// Tool-ID hygiene and tool-pairing repair.
//
// Ported from Any2API `src/translate/hygiene/hygiene.go` and
// `src/translate/toolcall/history.go` with two deliberate changes:
//   - valid IDs are identity (no rewrite on the client-visible leg);
//   - orphan tool results are folded into text, never dropped.
//
// Request-scoped: no global mutable state.

import { createHash } from 'node:crypto';
import { neutralizeToolResultBody } from './tool-text.js';

export const MAX_TOOL_ID_LEN = 64;
export const INTERRUPTED_RESULT_TEXT = 'Tool call was interrupted before any output was recorded.';
export const EMPTY_RESULT_TEXT = 'Tool result was empty.';

const ID_RE = /^[A-Za-z0-9_-]+$/;

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isValidToolId(id, { maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (!ID_RE.test(id)) return false;
  return charsetOnly ? true : id.length <= maxLen;
}

export function sanitizeToolId(id, { maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (id === undefined || id === null || id === '') return '';
  const raw = String(id);
  if (isValidToolId(raw, { maxLen, charsetOnly })) return raw;
  let s = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!charsetOnly && s.length > maxLen) {
    if (maxLen >= 9) {
      const hashLen = Math.min(16, maxLen - 1);
      s = `${s.slice(0, Math.max(0, maxLen - hashLen - 1))}_${sha256Hex(s).slice(0, hashLen)}`;
    } else {
      s = s.slice(0, Math.max(0, maxLen));
    }
  }
  return s;
}

export function synthToolId(base, seed, slot) {
  const prefix = `${base || 'call'}_synth_`;
  if (seed === undefined || seed === null || seed === '') return `${prefix}${slot}`;
  return `${prefix}${sha256Hex(`${seed}\u0000${slot}`).slice(0, 32)}`;
}

export function wireToolId(base, id, seed, slot, opts = {}) {
  const { maxLen = MAX_TOOL_ID_LEN } = opts;
  const synth = synthToolId(base, seed, slot);
  return sanitizeToolId(id, opts) || (maxLen >= 1 ? synth.slice(0, maxLen) : '');
}

// ── Client-visible tool-call id shape (devin family) ────────────────────────
//
// OpenAI clients expect an opaque `call_<opaque>` id. The Devin Connect
// upstream issues its own dialect (`get_weather:0#<uuid>` — live swe-2-medium
// capture, ToolMatrixLive §7) and the ACP runner forwards its
// toolCallId verbatim, so the devin adapters normalize at the CLIENT boundary.
//
// The mapping is REVERSIBLE and STATELESS: a non-conforming upstream id is
// base64url-encoded behind a versioned `call_e1_` marker. No process-global
// map, so a follow-up turn served by another worker (or after a restart) still
// restores the exact upstream id before native history is re-encoded. Ids that
// already match the OpenAI shape pass through untouched.
export const CLIENT_TOOL_CALL_ID_RE = /^call_[A-Za-z0-9_-]+$/;
const CLIENT_TOOL_CALL_ID_PREFIX = 'call_e1_';

export function toClientToolCallId(rawId, fallback = '') {
  if (typeof rawId !== 'string' || rawId === '') return fallback;
  if (CLIENT_TOOL_CALL_ID_RE.test(rawId)) return rawId;
  return CLIENT_TOOL_CALL_ID_PREFIX + Buffer.from(rawId, 'utf8').toString('base64url');
}

export function fromClientToolCallId(clientId) {
  if (typeof clientId !== 'string' || !clientId.startsWith(CLIENT_TOOL_CALL_ID_PREFIX)) return clientId;
  const encoded = clientId.slice(CLIENT_TOOL_CALL_ID_PREFIX.length);
  if (!encoded || !ID_RE.test(encoded)) return clientId;
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  // Canonical round-trip only: an id that merely LOOKS like our encoding
  // (bad length/padding/non-UTF-8) must not be rewritten.
  if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return clientId;
  return decoded;
}

// Inverse of the adapter's egress normalization, applied to a request's history
// immediately before it is encoded for the upstream. Only ids this proxy minted
// are rewritten; every other id passes through byte-identically.
export function restoreUpstreamToolIds(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      let localChanged = false;
      const calls = m.tool_calls.map((tc) => {
        const id = fromClientToolCallId(tc?.id);
        if (id === tc?.id) return tc;
        localChanged = true;
        return { ...tc, id };
      });
      if (localChanged) {
        changed = true;
        return { ...m, tool_calls: calls };
      }
    }
    if (typeof m?.tool_call_id === 'string') {
      const id = fromClientToolCallId(m.tool_call_id);
      if (id !== m.tool_call_id) {
        changed = true;
        return { ...m, tool_call_id: id };
      }
    }
    return m;
  });
  return changed ? out : messages;
}

