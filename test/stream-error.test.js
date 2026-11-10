import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { isCascadeTransportError } from '../src/client.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';
import {
  chatStreamError,
  connectErrorToHttp,
  finishPartialStreamAfterError,
  handleChatCompletions,
  isUpstreamDeadlineExceeded,
  isUpstreamTransientError,
  redactRequestLogText,
} from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { serveChatStream } from '../src/server.js';

const createdAccountIds = [];

afterEach(() => {
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

function parseEvents(raw) {
  return raw.trim().split('\n\n').filter(Boolean).map(frame => {
    const lines = frame.split('\n');
    return {
      event: lines.find(line => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
    };
  });
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    headersSent: false,
    statusCode: null,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

describe('stream error protocol', () => {
  it('creates OpenAI-style structured stream errors', () => {
    assert.deepEqual(chatStreamError('boom', 'upstream_error', 'x'), {
      error: { message: 'boom', type: 'upstream_error', code: 'x' },
    });
  });

  it('classifies ECONNRESET on err.code even when the message looks like auth', () => {
    const err = Object.assign(new Error('unauthenticated'), { code: 'ECONNRESET' });
    assert.equal(isCascadeTransportError(err), true);
    assert.equal(isCascadeTransportError(new Error('unauthenticated')), false);
  });

  it('classifies Cascade HTTP/2 cancellation as upstream transient', () => {
    const err = new Error('The pending stream has been canceled (caused by: )');
    assert.equal(isCascadeTransportError(err), true);
    assert.equal(isUpstreamTransientError(err), true);
    assert.equal(isUpstreamTransientError(new Error('permission_denied: model unavailable')), false);
  });

  it('classifies provider context deadline as upstream deadline, not generic transient', () => {
    const err = new Error('Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)');
    assert.equal(isUpstreamDeadlineExceeded(err), true);
    assert.equal(isUpstreamTransientError(err), false);
    assert.equal(isUpstreamDeadlineExceeded('rate limit exceeded'), false);
  });

  it('redacts common secret patterns before debug request-body logging', () => {
    const redacted = redactRequestLogText('sk-1234567890abcdefghijklmnop test@example.com Cookie: session=abc eyJabc.def.ghi AKIAABCDEFGHIJKLMNOP');
    assert.doesNotMatch(redacted, /sk-1234567890/);
    assert.doesNotMatch(redacted, /test@example\.com/);
    assert.doesNotMatch(redacted, /session=abc/);
    assert.doesNotMatch(redacted, /eyJabc\.def\.ghi/);
    assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
  });

  it('translates structured chat stream errors to Anthropic error events', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('boom', 'upstream_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.error.message, 'boom');
  });

  it('maps upstream_transient_error to overloaded_error in Anthropic stream errors', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('cascade transport canceled', 'upstream_transient_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    // A transient upstream error is the proxy's back-off-and-retry signal; for an
    // Anthropic client that's overloaded_error (529-class), NOT a leaked
    // proxy-specific type the SDK can't interpret.
    assert.equal(events[0].data.error.type, 'overloaded_error');
  });

  it('partial content then upstream deadline emits a structured error and never finish_reason:stop or [DONE]', async () => {
    // Direct helper contract: an error after content is an explicit error
    // frame, not a fabricated successful terminal.
    const helperRes = fakeRes();
    const send = (data) => helperRes.write(`data: ${JSON.stringify(data)}\n\n`);
    finishPartialStreamAfterError({
      id: 'chatcmpl_partial',
      created: 1,
      model: 'claude-sonnet-4.6',
      send,
      res: helperRes,
      error: {
        message: 'upstream deadline',
        type: 'upstream_deadline_exceeded',
        code: 'windsurf_provider_deadline',
      },
    });
    assert.match(helperRes.body, /"error"/);
    assert.equal(helperRes.body.includes('"finish_reason":"stop"'), false);
    assert.equal(helperRes.body.includes('[DONE]'), false);

    // Real handler: the failure tail must take the same honest path.
    const account = addAccountByKey(`partial-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'partial-deadline');
    createdAccountIds.push(account.id);

    class PartialDeadlineClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
        opts.onChunk({ text: 'partial answer' });
        throw new Error('Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)');
      }
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'write a long answer' }],
    }, {
      async waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 17777, csrfToken: 'csrf', generation: 1 };
      },
      WindsurfClient: PartialDeadlineClient,
    });

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    const res = fakeRes();
    await result.handler(res);

    assert.match(res.body, /partial answer/);
    assert.match(res.body, /"error"/);
    assert.equal(res.body.includes('"finish_reason":"stop"'), false,
      'a dead turn must not be closed as a successful stop');
    assert.equal(res.body.includes('[DONE]'), false,
      'a failed stream must not claim a clean finish');
  });

  it('still sends a structured stream error when only an empty role chunk was emitted, without [DONE]', async () => {
    const account = addAccountByKey(`empty-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'empty-deadline');
    createdAccountIds.push(account.id);

    class EmptyThenDeadlineClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
        opts.onChunk({ text: '' });
        throw new Error('Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)');
      }
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 17777, csrfToken: 'csrf', generation: 1 };
      },
      WindsurfClient: EmptyThenDeadlineClient,
    });

    const res = fakeRes();
    await result.handler(res);

    assert.match(res.body, /"error"/);
    // O10: a direct OpenAI client (no __route) sees the normalized official
    // error.type; the specific condition is still carried in `code`.
    assert.match(res.body, /"type":"api_error"/);
    assert.match(res.body, /"code":"windsurf_provider_deadline"/);
    // [DONE] is the OpenAI stream's "completed" marker. A pre-content failure
    // has not completed anything, so the error frame must be the last signal;
    // a client (or relay) that sees [DONE] would treat the turn as a clean empty
    // answer and may drop the error entirely.
    assert.equal(res.body.includes('data: [DONE]'), false, 'no [DONE] after a pre-content error');
  });

  it('route: a pre-content failure with no prior write returns the real status, not a committed 200', async () => {
    const account = addAccountByKey(`late-precontent-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'late-precontent');
    createdAccountIds.push(account.id);

    class LatePreContentDeadlineClient {
      async cascadeChat() {
        // No frame is written before this failure. The gate used to arm its
        // bootstrap timer at CONSTRUCTION, so `commitMs: 5` committed HTTP 200
        // before the 20 ms failure and the 504 could only arrive in-band. The
        // timer now arms on the first write, so the error frame is the first
        // write and rewrites the status — the measured P0 fix.
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)');
      }
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 17777, csrfToken: 'csrf', generation: 1 };
      },
      WindsurfClient: LatePreContentDeadlineClient,
    });

    const res = fakeRes();
    let onDoneCalls = 0;
    await serveChatStream(res, result, {
      headers: { 'Content-Type': 'text/event-stream' },
      commitMs: 5,
      onDone: () => { onDoneCalls += 1; },
    });

    assert.equal(res.statusCode, 504, 'the uncommitted gate must rewrite the real status');
    assert.match(res.body, /"error"/);
    assert.equal(res.body.includes('data: [DONE]'), false, 'a failed request must not gain a success sentinel');
    assert.equal(res.writableEnded, true, 'the response must be closed');
    assert.equal(onDoneCalls, 1, 'cleanup must still run exactly once');
  });

  it('routes oversized Connect frame parser errors to onError without throwing from data handlers', async () => {
    const previousProtocol = process.env.GRPC_PROTOCOL;
    process.env.GRPC_PROTOCOL = 'connect';
    const grpc = await import(`../src/grpc.js?connect-error-test=${Date.now()}`);

    const server = http2.createServer();
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      const frame = Buffer.alloc(5);
      frame[0] = 0;
      frame.writeUInt32BE(16 * 1024 * 1024 + 1, 1);
      stream.end(frame);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for parser error')), 1000);
        grpc.grpcStream(port, 'csrf', '/exa.language_server_pb.LanguageServerService/RawGetChatMessage', Buffer.from('{}'), {
          timeout: 1000,
          onData() {
            reject(new Error('unexpected data callback'));
          },
          onEnd() {
            reject(new Error('unexpected end callback'));
          },
          onError(error) {
            clearTimeout(timer);
            resolve(error);
          },
        });
      });

      assert.match(err.message, /exceeds 16777216/);
    } finally {
      grpc.closeSessionForPort(port);
      await new Promise(resolve => server.close(resolve));
      if (previousProtocol == null) delete process.env.GRPC_PROTOCOL;
      else process.env.GRPC_PROTOCOL = previousProtocol;
    }
  });
});

describe('connectErrorToHttp (DEVIN_CONNECT error mapping)', () => {
  it('maps MODEL_BLOCKED to 402 model_blocked', () => {
    assert.deepEqual(connectErrorToHttp('MODEL_BLOCKED'), { status: 402, type: 'model_blocked' });
  });
  it('maps UNAUTHORIZED and NO_TOKEN to 401 authentication_error', () => {
    assert.deepEqual(connectErrorToHttp('UNAUTHORIZED'), { status: 401, type: 'authentication_error' });
    assert.deepEqual(connectErrorToHttp('NO_TOKEN'), { status: 401, type: 'authentication_error' });
  });
  it('maps RATE_LIMITED to 429 rate_limit_error', () => {
    assert.deepEqual(connectErrorToHttp('RATE_LIMITED'), { status: 429, type: 'rate_limit_error' });
  });
  it('maps TIMEOUT to 504 timeout_error', () => {
    assert.deepEqual(connectErrorToHttp('TIMEOUT'), { status: 504, type: 'timeout_error' });
  });
  it('falls back to 502 upstream_error for unknown/null codes', () => {
    assert.deepEqual(connectErrorToHttp('UPSTREAM_ERROR'), { status: 502, type: 'upstream_error' });
    assert.deepEqual(connectErrorToHttp(null), { status: 502, type: 'upstream_error' });
  });
});
