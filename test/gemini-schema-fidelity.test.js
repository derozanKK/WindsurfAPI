// A4 — Gemini schema fidelity for the three shapes the absorption report
// names. The question is what the proxy does with a schema that Gemini's
// `parameters` carrier cannot express losslessly:
//
//   (a) oneOf: [integer, number] — the value 1 satisfies BOTH branches, so a
//       strict JSON-Schema validator rejects it. Does the proxy project it?
//   (b) allOf — does it intersect/flatten the branches (the lossy behaviour
//       the report measured elsewhere), or preserve them?
//   (c) numeric enum — are values converted to strings (Gemini's own Schema
//       enum is string-typed), or preserved as numbers?
//
// WindsurfAPI has no tight/rich carrier switch: geminiToOpenAI forwards
// `parameters` or `parametersJsonSchema` to the JSON-Schema path, and the
// upstream encoder's normalizeToolSchema fixes only the envelope (root
// combinators, object/properties/required, description annotations). These
// tests are CHARACTERIZATION tests: they pin the current, exact-preserving
// behaviour and the one deliberate root-level loss. They pass on e3e39d9.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geminiToOpenAI } from '../src/handlers/gemini.js';
import { normalizeToolSchema } from '../src/devin-connect.js';
import {
  buildSchemaCompactToolPreambleForProto,
  buildSkinnyToolPreambleForProto,
} from '../src/handlers/tool-emulation.js';

function geminiBody(schema, carrier = 'parametersJsonSchema') {
  return {
    contents: [{ role: 'user', parts: [{ text: 'use the tool' }] }],
    tools: [{ functionDeclarations: [{ name: 'f', description: 'demo', [carrier]: schema }] }],
  };
}

// The frontend conversion (Gemini → internal OpenAI tools).
function converted(schema, carrier) {
  return geminiToOpenAI(geminiBody(schema, carrier), 'gemini-3-pro').tools[0].function.parameters;
}

// The schema the upstream encoder puts on the wire (devin-connect path).
function onWire(schema, carrier) {
  return normalizeToolSchema(converted(schema, carrier));
}

