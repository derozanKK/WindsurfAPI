/**
 * Tiny CSS helpers shared by the dashboard token gates.
 *
 * The dashboard ships as ONE html file, so the checks read the <style> block
 * out of it and parse just enough CSS for two questions:
 *   - is every account/usage surface on the spacing + type scale?
 *   - does every palette token clear its WCAG floor in BOTH themes?
 *
 * Deliberately not a general CSS parser: no at-rule semantics beyond unwrapping
 * @media, no shorthand expansion, no inheritance. If the checks ever need more,
 * that is the signal to reconsider the approach — not to grow this file.
 */

/** Return the text inside the first <style>…</style>, comments stripped. */
export function readStyleBlock(html) {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>');
  if (start < 0 || end < 0) throw new Error('no <style> block');
  return stripComments(html.slice(start + '<style>'.length, end));
}

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Leaf rules in document order: `{ selector, body }`. Rules nested in @media
 * are returned individually with the wrapper dropped — that is what the scale
 * gate wants (a padding inside a media query is still a padding).
 */
export function parseRules(css) {
  const rules = [];
  let depth = 0;
  let selStart = 0;
  let current = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) current = { selector: css.slice(selStart, i).trim(), bodyStart: i + 1, bodyEnd: -1 };
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && current) {
        current.bodyEnd = i;
        rules.push({ selector: current.selector, body: css.slice(current.bodyStart, i) });
        current = null;
        selStart = i + 1;
      }
      if (depth < 0) throw new Error('unbalanced braces in style block');
    }
  }
  return rules.filter((r) => !r.selector.startsWith('@'));
}

/** Declarations of one rule body (shorthand kept whole; `!important` stripped). */
export function parseDeclarations(body) {
  const out = [];
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    let value = part.slice(idx + 1).trim();
    if (!prop || !value) continue;
    value = value.replace(/\s*!important\s*$/i, '');
    out.push({ prop, value });
  }
  return out;
}

/** Custom properties of the rule whose selector matches `selector` exactly. */
export function customProperties(css, selector) {
  const rule = parseRules(css).find((r) => r.selector === selector);
  if (!rule) throw new Error(`selector not found: ${selector}`);
  const vars = {};
  for (const { prop, value } of parseDeclarations(rule.body)) {
    if (prop.startsWith('--')) vars[prop] = value;
  }
  return vars;
}

/** Follow `var(--x)` chains inside one theme's property map. */
export function resolveVar(value, vars, depth = 0) {
  if (depth > 10) throw new Error(`var() cycle at ${value}`);
  const m = String(value).trim().match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,[\s\S]*)?\)$/i);
  if (!m) return String(value).trim();
  if (!(m[1] in vars)) throw new Error(`undefined custom property ${m[1]}`);
  return resolveVar(vars[m[1]], vars, depth + 1);
}

/** `#rgb`, `#rrggbb`, `rgb()`, `rgba()` → { r, g, b, a } (0–255, 0–1). */
export function parseColor(input) {
  const value = String(input).trim();
  let m = value.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }
  m = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** Composite a possibly-translucent colour over an opaque backdrop. */
export function composite(fg, bg) {
  const a = fg.a ?? 1;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.2 contrast ratio, rounded to 2 decimals for readable failures. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
