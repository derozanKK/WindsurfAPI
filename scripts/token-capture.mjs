#!/usr/bin/env node
/**
 * Capture a Windsurf auth token from a LOCAL browser window and import it.
 *
 * WHY THIS EXISTS
 * ---------------
 * windsurf.com's sign-in page finishes on /editor/show-auth-token, which calls
 * `GetOneTimeAuthToken` and renders the returned token in a read-only input.
 * The token never appears in the URL, so the dashboard's paste flow is the only
 * option when the gateway runs on another machine. When the gateway and the
 * browser are the SAME machine (a local deploy), this script closes that last
 * gap: it launches a throwaway browser profile with remote debugging, waits for
 * the operator to finish signing in (Google / GitHub / email code — the consent
 * step is always theirs), reads the token from the CDP network response (or the
 * page input as a fallback), and imports it through the dashboard API.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * - It never types credentials, never sends an email code, never bypasses a
 *   consent screen, and never touches an existing browser profile.
 * - It never writes the token to disk, and never prints it unless `--print` is
 *   passed explicitly (for an operator who wants to paste it elsewhere).
 * - It never talks to anything but 127.0.0.1 and windsurf.com.
 *
 * USAGE
 * -----
 *   node scripts/token-capture.mjs --password <dashboard password> [--port 3456]
 *   node scripts/token-capture.mjs --password ... --print     # do not import
 *
 * Requires Chrome/Edge (or chromium on Linux). Exit codes: 0 captured+imported,
 * 1 failed, 2 usage/browser missing.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const SIGNIN_URL = 'https://windsurf.com/windsurf/signin?response_type=token'
  + '&client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u&redirect_uri=show-auth-token'
  + '&state=token-capture&prompt=login&redirect_parameters_type=query&workflow=';
const TOKEN_RE = /^[A-Za-z0-9_\-.$]{20,400}$/;
const OTT_URL_PART = 'GetOneTimeAuthToken';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node scripts/token-capture.mjs --password <dashboard password> [--port 3456] [--timeout 300] [--print] [--browser <path>]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { port: 3456, timeout: 300, print: false, password: process.env.DASHBOARD_PASSWORD || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--password') out.password = String(argv[++i] || '');
    else if (a === '--browser') out.browser = String(argv[++i] || '');
    else if (a === '--print') out.print = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument ${a}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) usage('bad --port');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) usage('bad --timeout');
  if (!out.print && !out.password) usage('--password (or DASHBOARD_PASSWORD) is required to import');
  return out;
}

/** Minimal dependency-free WebSocket client (same framing as dashboard-cdp-check.mjs). */
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from(String(Math.random())).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshaken = false;
    let buf = Buffer.alloc(0);
    const listeners = [];
    const frames = () => {
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f;
        let off = 2;
        let len = l0;
        if (l0 === 126) { len = buf.readUInt16BE(2); off = 4; } else if (l0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        try { const msg = JSON.parse(payload.toString()); for (const fn of listeners) fn(msg); } catch { /* control frame */ }
      }
    };
    sock.on('data', (d) => {
      if (!handshaken) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        handshaken = true;
        buf = buf.subarray(i + 4);
        resolve(api);
        if (buf.length) frames();
        return;
      }
      buf = Buffer.concat([buf, d]);
      frames();
    });
    sock.on('error', reject);
    const send = (obj) => {
      const data = Buffer.from(JSON.stringify(obj));
      const header = [0x81];
      if (data.length < 126) header.push(0x80 | data.length);
      else if (data.length < 65536) header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
      else header.push(0x80 | 127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
      sock.write(Buffer.concat([Buffer.from(header), Buffer.from([0, 0, 0, 0]), data]));
    };
    const api = { send, on: (fn) => listeners.push(fn), close: () => sock.destroy() };
  });
}

