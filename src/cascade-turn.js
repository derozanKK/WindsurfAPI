// Producer-level Cascade turn state (Q10 P1, research/Q10/REPORT.md §5.2).
//
// Why this exists: a Cascade trajectory is append-only while a turn is ACTIVE,
// and a step's responseText/thinking grows IN PLACE across polls. The answer
// does not stop at the last step index — E2b measured 596 → 16,632 chars
// inside the same three steps while the client was detached. A resume keyed on
// `stepOffset` alone therefore reads zero steps and returns an empty answer.
//
// The cursor is the design-critical state:
//   - `stepOffset` is the absolute index of the next unread step;
//   - `pollFloor` is the absolute offset this turn started from, so a resumed
//     cascade never replays pre-turn steps as fresh output;
//   - `yieldedByStep` / `thinkingByStep` are absolute-index → emitted-length
//     cursors, so re-reading the overlap window emits only real growth;
//   - the poll window starts at `max(pollFloor, stepOffset - overlap)`, never
//     at `stepOffset`, so growth inside an already-counted step is visible.
//
// `snapshot()` / `fromSnapshot()` are the lazy-resume contract. A snapshot
// without the per-step cursors is rejected: it cannot distinguish "already
// emitted" from "not yet read", which is exactly the E2b bug.

// Cascade steps are append-only while ACTIVE: a step's responseText/thinking
// grows in place across polls. Polling strictly after the last consumed step
// would strand that growth until the final sweep, so each poll re-reads this
// many already-seen steps. Bounded (not the whole trajectory) and floored at
// the turn's resume offset so pre-turn steps are never replayed.
export const CASCADE_STEP_OVERLAP = 8;

// v2 (detach P1) adds generatorOffset, sawActive, usageByStep and
// consumedThrough. v1 snapshots were in-memory only, so the bump is free:
// fromSnapshot refuses a v1 payload instead of silently resuming it without
// the metadata offset (over-bill) or the consumed pointer (duplicate steps).
const SNAPSHOT_VERSION = 2;

// The feature flag is read at call time, not module load, so a test (or a
// future runtime config reload) can flip it without re-importing client.js.
// Default OFF: only the exact string '1' enables the producer path.
export function cascadeTurnEnabled(env = process.env) {
  return String(env.WINDSURFAPI_CASCADE_TURN || '') === '1';
}

/**
 * A snapshot that cannot be resumed safely. Named so callers can distinguish
 * a broken entry (drop it, retry upstream) from a transport failure.
 */
export class CascadeTurnCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CascadeTurnCursorError';
    this.code = 'CASCADE_TURN_CURSOR';
  }
}

function pairsFromMap(value, label) {
  if (value instanceof Map) {
    for (const [index, length] of value) {
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(length) || length < 0) {
        throw new CascadeTurnCursorError(`CascadeTurn ${label} has a non-integer cursor entry`);
      }
    }
    return new Map(value);
  }
  if (!Array.isArray(value)) {
    throw new CascadeTurnCursorError(`CascadeTurn ${label} must be a Map or an array of [index, length] pairs`);
  }
  const map = new Map();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new CascadeTurnCursorError(`CascadeTurn ${label} entry is not an [index, length] pair`);
    }
    const [index, length] = pair;
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(length) || length < 0) {
      throw new CascadeTurnCursorError(`CascadeTurn ${label} has a non-integer cursor entry`);
    }
    map.set(index, length);
  }
  return map;
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Per-step usage is an index → {inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens} map. JSON-safe form is an array of [index, usage] pairs.
 * A non-object value is a broken snapshot, not a usage report: refuse it
 * rather than resume with a silently dropped billing fallback.
 */
function usageFromMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : value;
  if (!Array.isArray(entries)) {
    throw new CascadeTurnCursorError('CascadeTurn usageByStep must be a Map or an array of [index, usage] pairs');
  }
  const map = new Map();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new CascadeTurnCursorError('CascadeTurn usageByStep entry is not an [index, usage] pair');
    }
    const [index, usage] = pair;
    if (!Number.isInteger(index) || index < 0) {
      throw new CascadeTurnCursorError('CascadeTurn usageByStep has a non-integer index');
    }
    if (!usage || typeof usage !== 'object') {
      throw new CascadeTurnCursorError('CascadeTurn usageByStep has a non-object usage value');
    }
    map.set(index, { ...usage });
  }
  return map;
}

