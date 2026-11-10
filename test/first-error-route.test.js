import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serveChatStream } from '../src/server.js';
import { handleMessages, toAnthropicError } from '../src/handlers/messages.js';
import { handleGemini, geminiError } from '../src/handlers/gemini.js';
import { handleResponses } from '../src/handlers/responses.js';

function sink() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    destroy() { this.writableEnded = true; },
  };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function opts(protocol) {
  const base = { headers: { 'Content-Type': 'text/event-stream' }, requestId: 'req_test', protocol };
  if (protocol === 'messages') {
    Object.assign(base, {
      isBootstrap: (obj) => obj?.type === 'message_start' || obj?.type === 'ping',
      parseError: (obj) => (obj?.type === 'error' && obj.error ? obj.error : null),
      errorBody: (error, status) => toAnthropicError(status, error?.type, error?.message).body,
    });
  }
  if (protocol === 'responses') {
    Object.assign(base, {
      isBootstrap: (obj) => obj?.type === 'response.created' || obj?.type === 'response.in_progress',
      parseError: (obj) => (obj?.type === 'response.failed' ? obj.response?.error : null),
      errorBody: (error, status) => ({ error: { message: error?.message, type: error?.type, code: error?.code, status } }),
    });
  }
  if (protocol === 'gemini') {
    Object.assign(base, {
      isBootstrap: (obj) => Array.isArray(obj?.candidates)
        && obj.candidates.length > 0
        && obj.candidates.every((c) => !c?.finishReason && (c?.content?.parts || []).every((p) => !p?.text && !p?.functionCall)),
      parseError: (obj) => (obj?.error && typeof obj.error === 'object' ? obj.error : null),
      errorBody: (error, status) => geminiError(status, error?.type, error?.message).body,
    });
  }
  return base;
}

async function firstError(protocol, code) {
  const chat = async () => ({
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream' },
    handler: async (res) => {
      res.write(frame({
        error: {
          type: code === 'RATE_LIMITED' ? 'rate_limit_exceeded' : 'upstream_error',
          code,
          message: `synthetic ${code}`,
          ...(code === 'RATE_LIMITED' ? { retry_after_ms: 2500 } : {}),
        },
      }));
      res.end();
    },
  });
  if (protocol === 'messages') {
    return handleMessages(
      { model: 'claude-sonnet-4.6', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] },
      { handleChatCompletions: chat },
    );
  }
  if (protocol === 'responses') {
    return handleResponses(
      { model: 'claude-sonnet-4.6', stream: true, store: false, input: 'x' },
      { handleChatCompletions: chat },
    );
  }
  return handleGemini(
    'gemini-2.5-pro',
    { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
    { handleChatCompletions: chat },
    { stream: true, alt: 'sse' },
  );
}

describe('first-error status contract', () => {
  it('Messages preserves 429 and Retry-After from a pre-content upstream error', async () => {
    const res = sink();
    const result = await firstError('messages', 'RATE_LIMITED');
    await serveChatStream(res, result, { ...opts('messages'), headers: result.headers });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(JSON.parse(res.body).error.type, 'rate_limit_error');
  });

  it('Messages maps CAPACITY to 529 instead of the generic 502', async () => {
    const res = sink();
    const result = await firstError('messages', 'CAPACITY');
    await serveChatStream(res, result, { ...opts('messages'), headers: result.headers });
    assert.equal(res.statusCode, 529);
    assert.equal(JSON.parse(res.body).error.type, 'overloaded_error');
  });

  it('Responses preserves Retry-After on a pre-content rate limit', async () => {
    const res = sink();
    const result = await firstError('responses', 'RATE_LIMITED');
    await serveChatStream(res, result, { ...opts('responses'), headers: result.headers });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
  });

  it('Gemini preserves 429/Retry-After and QUOTA as RESOURCE_EXHAUSTED', async () => {
    for (const [code, expected] of [['RATE_LIMITED', 429], ['QUOTA_EXHAUSTED', 429]]) {
      const res = sink();
      const result = await firstError('gemini', code);
      await serveChatStream(res, result, { ...opts('gemini'), headers: result.headers });
      assert.equal(res.statusCode, expected, code);
      const body = JSON.parse(res.body);
      assert.equal(body.error.status, 'RESOURCE_EXHAUSTED');
      if (code === 'RATE_LIMITED') assert.equal(res.headers['retry-after'], '30');
    }
  });

  it('keeps MODEL_BLOCKED 402 for Responses but 403 for Messages', async () => {
    for (const [protocol, expected] of [['messages', 403], ['responses', 402]]) {
      const res = sink();
      const result = await firstError(protocol, 'MODEL_BLOCKED');
      await serveChatStream(res, result, { ...opts(protocol), headers: result.headers });
      assert.equal(res.statusCode, expected, protocol);
    }
  });

  it('Gemini array mode streams before upstream completion', async () => {
    const res = sink();
    let midBytes = -1;
    const result = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
      {
        handleChatCompletions: async () => ({
          status: 200,
          stream: true,
          headers: { 'Content-Type': 'application/json' },
          handler: async (capture) => {
            capture.write(frame({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] }));
            midBytes = res.body.length;
            capture.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            capture.end();
          },
        }),
      },
      { stream: true, alt: null },
    );
    await serveChatStream(res, result, { ...opts('gemini'), headers: result.headers, commitMs: 5000 });
    assert.ok(midBytes > 0, 'first array element must be visible before upstream ends');
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });
});
