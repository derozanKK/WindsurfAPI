// Credential-pattern rules shared by the two scanners:
//
//   scripts/secret-scan.mjs          — the WORKING TREE (`git ls-files -co`, explicit paths)
//   scripts/history-secret-scan.mjs  — the GIT HISTORY (every blob reachable from any ref,
//                                      plus unreachable objects left by amend/rebase/force-push)
//
// They live here rather than in secret-scan.mjs because a rule added for one scope and not
// the other is a hole that looks like coverage. The history scanner runs on every push
// (`.github/workflows/ci.yml` job `history-secrets`), so the two rule sets are the same
// array, not two copies that a future edit can desynchronise.
//
// Matching semantics are also shared: `findRuleMatches()` applies the same synthetic-fixture
// exemption as the working-tree scanner, so a fixture that is legal in the tree cannot become
// a "leak" merely because it has a commit behind it.

export const RULES = [
  {
    id: 'openai-api-key',
    regex: /sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'literal-credential-assignment',
    regex: /\b(?:secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/gi,
  },
  {
    id: 'private-key-block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'credentialed-email-example',
    regex: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}["']?\s*,\s*["']?password["']?\s*:/gi,
  },
  // ── Rules below added after audit round 13 measured what the four above MISS ──
  //
  // The gap they closed: `literal-credential-assignment` requires the secret to be a
  // quoted run of [A-Za-z0-9_./+=-]. That class has no `$`. This repo's OWN native
  // session-token format is `devin-session-token$<JWT>` — so a bare JWT was caught while
  // the exact string the code actually passes around was NOT. Verified before the fix:
  // a file containing `token: "devin-session-token$eyJ...".` scanned clean, exit 0.
  //
  // These match credential STRUCTURE, not field name. Field-name matching was tried and
  // rejected: `\b(idToken|apiKey|sessionToken|...)\b\s*[:=]\s*"..."` flagged 12 files of
  // legitimate synthetic fixtures. Same trap as the switch-registry regex that reported
  // DASHBOARD_PASSWORD as a switch — loosening until it matches is not the answer.
  {
    // A JWT is three base64url segments and the first two decode to `{"`. No synthetic
    // fixture in this tree has that shape (measured: 0 hits across 696 tracked files),
    // so this needs no allow-list. Covers devin-session-token$<JWT>, Firebase idToken,
    // and any bearer/access token, wherever it appears and whatever the field is called.
    id: 'jwt-literal',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    // Session token whose payload is opaque rather than a JWT. Requires mixed case AND a
    // digit so that readable placeholders (`devin-session-token$definitely-not-in-pool`,
    // already in test/sticky-queue-on-pin.test.js) stay legal while real high-entropy
    // values do not.
    //
    // The three lookaheads are bounded by the TOKEN class, not by quotes/whitespace. They
    // used to be `[^"'\s]*`, which looked past the end of the token into the rest of the
    // line: a template literal `devin-session-token$ws-issue257-apikey-url-${Date.now()}`
    // satisfied the "has an uppercase letter" lookahead with the `D` in `Date` and then
    // matched a lowercase placeholder as a credential (measured on the history scan,
    // 2026-10-23). A token is mixed-case on its own or it is not a token.
    id: 'session-token-literal',
    regex: /devin-session-token\$(?=[A-Za-z0-9._~+/-]*[0-9])(?=[A-Za-z0-9._~+/-]*[a-z])(?=[A-Za-z0-9._~+/-]*[A-Z])[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    // Firebase refresh token. Fixed vendor prefix, so no entropy heuristic needed.
    id: 'firebase-refresh-token',
    regex: /\bAMf-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // The bulk-import account format (`email----password`). The existing
    // `credentialed-email-example` rule only sees the JSON `{email, password:}` spelling.
    id: 'account-credential-pair',
    regex: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}----\S{8,}/g,
  },
  {
    // SEC-05, measured gap: `Authorization: Bearer <key>` in a doc or example is how this
    // repository's own gateway key reached public history (`sk-dwgxnbnb`, redacted in
    // 413106e, still in every clone). `openai-api-key` needs 20+ chars after `sk-`, so an
    // 8-char key was invisible to it; and the key was indistinguishable from a placeholder
    // by entropy (all lowercase, no digits), which is exactly why a human audit — not a
    // scanner — found it. This rule uses the CONTEXT instead: a bearer credential in a
    // non-test path, minus the placeholder vocabulary that legitimately appears in docs.
    //
    // test/ is out of scope for this rule on purpose: fixtures there say `Bearer sk-…`
    // with invented values by the hundred, and a value-level skip list cannot separate
    // `sk-chat-shared` from a real short key. Long keys in tests are still caught by
    // `openai-api-key`, and every other rule still applies to test/.
    id: 'authorization-bearer-literal',
    regex: /\bBearer\s+([A-Za-z0-9._~+/-]{8,})/g,
    paths: (repoPath) => !repoPath.startsWith('test/'),
    skip: (value) => {
      const lower = value.toLowerCase();
      return ['your', 'demo', 'redacted', 'credential', 'placeholder', 'sample', 'dummy',
        'fake', 'invalid', 'xxxx', 'example', 'fixture', 'changeme', 'change-me', 'key',
        'secret', 'token'].some((marker) => lower.includes(marker));
    },
  },
  {
    // SEC-05: `.env`-style UNQUOTED assignment. `literal-credential-assignment`
    // requires the value to be quoted, so the exact spelling this project tells
    // operators to use (`API_KEY=…`, `DASHBOARD_PASSWORD=…` in .env) was never
    // scanned. Field name is env-style uppercase and ends in a credential word;
    // the value must be a bare 16+ char run with at least one digit and one
    // letter, so indirection (`process.env.API_KEY`, `${API_KEY}`) and readable
    // placeholders (`YOUR_API_KEY_HERE`) stay legal. `$`, quotes and dots are
    // excluded from the value class — that is what keeps code references out.
    id: 'unquoted-env-secret',
    regex: /(?<![A-Za-z0-9_])(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))[ \t]*=[ \t]*(?![$"'\s#])(?=[A-Za-z0-9_+=-]*[0-9])(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{16,}/g,
  },
];

// A match is a fixture only if the SECRET ITSELF advertises that it is fake. Keep this
// list tight: every entry is a hole, so it must be a shape no real credential has.
export const FIXTURE_MARKERS = [
  'fixture',        // sk-ws-01-fixturekey1234567890abcdef
  'example',
  'placeholder',
  'dummy',
  'redacted',
  'fake',
  'not-real',       // throwaway-not-real
  'not-a-real',
  'not-a-valid',    // definitely-not-a-valid-token
  'invalid',
  'throwaway',
  'test-only',
];

// Sequential digits/letters — no issued credential looks like this.
export const FIXTURE_SEQUENCES = [
  '1234567890',
  '0987654321',
  'abcdefghijklmnop',
];

// Files that DEFINE or TEST the scanner and therefore spell out key-shaped fixtures in
// their own text. Scanning them reports the definition of a rule with that rule. Shared by
// both scopes so a history finding cannot come from a file the tree scan is allowed to skip.
export const IGNORED_PATHS = new Set([
  'scripts/secret-scan.mjs',
  'scripts/secret-rules.mjs',
  'scripts/history-secret-scan.mjs',
  'test/secret-scan.test.js',
]);

export function isSyntheticFixture(repoPath, matchText) {
  if (!repoPath.startsWith('test/')) return false;
  const lower = String(matchText).toLowerCase();
  if (FIXTURE_MARKERS.some((m) => lower.includes(m))) return true;
  return FIXTURE_SEQUENCES.some((s) => lower.includes(s));
}

/**
 * Every rule match in `text`, minus the ones the fixture exemption excuses.
 *
 * Returns `{ rule, index, match }` in rule order, where `index` is the character offset of
 * the match in `text`. Line numbers are the caller's job: the working-tree scanner counts
 * newlines in a file it read, and the history scanner does the same over a blob — the same
 * function, so a finding can never be reported at a different line by the two scopes.
 */
export function findRuleMatches(text, repoPaths) {
  // `repoPaths` is one path or a list. The tree scanner passes both the lexical path and
  // the resolved one, because a fixture reached through an inside link is still a fixture;
  // the history scanner passes the path recorded for the blob. `rule.paths` is decided on
  // the first (the path the finding will be reported at).
  const paths = Array.isArray(repoPaths) ? repoPaths : [repoPaths];
  const matches = [];
  for (const rule of RULES) {
    // A rule may be scoped to paths (`paths`) or to values (`skip`) when the shape alone
    // cannot separate a credential from the placeholder vocabulary a scope legitimately
    // uses. Both predicates are declared on the rule so the two scanners cannot disagree.
    if (rule.paths && !rule.paths(paths[0])) continue;
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      if (paths.some((path) => isSyntheticFixture(path, match[0]))) continue;
      if (rule.skip && rule.skip(match[1] ?? match[0])) continue;
      matches.push({ rule: rule.id, index: match.index || 0, match: match[0] });
    }
  }
  return matches;
}

export function lineForOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
