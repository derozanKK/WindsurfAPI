// Regression: the native ToolDef path must never emit a JSON Schema `type`
// ARRAY. Upstream's decoder rejects the whole chat request with
// `invalid_argument` when a tool parameter schema carries `"type": ["x","null"]`
// (reproduced live with the omp grep `skip` parameter, which is
// `type: ["number","null"]`). JSON Schema's lossless equivalent is an `anyOf`
// of single-type members; upstream accepts `anyOf` (verified control).
//
// These tests are deliberately independent of any live account: the fixture
// schemas are synthetic / public tool shapes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToolSchema,
  buildGetChatMessageRequest,
} from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import { validateJsonSchema } from '../src/json-schema.js';

const TOKEN = 'devin-session-token$test.jwt.sig';

// Collect every `type` ARRAY anywhere in a normalized schema. A lowered schema
// must produce none.
function collectTypeArrays(value, path = '$', hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectTypeArrays(item, `${path}[${i}]`, hits));
    return hits;
  }
  if (!value || typeof value !== 'object') return hits;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'type' && Array.isArray(child)) hits.push(`${path}.type`);
    collectTypeArrays(child, `${path}.${key}`, hits);
  }
  return hits;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

// The real omp grep shape (public tool), trimmed to the parameters that matter.
function grepLikeSchema() {
  return {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'regex' },
      skip: { type: ['number', 'null'], description: 'lines to skip' },
      head_limit: { type: ['number', 'null'], default: null },
    },
    required: ['pattern'],
    additionalProperties: false,
  };
}

