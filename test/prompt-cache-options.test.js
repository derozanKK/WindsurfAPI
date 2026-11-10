// Explicit prompt caching — GetChatMessageRequest #13 system_prompt_cache_options.
//
// The epistemic situation matters more than the code here, so it is worth stating:
//
// MEASURED (paid Teams account, repo history): a cache HIT costs ~17.8% of a miss
// (#220), and caching is per-ACCOUNT keyed on the prompt PREFIX — NOT on the session
// id. Both #220 A/Bs scored hits while devin-connect.js emitted a fresh randomUUID
// session id per request, and chat.js:2004 records the three-account experiment
// (same body on a second account = WRITE, repeat on the first = READ). So implicit
// caching already works and sticky sessions already supply the account stability.
//
// NOT MEASURED: that #13 is the tag for system_prompt_cache_options, or that asking
// for EPHEMERAL beats what we get implicitly. #13 comes from third-party .proto
// DECLARATION ORDER, and prost allows tag gaps, so declaration order is not a wire
// tag.
//
// Defaults as of 2026-10-23: UNSET → ON for the gpt-6 family only, OFF everywhere
// else. The live matrix (evidence/ToolMatrixLive.md §cache) measured five identical
// gpt-6-luna-max requests with cache_write=3984 on EVERY round and zero cache reads,
// while Claude read 6884 cached tokens on every warm round. The hint is the only
// cache-control field the wire exposes, so the family defaults on to settle whether
// it is required; every other family keeps the historical default-OFF wire, and
// DEVIN_CONNECT_PROMPT_CACHE=0 is the kill switch for all of them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildGetChatMessageRequest,
  buildSystemPromptCacheOptions,
  isPromptCacheEnabled,
  streamChat,
  __setRequestImpl,
} from '../src/devin-connect.js';
import { parseFields, getField, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope, unwrapRequest } from '../src/connect.js';

const ON = { DEVIN_CONNECT_PROMPT_CACHE: '1' };
const OFF = { DEVIN_CONNECT_PROMPT_CACHE: '0' };
// Long enough to clear the "not worth a cache write" floor.
const LONG_PROMPT = 'You are a careful assistant. Follow the user instructions exactly. '.repeat(3);
const TOKEN = 'devin-session-token$a.b.c';

function request(env, systemPrompt, model = 'm') {
  return buildGetChatMessageRequest({
    token: TOKEN,
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'x' }],
    env,
    deviceSeed: 'stable',
  });
}
const hasField13 = (proto) => parseFields(proto).some((f) => f.field === 13);

describe('isPromptCacheEnabled — exact "1" opt-in, gpt-6 family default', () => {
  it('is off when unset or empty for models outside the gpt-6 family', () => {
    // Unset + a non-gpt-6 selector is the state of every existing deployment on
    // every other family. This adds a field to a wire that already works, so
    // silence must mean off there.
    assert.equal(isPromptCacheEnabled({}), false);
    assert.equal(isPromptCacheEnabled({ DEVIN_CONNECT_PROMPT_CACHE: '' }), false);
    for (const m of ['claude-haiku-5-5-medium', 'gemini-3-6-flash-medium',
      'swe-2-medium', 'gpt-5-6-sol-medium', 'gpt-6-lunar-max', 'gpt-60-luna-max', '']) {
      assert.equal(isPromptCacheEnabled({}, m), false, `"${m}" must stay default-off`);
    }
  });

  it('rejects truthy-looking values that are not "1"', () => {
    // Guards the Number()/falsy rewrite that silently flipped sibling knobs (#241,
    // #242): '0' and 'false' must not read as on.
    for (const v of ['0', 'false', 'true', 'on', 'yes', '00']) {
      assert.equal(isPromptCacheEnabled({ DEVIN_CONNECT_PROMPT_CACHE: v }), false,
        `"${v}" must not enable a wire-changing switch`);
      // The same explicit value also overrides the gpt-6 family default.
      assert.equal(isPromptCacheEnabled({ DEVIN_CONNECT_PROMPT_CACHE: v }, 'gpt-6-luna-max'), false,
        `"${v}" must also override the gpt-6 default`);
    }
    assert.equal(isPromptCacheEnabled(ON), true);
  });

  it('defaults ON for every gpt-6 selector when unset', () => {
    // The 2026-10-23 live matrix: five identical gpt-6-luna-max requests, a cache
    // WRITE on every round and zero reads. The hint is the only cache-control field
    // on the wire, so this family asks for it unless the operator says otherwise.
    for (const m of ['gpt-6-luna-max', 'gpt-6-luna-medium', 'gpt-6-sol-high',
      'gpt-6-astra-medium', 'gpt-6-1-sol-medium', 'gpt-6.1-sol-medium', 'GPT-6-LUNA-MAX']) {
      assert.equal(isPromptCacheEnabled({}, m), true, `"${m}" must default on`);
    }
  });

  it('DEVIN_CONNECT_PROMPT_CACHE=0 is the kill switch for the family default', () => {
    assert.equal(isPromptCacheEnabled(OFF, 'gpt-6-luna-max'), false);
    assert.equal(isPromptCacheEnabled(OFF, 'claude-sonnet-4-6'), false);
  });
});

