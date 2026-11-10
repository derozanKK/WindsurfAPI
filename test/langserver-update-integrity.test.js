// A05 regression: a custom LS update must carry an expected SHA-256 and
// install-ls.sh must revalidate every redirect hop. The route may only
// install/restart after the digest matches.
//
// The red-first cases below fail on the pre-fix code:
//   - POST /langserver/update {url} (no sha256) used to spawn install-ls.sh
//     with only --url; the installer warned "not integrity-checked" and
//     installed the downloaded bytes.
//   - POST /langserver/update {url, sha256: <wrong>} ignored the hash and did
//     the same.
//   - install-ls.sh used `curl -L`, so a github.com URL could redirect to an
//     arbitrary host and still be installed.
//
// The fake curl is hermetic (no network). It writes a small known payload or
// a 302 to evil.example; the real bash + install-ls.sh path runs end to end.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { configureBindHost, _resetLockoutForTests } from '../src/auth.js';
import { handleDashboardApi, __setLangserverInstallScriptForTests } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'install-ls.sh');
const PAYLOAD = Buffer.from('#!/bin/sh\necho fake-language-server\n');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');
const TEMP_DIRS = [];

const original = {
  dashboardPassword: config.dashboardPassword,
  apiKey: config.apiKey,
  lsBinaryPath: config.lsBinaryPath,
  allowNoAuth: process.env.DASHBOARD_ALLOW_NO_AUTH,
  path: process.env.PATH,
  curl: process.env.WINDSURFAPI_LS_CURL,
  platform: process.env.WINDSURFAPI_LS_PLATFORM,
  payloadFile: process.env.FAKE_CURL_PAYLOAD_FILE,
  bashEnv: process.env.BASH_ENV,
  fakeCurlScript: process.env.FAKE_CURL_SCRIPT,
};

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.WINDSURFAPI_TEST_BASH,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

const BASH = findBash();

function posixPath(p) {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return p.replace(/\\/g, '/');
}

function restore(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeFakeCurl(dir) {
  const file = join(dir, 'fake-curl');
  const payloadFile = join(dir, 'payload.bin');
  const bashEnv = join(dir, 'bash-env.sh');
  writeFileSync(payloadFile, PAYLOAD);
  // Pre-fix install-ls.sh called bare `curl`, not $WINDSURFAPI_LS_CURL.
  // A BASH_ENV function override makes the pre-fix script use the same fake
  // (Git Bash otherwise prepends /mingw64/bin and wins the PATH lookup).
  writeFileSync(bashEnv, 'curl() { "$FAKE_CURL_SCRIPT" "$@"; }\n');
  writeFileSync(file, `#!/bin/sh
out=""
hdr=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) hdr="$2"; shift 2 ;;
    -w) shift 2 ;;
    --max-time|--max-filesize|--retry|--retry-delay|--max-redirs|--proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ "\${FAKE_CURL_REDIRECT:-0}" = "1" ] && [ -z "$hdr" ]; then
  # Old install-ls.sh used curl -L: emulate following the redirect.
  if [ -n "\${FAKE_CURL_LOG:-}" ]; then
    printf 'followed %s -> %s\\n' "$url" "\${FAKE_CURL_REDIRECT_TARGET:-https://evil.example/payload}" >> "$FAKE_CURL_LOG"
  fi
fi
if [ "\${FAKE_CURL_REDIRECT:-0}" = "1" ] && [ -n "$hdr" ]; then
  case "$url" in
    *objects.githubusercontent.com*) : ;;
    *)
      printf 'HTTP/1.1 302 Found\\r\\nLocation: %s\\r\\nContent-Length: 0\\r\\n\\r\\n' "\${FAKE_CURL_REDIRECT_TARGET:-https://evil.example/payload}" > "$hdr"
      [ -n "$out" ] && : > "$out"
      printf '302'
      exit 0
      ;;
  esac
fi
if [ -n "$out" ]; then
  cat "$FAKE_CURL_PAYLOAD_FILE" > "$out"
fi
printf '200'
exit 0
`, 'utf8');
  try { chmodSync(file, 0o755); } catch { /* Windows maps this to read-only */ }
  return { dir, file, payloadFile, bashEnv };
}

function runInstall(args, { target, fakeCurl, redirect = false }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('WINDSURFAPI_LS_')) delete env[key];
  }
  env.WINDSURFAPI_LS_PLATFORM = 'linux-x64';
  env.WINDSURFAPI_LS_CURL = posixPath(fakeCurl.file);
  env.FAKE_CURL_SCRIPT = posixPath(fakeCurl.file);
  env.FAKE_CURL_PAYLOAD_FILE = posixPath(fakeCurl.payloadFile);
  env.BASH_ENV = posixPath(fakeCurl.bashEnv);
  env.FAKE_CURL_REDIRECT = redirect ? '1' : '0';
  env.LS_INSTALL_PATH = posixPath(target);
  return spawnSync(BASH, [posixPath(SCRIPT), ...args], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
}

