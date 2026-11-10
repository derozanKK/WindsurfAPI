import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClaudeCodeClient,
  resolveCcCompat,
  stripCcNamespace,
  isClaudeCode,
  recordSchemaNormalized,
  recordIdentityNeutralized,
  getCcCompatStats,
  resetCcCompatStats,
  CC_CONTENT_MARKERS,
} from '../src/handlers/cc-compat.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __root = join(dirname(fileURLToPath(import.meta.url)), '..');

// cc-compat is the standalone, pluggable Claude Code compatibility layer. It
// never changes standard behavior unless a request is explicitly routed through
// /v1/cc/* (endpoint opt-in) or detected as Claude Code with the master toggle
// on. Claude Code defaults to the Anthropic protocol (/v1/messages).

describe('detectClaudeCodeClient', () => {
  it('detects Claude Code by the claude-cli User-Agent', () => {
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'claude-cli/2.1.77 (external, cli)' }), true);
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'claude-code/2.1.77 (cli)' }), true);
    assert.equal(detectClaudeCodeClient({ 'User-Agent': 'CLAUDE-CLI/1.0' }), true);
  });

  it('detects by the gateway session-id header', () => {
    assert.equal(detectClaudeCodeClient({ 'x-claude-code-session-id': 'sess_abc' }), true);
  });

  it('x-app:cli counts ONLY when paired with a claude UA (too broad alone)', () => {
    // Gemini CLI / Codex CLI also send x-app:cli, so it must not fire on its own.
    assert.equal(detectClaudeCodeClient({ 'x-app': 'cli' }), false);
    assert.equal(detectClaudeCodeClient({ 'x-app': 'CLI' }), false);
    // Paired with a claude-mentioning UA it becomes a valid combined signal.
    assert.equal(detectClaudeCodeClient({ 'x-app': 'cli', 'user-agent': 'claude/2.1' }), true);
  });

  it('does not misfire on other clients (incl. Cline, curl, browsers, other CLIs)', () => {
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'Cline/3.2.0' }), false);
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'curl/8.4.0' }), false);
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'Mozilla/5.0' }), false);
    // "claude" alone (e.g. an unrelated UA mentioning it) must not match — we
    // require the claude-cli/ or claude-code/ prefix with a version slash.
    assert.equal(detectClaudeCodeClient({ 'user-agent': 'my-claude-wrapper/1.0' }), false);
    // A different CLI client sending x-app:cli without a claude UA must not match.
    assert.equal(detectClaudeCodeClient({ 'x-app': 'cli', 'user-agent': 'gemini-cli/1.0' }), false);
    assert.equal(detectClaudeCodeClient({ 'x-app': 'web' }), false);
    assert.equal(detectClaudeCodeClient({ 'user-agent': '' }), false);
    assert.equal(detectClaudeCodeClient({}), false);
    assert.equal(detectClaudeCodeClient(null), false);
  });
});

describe('resolveCcCompat', () => {
  it('endpoint path is active even when master toggle is OFF (explicit opt-in namespace)', () => {
    const r = resolveCcCompat({ path: '/v1/cc/messages', headers: {}, masterEnabled: false });
    assert.equal(r.active, true);
    assert.equal(r.source, 'endpoint');
  });

  it('standard path with master OFF and non-CC UA is inactive (byte-identical)', () => {
    const r = resolveCcCompat({ path: '/v1/messages', headers: { 'user-agent': 'curl' }, masterEnabled: false });
    assert.equal(r.active, false);
    assert.equal(r.source, null);
  });

  it('detection path requires master ON', () => {
    const ua = { 'user-agent': 'claude-cli/2.1.77 (external, cli)' };
    const off = resolveCcCompat({ path: '/v1/messages', headers: ua, masterEnabled: false });
    assert.equal(off.active, false);
    const on = resolveCcCompat({ path: '/v1/messages', headers: ua, masterEnabled: true });
    assert.equal(on.active, true);
    assert.equal(on.source, 'detect');
  });

  it('master ON but non-CC client on standard path stays inactive (no blanket change)', () => {
    const r = resolveCcCompat({ path: '/v1/messages', headers: { 'user-agent': 'curl' }, masterEnabled: true });
    assert.equal(r.active, false);
  });

  it('endpoint source takes priority over detect (namespace wins)', () => {
    const r = resolveCcCompat({ path: '/v1/cc/messages', headers: { 'user-agent': 'claude-cli/2.1' }, masterEnabled: true });
    assert.equal(r.source, 'endpoint');
  });
});

describe('stripCcNamespace', () => {
  it('rewrites /v1/cc/* to canonical /v1/*', () => {
    assert.equal(stripCcNamespace('/v1/cc/messages'), '/v1/messages');
    assert.equal(stripCcNamespace('/v1/cc/messages/count_tokens'), '/v1/messages/count_tokens');
    assert.equal(stripCcNamespace('/v1/cc/chat/completions'), '/v1/chat/completions');
    assert.equal(stripCcNamespace('/v1/cc/models'), '/v1/models');
  });
  it('leaves non-cc paths unchanged', () => {
    assert.equal(stripCcNamespace('/v1/messages'), '/v1/messages');
    assert.equal(stripCcNamespace('/v1/cline/chat/completions'), '/v1/cline/chat/completions');
    assert.equal(stripCcNamespace('/dashboard/api/x'), '/dashboard/api/x');
  });
});

