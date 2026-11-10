/**
 * Backend router — makes the implicit "which backend" decision explicit.
 *
 * Historically the backend choice was scattered across handlers/chat.js and
 * special-agent.js as inline branches. This module centralizes that decision
 * into one pure function so the multi-backend migration (Cascade ↔ Devin) has
 * a single, testable seam.
 *
 * BEHAVIOUR-PRESERVING: as of P1 this returns exactly what the inline logic in
 * chat.js:1789-1806 produced. No new routing is introduced yet — Devin REST is
 * defined as a backend constant but only selected when explicitly enabled via
 * env, which defaults OFF. Later phases (P2/P3) extend selectBackend() with
 * entitlement + availability inputs without touching the call sites.
 *
 * Decision order (matches legacy):
 *   1. modelInfo.backend === 'special_agent'         → BACKEND.DEVIN_ACP / DEVIN_PRINT
 *      (the special-agent path; its sub-mode comes from DEVIN_CLI_MODE)
 *   2. modelUid (string) OR enumValue > 0             → BACKEND.CASCADE
 *   3. otherwise                                       → BACKEND.LEGACY
 */

import { getBackendSwitch } from './runtime-config.js';

export const BACKEND = Object.freeze({
  CASCADE: 'cascade',        // Connect-RPC → server.codeium.com (StartCascade flow)
  LEGACY: 'legacy',          // RawGetChatMessage (deprecated, enum-only models)
  DEVIN_ACP: 'devin-acp',    // Devin CLI ACP over stdio (special-agent, mode=acp)
  DEVIN_PRINT: 'devin-print',// Devin CLI print mode (special-agent, mode=print)
  DEVIN_REST: 'devin-rest',  // Devin DRS REST → api.devin.ai (P2+, not yet wired)
  DEVIN_CONNECT: 'devin-connect', // Direct cloud GetChatMessage over pure HTTP
                                  // (no local CLI) → server.codeium.com. See
                                  // src/devin-connect.js + devin-connect-openai.js.
});

/**
 * Is the given model info routed to the special-agent (Devin CLI) backend?
 * Mirrors special-agent.js isSpecialAgentModelInfo without importing it, to
 * keep this module free of side effects.
 */
function isSpecialAgentInfo(modelInfo) {
  return modelInfo?.backend === 'special_agent';
}

function specialAgentEnabled(env = process.env) {
  if (getBackendSwitch('devinOnly', env)) return true;
  const backend = String(env?.WINDSURFAPI_SPECIAL_AGENT_BACKEND || '').trim().toLowerCase();
  return backend === 'devin-cli' || env?.DEVIN_CLI_ENABLED === '1';
}

// SKUs Cascade rejects with "This model is only in Devin Local": the gpt-5.6
// luna/sol/terra family and the gpt-6 luna/sol/astra (+ 6.1 sol) family. The
// effort tier and the -priority lane suffix are optional, matching the catalog
// names in models.js. Anchored to the family names so lookalikes (gpt-5.60,
// gpt-6-lunar, gpt-60-*) never hijack routing. swe-2* is catalogued as
// backend: 'special_agent' and is handled by that branch.
const DEVIN_LOCAL_ONLY_SKU = /^(?:(?:gpt-5[.-]6|gpt5[.-]6)-(?:luna|sol|terra)|(?:gpt-6|gpt6)(?:[.-]1)?-(?:luna|sol|astra))(?:-(?:none|low|medium|high|xhigh|max)(?:-priority)?)?$/;

function isDevinLocalOnlyModel(modelInfo) {
  return [modelInfo?.name, modelInfo?.modelUid].some((k) => DEVIN_LOCAL_ONLY_SKU.test(String(k || '').trim().toLowerCase()));
}

/**
 * Resolve the Devin CLI sub-mode (acp vs print). Defaults to print — the same
 * conservative default special-agent.js uses.
 */
function devinCliMode(env = process.env) {
  // runtime-config override wins; env is the fallback (getBackendSwitch handles
  // the 'acp'|'print' resolution + historical 'print' default).
  return getBackendSwitch('devinCliMode', env) === 'acp' ? BACKEND.DEVIN_ACP : BACKEND.DEVIN_PRINT;
}

