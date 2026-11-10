// Q10 P1: the Cascade cursor is the design-critical state.
//
// E2b (research/Q10/REPORT.md §3.2) detached at stepOffset=3 with 596 chars,
// let the SAME three steps grow to 16,632 chars, then resumed:
//
//   windowStart = stepOffset (3)  -> 0 steps / 0 chars   <- the bug
//   windowStart = 0               -> 3 steps / 16,632   <- correct
//
// These tests script that trajectory at the producer seam. They pin the
// resume contract (per-step cursors, overlap window, snapshot round-trip) and
// the default-off flag. They do not need a language server: the turn's only
// upstream dependency is the injected fetchSteps callback.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CascadeTurn,
  CascadeTurnCursorError,
  CASCADE_STEP_OVERLAP,
  cascadeTurnEnabled,
} from '../src/cascade-turn.js';

// E2b's measured shape: 596 chars at detach, 16,632 after the turn finished,
// all inside three steps. Step 2 carries the growth; steps 0/1 are stable.
const DETACHED_STEP_TEXT = 'P'.repeat(396);
const FINAL_STEP_TEXT = 'P'.repeat(396) + 'G'.repeat(16632 - 596);
const FULL_TEXT = 'A'.repeat(100) + 'B'.repeat(100) + FINAL_STEP_TEXT;
const DETACHED_TEXT = 'A'.repeat(100) + 'B'.repeat(100) + DETACHED_STEP_TEXT;
const DETACHED_THINKING = 't'.repeat(72);
const FINAL_THINKING = 't'.repeat(81);

function plannerStep(responseText, { thinking = '', modifiedText = '', status = 3 } = {}) {
  return { responseText, thinking, modifiedText, status, toolCalls: [] };
}

function e2bTrajectory() {
  let steps = [
    plannerStep('A'.repeat(100)),
    plannerStep('B'.repeat(100)),
    plannerStep(DETACHED_STEP_TEXT, { thinking: DETACHED_THINKING }),
  ];
  return {
    steps,
    grow() {
      steps = [
        plannerStep('A'.repeat(100)),
        plannerStep('B'.repeat(100)),
        plannerStep(FINAL_STEP_TEXT, { thinking: FINAL_THINKING }),
      ];
    },
    fetch(start) {
      return steps.slice(start);
    },
  };
}

async function consumeAll(turn, read) {
  for (let i = 0; i < read.steps.length; i++) {
    await turn.consumeStep(read.steps[i], read.windowStart + i);
  }
}

