// SessionReauth Phase 2 — the PostAuth `auth1_token` field (#3).
//
// WindsurfPostAuthResponse carries an optional rotated Auth1 at field #3, which
// the decoder used to skip. Decoding it is what keeps a stored Auth1 usable
// after the first exchange (Phase 4); here we only pin the wire decode, and that
// the JSON / regex fallbacks are byte-identical to before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeStringField, writeMessageField } from '../src/proto.js';
import { parsePostAuthResponseData } from '../src/dashboard/windsurf-login.js';

const SESSION = 'devin-session-token$auth1-field.fixture.sig';
const AUTH1 = 'auth1_rotated_abcdefghijklmnopqrstuvwxyz0123456789';
const ACCOUNT = 'account-A1B2C3D4';
const ORG = 'org-A1B2C3D4';

function body({ auth1 = null } = {}) {
  const parts = [
    writeStringField(1, SESSION),
    writeMessageField(2, Buffer.concat([
      writeStringField(1, 'org-proto'),
      writeStringField(6, 'free'),
    ])),
  ];
  if (auth1 != null) parts.push(writeStringField(3, auth1));
  parts.push(writeStringField(4, ACCOUNT), writeStringField(5, ORG));
  return Buffer.concat(parts);
}

describe('parsePostAuthResponseData — auth1_token (#3)', () => {
  it('decodes a rotated auth1_token alongside session_token/account/orgs', () => {
    const parsed = parsePostAuthResponseData(body({ auth1: AUTH1 }));
    assert.equal(parsed.sessionToken, SESSION);
    assert.equal(parsed.auth1Token, AUTH1, 'field #3 is the Auth1 this exchange may have rotated');
    assert.equal(parsed.accountId, ACCOUNT);
    assert.equal(parsed.primaryOrgId, ORG);
    assert.equal(parsed.orgs?.[0]?.id, 'org-proto', 'field #2 stays a repeated org message, not the Auth1');
  });

  it('leaves auth1Token undefined when the server omits it', () => {
    const parsed = parsePostAuthResponseData(body());
    assert.equal(parsed.sessionToken, SESSION);
    assert.equal(parsed.auth1Token, undefined, 'absent must stay undefined — callers re-store only when present');
  });

  it('the JSON path is unchanged (no invented field)', () => {
    const parsed = parsePostAuthResponseData(Buffer.from(JSON.stringify({
      sessionToken: 'devin-session-token$json', accountId: 'account-json',
    })));
    assert.equal(parsed.sessionToken, 'devin-session-token$json');
    assert.equal(parsed.auth1Token, undefined);
  });

  it('the regex fallback is unchanged (no invented field)', () => {
    const parsed = parsePostAuthResponseData(`upstream said: ${SESSION} ${ACCOUNT}`);
    assert.equal(parsed.sessionToken, SESSION);
    assert.equal(parsed.auth1Token, undefined);
  });
});
