/**
 * P-03 — Responses `input_file` must never disappear at the Devin Connect text
 * boundary.
 *
 * `responsesToChat()` deliberately preserves typed file blocks: the Cascade
 * backend has a real PDF text extractor (`image.js:extractImages`) that turns
 * them into model-visible text. The Devin Connect wire has no attachment field
 * at all — `ChatMessage` is {uuid #1, role #2, text #3, tool_call_id #7,
 * images #10} — so `messageText()` would flatten the block to '' and the model
 * would answer without the document. The only honest Connect outcome is a
 * stable 400 naming `input`, raised before any upstream call.
 *
 * These tests compose the real Responses converter with the real Connect
 * request builder, which is the boundary the audit found untested: converter
 * tests stopped at `responsesToChat`, builder tests started at `messages`.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, responsesToChat } from '../src/handlers/responses.js';
import { buildGetChatMessageRequest, messageText } from '../src/devin-connect.js';

const TOKEN = 'p03-test-token';
const MODEL = 'swe-1-6-slow';

// A minimal text-layer PDF. The bytes are never parsed by the rejection path;
// they only need to be a plausible `data:application/pdf` payload.
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Length 44 >>\nstream\nBT (P03 document body) Tj ET\nendstream\nendobj\n',
  'latin1',
);
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString('base64')}`;

function messageWith(content) {
  return { type: 'message', role: 'user', content };
}

function filePart(overrides = {}) {
  return {
    type: 'input_file',
    file: { filename: 'p03.pdf', file_data: PDF_DATA_URL },
    ...overrides,
  };
}

function assertUnsupportedFileError(fn, { param = 'input' } = {}) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'unsupported_input_file');
    assert.equal(err.param, param);
    assert.equal(err.status, 400);
    assert.match(err.message, /file|document/i);
    return true;
  });
}

const originalConnect = process.env.DEVIN_CONNECT;

beforeEach(() => {
  // Default every case to the Cascade selector; the route-rejection case opts
  // into Connect explicitly. This keeps the suite independent of a CI env var.
  delete process.env.DEVIN_CONNECT;
});

afterEach(() => {
  if (originalConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = originalConnect;
});

describe('P-03: Responses input_file survives conversion but cannot ride Connect', () => {
  it('keeps the typed file part after responsesToChat (Cascade still consumes it)', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([{ type: 'input_text', text: 'Summarize the attached document.' }, filePart()])],
    });

    assert.equal(chat.messages.length, 1);
    const parts = chat.messages[0].content;
    assert.ok(Array.isArray(parts), 'message content stays typed');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Summarize the attached document.');
    assert.equal(parts[1].type, 'input_file', 'the file part must not be silently erased by normalization');
    assert.equal(parts[1].file.file_data, PDF_DATA_URL);
  });

  it('the real Connect builder rejects text+file before encoding a text-only turn', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([{ type: 'input_text', text: 'Summarize the attached document.' }, filePart()])],
    });

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('the real Connect builder rejects a file-only turn too', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([filePart()])],
    });

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('rejects the top-level file_data shape and normalises it for Cascade', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([{ type: 'input_file', filename: 'p03.pdf', file_data: PDF_DATA_URL }])],
    });

    // Responses puts file_data/filename at the top level; Cascade's extractor
    // reads the nested Chat shape, so the converter must bridge them.
    assert.equal(chat.messages[0].content[0].file.file_data, PDF_DATA_URL);
    assert.equal(chat.messages[0].content[0].file.filename, 'p03.pdf');

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('rejects the nested Chat-style {type:"file", file:{file_data}} shape', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([{ type: 'file', file: { filename: 'p03.pdf', file_data: PDF_DATA_URL } }])],
    });

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('rejects a file_id reference that the proxy cannot fetch', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [messageWith([{ type: 'input_file', file_id: 'file-p03' }])],
    });

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('materialises a top-level input_file item instead of dropping it in the item loop', () => {
    const chat = responsesToChat({
      model: MODEL,
      input: [{ type: 'input_file', file_data: PDF_DATA_URL, filename: 'p03.pdf' }],
    });

    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].role, 'user');
    assert.equal(chat.messages[0].content[0].type, 'input_file');
    assert.equal(chat.messages[0].content[0].file.file_data, PDF_DATA_URL);

    assertUnsupportedFileError(() => buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: chat.messages,
    }));
  });

  it('messageText never silently returns only the instruction for a file turn', () => {
    assertUnsupportedFileError(() => messageText([
      { type: 'text', text: 'Summarize the attached document.' },
      filePart(),
    ]));
  });

  it('handleResponses returns 400 param=input before calling the chat handler', async () => {
    process.env.DEVIN_CONNECT = '1';
    let called = false;

    const result = await handleResponses({
      model: MODEL,
      input: [messageWith([{ type: 'input_text', text: 'Summarize the attached document.' }, filePart()])],
    }, {
      async handleChatCompletions() {
        called = true;
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'should not run' } }] } };
      },
    });

    assert.equal(called, false, 'the rejection must precede every upstream/model call');
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.param, 'input');
    assert.equal(result.body.error.code, 'unsupported_input_file');
    assert.match(result.body.error.message, /input_file|file/i);
  });

  it('does not reject the same request on the Cascade path', async () => {
    delete process.env.DEVIN_CONNECT;
    const seen = [];

    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: [messageWith([{ type: 'input_text', text: 'Summarize the attached document.' }, filePart()])],
    }, {
      async handleChatCompletions(body) {
        seen.push(body);
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
      },
    });

    assert.equal(result.status, 200);
    assert.equal(seen.length, 1, 'Cascade must still receive the request');
    const part = seen[0].messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p?.type === 'input_file');
    assert.ok(part, 'Cascade keeps the typed file part for image.js:extractImages');
  });

  it('plain text and image content keep building unchanged', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: MODEL,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
    });
    assert.ok(Buffer.isBuffer(proto) && proto.length > 0);
  });
});