describe('native ToolDef: JSON Schema type arrays are lowered to anyOf', () => {
  it('lowers the omp grep skip shape (number|null) and preserves siblings', () => {
    const r = normalizeToolSchema(grepLikeSchema());
    assert.deepEqual(r.properties.skip.anyOf, [{ type: 'number' }, { type: 'null' }]);
    assert.equal(r.properties.skip.type, undefined, 'no type array survives');
    assert.equal(r.properties.skip.description, undefined, 'annotation still stripped');
    assert.deepEqual(r.properties.head_limit.anyOf, [{ type: 'number' }, { type: 'null' }]);
    assert.equal(r.properties.head_limit.default, null, 'non-type fields preserved');
    assert.deepEqual(r.required, ['pattern']);
    assert.equal(r.additionalProperties, false);
    assert.deepEqual(collectTypeArrays(r), []);
  });

  it('lowers a null-first union without reordering members', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: { n: { type: ['null', 'integer'] } },
    });
    assert.deepEqual(r.properties.n.anyOf, [{ type: 'null' }, { type: 'integer' }]);
  });

  it('lowers non-null multi-type unions', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: { id: { type: ['string', 'number'] } },
    });
    assert.deepEqual(r.properties.id.anyOf, [{ type: 'string' }, { type: 'number' }]);
    assert.deepEqual(collectTypeArrays(r), []);
  });

  it('keeps an existing anyOf and ANDs the lowered union in via allOf', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: {
        v: {
          type: ['string', 'null'],
          anyOf: [{ type: 'string', minLength: 1 }, { type: 'integer' }],
        },
      },
    });
    assert.deepEqual(r.properties.v.anyOf, [
      { type: 'string', minLength: 1 },
      { type: 'integer' },
    ], 'the caller anyOf is untouched');
    assert.deepEqual(r.properties.v.allOf, [
      { anyOf: [{ type: 'string' }, { type: 'null' }] },
    ], 'the lowered union still constrains the value');
    assert.equal(r.properties.v.type, undefined);
    assert.deepEqual(collectTypeArrays(r), []);
  });

  it('keeps oneOf/allOf and adds the lowered anyOf alongside them', () => {
    const oneOf = normalizeToolSchema({
      type: 'object',
      properties: { v: { type: ['string', 'null'], oneOf: [{ type: 'string' }, { type: 'integer' }] } },
    });
    assert.deepEqual(oneOf.properties.v.oneOf, [{ type: 'string' }, { type: 'integer' }]);
    assert.deepEqual(oneOf.properties.v.anyOf, [{ type: 'string' }, { type: 'null' }]);

    const allOf = normalizeToolSchema({
      type: 'object',
      properties: { v: { type: ['string', 'null'], allOf: [{ type: 'string' }] } },
    });
    assert.deepEqual(allOf.properties.v.allOf, [{ type: 'string' }], 'existing allOf untouched');
    assert.deepEqual(allOf.properties.v.anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.deepEqual(collectTypeArrays(allOf), []);
  });

  it('recurses through items, additionalProperties, and combinator variants', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: ['string', 'null'] } },
        bag: { type: 'object', additionalProperties: { type: ['integer', 'null'] } },
        choice: {
          oneOf: [
            { type: ['string', 'null'] },
            { type: 'object', properties: { deep: { type: ['boolean', 'null'] } } },
          ],
        },
      },
    });
    assert.deepEqual(r.properties.list.items.anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.deepEqual(r.properties.bag.additionalProperties.anyOf, [{ type: 'integer' }, { type: 'null' }]);
    assert.deepEqual(r.properties.choice.oneOf[0].anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.deepEqual(r.properties.choice.oneOf[1].properties.deep.anyOf, [{ type: 'boolean' }, { type: 'null' }]);
    assert.deepEqual(collectTypeArrays(r), []);
  });

  it('does not mutate a deeply frozen caller schema', () => {
    const src = deepFreeze({
      type: 'object',
      properties: {
        skip: { type: ['number', 'null'] },
        list: { type: 'array', items: { type: ['string', 'null'] } },
      },
    });
    const r = normalizeToolSchema(src);
    assert.deepEqual(src.properties.skip.type, ['number', 'null'], 'caller keeps its array');
    assert.deepEqual(r.properties.skip.anyOf, [{ type: 'number' }, { type: 'null' }]);
  });

  it('preserves parameters literally named description/type/properties', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: {
        description: { type: ['string', 'null'], enum: ['short', 'long'] },
        type: { type: 'string' },
        properties: { type: ['string', 'null'] },
      },
      required: ['description'],
    });
    assert.deepEqual(r.properties.description.anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.deepEqual(r.properties.description.enum, ['short', 'long']);
    assert.equal(r.properties.type.type, 'string', 'a parameter named type is not a keyword');
    assert.deepEqual(r.properties.properties.anyOf, [{ type: 'string' }, { type: 'null' }],
      'a parameter named properties still has its schema lowered');
    assert.deepEqual(r.required, ['description']);
    assert.deepEqual(collectTypeArrays(r), []);
  });

  it('is byte-identical for a schema without type arrays (fast path)', () => {
    const src = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] };
    assert.equal(
      JSON.stringify(normalizeToolSchema(src)),
      '{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"integer"}},"required":["a"]}',
    );
    // A parameter literally named "properties" must not change the pre-existing
    // description behavior either (its annotation was always preserved).
    const named = { type: 'object', properties: { properties: { type: 'string', description: 'param hint' } } };
    assert.equal(
      JSON.stringify(normalizeToolSchema(named)),
      '{"type":"object","properties":{"properties":{"type":"string","description":"param hint"}}}',
    );
  });

  it('does not reject or rewrite a malformed type array', () => {
    const r = normalizeToolSchema({
      type: 'object',
      properties: { bad: { type: ['string', 42] } },
    });
    assert.deepEqual(r.properties.bad.type, ['string', 42]);
  });

  it('does not lower type-array keys inside literal values', () => {
    // default/examples/enum are caller DATA, not schemas; a `type` key inside
    // them is a literal and must survive verbatim.
    const r = normalizeToolSchema({
      type: 'object',
      properties: {
        x: { type: 'string', default: { type: ['a', 'b'], keep: 1 } },
        y: { type: 'string', examples: [{ type: ['c'] }] },
        z: { type: 'string', enum: [{ type: ['d'] }] },
      },
    });
    assert.deepEqual(r.properties.x.default, { type: ['a', 'b'], keep: 1 });
    assert.deepEqual(r.properties.y.examples, [{ type: ['c'] }]);
    assert.deepEqual(r.properties.z.enum, [{ type: ['d'] }]);
  });

  it('keeps NESTED objects inside literal values untouched (sticky literal context)', () => {
    // Regression from VERIFY-UNION probe-adversarial G4: literal context must
    // survive array recursion and every deeper object, or `enum`/`const` values
    // stop matching themselves and value acceptance changes.
    const r = normalizeToolSchema({
      type: 'object',
      properties: {
        x: {
          type: 'string',
          default: { inner: { type: ['a', 'b'] } },
          enum: [{ inner: { type: ['a', 'b'] } }],
          const: { inner: { type: ['a', 'b'] } },
          examples: [{ properties: { p: { type: ['a', 'b'] } } }],
        },
      },
    });
    assert.deepEqual(r.properties.x.default, { inner: { type: ['a', 'b'] } });
    assert.deepEqual(r.properties.x.enum, [{ inner: { type: ['a', 'b'] } }]);
    assert.deepEqual(r.properties.x.const, { inner: { type: ['a', 'b'] } });
    assert.deepEqual(r.properties.x.examples, [{ properties: { p: { type: ['a', 'b'] } } }]);
  });

  it('literal acceptance is unchanged (enum/const values still match)', () => {
    const value = { z: { inner: { type: ['a', 'b'] } } };
    for (const key of ['enum', 'const']) {
      const original = { type: 'object', properties: { z: { [key]: { inner: { type: ['a', 'b'] } } } } };
      const normalized = normalizeToolSchema(original);
      const before = validateJsonSchema(value, original);
      const after = validateJsonSchema(value, normalized);
      assert.equal(before.ok, true, `${key}: precondition`);
      assert.equal(after.ok, before.ok, `${key}: original=${before.ok}, normalized=${after.ok}`);
    }
  });

  it('wire: the emitted ToolDef parameters decode without any type array', () => {
    const tool = {
      type: 'function',
      function: { name: 'grep', description: 'search', parameters: grepLikeSchema() },
    };
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      env: { DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3' },
    });
    const toolFields = getAllFields(parseFields(proto), 10).filter((f) => f.wireType === 2);
    assert.equal(toolFields.length, 1, 'one ToolDef emitted at #10');
    const td = parseFields(toolFields[0].value);
    assert.equal(getField(td, 1, 2).value.toString('utf8'), 'grep');
    const params = JSON.parse(getField(td, 3, 2).value.toString('utf8'));
    assert.deepEqual(collectTypeArrays(params), [], 'no type array crosses the wire');
    assert.deepEqual(params.properties.skip.anyOf, [{ type: 'number' }, { type: 'null' }]);
  });
});

