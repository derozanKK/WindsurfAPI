// A8-FALLBACK variant probe — one hostile fragment at a time.
//
// Same real modules and the same stub boundary as the registered probe
// (.agent/audit-20260922/evidence/probes/a8-model-fallback-log-escape/probe.mjs):
// the real src/handlers/chat.js handleChatCompletions, the real config logger,
// the real dashboard logger persistence patch, and a synthetic model-access.json
// in a throwaway DATA_DIR. No network, no account, no repo write, no real secret.
//
// Differences, both deliberate:
//   * the policy and the hostile model come from the environment (A8_POLICY /
//     A8_MODEL), so the rejection line and the fallback-success line can each be
//     exercised against the fragment it prints;
//   * the verdict is "did ANY raw C0/C1/DEL byte reach a log-message argument",
//     not "does the caller's model appear verbatim" — the mutation controls need
//     to detect a hostile fragment in the *fallback* field too.
//
// Run:
//   A8_POLICY='{"mode":"allowlist","list":[],"defaultModel":"x"}' node a8-log-escape-variants.mjs

process.env.WINDSURFAPI_SKIP_DOTENV = '1';

import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = new URL('../../', import.meta.url);
const srcUrl = (p) => new URL(`src/${p}`, SRC_ROOT).href;

const TMP = mkdtempSync(join(tmpdir(), 'a8-variant-'));
process.env.DATA_DIR = TMP;

const policy = JSON.parse(process.env.A8_POLICY || '{"mode":"allowlist","list":[],"defaultModel":"no-such-model-xyz"}');
writeFileSync(join(TMP, 'model-access.json'), JSON.stringify(policy));

const ESC = '\u001b';
const BEL = '\u0007';
const MODEL = process.env.A8_MODEL || `evil${ESC}[31mRED${ESC}]0;pwned${BEL}-model`;

const { config, log } = await import(srcUrl('config.js'));
await import(srcUrl('dashboard/logger.js'));
const { handleChatCompletions } = await import(srcUrl('handlers/chat.js'));

const captured = [];
const consoleLines = [];
const origConsole = { warn: console.warn, error: console.error, log: console.log };
console.warn = (...a) => consoleLines.push(a.map(String).join(' '));
console.error = (...a) => consoleLines.push(a.map(String).join(' '));
console.log = (...a) => consoleLines.push(a.map(String).join(' '));
for (const level of ['debug', 'info', 'warn', 'error']) {
  const prev = log[level];
  log[level] = (...a) => {
    captured.push({ level, msg: a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') });
    return prev(...a);
  };
}

// The fallback-success policy continues into routing, where a real account queue
// would block. This probe measures the LOG boundary, so the call is bounded and
// the verdict is taken from what was already logged.
const handled = handleChatCompletions(
  { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
  {},
).catch((e) => ({ status: 0, error: String(e && e.message) }));
const raced = await Promise.race([
  handled,
  new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), 1500)),
]);

const logDir = join(config.dataDir, 'logs');
const readLines = (f) => (existsSync(join(logDir, f)) ? readFileSync(join(logDir, f), 'utf-8').split('\n').filter(Boolean) : []);
await new Promise((r) => setTimeout(r, 250));
const appLines = readdirSync(logDir).filter(f => /^app-.*\.jsonl$/.test(f)).flatMap(readLines);
const records = appLines.map(line => JSON.parse(line));

const hasRawControl = (s) => typeof s === 'string' && /[\u0000-\u001f\u007f-\u009f]/.test(s) ;
const rawInLogArgs = captured.filter((c) => hasRawControl(c.msg));

const out = {
  probe: 'A8-FALLBACK-variants',
  policy,
  request_model_has_control_bytes: hasRawControl(MODEL),
  response_status: raced?.status ?? null,
  log_calls: captured.length,
  log_call_messages: captured.map((c) => ({ level: c.level, msg: c.msg })),
  rawControlInLogArgs: rawInLogArgs.length > 0,
  rawControlLogLines: rawInLogArgs.map((c) => c.msg),
  consoleLinesWithRawBytes: consoleLines.filter((l) => l.includes(ESC) || l.includes(BEL)).length,
  jsonlRecords: appLines.length,
  jsonlWithRawControl: appLines.filter((l) => {
    // The JSONL record escapes control bytes as \uXXXX, so a raw byte means the
    // writer passed one through unescaped.
    try { return hasRawControl(JSON.parse(l).msg || ''); } catch { return false; }
  }).length,
};

console.log = origConsole.log;
console.warn = origConsole.warn;
console.error = origConsole.error;
process.stdout.write(`PROBE a8-variants ${JSON.stringify(out, null, 2)}\n`);
// The routing path may still be waiting on an account queue; the measurement is
// complete, so the probe exits rather than inheriting that wait.
const target = records.filter(r => /blocked.*(?:falling back|default model)/.test(r.msg));
assert.ok(target.length > 0, 'A8 expected fallback record must reach persistent sink');
assert.ok(captured.some(r => /blocked.*(?:falling back|default model)/.test(r.msg)), 'A8 intended fallback branch reached');
assert.equal(rawInLogArgs.length, 0, 'A8 no raw controls in log arguments');
assert.equal(records.filter(r => hasRawControl(r.msg)).length, 0, 'A8 no raw controls in persisted messages');
process.exit(0);