describe('CascadeTurn lazy resume (Q10 E2b)', () => {
  it('returns the full text that grew inside the last step after detach', async () => {
    const upstream = e2bTrajectory();
    const original = new CascadeTurn({ cascadeId: 'q10-e2b' });

    const firstRead = await original.readWindow(start => upstream.fetch(start));
    assert.equal(firstRead.windowStart, 0);
    assert.equal(firstRead.steps.length, 3);
    assert.equal(firstRead.advanced, true);
    assert.equal(original.stepOffset, 3, 'the three counted steps are the absolute next offset');
    await consumeAll(original, firstRead);
    assert.equal(original.text, DETACHED_TEXT);
    assert.equal(original.totalYielded, 596);
    assert.equal(original.thinking, DETACHED_THINKING);

    const snapshot = original.snapshot();
    assert.equal(snapshot.stepOffset, 3);
    assert.equal(snapshot.pollFloor, 0);
    assert.equal(snapshot.windowStart, 0, 'the next poll window must reach behind the unread offset');

    // The upstream finishes the turn while the client is detached. Nothing
    // new is appended: the same three steps now hold 16,632 chars.
    upstream.grow();

    // The bug, reproduced: a resume keyed on stepOffset alone asks the LS for
    // steps starting at 3 and gets nothing back.
    const naive = new CascadeTurn({ cascadeId: 'q10-e2b', stepOffset: 3, pollFloor: 3 });
    const naiveRead = await naive.readWindow(start => upstream.fetch(start));
    assert.equal(naiveRead.windowStart, 3);
    assert.equal(naiveRead.steps.length, 0);
    assert.equal(naive.text, '', 'stepOffset=3 → 0 steps / 0 chars');

    // The fix: restore the cursor snapshot. The window starts at 0 and the
    // per-step cursors emit only the 16,036 chars that arrived while detached.
    const resumed = CascadeTurn.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const resumedRead = await resumed.readWindow(start => upstream.fetch(start));
    assert.equal(resumedRead.windowStart, 0);
    assert.equal(resumedRead.steps.length, 3);
    assert.equal(resumedRead.advanced, false, 're-reading counted steps does not advance the offset');

    const chunksBefore = resumed.chunks.length;
    await consumeAll(resumed, resumedRead);
    const replayDelta = resumed.chunks.slice(chunksBefore).map(chunk => chunk.text || '').join('');

    assert.equal(resumed.text, FULL_TEXT, 'the resumed turn holds the full answer, prefix included exactly once');
    assert.equal(resumed.totalYielded, FULL_TEXT.length);
    assert.equal(replayDelta, FULL_TEXT.slice(DETACHED_TEXT.length), 'only the post-detach growth is re-emitted');
    assert.equal(resumed.thinking, FINAL_THINKING);
    assert.equal(resumed.chunks.slice(chunksBefore).map(chunk => chunk.thinking || '').join(''), 't'.repeat(9),
      'thinking resumes from its own per-step cursor');
  });

  it('reconstructs the window from per-step cursors when windowStart is absent', async () => {
    const upstream = e2bTrajectory();
    const original = new CascadeTurn({ cascadeId: 'no-window' });
    const firstRead = await original.readWindow(start => upstream.fetch(start));
    await consumeAll(original, firstRead);

    const snapshot = original.snapshot();
    delete snapshot.windowStart; // older entry shape: cursors only
    upstream.grow();

    const resumed = CascadeTurn.fromSnapshot(snapshot);
    assert.equal(resumed.nextWindowStart(), 0, 'stepOffset - overlap reaches back into the counted steps');
    const resumedRead = await resumed.readWindow(start => upstream.fetch(start));
    await consumeAll(resumed, resumedRead);
    assert.equal(resumed.text, FULL_TEXT);
  });

  it('refuses a snapshot without per-step cursors instead of resuming at stepOffset', () => {
    assert.throws(
      () => CascadeTurn.fromSnapshot({ stepOffset: 3, pollFloor: 0 }),
      (err) => {
        assert.ok(err instanceof CascadeTurnCursorError);
        assert.equal(err.code, 'CASCADE_TURN_CURSOR');
        assert.match(err.message, /yieldedByStep\/thinkingByStep/);
        assert.match(err.message, /stepOffset=3/);
        return true;
      },
    );
    assert.throws(
      () => CascadeTurn.fromSnapshot({ stepOffset: 3, pollFloor: 0, yieldedByStep: [] }),
      CascadeTurnCursorError,
      'both cursor maps are required',
    );
  });

  it('round-trips a JSON-serialized snapshot without losing cursors or buffered chunks', async () => {
    const original = new CascadeTurn({ cascadeId: 'round-trip' });
    const step = plannerStep('hello', { thinking: 'why' });
    await original.consumeStep(step, 0);
    const snapshot = JSON.parse(JSON.stringify(original.snapshot()));

    const restored = CascadeTurn.fromSnapshot(snapshot);
    assert.equal(restored.cascadeId, 'round-trip');
    assert.equal(restored.stepOffset, 0);
    assert.equal(restored.text, 'hello');
    assert.equal(restored.thinking, 'why');
    assert.deepEqual([...restored.yieldedByStep.entries()], [[0, 5]]);
    assert.deepEqual([...restored.thinkingByStep.entries()], [[0, 3]]);
  });
});

