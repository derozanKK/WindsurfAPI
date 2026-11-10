#!/usr/bin/env node
/**
 * Negative controls for the smoke matrix: one deliberate product break per
 * family, and the matrix must go red in THAT family.
 *
 * Why a separate opt-in script: each mutant costs a full matrix boot, so this
 * is evidence-grade tooling, not a per-commit gate. It is the check that keeps
 * the matrix honest — a family whose assertions never bite is decoration.
 *
 * Contract per mutant:
 *   1. the anchor must appear EXACTLY ONCE (a silent no-op would report a
 *      false SURVIVED, the same trap scripts/mutate-verify.mjs documents);
 *   2. the patched file is written, the matrix child is run, and at least one
 *      `FAIL  [<family>]` line must appear with a non-zero exit;
 *   3. the original bytes are restored and verified by sha256, even on throw.
 *
 * A crash leaves `<file>.smoke-mutant-backup` behind instead of a silently
 * patched tree; the next run refuses to start until it is resolved.
 *
 * Usage:
 *   node scripts/smoke-matrix-mutants.mjs [--only <family>] [--keep-going]
 *
 * Exit 0 = baseline green and every mutant caught. Exit 1 = a mutant survived
 * or the baseline was red. Exit 2 = the harness could not produce a verdict.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TIMEOUT_MS = 180_000;
const BACKUP_SUFFIX = '.smoke-mutant-backup';

/**
 * At least one break per family; `login` carries a second for the wave-3
 * non-auth1 probe. Anchors are verified unique at run time.
 * `family` is the family that must report the FAIL line.
 */