function mkRes() {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(payload) {
      try { captured.body = JSON.parse(payload); } catch { captured.body = payload; }
    },
    setHeader(k, v) { captured.headers[k] = v; },
    on() {},
    write() {},
  };
  return { res, captured };
}

function updateReq() {
  return {
    method: 'POST',
    url: '/dashboard/api/langserver/update',
    headers: {
      host: '127.0.0.1:3003',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3003',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function postUpdate(body) {
  const { res, captured } = mkRes();
  await handleDashboardApi('POST', '/langserver/update', body, updateReq(), res);
  return captured;
}

let fakeCurl;
let target;

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = '';
  config.apiKey = '';
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  process.env.WINDSURFAPI_LS_PLATFORM = 'linux-x64';
  configureBindHost('127.0.0.1');
  if (process.platform === 'win32') {
    // Make Node's spawn('bash', ...) resolve Git Bash, not the WSL launcher.
    process.env.PATH = `C:/Program Files/Git/bin;${process.env.PATH}`;
  }
  const dir = makeTempDir('ls-integrity-');
  fakeCurl = makeFakeCurl(dir);
  target = join(dir, 'install', 'language_server_linux_x64');
  config.lsBinaryPath = target;
  process.env.WINDSURFAPI_LS_CURL = posixPath(fakeCurl.file);
  process.env.FAKE_CURL_SCRIPT = posixPath(fakeCurl.file);
  process.env.FAKE_CURL_PAYLOAD_FILE = posixPath(fakeCurl.payloadFile);
  process.env.BASH_ENV = posixPath(fakeCurl.bashEnv);
});

afterEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = original.dashboardPassword;
  config.apiKey = original.apiKey;
  config.lsBinaryPath = original.lsBinaryPath;
  restore('DASHBOARD_ALLOW_NO_AUTH', original.allowNoAuth);
  restore('PATH', original.path);
  restore('WINDSURFAPI_LS_CURL', original.curl);
  restore('WINDSURFAPI_LS_PLATFORM', original.platform);
  restore('FAKE_CURL_PAYLOAD_FILE', original.payloadFile);
  restore('BASH_ENV', original.bashEnv);
  restore('FAKE_CURL_SCRIPT', original.fakeCurlScript);
  __setLangserverInstallScriptForTests(null);
  configureBindHost('0.0.0.0');
});

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('A05: custom LS update requires an expected SHA-256', () => {
  test('install-ls.sh refuses --url without --sha256 before download/install', () => {
    const res = runInstall(['--url', 'https://github.com/owner/repo/releases/download/v1/ls'], {
      target,
      fakeCurl,
    });
    assert.notEqual(res.status, 0, 'missing hash must fail closed');
    assert.equal(existsSync(target), false, 'target must not be installed without a hash');
  });

  test('POST /langserver/update rejects a custom URL without sha256 before spawning', async () => {
    const captured = await postUpdate({ url: 'https://github.com/owner/repo/releases/download/v1/ls' });
    assert.equal(captured.status, 400, JSON.stringify(captured.body));
    assert.equal(captured.body.error, 'ERR_LS_SHA256_REQUIRED');
    assert.equal(existsSync(target), false, 'target must not be installed without a hash');
  });

  test('POST /langserver/update rejects a mismatched sha256 before install', async () => {
    const captured = await postUpdate({
      url: 'https://github.com/owner/repo/releases/download/v1/ls',
      sha256: '0'.repeat(64),
    });
    assert.equal(captured.body.ok, false, JSON.stringify(captured.body));
    assert.equal(existsSync(target), false, 'target must not be installed on a hash mismatch');
  });

  test('a matching sha256 installs and reports success', async () => {
    const captured = await postUpdate({
      url: 'https://github.com/owner/repo/releases/download/v1/ls',
      sha256: PAYLOAD_SHA,
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(captured.body.ok, true, JSON.stringify(captured.body));
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target).toString('utf8'), PAYLOAD.toString('utf8'));
  });

  test('the route refuses to publish bytes from a fake installer that exits 0', async () => {
    const dir = makeTempDir('fake-installer-');
    const script = join(dir, 'fake-install.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "#!/bin/sh\\necho wrong-binary\\n" > "${LS_INSTALL_STAGE_PATH:-$LS_INSTALL_PATH}"\nexit 0\n');
    try { chmodSync(script, 0o755); } catch { /* Windows maps this to read-only */ }
    __setLangserverInstallScriptForTests(script.replace(/\\/g, '/'));
    try {
      const captured = await postUpdate({
        url: 'https://github.com/owner/repo/releases/download/v1/ls',
        sha256: PAYLOAD_SHA,
      });
      assert.equal(captured.status, 409, JSON.stringify(captured.body));
      assert.equal(captured.body.error, 'ERR_LS_INTEGRITY_FAILED');
      assert.equal(existsSync(target), false, 'the route must not publish unverified bytes');
    } finally {
      __setLangserverInstallScriptForTests(null);
    }
  });
});

describe('A05: every redirect hop is revalidated', () => {
  test('install-ls.sh refuses a redirect from github.com to evil.example before install', () => {
    const log = join(fakeCurl.dir, 'followed-redirect.log');
    process.env.FAKE_CURL_LOG = log;
    try {
      const res = runInstall([
        '--url', 'https://github.com/owner/repo/releases/download/v1/ls',
        '--sha256', PAYLOAD_SHA,
      ], { target, fakeCurl, redirect: true });
      assert.notEqual(res.status, 0, 'redirect to a different host must fail');
      assert.equal(existsSync(target), false, 'target must not be installed after a hostile redirect');
      assert.equal(existsSync(log), false, 'the installer must not follow the redirect at all');
    } finally {
      delete process.env.FAKE_CURL_LOG;
    }
  });

  test('allows a redirect to an allowlisted GitHub CDN host', async () => {
    process.env.FAKE_CURL_REDIRECT = '1';
    process.env.FAKE_CURL_REDIRECT_TARGET = 'https://objects.githubusercontent.com/payload';
    try {
      const captured = await postUpdate({
        url: 'https://github.com/owner/repo/releases/download/v1/ls',
        sha256: PAYLOAD_SHA,
      });
      assert.equal(captured.status, 200, JSON.stringify(captured.body));
      assert.equal(captured.body.ok, true, JSON.stringify(captured.body));
      assert.equal(existsSync(target), true);
    } finally {
      delete process.env.FAKE_CURL_REDIRECT;
      delete process.env.FAKE_CURL_REDIRECT_TARGET;
    }
  });

  test('POST /langserver/update refuses the same hostile redirect before install/restart', async () => {
    process.env.FAKE_CURL_REDIRECT = '1';
    try {
      const captured = await postUpdate({
        url: 'https://github.com/owner/repo/releases/download/v1/ls',
        sha256: PAYLOAD_SHA,
      });
      assert.equal(captured.body.ok, false, JSON.stringify(captured.body));
      assert.equal(existsSync(target), false, 'target must not be installed after a hostile redirect');
    } finally {
      delete process.env.FAKE_CURL_REDIRECT;
    }
  });
});