describe('A4(a) — oneOf: [integer, number] is preserved, not projected', () => {
  const schema = {
    type: 'object',
    properties: { n: { oneOf: [{ type: 'integer' }, { type: 'number' }] } },
    required: ['n'],
  };

  it('parametersJsonSchema: both variants reach the wire verbatim', () => {
    const out = onWire(structuredClone(schema));
    assert.deepEqual(out.properties.n, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
    assert.equal(out.properties.n.type, undefined, 'no projection to a single type');
    assert.equal(out.oneOf, undefined, 'the combinator is not hoisted to the root');
  });

  it('Gemini Schema carrier: UPPERCASE types are normalized, the combinator is kept', () => {
    const out = onWire({
      type: 'OBJECT',
      properties: { n: { oneOf: [{ type: 'INTEGER' }, { type: 'NUMBER' }] } },
    }, 'parameters');
    assert.deepEqual(out.properties.n, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
  });

  it('DECISION: the proxy does not choose a branch for the ambiguous value 1', () => {
    // 1 is an integer and a number, so `oneOf` is unsatisfiable for it under a
    // strict validator. The proxy preserves the client's exact schema instead
    // of guessing a projection; any rejection is the upstream's semantics.
    const out = onWire(structuredClone(schema));
    assert.equal(out.properties.n.oneOf.length, 2);
    assert.deepEqual(out.properties.n.oneOf.map((v) => v.type), ['integer', 'number']);
  });
});

describe('A4(b) — allOf is preserved (no intersection/flattening)', () => {
  it('property-level allOf keeps both branches and both numeric constraints', () => {
    const out = onWire({
      type: 'object',
      properties: {
        x: { allOf: [{ type: 'number', minimum: 0 }, { type: 'number', maximum: 10 }] },
      },
    });
    assert.deepEqual(out.properties.x, {
      allOf: [{ type: 'number', minimum: 0 }, { type: 'number', maximum: 10 }],
    });
    assert.equal(out.properties.x.minimum, undefined, 'branches are not flattened first-wins');
    assert.equal(out.properties.x.maximum, undefined);
  });

  it('same-name properties in two object branches stay two branches', () => {
    const branchA = { type: 'object', properties: { x: { type: 'number', minimum: 0 } } };
    const branchB = { type: 'object', properties: { x: { type: 'number', maximum: 10 } } };
    const out = onWire({
      type: 'object',
      properties: { box: { allOf: [branchA, branchB] } },
    });
    assert.equal(out.properties.box.allOf.length, 2);
    assert.deepEqual(out.properties.box.allOf[0].properties.x, { type: 'number', minimum: 0 });
    assert.deepEqual(out.properties.box.allOf[1].properties.x, { type: 'number', maximum: 10 });
  });

  it('CHARACTERIZATION: a ROOT allOf is stripped and the first object variant wins', () => {
    // Deliberate loss, not a fidelity regression: the upstream rejects a tool
    // parameters schema whose ROOT is a combinator. normalizeToolSchema removes
    // it and recovers properties/required from the first type:'object' variant.
    // Nested allOf (above) is untouched.
    const out = onWire({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    });
    assert.equal(out.allOf, undefined, 'root combinator removed');
    assert.deepEqual(out.properties, { a: { type: 'string' } }, 'first object variant recovered');
    assert.deepEqual(out.required, ['a']);
    assert.equal(out.properties.b, undefined, 'later variants are lost at the root — documented');
  });
});

describe('A4(c) — numeric enum values stay numbers', () => {
  it('parametersJsonSchema: [1,2] is not stringified and the type is untouched', () => {
    const out = onWire({
      type: 'object',
      properties: { mode: { type: 'integer', enum: [1, 2] } },
    });
    assert.deepEqual(out.properties.mode, { type: 'integer', enum: [1, 2] });
    assert.equal(typeof out.properties.mode.enum[0], 'number');
    assert.equal(typeof out.properties.mode.enum[1], 'number');
  });

  it('mixed enum ["a",1] keeps each value\'s JSON type', () => {
    const out = onWire({
      type: 'object',
      properties: { mixed: { type: 'string', enum: ['a', 1] } },
    });
    assert.deepEqual(out.properties.mixed.enum, ['a', 1]);
    assert.equal(typeof out.properties.mixed.enum[1], 'number');
  });

  it('Gemini Schema carrier: type INTEGER is lowercased but enum values are not coerced', () => {
    const out = onWire({
      type: 'OBJECT',
      properties: { mode: { type: 'INTEGER', enum: [1, 2] } },
    }, 'parameters');
    assert.deepEqual(out.properties.mode, { type: 'integer', enum: [1, 2] });
  });
});

describe('A4 — prompt-emulation tiers (tool-emulation.js)', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'f',
      description: 'demo',
      parameters: {
        type: 'object',
        properties: {
          n: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
          x: { allOf: [{ type: 'number', minimum: 0 }, { type: 'number', maximum: 10 }] },
          mode: { type: 'integer', enum: [1, 2] },
        },
      },
    },
  }];

  it('compact tier: oneOf and numeric enum are exact; allOf branches keep only whitelisted keys', () => {
    const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto', '');
    const line = preamble.split('\n').find((l) => l.startsWith('Params: '));
    assert.ok(line, 'the compact tier emitted a Params line');
    const compact = JSON.parse(line.slice('Params: '.length));

    assert.deepEqual(compact.properties.n, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
    assert.deepEqual(compact.properties.mode, { type: 'integer', enum: [1, 2] });
    assert.equal(typeof compact.properties.mode.enum[0], 'number');
    // Deliberate loss: the compact tier keeps a schema-key whitelist
    // (type/enum/properties/items/required/oneOf/anyOf/allOf/const/format/
    // additionalProperties). The allOf STRUCTURE survives; minimum/maximum do
    // not. This is a prompt representation, not the wire schema — the wire path
    // above preserves both constraints.
    assert.deepEqual(compact.properties.x, { allOf: [{ type: 'number' }, { type: 'number' }] });
    assert.equal(line.includes('minimum'), false);
    assert.equal(line.includes('maximum'), false);
  });

  it('skinny tier: numeric enum renders as numbers; oneOf/allOf collapse to `any`', () => {
    const preamble = buildSkinnyToolPreambleForProto(tools, 'auto', '');
    const line = preamble.split('\n').find((l) => l.startsWith('- f('));
    assert.ok(line, 'the skinny tier emitted a signature line');
    assert.match(line, /mode\?: 1\|2/, 'numeric enum values are numbers, not "1"|"2"');
    assert.match(line, /n\?: any/, 'oneOf detail is dropped by this deliberately lossy tier');
    assert.match(line, /x\?: any/, 'allOf detail is dropped by this deliberately lossy tier');
  });
});
