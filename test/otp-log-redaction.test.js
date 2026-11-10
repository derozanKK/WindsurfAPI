/**
 * SEC-FIX-2 / SD-1 (selfaudit-20261015/SECURITY-DEEP/FINDINGS.md):
 * `src/dashboard/email-otp-login.js` used to append `otpCode.slice(-2)` after
 * the `***` marker on two log lines (RegisterUser / OTP found), shrinking the
 * brute-force space of a single-use 6-digit code from 10^6 to 10^4 and
 * contradicting the module's own log-safety discipline — the email on the very
 * same line is hashed via safeEmailRef.
 *
 * These tests drive both previously-leaking lines for real and assert that no
 * captured log line contains the full OTP or any >=2-digit fragment of it.
 * Hex hash fields (`emailHash=`/`apiKeyHash=`) and `timeout=<n>ms` are
 * normalized out first — those legitimately contain digit pairs.
 */

import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import {
  registerUserWithOtp,
  pollGmailForOtp,
  windsurfLoginViaEmailOtp,
  __setOtpTransportForTests,
} from '../src/dashboard/email-otp-login.js';

const OTP = '123456';
const MODULE_LOG_PREFIX = /^\[(?:DEBUG|INFO|WARN|ERROR)\]/;

// config.js `log` is a thin console wrapper, so capturing console captures the
// module's log lines. Returns every captured line; callers filter.
async function withCapturedConsole(fn) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return lines;
}

// Legitimate digit carriers on these log lines: hex hashes and the poll timeout.
function normalizeForScan(line) {
  return line
    .replace(/Hash=[0-9a-f]+/g, 'Hash=[H]')
    .replace(/timeout=\d+ms/g, 'timeout=[T]ms');
}

function assertNoOtpFragments(captured, otp) {
  const moduleLines = captured.filter(line => MODULE_LOG_PREFIX.test(line));
  assert.ok(
    moduleLines.length > 0,
    `expected the module to emit log lines, captured: ${JSON.stringify(captured)}`,
  );
  for (const line of moduleLines) {
    const normalized = normalizeForScan(line);
    assert.ok(!normalized.includes(otp), `full OTP leaked into log line: ${line}`);
    for (let len = 2; len <= otp.length; len++) {
      for (let start = 0; start + len <= otp.length; start++) {
        const fragment = otp.slice(start, start + len);
        assert.ok(
          !normalized.includes(fragment),
          `OTP fragment "${fragment}" leaked into log line: ${line}`,
        );
      }
    }
  }
  return moduleLines;
}

const fakeOkTransport = () => Promise.resolve({
  status: 200,
  data: {
    api_key: 'sk-fixture-key-not-a-real-credential',
    name: 'Fixture User',
    api_server_url: 'https://example.test',
  },
});

// Drives pollGmailForOtp against a fake IMAP dialogue (patches node:tls.connect —
// the module's readOtpFromImapOnce has no injection seam). `searchResponse` is
// the server line answered to the SEARCH command, e.g. '* SEARCH 41 42'.
async function runFakeImapPoll(searchResponse, timeoutMs = 1500) {
  const originalConnect = tls.connect;
  tls.connect = (options, onConnect) => {
    const socket = new EventEmitter();
    const reply = (cmd) => {
      if (/^A\d+ LOGIN/.test(cmd)) socket.emit('data', 'A1 OK LOGIN completed\r\n');
      else if (/^A\d+ SELECT/.test(cmd)) socket.emit('data', 'A2 OK SELECT completed\r\n');
      else if (/^A\d+ SEARCH/.test(cmd)) socket.emit('data', `${searchResponse}\r\n`);
      else if (/^A\d+ FETCH/.test(cmd)) {
        socket.emit('data', `* 42 FETCH (BODY[TEXT] "Windsurf verification code: ${OTP}")\r\n`);
      }
    };
    socket.write = (cmd) => { setImmediate(() => reply(String(cmd))); return true; };
    socket.destroy = () => {};
    socket.setTimeout = () => socket;
    setImmediate(() => {
      onConnect?.();
      socket.emit('data', '* OK [CAPABILITY IMAP4rev1] ready\r\n');
    });
    return socket;
  };

  let found;
  let error = null;
  let captured;
  try {
    captured = await withCapturedConsole(async () => {
      try {
        found = await pollGmailForOtp('fixture@gmail.test', 'fixture-app-password', timeoutMs);
      } catch (err) {
        error = err;
      }
    });
  } finally {
    tls.connect = originalConnect;
  }
  return { found, error, captured };
}

