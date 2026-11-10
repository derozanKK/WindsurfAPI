/**
 * Smoke-matrix family: detach.
 *
 * WINDSURFAPI_CASCADE_DETACH (3.9.60, 2854fab) freezes a Cascade turn into
 * src/detached-registry.js when the CLIENT hangs up mid-stream, so a
 * byte-identical retry claims the frozen snapshot and continues the original
 * poll loop instead of paying for a second upstream turn. It is a behaviour
 * change (network, memory, billing) and ships OFF, behind its own switch.
 *
 * What this family can and cannot reach over HTTP, and why:
 *
 *   - The switch is read per request (`cascadeDetachEnabled()`), so the flows
 *     below flip it at runtime, exactly like the operator's env.
 *   - Detach is admitted only for a CASCADE turn (`detachEnabled = key && useCascade
 *     && !nativeBridge`). The smoke server runs the DEVIN_CONNECT transport, and
 *     a cascade turn needs a resident language server, which this suite does not
 *     ship (no LS binary, no pool entry, and `ensureLs` has no injection seam on
 *     the HTTP route). So the two HTTP flows pin the contract that IS reachable
 *     over HTTP — flag OFF parity, and flag ON staying inert off the cascade
 *     transport — and the resume half drives the SAME process-wide registry the
 *     handler imports (admit → lookup → claim → serve), which is where the
 *     prefix replay and the single-writer rule actually live.
 *
 * Every flow asserts the observable, not the intent: upstream turns counted at
 * the scripted stream seam, and registry state transitions.
 */

const HEX64 = /^[0-9a-f]{64}$/;

