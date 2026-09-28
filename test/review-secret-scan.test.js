import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-scanner-review-'));
  fs.mkdirSync(join(root, 'scripts'));
  fs.mkdirSync(join(root, 'logs'));
  fs.copyFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url), join(root, 'scripts/secret-scan.mjs'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const run = args => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  return { root, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const secret = 'sk-' + ['K9rP', 'L8mQ'].join('').repeat(4);

it('an internal link to the repository root is scanned before cycle suppression', () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.root, 'secret.log'), secret);
    fs.symlinkSync(f.root, join(f.root, 'logs/root-link'), 'junction');
    const result = f.run(['scripts/secret-scan.mjs', 'logs']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /secret\.log:1 openai-api-key/);
    assert.ok(!result.stdout.includes(secret));
  } finally { f.cleanup(); }
});
it('a two-dot-prefixed directory inside the repository is not its parent', () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.root, '..notes'));
    fs.writeFileSync(join(f.root, '..notes/secret.log'), secret);
    const result = f.run(['scripts/secret-scan.mjs', '..notes']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /\.\.notes\/secret\.log:1 openai-api-key/);
  } finally { f.cleanup(); }
});
function injectedRun(f, body, arg) {
  const wrapper = join(f.root, 'injected.mjs');
  fs.writeFileSync(wrapper, "import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\n"
    + body + "\nsyncBuiltinESMExports();\nprocess.argv=['node','scanner'," + JSON.stringify(arg)
    + "];\nawait import(" + JSON.stringify(pathToFileURL(join(f.root, 'scripts/secret-scan.mjs')).href) + ");\n");
  return f.run([wrapper]);
}
it('an enumerated regular file whose real path is unreadable cannot disappear from a clean verdict', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'logs/unreadable.log'); fs.writeFileSync(target, 'ordinary text');
    const result = injectedRun(f, 'const real = fs.realpathSync; fs.realpathSync = p => { if (p === '
      + JSON.stringify(target) + ') throw Object.assign(new Error("synthetic denial"), {code:"EACCES"}); return real(p); };', 'logs');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /refusing|partial|cannot|unresolv/i);
  } finally { f.cleanup(); }
});
it('an explicitly named file disappearing after validation is incomplete, not clean', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'logs/disappeared.log'); fs.writeFileSync(target, 'ordinary text');
    const result = injectedRun(f, 'const exists = fs.existsSync; let reads = 0; fs.existsSync = p => p === '
      + JSON.stringify(target) + ' && ++reads > 1 ? false : exists(p);', 'logs/disappeared.log');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /refusing|partial|cannot|disappear/i);
  } finally { f.cleanup(); }
});
