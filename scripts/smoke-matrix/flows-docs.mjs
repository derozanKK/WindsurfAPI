/**
 * Smoke-matrix family: docs.
 *
 * The documentation set carries claims about itself (the live handoff names the
 * current release, every archived handoff points at the live head, a version
 * link resolves to that version's notes). Those were enforced by discipline and
 * failed repeatedly, so test/docs-consistency-guard.test.js now settles the
 * mechanical ones — including the 3.9.54 rule (df4f915) that the live handoff's
 * §0 block may not name a superseded tag/package version twelve releases behind
 * package.json, and that a banner's VISIBLE text must match its href.
 *
 * A guard that is green because it stopped looking is worse than no guard, so
 * this family asserts both halves:
 *
 *   - the guard RUNS and passes on the tree being released (its self-test cases
 *     must be part of that run — they feed known-bad banners and version claims
 *     to the same detectors, so a detector that silently stopped detecting
 *     fails here);
 *   - the version the RUNNING server reports agrees with package.json and with
 *     the live handoff's current-state block — the one link the file-only guard
 *     cannot see.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARD = 'test/docs-consistency-guard.test.js';
const LIVE_HANDOFF = 'docs/HANDOFF-2026-10-15.md';
const TIMEOUT_MS = 120_000;

function run(command, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, error: err, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, error: null, stdout, stderr, timedOut });
    });
  });
}

/** `ℹ tests 44` (spec reporter) or `# tests 44` (TAP) — never anchored on the marker. */
function counter(output, name) {
  const match = output.match(new RegExp(`\\b${name}\\s+(\\d+)\\s*$`, 'm'));
  return match ? Number(match[1]) : null;
}

/** The first fenced block of the live handoff's §0 (the retained snapshot is outside it). */
function liveStateBlock(markdown) {
  const start = markdown.indexOf('## 0.');
  if (start < 0) return '';
  const fence = markdown.indexOf('```', start);
  if (fence < 0) return '';
  const end = markdown.indexOf('```', fence + 3);
  if (end < 0) return '';
  return markdown.slice(fence + 3, end);
}

export function registerDocsFlows(ctx) {
  const { http, requireThat, addFlow } = ctx;

  addFlow('docs', 'docs.guard-passes-with-self-tests', async () => {
    const result = await run(process.execPath, ['--test', GUARD]);
    const output = `${result.stdout}\n${result.stderr}`;
    requireThat(result.error === null, `failed to spawn the guard: ${result.error?.message || 'unknown'}`);
    requireThat(!result.timedOut, `the guard did not finish within ${TIMEOUT_MS} ms`);
    requireThat(result.code === 0, `the doc-drift guard exited ${result.code}\n${output.slice(-4000)}`);

    const tests = counter(output, 'tests');
    const pass = counter(output, 'pass');
    const fail = counter(output, 'fail');
    requireThat(tests !== null && pass !== null && fail !== null, 'the guard printed no test summary');
    requireThat(fail === 0, `${fail} doc guard assertion(s) failed`);
    requireThat(pass === tests, `${pass} of ${tests} guard assertions passed`);
    requireThat(tests >= 40, `only ${tests} guard assertions ran; the guard lost coverage`);

    // Negative control: the detectors are exercised against known-bad inputs in
    // the same run. A green run without them proves nothing.
    const selfTests = (output.match(/self-test:/g) || []).length;
    requireThat(selfTests >= 3, `the guard ran ${selfTests} self-test case(s); drift detection is unproven`);
    for (const name of [
      'version claims match the repository',
      'the text/href detector rejects the banner shape',
      'the detectors reject known-bad inputs',
    ]) {
      requireThat(output.includes(name), `the guard no longer runs "${name}"`);
    }
    return `${tests} assertions green, ${selfTests} self-test cases`;
  });

  addFlow('docs', 'docs.live-version-agrees-with-build', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    requireThat(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version ${pkg.version}`);

    const health = await http('GET', '/health', { auth: 'none' });
    requireThat(health.status === 200 && health.json?.status === 'ok', `health status ${health.status}`);
    requireThat(health.json.version === pkg.version, `the running build reports ${health.json.version}, package.json says ${pkg.version}`);

    const handoff = readFileSync(join(ROOT, LIVE_HANDOFF), 'utf8');
    const block = liveStateBlock(handoff);
    requireThat(block.length > 0, `${LIVE_HANDOFF} has no §0 fenced state block`);
    const packaged = block.match(/package\.json\s+v?(\d+\.\d+\.\d+)/);
    requireThat(packaged, 'the live handoff §0 no longer states a package.json version');
    requireThat(packaged[1] === pkg.version, `the live handoff claims package.json ${packaged[1]}, the tree ships ${pkg.version}`);

    // The 产品 tag line is deliberately NOT compared to package.json here: the
    // release gate runs between `chore(release)` and `git tag`, when the tag
    // legitimately names the previous release. The guard resolves that window
    // against tag ancestry; this flow only pins the unconditional claims.
    const tag = block.match(/产品 tag\s+v?(\d+\.\d+\.\d+)/);
    requireThat(tag, 'the live handoff §0 no longer states a 产品 tag');

    // The archived snapshot inside <details> must not be what the guard reads.
    requireThat(block !== handoff, 'the state block is the whole document');
    return `build ${health.json.version} = package.json = live handoff (tag line v${tag[1]})`;
  });
}
