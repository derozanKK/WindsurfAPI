// Devin's upstream backend hard-rejects (529 overloaded_error / internal error)
// any request whose system prompt announces "You are Claude Code, Anthropic's
// official CLI for Claude." — a client fingerprint / anti-competitor gate,
// CONFIRMED 2026-07-08 by ablation (one-word flip toggles 529↔200, all models).
// neutralizeClientIdentity rewrites only that self-ID line so the request serves.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeClientIdentity } from '../src/handlers/messages.js';

afterEach(() => {
  delete process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID;
  delete process.env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE;
  delete process.env.WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE;
});

describe('neutralizeClientIdentity', () => {
  it('rewrites the exact Claude Code self-identification', () => {
    const out = neutralizeClientIdentity("You are Claude Code, Anthropic's official CLI for Claude.");
    assert.ok(!/Claude Code/.test(out), 'no Claude Code');
    assert.ok(!/Anthropic/.test(out), 'no Anthropic');
    assert.match(out, /AI coding assistant/);
  });

  it('handles a curly/straight apostrophe and trailing text', () => {
    const src = "You are Claude Code, Anthropic’s official CLI for Claude. You help with tasks.";
    const out = neutralizeClientIdentity(src);
    assert.ok(!/Claude Code/.test(out));
    assert.match(out, /You help with tasks\./, 'user instruction preserved');
  });

  it('neutralizes the phrase even without the leading "You are"', () => {
    const out = neutralizeClientIdentity("Note: Claude Code, Anthropic's official CLI for Claude, is running.");
    assert.ok(!/official CLI for Claude/.test(out));
  });

  it('leaves unrelated mentions of the words alone (only the ID phrase is rewritten)', () => {
    // Bare mentions are safe (ablation: standalone "Anthropic"/"Claude Code" → 200),
    // so we must NOT scrub general text — only the exact self-ID phrasing.
    const src = 'Use the Anthropic SDK. The Claude Code style guide applies.';
    const out = neutralizeClientIdentity(src);
    assert.equal(out, src, 'unrelated text untouched');
  });

  it('is a no-op on empty/undefined', () => {
    assert.equal(neutralizeClientIdentity(''), '');
    assert.equal(neutralizeClientIdentity(undefined), undefined);
  });

  it('can be disabled via WINDSURFAPI_NEUTRALIZE_CLIENT_ID=0', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const src = "You are Claude Code, Anthropic's official CLI for Claude.";
    assert.equal(neutralizeClientIdentity(src), src, 'opt-out leaves it verbatim');
  });

  // 401 abuse-content gate: the dense security-policy paragraph.
  const SEC = "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

  it('neutralizes the security-policy paragraph (drops the trigger vocabulary)', () => {
    const out = neutralizeClientIdentity('You are an interactive agent.\n\n' + SEC + '\n\n# Harness');
    // trigger terms Devin flags must be gone
    ['security testing', 'CTF', 'DoS attacks', 'supply chain', 'detection evasion', 'C2 frameworks', 'credential testing', 'exploit development'].forEach(function (t) {
      assert.ok(!out.includes(t), 'trigger term removed: ' + t);
    });
    // surrounding content preserved
    assert.ok(out.includes('You are an interactive agent.'), 'preamble before kept');
    assert.ok(out.includes('# Harness'), 'content after kept');
    // benign replacement present
    assert.match(out, /malicious or harmful/i);
  });

  it('leaves a system prompt without the security paragraph untouched', () => {
    const src = 'You are a coding assistant. Help with the task.';
    assert.equal(neutralizeClientIdentity(src), src);
  });

  it('security-paragraph neutralization also respects the opt-out flag', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    assert.equal(neutralizeClientIdentity(SEC), SEC);
  });

  // 2026-07-10 (a2/a3): Claude Code 2.1.204 sdk-cli entrypoint. Live A/B on the
  // Devin upstream proved this exact identity line trips the content policy
  // (permission_denied); neutralizing it + stripping the billing header lets the
  // same heavy request through. This is the DEVIN_CONNECT-egress fix.
  it('rewrites the Agent-SDK / sdk-cli self-identification line', () => {
    const out = neutralizeClientIdentity("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    assert.ok(!/Claude agent/i.test(out), 'no "Claude agent"');
    assert.ok(!/Anthropic/i.test(out), 'no Anthropic');
    assert.match(out, /AI coding assistant/);
  });

  it('handles the curly apostrophe in the Agent-SDK line', () => {
    const out = neutralizeClientIdentity("You are a Claude agent, built on Anthropic’s Claude Agent SDK.");
    assert.ok(!/Claude agent/i.test(out));
    assert.match(out, /AI coding assistant/);
  });

  it('strips the x-anthropic-billing-header competitor-fingerprint line', () => {
    const src = "x-anthropic-billing-header: cc_version=2.1.204.5d3; cc_entrypoint=sdk-cli;\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\nCWD: /tmp";
    const out = neutralizeClientIdentity(src);
    assert.ok(!/x-anthropic-billing-header/i.test(out), 'billing header line removed');
    assert.ok(!/cc_version|cc_entrypoint/i.test(out), 'billing fingerprint gone');
    assert.ok(!/Claude agent/i.test(out), 'identity neutralized too');
    assert.match(out, /CWD: \/tmp/, 'benign context preserved');
  });

  it('the Agent-SDK neutralization respects the opt-out flag', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const src = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    assert.equal(neutralizeClientIdentity(src), src);
  });

  // 2026-07-10 (a4): the Environment "brand block" in Claude Code's interactive
  // system prompt trips Devin's content policy (400). Bisected live to the
  // Claude-Code product blurb + Claude model-ID catalogue. Neutralize them.
  it('neutralizes the Claude Code product blurb in the Environment block', () => {
    const src = ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).\n - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.8/4.7.';
    const out = neutralizeClientIdentity(src);
    assert.ok(!/Claude Code/i.test(out), 'no "Claude Code"');
    assert.ok(!/claude\.ai\/code/i.test(out), 'no claude.ai/code URL');
  });

  it('strips the Claude model-ID catalogue', () => {
    const src = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'. When building AI applications, default to the latest and most capable Claude models.";
    const out = neutralizeClientIdentity(src);
    assert.ok(!/Model IDs/i.test(out) && !/claude-fable-5/i.test(out), 'model catalogue removed');
  });

  it('strips a "You are powered by the model ..." self-fingerprint line', () => {
    const src = ' - You are powered by the model claude-5-fable-max.\n - Next line kept.';
    const out = neutralizeClientIdentity(src);
    assert.ok(!/powered by the model/i.test(out), 'powered-by line removed');
    assert.match(out, /Next line kept/, 'surrounding content preserved');
  });

  // 2026-07-15 (a5): Cline's system prompt opens with a capability-boast identity
  // sentence — "You are Cline, a highly skilled software engineer with extensive
  // knowledge in many programming languages, frameworks, design patterns, and best
  // practices." Live A/B bisection on the Devin upstream (homecloud, v3.4.0) proved
  // this exact sentence trips the content policy (permission_denied / 400): dropping
  // the "highly skilled … best practices" capability clause flips it to 200, while
  // swapping only the name "Cline" does NOT (the boast phrasing is the trigger, not
  // the brand). Rewrite it to a plain role line; the model keeps its "Cline" identity.
  const CLINE_ID = 'You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.';

  it('neutralizes the Cline capability-boast identity sentence', () => {
    const out = neutralizeClientIdentity(CLINE_ID + '\n\nTOOL USE\n\nYou have access to a set of tools.');
    assert.ok(!/highly skilled software engineer with extensive knowledge/i.test(out), 'capability boast removed');
    assert.ok(!/design patterns, and best practices/i.test(out), 'boast tail removed');
    // surrounding prompt preserved
    assert.match(out, /TOOL USE/, 'rest of prompt kept');
    assert.match(out, /You have access to a set of tools\./, 'content after kept');
    // the rewritten line is a well-formed identity ("You are ..."), not empty
    assert.match(out, /^You are /, 'still opens with an identity line');
  });

  it('the Cline neutralization respects the opt-out flag', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    assert.equal(neutralizeClientIdentity(CLINE_ID), CLINE_ID);
  });

  it('does not touch an unrelated "You are X, a software engineer" line (only the boast phrasing)', () => {
    const src = 'You are Cline, a software engineer. Help with the task.';
    assert.equal(neutralizeClientIdentity(src), src, 'plain role line untouched');
  });

  // 2026-07-15 (a6-cline-obj): SPECULATIVE / HYPOTHESIS-ONLY, DEFAULT-OFF. The OBJECTIVE
  // section's "Remember, you have extensive capabilities …" boast sentence is only
  // SUSPECTED to share the a5 content-policy trigger family — NOT live-verified
  // (Devin's policy is non-deterministic, so no reliable A/B). Gated behind an
  // opt-in flag WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE=1 and shipped OFF. The main
  // WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch (default on) still wraps the whole
  // function, so a6-cline-obj runs only when the main switch is on AND the a6-cline-obj flag === '1'.
  const OBJECTIVE_BOAST = 'Remember, you have extensive capabilities with access to a wide range of tools that can be used in powerful and clever ways as necessary to accomplish each goal.';
  const CAPABILITIES_BULLET = "- You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, and more.";
  // A realistic OBJECTIVE snippet: a sentence before, the boast, and a numbered step after.
  const OBJECTIVE_BLOCK =
    'You accomplish a given task iteratively, breaking it down into clear steps.\n' +
    OBJECTIVE_BOAST + '\n' +
    '1. Analyze the user\'s task and set clear, achievable goals.';

  it('(a6-cline-obj) DEFAULT-OFF: the OBJECTIVE boast sentence is byte-equivalent passthrough (regression lock)', () => {
    // Flag unset → speculative rule must NOT fire. Critical default-off guarantee.
    assert.equal(process.env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE, undefined, 'flag unset by default');
    assert.equal(neutralizeClientIdentity(OBJECTIVE_BLOCK), OBJECTIVE_BLOCK, 'unchanged when flag off');
  });

  it('(a6-cline-obj) flag=1: rewrites the OBJECTIVE boast and preserves surrounding text', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE = '1';
    const out = neutralizeClientIdentity(OBJECTIVE_BLOCK);
    assert.ok(!/extensive capabilities with access to a wide range of tools/i.test(out), 'boast removed');
    assert.match(out, /Use the available tools as needed to accomplish each goal\./, 'rewritten line present');
    assert.match(out, /You accomplish a given task iteratively, breaking it down into clear steps\./, 'sentence before preserved');
    assert.match(out, /1\. Analyze the user's task and set clear, achievable goals\./, 'numbered step after preserved');
  });

  it('(a6-cline-obj) flag=1: does NOT touch the CAPABILITIES "execute CLI commands" bullet', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE = '1';
    const src = CAPABILITIES_BULLET + '\n' + OBJECTIVE_BOAST;
    const out = neutralizeClientIdentity(src);
    assert.ok(out.includes(CAPABILITIES_BULLET), 'CAPABILITIES bullet left intact');
    assert.ok(out.includes("execute CLI commands on the user's computer"), 'functional description untouched');
  });

  it('(a6-cline-obj) is gated by the main off-switch too: main switch off → early return, boast unchanged even with a6 flag on', () => {
    // The function early-returns when WINDSURFAPI_NEUTRALIZE_CLIENT_ID==='0', so
    // a6-cline-obj cannot run regardless of its own flag. Assert the ACTUAL control flow.
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    process.env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE = '1';
    assert.equal(neutralizeClientIdentity(OBJECTIVE_BLOCK), OBJECTIVE_BLOCK, 'main off-switch wins; a6-cline-obj does not run');
  });

  // 2026-07-20 (a7): codex apply_patch tool-DESCRIPTION content-policy trigger,
  // live-bisected 7/7 by @forrinzhao (PR #219). apply_patch's description carries
  // "FREEFORM tool, so do not wrap the patch in JSON." which trips Devin's content
  // policy once the tool-description preamble is injected into the system prompt on
  // the native path. Live A/B: BOTH fragments must change. Live-confirmed → runs
  // unconditionally on the main WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch.
  const APPLY_PATCH_DESC = 'This is a FREEFORM tool, so do not wrap the patch in JSON. Provide the diff directly.';

  it('(a7) rewrites both codex apply_patch content-policy trigger fragments', () => {
    const out = neutralizeClientIdentity(APPLY_PATCH_DESC);
    assert.ok(!/FREEFORM/.test(out), 'FREEFORM token gone');
    assert.ok(!/do not wrap the patch in JSON\./.test(out), 'JSON-wrap fragment gone');
    assert.match(out, /free-form/, 'reworded to free-form');
    assert.match(out, /provide the patch as plain text\./, 'reworded JSON-wrap fragment');
    assert.match(out, /Provide the diff directly\./, 'surrounding description preserved');
  });

  it('(a7) is idempotent — a second pass is a no-op', () => {
    const once = neutralizeClientIdentity(APPLY_PATCH_DESC);
    assert.equal(neutralizeClientIdentity(once), once, 'already-neutralized text unchanged');
  });

  it('(a7) leaves a normal tool description without the trigger untouched', () => {
    const src = 'Apply a unified-diff patch to a file. Provide the diff as an argument.';
    assert.equal(neutralizeClientIdentity(src), src, 'unrelated description untouched');
  });

  it('(a7) respects the main off-switch', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    assert.equal(neutralizeClientIdentity(APPLY_PATCH_DESC), APPLY_PATCH_DESC, 'opt-out leaves it verbatim');
  });

  // 2026-10-24 (a8): Claude Code subagent system-prompt trigger, live-bisected via
  // /v1/messages replay (Claude Code 2.1.310). Every subagent prompt carries the
  // Notes bullet below; that sentence alone blocks (permission_denied), and the
  // full subagent request with only MUST -> should passed 3/3. Near-miss variants
  // that passed live are pinned as untouched so the rule stays sentence-anchored.
  const SUBAGENT_NOTES = [
    'Notes:',
    '- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.',
    '- For clear communication with the user the assistant MUST avoid using emojis.',
    '- Do not use a colon before tool calls.',
  ].join('\n');

  it('(a8) rewrites the Claude Code subagent emoji bullet and keeps the rest of the block', () => {
    const out = neutralizeClientIdentity(SUBAGENT_NOTES);
    assert.ok(!/the assistant MUST avoid using emojis/.test(out), 'trigger sentence gone');
    assert.match(out, /^- For clear communication with the user the assistant should avoid using emojis\.$/m, 'instruction kept with should');
    assert.match(out, /^- Agent threads always have their cwd reset/m, 'preceding bullet preserved');
    assert.match(out, /^- Do not use a colon before tool calls\.$/m, 'following bullet preserved');
  });

  it('(a8) is idempotent — a second pass is a no-op', () => {
    const once = neutralizeClientIdentity(SUBAGENT_NOTES);
    assert.equal(neutralizeClientIdentity(once), once, 'already-neutralized text unchanged');
  });

  it('(a8) leaves the near-miss variants that passed live untouched', () => {
    for (const src of [
      'The assistant MUST avoid using emojis.',
      'For clear communication with the user, avoid using emojis.',
      'For clear communication with the user the assistant should avoid using emojis.',
    ]) {
      assert.equal(neutralizeClientIdentity(src), src, `untouched: ${src}`);
    }
  });

  it('(a8) respects the main off-switch', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    assert.equal(neutralizeClientIdentity(SUBAGENT_NOTES), SUBAGENT_NOTES, 'opt-out leaves it verbatim');
  });
});

