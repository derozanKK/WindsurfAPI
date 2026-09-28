import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/exe-boot-smoke.mjs', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const HTML = '<!doctype html><html><body>' + 'fixture dashboard '.repeat(100) + '</body></html>';
const health = pid => ({ status: 'ok', provider: 'WindsurfAPI bydwgx1337', version: VERSION, pid });
async function ownedListener(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: async () => {
    server.closeAllConnections(); await new Promise(r => server.close(r));
  } };
}
async function freePort() {
  const owned = await ownedListener((_q, s) => s.end());
  const port = owned.port; await owned.close(); return port;
}
async function exercise(mode, port, extraEnv = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'wa-boot-contract-'));
  const fixture = join(dir, 'child.mjs'), hook = join(dir, 'launcher.mjs');
  // The application dependency is a real child process with real loopback HTTP.
  // Only its launch arguments are supplied by the preload; the CLI under test is unchanged.
  fs.writeFileSync(fixture, "import http from 'node:http';\nconst mode=" + JSON.stringify(mode)
    + "; const html=" + JSON.stringify(HTML) + "; const version=" + JSON.stringify(VERSION) + ";\n"
    + "if(mode==='idle') { setInterval(()=>{},1000); } else if(mode==='exit') { process.exitCode=0; } else {\n"
    + "http.createServer((q,s)=>{ if(q.url==='/health'){s.setHeader('content-type','application/json');s.end(JSON.stringify({status:mode==='wrong-status'?'degraded':'ok',provider:mode==='wrong-provider'?'some-other-service':'WindsurfAPI bydwgx1337',version:mode==='wrong-version'?'0.0.0-fixture':version,pid:mode==='wrong-pid'?process.pid+1:process.pid}));}\n"
    + "else if(q.url==='/dashboard'){s.setHeader('content-type','text/html');s.end(mode==='bad-html'?'ok':html);}\n"
    + "else {s.setHeader('content-type','application/json');if(mode==='missing-locale'&&q.url==='/dashboard/i18n/en.json')s.statusCode=404;s.end(JSON.stringify({fixture:true}));}\n"
    + "}).listen(Number(process.env.PORT),'127.0.0.1'); }\n");
  fs.writeFileSync(hook, "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\n"
    + "const real=cp.spawn; cp.spawn=(file,args,options)=>real(file,["+JSON.stringify(fixture)+"],options); syncBuiltinESMExports();\n");
  const env = { ...process.env, SMOKE_PORT:String(port), SMOKE_BOOT_TIMEOUT_MS:'1200', RELOGIN_LIVE:'0',
    WINDSURFAPI_SKIP_DOTENV:'1', DASHBOARD_PASSWORD:'fixture-only', ...extraEnv };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT; delete env.FORCE_COLOR;
  try {
    return await new Promise(resolve => {
      const child=spawn(process.execPath,['--import',pathToFileURL(hook).href,SCRIPT,process.execPath],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
      let output='',error=null,timedOut=false;const started=Date.now();
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
      child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',e=>error=e.code);
      child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,error,timedOut,output,ms:Date.now()-started});});
    });
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
function completed(r,status) {
  assert.equal(r.error,null,r.output);assert.equal(r.signal,null,r.output);assert.equal(r.timedOut,false,r.output);
  assert.equal(r.status,status,r.output);
}
it('a healthy owned child serves the required HTML/JSON assets and exits smoke cleanly', async()=>{
  const r=await exercise('healthy',await freePort());completed(r,0);assert.match(r.output,/boot-smoke OK/);
});
it('another listener cannot certify a binary that never serves the application', async()=>{
  const other=await ownedListener((q,s)=>{s.setHeader('content-type',q.url==='/dashboard'?'text/html':'application/json');
    s.end(q.url==='/dashboard'?HTML:JSON.stringify(q.url==='/health'?health(process.pid):{fixture:true}));});
  try {const r=await exercise('idle',other.port);completed(r,1);assert.match(r.output,/identity|pid/i);}
  finally {await other.close();}
});
it('even application-shaped health from the wrong PID is not this spawned process',async()=>{
  const r=await exercise('wrong-pid',await freePort());completed(r,1);assert.match(r.output,/identity|pid/i);
});
it('an owned process returning HTTP 200 with no dashboard HTML is rejected',async()=>{
  const r=await exercise('bad-html',await freePort());completed(r,1);assert.match(r.output,/dashboard/i);
});
it('a missing representative locale JSON is not complete asset smoke',async()=>{
  const r=await exercise('missing-locale',await freePort());completed(r,1);assert.match(r.output,/i18n|locale/i);
});
it('a child exiting zero before readiness is still failed smoke',async()=>{
  const r=await exercise('exit',await freePort());completed(r,1);assert.match(r.output,/exit|health/i);
});

it('a 200 whose status field is not ok is not a healthy application',async()=>{
  const r=await exercise('wrong-status',await freePort());completed(r,1);assert.match(r.output,/identity/i);
});
it('a 200 from another service answering on the port is not this application',async()=>{
  const r=await exercise('wrong-provider',await freePort());completed(r,1);assert.match(r.output,/identity/i);
});
it('a 200 reporting a different version is not the binary that was built',async()=>{
  const r=await exercise('wrong-version',await freePort());completed(r,1);assert.match(r.output,/identity/i);
});
it('all executable release jobs invoke the shared verifier before upload, without suppressing its exit',()=>{
  const yaml=fs.readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  for(const [job,binary] of [['windows-exe','dist-windows/windsurfapi.exe'],['macos-exe-arm64','dist-macos/windsurfapi-macos-arm64'],['macos-exe-x64','dist-macos/windsurfapi-macos-x64']]){
    const start=yaml.indexOf('\n  '+job+':\n');assert.ok(start>=0,job);
    const rest=yaml.slice(start+1);const end=rest.search(/\n  [A-Za-z0-9_-]+:\n/);const block=end<0?rest:rest.slice(0,end);
    const command='run: node scripts/exe-boot-smoke.mjs '+binary;
    const at=block.indexOf(command);assert.ok(at>=0,job+' must invoke the shared verifier');
    assert.ok(at<block.indexOf('uses: actions/upload-artifact'),job+' must verify before uploading');
    const stepStart=block.lastIndexOf('      - name:',at),stepEnd=block.indexOf('\n      - ',at);
    const step=block.slice(stepStart,stepEnd<0?block.length:stepEnd);
    assert.equal(step.split('\n').map(s=>s.trim()).find(s=>s.startsWith('run:')),command,'no shell command may mask the verifier exit');
    assert.doesNotMatch(step,/continue-on-error\s*:\s*true/,'the smoke step itself must propagate failure');
  }
});
