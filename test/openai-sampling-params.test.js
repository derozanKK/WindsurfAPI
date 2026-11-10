import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';

// T1 (Grok audit): seed / presence_penalty / frequency_penalty / logit_bias are
// accepted by the OpenAI request schema but the Devin/Windsurf upstream ignores
// them — they used to be SILENTLY dropped (client thinks they took effect). We
// now reject a non-default value with a 400 invalid_request_error instead of
// faking success. Neutral defaults still pass so ordinary clients aren't broken.

const baseReq = (extra) => ({
  model: 'claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

const rejectedFor = (result, param) =>
  result?.status === 400
  && result?.body?.error?.type === 'invalid_request_error'
  && result?.body?.error?.param === param;

// Distinguish "rejected by the sampling gate" from "reached routing and failed
// for lack of a real account" — the latter is any non-400 or a 400 whose param
// is not one of our sampling params.
const passedSamplingGate = (result) => {
  if (result?.status !== 400) return true;
  const p = result?.body?.error?.param;
  return !['seed', 'presence_penalty', 'frequency_penalty', 'logit_bias'].includes(p);
};

describe('T1 unsupported sampling params rejected', () => {
  it('rejects seed with 400 param=seed', async () => {
    const r = await handleChatCompletions(baseReq({ seed: 1 }));
    assert.ok(rejectedFor(r, 'seed'), JSON.stringify(r?.body));
    assert.match(r.body.error.message, /seed/);
  });

  it('rejects a non-zero presence_penalty', async () => {
    const r = await handleChatCompletions(baseReq({ presence_penalty: 0.5 }));
    assert.ok(rejectedFor(r, 'presence_penalty'), JSON.stringify(r?.body));
  });

  it('rejects a non-zero frequency_penalty', async () => {
    const r = await handleChatCompletions(baseReq({ frequency_penalty: -0.3 }));
    assert.ok(rejectedFor(r, 'frequency_penalty'), JSON.stringify(r?.body));
  });

  it('rejects a non-empty logit_bias', async () => {
    const r = await handleChatCompletions(baseReq({ logit_bias: { '50256': -100 } }));
    assert.ok(rejectedFor(r, 'logit_bias'), JSON.stringify(r?.body));
  });

  it('allows neutral defaults (penalties=0, empty logit_bias, no seed) — passes the sampling gate', async () => {
    const r = await handleChatCompletions(baseReq({
      presence_penalty: 0, frequency_penalty: 0, logit_bias: {},
    }));
    assert.ok(passedSamplingGate(r), `neutral defaults must not be rejected as a sampling param: ${JSON.stringify(r?.body)}`);
  });

  it('temperature/top_p: honoured by Connect, refused by Cascade (V-14)', async () => {
    // V-14: the Cascade planner config carries no sampling field, so accepting
    // these and dropping them was a success that lied about the request. The
    // Devin Connect backend does honour them — same body, different backend.
    const cascade = await handleChatCompletions(baseReq({ temperature: 0.7, top_p: 0.9 }));
    assert.ok(rejectedFor(cascade, 'temperature'), JSON.stringify(cascade?.body));

    const prev = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    try {
      __setConnectDeps({
        toChatCompletion: async () => ({
          status: 200,
          body: {
            id: 'x', object: 'chat.completion', created: 1, model: 'claude-sonnet-4.6',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          },
        }),
      });
      const connect = await handleChatCompletions(baseReq({ temperature: 0.7, top_p: 0.9 }));
      assert.equal(connect.status, 200, JSON.stringify(connect?.body));
    } finally {
      __resetConnectDeps();
      if (prev === undefined) delete process.env.DEVIN_CONNECT;
      else process.env.DEVIN_CONNECT = prev;
    }
  });
});
