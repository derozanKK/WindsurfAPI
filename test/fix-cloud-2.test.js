// FIX-CLOUD-2 — A10/A12/A15 acceptance tests (transport / login surface).
//
//   A10  CheckUserMessageRateLimit: the cooldown is `resets_in_seconds` (#5) — the
//        response has no `retryAfterMs` key, so that read was dead; ×1000 → ms.
//   A12  ChatToolDefinition.strict sits at #12 on the current server (#4 is
//        reserved there); the documented calibration example must point at #12,
//        and the emission stays opt-in (no strict key in the default tag map).
//   A15  WindsurfPostAuth responds with protobuf — decode session_token#1 /
//        account_id#4 / primary_org_id#5 / orgs#2 directly; the byte-scanning
//        regex stays as the non-protobuf fallback.
//
// A11's tests live in the pinned file test/completion-config-max-tokens-tag.test.js.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkMessageRateLimit, __setWindsurfApiPostJsonForTest } from '../src/windsurf-api.js';
import { buildGetChatMessageRequest, getToolDefTags } from '../src/devin-connect.js';
import {
  parseFields, getField, getAllFields,
  writeStringField, writeMessageField, writeVarintField,
} from '../src/proto.js';
import { parsePostAuthResponseData } from '../src/dashboard/windsurf-login.js';

const TOKEN = 'devin-session-token$fix-cloud-2.jwt.sig';

// ─── A10 ─────────────────────────────────────────────────────────────────────

describe('A10 — CheckUserMessageRateLimit surfaces the cooldown as retryAfterMs', () => {
  afterEach(() => __setWindsurfApiPostJsonForTest(null));

  it('a {resetsInSeconds:30} response yields retryAfterMs 30000 (the schema key, ×1000)', async () => {
    __setWindsurfApiPostJsonForTest(async (host, path, body) => {
      assert.equal(path, '/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit');
      assert.equal(body.metadata.apiKey, 'fix-cloud-2-key');
      return {
        status: 200,
        data: {
          hasCapacity: false,
          message: 'slow down',
          messagesRemaining: 0,
          maxMessages: 50,
          resetsInSeconds: 30,
        },
        raw: '{}',
      };
    });

    const r = await checkMessageRateLimit('fix-cloud-2-key');
    assert.equal(r.retryAfterMs, 30000, 'resets_in_seconds (#5) × 1000');
    assert.equal(r.hasCapacity, false);
    assert.equal(r.messagesRemaining, 0);
    assert.equal(r.maxMessages, 50);
  });

  it('an absent resetsInSeconds keeps retryAfterMs null (no fabricated cooldown)', async () => {
    __setWindsurfApiPostJsonForTest(async () => ({
      status: 200,
      data: { hasCapacity: true, messagesRemaining: -1, maxMessages: -1 },
      raw: '{}',
    }));

    const r = await checkMessageRateLimit('fix-cloud-2-key');
    assert.equal(r.retryAfterMs, null);
  });
});

// ─── A12 ─────────────────────────────────────────────────────────────────────

describe('A12 — ChatToolDefinition.strict is #12 on the current server', () => {
  const SRC = readFileSync(new URL('../src/devin-connect.js', import.meta.url), 'utf8');

  it('the documented DEVIN_CONNECT_TOOL_DEF_TAGS example calibrates strict at #12', () => {
    // The example is the calibration an operator copies; #4 is reserved on the
    // current server and #6 is server_name, so a stale number would silently
    // point the strict bool at the wrong field.
    const m = SRC.match(/\[,strict=(\d+)\]/);
    assert.ok(m, 'expected the tool-def example to include the optional strict key');
    assert.equal(Number(m[1]), 12, 'strict must be documented at #12 (#4 is reserved; #6 is server_name)');
  });

  it('configuring strict=12 encodes the bool at #12 and never at the reserved #4', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {}, strict: true } }],
      env: { DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3,strict=12' },
    });
    const td = parseFields(getAllFields(parseFields(proto), 10)[0].value);
    assert.equal(Number(getField(td, 12, 0)?.value), 1, 'strict=true must ride #12');
    assert.equal(getField(td, 4, 0), null, '#4 is reserved on the current server');
  });

  it('the default tag map still carries no strict key (unreachable unless configured)', () => {
    const tags = getToolDefTags({}, { useDefault: true });
    assert.equal(Object.prototype.hasOwnProperty.call(tags, 'strict'), false);
  });
});

// ─── A15 ─────────────────────────────────────────────────────────────────────

describe('A15 — WindsurfPostAuth protobuf response decodes directly', () => {
  it('decodes session_token#1 / account_id#4 / primary_org_id#5 / orgs#2 from a protobuf body', () => {
    // The values deliberately carry characters outside the legacy regex classes
    // (`+`/`=` in the token, uppercase hex in the ids): a byte-scanning regex
    // cannot produce them, so this can only pass through the protobuf decode.
    const fixture = Buffer.concat([
      writeStringField(1, 'devin-session-token$proto+fixture='),
      writeMessageField(2, Buffer.concat([
        writeStringField(1, 'org-proto'),
        writeStringField(6, 'free'),
        writeVarintField(5, 1),
      ])),
      writeStringField(4, 'account-A1B2C3D4'),
      writeStringField(5, 'org-A1B2C3D4'),
    ]);

    const parsed = parsePostAuthResponseData(fixture);
    assert.equal(parsed.sessionToken, 'devin-session-token$proto+fixture=');
    assert.equal(parsed.accountId, 'account-A1B2C3D4');
    assert.equal(parsed.primaryOrgId, 'org-A1B2C3D4');
    assert.equal(parsed.orgs?.[0]?.id, 'org-proto');
    assert.equal(parsed.orgs?.[0]?.planSlug, 'free');
    assert.equal(parsed.orgs?.[0]?.canUseCascade, true);
  });

  it('keeps the regex fallback for non-protobuf (text) responses', () => {
    const parsed = parsePostAuthResponseData('upstream error: devin-session-token$fallback.abc-123');
    assert.equal(parsed.sessionToken, 'devin-session-token$fallback.abc-123');
  });

  it('keeps the JSON path for JSON bodies', () => {
    const parsed = parsePostAuthResponseData(
      Buffer.from(JSON.stringify({ sessionToken: 'devin-session-token$json', accountId: 'account-json' })),
    );
    assert.equal(parsed.sessionToken, 'devin-session-token$json');
    assert.equal(parsed.accountId, 'account-json');
  });

  it('a protobuf body without a session token is an error object, never a fake success', () => {
    const parsed = parsePostAuthResponseData(Buffer.concat([
      writeStringField(4, 'account-no-token'),
      writeStringField(5, 'org-no-token'),
    ]));
    assert.equal(parsed.sessionToken, undefined);
    assert.ok(parsed.error, 'no session token → error object');
  });
});
