// Tool-name mapping across the client/upstream boundary.
import { TOOL_MAP } from './cascade-native-bridge.js';
//
// Anthropic accepts 1–128 chars; the OpenAI-compatible upstream accepts 64.
// A valid client name must stay byte-identical on the client-visible leg, so
// the map is two-pass: reserve every already-valid name first, then assign
// sanitized/truncated wire names around them. A single pass can rewrite a
// valid name when an earlier invalid name sanitizes into it.
//
// Request-scoped: no global mutable state.

import { createHash } from 'node:crypto';

export const MAX_ANTHROPIC_TOOL_NAME = 128;
export const MAX_UPSTREAM_TOOL_NAME = 64;

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isValidToolName(name, maxLen = MAX_ANTHROPIC_TOOL_NAME) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= maxLen
    && NAME_RE.test(name);
}

export function sanitizeToolName(name, maxLen = MAX_UPSTREAM_TOOL_NAME) {
  if (name === undefined || name === null || name === '') return '';
  let s = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  if (s.length === 0) s = 'tool';
  if (s.length > maxLen) {
    if (maxLen >= 9) {
      s = `${s.slice(0, Math.max(0, maxLen - 9))}_${sha256Hex(s).slice(0, 8)}`;
    } else {
      s = s.slice(0, Math.max(0, maxLen));
    }
  }
  return s;
}

/**
 * Build a bidirectional, collision-free map for one request.
 *
 * @param {Array<{name?: string}>|string[]} tools
 * @param {{ maxUpstream?: number }} [opts]
 * @returns {{ toUpstream: Map<string,string>, toClient: Map<string,string> }}
 */
export function buildToolNameMap(tools, { maxUpstream = MAX_UPSTREAM_TOOL_NAME } = {}) {
  const names = [];
  const seen = new Set();
  for (const t of tools || []) {
    const name = typeof t === 'string' ? t : t?.name;
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  const toUpstream = new Map();
  const toClient = new Map();
  const reserved = new Set(names.filter((n) => isValidToolName(n, maxUpstream)));
  // A normalized caller name must never acquire native-bridge meaning. Reserve
  // every native tool name even when the caller did not declare it, so
  // `shell.command` cannot be rewritten to the native `shell_command`.
  for (const native of Object.keys(TOOL_MAP)) {
    if (isValidToolName(native, maxUpstream)) reserved.add(native);
  }

  // Pass 1: every valid name keeps its exact bytes and reserves its slot.
  for (const name of names) {
    if (!reserved.has(name)) continue;
    toUpstream.set(name, name);
    toClient.set(name, name);
  }

  // Pass 2: invalid/too-long names get a deterministic, unique wire name.
  for (const name of names) {
    if (toUpstream.has(name)) continue;
    const base = sanitizeToolName(name, maxUpstream);
    let wire = base;
    let n = 2;
    while (reserved.has(wire) || toClient.has(wire)) {
      const suffix = `_${n++}`;
      wire = `${base.slice(0, Math.max(1, maxUpstream - suffix.length))}${suffix}`;
    }
    reserved.add(wire);
    toUpstream.set(name, wire);
    toClient.set(wire, name);
  }

  return { toUpstream, toClient };
}

export function restoreToolName(name, map) {
  return map?.toClient?.get(name) ?? name;
}
