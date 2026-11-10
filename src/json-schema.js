/**
 * A bounded, dependency-free JSON Schema validator.
 *
 * Why this exists: `response_format: {type:'json_schema'}` (and Anthropic's
 * `output_config.format`) is a promise to the caller that the body conforms to
 * its schema. This proxy cannot make the model obey — the upstream has no such
 * control — so the honest thing is to CHECK the answer and say so when it does
 * not hold. Before this module the code only "stabilised" the payload by
 * projecting it onto the requested key names, inventing `null`/`true` for keys
 * the model never produced (KH-013).
 *
 * Scope, deliberately: the keyword subset real callers actually ship —
 * type/enum/const, object properties/required/additionalProperties, array
 * items/minItems/maxItems/uniqueItems, string min/maxLength/pattern, numeric
 * bounds, and the anyOf/oneOf/allOf/not combinators, plus local `$ref`
 * (`#/$defs/...`, `#/definitions/...`). Unknown keywords are IGNORED, which is
 * exactly what the JSON Schema spec requires of an implementation that does not
 * know an annotation — it must never turn "I don't understand this" into a
 * failure.
 *
 * A `$ref` cycle is not followed: the depth guard reports non-conformance for a
 * schema that cannot be evaluated rather than looping forever.
 */

const MAX_REF_DEPTH = 32;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, wanted) {
  switch (wanted) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // an unknown type name is an annotation we cannot judge
  }
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  const path = ref.slice(1).replace(/^\//, '');
  if (!path) return root;
  let cur = root;
  for (const rawPart of path.split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * @returns {{ok: true} | {ok: false, path: string, message: string}}
 */
export function validateJsonSchema(value, schema, { path = '$', root = schema, depth = 0 } = {}) {
  if (schema === undefined || schema === true || schema === null) return { ok: true };
  if (schema === false) return { ok: false, path, message: 'no value is allowed here' };
  if (!isPlainObject(schema)) return { ok: true };
  if (depth > MAX_REF_DEPTH) {
    return { ok: false, path, message: 'schema $ref nesting is too deep to evaluate' };
  }

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (target === undefined) return { ok: false, path, message: `unresolvable schema reference ${schema.$ref}` };
    const viaRef = validateJsonSchema(value, target, { path, root, depth: depth + 1 });
    if (!viaRef.ok) return viaRef;
  }

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    // OpenAPI's `nullable` is an annotation on a typed schema; honour it so a
    // schema written for a different toolchain is not rejected for a reason the
    // caller never wrote down.
    const allowNull = schema.nullable === true && value === null;
    if (!allowNull && !wanted.some((t) => matchesType(value, t))) {
      return {
        ok: false,
        path,
        message: `expected ${wanted.join(' | ')}, got ${typeOf(value)}`,
      };
    }
  }

  if (Array.isArray(schema.enum)) {
    const hit = schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
    if (!hit) return { ok: false, path, message: `must be one of ${JSON.stringify(schema.enum)}` };
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (JSON.stringify(schema.const) !== JSON.stringify(value)) {
      return { ok: false, path, message: `must equal ${JSON.stringify(schema.const)}` };
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, path, message: `must be >= ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, path, message: `must be <= ${schema.maximum}` };
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return { ok: false, path, message: `must be > ${schema.exclusiveMinimum}` };
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return { ok: false, path, message: `must be < ${schema.exclusiveMaximum}` };
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        return { ok: false, path, message: `must be a multiple of ${schema.multipleOf}` };
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { ok: false, path, message: `must be at least ${schema.minLength} characters` };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { ok: false, path, message: `must be at most ${schema.maxLength} characters` };
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try { re = new RegExp(schema.pattern); } catch { re = null; }
      // An unparseable pattern is an annotation we cannot judge, not a failure.
      if (re && !re.test(value)) return { ok: false, path, message: `must match ${schema.pattern}` };
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return { ok: false, path, message: `must have at least ${schema.minItems} items` };
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return { ok: false, path, message: `must have at most ${schema.maxItems} items` };
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) return { ok: false, path, message: 'items must be unique' };
    }
    const itemSchemas = Array.isArray(schema.items) ? schema.items : null;
    if (itemSchemas) {
      for (let i = 0; i < value.length; i++) {
        const sub = itemSchemas[i] ?? schema.additionalItems;
        if (sub === undefined) continue;
        const r = validateJsonSchema(value[i], sub, { path: `${path}[${i}]`, root, depth: depth + 1 });
        if (!r.ok) return r;
      }
    } else if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const r = validateJsonSchema(value[i], schema.items, { path: `${path}[${i}]`, root, depth: depth + 1 });
        if (!r.ok) return r;
      }
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : null;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          return { ok: false, path, message: `missing required property "${key}"` };
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const own = props && Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
      const sub = own !== undefined ? own : schema.additionalProperties;
      const childPath = `${path}.${key}`;
      if (sub === false) return { ok: false, path: childPath, message: 'additional properties are not allowed' };
      if (sub !== undefined) {
        const r = validateJsonSchema(child, sub, { path: childPath, root, depth: depth + 1 });
        if (!r.ok) return r;
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const r = validateJsonSchema(value, sub, { path, root, depth: depth + 1 });
      if (!r.ok) return r;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const results = schema.anyOf.map((sub) => validateJsonSchema(value, sub, { path, root, depth: depth + 1 }));
    if (!results.some((r) => r.ok)) {
      return { ok: false, path, message: `does not match any allowed shape (${results.map((r) => r.message).join('; ')})` };
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const results = schema.oneOf.map((sub) => validateJsonSchema(value, sub, { path, root, depth: depth + 1 }));
    const passed = results.filter((r) => r.ok).length;
    if (passed !== 1) {
      return { ok: false, path, message: `must match exactly one allowed shape, matched ${passed}` };
    }
  }
  if (schema.not !== undefined) {
    const r = validateJsonSchema(value, schema.not, { path, root, depth: depth + 1 });
    if (r.ok) return { ok: false, path, message: 'must not match the forbidden shape' };
  }

  return { ok: true };
}