describe('buildSystemPromptCacheOptions', () => {
  it('returns null when the switch is off, whatever the prompt', () => {
    // Null rather than an empty buffer is what keeps the default wire unchanged:
    // the caller spreads nothing instead of emitting a zero-length #13.
    assert.equal(buildSystemPromptCacheOptions(LONG_PROMPT, {}), null);
  });

  it('returns an EPHEMERAL(1) varint when on with a substantial prompt', () => {
    const buf = buildSystemPromptCacheOptions(LONG_PROMPT, ON);
    assert.ok(Buffer.isBuffer(buf), 'expected a sub-message buffer');
    assert.equal(getField(parseFields(buf), 1, 0)?.value, 1,
      'cache mode must be EPHEMERAL = 1');
  });

  it('returns null for a prompt too short to be worth a cache write', () => {
    // A write costs roughly an order of magnitude more than a read (chat.js:2004),
    // so requesting a cache for a trivial prompt is a pure loss, not a no-op.
    for (const p of ['', '   ', 'hi', 'You are helpful.']) {
      assert.equal(buildSystemPromptCacheOptions(p, ON), null,
        `a ${p.length}-char prompt must not request caching`);
    }
  });

  it('returns null for a non-string prompt instead of throwing', () => {
    // This runs on the request path; a caller passing null must not 500 the turn.
    for (const p of [null, undefined, 42, {}, []]) {
      assert.equal(buildSystemPromptCacheOptions(p, ON), null);
    }
  });

  it('does not count whitespace toward the floor', () => {
    assert.equal(buildSystemPromptCacheOptions(' '.repeat(200), ON), null,
      'a whitespace-only prompt has no prefix to cache');
  });
});

describe('request wire: #13 appears only when enabled', () => {
  it('emits NO field 13 when the switch is off', () => {
    // The load-bearing assertion. Field ABSENCE is checked rather than byte-equality
    // because two identical buildGetChatMessageRequest calls already differ (a
    // pre-existing random field), so a byte comparison would fail for the wrong
    // reason and prove nothing.
    assert.equal(hasField13(request({}, LONG_PROMPT)), false);
  });

  it('emits field 13 when the switch is on and the prompt is substantial', () => {
    const proto = request(ON, LONG_PROMPT);
    assert.equal(hasField13(proto), true);
    const inner = getField(parseFields(proto), 13, 2).value;
    assert.equal(getField(parseFields(inner), 1, 0)?.value, 1, 'EPHEMERAL inside #13');
  });

  it('emits NO field 13 when on but the prompt is below the floor', () => {
    assert.equal(hasField13(request(ON, 'hi')), false);
  });

  it('keeps the request fields ascending with #13 present', () => {
    // #13 sits between #8 (completion config) and #15 (model config). Ascending
    // order is what every other field here maintains.
    const nums = parseFields(request(ON, LONG_PROMPT)).map((f) => f.field);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `not ascending: ${nums}`);
    assert.ok(nums.indexOf(13) > nums.indexOf(8), '#13 must follow #8');
    assert.ok(nums.indexOf(13) < nums.indexOf(15), '#13 must precede #15');
  });

  it('leaves every other field intact when enabled', () => {
    // A new field must not displace or drop an existing one.
    const off = new Set(parseFields(request({}, LONG_PROMPT)).map((f) => f.field));
    const on = new Set(parseFields(request(ON, LONG_PROMPT)).map((f) => f.field));
    for (const f of off) assert.ok(on.has(f), `field ${f} disappeared when caching was enabled`);
    assert.deepEqual([...on].filter((f) => !off.has(f)), [13],
      'enabling the switch must add exactly #13 and nothing else');
  });

  it('emits #13 for gpt-6 by default and for no other family', () => {
    assert.equal(hasField13(request({}, LONG_PROMPT, 'gpt-6-luna-max')), true,
      'gpt-6 must carry the hint with DEVIN_CONNECT_PROMPT_CACHE unset');
    assert.equal(hasField13(request({}, LONG_PROMPT, 'gpt-6-1-sol-medium')), true,
      'the 6.1 sol variant is the same family');
    for (const m of ['claude-haiku-5-5-medium', 'gemini-3-6-flash-medium', 'swe-2-medium',
      'gpt-5-6-sol-medium', 'gpt-6-lunar-max']) {
      assert.equal(hasField13(request({}, LONG_PROMPT, m)), false,
        `${m} must keep the default-off wire`);
    }
    assert.equal(hasField13(request(OFF, LONG_PROMPT, 'gpt-6-luna-max')), false,
      'the kill switch must win over the family default');
    assert.equal(hasField13(request(ON, LONG_PROMPT, 'claude-haiku-5-5-medium')), true,
      'the global opt-in must still work for other families');
  });
});