// 2026-07-16 (a6-grok/a6-grok2): Grok CLI's system prompt opens with "You are
// Grok 4.5 released by xAI. You are an interactive CLI tool that helps users
// with software engineering tasks." Live A/B on the Devin upstream proved that
// exact self-ID line trips the content policy (permission_denied); the same
// request with a generic assistant line passes. The competitor-specific
// <executing_actions_with_care> safety paragraph rides in the same blocked
// prompt body and is stripped whole. Both rules are unconditional like a1-a5,
// gated only by the main WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch (default on).
describe('neutralizeClientIdentity — Grok / xAI rules (a6-grok)', () => {
  const GROK_ID = 'You are Grok 4.5 released by xAI.';

  it('rewrites the exact Grok self-identification', () => {
    const out = neutralizeClientIdentity(GROK_ID + ' You are an interactive CLI tool that helps users with software engineering tasks.');
    assert.ok(!/Grok/.test(out), 'no Grok');
    assert.ok(!/xAI/.test(out), 'no xAI');
    assert.match(out, /^You are an AI coding assistant\./, 'opens with the generic identity line');
    assert.match(out, /You are an interactive CLI tool that helps users with software engineering tasks\./, 'rest of prompt preserved');
  });

  it('neutralizes the bare noun phrase without the leading "You are"', () => {
    const out = neutralizeClientIdentity('Note: Grok 4 released by xAI is running.');
    assert.ok(!/Grok/.test(out), 'no Grok');
    assert.ok(!/released by xAI/i.test(out), 'no xAI attribution');
    assert.match(out, /an AI coding assistant\./, 'generic noun phrase substituted');
  });

  it('matches any Grok version variant (4.5.1, 3 mini, ...)', () => {
    assert.equal(
      neutralizeClientIdentity('You are Grok 4.5.1 released by xAI.'),
      'You are an AI coding assistant.',
    );
    assert.equal(
      neutralizeClientIdentity('You are Grok 3 mini released by xAI.'),
      'You are an AI coding assistant.',
    );
  });

  it('strips the <executing_actions_with_care> block entirely', () => {
    const out = neutralizeClientIdentity('<executing_actions_with_care>foo bar</executing_actions_with_care>');
    assert.equal(out, '', 'inline block fully removed');
  });

  it('strips a multiline <executing_actions_with_care> block and keeps surrounding text', () => {
    const src = 'Before.\n<executing_actions_with_care>\nfoo bar\nDouble-check destructive commands before running them.\n</executing_actions_with_care>\nAfter.';
    const out = neutralizeClientIdentity(src);
    assert.ok(!/executing_actions_with_care/i.test(out), 'tags removed');
    assert.ok(!/foo bar/.test(out), 'block content removed');
    assert.ok(!/destructive commands/.test(out), 'multiline content removed');
    assert.match(out, /Before\./, 'content before kept');
    assert.match(out, /After\./, 'content after kept');
  });

  it('leaves unrelated mentions of "Grok" alone (no "released by xAI" attribution)', () => {
    // Bare mentions are safe — only the xAI-attributed self-ID phrasing is rewritten.
    const src = 'Use the Logstash grok filter. Grok patterns parse logs.';
    assert.equal(neutralizeClientIdentity(src), src, 'unrelated text untouched');
    const plainId = 'You are Grok, a helpful assistant.';
    assert.equal(neutralizeClientIdentity(plainId), plainId, 'un-attributed identity line untouched');
  });

  it('the Grok neutralization respects the opt-out flag', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const src = GROK_ID + '\n<executing_actions_with_care>Take care.</executing_actions_with_care>';
    assert.equal(neutralizeClientIdentity(src), src, 'opt-out leaves it verbatim');
  });
});

