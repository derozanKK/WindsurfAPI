/**
 * DEVIN_CONNECT catalog + entitlement probe.
 *
 * Two read-only unary RPCs on the same Connect-RPC transport as GetChatMessage
 * (server.codeium.com, `Basic <token>-<token>` auth, client metadata as proto
 * field #1). Neither issues a chat turn, so both are zero-billable:
 *
 *   - GetCliModelConfigs → the full model catalog. Each ClientModelConfig
 *     carries the selector (#22) that goes into GetChatMessageRequest.model
 *     (field #21), the friendly label (#1), provider (#10), and a short alias
 *     (#23.#23). This is the source of truth for src/devin-connect-models.js's
 *     hand-maintained SELECTOR_MAP — run it against a paid account and the
 *     catalog reveals every selector that account can name.
 *
 *   - GetUserStatus → the account's plan name (#2.#2, e.g. "Free"). The catalog
 *     itself lists all models regardless of tier (the entitlement wall is
 *     enforced server-side at chat time, NOT in the catalog), so planName is
 *     the reliable free-vs-paid signal.
 *
 * Wire shapes were calibrated against the live API on 2026-06-30 with a free
 * account: GetCliModelConfigs → 200, 24 configs; GetUserStatus → 200, plan
 * "Free". See memory devin-connect-response-protocol-2026-06-30.
 */

import https from 'https';
import { randomBytes } from 'crypto';
import { log } from './config.js';
import { parseFields, writeStringField, writeMessageField, writeVarintField } from './proto.js';
import { getConnectToken, classifyUpstreamError, MAX_ERROR_BODY_BYTES, ERROR_BODY_TRUNCATION_MARKER, createBoundedBodyAccumulator } from './devin-connect.js';

// Transport seam: defaults to https.request. Swappable in tests so the non-200
// classification path can be exercised without a real socket. Mirrors the
// __setRequestImpl seam in devin-connect.js.
let requestImpl = https.request;
export function __setCatalogRequestImpl(fn) { requestImpl = fn || https.request; }

const HOST = 'server.codeium.com';
const CATALOG_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
const STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const CLIENT_NAME = 'chisel';
const CLIENT_VERSION = '2026.8.18';

// ── ClientModelConfig field numbers (calibrated from a live 200 response) ──
const F_LABEL = 1;       // friendly name, e.g. "Claude Opus 4.8 Medium"
const F_DISABLED = 4;    // model is not callable and must not be advertised
const F_SUPPORTS_IMAGES = 5; // explicit upstream multimodal capability
const F_PROVIDER = 10;   // 1=SWE/Cognition 2=OpenAI 3=Anthropic 4=Google 7=Moonshot 9=Zhipu
const F_SELECTOR = 22;   // the value GetChatMessageRequest.model expects
const F_MODEL_INFO = 23; // ModelInfo submessage; #23.#23 is the short alias
const F_ALIAS = 23;      // inside ModelInfo: short alias e.g. "claude-opus-4.8"

const PROVIDER_NAMES = {
  1: 'cognition', 2: 'openai', 3: 'anthropic', 4: 'google', 7: 'moonshot', 9: 'zhipu',
};

/**
 * Build the ClientMetadata sub-message (proto field #1 of the request). Mirrors
 * src/devin-connect.js buildClientMetadata — the token is embedded SINGLE here;
 * the doubling is only for the HTTP Authorization header.
 */
function buildClientMetadata(token) {
  return Buffer.concat([
    writeStringField(1, CLIENT_NAME),
    writeStringField(2, CLIENT_VERSION),
    writeStringField(3, token),
    writeStringField(4, 'en'),
    writeStringField(5, 'windows'),
    writeStringField(7, CLIENT_VERSION),
    writeStringField(12, CLIENT_NAME),
    writeStringField(31, randomBytes(366).toString('hex')),
  ]);
}

