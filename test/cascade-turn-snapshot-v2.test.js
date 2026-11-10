// Detach P1 — snapshot v2 (S1–S7).
//
// The v1 snapshot carried the per-step cursors but not the four fields a
// CORRECT resume needs:
//   - generatorOffset: the metadata RPC is offset-scoped. Resuming from 0
//     re-sums every prior turn of the cascade and over-bills it.
//   - sawActive: a resumed ACTIVE turn must not wait the IDLE grace again.
//   - usageByStep: the fallback when the metadata RPC fails.
//   - consumedThrough: proves every counted step was actually consumed.
//     Without it `fromSnapshot({stepOffset:3, cursors:[]})` is accepted and
//     the resumed window re-emits steps 0–2 (a duplicated prefix).
//
// S1–S6 are RED-B against the pre-change module (the fields are undefined and
// the empty-cursor snapshot is accepted); S7 is a post-bump guard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CascadeTurn, CascadeTurnCursorError } from '../src/cascade-turn.js';

function step(text, { thinking = '' } = {}) {
  return { responseText: text, thinking, modifiedText: '', status: 3, toolCalls: [] };
}

function consumedTurn({ generatorOffset = 0, sawActive = false } = {}) {
  const turn = new CascadeTurn({ cascadeId: 'snapshot-v2', generatorOffset, sawActive });
  return turn;
}

async function readAndConsume(turn, steps) {
  const read = await turn.readWindow(start => steps.slice(start));
  for (let i = 0; i < read.steps.length; i++) {
    await turn.consumeStep(read.steps[i], read.windowStart + i);
  }
  return read;
}

describe('CascadeTurn snapshot v2', () => {
  it('S1 carries generatorOffset (the metadata RPC must not restart at 0)', async () => {
    const turn = consumedTurn({ generatorOffset: 7 });
    await readAndConsume(turn, [step('a')]);
    const snap = JSON.parse(JSON.stringify(turn.snapshot()));
    assert.equal(snap.generatorOffset, 7,
      'a resumed turn without generatorOffset asks GetCascadeTrajectoryGeneratorMetadata from offset 0 and sums prior turns');
  });

  it('S2 carries sawActive (no second IDLE grace after a resume)', async () => {
    const turn = consumedTurn();
    await readAndConsume(turn, [step('a')]);
    // The client sets this when GetCascadeTrajectory reports non-IDLE.
    turn.sawActive = true;
    const snap = turn.snapshot();
    assert.equal(snap.sawActive, true);
    const restored = CascadeTurn.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.sawActive, true);
  });

  it('S3 carries usageByStep and survives JSON', async () => {
    const turn = consumedTurn();
    await readAndConsume(turn, [step('a')]);
    turn.usageByStep.set(0, {
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
    });
    const snap = JSON.parse(JSON.stringify(turn.snapshot()));
    assert.deepEqual(snap.usageByStep, [[0, {
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
    }]]);
    const restored = CascadeTurn.fromSnapshot(snap);
    assert.deepEqual([...restored.usageByStep.entries()], [[0, {
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
    }]]);
  });

  it('S4 consumedThrough equals stepOffset after a full window', async () => {
    const turn = consumedTurn();
    await readAndConsume(turn, [step('a'), step('b'), step('c')]);
    assert.equal(turn.stepOffset, 3);
    assert.equal(turn.snapshot().consumedThrough, 3);
  });

  it('S5 refuses a mid-batch snapshot instead of losing the unconsumed steps', async () => {
    const turn = consumedTurn();
    const read = await turn.readWindow(() => [step('a'), step('b')]);
    await turn.consumeStep(read.steps[0], read.windowStart); // step 1 NOT consumed
    assert.equal(turn.stepOffset, 2);
    assert.equal(turn.consumedThrough, 1);
    assert.throws(
      () => turn.snapshot(),
      (err) => {
        assert.ok(err instanceof CascadeTurnCursorError);
        assert.equal(err.code, 'CASCADE_TURN_CURSOR');
        assert.match(err.message, /mid-batch/);
        return true;
      },
    );

    // Positive control in the same file: consuming the rest makes it valid.
    await turn.consumeStep(read.steps[1], read.windowStart + 1);
    assert.equal(turn.snapshot().consumedThrough, 2);
  });

  it('S6 refuses an empty-cursor snapshot (duplicated prefix)', () => {
    assert.throws(
      () => CascadeTurn.fromSnapshot({
        version: 2,
        cascadeId: 'empty',
        stepOffset: 3,
        pollFloor: 0,
        windowStart: 0,
        yieldedByStep: [],
        thinkingByStep: [],
        consumedThrough: 0,
        generatorOffset: 0,
        sawActive: false,
        usageByStep: [],
        chunks: [],
      }),
      CascadeTurnCursorError,
      'consumedThrough=0 with stepOffset=3 must be refused',
    );

    // Positive control: the same shape with every counted step consumed is a
    // valid resume (the window is 0 and the empty cursors are legitimate for
    // steps that produced no text).
    const ok = CascadeTurn.fromSnapshot({
      version: 2,
      cascadeId: 'empty-ok',
      stepOffset: 3,
      pollFloor: 0,
      windowStart: 0,
      yieldedByStep: [],
      thinkingByStep: [],
      consumedThrough: 3,
      generatorOffset: 0,
      sawActive: false,
      usageByStep: [],
      chunks: [],
    });
    assert.equal(ok.stepOffset, 3);
    assert.equal(ok.consumedThrough, 3);
  });

  it('S7 rejects a v1 snapshot after the bump (guard, not red-first)', () => {
    assert.throws(
      () => CascadeTurn.fromSnapshot({
        version: 1,
        stepOffset: 1,
        pollFloor: 0,
        yieldedByStep: [[0, 1]],
        thinkingByStep: [],
        chunks: [],
      }),
      (err) => {
        assert.ok(err instanceof CascadeTurnCursorError);
        assert.match(err.message, /version 1 is not supported/);
        return true;
      },
    );
  });
});
