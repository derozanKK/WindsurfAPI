// WHY THIS IS A CHILD PROCESS. The packaged first-run credential bootstrap runs once,
// at import time of src/config.js, against process.pkg / process.execPath / DATA_DIR
// and the process environment. src/dashboard/logger.js then patches `log` in place and
// keeps its ring buffer, subscriber set and JSONL streams in module state. Neither can
// be re-armed inside a running process, so each scenario gets its own process.
//
// WHAT IS REAL HERE: src/config.js (its packaged branch), src/dashboard/logger.js (the
// persist patch), and the actual startup print block of src/index.js — extracted by
// marker + string-aware brace matching and evaluated with vm, never re-typed. WHAT IS
// FAKE: the exe location (a temp dir), the data dir, and the `.env` under test.
//
// NO REAL CREDENTIAL IS TOUCHED: .env loading is disabled (WINDSURFAPI_SKIP_DOTENV=1),
// every preset value is an obvious fixture string, and this harness reports secret
// values as occurrence counts only — the generated randoms are never echoed.
//
// Exit codes: 0 observation printed, 2 usage, 3 the harness itself could not run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIOS = ['generated', 'preset', 'partial', 'persist-failure'];
const SCENARIO = process.argv[2];
if (!SCENARIOS.includes(SCENARIO)) {
  console.error(`usage: node test/helpers/bootstrap-credential-scenario.mjs <${SCENARIOS.join('|')}>`);
  process.exit(2);
}

const PRESET = {
  API_KEY: 'sk-preset-fixture-key-not-a-real-credential',
  DASHBOARD_PASSWORD: 'preset-fixture-password-not-a-real-credential',
};
const BLOCK_MARKER = 'if (config.generatedCreds) {';
const CREDENTIAL_KEYS = ['API_KEY', 'DASHBOARD_PASSWORD'];

// ---- packaged first run, in a throwaway exe directory ----------------------
const exeDir = realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-creds-')));
process.pkg = {};
process.execPath = join(exeDir, 'windsurfapi.exe');
process.env.WINDSURFAPI_SKIP_DOTENV = '1';
process.env.DATA_DIR = join(exeDir, 'data');
if (SCENARIO === 'preset' || SCENARIO === 'partial') process.env.API_KEY = PRESET.API_KEY;
if (SCENARIO === 'preset') process.env.DASHBOARD_PASSWORD = PRESET.DASHBOARD_PASSWORD;
// A directory where the exe expects `.env`: existsSync is true, the write cannot succeed.
if (SCENARIO === 'persist-failure') mkdirSync(join(exeDir, '.env'));

// ---- capture both console and the logger's sinks ---------------------------
const lines = [];
const emit = (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : safeString(a))).join(' '));
const saved = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  saved[level] = console[level].bind(console);
  console[level] = emit;
}
const say = (...args) => saved.log(...args);
const restore = () => { for (const level of Object.keys(saved)) console[level] = saved[level]; };

function safeString(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** The real print block, from its marker to the brace that closes it. */
function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`startup print block not found: ${marker}`);
  let depth = 0;
  let quote = null;
  for (let i = start + marker.length - 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment inside the print block');
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('the startup print block never closed — refusing to evaluate a partial extract');
}

const { config, log } = await import(pathToFileURL(join(ROOT, 'src', 'config.js')).href);
const { getLogs, subscribeToLogs } = await import(pathToFileURL(join(ROOT, 'src', 'dashboard', 'logger.js')).href);

const entries = [];
const onEntry = entry => entries.push(entry);
subscribeToLogs(onEntry);

const indexSource = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
vm.runInNewContext(extractBlock(indexSource, BLOCK_MARKER), { config, log, console },
  { filename: 'src/index.js#generatedCredsBlock' });

// Positive control for the persistent sinks: this non-secret line MUST reach both
// JSONL files. Without it, "the credentials are absent from the log" would be a claim
// about files nobody proved were being written at all.
const SENTINEL = `bootstrap-creds-scenario-sentinel-${SCENARIO}`;
log.warn(SENTINEL);