afterEach(() => {
  __setOtpTransportForTests(null);
});

describe('OTP log redaction (SEC-FIX-2 / SD-1)', () => {
  it('registerUserWithOtp does not log any fragment of the submitted OTP', async () => {
    __setOtpTransportForTests(fakeOkTransport);

    const captured = await withCapturedConsole(() =>
      registerUserWithOtp('operator@example.test', OTP, 'turnstile-fixture', 'Fixture', 'User'));

    const moduleLines = assertNoOtpFragments(captured, OTP);
    assert.ok(
      moduleLines.some(line => line.includes('RegisterUser (OTP)')),
      `expected the RegisterUser log line, got: ${JSON.stringify(moduleLines)}`,
    );
  });

  it('pollGmailForOtp does not log any fragment of the code it found', async () => {
    // Two ids: this case works on the old and new SEARCH parser alike, so it
    // isolates the log-redaction contract from the parser fix below.
    const { found, error, captured } = await runFakeImapPoll('* SEARCH 41 42');

    assert.equal(error, null, `fake IMAP dialogue should deliver the code: ${error?.message}`);
    assert.equal(found, OTP, 'fake IMAP dialogue should deliver the code (guards against a vacuous pass)');
    const moduleLines = assertNoOtpFragments(captured, OTP);
    assert.ok(
      moduleLines.some(line => line.includes('OTP code found')),
      `expected the "OTP code found" log line, got: ${JSON.stringify(moduleLines)}`,
    );
  });

  it('pollGmailForOtp fetches the code when SEARCH returns exactly one message id', async () => {
    // Regression (SEC-FIX-2 follow-up): the SEARCH parser used to run
    // `match(/\d+/g).slice(1)` "to skip the SEARCH token" — but the token has no
    // digits, so a single-result inbox ('* SEARCH 42' -> []) read as "no mail"
    // and the poller timed out with the code sitting unread.
    const { found, error, captured } = await runFakeImapPoll('* SEARCH 42');

    assert.equal(error, null, `poll must not fail for a single-message inbox: ${error?.message}`);
    assert.equal(found, OTP, 'the single SEARCH result must be fetched, not treated as "no mail"');
    const moduleLines = assertNoOtpFragments(captured, OTP);
    assert.ok(
      moduleLines.some(line => line.includes('OTP code found')),
      `expected the "OTP code found" log line, got: ${JSON.stringify(moduleLines)}`,
    );
  });

  it('the full email-OTP orchestrator emits no OTP fragment anywhere', async () => {
    __setOtpTransportForTests(fakeOkTransport);

    const captured = await withCapturedConsole(() =>
      windsurfLoginViaEmailOtp('operator@example.test', 'Fixture', 'turnstile-fixture', '', null, {
        readOtp: async () => OTP,
        env: { GMAIL_IMAP_USER: 'fixture@gmail.test', GMAIL_IMAP_PASSWORD: 'fixture-app-password' },
      }));

    assertNoOtpFragments(captured, OTP);
  });

  it('no module log statement slices a value into the message (static guard)', () => {
    const source = readFileSync(new URL('../src/dashboard/email-otp-login.js', import.meta.url), 'utf8');
    const offenders = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!/\blog\.(?:info|warn|error|debug)\b/.test(line)) continue;
      if (/\$\{[^}]*\.slice\(-\d/.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
    }
    assert.deepEqual(offenders, []);
  });
});