export function foldOrphanResultText(content) {
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') return part.text;
        if (part.type) return `[${part.type}]`;
      }
      return '';
    }).filter(Boolean).join('\n').trim();
    return parts || EMPTY_RESULT_TEXT;
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  const text = typeof content === 'string' ? content.trim() : String(content ?? '').trim();
  return text || EMPTY_RESULT_TEXT;
}

function appendText(content, text) {
  if (typeof content === 'string' || content == null) {
    return content ? `${content}\n\n${text}` : text;
  }
  if (Array.isArray(content)) return [...content, { type: 'text', text }];
  return text;
}

export function knownToolCallIds(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc?.id) ids.add(tc.id);
    }
  }
  return ids;
}

function uniqueToolId(base, reserved, maxLen) {
  const limit = maxLen >= 1 ? maxLen : 1;
  const stem = base || 'call';
  let wire = stem.slice(0, limit);
  let n = 2;
  // A suffix must fit inside the same namespace; if it cannot, use the
  // base-36 counter itself rather than appending past maxLen. Exhausting a
  // tiny namespace is a contract error, not a reason to emit an overlong id.
  const maxAttempts = limit <= 6 ? 36 ** limit : Number.MAX_SAFE_INTEGER;
  while (reserved.has(wire)) {
    if (n > maxAttempts) throw new Error('tool id namespace exhausted');
    const token = n.toString(36);
    n += 1;
    wire = token.length >= limit
      ? token.slice(-limit)
      : `${stem.slice(0, limit - token.length - 1)}_${token}`;
  }
  reserved.add(wire);
  return wire;
}

// Egress-side counterpart to the request-leg repair above. Upstream can reuse
// one call id for two DISTINCT calls (parallel calls or a repeated turn); a
// client that keys tool results by id then cannot tell them apart. Allocate in
// first-arrival order: the first occurrence keeps the raw (sanitized) id, later
// occurrences get the same deterministic suffix the request leg uses, so the
// mapping is stable across turns. `makeFallback` supplies the surface's
// historical generated id when upstream omitted one; without it an absent id
// stays absent.
export function createToolIdAllocator({ maxLen = MAX_TOOL_ID_LEN, charsetOnly = false, makeFallback = null } = {}) {
  const opts = { maxLen, charsetOnly };
  const reserved = new Set();
  let slot = 0;
  return function allocateToolId(rawId) {
    const base = sanitizeToolId(rawId, opts);
    if (base) return uniqueToolId(base, reserved, maxLen);
    if (!makeFallback) return '';
    const generated = sanitizeToolId(String(makeFallback(slot++) ?? ''), opts);
    return uniqueToolId(generated || synthToolId('call', '', slot), reserved, maxLen);
  };
}