/**
 * DEVIN_ONLY kill-switch. When set, Cascade is fully retired and EVERY request
 * — regardless of model — is routed through the Devin CLI special-agent
 * backend. This is the "Devin is the only core" mode for after the Cascade
 * upstream is decommissioned. Defaults OFF, so behaviour is unchanged until an
 * operator flips it.
 *
 * NOTE (model selection is settled; per-account serving is not): routing a model like
 * claude-4.5-sonnet here makes Devin the *nominal* backend. The ACP path passes that model
 * to the CLI launch as `devin acp --model <key>` (devin-acp.js:530-531) and ALSO adds a
 * prompt-side hint alongside it (devin-acp.js:579-582). The CLI's `--model` **does** switch
 * the underlying core, and the name is resolved server-side — but in TWO different places, and
 * merging them into one is the wrong reading: **router-style names** (the `adaptive` /
 * `arena-*` family) resolve through the AssignModel RPC — its own log line is literally
 * `Resolving model router '' via AssignModel RPC` and its method path is
 * `/exa.api_server_pb.ApiServerService/AssignModel` — while **ordinary fuzzy names** (the
 * family slug / alias / partial name vocabulary the CLI's help promises, "the same fuzzy
 * names as /model") are matched against the **server-side model catalog**
 * (`GetCliModelConfigs`); the binary carries no local name→uid table (whether every fuzzy name
 * takes that path is beyond static evidence). That a `--model` value is
 * resolved rather than ignored is also carried by a runtime string: `devin acp --model` value
 * did not resolve to an available model → falls back to the configured `agent.model`
 * (file offset 0x80051f0). A prompt hint cannot produce server-side resolution, and the client
 * never resolves a uid locally (old ledger §1c:
 * extra-hands/RESEARCH/windsurfapi-verification-ledger-2026-10-01.md; corrected attribution +
 * new strings: board ACPMAP, windsurf-re-20261015/derived/acpmap/L-ASSIGNMODEL.md §5.10/§6).
 * So model selection is a routing change, not a capability gap. Honest boundary: the last hop is
 * not statically provable — that the downstream inference request really carries the switched
 * model needs one live ACP session — and whether a given account can *serve* a specific model
 * (entitlement) stays live-only; the tool layer remains the real gap: special-agent.js:804
 * hard-400s any request carrying caller-local tools[].
 */
function devinOnlyEnabled(env = process.env) {
  return getBackendSwitch('devinOnly', env);
}

/**
 * DEVIN_CONNECT kill-switch. When set, every request is served by the direct
 * cloud GetChatMessage path (src/devin-connect.js) — pure HTTP to
 * server.codeium.com with NO local Devin CLI subprocess. This is the deploy
 * mode for hosts that have the Windsurf session token but can't (or shouldn't)
 * run the CLI. Defaults OFF.
 *
 * Wins over DEVIN_ONLY (CLI) and all model-based routing: when an operator opts
 * into the pure-HTTP egress they mean it for the whole process. The model name
 * still flows through unchanged so devin-connect maps it to the upstream
 * selector (field #21). Verified working on a free account with swe-1-6-* (see
 * memory: devin-connect-WORKING-recipe-2026-06-30); claude-* selectors are
 * gated on a paid-account probe.
 */
function devinConnectEnabled(env = process.env) {
  return getBackendSwitch('devinConnect', env);
}

/**
 * Select the backend for a request. Pure function — no I/O, no mutation.
 *
 * @param {object} params
 * @param {object|null} params.modelInfo  resolved model catalog entry
 * @param {object} [params.env]           env source (injectable for tests)
 * @returns {{ backend: string, reason: string, flow: 'special_agent'|'cascade'|'legacy' }}
 */
export function selectBackend({ modelInfo = null, env = process.env } = {}) {
  // DEVIN_CONNECT: pure-HTTP cloud egress retires both Cascade AND the local
  // CLI. Highest precedence — an operator who flips this wants every request on
  // the direct GetChatMessage path regardless of model or DEVIN_ONLY.
  if (devinConnectEnabled(env)) {
    return {
      backend: BACKEND.DEVIN_CONNECT,
      reason: 'devin_connect',
      flow: 'devin_connect',
    };
  }

  // DEVIN_ONLY: Cascade is retired — force every request onto Devin. This wins
  // over all model-based routing below. The sub-mode (acp/print) still comes
  // from DEVIN_CLI_MODE so the existing runner selection is preserved.
  if (devinOnlyEnabled(env)) {
    return {
      backend: devinCliMode(env),
      reason: 'devin_only',
      flow: 'special_agent',
    };
  }

  if (isSpecialAgentInfo(modelInfo)) {
    return {
      backend: devinCliMode(env),
      reason: 'modelInfo.backend=special_agent',
      flow: 'special_agent',
    };
  }

  if (specialAgentEnabled(env) && isDevinLocalOnlyModel(modelInfo)) {
    return {
      backend: devinCliMode(env),
      reason: 'devin_local_only',
      flow: 'special_agent',
    };
  }

  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  if (modelUid || modelEnum) {
    return { backend: BACKEND.CASCADE, reason: modelUid ? 'modelUid' : 'enumValue', flow: 'cascade' };
  }

  return { backend: BACKEND.LEGACY, reason: 'no-uid-no-enum', flow: 'legacy' };
}

/**
 * Convenience: does this selection use the Cascade Connect-RPC flow? Call sites
 * in chat.js currently compute `useCascade = !!(modelUid || modelEnum)`; this
 * keeps that exact semantics so the router can be dropped in without behaviour
 * change.
 */
export function usesCascadeFlow(selection) {
  return selection?.flow === 'cascade';
}

export const __testing = { isSpecialAgentInfo, devinCliMode, devinOnlyEnabled, devinConnectEnabled };