const MUTANTS = [
  {
    family: 'core',
    name: 'health reports a non-ok status',
    file: 'src/server.js',
    anchor: "      status: 'ok',",
    replacement: "      status: 'mutated',",
  },
  {
    family: 'auth',
    name: 'API-key gate disabled',
    file: 'src/server.js',
    anchor: '  if (!validateApiKey(extractToken(req))) {',
    replacement: '  if (false && !validateApiKey(extractToken(req))) {',
  },
  {
    family: 'dashboard',
    name: 'dashboard auth gate disabled',
    file: 'src/dashboard/api.js',
    anchor: "  if (subpath !== '/auth' && !checkAuth(req)) {",
    replacement: "  if (false && subpath !== '/auth' && !checkAuth(req)) {",
  },
  {
    family: 'login',
    name: 'upstream "not_found" treated as a login method',
    file: 'src/dashboard/windsurf-login.js',
    anchor: "  const method = rawMethod && rawMethod !== 'not_found' ? rawMethod : null;",
    replacement: '  const method = rawMethod || null;',
  },
  {
    family: 'accounts',
    name: 'add-account reports success:false',
    file: 'src/dashboard/api.js',
    anchor: '        success: true,\n        account: { id: account.id, email: account.email, method: account.method, status: account.status },',
    replacement: '        success: false,\n        account: { id: account.id, email: account.email, method: account.method, status: account.status },',
  },
  {
    family: 'models',
    name: 'catalog ids replaced',
    file: 'src/models.js',
    anchor: '      id: info.name,',
    replacement: "      id: 'mutated-model',",
  },
  {
    family: 'openai',
    name: 'stream chunk object renamed',
    file: 'src/devin-connect-openai.js',
    anchor: "const OBJECT_CHUNK = 'chat.completion.chunk';",
    replacement: "const OBJECT_CHUNK = 'mutated.chunk';",
  },
  {
    family: 'messages',
    name: 'Anthropic envelope type renamed',
    file: 'src/handlers/messages.js',
    anchor: '  return {\n    id: msgId,\n    type: \'message\',',
    replacement: '  return {\n    id: msgId,\n    type: \'mutated_message\',',
  },
  {
    family: 'responses',
    name: 'Responses object type renamed',
    file: 'src/handlers/responses.js',
    anchor: "  return {\n    id: responseId,\n    object: 'response',\n    created_at: chatBody.created || Math.floor(Date.now() / 1000),",
    replacement: "  return {\n    id: responseId,\n    object: 'mutated_response',\n    created_at: chatBody.created || Math.floor(Date.now() / 1000),",
  },
  {
    family: 'gemini',
    name: 'clean finish reported as MUTATED',
    file: 'src/handlers/gemini.js',
    anchor: "  stop: 'STOP',",
    replacement: "  stop: 'MUTATED',",
  },
  {
    family: 'dashboard-live',
    name: 'request ring drops the protocol column',
    file: 'src/dashboard/request-ring.js',
    anchor: "    protocol: typeof row.protocol === 'string' ? row.protocol.slice(0, 32) : null,",
    replacement: '    protocol: null,',
  },
  {
    family: 'acp',
    name: 'ACP agent message chunk ignored',
    file: 'src/devin-acp.js',
    anchor: 'agent_message_chunk',
    replacement: 'agent_message_chunk_mutated',
  },
  {
    family: 'i18n',
    name: 'zh-CN nav.overview untranslated',
    file: 'src/dashboard/i18n/zh-CN.json',
    anchor: '      "settings": "设置 · 高级"\n    },\n    "overview": "仪表盘",',
    replacement: '      "settings": "设置 · 高级"\n    },\n    "overview": "Dashboard",',
  },
  {
    family: 'hygiene',
    name: 'upstream echoes a pool credential (leak control)',
    file: 'test/helpers/smoke-matrix-upstream.mjs',
    anchor: "    yield { type: 'content', text: MATRIX.text };",
    replacement: "    yield { type: 'content', text: MATRIX.text + MATRIX.sessionTokenPassword };",
  },
  // ─── wave 6 families ──────────────────────────────────────────────────
  {
    family: 'login',
    name: 'non-auth1 probe method discarded (wave 3)',
    file: 'src/dashboard/windsurf-login.js',
    anchor: "          || (interpreted.method && interpreted.method !== 'auth1')) {",
    replacement: "          || (false && interpreted.method && interpreted.method !== 'auth1')) {",
  },
  {
    family: 'reauth',
    name: 'same token silently clears the reauth state',
    file: 'src/auth.js',
    anchor: "  if (apiKey != null && account.status === 'reauth' && apiKey === account.apiKey && !allowSameKey) {",
    replacement: '  if (false) {',
  },
  {
    family: 'acu',
    name: 'org handle is the raw upstream id',
    file: 'src/dashboard/acu-usage.js',
    anchor: "  return `orgref-${createHash('sha256').update(String(orgId || '')).digest('hex').slice(0, 12)}`;",
    replacement: "  return String(orgId || '');",
  },
  {
    family: 'request-history',
    name: 'billed-request history is always empty',
    file: 'src/auth.js',
    anchor: '  return { items: ring.slice(-n).reverse(), total: ring.length, capacity: ACCOUNT_REQUEST_CAP, summary };',
    replacement: '  return { items: [], total: 0, capacity: ACCOUNT_REQUEST_CAP, summary };',
  },
  {
    family: 'devin-cards',
    name: 'key card returns the raw credential',
    file: 'src/dashboard/devin-cards.js',
    anchor: '      apiKeyMasked: maskApiKey(account.apiKey),',
    replacement: '      apiKeyMasked: account.apiKey,',
  },
  {
    family: 'engines',
    name: 'declared Node floor lowered to 20',
    file: 'package.json',
    anchor: '    "node": ">=22.13.0"',
    replacement: '    "node": ">=20.0.0"',
  },
  {
    family: 'docker',
    name: 'healthcheck probes a path the server does not serve',
    file: 'Dockerfile',
    anchor: "+ '/health').then((r) => process.exit(r.ok ? 0 : 1))",
    replacement: "+ '/healthz').then((r) => process.exit(r.ok ? 0 : 1))",
  },
];

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function die(message) {
  console.error(`${RED}smoke-matrix-mutants: ${message}${RESET}`);
  process.exit(2);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertContained(file) {
  const absolute = resolve(ROOT, file);
  const rel = relative(ROOT, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) die(`target escapes the repo: ${file}`);
  return absolute;
}

function runMatrix() {
  return new Promise((resolvePromise) => {
    const env = { ...process.env, WINDSURFAPI_SKIP_DOTENV: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, ['scripts/smoke-matrix.mjs'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, ...result });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, signal: 'TIMEOUT' });
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    child.on('close', (code, signal) => finish({ code, signal }));
    child.on('error', (err) => finish({ code: null, signal: null, error: err }));
  });
}