export function registerDetachFlows(ctx) {
  const { http, requireThat, addFlow, deps, SMOKE, MATRIX, base } = ctx;

  /**
   * Send a streamed chat, read until `needle` is on the wire, then hang up —
   * the client-gone the detach path exists for. `http()` cannot do this: it
   * waits for the body to end.
   */
  async function abortAfterText(body, needle) {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SMOKE.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    let text = '';
    let sawNeedle = false;
    try {
      while (!sawNeedle) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
        sawNeedle = text.includes(needle);
      }
    } finally {
      controller.abort();
      try { await reader.cancel(); } catch { /* the socket is already gone */ }
    }
    return { status: res.status, contentType: res.headers.get('content-type') || '', text, sawNeedle };
  }

  /** Upstream turns the scripted connect stream served for one marker. */
  function turnsFor(marker) {
    return deps.connectStream.seen.filter((entry) => String(entry.text || '').includes(marker)).length;
  }

  async function retryPair(marker) {
    const body = {
      model: MATRIX.models.chat,
      // A body `user` makes the caller scope trusted (`:user:`), which is the
      // tenancy gate a detach key requires. Without it the flag could never
      // engage and this parity check would pass for the wrong reason.
      user: `detach-smoke-${marker}`,
      stream: true,
      messages: [{ role: 'user', content: `${marker} ${MATRIX.marker.slow}` }],
    };
    const first = await abortAfterText(body, MATRIX.slow.prefix);
    requireThat(first.status === 200, `first status ${first.status}`);
    requireThat(first.sawNeedle, 'the prefix never reached the client; the abort was not mid-stream');
    requireThat(!first.text.includes(MATRIX.slow.growth), 'the first stream finished before the client hung up');
    requireThat(turnsFor(marker) === 1, `the aborted turn issued ${turnsFor(marker)} upstream requests`);

    // Byte-identical retry (same body, same caller scope).
    const second = await http('POST', '/v1/chat/completions', { auth: 'api', body });
    requireThat(second.status === 200, `retry status ${second.status} error ${JSON.stringify(second.json?.error)}`);
    requireThat(second.text.includes(MATRIX.slow.prefix) && second.text.includes(MATRIX.slow.growth),
      'the retry did not serve the whole answer');
    requireThat(second.text.split(MATRIX.slow.prefix).length - 1 === 1, 'the prefix was replayed more than once');
    requireThat(second.text.trimEnd().endsWith('data: [DONE]'), 'the retry did not finish the stream');
    return { first, second, turns: turnsFor(marker) };
  }

  addFlow('detach', 'detach.flag-off-parity', async () => {
    // The response cache would serve the retry without touching upstream and
    // make "no resume happened" indistinguishable from "a cache hit".
    const savedCache = process.env.RESPONSE_CACHE_ENABLED;
    process.env.RESPONSE_CACHE_ENABLED = '0';
    const detach = await import('../../src/detached-registry.js');
    try {
      requireThat(detach.cascadeDetachEnabled() === false, 'detach is armed without WINDSURFAPI_CASCADE_DETACH=1');
      const marker = `DETACH_OFF_${Date.now()}`;
      const { turns } = await retryPair(marker);
      requireThat(turns === 2, `upstream saw ${turns} turns for an identical retry; the flag-off path must pay twice`);
      const stats = detach.detachedRegistry.stats();
      requireThat(stats.entries === 0, `flag-off admitted ${stats.entries} detached entries`);
      requireThat(stats.admit === 0 && stats.serve === 0, `flag-off counters moved: admit ${stats.admit} serve ${stats.serve}`);
      return 'client-gone + identical retry → 2 upstream turns, 0 entries (parity)';
    } finally {
      if (savedCache === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
      else process.env.RESPONSE_CACHE_ENABLED = savedCache;
    }
  });

  addFlow('detach', 'detach.flag-on-resume-path', async () => {
    const savedCache = process.env.RESPONSE_CACHE_ENABLED;
    const savedTurn = process.env.WINDSURFAPI_CASCADE_TURN;
    const savedDetach = process.env.WINDSURFAPI_CASCADE_DETACH;
    process.env.RESPONSE_CACHE_ENABLED = '0';
    // Detach requires the producer flag: it has no snapshot without it.
    process.env.WINDSURFAPI_CASCADE_TURN = '1';
    process.env.WINDSURFAPI_CASCADE_DETACH = '1';
    const detach = await import('../../src/detached-registry.js');
    const registry = detach.detachedRegistry;
    try {
      requireThat(detach.cascadeDetachEnabled() === true, 'the switch did not arm with both flags set');

      // The key is the tenancy gate: an untrusted scope must never mint one.
      const keyBody = { model: MATRIX.models.chat, messages: [{ role: 'user', content: 'detach key probe' }] };
      requireThat(detach.detachedKey(keyBody, 'session:smoke', { scopeTrusted: false }) === null,
        'an untrusted scope minted a detach key');
      const key = detach.detachedKey(keyBody, 'session:smoke', { scopeTrusted: true, modelKey: 'm' });
      requireThat(HEX64.test(String(key)), `detach key ${key}`);

      // Off the cascade transport the switch stays inert: the connect turn is
      // not resumable, so the retry still reaches upstream.
      const marker = `DETACH_ON_${Date.now()}`;
      const { turns } = await retryPair(marker);
      requireThat(turns === 2, `connect transport resumed ${turns} turns with the flag on; detach is cascade-only`);

      // The resume half: the process-wide registry the handler calls.
      const snapshot = {
        version: 2,
        chunks: [{ text: MATRIX.slow.prefix }, { text: MATRIX.slow.growth }],
        stepOffset: 7,
        consumedThrough: 7,
      };
      const pin = { cascadeId: 'smoke-cascade', accountId: 'smoke-account', generatorOffset: 7, deadline: Date.now() + 5000 };
      const admitted = registry.admit({ key, callerKey: 'session:smoke', snapshot, pin, cause: 'client_gone' });
      requireThat(typeof admitted.token === 'string' && admitted.token, `admit refused: ${admitted.refused}`);
      requireThat(registry.stats().entries === 1, `registry holds ${registry.stats().entries} entries`);

      // A different caller scope never sees the frozen output.
      requireThat(registry.lookup(key, 'session:other') === null, 'a foreign scope read the detached entry');
      const found = registry.lookup(key, 'session:smoke');
      requireThat(found?.snapshot?.stepOffset === 7, `lookup snapshot offset ${found?.snapshot?.stepOffset}`);

      const claimed = registry.claim(key, 'session:smoke');
      requireThat(typeof claimed.token === 'string', `claim refused: ${claimed.refused}`);
      requireThat(claimed.entry.state === 'claimed', `claimed entry state ${claimed.entry.state}`);
      requireThat(registry.claim(key, 'session:smoke').refused === 'busy', 'a second resumer claimed the same entry');

      // The replay is the frozen prefix, exactly once.
      const replay = claimed.entry.snapshot.chunks.map((chunk) => chunk.text).join('');
      requireThat(replay === `${MATRIX.slow.prefix}${MATRIX.slow.growth}`, `replay ${replay}`);
      requireThat(registry.release(key, claimed.token, { state: 'served' }) === true, 'release(served) refused');
      requireThat(registry.stats().entries === 0, 'a served entry was not deleted');
      requireThat(registry.stats().serve === 1, `serve counter ${registry.stats().serve}`);
      requireThat(registry.lookup(key, 'session:smoke') === null, 'a served entry is still readable');
      return 'switch armed; connect turn inert; admit→claim→serve replayed the prefix once';
    } finally {
      try { registry.reset(); } catch { /* best-effort */ }
      if (savedCache === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
      else process.env.RESPONSE_CACHE_ENABLED = savedCache;
      if (savedTurn === undefined) delete process.env.WINDSURFAPI_CASCADE_TURN;
      else process.env.WINDSURFAPI_CASCADE_TURN = savedTurn;
      if (savedDetach === undefined) delete process.env.WINDSURFAPI_CASCADE_DETACH;
      else process.env.WINDSURFAPI_CASCADE_DETACH = savedDetach;
    }
  });

  addFlow('detach', 'detach.refusals-never-admit', async () => {
    // A refusal is not an error — the producer just continues its abort path —
    // so the negative cases must be silent no-ops, not half-written entries.
    const detach = await import('../../src/detached-registry.js');
    const registry = new detach.DetachedRegistry({ timers: false });
    const snapshot = {
      version: 2,
      chunks: [{ text: MATRIX.slow.prefix }],
      stepOffset: 3,
      consumedThrough: 3,
    };
    const pin = { deadline: Date.now() + 5000 };
    const base = { key: 'k', callerKey: 'session:refusal', snapshot, pin, cause: 'client_gone' };

    requireThat(registry.admit({ ...base, cause: 'shutdown' }).refused === 'not_client_gone', 'a shutdown admitted an entry');
    requireThat(registry.admit({ ...base, callerKey: '' }).refused === 'no_scope', 'a scoped-out admit was accepted');
    requireThat(registry.admit({ ...base, snapshot: { version: 1, chunks: [], stepOffset: 0, consumedThrough: 0 } }).refused === 'bad_snapshot',
      'a v1 snapshot was admitted');
    requireThat(registry.admit({ ...base, snapshot: { ...snapshot, consumedThrough: 9 } }).refused === 'bad_snapshot',
      'a cursor/stepOffset mismatch was admitted');
    requireThat(registry.admit({ ...base, pin: { deadline: 1 } }).refused === 'no_deadline', 'an expired deadline was admitted');
    requireThat(registry.stats().entries === 0, `refusals left ${registry.stats().entries} entries`);

    requireThat(typeof registry.admit(base).token === 'string', 'the positive control was refused');
    registry.beginDrain();
    requireThat(registry.stats().entries === 0, 'a drain kept the entry');
    requireThat(registry.admit({ ...base, key: 'k2' }).refused === 'draining', 'a draining registry admitted a new turn');
    return 'shutdown/scope/snapshot/deadline refusals leave the registry empty; drain drops entries';
  });
}
