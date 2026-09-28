import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function run(options = {}) {
  const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const start = source.indexOf('        // All attempts failed\n');
  const end = source.indexOf('      } finally {\n        unregisterSse();', start);
  assert.ok(start >= 0 && end > start, 'execute the actual failure continuation, not a copied decision tree');
  const block = source.slice(start, end);
  const warnings = [], fallback = [], writes = [], visited = [];
  const boom = () => { throw new Error('sensitive-token-in-error'); };
  const res = {
    writableEnded: false,
    write(text) {
      if (options.errorWrite && text.includes('"error"')) boom();
      if (options.doneWrite && text === 'data: [DONE]\n\n') boom();
      if (options.finishWrite && text.includes('"finish_reason":"stop"')) boom();
      writes.push(text); return true;
    },
    end() { if (options.endFail) boom(); this.writableEnded = true; },
  };
  // Collaborator contract: this unchanged helper emits one finish then DONE.
  // The separate full-handler integration test also exercises its real definition.
  function finishPartialStreamAfterError({ id, created, model, send, res, internalRoute }) {
    send({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(internalRoute ? { __synthetic_finish: true } : {}) });
    if (res && !res.writableEnded) res.write('data: [DONE]\n\n');
  }
  const deps = {
    options, res, visited, lastErr: new Error('upstream failed'), model: 'model', modelKey: 'model',
    startTime: 0, currentApiKey: 'test-key', reqId: 'request', id: 'completion', created: 1,
    tried: ['key'], streamInternalCount: 0, hadSuccess: false, reuseEntryDead: false,
    checkedOutReuseEntry: null, fpBefore: null, callerKey: '', cachePolicy: null,
    deps: { wantThinking: false }, collectedToolCalls: [], isOpenAIClient: !options.internal,
    log: { error: options.logErrorFail ? boom : () => {}, info() {},
      warn: options.logWarnFail ? boom : line => warnings.push(line) },
    process: { stderr: { write: line => fallback.push(line) } },
    safeKeyRef: (text, prefix) => `${prefix}Hash=${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    recordRequest() {}, isAllTemporarilyUnavailable: options.classifyFail ? boom : () => ({ allUnavailable: false }),
    isAllRateLimited: () => ({ allLimited: false }), isLsPoolExhausted: () => false,
    isUpstreamDeadlineExceeded: () => false, isCascadeTransportError: () => false,
    upstreamTransientErrorMessage: () => 'transient', upstreamDeadlineExceededMessage: () => 'deadline',
    sanitizeText: x => x, poolCheckin() {}, ttlHintFromCachePolicy() {},
    pathStreamText: { flush() { visited.push('egress'); if (options.pathFail) boom(); return ''; } },
    thinkClassifier: { flush() { visited.push('think'); return ''; } },
    reasoningDedup: { release() { visited.push('dedup'); if (options.dedupFail) boom(); return ''; } },
    // The stop gate is owned outside this extracted continuation; real handler tests cover its bytes.
    flushContentGate: options.gateFail ? boom : () => {},
    shouldFallbackThinkingToText: () => false, finishPartialStreamAfterError: options.helperFail ? boom : finishPartialStreamAfterError,
    chatStreamError: (message, type, code) => ({ error: { message, type, code } }),
  };
  new Function(...Object.keys(deps), `
    let emittedClientPayload = !!options.partial, accThinking = '', accText = '';
    const send = frame => res.write('data: ' + JSON.stringify(frame) + '\\n\\n');
    const emitContent = text => { emittedClientPayload = true; send({ content: text }); };
    const emitThinking = emitContent;
    ${block}
  `)(...Object.values(deps));
  return { warnings, fallback, writes, visited, res };
}
const done = r => r.writes.filter(x => x === 'data: [DONE]\n\n').length;

test('R4 an error-frame-only write failure still writes DONE and one diagnostic warn', () => {
  const r = run({ errorWrite: true });
  assert.equal(done(r), 1, 'DONE is independent of error-frame delivery');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /stage=error-frame/);
  assert.doesNotMatch(r.warnings.join(''), /sensitive-token-in-error/);
  assert.equal(r.res.writableEnded, true);
});

test('R4 a broken warning logger uses the fallback sink without blocking DONE', () => {
  const r = run({ errorWrite: true, logWarnFail: true });
  assert.equal(done(r), 1); assert.equal(r.fallback.length, 1);
  assert.match(r.fallback[0], /stage=error-frame.*logger=failed/);
});

test('R4 a failed DONE write does not erase the error frame or skip end', () => {
  const r = run({ doneWrite: true });
  assert.ok(r.writes.some(x => x.includes('"error"')));
  assert.match(r.warnings.join(''), /stage=done/);
  assert.equal(r.res.writableEnded, true);
});

test('R4 a flush failure does not suppress other flushes, the error frame or DONE', () => {
  const r = run({ pathFail: true });
  assert.deepEqual(r.visited, ['egress', 'think']);
  assert.ok(r.writes.some(x => x.includes('"error"'))); assert.equal(done(r), 1);
  assert.match(r.warnings.join(''), /stage=egress-tail/);
});

test('R4 a failed held tail or synthetic finish cannot prevent partial DONE', () => {
  for (const flags of [{ dedupFail: true }, { finishWrite: true }, { helperFail: true }]) {
    const r = run({ partial: true, internal: true, ...flags });
    assert.equal(done(r), 1);
    assert.equal(r.writes.some(x => x.includes('"error"')), false);
    assert.match(r.warnings.join(''), /stage=(dedup-tail|finish-frame)/);
  }
});

test('R4 synthetic finish markers remain internal-only and successful termination is single-shot', () => {
  for (const internal of [false, true]) {
    const r = run({ partial: true, internal });
    const finish = JSON.parse(r.writes[0].slice(6));
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.equal(Object.hasOwn(finish, '__synthetic_finish'), internal);
    assert.equal(done(r), 1);
  }
});

test('R4 classification and ordinary error logging cannot block terminal delivery', () => {
  for (const flags of [{ classifyFail: true }, { logErrorFail: true }]) {
    const r = run(flags);
    assert.equal(done(r), 1);
    assert.equal(r.res.writableEnded, true);
    assert.equal(r.warnings.length, 1);
  }
});

test('R4 end failures are diagnosed rather than escaping the finalizer', () => {
  const r = run({ endFail: true });
  assert.equal(done(r), 1); assert.match(r.warnings.join(''), /stage=end/);
});

test('R4 a stop-gate flush failure still delivers the error frame and DONE', () => {
  const r = run({ gateFail: true });
  assert.equal(done(r), 1);
  assert.ok(r.writes.some(x => x.includes('"error"')));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /stage=content-gate-tail/);
  assert.equal(r.res.writableEnded, true);
});
