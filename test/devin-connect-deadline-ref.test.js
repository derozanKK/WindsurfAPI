// WHY A CHILD PROCESS. The absolute-deadline timer in streamChat is unref'd by
// default and only enters the loop's ref set while a consumer is blocked in the
// wait (src/devin-connect.js, "consumer wait"). If that ref window is lost, a hung
// upstream can never be ended by the deadline — but the damage is version-gated:
// on Node 20/22 the runtime cancels the pending await ("Promise resolution is
// still pending but the event loop has already resolved") and the in-process test
// at devin-connect.test.js:1147 goes red, while on Node 24 the test runner's own
// handles keep the loop alive and the same defect is invisible. Node 24 is the
// release gate, so the in-process test alone cannot guard this fix.
//
// A standalone process has exactly two things that could keep it alive: the fake
// request (which never responds) and the deadline timer. If the timer is not ref'd
// while the consumer waits, the process exits with an unsettled top-level await
// and status 13 on EVERY version; with the ref window it settles with
// DEADLINE_EXCEEDED and exits 0. That makes this the version-independent guard.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const devinConnect = pathToFileURL(join(root, 'src', 'devin-connect.js')).href;

const script = `
import { EventEmitter } from 'node:events';
const { streamChat, __setRequestImpl } = await import(${JSON.stringify(devinConnect)});
const res = new EventEmitter();
res.statusCode = 200;
// Hung-but-silent upstream: connects, never sends a frame, never errors.
__setRequestImpl((_opts, cb) => {
  const req = new EventEmitter();
  req.destroyed = false;
  req.setTimeout = () => req;      // the idle timer never fires
  req.write = () => {};
  req.destroy = () => { req.destroyed = true; };
  req.end = () => { setTimeout(() => cb(res), 1); };
  return req;
});
try {
  for await (const _event of streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'swe-1-6-slow',
    token: 'devin-session-token$fake.jwt.sig',
    timeoutMs: 60000,
    deadlineMs: 50,
  })) { /* drain */ }
  console.log('SETTLED:no-error');
} catch (err) {
  console.log('SETTLED:' + err.code);
}
`;

test('a standalone consumer of a hung stream is ended by the absolute deadline, not by loop drain', () => {
  const out = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(
    out.status, 0,
    `child exited ${out.status} (a non-zero status here means the pending await was abandoned by the `
    + `event loop, i.e. the deadline timer was not ref'd while the consumer waited)\n`
    + `stdout: ${out.stdout}\nstderr: ${out.stderr}`,
  );
  assert.match(out.stdout, /SETTLED:DEADLINE_EXCEEDED/, `child did not settle on the deadline: ${out.stdout}`);
});
