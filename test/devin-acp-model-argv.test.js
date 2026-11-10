import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  runDevinAcpProcess,
  __setDevinAcpSpawnForTest,
} from '../src/devin-acp.js';

// Pins the ACP model channel against a NOTE that used to deny it: the
// DEVIN_ONLY note in src/backend-router.js claimed the ACP path "only" passes
// the requested model as a prompt hint. That is false twice over — the model is
// pushed onto the CLI LAUNCH argv as `devin acp --model <key>`
// (src/devin-acp.js:530-531) AND a prompt-side hint is added
// (src/devin-acp.js:579-582). The launch-argv half is machine-checkable here.
//
// The repo proves what it SENDS, not what the `devin` CLI does with it: whether
// `--model` actually switches the CLI's underlying core is not determined by
// this repository and needs a live probe against a real account.
//
// test/mutations/acp-model-argv.json deletes the argv push permanently, so
// this pin cannot decay into a green test that asserts nothing.

// A minimal fake child that looks enough like a ChildProcess for makeAcpClient
// (same shape as test/devin-acp-stdin-epipe.test.js): stdout/stderr/stdin are
// EventEmitters, stdin is writable, kill() is a no-op. It never answers RPCs;
// the spawn seam lets us capture argv before the handshake stalls.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = () => true;
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function captureSpawn(capture) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    return makeFakeChild();
  };
}

// Drive one run through the spawn seam. The spawn happens synchronously inside
// runDevinAcpProcess (before its first await), so by the time the promise is
// back the argv is already captured; aborting then settles the never-answered
// initialize RPC so nothing hangs or leaks.
async function runAndCapture(modelKey) {
  const capture = {};
  __setDevinAcpSpawnForTest(captureSpawn(capture));
  const ac = new AbortController();
  const p = runDevinAcpProcess('hi', { modelKey, apiKey: 'k', signal: ac.signal });
  p.catch(() => {}); // the abort rejection is asserted below
  ac.abort();
  await assert.rejects(p);
  return capture;
}

afterEach(() => {
  __setDevinAcpSpawnForTest(null); // restore the real spawn
  delete process.env.DEVIN_CLI_ACP_ARGS_JSON;
});

describe('Devin ACP — the requested model reaches the CLI launch argv', () => {
  it('pushes --model <modelKey> onto the devin acp argv', async () => {
    delete process.env.DEVIN_CLI_ACP_ARGS_JSON; // pin the default parse, not ambient config
    const capture = await runAndCapture('claude-4.5-sonnet');
    assert.equal(capture.command, process.env.DEVIN_CLI_PATH || 'devin');
    assert.deepEqual(
      capture.args,
      ['acp', '--model', 'claude-4.5-sonnet'],
      'the model must reach the CLI launch argv, not only the session/prompt hint',
    );
  });

  it('does not duplicate --model when DEVIN_CLI_ACP_ARGS_JSON already supplies one', async () => {
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify(['acp', '--model', 'operator-pinned-model']);
    const capture = await runAndCapture('claude-4.5-sonnet');
    assert.deepEqual(
      capture.args,
      ['acp', '--model', 'operator-pinned-model'],
      'an operator-supplied --model must win, not be duplicated or overridden',
    );
  });
});
