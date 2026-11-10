// FIX-CLOUD-1 — DEVIN_CONNECT catalog fixes (audit items A7 / A8 / A13).
//
// A7  Rate table dual-source: target servers reserve PlanInfo#21 and carry the
//     per-model table on UserStatus#33 (cascade_model_config_data →
//     client_model_configs[] with model_uid #22 + credit_multiplier #3, float);
//     the #21 read stays as the fallback for older servers. Both shapes must
//     decode to a non-empty rate table.
// A8  AssignModelRequest.cascade_id (#3) is required upstream — every request
//     body must carry it (empty-but-present when the cascade is unknown).
// A13 PlanStatus#17/#18 are the daily/weekly quota reset timestamps, not a
//     billing period; the decoder surfaces them as dailyQuotaResetAt /
//     weeklyQuotaResetAt (periodStart/periodEnd remain as deprecated aliases
//     for existing consumers).
//
// Fixtures are synthetic protobuf built with the src/proto.js writers.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  decodeUserStatusFull,
  encodeAssignModelRequest,
  assignModel,
  parseAssignTags,
  __setCatalogRequestImpl,
} from '../src/devin-connect-catalog.js';
import {
  writeStringField,
  writeMessageField,
  writeVarintField,
  writeFixed32Field,
  parseFields,
} from '../src/proto.js';

afterEach(() => { __setCatalogRequestImpl(null); });

// ── fixture builders ────────────────────────────────────────────────────────

/** f32 value → fixed32 payload buffer. */
function f32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeFloatLE(value, 0);
  return b;
}

/**
 * Target shape: UserStatus#33 = cascade_model_config_data {
 *   client_model_configs[] = { model_uid #22, credit_multiplier #3 (f32) } }.
 */
function buildCascadeModelConfigData(entries) {
  const configs = entries.map(({ selector, credit }) => {
    const fields = [writeStringField(22, selector)];
    if (credit != null) fields.push(writeFixed32Field(3, f32(credit)));
    return writeMessageField(1, Buffer.concat(fields));
  });
  return writeMessageField(33, Buffer.concat(configs));
}

/**
 * Legacy shape: PlanStatus#1 = plan_info { plan_name #2,
 * cascade_allowed_models_config #21[] = { credit_multiplier #2 (f32) } }.
 */
function buildLegacyPlan({ name = 'Teams', rates = [] } = {}) {
  const fields = [writeStringField(2, name)];
  for (const r of rates) fields.push(writeMessageField(21, writeFixed32Field(2, f32(r))));
  return writeMessageField(1, Buffer.concat(fields));
}

/** GetUserStatusResponse#1 = user_status { ...fields }. */
function buildUserStatusResponse(userStatusFields) {
  return writeMessageField(1, Buffer.concat(userStatusFields));
}

/** AssignModelResponse#1 = assignment { assignment_jwt #1, model_uid #2, harness #3 }. */
function buildAssignResponse({ modelUid, jwt, harness = [] } = {}) {
  const inner = [];
  if (jwt != null) inner.push(writeStringField(1, jwt));
  if (modelUid != null) inner.push(writeStringField(2, modelUid));
  for (const h of harness) inner.push(writeStringField(3, h));
  return writeMessageField(1, Buffer.concat(inner));
}