export class CascadeTurn {
  /**
   * @param {object} [options]
   * @param {string} [options.cascadeId]
   * @param {number} [options.stepOffset=0] absolute index of the next unread step
   * @param {number} [options.pollFloor=stepOffset] absolute offset this turn started from
   * @param {number} [options.overlap=CASCADE_STEP_OVERLAP] bounded re-read window
   * @param {Array} [options.chunks=[]] producer buffer (raw chunks, not SSE bytes)
   * @param {(chunk: object) => any} [options.emit] sink called after each chunk is buffered
   * @param {Map|Array} [options.yieldedByStep]
   * @param {Map|Array} [options.thinkingByStep]
   * @param {number} [options.totalYielded=0]
   * @param {number} [options.totalThinking=0]
   * @param {boolean} [options.sawText=false]
   * @param {number} [options.generatorOffset=0] metadata-RPC offset this turn started from
   * @param {boolean} [options.sawActive=false] true once the trajectory was non-IDLE
   * @param {Map|Array} [options.usageByStep] per-step usage fallback
   * @param {number} [options.consumedThrough=pollFloor] max(consumed index)+1
   */
  constructor({
    cascadeId = '',
    stepOffset = 0,
    pollFloor = stepOffset,
    overlap = CASCADE_STEP_OVERLAP,
    chunks = [],
    emit = null,
    yieldedByStep = new Map(),
    thinkingByStep = new Map(),
    totalYielded = 0,
    totalThinking = 0,
    sawText = false,
    generatorOffset = 0,
    sawActive = false,
    usageByStep = new Map(),
    consumedThrough = pollFloor,
  } = {}) {
    if (!Number.isInteger(stepOffset) || stepOffset < 0) {
      throw new CascadeTurnCursorError(`CascadeTurn stepOffset must be a non-negative integer, got ${stepOffset}`);
    }
    if (!Number.isInteger(pollFloor) || pollFloor < 0 || pollFloor > stepOffset) {
      throw new CascadeTurnCursorError(`CascadeTurn pollFloor must be an integer in [0, stepOffset], got ${pollFloor}`);
    }
    if (!Number.isInteger(generatorOffset) || generatorOffset < 0) {
      throw new CascadeTurnCursorError(`CascadeTurn generatorOffset must be a non-negative integer, got ${generatorOffset}`);
    }
    if (!Number.isInteger(consumedThrough) || consumedThrough < 0 || consumedThrough > stepOffset) {
      throw new CascadeTurnCursorError(
        `CascadeTurn consumedThrough must be an integer in [0, stepOffset], got ${consumedThrough}`,
      );
    }
    this.cascadeId = cascadeId;
    this.stepOffset = stepOffset;
    this.pollFloor = pollFloor;
    this.overlap = positiveInt(overlap, CASCADE_STEP_OVERLAP);
    this.chunks = chunks;
    this.emit = typeof emit === 'function' ? emit : null;
    this.yieldedByStep = pairsFromMap(yieldedByStep, 'yieldedByStep');
    this.thinkingByStep = pairsFromMap(thinkingByStep, 'thinkingByStep');
    this.totalYielded = Number.isFinite(totalYielded) ? totalYielded : 0;
    this.totalThinking = Number.isFinite(totalThinking) ? totalThinking : 0;
    this.sawText = !!sawText;
    this.generatorOffset = generatorOffset;
    this.sawActive = !!sawActive;
    this.usageByStep = usageFromMap(usageByStep);
    // Absolute pointer proving every counted step was actually consumed. A
    // detach is only safe when this equals stepOffset: otherwise the steps
    // between the two would fall out of the resume window (stepOffset -
    // overlap) and their text would be lost.
    this.consumedThrough = consumedThrough;
    this.lastWindowStart = pollFloor;
    this.lastGrowthAt = Date.now();
    // Set by fromSnapshot: the exact window the detached turn would have read
    // next. Used once, then the live formula takes over.
    this.resumeWindowStart = null;
  }

  /** Window start the next poll would use. Does not consume a pending resume. */
  nextWindowStart() {
    if (this.resumeWindowStart !== null) return this.resumeWindowStart;
    return Math.max(this.pollFloor, this.stepOffset - this.overlap);
  }

  /** The produced text so far (all chunks, including pre-detach). */
  get text() {
    let out = '';
    for (const chunk of this.chunks) out += chunk?.text || '';
    return out;
  }

