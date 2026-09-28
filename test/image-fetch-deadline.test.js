// A5-DEADLINE: one absolute budget for the whole image fetch.
//
// fetchImageUrl handed the per-hop `timeout` to every redirect and treated it as a
// socket-inactivity guard, so a chain of 7 s hops took 28 s and a body ticking one
// byte every 7 s stayed alive indefinitely — bounded only by the 5 MB cap
// (evidence: .agent/audit-20260922/evidence/probes/a5-image-fetch-deadline/).
//
// The real helper runs here against a fake transport installed on the REAL builtin
// modules (the same seam test/wire-*.test.js use: patch the builtin's export, then
// syncBuiltinESMExports so the ESM bindings see it), with node's mock timers driving
// the absolute clock, so "7999 ms pending / 8000 ms rejected" is measured rather than
// wall-clock waited. src/image.js itself is loaded unchanged — no loader hooks, no
// flags, no dependency.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const transport = await import('./helpers/fake-image-transport.mjs');

const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
http.get = transport.get;
https.get = transport.get;
syncBuiltinESMExports();

const { fetchImageUrl } = await import('../src/image.js');

const URL_A = 'https://img.example.test/a.png';
const URL_B = 'https://img.example.test/b.png';
const URL_C = 'https://img.example.test/c.png';
const PNG = Buffer.from('PNGDATA');
const PNG_HEADERS = { 'content-type': 'image/png' };
const MAX_SIZE = 5 * 1024 * 1024;
const TIMEOUT = { timeout: 20000 };

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Records every settlement of `promise` so "settles exactly once" is observable.
function watch(promise) {
  const state = { settlements: 0, value: null, error: null };
  const settled = promise.then(
    (value) => { state.settlements++; state.value = value; return 'resolved'; },
    (error) => { state.settlements++; state.error = error; return 'rejected'; },
  );
  return { state, settled };
}

const useMockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