// The lowering must accept exactly the values the original schema accepted.
// `validateJsonSchema` is the repo's own bounded validator and it understands
// BOTH spellings (`type` arrays and anyOf/allOf), so it can decide the two
// schemas on the same value matrix. This is the proof for the collision case:
// an existing anyOf is preserved and ANDed with the lowered union, not merged
// by overwriting either side.
describe('native ToolDef: type-array lowering preserves acceptance', () => {
  const cases = [
    ['grep skip (number|null)', {
      type: 'object',
      properties: { skip: { type: ['number', 'null'] } },
    }, [{ skip: 0 }, { skip: 3.5 }, { skip: null }, { skip: 'x' }, { skip: true }, {}, { skip: 0, extra: 1 }]],

    ['null-first (null|integer)', {
      type: 'object',
      properties: { n: { type: ['null', 'integer'] } },
    }, [{ n: 0 }, { n: 1.5 }, { n: null }, { n: 'x' }, {}]],

    ['type array + existing anyOf (intersection)', {
      type: 'object',
      properties: {
        v: {
          type: ['string', 'null'],
          anyOf: [{ type: 'string', minLength: 2 }, { type: 'integer', minimum: 5 }],
        },
      },
    }, [{ v: 'ab' }, { v: 'a' }, { v: 7 }, { v: 3 }, { v: null }, { v: true }, {}]],

    ['type array + existing oneOf', {
      type: 'object',
      properties: {
        v: {
          type: ['string', 'null'],
          oneOf: [{ type: 'string', minLength: 2 }, { type: 'string', maxLength: 1 }],
        },
      },
    }, [{ v: 'ab' }, { v: 'a' }, { v: 'abc' }, { v: null }, { v: 5 }, {}]],

    ['type array + existing allOf', {
      type: 'object',
      properties: {
        v: { type: ['number', 'null'], allOf: [{ type: 'number', minimum: 3 }] },
      },
    }, [{ v: 5 }, { v: 1 }, { v: 2.5 }, { v: null }, { v: 'x' }, {}]],

    ['type array through items', {
      type: 'object',
      properties: { list: { type: 'array', items: { type: ['string', 'null'] } } },
    }, [{ list: ['a', null] }, { list: [1] }, { list: [] }, { list: 'x' }, {}]],
  ];

  for (const [name, original, values] of cases) {
    it(`matches the original schema on every value: ${name}`, () => {
      const normalized = normalizeToolSchema(original);
      assert.deepEqual(collectTypeArrays(normalized), [], 'normalized schema has no type array');
      for (const value of values) {
        const before = validateJsonSchema(value, original);
        const after = validateJsonSchema(value, normalized);
        assert.equal(
          after.ok,
          before.ok,
          `${JSON.stringify(value)}: original=${before.ok}${before.ok ? '' : ` (${before.message})`}, normalized=${after.ok}${after.ok ? '' : ` (${after.message})`}`,
        );
      }
    });
  }
});