  /** The produced thinking so far. */
  get thinking() {
    let out = '';
    for (const chunk of this.chunks) out += chunk?.thinking || '';
    return out;
  }

  /**
   * One GetCascadeTrajectorySteps read. Advances `stepOffset` and records the
   * window; does NOT consume the steps (call consumeStep in the caller's order
   * so tool-call chunks interleave exactly as they do in the foreground loop).
   *
   * @param {(windowStart: number) => Promise<Array>} fetchSteps
   */
  async readWindow(fetchSteps) {
    if (typeof fetchSteps !== 'function') {
      throw new TypeError('CascadeTurn.readWindow requires a fetchSteps(windowStart) function');
    }
    const windowStart = this.nextWindowStart();
    const steps = await fetchSteps(windowStart);
    if (!Array.isArray(steps)) {
      throw new TypeError('CascadeTurn fetchSteps must resolve to an array of steps');
    }
    // Only consume the pending resume window after a successful read: a
    // transient fetch failure must retry the same (older, wider) window.
    this.resumeWindowStart = null;
    this.lastWindowStart = windowStart;
    const previousStepOffset = this.stepOffset;
    const nextStepOffset = windowStart + steps.length;
    if (nextStepOffset > this.stepOffset) this.stepOffset = nextStepOffset;
    const advanced = this.stepOffset > previousStepOffset;
    if (advanced) this.lastGrowthAt = Date.now();
    return {
      windowStart,
      steps,
      advanced,
      stepOffset: this.stepOffset,
    };
  }

  /**
   * Emit the thinking/text growth of one step since its cursor. The cursor is
   * advanced before the sink await, matching the foreground loop: a slow or
   * failed consumer must not cause the same delta to be emitted twice.
   *
   * @returns {Promise<{textDelta: string, thinkingDelta: string, grew: boolean}>}
   */
  async consumeStep(step, stepIndex) {
    // The step was read and is being consumed: advance the proof pointer
    // BEFORE any await, so a detach landing inside the sink still records it.
    // `stepIndex < stepOffset` keeps a standalone consume (no readWindow) from
    // moving the pointer past a cursor the turn never advanced.
    if (stepIndex < this.stepOffset && stepIndex + 1 > this.consumedThrough) {
      this.consumedThrough = stepIndex + 1;
    }
    let thinkingDelta = '';
    const liveThink = step?.thinking || '';
    if (liveThink) {
      const prevThink = this.thinkingByStep.get(stepIndex) || 0;
      if (liveThink.length > prevThink) {
        thinkingDelta = liveThink.slice(prevThink);
        this.thinkingByStep.set(stepIndex, liveThink.length);
        this.totalThinking += thinkingDelta.length;
        this.lastGrowthAt = Date.now();
        await this.#emit({ text: '', thinking: thinkingDelta, isError: false });
      }
    }

    let textDelta = '';
    const liveText = step?.responseText || step?.text || '';
    if (liveText) {
      const prev = this.yieldedByStep.get(stepIndex) || 0;
      if (liveText.length > prev) {
        textDelta = liveText.slice(prev);
        this.yieldedByStep.set(stepIndex, liveText.length);
        this.totalYielded += textDelta.length;
        this.sawText = true;
        this.lastGrowthAt = Date.now();
        await this.#emit({ text: textDelta, thinking: '', isError: false });
      }
    }

    return { textDelta, thinkingDelta, grew: !!(textDelta || thinkingDelta) };
  }

