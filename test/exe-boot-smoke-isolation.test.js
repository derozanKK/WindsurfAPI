import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/exe-boot-smoke.mjs', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function portState(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish('listening'));
    socket.once('error', error => finish(error.code));
    socket.setTimeout(1000, () => finish('timeout'));
  });
}
async function exercise(missingLocale) {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-smoke-custody-'));
  const scratch = join(root, 'scratch'), callerData = join(root, 'caller-data');
  fs.mkdirSync(scratch); fs.mkdirSync(callerData);
  fs.writeFileSync(join(callerData, 'keep.txt'), 'caller-owned bytes');
  const receiptPath = join(root, 'receipt.json'), fixture = join(root, 'child.mjs'), hook = join(root, 'launch.mjs');
  const port = await freePort();
  // These are observed by the real child, not inferred from intercepted spawn options.
  const settings = { receiptPath, version: VERSION, missingLocale };
  fs.writeFileSync(fixture, "import fs from 'node:fs'; import http from 'node:http'; import {join} from 'node:path';\n"
    + 'const fixture = ' + JSON.stringify(settings) + ';\n'
    + "fs.writeFileSync(fixture.receiptPath, JSON.stringify({pid:process.pid,dataDir:process.env.DATA_DIR,apiKey:process.env.API_KEY,password:process.env.DASHBOARD_PASSWORD,skipDotenv:process.env.WINDSURFAPI_SKIP_DOTENV,providerToken:process.env.DEVIN_CONNECT_SESSION_TOKEN,proxy:process.env.HTTP_PROXY}));\n"
    + "fs.writeFileSync(join(process.env.DATA_DIR,'created-by-child.txt'),'synthetic app state');\n"
    + "http.createServer((q,s)=>{if(q.url==='/health'){s.setHeader('content-type','application/json');s.end(JSON.stringify({status:'ok',provider:'WindsurfAPI bydwgx1337',version:fixture.version,pid:process.pid}));}"
    + "else if(q.url==='/dashboard'){s.setHeader('content-type','text/html');s.end('<html><body>'+'fixture '.repeat(200)+'</body></html>');}"
    + "else{s.setHeader('content-type','application/json');if(fixture.missingLocale&&q.url==='/dashboard/i18n/en.json')s.statusCode=404;s.end(JSON.stringify({fixture:true}));}}).listen(Number(process.env.PORT),'127.0.0.1');\n");
  fs.writeFileSync(hook, "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\n"
    + 'const original=cp.spawn; cp.spawn=(file,args,options)=>original(file,[' + JSON.stringify(fixture) + '],options); syncBuiltinESMExports();\n');
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  Object.assign(env, { TMP: scratch, TEMP: scratch, TMPDIR: scratch, SMOKE_PORT: String(port),
    SMOKE_BOOT_TIMEOUT_MS: '2500', RELOGIN_LIVE: '0', NO_COLOR: '1', DATA_DIR: callerData,
    API_KEY: 'fixture-parent-api-key', DASHBOARD_PASSWORD: 'fixture-parent-password',
    DEVIN_CONNECT_SESSION_TOKEN: 'fixture-parent-provider-token', HTTP_PROXY: 'http://fixture.invalid:9',
    WINDSURFAPI_SKIP_DOTENV: '0' });
  let receipt = null;
  try {
    const result = await new Promise(resolve => {
      const driver = spawn(process.execPath, ['--import', pathToFileURL(hook).href, SCRIPT, process.execPath],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = null, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; driver.kill('SIGKILL'); }, 12000);
      driver.stdout.on('data', b => { output = (output + b).slice(-65536); });
      driver.stderr.on('data', b => { output = (output + b).slice(-65536); });
      driver.once('error', e => { error = e.code; });
      driver.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, error, timedOut, output }); });
    });
    if (fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath));
    const rel = receipt ? relative(scratch, receipt.dataDir) : '..';
    return { ...result, receipt, createdInsideScratch: rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel),
      removedOwnData: receipt ? !fs.existsSync(receipt.dataDir) : false,
      callerData: fs.readFileSync(join(callerData, 'keep.txt'), 'utf8'), portState: await portState(port) };
  } finally {
    // Only this fixture's recorded child may be terminated on an assertion/driver failure.
    if (!receipt && fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath));
    if (Number.isInteger(receipt?.pid)) { try { process.kill(receipt.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function assertCustody(r) {
  assert.equal(r.error, null, r.output); assert.equal(r.signal, null, r.output); assert.equal(r.timedOut, false, r.output);
  assert.ok(r.receipt, 'the actual spawned child must return an observation');
  assert.ok(r.receipt.apiKey && r.receipt.apiKey !== 'fixture-parent-api-key', 'supply a synthetic API credential');
  assert.ok(r.receipt.password && r.receipt.password !== 'fixture-parent-password', 'supply a synthetic dashboard credential, preventing packaged first-run generation');
  assert.equal(r.receipt.skipDotenv, '1', 'adjacent operator configuration must not be loaded');
  assert.equal(r.receipt.providerToken, undefined, 'provider credentials must not cross into the smoke child');
  assert.equal(r.receipt.proxy, undefined, 'operator proxy settings must not cross into the smoke child');
  assert.equal(r.createdInsideScratch, true, 'the child must use a newly owned directory');
  assert.equal(r.removedOwnData, true, 'check removal before the test fixture removes its own parent');
  assert.equal(r.callerData, 'caller-owned bytes', 'never remove the caller data directory');
  assert.equal(r.portState, 'ECONNREFUSED', 'the application listener is gone when the verifier returns');
}
it('successful binary smoke isolates child credentials and removes only its own application state', async () => {
  const r = await exercise(false); assert.equal(r.status, 0, r.output); assertCustody(r);
});
it('failed asset smoke still closes its child and removes only its own application state', async () => {
  const r = await exercise(true); assert.equal(r.status, 1, r.output); assert.match(r.output, /i18n|locale/i); assertCustody(r);
});