function summaryLine(stdout) {
  return stdout.split('\n').find((line) => line.startsWith('SMOKE-MATRIX SUMMARY:')) || '(no summary line)';
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
  const keepGoing = args.includes('--keep-going');

  if (!existsSync(resolve(ROOT, 'scripts/smoke-matrix.mjs'))) die('scripts/smoke-matrix.mjs not found');

  // A leftover backup means a previous run died between patch and restore.
  for (const mutant of MUTANTS) {
    const absolute = assertContained(mutant.file);
    if (existsSync(absolute + BACKUP_SUFFIX)) {
      die(`leftover backup for ${mutant.file}; restore it before running again`);
    }
  }

  const selected = only ? MUTANTS.filter((m) => m.family === only) : MUTANTS;
  if (!selected.length) die(`no mutant for family ${only}`);

  console.log(`${DIM}baseline: node scripts/smoke-matrix.mjs${RESET}`);
  const baseline = await runMatrix();
  if (baseline.code !== 0) {
    die(`baseline matrix is not green (exit ${baseline.code})\n${summaryLine(baseline.stdout)}`);
  }
  console.log(`${GREEN}baseline green${RESET} — ${summaryLine(baseline.stdout)}`);

  const rows = [];
  for (const mutant of selected) {
    const absolute = assertContained(mutant.file);
    const original = readFileSync(absolute, 'utf8');
    const originalHash = sha256(original);
    const occurrences = original.split(mutant.anchor).length - 1;
    if (occurrences !== 1) {
      die(`anchor for "${mutant.name}" matched ${occurrences} times in ${mutant.file} (must be exactly 1)`);
    }

    const backupPath = absolute + BACKUP_SUFFIX;
    writeFileSync(backupPath, original, 'utf8');
    let result;
    try {
      writeFileSync(absolute, original.replace(mutant.anchor, mutant.replacement), 'utf8');
      result = await runMatrix();
    } finally {
      writeFileSync(absolute, original, 'utf8');
      if (sha256(readFileSync(absolute, 'utf8')) !== originalHash) {
        die(`RESTORE FAILED for ${mutant.file}; original bytes are in ${backupPath}`);
      }
      unlinkSync(backupPath);
    }

    const failLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith(`FAIL  [${mutant.family}]`));
    const caught = result.code !== 0 && !!failLine;
    rows.push({ ...mutant, caught, failLine: failLine || null, exit: result.code });
    if (caught) {
      console.log(`${GREEN}CAUGHT${RESET}   ${mutant.family.padEnd(14)} ${mutant.name}\n${DIM}         ${failLine}${RESET}`);
    } else {
      console.log(`${RED}SURVIVED${RESET} ${mutant.family.padEnd(14)} ${mutant.name} (exit ${result.code})`);
      if (result.stdout) {
        const failed = result.stdout.split('\n').filter((line) => line.startsWith('FAIL')).slice(0, 3);
        console.log(`${DIM}         ${failed.join('\n         ') || 'no FAIL line'}${RESET}`);
      }
      if (!keepGoing) break;
    }
  }

  const caughtCount = rows.filter((row) => row.caught).length;
  const survived = rows.filter((row) => !row.caught);
  console.log('');
  for (const row of rows) {
    console.log(`${row.caught ? GREEN + 'caught  ' : RED + 'survived'}${RESET} ${row.family.padEnd(14)} ${row.name}`);
  }
  console.log(`SMOKE-MATRIX MUTANTS: ${caughtCount}/${rows.length} caught${survived.length ? `, ${survived.length} survived` : ''}`);
  process.exit(survived.length === 0 && rows.length === selected.length ? 0 : 1);
}

try {
  await main();
} catch (err) {
  die(err?.stack || String(err));
}
