// Sentinel child for test/test-network-guard.test.js (D-TEST-EGRESS).
//
// The question this child answers is narrow and must not be blurred: does
// test/setup-env.mjs install the fail-closed transport guard BY ITSELF? A
// caller-supplied `--import scripts/mutation-network-deny.mjs` preload installs
// the same guard and would make a missing default enforcement look green, so the
// parent removes NODE_OPTIONS for this child and the child asserts it stayed
// removed. The mirror case — an explicit preload that must still win — runs this
// same child as `probe --preload=1`, where the guard is expected to come from the
// preload instead.
//
// Nothing in here may dial. Unless a guard is already installed, every guarded
// native transport entry point (net.connect/createConnection, tls.connect,
// http.request/get, https.request/get) and globalThis.fetch is replaced with a
// counted terminal stub that throws TEST_TRANSPORT_SENTINEL — no DNS, no socket,
// not even for a reserved domain. Counted entry observers are then layered ABOVE
// the guard: they only pass the call down, so they can prove a real call site
// reached the transport without weakening anything the guard decided.
//
// Modes (argv[2]):
//   guard-contract   default env, no preload. Full battery + the causal route
//                    (real addAccountByKey + __waitForModelCatalogSync).
//   probe            parent sets the environment; --expect=installed|skipped
//                    --preload=0|1 drives arming/partial-arming controls.
//   data-dir         WINDSURFAPI_TEST_DATA_DIR / skip-dotenv behaviour.
//
// Report: JSON at --report=<abs path>. Exit 0 iff every check passed.

import { writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const mode = argv[0] || 'guard-contract';
function flag(name, fallback = null) {
  const hit = argv.find(argument => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const reportPath = flag('report');
const expect = flag('expect', 'installed');
const preload = flag('preload', '0') === '1';

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');

const ENTRY_DEFS = [
  [net, 'connect', 'net.connect'],
  [net, 'createConnection', 'net.createConnection'],
  [tls, 'connect', 'tls.connect'],
  [http, 'request', 'http.request'],
  [http, 'get', 'http.get'],
  [https, 'request', 'https.request'],
  [https, 'get', 'https.get'],
];

const terminal = { count: 0, targets: [] };
const entryCounts = Object.create(null);
for (const [, , kind] of ENTRY_DEFS) entryCounts[kind] = 0;
entryCounts.fetch = 0;

const checks = [];
const failures = [];
let preloadedGuardDetected = null;

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
  return Boolean(ok);
}

function describeTarget(args) {
  const first = args[0];
  if (first instanceof URL) return first.href;
  if (typeof first === 'string') return first;
  if (typeof first === 'number') return String(args[1] ?? first);
  if (first && typeof first === 'object') {
    return first.hostname || first.host || first.servername || first.path || first.socketPath || '(object)';
  }
  return String(first);
}

function terminalStub(kind) {
  return function terminalTestStub(...args) {
    terminal.count += 1;
    terminal.targets.push(`${kind} -> ${describeTarget(args)}`);
    const error = new Error(`TEST_TRANSPORT_SENTINEL: ${kind} reached the terminal test stub (no socket, no DNS)`);
    error.code = 'TEST_TRANSPORT_SENTINEL';
    throw error;
  };
}

// The wrapper's name is used here as a SAFETY INTERLOCK only, never as an
// assertion: it decides whether installing a terminal stub would strip a guard
// that is already doing its job. Everything this child asserts is behavioural
// (which error code comes back, and how many terminal transports ran).
function guardedEntry(value) {
  return typeof value === 'function' && value.name === 'guardedNetworkCall';
}

function installTerminalStubs() {
  for (const [target, name, kind] of ENTRY_DEFS) target[name] = terminalStub(kind);
  globalThis.fetch = terminalStub('fetch');
  syncBuiltinESMExports();
}

function installEntryObservers() {
  for (const [target, name, kind] of ENTRY_DEFS) {
    const inner = target[name];
    target[name] = function countedEntryPoint(...args) {
      entryCounts[kind] += 1;
      return inner.apply(this, args);
    };
  }
  const innerFetch = globalThis.fetch;
  globalThis.fetch = function countedFetchEntryPoint(...args) {
    entryCounts.fetch += 1;
    return innerFetch.apply(this, args);
  };
}

async function probe(call) {
  const terminalBefore = terminal.count;
  const entryBefore = { ...entryCounts };
  let outcome;
  try {
    await call();
    outcome = { code: 'NO_THROW', message: '' };
  } catch (error) {
    outcome = { code: error?.code || 'NO_CODE', message: error?.message || String(error) };
  }
  const entryDelta = Object.create(null);
  for (const kind of Object.keys(entryCounts)) {
    const delta = entryCounts[kind] - entryBefore[kind];
    if (delta) entryDelta[kind] = delta;
  }
  return { ...outcome, terminalDelta: terminal.count - terminalBefore, entryDelta };
}

const LOOPBACK_PASS = [
  ['net.connect({host:127.0.0.1})', () => net.connect({ host: '127.0.0.1', port: 9 })],
  ['net.connect({host:localhost})', () => net.connect({ host: 'localhost', port: 9 })],
  ['net.connect({host:::1})', () => net.connect({ host: '::1', port: 9 })],
  ['net.connect({host:[::1]})', () => net.connect({ host: '[::1]', port: 9 })],
  ['net.connect({host:::ffff:127.0.0.1})', () => net.connect({ host: '::ffff:127.0.0.1', port: 9 })],
  ['net.connect({socketPath:/tmp/x.sock})', () => net.connect({ socketPath: '/tmp/x.sock' })],
  ['net.connect(\\\\.\\pipe\\x)', () => net.connect('\\\\.\\pipe\\x')],
  ['net.connect(9,127.0.0.1)', () => net.connect(9, '127.0.0.1')],
  ['net.connect(new URL(http://127.0.0.1:9/))', () => net.connect(new URL('http://127.0.0.1:9/'))],
  ['http.get(http://localhost:9/)', () => http.get('http://localhost:9/')],
  ['https.request({hostname:localhost.localdomain})', () => https.request({ hostname: 'localhost.localdomain', port: 9 })],
  ['fetch(http://127.0.0.1:9/)', () => fetch('http://127.0.0.1:9/')],
];

const REMOTE_DENY = [
  ['net.connect({hostname:egress.invalid})', () => net.connect({ hostname: 'egress.invalid', port: 443 })],
  ['net.createConnection({host:egress.invalid})', () => net.createConnection({ host: 'egress.invalid', port: 443 })],
  ['tls.connect({host:egress.invalid})', () => tls.connect({ host: 'egress.invalid', servername: 'egress.invalid', port: 443 })],
  ['http.request({host:egress.invalid})', () => http.request({ host: 'egress.invalid', port: 80 })],
  ['http.get(http://egress.invalid/)', () => http.get('http://egress.invalid/')],
  ['https.request({hostname:egress.invalid,port:443})', () => https.request({ hostname: 'egress.invalid', port: 443 })],
  ['https.get(https://egress.invalid/)', () => https.get('https://egress.invalid/')],
  ['net.connect(443,egress.invalid)', () => net.connect(443, 'egress.invalid')],
  ['fetch(https://egress.invalid/)', () => fetch('https://egress.invalid/')],
];

const SETUP_URL = new URL('./setup-env.mjs', import.meta.url).href;
const DENY_URL = new URL('../scripts/mutation-network-deny.mjs', import.meta.url).href;

const warnings = [];
function captureWarnings() {
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(argument => (typeof argument === 'string' ? argument : String(argument))).join(' '));
  };
  return () => { console.warn = original; };
}