const logDir = join(config.dataDir, 'logs');
const day = new Date().toISOString().slice(0, 10);
const appFile = join(logDir, `app-${day}.jsonl`);
const errFile = join(logDir, `error-${day}.jsonl`);
const readText = file => (existsSync(file) ? readFileSync(file, 'utf8') : '');

let appText = '';
let errText = '';
for (let i = 0; i < 120; i++) {
  appText = readText(appFile);
  errText = readText(errFile);
  if (appText.includes(SENTINEL) && errText.includes(SENTINEL)) break;
  await new Promise(r => setTimeout(r, 25));
}
if (!appText.includes(SENTINEL) || !errText.includes(SENTINEL)) {
  restore();
  console.error(`harness: the logger never flushed ${SENTINEL} to ${appFile} / ${errFile}`);
  process.exit(3);
}

// ---- occurrence counts, never the values themselves ------------------------
const count = (text, value) => (!value || !text ? 0 : text.split(value).length - 1);
const bufferText = getLogs(0).map(entry => JSON.stringify(entry)).join('\n');
const subscriberText = entries.map(entry => JSON.stringify(entry)).join('\n');
const consoleText = lines.join('\n');

const generated = config.generatedCreds;
const checks = CREDENTIAL_KEYS.map((key) => {
  const generatedValue = generated && typeof generated[key] === 'string' ? generated[key] : null;
  const origin = generatedValue ? 'generated' : (process.env[key] ? 'preset' : 'absent');
  const value = generatedValue ?? (origin === 'preset' ? process.env[key] : null);
  return {
    key,
    origin,
    consoleHits: count(consoleText, value),
    appJsonlHits: count(appText, value),
    errorJsonlHits: count(errText, value),
    bufferHits: count(bufferText, value),
    subscriberHits: count(subscriberText, value),
    inProcessEnv: generated ? process.env[key] === generatedValue : null,
    inConfig: generated ? (key === 'API_KEY' ? config.apiKey : config.dashboardPassword) === generatedValue : null,
  };
});

// statSync, not `existsSync(join(path, '.'))`: Windows normalizes a trailing `\.` away,
// so the existsSync probe reports a regular file as a directory.
const envFile = join(exeDir, '.env');
const envFileStat = (() => { try { return statSync(envFile); } catch { return null; } })();
const envFileText = envFileStat && envFileStat.isFile() ? readText(envFile) : '';

const observation = {
  scenario: SCENARIO,
  root: ROOT,
  exeDir,
  dataDir: config.dataDir,
  generatedKeys: generated
    ? CREDENTIAL_KEYS.filter(key => typeof generated[key] === 'string')
    : [],
  generatedEnvPath: generated ? generated.envPath ?? null : null,
  generatedPersistError: generated ? generated.persistError ?? null : null,
  envFile: {
    exists: envFileStat !== null,
    isDirectory: envFileStat?.isDirectory() ?? false,
    hasApiKey: generated?.API_KEY ? envFileText.includes(generated.API_KEY) : false,
    hasDashboardPassword: generated?.DASHBOARD_PASSWORD ? envFileText.includes(generated.DASHBOARD_PASSWORD) : false,
  },
  consoleLineCount: lines.length,
  checks,
  nonsecret: {
    bannerOnConsole: consoleText.includes('已为你自动生成密钥'),
    bannerLogged: bufferText.includes('已为你自动生成密钥'),
    persistExplanationLogged: /已写入|写入 \.env 失败/.test(bufferText),
    sentinelLogged: bufferText.includes(SENTINEL),
    sentinelOnDisk: appText.includes(SENTINEL) && errText.includes(SENTINEL),
  },
  sinks: { appFile, errFile, appLines: appText.split('\n').filter(Boolean).length, bufferEntries: getLogs(0).length, subscriberEntries: entries.length },
};

restore();
say(JSON.stringify(observation, null, 2));
