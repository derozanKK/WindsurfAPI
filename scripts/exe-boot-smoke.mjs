#!/usr/bin/env node
/**
 * Boot-smoke a packaged binary, not whichever service occupies the port.
 * All three executable release jobs use this entry point. Synthetic runtime
 * credentials and a fresh DATA_DIR prevent reading/writing adjacent user state.
 * A pass covers this child's health, dashboard HTML and two representative JSON
 * assets, not every bundled asset or real upstream model behaviour.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT || 3999);
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 20000);
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const OUTPUT_LIMIT = 64 * 1024;
const BODY_LIMIT = 4 * 1024 * 1024;
function defaultBinary() {
  if (process.platform === 'win32') return 'dist-windows/windsurfapi.exe';
  return 'dist-macos/windsurfapi-macos-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
}
const binary = resolve(process.argv[2] || defaultBinary());
let child = null, dataDir = null, childClosed = false, done = null;
let exitedEarly = null, output = '';
function appendOutput(bytes) { output = (output + bytes.toString()).slice(-OUTPUT_LIMIT); }
function childEnvironment() {
  // Preserve OS process-launch essentials, not the operator's account/proxy/config env.
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT',
    'HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return { ...env, DEVIN_CONNECT:'1', HOST:'127.0.0.1', PORT:String(PORT),
    API_KEY:'ci-smoke', DASHBOARD_PASSWORD:'ci-smoke-dashboard', DATA_DIR:dataDir,
    WINDSURFAPI_SKIP_DOTENV:'1', WINDSURFAPI_NO_OPEN:'1', RELOGIN_LIVE:'0',
    DEVIN_CONNECT_AUTO_RELOGIN:'0', NO_COLOR:'1' };
}
async function cleanup() {
  if (child && !childClosed) {
    try { child.kill('SIGKILL'); } catch { /* close/error listener is authoritative */ }
    let timer;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cannot confirm smoke child termination')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  if (dataDir) rmSync(dataDir, { recursive:true, force:true });
}
async function probe(route) {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + route, {
      signal: AbortSignal.timeout(3000), redirect:'error',
    });
    const reader = res.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > BODY_LIMIT) { await reader.cancel(); throw new Error('smoke body limit exceeded'); }
        chunks.push(Buffer.from(value));
      }
    }
    return { status:res.status, type:res.headers.get('content-type') || '', body:Buffer.concat(chunks).toString('utf8') };
  } catch { return { status:0, type:'', body:'' }; }
}
async function requireJsonAsset(route) {
  const result = await probe(route);
  let data = null;
  try { data = JSON.parse(result.body); } catch { /* rejected below */ }
  if (result.status !== 200 || !/application\/json/i.test(result.type)
      || !data || typeof data !== 'object' || !Object.keys(data).length) {
    throw new Error('missing or invalid bundled JSON asset: ' + route);
  }
  console.log('  PASS ' + route + ' JSON');
}
async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('invalid SMOKE_PORT');
  if (!Number.isFinite(BOOT_TIMEOUT_MS) || BOOT_TIMEOUT_MS < 1 || BOOT_TIMEOUT_MS > 300000) throw new Error('invalid SMOKE_BOOT_TIMEOUT_MS');
  if (!existsSync(binary)) throw new Error('binary not found: ' + binary);
  if (process.platform !== 'win32') { try { chmodSync(binary, 0o755); } catch {} }
  dataDir = mkdtempSync(join(tmpdir(), 'wa-smoke-'));
  console.log('boot-smoke ' + binary + ' (port ' + PORT + ')');
  child = spawn(binary, [], { env:childEnvironment(), stdio:['ignore','pipe','pipe'] });
  done = new Promise(resolveDone => child.once('close', () => { childClosed = true; resolveDone(); }));
  child.once('error', error => { exitedEarly = error.code || error.message; });
  child.once('exit', (code, signal) => { exitedEarly = signal || code; });
  child.stdout?.on('data', appendOutput); child.stderr?.on('data', appendOutput);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let health = { status:0 };
  while (Date.now() < deadline && exitedEarly === null) {
    health = await probe('/health');
    if (health.status === 200) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (exitedEarly !== null) throw new Error('binary exited before serving: ' + exitedEarly);
  if (health.status !== 200) throw new Error('/health did not become ready within the boot timeout');
  let identity = null;
  try { identity = JSON.parse(health.body); } catch { /* rejected below */ }
  if (!identity || identity.pid !== child.pid || identity.status !== 'ok'
      || identity.provider !== 'WindsurfAPI bydwgx1337' || identity.version !== VERSION) {
    throw new Error('/health identity/PID/version does not belong to the spawned binary');
  }
  console.log('  PASS /health identity pid=' + child.pid + ' version=' + identity.version);
  const dashboard = await probe('/dashboard');
  if (dashboard.status !== 200 || !/text\/html/i.test(dashboard.type)
      || !/<html\b/i.test(dashboard.body) || !/<body\b/i.test(dashboard.body) || dashboard.body.length < 1000) {
    throw new Error('/dashboard did not serve the bundled HTML');
  }
  console.log('  PASS /dashboard HTML');
  await requireJsonAsset('/dashboard/i18n/en.json');
  await requireJsonAsset('/dashboard/data/contributors.json');
  // Observe pending exit callbacks before approving; no claim about future uptime.
  await new Promise(r => setImmediate(r));
  if (exitedEarly !== null || childClosed) throw new Error('binary exited during smoke');
}
let code = 1;
try { await main(); code = 0; }
catch (error) { console.error('smoke failed: ' + (error?.message || error)); if (output) console.error(output.slice(-2000)); }
finally {
  try { await cleanup(); }
  catch (error) { code = 1; console.error('smoke cleanup failed: ' + error.message); }
}
if (code === 0) console.log('boot-smoke OK (owned process terminated)');
// close, unlike exit, includes draining the child stdio. Never force process.exit().
process.exitCode = code;