describe('isClaudeCode — single consolidated signal', () => {
  it('matches on body.metadata.user_id CC wire shape — string form (highest confidence)', () => {
    const body = { metadata: { user_id: 'user_deadbeef_account_1111-2222_session_abcd-ef01' } };
    assert.equal(isClaudeCode({ headers: {}, body }), true);
  });

  it('matches on body.metadata.user_id object form { account_uuid, session_id }', () => {
    const body = { metadata: { user_id: { device_id: 'd', account_uuid: 'a', session_id: 's' } } };
    assert.equal(isClaudeCode({ headers: {}, body }), true);
    const camel = { metadata: { user_id: { accountUuid: 'a', sessionId: 's' } } };
    assert.equal(isClaudeCode({ headers: {}, body: camel }), true);
  });

  it('requires BOTH account_ AND session_ in the string form (half-match is not enough)', () => {
    // Guards the AND contract: a bare opaque id with only one segment must not
    // be mistaken for the CC wire shape.
    assert.equal(isClaudeCode({ headers: {}, body: { metadata: { user_id: 'user_x_session_y' } } }), false);
    assert.equal(isClaudeCode({ headers: {}, body: { metadata: { user_id: 'user_x_account_y' } } }), false);
    // Object form missing one field also must not match.
    assert.equal(isClaudeCode({ headers: {}, body: { metadata: { user_id: { session_id: 's' } } } }), false);
  });

  it('matches on headers when no metadata present', () => {
    assert.equal(isClaudeCode({ headers: { 'user-agent': 'claude-cli/2.1.77 (external, cli)' }, body: {} }), true);
  });

  it('matches on system-prompt content fingerprint as a fallback', () => {
    const body = { system: "You are Claude Code, Anthropic's official CLI for Claude." };
    assert.equal(isClaudeCode({ headers: {}, body }), true);
    const arr = { system: [{ type: 'text', text: 'blah cc_version=2.1.77 blah' }] };
    assert.equal(isClaudeCode({ headers: {}, body: arr }), true);
  });

  it('does not match unrelated requests', () => {
    assert.equal(isClaudeCode({ headers: { 'user-agent': 'curl' }, body: { system: 'You are a helpful assistant.' } }), false);
    assert.equal(isClaudeCode({ headers: {}, body: { metadata: { user_id: 'plain-string' } } }), false);
    assert.equal(isClaudeCode({ headers: {}, body: null }), false);
    assert.equal(isClaudeCode({}), false);
  });
});

describe('CC_CONTENT_MARKERS — single source of truth (no drift with client.js)', () => {
  it('client.js imports the shared constant instead of an inline copy', () => {
    // The whole point of this module is to kill the divergent "is this CC?"
    // heuristics. Assert client.js references CC_CONTENT_MARKERS and no longer
    // carries its own inline Anthropic-CLI regex literal.
    const clientSrc = readFileSync(join(__root, 'src/client.js'), 'utf8');
    assert.match(clientSrc, /CC_CONTENT_MARKERS/, 'client.js must import/use the shared marker');
    assert.doesNotMatch(
      clientSrc,
      /\/Anthropic's official CLI for Claude\|Claude Code\|cc_version=/,
      'client.js must not keep its own inline copy of the marker regex',
    );
  });

  it('covers every historical Claude Code marker (case-insensitive)', () => {
    for (const s of [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'ANTHROPIC\'S OFFICIAL CLI FOR CLAUDE',
      'blah Claude Code blah',
      'cc_version=2.1.77',
      'a content_block here',
      'a tool_use block',
      '<env>cwd: /x</env>',
    ]) {
      assert.ok(CC_CONTENT_MARKERS.test(s), `marker regex should match: ${s}`);
    }
    assert.equal(CC_CONTENT_MARKERS.test('You are a helpful assistant.'), false);
  });
});

describe('cc-compat stats', () => {
  beforeEach(() => resetCcCompatStats());

  it('counts schema normalizations and identity neutralizations independently', () => {
    assert.deepEqual(getCcCompatStats(), {
      schemaNormalized: 0,
      identityNeutralized: 0,
      toolDeferLoadingHonored: 0,
      toolDeferLoadingIgnored: 0,
    });
    recordSchemaNormalized();
    recordSchemaNormalized();
    recordIdentityNeutralized();
    assert.deepEqual(getCcCompatStats(), {
      schemaNormalized: 2,
      identityNeutralized: 1,
      toolDeferLoadingHonored: 0,
      toolDeferLoadingIgnored: 0,
    });
  });
});