describe('A7 — rate table dual-source (UserStatus#33 with PlanInfo#21 fallback)', () => {
  it('decodes the rate table from the target shape (#33, no #21)', () => {
    const response = buildUserStatusResponse([
      buildCascadeModelConfigData([
        { selector: 'claude-opus-4-8-medium', credit: 25 },
        { selector: 'claude-sonnet-5-medium', credit: 6 },
      ]),
    ]);
    const result = decodeUserStatusFull(response);
    assert.ok(result.rateTable && !Array.isArray(result.rateTable),
      'target-shape rate table must decode to a selector-keyed object');
    assert.equal(Object.keys(result.rateTable).length, 2);
    assert.equal(result.rateTable['claude-opus-4-8-medium'], 25);
    assert.equal(result.rateTable['claude-sonnet-5-medium'], 6);
  });

  it('keeps decoding the legacy shape (#21) as the fallback', () => {
    const response = buildUserStatusResponse([
      writeMessageField(13, buildLegacyPlan({ rates: [25, 50] })),
    ]);
    const unpaired = decodeUserStatusFull(response);
    assert.ok(Array.isArray(unpaired.rateTable) && unpaired.rateTable.length === 2,
      'legacy table must stay non-empty without a catalog');
    assert.equal(unpaired.rateTable[0], 25);

    const paired = decodeUserStatusFull(response, [{ selector: 'a' }, { selector: 'b' }]);
    assert.equal(paired.rateTable['a'], 25);
    assert.equal(paired.rateTable['b'], 50);
  });

  it('prefers the #33 table when both shapes are present', () => {
    const response = buildUserStatusResponse([
      buildCascadeModelConfigData([{ selector: 'new-model', credit: 1 }]),
      writeMessageField(13, buildLegacyPlan({ rates: [25] })),
    ]);
    const result = decodeUserStatusFull(response);
    assert.deepEqual(result.rateTable, { 'new-model': 1 });
  });
});

describe('A8 — AssignModelRequest.cascade_id (#3, required upstream)', () => {
  it('writes cascade_id as an empty-but-present field by default', () => {
    const body = encodeAssignModelRequest('adaptive');
    const f3 = parseFields(body).find((x) => x.field === 3 && x.wireType === 2);
    assert.ok(f3, 'cascade_id (#3) must be present on every request body');
    assert.equal(f3.value.toString('utf8'), '', 'unknown cascade → empty string');
  });

  it('writes the caller-provided cascade id at #3', () => {
    const body = encodeAssignModelRequest('adaptive', parseAssignTags({}), 'cascade-123');
    const f3 = parseFields(body).find((x) => x.field === 3 && x.wireType === 2);
    assert.ok(f3, 'cascade_id (#3) must be present');
    assert.equal(f3.value.toString('utf8'), 'cascade-123');
  });

  it('assignModel carries the cascade id into the request body', async () => {
    const captured = {};
    __setCatalogRequestImpl((_opts, cb) => {
      const req = new EventEmitter();
      const res = new EventEmitter();
      res.statusCode = 200;
      req.write = () => {};
      req.destroy = () => {};
      req.end = (body) => {
        captured.body = body;
        setImmediate(() => {
          cb(res);
          res.emit('data', buildAssignResponse({ modelUid: 'resolved-model', jwt: 'jwt-1' }));
          res.emit('end');
          req.emit('close'); // unaryCall clears its guard timer on 'close'
        });
      };
      return req;
    });
    const asg = await assignModel({
      token: 'devin-session-token$fix-cloud-1',
      modelUid: 'adaptive',
      cascadeId: 'cascade-42',
      env: {},
    });
    assert.equal(asg.model_uid, 'resolved-model');
    const fields = parseFields(captured.body);
    assert.equal(fields.find((x) => x.field === 2 && x.wireType === 2)?.value.toString('utf8'), 'adaptive');
    assert.equal(fields.find((x) => x.field === 3 && x.wireType === 2)?.value.toString('utf8'), 'cascade-42');
  });
});

describe('A13 — quota reset timestamps (PlanStatus#17/#18)', () => {
  it('surfaces #17/#18 as dailyQuotaResetAt / weeklyQuotaResetAt', () => {
    const response = buildUserStatusResponse([
      writeMessageField(13, Buffer.concat([
        writeVarintField(17, 1783411200),
        writeVarintField(18, 1783843200),
      ])),
    ]);
    const result = decodeUserStatusFull(response);
    assert.equal(result.dailyQuotaResetAt, 1783411200 * 1000);
    assert.equal(result.weeklyQuotaResetAt, 1783843200 * 1000);
  });

  it('returns null for both when the response carries no reset timestamps', () => {
    const result = decodeUserStatusFull(Buffer.alloc(0));
    assert.equal(result.dailyQuotaResetAt, null);
    assert.equal(result.weeklyQuotaResetAt, null);
  });
});
