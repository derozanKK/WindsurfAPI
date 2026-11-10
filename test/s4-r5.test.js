import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function load() {
  const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const head = /(?:async )?function acquireConnectFailover\(triedKeys, signal, callerKey, selector = null(?:, budget = null)?\) \{/;
  const start = source.search(head), end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  let now = 0, serial = 0, calls = 0;
  const timers = new Map(), keys = [];
  const api = new Function('getApiKey', 'setTimeout', 'clearTimeout', `${source.slice(start, end)}\nreturn acquireConnectFailover;`)(
    (...args) => { calls++; keys.push(args); return { id: 'next' }; },
    (fn, ms) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id; },
    id => timers.delete(id));
  return { acquire: api, timers, keys, calls: () => calls,
    async tick(ms) {
      now += ms;
      for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn(); }
      for (let i = 0; i < 6; i++) await Promise.resolve();
    } };
}

test('R5 a failover waits 500ms before reserving the next account', async () => {
  const s = load(), ctrl = new AbortController();
  const p = s.acquire(['used'], ctrl.signal, 'owner', 'selector');
  assert.equal(s.calls(), 0, 'the failed request cannot immediately fan out');
  await s.tick(499); assert.equal(s.calls(), 0);
  await s.tick(1); assert.deepEqual(await p, { id: 'next' });
  assert.deepEqual(s.keys, [[['used'], null, 'owner', 'selector']]);
  assert.equal(s.timers.size, 0);
});

test('R5 disconnect during backoff cancels the timer and acquires no account', async () => {
  const s = load(), ctrl = new AbortController();
  const p = s.acquire([], ctrl.signal, 'owner');
  ctrl.abort();
  assert.equal(await p, null); assert.equal(s.calls(), 0); assert.equal(s.timers.size, 0);
});

test('R5 an already-aborted request creates neither a timer nor a reservation', async () => {
  const s = load(), ctrl = new AbortController(); ctrl.abort();
  assert.equal(await s.acquire([], ctrl.signal, 'owner'), null);
  assert.equal(s.calls(), 0); assert.equal(s.timers.size, 0);
});

test('R5 both existing streaming failover arms still await the same choke point', () => {
  const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const start = source.indexOf("              if (r.kind === 'error') {", source.indexOf('const attemptStream'));
  // On a complete checkout the unique end marker belongs to the same handler.
  const fallbackStart = start >= 0 ? start : source.indexOf("              if (r.kind === 'error') {");
  const end = source.indexOf('            if (leakTraceEnabled()) {', fallbackStart);
  const loop = source.slice(fallbackStart, end);
  assert.equal((loop.match(/await acquireConnectFailover\(triedKeys, abortController\.signal, callerKey, selector(?:, context\.budget \|\| null)?\)/g) || []).length, 2);
  assert.match(loop, /isAccountFailoverError\(r.err.code\) && !emitted && hops < maxHops/);
  assert.match(loop, /hops >= maxHops \|\| emitted/);
});