/**
 * POST a unary Connect-RPC request (application/proto, raw body) and resolve the
 * raw response buffer. Rejects with a coded error on non-200.
 *
 * @param {string} path
 * @param {string} token
 * @param {object} [opts]
 * @param {Buffer} [opts.extraBody]  extra proto fields appended AFTER the
 *   client-metadata field #1 (e.g. AssignModel's model_uid). Default: none.
 */
function unaryCall(path, token, { signal, timeoutMs = 30000, extraBody } = {}) {
  const body = extraBody
    ? Buffer.concat([writeMessageField(1, buildClientMetadata(token)), extraBody])
    : writeMessageField(1, buildClientMetadata(token));
  const authHeader = `Basic ${token}-${token}`;
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname: HOST, port: 443, path, method: 'POST',
      headers: {
        'Content-Type': 'application/proto',
        'Connect-Protocol-Version': '1',
        'Content-Length': body.length,
        'User-Agent': 'connect-es/2.0.0',
        authorization: authHeader,
        Accept: '*/*',
      },
      signal,
    }, (res) => {
      // Bounded read: the response is attacker-controlled and its body is
      // decoded for classification. Reading it unbounded is the availability
      // bug createBoundedBodyAccumulator exists for — and on this path it has
      // already taken the process down once: raw.toString('utf8') ran BEFORE
      // the 200-byte slice, so a 600MiB body threw ERR_STRING_TOO_LONG inside
      // this 'end' listener, which nothing catches.
      const buffer = createBoundedBodyAccumulator();
      res.on('data', buffer.onData);
      res.on('end', () => {
        const { raw, truncated } = buffer.finish();
        if (res.statusCode !== 200) {
          // Slice BEFORE stringifying: only the classification window is
          // decoded, never the whole body. The window is 200 bytes (error
          // bodies are ASCII JSON/text, so bytes and characters coincide), and
          // the truncation marker is appended AFTER it so an operator can tell
          // a clipped body from a short one.
          const text = raw.subarray(0, 200).toString('utf8')
            + (truncated ? ERROR_BODY_TRUNCATION_MARKER : '');
          if (truncated) {
            log.warn(`[devin-connect] upstream ${res.statusCode} error body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated for classification`);
          }
          // Transient-first: the upstream wraps capacity ("high demand") and
          // backend ("internal error occurred (trace ID: ...)") faults inside a
          // 401/403 auth-shell on the unary probe path too — not just on
          // GetChatMessage. Classifying by HTTP status alone would read such a
          // blip as UNAUTHORIZED, and the liveness probe (probeAndRecoverConnect
          // Account) only force-re-logins on UNAUTHORIZED → a live token gets a
          // needless re-login on a momentary hiccup (the #56/#57 母题). Route the
          // body+code+status through the shared classifier so CAPACITY /
          // UPSTREAM_INTERNAL / RATE_LIMITED are surfaced as their transient
          // codes, and only a genuine auth death stays UNAUTHORIZED. Best-effort
          // JSON parse to recover the Connect-RPC error code when present.
          let upstreamCode = null;
          // Connect-RPC unary errors are top-level {"code","message"}; the
          // GetChatMessage trailer path uses nested {"error":{"code"}}. Accept
          // either so the transient signal (unavailable/resource_exhausted)
          // survives regardless of which shape the upstream sends here.
          try {
            const parsed = JSON.parse(text);
            upstreamCode = parsed?.error?.code || parsed?.code || null;
          } catch { /* text body */ }
          const { code, message } = classifyUpstreamError(text, upstreamCode, res.statusCode);
          reject(Object.assign(new Error(`${path} HTTP ${res.statusCode}: ${message}`), { code, status: res.statusCode }));
          return;
        }
        if (truncated) {
          // A 200 body past the ceiling cannot be the single protobuf response
          // this path expects; fail instead of decoding a prefix as if it were
          // the whole message.
          log.warn(`[devin-connect] ${path} response body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated`);
          reject(Object.assign(new Error(`${path} response body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated`), { code: 'UPSTREAM_ERROR', status: res.statusCode }));
          return;
        }
        resolve(raw);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error('catalog probe timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

/** Read the first length-delimited subfield as UTF-8, or '' if absent. */
function strField(fields, num) {
  const f = fields.find((x) => x.field === num && x.wireType === 2);
  return f ? f.value.toString('utf8') : '';
}

/** Read the first varint subfield as Number, or null if absent. */
function intField(fields, num) {
  const f = fields.find((x) => x.field === num && x.wireType === 0);
  return f ? Number(f.value) : null;
}

/**
 * Decode a GetCliModelConfigsResponse into a flat list of model entries.
 *
 * @param {Buffer} raw
 * @returns {Array<{selector,label,provider,providerId,alias,isFreeDefault,supportsImages:boolean|null}>}
 */
export function decodeCatalog(raw) {
  const configs = parseFields(raw).filter((f) => f.field === 1 && f.wireType === 2);
  const out = [];
  for (const c of configs) {
    const fields = parseFields(c.value);
    const selector = strField(fields, F_SELECTOR);
    if (!selector) continue;
    if (intField(fields, F_DISABLED) === 1) continue;
    const label = strField(fields, F_LABEL);
    const providerId = intField(fields, F_PROVIDER);
    const supportsImagesField = intField(fields, F_SUPPORTS_IMAGES);
    let alias = '';
    const info = fields.find((x) => x.field === F_MODEL_INFO && x.wireType === 2);
    if (info) {
      try { alias = strField(parseFields(info.value), F_ALIAS); } catch { /* keep '' */ }
    }
    // swe-1-6-slow uniquely carries the free context-window default (#18=200000
    // + #24=1). It's the one selector every
    // tier can run; flag it so callers can pick a safe default.
    const isFreeDefault = selector === 'swe-1-6-slow';
    out.push({
      selector,
      label,
      providerId,
      provider: PROVIDER_NAMES[providerId] || (providerId == null ? 'unknown' : String(providerId)),
      alias,
      isFreeDefault,
      supportsImages: supportsImagesField == null ? null : supportsImagesField === 1,
    });
  }
  return out;
}

/** Decode GetUserStatusResponse → plan name (#2.#2). Lowercased; '' if absent. */
export function decodePlanName(raw) {
  const top = parseFields(raw);
  const lvl1 = top.find((x) => x.field === 2 && x.wireType === 2);
  if (!lvl1) return '';
  try {
    return strField(parseFields(lvl1.value), 2).trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Decode GetUserStatusResponse → full billing ledger.
 *
 * Field spec:
 *   #1.13.16 = balance (varint, micro-dollar — divide by 1e6 for USD)
 *   #1.13.17 = daily quota reset timestamp (varint, epoch seconds)
 *   #1.13.18 = weekly quota reset timestamp (varint, epoch seconds)
 *   #1.13.1.21 (repeated) = legacy per-model credit rate table (fixed32 f32, paired to catalog order)
 *   #1.33.1 (repeated) = per-model credit rate table (model_uid #22, credit_multiplier #3 float)
 *
 * Returns { plan, isPaid, balance, balanceUnit, dailyQuotaResetAt, weeklyQuotaResetAt,
 * periodStart, periodEnd, rateTable }. periodStart/periodEnd are deprecated aliases
 * of dailyQuotaResetAt/weeklyQuotaResetAt — they are quota reset timestamps, NOT a
 * billing period. All billing fields are optional — older/free accounts may not
 * carry them. Returns null for missing fields (no throw). Rate table is
 * { selector → creditFloat }: the current shape is keyed by each config's own
 * model_uid, the legacy shape by pairing with the live catalog (requires a
 * separate fetchCatalog call; this decode is catalog-agnostic).
 *
 * @param {Buffer} raw  GetUserStatusResponse wire bytes
 * @param {Array<{selector:string}>} [catalog]  live catalog from fetchCatalog (for
 *   pairing rate-table indices to selectors). If omitted, rateTable is returned as
 *   an array of f32 values (no selector keys).
 * @returns {{
 *   plan: string,
 *   isPaid: boolean,
 *   balance: number|null,
 *   balanceUnit: 'usd'|null,
 *   dailyQuotaResetAt: number|null,
 *   weeklyQuotaResetAt: number|null,
 *   periodStart: number|null,
 *   periodEnd: number|null,
 *   rateTable: Object<string,number>|Array<number>|null
 * }}
 */
export function decodeUserStatusFull(raw, catalog = null) {
  const result = {
    plan: 'unknown',
    isPaid: false,
    balance: null,
    balanceUnit: null,
    dailyQuotaResetAt: null,
    weeklyQuotaResetAt: null,
    periodStart: null, // deprecated alias of dailyQuotaResetAt
    periodEnd: null,   // deprecated alias of weeklyQuotaResetAt
    rateTable: null,
  };

  try {
    const top = parseFields(raw);
    // #1 = main account block (55KB on paid accounts)
    const field1 = top.find((x) => x.field === 1 && x.wireType === 2);

    if (field1) {
      const lvl1 = parseFields(field1.value);

      // Rate table, current shape: UserStatus#33 (cascade_model_config_data)
      // carries client_model_configs[] with model_uid (#22) + credit_multiplier
      // (#3, float). PlanInfo#21 is reserved on target servers, so read #33
      // first and keep the #21 path below as the fallback for older servers.
      const cmcField = lvl1.find((x) => x.field === 33 && x.wireType === 2);
      if (cmcField) {
        try {
          const cmc = parseFields(cmcField.value);
          const configs = cmc.filter((x) => x.field === 1 && x.wireType === 2);
          const table = {};
          for (const cfg of configs) {
            const cf = parseFields(cfg.value);
            const selector = strField(cf, 22);
            const cm = cf.find((x) => x.field === 3 && x.wireType === 5);
            if (!selector || !cm || cm.value.length !== 4) continue;
            table[selector] = cm.value.readFloatLE(0);
          }
          if (Object.keys(table).length > 0) result.rateTable = table;
        } catch { /* fall through to the legacy #21 path */ }
      }

      // #1.13 = billing structure
      const billingField = lvl1.find((x) => x.field === 13 && x.wireType === 2);
      if (billingField) {
        const billing = parseFields(billingField.value);

        // Balance: #1.13.16 is in micro-dollars on the wire (observed 80000000
        // = $80 on a paid Teams account). We convert to USD here, so `balance`
        // is already USD and `balanceUnit` reflects that — consumers must NOT
        // divide by 1e6 again.
        const balanceMicro = intField(billing, 16);
        // uint64 -1 is a common "unknown/unlimited" sentinel on the wire; read as
        // an unsigned varint it becomes 1.8e19 micro-dollars and the dashboard
        // rendered $18,446,744,073,709.43. Only a plausible on-demand balance
        // (0 .. $1,000,000 in micro-dollars) is real; everything else is unknown.
        if (balanceMicro != null && Number.isFinite(balanceMicro)
            && balanceMicro >= 0 && balanceMicro <= 1e12) {
          result.balance = balanceMicro / 1e6;
          result.balanceUnit = 'usd';
          result.balanceMicro = balanceMicro; // raw micro-usd, for callers that want it
        }

        // Quota resets: #1.13.17/18 are the daily/weekly quota reset
        // timestamps (epoch SECONDS on the wire), NOT a billing period. Return
        // them as millisecond numbers — JSON-safe, directly usable by
        // `new Date(ms)`. periodStart/periodEnd keep the same values for
        // existing consumers (deprecated aliases; see the header note).
        const dailyResetEpoch = intField(billing, 17);
        const weeklyResetEpoch = intField(billing, 18);
        if (dailyResetEpoch != null) {
          result.dailyQuotaResetAt = dailyResetEpoch * 1000;
          result.periodStart = result.dailyQuotaResetAt;
        }
        if (weeklyResetEpoch != null) {
          result.weeklyQuotaResetAt = weeklyResetEpoch * 1000;
          result.periodEnd = result.weeklyQuotaResetAt;
        }

        // #1.13.1 = plan detail
        const planField = billing.find((x) => x.field === 1 && x.wireType === 2);
        if (planField) {
          const plan = parseFields(planField.value);

          // Plan name
          const planName = strField(plan, 2);
          if (planName) {
            result.plan = planName.trim().toLowerCase();
            result.isPaid = result.plan !== 'free' && result.plan !== '';
          }

          // #1.13.1.21 (repeated) = legacy credit rate table (fixed32 f32) —
          // only consulted when the #33 table above was absent (fallback path).
          const rateEntries = plan.filter((x) => x.field === 21 && x.wireType === 2);
          if (rateEntries.length > 0 && !result.rateTable) {
            const rates = rateEntries.map((entry) => {
              try {
                const fields = parseFields(entry.value);
                const f2 = fields.find((x) => x.field === 2 && x.wireType === 5);
                return f2 ? f2.value.readFloatLE(0) : null;
              } catch {
                return null;
              }
            });

            // Pair to catalog if provided; otherwise return raw array
            if (catalog && Array.isArray(catalog)) {
              const map = {};
              for (let i = 0; i < Math.min(rates.length, catalog.length); i++) {
                if (rates[i] != null && catalog[i]?.selector) {
                  map[catalog[i].selector] = rates[i];
                }
              }
              result.rateTable = map;
            } else {
              result.rateTable = rates;
            }
          }
        }
      }
    }

    // Fallback plan name from #2.#2 (backward compat with decodePlanName)
    if (result.plan === 'unknown') {
      const lvl2 = top.find((x) => x.field === 2 && x.wireType === 2);
      if (lvl2) {
        try {
          const planName = strField(parseFields(lvl2.value), 2);
          if (planName) {
            result.plan = planName.trim().toLowerCase();
            result.isPaid = result.plan !== 'free' && result.plan !== '';
          }
        } catch { /* keep 'unknown' */ }
      }
    }
  } catch (e) {
    // Defensive: malformed response → return partial result (never throw)
    log.warn(`decodeUserStatusFull: parse error (${e.message}), returning partial data`);
  }

  return result;
}

/**
 * Fetch the live model catalog for a session token.
 *
 * @param {object} [opts]
 * @param {string} [opts.token]  session token; defaults to env (getConnectToken)
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.env]
 * @returns {Promise<Array>} decodeCatalog() entries
 */
export async function fetchCatalog({ token, signal, env = process.env } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  const raw = await unaryCall(CATALOG_PATH, sessionToken, { signal });
  const models = decodeCatalog(raw);
  log.info(`DEVIN_CONNECT catalog: ${models.length} models`);
  return models;
}

/**
 * Fetch the account's plan/tier name for a session token.
 *
 * Returns the full billing ledger when available (paid accounts): { plan, isPaid,
 * balance, balanceUnit, dailyQuotaResetAt, weeklyQuotaResetAt, periodStart,
 * periodEnd, rateTable }. Free/old accounts only have plan + isPaid. All billing
 * fields are nullable (no throw on missing).
 *
 * @param {object} [opts]
 * @param {string} [opts.token]  session token; defaults to env (getConnectToken)
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.env]
 * @param {boolean} [opts.withCatalog]  fetch catalog for rate-table pairing (default false)
 * @returns {Promise<{
 *   plan: string,
 *   isPaid: boolean,
 *   balance?: number,
 *   balanceUnit?: string,
 *   dailyQuotaResetAt?: number,
 *   weeklyQuotaResetAt?: number,
 *   periodStart?: number,  // deprecated alias of dailyQuotaResetAt
 *   periodEnd?: number,    // deprecated alias of weeklyQuotaResetAt
 *   rateTable?: Object|Array
 * }>}
 */
export async function fetchUserStatus({ token, signal, env = process.env, withCatalog = false } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  const raw = await unaryCall(STATUS_PATH, sessionToken, { signal });

  let catalog = null;
  if (withCatalog) {
    try {
      catalog = await fetchCatalog({ token: sessionToken, signal, env });
    } catch (e) {
      // Catalog fetch failed — degrade gracefully (rate table returned as array)
      log.warn(`fetchUserStatus: catalog fetch failed (${e.message}), rate table will not be paired`);
    }
  }

  const status = decodeUserStatusFull(raw, catalog);

  // Backward compat: existing callers expect { plan, isPaid } at top level
  return status;
}

export const __testing = { buildClientMetadata, strField, intField, PROVIDER_NAMES };

/**
 * Zero-billable liveness check for a DEVIN_CONNECT session token.
 *
 * Reuses GetUserStatus (a free seat-management RPC — no model inference, no
 * token billing) purely to learn whether the session_id is still accepted
 * upstream. A 200 means alive; UNAUTHORIZED (401/403) means the server retired
 * the session_id and the account is dead until re-login.
 *
 * This is the early-warning probe: run it on a schedule (or before handing an
 * account a real request) so a dead token is caught — and recovered via
 * re-login — before a user request ever lands on it.
 *
 * @param {object} opts
 * @param {string} opts.token  session token to probe (required for pooled accounts)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{alive:boolean, plan?:string, code?:string, error?:string}>}
 *   Never throws — failures are returned as { alive:false, code, error }.
 */
export async function checkSessionLiveness({ token, signal, env = process.env } = {}) {
  try {
    const { plan } = await fetchUserStatus({ token, signal, env });
    return { alive: true, plan };
  } catch (e) {
    return { alive: false, code: e.code || 'UPSTREAM_ERROR', error: e.message };
  }
}

// ─── AssignModel — router-model resolution ──────────────────────────────────
//
// "Router" models (adaptive, arena-*) are not real model_uids — they're a
// router that the server resolves to a concrete model per request. The Windsurf
// client detects is_model_router=true and makes an AssignModel unary RPC FIRST,
// gets back a ModelAssignment{ model_uid, assignment_jwt, harness_uids }, then
// issues GetChatMessage with the RESOLVED model_uid. WindsurfAPI never made that
// hop, so every router model was rejected upstream (D4 §6).
//
// Wire layout: the method path and the message shapes (AssignModelResponse
// { assignment }, ModelAssignment{ model_uid, assignment_jwt, harness_uids })
// are known; the request carries model_router_uid (#2) and cascade_id (#3,
// required upstream); the assignment carries assignment_jwt (#1), model_uid
// (#2) and harness_uids (#3). Every tag stays overridable via
// DEVIN_CONNECT_ASSIGN_TAGS, so a live round-trip can re-point any of them
// without a code change.
const ASSIGN_MODEL_PATH = '/exa.api_server_pb.ApiServerService/AssignModel';

// Default tags (override via DEVIN_CONNECT_ASSIGN_TAGS). req_cascade_id is
// required by the server's request validation — assignModel() writes it on
// every call (empty string when the cascade is unknown).
const ASSIGN_TAGS_DEFAULT = Object.freeze({
  req_model_uid: 2,      // request: model_uid string (after client-meta #1)
  req_cascade_id: 3,     // request: cascade_id string (required; '' when unknown)
  resp_assignment: 1,    // AssignModelResponse.assignment (message)
  asg_model_uid: 2,      // ModelAssignment.model_uid (string)
  asg_jwt: 1,            // ModelAssignment.assignment_jwt (string)
  asg_harness: 3,        // ModelAssignment.harness_uids (repeated string)
});

/**
 * Parse DEVIN_CONNECT_ASSIGN_TAGS overrides, e.g.
 *   "req_model_uid=2,req_cascade_id=3,resp_assignment=1,asg_model_uid=2,asg_jwt=1,asg_harness=3"
 * Unknown keys / non-positive-int tags are ignored. Returns the default map with
 * any valid overrides applied.
 */
export function parseAssignTags(env = process.env) {
  const map = { ...ASSIGN_TAGS_DEFAULT };
  const raw = String(env.DEVIN_CONNECT_ASSIGN_TAGS || '').trim();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [key, tag] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(tag, 10);
    if (key in ASSIGN_TAGS_DEFAULT && Number.isInteger(n) && n > 0) map[key] = n;
  }
  return map;
}

/**
 * Is this model name a router that needs an AssignModel hop before chat?
 * `adaptive` and the `arena-*` family are the known routers (D4 §6). Extendable
 * via DEVIN_CONNECT_ROUTER_MODELS (comma-separated names/prefixes, `*` suffix
 * for prefix match).
 */
export function isRouterModel(name, env = process.env) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const extra = String(env.DEVIN_CONNECT_ROUTER_MODELS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const patterns = ['adaptive', 'arena-*', ...extra];
  return patterns.some((p) =>
    p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p);
}

/**
 * Encode the AssignModel request body (the extra fields after client-meta #1).
 * cascade_id (#3) is required by the server's request validation: pass the
 * cascade the turn belongs to via `cascadeId`, or leave it empty — the field is
 * written either way so the request always carries it.
 */
export function encodeAssignModelRequest(modelUid, tags = ASSIGN_TAGS_DEFAULT, cascadeId = '') {
  return Buffer.concat([
    writeStringField(tags.req_model_uid, String(modelUid)),
    writeStringField(tags.req_cascade_id, String(cascadeId ?? '')),
  ]);
}

/**
 * Decode an AssignModelResponse → { model_uid, assignment_jwt, harness_uids }.
 * Returns null if the response carries no assignment (server's documented
 * "AssignModel returned empty assignment" case).
 */
export function decodeAssignModelResponse(raw, tags = ASSIGN_TAGS_DEFAULT) {
  const top = parseFields(raw);
  const asg = top.find((x) => x.field === tags.resp_assignment && x.wireType === 2);
  if (!asg) return null;
  const fields = parseFields(asg.value);
  const model_uid = strField(fields, tags.asg_model_uid);
  if (!model_uid) return null; // empty assignment
  const assignment_jwt = strField(fields, tags.asg_jwt);
  const harness_uids = fields
    .filter((x) => x.field === tags.asg_harness && x.wireType === 2)
    .map((x) => x.value.toString('utf8'));
  return { model_uid, assignment_jwt, harness_uids };
}

/**
 * Resolve a router model uid → a concrete ModelAssignment via the AssignModel
 * unary RPC. Throws a coded error on transport failure or an empty assignment so
 * the caller can fall back / surface a clean message instead of letting the
 * router uid hit GetChatMessage (where it's rejected).
 *
 * @param {object} opts
 * @param {string} [opts.cascadeId]  cascade the turn belongs to (sent as
 *   cascade_id #3; an empty string is written when omitted — the field is
 *   required on the wire)
 * @returns {Promise<{model_uid, assignment_jwt, harness_uids}>}
 */
export async function assignModel({ token, modelUid, cascadeId, signal, env = process.env } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  if (!modelUid) throw Object.assign(new Error('AssignModel: modelUid required'), { code: 'BAD_REQUEST' });
  const tags = parseAssignTags(env);
  const raw = await unaryCall(ASSIGN_MODEL_PATH, sessionToken, {
    signal,
    extraBody: encodeAssignModelRequest(modelUid, tags, cascadeId),
  });
  const assignment = decodeAssignModelResponse(raw, tags);
  if (!assignment) {
    throw Object.assign(new Error(`AssignModel returned empty assignment for '${modelUid}'`), { code: 'ASSIGN_EMPTY' });
  }
  log.info(`DEVIN_CONNECT AssignModel: router '${modelUid}' → '${assignment.model_uid}'`);
  return assignment;
}