async function runGuardContract() {
  check(
    'the sentinel child inherited no NODE_OPTIONS',
    !process.env.NODE_OPTIONS,
    `NODE_OPTIONS=${JSON.stringify(process.env.NODE_OPTIONS || '')}`,
  );

  installTerminalStubs();

  await import(SETUP_URL);

  check('setup keeps dotenv disabled', process.env.WINDSURFAPI_SKIP_DOTENV === '1');
  const dataDir = resolve(process.env.DATA_DIR || '');
  check(
    'setup points DATA_DIR at a fresh temp dir',
    dataDir.startsWith(resolve(tmpdir()) + sep) && dataDir.includes('windsurfapi-test-'),
    dataDir,
  );

  const lateValue = 'late-import-probe-not-a-secret';
  process.env.API_KEY = lateValue;
  const { config } = await import('../src/config.js');
  check(
    'env set after setup is visible to a later product import',
    config.apiKey === lateValue,
    `config.apiKey=${JSON.stringify(config.apiKey)}`,
  );
  check('setup did not pre-import config with a stale DATA_DIR', config.dataDir === process.env.DATA_DIR, String(config.dataDir));

  for (const [label, call] of REMOTE_DENY) {
    const result = await probe(call);
    check(
      `denied: ${label}`,
      result.code === 'NETWORK_STUB_MISS' && result.terminalDelta === 0,
      `code=${result.code} terminalDelta=${result.terminalDelta} message=${result.message}`,
    );
  }
  for (const [label, call] of LOOPBACK_PASS) {
    const result = await probe(call);
    check(
      `pass-through: ${label}`,
      result.code === 'TEST_TRANSPORT_SENTINEL' && result.terminalDelta === 1,
      `code=${result.code} terminalDelta=${result.terminalDelta} message=${result.message}`,
    );
  }

  await import(DENY_URL);
  const duplicateDeny = await probe(() => https.request({ hostname: 'egress.invalid', port: 443 }));
  check(
    'duplicate guard import stays denied',
    duplicateDeny.code === 'NETWORK_STUB_MISS' && duplicateDeny.terminalDelta === 0,
    `code=${duplicateDeny.code} terminalDelta=${duplicateDeny.terminalDelta}`,
  );
  const duplicatePass = await probe(() => net.connect({ host: '127.0.0.1', port: 9 }));
  check(
    'duplicate guard import keeps loopback pass-through',
    duplicatePass.code === 'TEST_TRANSPORT_SENTINEL' && duplicatePass.terminalDelta === 1,
    `code=${duplicatePass.code} terminalDelta=${duplicatePass.terminalDelta}`,
  );

  // Observers go on TOP of whatever the guard left in place: the guard refuses a
  // denied call before delegating, so a counter underneath it would read zero for
  // exactly the calls this child must prove happened.
  installEntryObservers();

  const catalog = await import('../src/devin-connect-catalog.js');
  catalog.__setCatalogRequestImpl(() => {
    const error = new Error('FAKE_TRANSPORT_SEAM_REACHED');
    error.code = 'FAKE_TRANSPORT_SEAM';
    throw error;
  });
  const seam = await probe(() => catalog.fetchCatalog({ token: 'seam-probe' }));
  check(
    'a test-installed fake transport still owns the seam',
    seam.code === 'FAKE_TRANSPORT_SEAM' && seam.terminalDelta === 0,
    `code=${seam.code} terminalDelta=${seam.terminalDelta} message=${seam.message}`,
  );
  catalog.__setCatalogRequestImpl(null);

  const terminalBeforeRoute = terminal.count;
  const httpsBeforeRoute = entryCounts['https.request'];
  const stopCapture = captureWarnings();
  try {
    const auth = await import('../src/auth.js');
    const account = auth.addAccountByKey('synthetic-egress-probe-key-0001', 'egress-probe');
    await auth.__waitForModelCatalogSync();
    auth.removeAccount(account.id);
  } finally {
    stopCapture();
  }

  const routeDenied = warnings.filter(line => line.includes('NETWORK_STUB_MISS'));
  check(
    'the real catalog sync is denied before any transport',
    routeDenied.length > 0,
    `warnings=${JSON.stringify(warnings.slice(-6))}`,
  );
  check(
    'the denied catalog call named the real upstream host',
    routeDenied.some(line => line.includes('server.codeium.com')),
    `warnings=${JSON.stringify(routeDenied.slice(0, 3))}`,
  );
  check(
    'no terminal transport ran during the catalog sync route',
    terminal.count - terminalBeforeRoute === 0,
    `terminalDelta=${terminal.count - terminalBeforeRoute} targets=${JSON.stringify(terminal.targets.slice(-4))}`,
  );
  check(
    'the catalog call sites reached the guarded transport entry',
    entryCounts['https.request'] - httpsBeforeRoute > 0,
    `https.request delta=${entryCounts['https.request'] - httpsBeforeRoute}`,
  );
}