  /**
   * The final IDLE sweep's polish pass. `responseText` is topped up first;
   * `modifiedText` is only appended when it is a strict extension of
   * responseText (a rewrite would splice wrong bytes onto the stream). Both
   * top-ups mark `sawText`: this sweep is often the FIRST place a turn's text
   * becomes visible, and a turn that emitted text did not end empty.
   */
  async consumeFinalStep(step, stepIndex) {
    if (stepIndex < this.stepOffset && stepIndex + 1 > this.consumedThrough) {
      this.consumedThrough = stepIndex + 1;
    }
    const responseText = step?.responseText || '';
    const modifiedText = step?.modifiedText || '';
    let textDelta = '';

    const prev = this.yieldedByStep.get(stepIndex) || 0;
    if (responseText.length > prev) {
      textDelta = responseText.slice(prev);
      this.yieldedByStep.set(stepIndex, responseText.length);
      this.totalYielded += textDelta.length;
      // F2: the sweep can be the FIRST place this step's text is visible, so
      // it must account for the emission exactly like consumeStep does.
      // Leaving sawText false made the turn end `idle_empty` after the bytes
      // had already been streamed.
      this.sawText = true;
      this.lastGrowthAt = Date.now();
      await this.#emit({ text: textDelta, thinking: '', isError: false });
    }

    const cursor = this.yieldedByStep.get(stepIndex) || 0;
    if (modifiedText.length > cursor && modifiedText.startsWith(responseText)) {
      const polish = modifiedText.slice(cursor);
      this.yieldedByStep.set(stepIndex, modifiedText.length);
      this.totalYielded += polish.length;
      this.sawText = true;
      this.lastGrowthAt = Date.now();
      await this.#emit({ text: polish, thinking: '', isError: false });
      textDelta += polish;
    }

    return { textDelta };
  }

  /**
   * Fetch + consume in one call. This is the pump's entry point; the
   * foreground loop uses readWindow/consumeStep separately so its per-step
   * tool-call handling keeps its exact ordering.
   *
   * `beforeStep` runs before the step's deltas are consumed and may return
   * false to stop (e.g. the native-tool proposal hand-off). `afterStep` runs
   * after the deltas.
   */
  async pollOnce(fetchSteps, { beforeStep, afterStep } = {}) {
    const read = await this.readWindow(fetchSteps);
    let grew = read.advanced;
    let stopped = false;
    for (let i = 0; i < read.steps.length; i++) {
      const step = read.steps[i];
      const stepIndex = read.windowStart + i;
      if (typeof beforeStep === 'function' && (await beforeStep(step, stepIndex)) === false) {
        stopped = true;
        break;
      }
      const consumed = await this.consumeStep(step, stepIndex);
      grew = grew || consumed.grew;
      await afterStep?.(step, stepIndex, consumed);
    }
    return { ...read, grew, stopped };
  }

  /** Move the next-unread cursor forward (the final sweep can see new steps). */
  advanceTo(stepOffset) {
    if (Number.isInteger(stepOffset) && stepOffset > this.stepOffset) {
      this.stepOffset = stepOffset;
    }
    return this.stepOffset;
  }

  /**
   * The resumable producer state. The cursor maps are JSON-safe [index,
   * length] arrays; chunks are shallow copies (nested tool payloads keep
   * their original object identity).
   */
  snapshot() {
    // A detach taken mid-batch would store stepOffset ahead of the cursors;
    // steps older than stepOffset - overlap would then fall out of the resume
    // window and their text would be lost forever. Refuse instead of storing
    // an entry that cannot be resumed correctly.
    if (this.consumedThrough !== this.stepOffset) {
      throw new CascadeTurnCursorError(
        `CascadeTurn cannot snapshot a mid-batch turn: consumedThrough ${this.consumedThrough} != stepOffset ${this.stepOffset}`,
      );
    }
    return {
      version: SNAPSHOT_VERSION,
      cascadeId: this.cascadeId,
      stepOffset: this.stepOffset,
      pollFloor: this.pollFloor,
      windowStart: this.nextWindowStart(),
      lastWindowStart: this.lastWindowStart,
      overlap: this.overlap,
      yieldedByStep: [...this.yieldedByStep.entries()].sort((a, b) => a[0] - b[0]),
      thinkingByStep: [...this.thinkingByStep.entries()].sort((a, b) => a[0] - b[0]),
      totalYielded: this.totalYielded,
      totalThinking: this.totalThinking,
      sawText: this.sawText,
      // v2: the metadata RPC is offset-scoped. Resuming from 0 re-sums every
      // prior turn of the cascade and over-bills it (src/windsurf.js:947-951).
      generatorOffset: this.generatorOffset,
      // v2: the IDLE grace only applies before the trajectory was ever
      // non-IDLE; a resumed ACTIVE turn must not wait the extra grace.
      sawActive: this.sawActive,
      // v2: fallback usage when the metadata RPC fails.
      usageByStep: [...this.usageByStep.entries()].sort((a, b) => a[0] - b[0]).map(([i, u]) => [i, { ...u }]),
      // v2: proves every counted step was consumed (see the guard above).
      consumedThrough: this.consumedThrough,
      chunks: this.chunks.map(chunk => ({ ...chunk })),
    };
  }