function maskAccount(account) {
  const email = String(account?.email || '');
  if (!email.includes('@')) return email ? `${email.slice(0, 4)}…` : '(no email)';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Extract a token-shaped string from page text, preferring the read-only input. */
function pickTokenFromDom(value) {
  const raw = String(value || '').trim();
  if (TOKEN_RE.test(raw)) return raw;
  const m = raw.match(/[A-Za-z0-9_\-.$]{40,400}/);
  return m ? m[0] : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = args.browser || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!browser) {
    console.error('error: Chrome/Edge not found. Pass --browser <path>.');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'windsurf-token-'));
  const portFile = join(profile, 'DevToolsActivePort');
  const chrome = spawn(browser, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', cleanup);

  let devtoolsPort = 0;
  for (let i = 0; i < 100 && !devtoolsPort; i++) {
    await sleep(100);
    if (!existsSync(portFile)) continue;
    const first = readFileSync(portFile, 'utf8').split('\n')[0];
    devtoolsPort = Number(first);
  }
  if (!devtoolsPort) {
    console.error('error: the browser never exposed a DevTools port');
    cleanup();
    process.exit(1);
  }

  // Open the sign-in page in its own tab and attach to it.
  const tab = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(SIGNIN_URL)}`, { method: 'PUT' })
    .then((r) => r.json());
  const ws = await connectWS(tab.webSocketDebuggerUrl);

  let msgId = 0;
  const pending = new Map();
  const responses = [];
  ws.on((msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    if (msg.method === 'Network.responseReceived') responses.push(msg.params);
  });
  const cmd = (method, params) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send({ id, method, params: params || {} });
  });

  await cmd('Network.enable');
  await cmd('Page.enable');

  console.log('Sign in in the window that just opened (Google / GitHub / email code).');
  console.log('Waiting for the show-auth-token page…');

  const deadline = Date.now() + args.timeout * 1000;
  let token = '';
  let capturedVia = '';
  while (Date.now() < deadline && !token) {
    await sleep(700);
    // 1) The authoritative source: the GetOneTimeAuthToken JSON response.
    for (let i = responses.length - 1; i >= 0 && !token; i--) {
      const r = responses[i];
      if (!String(r.response?.url || '').includes(OTT_URL_PART)) continue;
      const body = await cmd('Network.getResponseBody', { requestId: r.requestId });
      try {
        const parsed = JSON.parse(body?.body || '{}');
        if (typeof parsed.authToken === 'string' && TOKEN_RE.test(parsed.authToken)) {
          token = parsed.authToken;
          capturedVia = 'GetOneTimeAuthToken response';
        }
      } catch { /* not JSON — ignore */ }
    }
    if (token) break;
    // 2) Fallback: the read-only input the page renders the token into.
    const evaled = await cmd('Runtime.evaluate', {
      expression: `(() => { const i = document.querySelector('input[readonly], input[type="text"]'); return i ? i.value : ''; })()`,
      returnByValue: true,
    });
    const fromDom = pickTokenFromDom(evaled?.result?.value);
    if (fromDom) {
      token = fromDom;
      capturedVia = 'show-auth-token page';
    }
  }

  ws.close();
  if (!token) {
    console.error(`error: no token captured within ${args.timeout}s (sign-in not completed?)`);
    cleanup();
    process.exit(1);
  }
  console.log(`Captured a token from the ${capturedVia} (${token.length} chars).`);

  if (args.print) {
    // Deliberate, explicit: the operator asked for the value on stdout.
    console.log(token);
    cleanup();
    process.exit(0);
  }

  const res = await fetch(`http://127.0.0.1:${args.port}/dashboard/api/windsurf-login/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-password': args.password },
    body: JSON.stringify({ token }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  if (res.status !== 200 || !res.body?.success) {
    // The response never contains the token, so it is safe to print verbatim.
    console.error(`error: import failed (HTTP ${res.status}): ${res.body?.error || 'unknown'}`);
    cleanup();
    process.exit(1);
  }
  console.log(`Imported into the account pool: ${maskAccount(res.body.account)} (${res.body.account?.status || 'unknown'}).`);
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(`error: ${err?.message || err}`);
  process.exit(1);
});