describe('CascadeTurn overlap window', () => {
  it('re-reads a bounded overlap instead of the whole trajectory and emits only growth', async () => {
    const steps = Array.from({ length: 20 }, (_, i) => plannerStep(`S${i}`));
    const requested = [];
    const turn = new CascadeTurn({ cascadeId: 'overlap' });

    const read = await turn.readWindow((start) => {
      requested.push(start);
      return steps.slice(start);
    });
    await consumeAll(turn, read);
    assert.equal(turn.text, steps.map(step => step.responseText).join(''));

    // Step 19 grows after it was counted. The next window starts eight steps
    // back, not at the unread offset (20), so the growth is visible.
    steps[19] = plannerStep('S19-plus-growth');
    const next = await turn.readWindow((start) => {
      requested.push(start);
      return steps.slice(start);
    });
    assert.deepEqual(requested, [0, 20 - CASCADE_STEP_OVERLAP]);
    assert.equal(next.windowStart, 12);
    assert.equal(next.advanced, false, 'no new step appeared; only an existing one grew');

    const chunksBefore = turn.chunks.length;
    await consumeAll(turn, next);
    assert.equal(turn.chunks.slice(chunksBefore).map(chunk => chunk.text || '').join(''), '-plus-growth');
    assert.equal(turn.text, 'S0S1S2S3S4S5S6S7S8S9S10S11S12S13S14S15S16S17S18S19-plus-growth');
  });

  it('never reaches behind pollFloor on a resumed cascade', async () => {
    const requested = [];
    const turn = new CascadeTurn({ cascadeId: 'resume-floor', stepOffset: 5, pollFloor: 5 });
    assert.equal(turn.nextWindowStart(), 5, 'a fresh turn on an existing cascade starts at its floor');

    const read = await turn.readWindow((start) => {
      requested.push(start);
      return [plannerStep('R5'), plannerStep('R6')].slice(start - 5);
    });
    assert.deepEqual(requested, [5]);
    assert.equal(read.steps.length, 2);
    assert.equal(turn.stepOffset, 7);
    assert.equal(turn.nextWindowStart(), 5, 'overlap is clamped to the turn floor');
  });

  it('retries the same resume window after a transient fetch failure', async () => {
    const original = new CascadeTurn({ cascadeId: 'flaky-resume' });
    const read = await original.readWindow(() => [plannerStep('abc')]);
    await consumeAll(original, read);

    const resumed = CascadeTurn.fromSnapshot(original.snapshot());
    await assert.rejects(resumed.readWindow(() => { throw new Error('transport reset'); }), /transport reset/);
    assert.equal(resumed.nextWindowStart(), 0, 'the pending resume window survives a failed read');

    const retry = await resumed.readWindow(() => [plannerStep('abcdef')]);
    assert.equal(retry.windowStart, 0);
    assert.equal(resumed.text, 'abc', 'no delta is emitted until the caller consumes the retried steps');
    await consumeAll(resumed, retry);
    assert.equal(resumed.text, 'abcdef');
  });
});

describe('CascadeTurn final sweep', () => {
  it('tops up responseText and only appends modifiedText when it is a strict extension', async () => {
    const turn = new CascadeTurn({ cascadeId: 'polish' });

    await turn.consumeFinalStep(plannerStep('abc'), 0);
    assert.equal(turn.text, 'abc');

    await turn.consumeFinalStep(plannerStep('abc', { modifiedText: 'abcd' }), 0);
    assert.equal(turn.text, 'abcd', 'a strict extension is appended');

    await turn.consumeFinalStep(plannerStep('abc', { modifiedText: 'Xbcdef' }), 0);
    assert.equal(turn.text, 'abcd', 'a rewritten prefix is not spliced onto the stream');
  });
});

describe('CascadeTurn feature flag', () => {
  it('is off unless WINDSURFAPI_CASCADE_TURN is exactly 1', () => {
    assert.equal(cascadeTurnEnabled({}), false);
    assert.equal(cascadeTurnEnabled({ WINDSURFAPI_CASCADE_TURN: '0' }), false);
    assert.equal(cascadeTurnEnabled({ WINDSURFAPI_CASCADE_TURN: 'true' }), false);
    assert.equal(cascadeTurnEnabled({ WINDSURFAPI_CASCADE_TURN: '' }), false);
    assert.equal(cascadeTurnEnabled({ WINDSURFAPI_CASCADE_TURN: '1' }), true);
  });
});