// ─── End-to-end: hint on the request, cache reads in the response ────────────
//
// The two halves the flag exists for, measured through the real streamChat over a
// mock transport: the gpt-6 request must CARRY #13 with the variable unset, and a
// metadata frame carrying the calibrated cache-read tag (5) must surface as
// prompt_tokens_details.cached_tokens on the finish event. Unit-testing the
// builder and the decoder separately would pass even if streamChat stopped
// passing `model` into the cache decision, or if the finish event stopped
// normalizing usage.

function metaFrame({ prompt, completion, cacheRead }) {
  const parts = [];
  if (prompt != null) parts.push(writeVarintField(2, prompt));
  if (completion != null) parts.push(writeVarintField(3, completion));
  if (cacheRead != null) parts.push(writeVarintField(5, cacheRead));
  return writeMessageField(7, Buffer.concat(parts));
}

function mockTransport(framePayloads, onBody) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = (buf) => { onBody?.(buf); };
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        for (const p of framePayloads) res.emit('data', wrapEnvelope(p, { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

describe('streamChat gpt-6: request hint + response cache reads', () => {
  it('carries #13 by default and reports cached_tokens from metadata tag 5', async () => {
    let sent = null;
    __setRequestImpl(mockTransport([
      Buffer.concat([
        writeStringField(3, 'ok'),
        writeVarintField(5, 2),
        metaFrame({ prompt: 3, completion: 7, cacheRead: 3984 }),
      ]),
    ], (body) => { sent = unwrapRequest(body); }));
    try {
      const events = [];
      for await (const ev of streamChat({
        messages: [
          { role: 'system', content: LONG_PROMPT },
          { role: 'user', content: 'Reply with exactly: CACHE-OK' },
        ],
        model: 'gpt-6-luna-max',
        token: TOKEN,
        env: { DEVIN_CONNECT_TOKEN: TOKEN }, // DEVIN_CONNECT_PROMPT_CACHE deliberately unset
      })) events.push(ev);

      assert.ok(sent, 'the request body must have been captured');
      const fields = parseFields(sent);
      assert.equal(fields.some((f) => f.field === 13), true,
        'gpt-6 request must carry system_prompt_cache_options (#13) by default');
      const inner = getField(fields, 13, 2)?.value;
      assert.equal(getField(parseFields(inner), 1, 0)?.value, 1,
        'the hint must ask for EPHEMERAL(1)');

      const finish = events.find((e) => e.type === 'finish');
      assert.ok(finish, 'stream must reach its terminal finish event');
      assert.equal(finish.usage?.prompt_tokens_details?.cached_tokens, 3984,
        'the calibrated cache-read tag (5) must reach prompt_tokens_details.cached_tokens');
      assert.equal(finish.usage.prompt_tokens, 3 + 3984,
        'prompt_tokens is fresh input + cache read');
    } finally { __setRequestImpl(null); }
  });
});
