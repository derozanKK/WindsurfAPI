/**
 * Claude Code compatibility layer — standalone, pluggable, and OFF by default.
 *
 * WHY THIS EXISTS
 * Claude Code is this gateway's oldest first-class client, and support for it
 * accreted across ~20 sites (conversation-pool fingerprint normalization,
 * identity neutralization, messages.js output_config/Read handling, Opus
 * injection-guard avoidance). "Is this Claude Code?" ends up decided at least
 * three different, drifting ways (client.js content regex, identity-neutralize
 * competitor-identity regex, messages.js metadata.user_id parse). This module
 * gives that a SINGLE explicit signal and a SINGLE pluggable activation, mirroring
 * the Cline layer (src/handlers/cline-compat.js) — so the dedicated /v1/cc/*
 * namespace is a stable address a Claude Code user points at, and CC-specific
 * dials become observable and opt-in instead of implicit global defaults.
 *
 * DESIGN CONTRACT
 * - Standard `/v1/*` (and every other client) stays BYTE-IDENTICAL unless this
 *   layer is explicitly activated. Activation has two independent sources:
 *     1. endpoint  — the request came through the dedicated `/v1/cc/*` namespace.
 *        The namespace IS the consent, so it activates EVEN WHEN the master
 *        toggle is off — a stable address that never depends on a dashboard flag.
 *     2. detect    — the request looks like Claude Code (User-Agent) AND the
 *        master `experimental.ccCompat` toggle is on.
 * - Claude Code defaults to the Anthropic protocol (/v1/messages). Unlike Cline
 *   (which rides the OpenAI-compatible /v1/chat/completions path), CC's core
 *   shims live on the Anthropic translation, so `/v1/cc/*` rewrites to the
 *   canonical `/v1/*` and the caller wiring threads `ccCompat` into the messages
 *   and responses handlers, not only the chat one.
 * - This module holds ZERO I/O and ZERO imports from the request pipeline, so it
 *   stays trivially testable and cannot perturb the default path by mere import.
 *
 * CC FINGERPRINT (confirmed, not guessed)
 * - User-Agent: `claude-cli/<version> (external, cli)` (Anthropic itself gates
 *   on this prefix; stable). MCP proxy variant: `claude-code/<version> (cli)`.
 * - Aux headers: `x-app: cli`, `x-claude-code-session-id` (gateway protocol),
 *   `x-stainless-*` (Anthropic JS SDK).
 * - Body: `metadata.user_id` = `user_{device}_account_{uuid}_session_{uuid}`.
 */

const CC_ENDPOINT_PREFIX = '/v1/cc/';

/**
 * Content-fingerprint markers that identify a Claude Code system prompt. This is
 * the SINGLE source of truth — client.js:compactSystemPromptForCascade imports
 * this same regex so the "is this Claude Code?" content heuristic never drifts
 * into divergent copies (the exact drift this module exists to eliminate). The
 * `/i` flag and every marker must match client.js's historical regex verbatim.
 */
export const CC_CONTENT_MARKERS = /Anthropic's official CLI for Claude|Claude Code|cc_version=|content_block|tool_use|<env>/i;

// Process-wide counters surfaced in the dashboard diagnostics card. Reset only
// in tests. Cheap monotonic ints — no per-request allocation.
//
// toolDeferLoadingHonored / toolDeferLoadingIgnored are the CL3 counters for
// Claude Code 2.1.306 `defer_loading` tools (messages.js). The ignored counter
// is logged per request under the literal key `tool_defer_loading_ignored`:
// the upstream has no tool-loading protocol, so a schema-bearing deferred tool
// is forwarded anyway and that deviation must stay countable.
const _stats = {
  schemaNormalized: 0,
  identityNeutralized: 0,
  toolDeferLoadingHonored: 0,
  toolDeferLoadingIgnored: 0,
};

/**
 * Identify a Claude Code client from request headers. The Claude Code CLI sets a
 * User-Agent of the form `claude-cli/<version> (external, cli)` (and the MCP
 * proxy variant `claude-code/<version> (cli)`). Anthropic itself fingerprints on
 * this prefix, so it is stable. As a secondary signal we accept the gateway
 * protocol's `x-app: cli` or the presence of `x-claude-code-session-id`.
 * Case-insensitive; narrow enough not to catch unrelated clients.
 */