describe('A5-DEADLINE: image fetch root budget', () => {
  it('rejects once at the absolute 8000 ms budget and destroys the active hop', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));
    assert.equal(transport.hops.length, 1, 'the first hop must be issued without waiting for a timer');

    const hop = transport.hops[0];
    assert.equal(hop.url, URL_A);
    assert.equal(hop.options.timeout, 8000, 'the per-hop inactivity guard must stay');
    assert.equal(typeof hop.options.lookup, 'function', 'the SSRF lookup hook must be passed to the transport');

    t.mock.timers.tick(7999);
    await flush();
    assert.equal(state.settlements, 0, 'the fetch must still be pending before the absolute budget expires');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.settlements, 1, 'no absolute budget: the fetch was still pending at 8000 ms');
    assert.equal(await settled, 'rejected');
    assert.match(state.error.message, /deadline|timeout/i);
    assert.equal(hop.req.destroyCalls, 1, 'the pending request must be destroyed exactly once');
    assert.equal(hop.req.listenerCount('timeout'), 0, 'the helper must drop its own request listeners');

    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.settlements, 1, 'a settled fetch must not settle again');
  });

  it('does not renew the budget on a redirect hop', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));
    const first = transport.hops[0];

    t.mock.timers.tick(3999);
    const redirect = transport.respond(first, { status: 302, location: URL_B });
    await flush();
    assert.equal(transport.hops.length, 2, 'the redirect must be followed');
    const second = transport.hops[1];
    assert.equal(second.url, URL_B);
    assert.equal(second.options.timeout, 8000);
    assert.equal(second.options.lookup, first.options.lookup, 'every hop must keep the same SSRF lookup hook');
    assert.equal(redirect.destroyCalls, 1, 'the abandoned redirect body must be destroyed, not merely drained');

    t.mock.timers.tick(4000);
    await flush();
    assert.equal(state.settlements, 0, '3999 ms into the chain the fetch is still pending');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.settlements, 1, 'the second hop got a renewed budget instead of the root deadline');
    assert.equal(await settled, 'rejected');
    assert.match(state.error.message, /deadline|timeout/i);
    assert.equal(second.req.destroyCalls, 1);
  });

  it('resolves a redirect chain that finishes inside the budget (control)', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));

    t.mock.timers.tick(1000);
    transport.respond(transport.hops[0], { status: 302, location: URL_B });
    await flush();
    assert.equal(transport.hops.length, 2);

    const body = transport.respond(transport.hops[1], { status: 200, headers: PNG_HEADERS });
    body.chunk(PNG);
    body.end();
    assert.equal(await settled, 'resolved');
    assert.equal(state.value.base64_data, PNG.toString('base64'));
    assert.equal(state.value.mime_type, 'image/png');
    assert.equal(body.destroyCalls, 0, 'a completed response must not be destroyed');
    assert.equal(body.listenerCount('data'), 0, 'listeners must be released on success');
    assert.equal(body.listenerCount('end'), 0);
    assert.equal(transport.hops[0].req.listenerCount('error'), 0);

    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.settlements, 1, 'a settled fetch must stay settled');
    assert.equal(transport.hops.length, 2);
  });

  it('closes a trickling body at the absolute budget and ignores late bytes', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));
    const body = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });

    t.mock.timers.tick(7999);
    body.chunk(PNG);
    await flush();
    assert.equal(state.settlements, 0, 'a chunk arriving just before expiry must not extend the budget');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.settlements, 1, 'a body that keeps arriving below the inactivity window was never closed');
    assert.equal(await settled, 'rejected');
    assert.match(state.error.message, /deadline|timeout/i);
    assert.equal(body.destroyCalls, 1, 'the still-streaming body must be destroyed at expiry');

    body.chunk(PNG);
    body.end();
    body.fail(new Error('late transport error'));
    await flush();
    assert.equal(state.settlements, 1, 'late data/end/error must not settle the fetch again');
    assert.equal(transport.hops.length, 1, 'late bytes must not create another request');
  });

  it('ignores a response that arrives after the deadline', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));
    const first = transport.hops[0];

    t.mock.timers.tick(8000);
    await flush();
    assert.equal(state.settlements, 1, 'no absolute budget: the fetch was still pending at 8000 ms');
    assert.equal(await settled, 'rejected');
    assert.equal(first.req.destroyCalls, 1);

    const late = transport.respond(first, { status: 302, location: URL_C });
    await flush();
    assert.equal(transport.hops.length, 1, 'a late redirect must not start another request');
    assert.equal(late.destroyCalls, 1, 'the late response must be destroyed');
    assert.equal(state.settlements, 1);
  });

  it('keeps the per-hop inactivity guard', TIMEOUT, async () => {
    transport.reset();
    const { state, settled } = watch(fetchImageUrl(URL_A));
    const hop = transport.hops[0];
    hop.req.emit('timeout');
    await flush();
    assert.equal(state.settlements, 1, 'the inactivity guard must settle the fetch');
    assert.equal(await settled, 'rejected');
    assert.match(state.error.message, /Image fetch timeout/);
    assert.equal(hop.req.destroyCalls, 1);
    assert.equal(hop.req.listenerCount('timeout'), 0);
    assert.equal(hop.req.listenerCount('error'), 0);
  });

  it('keeps the response-side limits: byte cap, MIME allowlist, status and redirect count', TIMEOUT, async (t) => {
    useMockTimers(t);
    transport.reset();

    const capped = watch(fetchImageUrl(URL_A));
    const big = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    big.chunk(Buffer.alloc(MAX_SIZE, 0x41));
    big.chunk(Buffer.from([0x42]));
    await flush();
    assert.equal(capped.state.settlements, 1);
    assert.equal(await capped.settled, 'rejected');
    assert.match(capped.state.error.message, /Image exceeds 5242880 bytes/);
    assert.equal(big.destroyCalls, 1);
    assert.equal(big.listenerCount('data'), 0);

    const wrongType = watch(fetchImageUrl(URL_A));
    const html = transport.respond(transport.hops[1], { status: 200, headers: { 'content-type': 'text/html' } });
    await flush();
    assert.equal(await wrongType.settled, 'rejected');
    assert.match(wrongType.state.error.message, /Unsupported image type: text\/html/);
    assert.equal(html.destroyCalls, 1);

    const missing = watch(fetchImageUrl(URL_A));
    const notFound = transport.respond(transport.hops[2], { status: 404 });
    await flush();
    assert.equal(await missing.settled, 'rejected');
    assert.match(missing.state.error.message, /Image fetch HTTP 404/);
    assert.equal(notFound.destroyCalls, 1);

    const tooMany = watch(fetchImageUrl(URL_A));
    for (let i = 0; i < 4; i++) {
      transport.respond(transport.hops[3 + i], { status: 302, location: `${URL_C}?hop=${i}` });
      await flush();
    }
    assert.equal(await tooMany.settled, 'rejected');
    assert.match(tooMany.state.error.message, /Too many image redirects/);
    assert.equal(transport.hops.length, 3 + 4, 'the chain must stop at the redirect limit');

    const privateHop = watch(fetchImageUrl(URL_A));
    transport.respond(transport.hops[7], { status: 302, location: 'http://127.0.0.1/secret.png' });
    await flush();
    assert.equal(await privateHop.settled, 'rejected');
    assert.match(privateHop.state.error.message, /private\/internal address/);
    assert.equal(transport.hops.length, 8, 'a private redirect target must not be requested');
  });

  it('keeps the SSRF lookup hook live on the transport options', TIMEOUT, async () => {
    transport.reset();
    const { settled } = watch(fetchImageUrl(URL_A));
    const lookup = transport.hops[0].options.lookup;
    const error = await new Promise((resolve) => lookup('localhost', {}, resolve));
    assert.ok(error instanceof Error, 'a private resolution must still be rejected by the lookup hook');
    assert.match(error.message, /private address/);
    // Settle the pending fetch so no real timer outlives the test.
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    assert.equal(await settled, 'resolved');
  });
});
