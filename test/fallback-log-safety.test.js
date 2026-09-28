import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hostile = 'evil\n\u0085\u001b\u007f-model';
for (const success of [false, true]) {
  it(`fallback ${success ? 'success' : 'rejection'} persists sanitized nonempty log records`, () => {
    const policy = success
      ? { mode: 'allowlist', list: ['gemini-2.5-flash'], defaultModel: 'gemini-2.5-flash' }
      : { mode: 'allowlist', list: [], defaultModel: hostile };
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/fallback-log-scenario.mjs', import.meta.url))], {
      env: { ...process.env, RELOGIN_LIVE: '0', NODE_OPTIONS: `--import ${new URL('../scripts/mutation-network-deny.mjs', import.meta.url).href}`, A8_MODEL: hostile, A8_POLICY: JSON.stringify(policy) },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /"jsonlRecords": [1-9]/);
  });
}