export function normalizeToolIdsInMessages(messages, { seed = '', maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (!Array.isArray(messages)) return messages;

  const assistantCalls = [];
  const resultIds = [];
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) assistantCalls.push(tc);
    } else if (m?.role === 'tool') {
      resultIds.push(m.tool_call_id);
    }
  }

  const opts = { maxLen, charsetOnly };
  const reserved = new Set();
  for (const tc of assistantCalls) {
    if (isValidToolId(tc?.id, opts)) reserved.add(tc.id);
  }
  for (const id of resultIds) {
    if (isValidToolId(id, opts)) reserved.add(id);
  }

  // A raw id may legitimately appear more than once (some clients reuse the
  // same id for parallel calls). Valid ids stay identity on the first call;
  // later calls get a unique wire id, and results pair FIFO to the calls in
  // order. A single raw->wire map would collapse both calls onto one id and
  // make the second result indistinguishable from the first.
  const wireQueues = new Map();
  let slot = 0;
  const callWire = new Map();
  for (const tc of assistantCalls) {
    const raw = tc?.id;
    let wire;
    if (raw && isValidToolId(raw, opts)) {
      const queue = wireQueues.get(raw);
      if (!queue) {
        wire = raw;
        wireQueues.set(raw, [wire]);
      } else {
        wire = uniqueToolId(raw, reserved, maxLen);
        queue.push(wire);
      }
    } else {
      const base = raw ? sanitizeToolId(raw, opts) : synthToolId('call', seed, slot++);
      wire = uniqueToolId(base, reserved, maxLen);
      if (raw) {
        // A malformed raw id can repeat exactly like a valid one (parallel calls
        // or successive turns). Keep the same FIFO queue the valid-id branch
        // uses; overwriting it would bind every result to the last call.
        const queue = wireQueues.get(raw);
        if (queue) queue.push(wire);
        else wireQueues.set(raw, [wire]);
      }
    }
    callWire.set(tc, wire);
  }

  const resultWire = new Map();
  for (const m of messages) {
    if (m?.role !== 'tool' || !m.tool_call_id) continue;
    const queue = wireQueues.get(m.tool_call_id);
    if (queue && queue.length) {
      resultWire.set(m, queue.shift());
      continue;
    }
    const base = sanitizeToolId(m.tool_call_id, opts);
    if (base) resultWire.set(m, uniqueToolId(base, reserved, maxLen));
  }

  let changed = false;
  const out = messages.map((m) => {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      let localChanged = false;
      const calls = m.tool_calls.map((tc) => {
        const raw = tc?.id;
        const id = callWire.get(tc);
        if (id && id !== raw) {
          localChanged = true;
          return { ...tc, id };
        }
        return tc;
      });
      if (localChanged) {
        changed = true;
        return { ...m, tool_calls: calls };
      }
    }
    if (m?.role === 'tool' && m.tool_call_id) {
      const id = resultWire.get(m) || m.tool_call_id;
      if (id !== m.tool_call_id) {
        changed = true;
        return { ...m, tool_call_id: id };
      }
    }
    return m;
  });
  return changed ? out : messages;
}

export function toolHygieneEnabled() {
  return process.env.WINDSURFAPI_TOOL_HYGIENE !== '0';
}

export function foldOrphanToolResults(messages) {
  if (!Array.isArray(messages)) return messages;
  const known = knownToolCallIds(messages);
  let changed = false;
  const out = [];
  let pending = [];

  // Fold only after the contiguous tool run that contains the orphan. Inserting
  // a user message immediately after an assistant tool_call (while a valid tool
  // result for that call is still pending) breaks the required
  // assistant(tool_calls) -> tool(result) adjacency and re-orphans the valid
  // result. Buffering until the run ends preserves both the content and the
  // valid pair.
  const flush = () => {
    if (!pending.length) return;
    const folded = neutralizeToolResultBody(pending.join('\n\n'));
    pending = [];
    const prev = out[out.length - 1];
    if (prev?.role === 'user') {
      out[out.length - 1] = { ...prev, content: appendText(prev.content, folded) };
    } else {
      out.push({ role: 'user', content: folded });
    }
  };

  for (const m of messages) {
    if (m?.role === 'tool' && (!m.tool_call_id || !known.has(m.tool_call_id))) {
      changed = true;
      pending.push(
        `${m.tool_call_id ? `[tool result for ${m.tool_call_id}]\n` : '[tool result]\n'}${foldOrphanResultText(m.content)}`,
      );
      continue;
    }
    if (m?.role !== 'tool') flush();
    out.push(m);
  }
  flush();
  return changed ? out : messages;
}

export function synthesizeMissingResults(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    out.push(m);
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    // A trailing assistant call is the normal "awaiting execution" shape.
    if (i === messages.length - 1) continue;
    const existing = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') {
      existing.push(messages[j]);
      j += 1;
    }
    for (const tm of existing) out.push(tm);
    const have = new Set(existing.map((tm) => tm.tool_call_id).filter(Boolean));
    const missing = m.tool_calls.filter((tc) => tc?.id && !have.has(tc.id));
    if (missing.length) {
      changed = true;
      for (const tc of missing) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_RESULT_TEXT });
      }
    }
    i = j - 1;
  }
  return changed ? out : messages;
}