  /**
   * Restore a detached turn. Refuses a snapshot without per-step cursors:
   * `stepOffset` alone cannot tell which bytes were already emitted, and
   * starting the window there is the E2b "0 steps / 0 chars" bug.
   *
   * @param {object} snapshot
   * @param {object} [options]
   * @param {(chunk: object) => any} [options.emit]
   */
  static fromSnapshot(snapshot, { emit = null } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new CascadeTurnCursorError('CascadeTurn.fromSnapshot requires a snapshot object');
    }
    if (snapshot.version != null && snapshot.version !== SNAPSHOT_VERSION) {
      throw new CascadeTurnCursorError(`CascadeTurn snapshot version ${snapshot.version} is not supported (expected ${SNAPSHOT_VERSION})`);
    }
    if (!Number.isInteger(snapshot.stepOffset) || snapshot.stepOffset < 0) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no valid stepOffset');
    }
    if (!Number.isInteger(snapshot.pollFloor) || snapshot.pollFloor < 0 || snapshot.pollFloor > snapshot.stepOffset) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no valid pollFloor');
    }
    if (!Array.isArray(snapshot.yieldedByStep) || !Array.isArray(snapshot.thinkingByStep)) {
      throw new CascadeTurnCursorError(
        'CascadeTurn snapshot has no per-step cursors (yieldedByStep/thinkingByStep); '
        + 'resuming from stepOffset alone returns zero steps (Q10 E2b: stepOffset=3 → 0 steps / 0 chars)',
      );
    }
    // v2 validity precondition: every counted step must have been consumed.
    // Without this an entry with stepOffset=3 and empty cursors is accepted,
    // and the resumed window (max(0, 3-8)=0) re-emits steps 0-2 — a duplicated
    // prefix, not the E2b "0 steps" bug.
    if (!Number.isInteger(snapshot.consumedThrough)) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no consumedThrough pointer');
    }
    if (snapshot.consumedThrough !== snapshot.stepOffset) {
      throw new CascadeTurnCursorError(
        `CascadeTurn snapshot is mid-batch: consumedThrough ${snapshot.consumedThrough} != stepOffset ${snapshot.stepOffset}`,
      );
    }
    if (!Number.isInteger(snapshot.generatorOffset) || snapshot.generatorOffset < 0) {
      throw new CascadeTurnCursorError(
        'CascadeTurn snapshot has no generatorOffset; resuming the metadata RPC from 0 re-bills prior turns',
      );
    }
    if (typeof snapshot.sawActive !== 'boolean') {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no sawActive flag');
    }
    if (!Array.isArray(snapshot.usageByStep)) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no usageByStep fallback');
    }

    const turn = new CascadeTurn({
      cascadeId: snapshot.cascadeId,
      stepOffset: snapshot.stepOffset,
      pollFloor: snapshot.pollFloor,
      overlap: snapshot.overlap,
      chunks: Array.isArray(snapshot.chunks)
        ? snapshot.chunks.map(chunk => (chunk && typeof chunk === 'object' ? { ...chunk } : chunk))
        : [],
      emit,
      yieldedByStep: snapshot.yieldedByStep,
      thinkingByStep: snapshot.thinkingByStep,
      totalYielded: snapshot.totalYielded,
      totalThinking: snapshot.totalThinking,
      sawText: snapshot.sawText,
      generatorOffset: snapshot.generatorOffset,
      sawActive: snapshot.sawActive,
      usageByStep: snapshot.usageByStep,
      consumedThrough: snapshot.consumedThrough,
    });

    if (Number.isInteger(snapshot.windowStart)) {
      if (snapshot.windowStart < snapshot.pollFloor || snapshot.windowStart > snapshot.stepOffset) {
        throw new CascadeTurnCursorError(
          `CascadeTurn snapshot windowStart ${snapshot.windowStart} is outside [${snapshot.pollFloor}, ${snapshot.stepOffset}]`,
        );
      }
      turn.resumeWindowStart = snapshot.windowStart;
    }
    if (Number.isInteger(snapshot.lastWindowStart)) turn.lastWindowStart = snapshot.lastWindowStart;
    return turn;
  }

  async #emit(chunk) {
    this.chunks.push(chunk);
    if (this.emit) await this.emit(chunk);
  }
}
