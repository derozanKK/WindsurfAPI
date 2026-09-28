import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { storeCredential, getCredential } from '../src/devin-connect-credentials.js';

it('short tags cannot yield plaintext through ordinary, repaired or salvaged wrappers', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'wa-gcm-review-'));
  const file = join(dir, 'creds.json');
  const env = { DEVIN_CONNECT_CRED_FILE: file, DEVIN_CONNECT_CRED_KEY: 'fixture-only-master-key' };
  const email = 'review@example.com', password = 'fixture-password';
  try {
    storeCredential(email, password, env);
    const original = fs.readFileSync(file, 'utf8');
    const record = JSON.parse(original).records[email];
    for (const length of [0, 4, 8, 12, 15]) {
      const rec = { ...record, tag: record.tag.slice(0, length * 2) };
      const valid = JSON.stringify({ v: 1, records: { [email]: rec } });
      const wrappers = [valid, '\ufeff' + valid.replace(/}$/, ',}'), 'broken-wrapper "' + email + '": ' + JSON.stringify(rec) + ' invalid-tail'];
      for (const raw of wrappers) {
        fs.writeFileSync(file, raw);
        let value = null;
        try { value = getCredential(email, env); } catch { value = null; }
        assert.notEqual(value, password, `a ${length}-byte tag must never decrypt through this loader path`);
      }
    }
    fs.writeFileSync(file, original);
    assert.equal(getCredential(email, env), password, 'legitimate v1 bytes remain readable');
    const upper = JSON.parse(original); upper.records[email].tag = record.tag.toUpperCase();
    fs.writeFileSync(file, JSON.stringify(upper));
    assert.equal(getCredential(email, env), password, 'hex casing is not a tag-length violation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