export function detectClaudeCodeClient(headers) {
  if (!headers || typeof headers !== 'object') return false;
  const ua = String(headers['user-agent'] || headers['User-Agent'] || '');
  // Primary, high-confidence signal: the claude-cli/ or claude-code/ UA prefix
  // (with the version slash) that Anthropic itself fingerprints on.
  if (/claude-cli\/|claude-code\//i.test(ua)) return true;
  // The gateway-protocol session header is Claude-Code-specific.
  if (headers['x-claude-code-session-id'] || headers['X-Claude-Code-Session-Id']) return true;
  // `x-app: cli` alone is too broad (Gemini CLI / Codex CLI may send it), so it
  // only counts when paired with another CC-ish signal — a `claude` mention in
  // the UA or the session header (already handled above, so here we require the
  // UA hint). This keeps the detector from misfiring on unrelated CLI clients.
  const xApp = String(headers['x-app'] || headers['X-App'] || '');
  if (xApp.toLowerCase() === 'cli' && /claude/i.test(ua)) return true;
  return false;
}

/**
 * Resolve whether the CC compat layer is active for this request, and why.
 * Pure function of (path, headers, masterEnabled) so it is fully unit-testable.
 * Returns { active, source } where source ∈ 'endpoint' | 'detect' | null.
 */
export function resolveCcCompat({ path = '', headers = {}, masterEnabled = false } = {}) {
  if (typeof path === 'string' && path.startsWith(CC_ENDPOINT_PREFIX)) {
    return { active: true, source: 'endpoint' };
  }
  if (masterEnabled && detectClaudeCodeClient(headers)) {
    return { active: true, source: 'detect' };
  }
  return { active: false, source: null };
}

/**
 * Rewrite a `/v1/cc/<rest>` path to its canonical `/v1/<rest>` form so the
 * dedicated namespace reuses the existing handlers instead of duplicating them.
 * Returns the input unchanged when it is not a cc-namespaced path.
 */
export function stripCcNamespace(path) {
  if (typeof path !== 'string' || !path.startsWith(CC_ENDPOINT_PREFIX)) return path;
  return '/v1/' + path.slice(CC_ENDPOINT_PREFIX.length);
}

/**
 * Single "is this Claude Code?" signal, consolidating the three drifting
 * heuristics scattered across the pipeline. Order of confidence:
 *   1. body.metadata.user_id in the CC 2.1.120 wire shape
 *      (`user_{device}_account_{uuid}_session_{uuid}` or the JSON form).
 *   2. request headers (UA / x-app / session-id) via detectClaudeCodeClient.
 *   3. system-prompt content fingerprint (the client.js looksLikeClaudeCode
 *      markers) as a last-resort fallback.
 * Pure — takes already-parsed pieces, does no I/O.
 */
export function isClaudeCode({ headers = {}, body = null } = {}) {
  const uid = body && typeof body === 'object' ? body?.metadata?.user_id : null;
  // (1) metadata.user_id in the CC wire shape. Two forms:
  //   - string: `user_{device}_account_{uuid}_session_{uuid}` — require BOTH
  //     the account_ and session_ segments so a bare opaque id doesn't match.
  //   - object: `{ device_id, account_uuid, session_id }` (older/alt clients).
  if (typeof uid === 'string' && /(?:^|_)session_/.test(uid) && /(?:^|_)account_/.test(uid)) {
    return true;
  }
  if (uid && typeof uid === 'object'
      && (uid.session_id || uid.sessionId)
      && (uid.account_uuid || uid.accountUuid)) {
    return true;
  }
  // (2) request headers (UA / gateway session header).
  if (detectClaudeCodeClient(headers)) return true;
  // (3) system-prompt content fingerprint — shared source of truth with
  // client.js so this heuristic never drifts into a divergent copy.
  const sys = systemText(body);
  if (sys && CC_CONTENT_MARKERS.test(sys)) return true;
  return false;
}

/**
 * Flatten an Anthropic request's `system` field (string, or array of text
 * blocks) into a single string for content-fingerprint checks. Returns '' when
 * absent. Kept here (not imported) so this module stays pipeline-free.
 */
function systemText(body) {
  const sys = body && typeof body === 'object' ? body.system : null;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

export function recordSchemaNormalized() { _stats.schemaNormalized++; }
export function recordIdentityNeutralized() { _stats.identityNeutralized++; }
// CL3: one call per request that carried deferred tools, with both buckets so
// the caller does not have to know which branch ran.
export function recordToolDeferLoading({ honored = 0, ignored = 0 } = {}) {
  _stats.toolDeferLoadingHonored += honored;
  _stats.toolDeferLoadingIgnored += ignored;
}
export function getCcCompatStats() { return { ..._stats }; }
export function resetCcCompatStats() {
  _stats.schemaNormalized = 0;
  _stats.identityNeutralized = 0;
  _stats.toolDeferLoadingHonored = 0;
  _stats.toolDeferLoadingIgnored = 0;
}
