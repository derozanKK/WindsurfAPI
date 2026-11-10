/**
 * The ONE abort-aware bounded writer for SSE egress.
 *
 * `res.write()` returning false is an ordinary slow-reader signal: Node has
 * ACCEPTED the frame, the socket buffer is full, and the producer must not hand
 * it more until `'drain'`. Discarding that verdict — which every non-Cascade
 * exit used to do — buys the producer unbounded work with no backpressure at
 * all (KH-001). Every writer in this proxy now goes through this module so the
 * contract cannot drift between routes again:
 *
 *   * at most ONE outstanding drain wait per stream — there is no payload queue;
 *   * the false-returning frame was already accepted: it is NEVER resent;
 *   * the wait is raced against response close/error and the caller's abort
 *     signal, settles exactly once, and detaches its own listeners;
 *   * closed/aborted is re-checked before every write and after every wait, so a
 *     client that vanished while we waited receives no further bytes;
 *   * a half-open client (no 'drain' ever) is bounded: `onTimeout` runs, the
 *     writer stops accepting waits, and the caller tears the stream down.
 *
 * `enabled: false` keeps a legacy synchronous producer byte-identical to its old
 * behaviour: the verdict is still returned, but no drain waiter is armed (the
 * legacy gRPC channel consumes its callback synchronously and cannot hold its
 * producer, so arming there would let `onEnd` overtake an unfinished emission).
 */

/**
 * 120s mirrors the historical Cascade constant. Overridable per deployment with
 * WINDSURFAPI_MAX_DRAIN_MS (a stalled reader should not pin a request forever).
 */
export const MAX_DRAIN_WAIT_DEFAULT_MS = 120_000;

export function resolveMaxDrainWaitMs(raw = process.env.WINDSURFAPI_MAX_DRAIN_MS) {
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_DRAIN_WAIT_DEFAULT_MS;
}

/** The abort shape every awaiting producer in this repo already recognises. */
export function clientGoneError(message = 'stream aborted while waiting for the client to drain') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'CLIENT_ABORTED';
  err.isClientAbort = true;
  return err;
}

/**
 * @param {object}   opts
 * @param {object}   opts.res      Writable-ish response (real `ServerResponse` or a translator capture).
 * @param {AbortSignal|null} [opts.signal]  Handler-local abort signal (client gone / shutdown).
 * @param {boolean}  [opts.enabled=true]     Arm the drain waiter on a false verdict.
 * @param {number}   [opts.maxWaitMs]        Bound on one drain wait.
 * @param {Function} [opts.onTimeout]        Called once when a drain wait expires, BEFORE the
 *                                           writer stops arming. The caller owns the teardown
 *                                           (error frame, abort, registry detach).
 */
export function createBoundedWriter({
  res,
  signal = null,
  enabled = true,
  maxWaitMs = resolveMaxDrainWaitMs(),
  onTimeout = null,
} = {}) {
  let pending = null;
  let settleCurrent = null;
  let timedOut = false;
  let disposed = false;

  const gone = () => !!disposed || res.writableEnded === true || signal?.aborted === true;

  const beginDrain = () => {
    if (pending) return pending;
    if (!enabled || timedOut || gone()) return null;
    let settleDrain = () => {};
    const operation = new Promise((resolve) => { settleDrain = resolve; });
    let settled = false;
    let timer = null;
    const finishDrain = () => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending === operation) pending = null;
      if (settleCurrent === finishDrain) settleCurrent = null;
      // Some embedders hand this handler a minimal writable; only real streams
      // carry the EventEmitter alias.
      res.removeListener?.('drain', finishDrain);
      res.removeListener?.('close', finishDrain);
      res.removeListener?.('error', finishDrain);
      signal?.removeEventListener?.('abort', finishDrain);
      settleDrain();
    };
    // Half-open client: no 'drain' ever arrives. Bound the wait, hand control
    // back to the caller, and stop arming new waits behind it.
    const onDrainTimeout = () => {
      if (settled) return;
      timedOut = true;
      try { onTimeout?.({ maxWaitMs }); } catch { /* teardown is the caller's, never ours */ }
      finishDrain();
    };
    pending = operation;
    settleCurrent = finishDrain;
    timer = setTimeout(onDrainTimeout, maxWaitMs);
    // Never keep the process alive for a wait that belongs to one request.
    timer.unref?.();
    res.on?.('drain', finishDrain);
    res.on?.('close', finishDrain);
    res.on?.('error', finishDrain);
    signal?.addEventListener?.('abort', finishDrain, { once: true });
    // The client may already be gone by the time we start waiting.
    if (gone()) finishDrain();
    return operation;
  };

  /**
   * Write one frame. Returns the real verdict (true when the writer is already
   * gone, because no bytes were needed). A false verdict arms the single drain
   * wait; the frame itself was accepted and is never resent.
   *
   * A throwing write is left to propagate: the caller's failure stages own its
   * diagnosis, and re-classifying it here would change how a broken socket is
   * reported.
   */
  const write = (text) => {
    if (gone()) return true;
    const ok = res.write(text) !== false;
    if (ok === false) beginDrain();
    return ok;
  };

  /**
   * Awaits the outstanding drain, if any. Throws once the writer is gone so the
   * awaiting producer stops instead of feeding a closed socket.
   */
  const awaitDrain = async () => {
    while (pending) await pending;
    if (gone()) throw clientGoneError();
  };

  /** Teardown variant: same wait, but never throws (a failure stage must reach its cleanup). */
  const settle = async () => {
    while (pending) await pending;
  };

  /**
   * Sequential emission: wait for any outstanding drain, then write once.
   * Returns undefined on the unarmed (legacy) path so that consumer stays fully
   * synchronous.
   */
  const writeFrame = (text) => {
    if (!enabled) {
      write(text);
      return undefined;
    }
    return awaitDrain().then(() => { write(text); });
  };

  const dispose = () => {
    disposed = true;
    // Settle (never hang) a producer parked on this writer.
    settleCurrent?.();
  };

  return {
    write,
    writeFrame,
    awaitDrain,
    settle,
    dispose,
    gone,
    get pending() { return pending; },
    get timedOut() { return timedOut; },
  };
}
