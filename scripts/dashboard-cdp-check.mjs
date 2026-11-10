#!/usr/bin/env node
/**
 * Dashboard CDP smoke-check (NOT in npm test — needs Chrome + a running server).
 *
 * Boots a throwaway gateway on an alt port with DASHBOARD_ALLOW_NO_AUTH=1, loads
 * /dashboard in headless Chrome, drives the page over a dependency-free CDP
 * WebSocket, and asserts: (a) zero console errors / uncaught exceptions, (b) no
 * unresolved i18n keys leaked into the body text, (c) a caller-supplied list of
 * DOM assertions (id present / absent, textContent). Screenshots don't render in
 * this environment, so we assert on computed content, not pixels.
 *
 * Usage: node scripts/dashboard-cdp-check.mjs
 * Exit 0 = all pass, 1 = failure.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { existsSync } from 'node:fs';

const PORT = 3995, DBG = 9227;
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) { console.error('Chrome not found; skipping CDP check.'); process.exit(0); }

const env = { ...process.env, PORT: String(PORT), DASHBOARD_ALLOW_NO_AUTH: '1', HOST: '127.0.0.1', WINDSURFAPI_NO_OPEN: '1', API_KEY: 'cdp-test', DEVIN_CONNECT: '0' };
const srv = spawn(process.execPath, ['src/index.js'], { env, stdio: 'ignore' });
await sleep(4000);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/dash-cdp-prof', 'about:blank'], { stdio: 'ignore' });
await sleep(2500);
const cleanup = () => { try { chrome.kill(); } catch {} try { srv.kill(); } catch {} };

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from(Math.random().toString(36)).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let hs = false, buf = Buffer.alloc(0); const ls = [];
    sock.on('data', (d) => {
      if (!hs) { buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i >= 0) { hs = true; buf = buf.slice(i + 4); resolve(api); if (buf.length) frames(); } return; }
      buf = Buffer.concat([buf, d]); frames();
    });
    sock.on('error', reject);
    function frames() {
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f; let off = 2, len = l0;
        if (l0 === 126) { len = buf.readUInt16BE(2); off = 4; } else if (l0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const pl = buf.slice(off, off + len); buf = buf.slice(off + len);
        try { const m = JSON.parse(pl.toString()); ls.forEach(f => f(m)); } catch {}
      }
    }
    function send(o) {
      const data = Buffer.from(JSON.stringify(o)); const h = [0x81];
      if (data.length < 126) h.push(0x80 | data.length);
      else if (data.length < 65536) h.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
      else h.push(0x80 | 127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
      sock.write(Buffer.concat([Buffer.from(h), Buffer.from([0, 0, 0, 0]), data]));
    }
    const api = { send, on: (f) => ls.push(f), close: () => sock.destroy() };
  });
}

let id = 0; const pending = new Map(); const errors = [];
let failed = false;
function pass(name, ok, detail) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = true; }
try {
  const tab = await fetch(`http://127.0.0.1:${DBG}/json/new?http://127.0.0.1:${PORT}/dashboard`, { method: 'PUT' }).then(r => r.json());
  const ws = await connectWS(tab.webSocketDebuggerUrl);
  ws.on((m) => {
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '?'));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push('CONSOLE: ' + (m.params.args || []).map(a => a.value || a.description || '').join(' '));
  });
  const cmd = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send({ id: i, method, params: params || {} }); });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await sleep(3500);
  const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  // Assertions for the declutter change:
  pass('overview trend section removed', (await ev(`!document.getElementById('overview-trend-section')`)) === true);
  pass('overview trend canvas removed', (await ev(`!document.getElementById('overview-trend-canvas')`)) === true);
  pass('model pie canvas removed', (await ev(`!document.getElementById('model-pie-canvas')`)) === true);
  pass('model stats aggregate table present', (await ev(`!!document.getElementById('stats-agg-table')`)) === true);
  const rawKeys = await ev(`(document.body.innerText.match(/\\b(section|action|status|confirm|toast|overview|table|aria)\\.[a-zA-Z][a-zA-Z0-9.]+/g)||[]).slice(0,6)`);
  pass('no unresolved i18n keys in body', Array.isArray(rawKeys) && rawKeys.length === 0, JSON.stringify(rawKeys));
  pass('zero console errors / exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
  ws.close();
} catch (e) { pass('CDP driver ran', false, e.message); }
cleanup(); await sleep(400);
console.log(failed ? '\nFAILED' : '\nAll dashboard CDP checks passed.');
process.exit(failed ? 1 : 0);

