import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.WINDSURFAPI_SKIP_DOTENV = '1';

const keepDataDir = process.env.WINDSURFAPI_TEST_KEEP_DATA_DIR === '1';
const requestedDataDir = process.env.WINDSURFAPI_TEST_DATA_DIR;
const dataDir = requestedDataDir || mkdtempSync(join(tmpdir(), 'windsurfapi-test-'));

process.env.DATA_DIR = dataDir;

if (!requestedDataDir && !keepDataDir) {
  process.once('exit', () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });
}

// D-TEST-EGRESS: ordinary local tests must not reach upstream. Adding a synthetic
// account (addAccountByKey) starts a catalog sync that dials server.codeium.com,
// so an unguarded run emitted real upstream 401s
// (.agent/audit-20260922/evidence/repairs/state-dirty/gate-01.log:418). Install
// the same fail-closed transport guard the mutation harness preloads — here,
// after the dotenv/data-directory isolation above and before the first test
// module is evaluated, which is what `--import` guarantees.
//
// Deliberately NOT imported from setup: any product module. auth/config/
// credential-store/logger read env at import time, so importing them here would
// freeze the values individual fixtures are about to set.
//
// The one escape hatch is the existing opt-in live suite. Its arming predicate is
// computed from the environment alone — the same four fields
// test/devin-connect-relogin-live.test.js:32-37 and
// src/devin-connect-credentials.js:62-68 require. DEVIN_CONNECT_AUTO_RELOGIN is
// set later in that suite's beforeEach, so it cannot arm anything here.
const liveArmed = process.env.RELOGIN_LIVE === '1'
  && Boolean(process.env.RELOGIN_LIVE_EMAIL)
  && Boolean(process.env.RELOGIN_LIVE_PASSWORD)
  && Boolean(String(process.env.DEVIN_CONNECT_CRED_KEY || '').trim());

// Awaited, so the guard is in place before the test graph runs. Importing the
// same file URL twice is a no-op, so an explicit
// `--import scripts/mutation-network-deny.mjs` preload stays authoritative: it is
// never double-wrapped and never undone.
if (!liveArmed) {
  await import('../scripts/mutation-network-deny.mjs');
}