// P2 — Claude Code compat layer: the ccActive gate on the opt-in (cc) block.
// Contract: a1-a5 stay UNCONDITIONAL (default 529 / content-policy defense for
// ALL clients); the (cc) block is opt-in and currently EMPTY, so activating it
// must NOT change output today. This locks both the byte-equivalence of the
// default path and the "empty hook" state so a future rule addition is deliberate.
describe('neutralizeClientIdentity — ccActive gate (P2)', () => {
  const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude.";
  const PLAIN = 'You are an interactive agent that helps with software tasks.';

  it('a1-a5 run regardless of ccActive (unconditional 529/content-policy defense)', () => {
    // The Claude Code self-ID (a1) must be neutralized whether or not the CC
    // compat layer is active — it is the default defense line, not a CC dial.
    const off = neutralizeClientIdentity(CC_ID, process.env, { ccActive: false });
    const on = neutralizeClientIdentity(CC_ID, process.env, { ccActive: true });
    assert.ok(!/Claude Code/.test(off), 'a1 fires with ccActive:false');
    assert.ok(!/Claude Code/.test(on), 'a1 fires with ccActive:true');
    assert.equal(off, on, 'a1-a5 output identical regardless of ccActive');
  });

  it('the (cc) block is EMPTY today: ccActive true vs false is byte-identical', () => {
    // Guards against a future accidental UNVERIFIED CC rewrite. If someone adds a
    // rule to the (cc) block without proof, this test must be updated deliberately.
    const src = PLAIN + '\n' + CC_ID + '\nRemember to be helpful.';
    assert.equal(
      neutralizeClientIdentity(src, process.env, { ccActive: true }),
      neutralizeClientIdentity(src, process.env, { ccActive: false }),
      'cc block empty → activation is a no-op on output',
    );
  });

  it('default opts ({}) is byte-identical to the pre-P2 two-arg call', () => {
    // The new third param must default such that every existing caller is
    // unchanged. Compare explicit ccActive:false against omitting opts entirely.
    const src = PLAIN + '\n' + CC_ID;
    assert.equal(
      neutralizeClientIdentity(src, process.env),
      neutralizeClientIdentity(src, process.env, { ccActive: false }),
      'omitting opts == ccActive:false',
    );
  });

  it('the env opt-in WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE also reaches the (cc) block (currently no-op)', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE = '1';
    const src = PLAIN + '\n' + CC_ID;
    // Empty block → still a no-op, but this proves the env path is wired for the
    // day a verified rule lands.
    const withEnv = neutralizeClientIdentity(src, process.env, { ccActive: false });
    delete process.env.WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE;
    const without = neutralizeClientIdentity(src, process.env, { ccActive: false });
    assert.equal(withEnv, without, 'env opt-in is a no-op while (cc) block is empty');
  });
});
