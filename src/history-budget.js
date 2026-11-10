// Outbound conversation-history budget.
//
// WHY THIS EXISTS. Issues #136 / #191 measured the same failure: a 113-turn,
// ~128 KB transcript is accepted, forwarded, and then dies MID-STREAM on the
// upstream's `context deadline exceeded` — the caller has already received
// partial bytes, so it cannot even retry cleanly. Nothing bounded the transcript
// the proxy forwards. `CASCADE_MAX_HISTORY_BYTES` is a prompt-assembly budget
// (it trims the Cascade history suffix and always keeps the newest turn); the
// DEVIN_CONNECT path has no equivalent at all. Neither is an admission check.
//
// This module is that admission check. The shared chat layer measures the
// transcript the caller handed us — turns and payload bytes — and refuses the
// request BEFORE backend selection, account acquisition, the cache, or any
// upstream call. The caller gets one actionable error instead of a truncated
// stream, and the account pool is not charged for a request the upstream cannot
// finish.
//
// UNITS. `turns` is `messages.length` — every entry the encoder will see, system
// turns included, because they all ride the wire. `bytes` counts the payload
// fields the encoder forwards (content text and non-text parts, tool-call ids /
// names / arguments, reasoning_content, reasoning_signature, name, tool_call_id) as UTF-8, the same
// unit proto.js writes. Transport framing is not counted; the number is a
// deliberate lower bound on the wire size, not an estimate of it.
//
// DEFAULTS. The turn ceiling sits below the measured failure (113 turns) so the
// reported shape is refused locally instead of dying mid-reply; the byte ceiling
// is a safety net under the 10 MB ingress cap, because the reported transcript
// was only 128 KB and a tight byte cap would reject large-but-trimmable Cascade
// transcripts that the history-suffix budget already handles. Both dimensions
// are independent: exceeding EITHER refuses the request. Set a dimension to 0
// to disable it (an explicit operator decision, not an accident).

export const HISTORY_BUDGET_TURNS_ENV = 'WINDSURFAPI_HISTORY_BUDGET_TURNS';
export const HISTORY_BUDGET_BYTES_ENV = 'WINDSURFAPI_HISTORY_BUDGET_BYTES';
export const DEFAULT_HISTORY_BUDGET_TURNS = 100;
export const DEFAULT_HISTORY_BUDGET_BYTES = 8_000_000;
export const HISTORY_BUDGET_ERROR_CODE = 'history_budget_exceeded';

function nonNegativeInt(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Resolve the configured budget. `0` disables a dimension; an absent, empty or
 * malformed value falls back to the default (a typo must not silently disable
 * the guard).
 */
export function resolveHistoryBudget({ env = process.env } = {}) {
  return {
    maxTurns: nonNegativeInt(env?.[HISTORY_BUDGET_TURNS_ENV]) ?? DEFAULT_HISTORY_BUDGET_TURNS,
    maxBytes: nonNegativeInt(env?.[HISTORY_BUDGET_BYTES_ENV]) ?? DEFAULT_HISTORY_BUDGET_BYTES,
  };
}

function textBytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function contentBytes(content) {
  if (typeof content === 'string') return textBytes(content);
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return textBytes(JSON.stringify(content));
  }
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === 'string') { total += textBytes(part); continue; }
    if (typeof part !== 'object') continue;
    if (typeof part.text === 'string') total += textBytes(part.text);
    else if (typeof part.image_url?.url === 'string') total += textBytes(part.image_url.url);
    else if (typeof part.input_audio?.data === 'string') total += textBytes(part.input_audio.data);
    else total += textBytes(JSON.stringify(part));
  }
  return total;
}

function messageBytes(message) {
  if (!message || typeof message !== 'object') return 0;
  let total = contentBytes(message.content);
  total += textBytes(message.reasoning_content);
  total += textBytes(message.reasoning_signature);
  total += textBytes(message.reasoning);
  total += textBytes(message.name);
  total += textBytes(message.tool_call_id);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += textBytes(call?.id);
      total += textBytes(call?.function?.name);
      total += textBytes(call?.function?.arguments);
    }
  }
  return total;
}

/** Measure the transcript the caller asked us to forward. */
export function measureOutboundHistory(messages) {
  if (!Array.isArray(messages)) return { turns: 0, bytes: 0 };
  let bytes = 0;
  for (const message of messages) bytes += messageBytes(message);
  return { turns: messages.length, bytes };
}

/**
 * Admission check. Pure (no logging, no env mutation) so tests and callers can
 * drive it deterministically; the chat layer owns the warning and the response.
 *
 * Returns `{ ok, measured, budget, overTurns, overBytes }`.
 */
export function checkOutboundHistory(messages, { env = process.env } = {}) {
  const budget = resolveHistoryBudget({ env });
  const measured = measureOutboundHistory(messages);
  const overTurns = budget.maxTurns > 0 && measured.turns > budget.maxTurns;
  const overBytes = budget.maxBytes > 0 && measured.bytes > budget.maxBytes;
  return { ok: !overTurns && !overBytes, measured, budget, overTurns, overBytes };
}

function kb(bytes) {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Caller-facing explanation. Names the exceeded dimension(s), the measured
 * values, the knobs, and what to do — the point of the check is to replace an
 * opaque mid-stream timeout with something the caller can act on.
 */
export function historyBudgetErrorMessage({ measured, budget, overTurns, overBytes }) {
  const parts = [];
  if (overTurns) parts.push(`${measured.turns} messages (budget ${budget.maxTurns}, ${HISTORY_BUDGET_TURNS_ENV})`);
  if (overBytes) parts.push(`${kb(measured.bytes)} of history (budget ${kb(budget.maxBytes)}, ${HISTORY_BUDGET_BYTES_ENV})`);
  return `Conversation history is too large to forward: ${parts.join('; ')}. `
    + 'The upstream stalls and the stream dies mid-reply on transcripts this large, so the request was refused before it was sent. '
    + 'Start a new session or compact/summarise the transcript. Operators can raise the budget with '
    + `${HISTORY_BUDGET_TURNS_ENV} / ${HISTORY_BUDGET_BYTES_ENV} (0 disables a dimension).`;
}