async function runProbe() {
  const alreadyGuarded = guardedEntry(https.request) && guardedEntry(net.connect);
  preloadedGuardDetected = alreadyGuarded;
  if (!alreadyGuarded) {
    installTerminalStubs();
  } else {
    terminal.targets.push('(not installed: a guard was already in place)');
  }

  await import(SETUP_URL);
  installEntryObservers();

  const result = await probe(() => https.request({ hostname: 'egress.invalid', port: 443 }));
  const alsoNet = await probe(() => net.connect({ host: 'egress.invalid', port: 443 }));

  if (expect === 'skipped') {
    check(
      'the fully-armed live opt-in leaves the guard off',
      result.code === 'TEST_TRANSPORT_SENTINEL' && result.terminalDelta === 1
        && alsoNet.code === 'TEST_TRANSPORT_SENTINEL' && alsoNet.terminalDelta === 1,
      `https=${result.code}/${result.terminalDelta} net=${alsoNet.code}/${alsoNet.terminalDelta}`,
    );
  } else {
    check(
      'the guard is installed',
      result.code === 'NETWORK_STUB_MISS' && result.terminalDelta === 0
        && alsoNet.code === 'NETWORK_STUB_MISS' && alsoNet.terminalDelta === 0,
      `https=${result.code}/${result.terminalDelta} net=${alsoNet.code}/${alsoNet.terminalDelta} preloaded=${preload ? 1 : 0}`,
    );
  }
}

async function runDataDir() {
  await import(SETUP_URL);
  const requested = process.env.WINDSURFAPI_TEST_DATA_DIR;
  check('WINDSURFAPI_TEST_DATA_DIR is honoured', process.env.DATA_DIR === requested, `${process.env.DATA_DIR} vs ${requested}`);
  check('dotenv stays skipped under a caller DATA_DIR', process.env.WINDSURFAPI_SKIP_DOTENV === '1');
}

let report;
try {
  if (mode === 'guard-contract') await runGuardContract();
  else if (mode === 'probe') await runProbe();
  else if (mode === 'data-dir') await runDataDir();
  else throw new Error(`unknown mode: ${mode}`);

  report = {
    mode, expect, preload, ok: failures.length === 0, checks, failures,
    preloadedGuardDetected: typeof preloadedGuardDetected === 'boolean' ? preloadedGuardDetected : null,
    terminalCount: terminal.count, terminalTargets: terminal.targets.slice(-40),
    entryCounts, warnings: warnings.slice(-10),
    node: process.version, setupUrl: SETUP_URL,
  };
} catch (error) {
  report = {
    mode, expect, preload, ok: false, checks, failures: [...failures, `child crashed: ${error?.stack || error}`],
    preloadedGuardDetected: typeof preloadedGuardDetected === 'boolean' ? preloadedGuardDetected : null,
    terminalCount: terminal.count, terminalTargets: terminal.targets.slice(-40),
    entryCounts, warnings: warnings.slice(-10),
    node: process.version, setupUrl: SETUP_URL,
  };
}

if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
