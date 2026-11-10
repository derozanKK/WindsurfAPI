// D9 source-OTA attestation: parser, policy, cosign invocation and generator.
//
// The attestation is a release asset that binds a tag to the exact commit,
// tree and asset bytes it published. The policy under test is the one the
// dashboard and update.sh share:
//   - a present attestation must name this tag and this commit, always;
//   - a present signature bundle must verify with the pinned release identity;
//   - missing material is fatal only in `required` mode. `warn` is the default
//     so an existing install without cosign keeps updating.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTESTATION_BUNDLE_FILENAME,
  ATTESTATION_FILENAME,
  DEFAULT_ATTESTATION_IDENTITY_REGEXP,
  DEFAULT_OIDC_ISSUER,
  ReleaseAttestationError,
  buildReleaseAttestation,
  normalizeAttestationMode,
  parseGitHubRepository,
  parseReleaseAttestation,
  runCosignVerifyBlob,
  serializeReleaseAttestation,
  verifyReleaseAttestation,
} from '../src/release-attestation.js';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const TAG = 'v3.9.22';
const GENERATOR = fileURLToPath(new URL('../scripts/generate-release-attestation.mjs', import.meta.url));
const VERIFIER = fileURLToPath(new URL('../scripts/verify-release-attestation.mjs', import.meta.url));

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function validAttestation(overrides = {}) {
  return {
    schema: 1,
    repository: 'dwgx/WindsurfAPI',
    tag: TAG,
    commit: COMMIT,
    tree: TREE,
    assets: { SHA256SUMS: 'd'.repeat(64) },
    ...overrides,
  };
}

const tempDirs = [];
function tempDir(prefix = 'wa-attestation-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeAttestationDir({
  attestation = validAttestation(),
  bundle = '{"mediaType":"application/vnd.dev.sigstore.bundle+json"}\n',
  raw = null,
} = {}) {
  const dir = tempDir();
  writeFileSync(join(dir, ATTESTATION_FILENAME), raw ?? serializeReleaseAttestation(attestation), 'utf8');
  if (bundle !== null) writeFileSync(join(dir, ATTESTATION_BUNDLE_FILENAME), bundle, 'utf8');
  return dir;
}

function fakeCosign(result = { status: 0 }) {
  const calls = [];
  const run = (options) => {
    calls.push(options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new ReleaseAttestationError(
        'ERR_RELEASE_ATTESTATION_INVALID',
        `cosign verification failed: exit ${result.status}`,
      );
    }
  };
  return { calls, run };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('release attestation parsing', () => {
  it('accepts the canonical tag/commit/tree/asset shape', () => {
    const parsed = parseReleaseAttestation(serializeReleaseAttestation(validAttestation()));
    assert.equal(parsed.tag, TAG);
    assert.equal(parsed.commit, COMMIT);
    assert.equal(parsed.tree, TREE);
    assert.equal(parsed.assets.SHA256SUMS, 'd'.repeat(64));
    assert.equal(parsed.repository, 'dwgx/WindsurfAPI');
  });

  it('rejects malformed JSON, unsupported schemas and unsafe asset names', () => {
    assert.throws(() => parseReleaseAttestation('{'), /valid JSON/i);
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({ schema: 2 }))),
      /schema/i,
    );
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({ commit: 'not-a-sha' }))),
      /commit/i,
    );
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({ tree: 'nope' }))),
      /tree/i,
    );
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({ tag: 'main' }))),
      /tag/i,
    );
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({
        assets: { '../escape': 'd'.repeat(64) },
      }))),
      /asset/i,
    );
    assert.throws(
      () => parseReleaseAttestation(serializeReleaseAttestation(validAttestation({
        assets: { 'a.bin': 'deadbeef' },
      }))),
      /sha-?256/i,
    );
  });

  it('normalizes the documented switch and rejects an unknown mode', () => {
    assert.equal(normalizeAttestationMode(undefined), 'warn');
    assert.equal(normalizeAttestationMode(''), 'warn');
    assert.equal(normalizeAttestationMode('WARN'), 'warn');
    assert.equal(normalizeAttestationMode('required'), 'required');
    assert.throws(() => normalizeAttestationMode('off'), /warn.*required|required.*warn/i);
  });

  it('recognizes canonical GitHub origins only', () => {
    assert.equal(parseGitHubRepository('https://github.com/dwgx/WindsurfAPI.git'), 'dwgx/WindsurfAPI');
    assert.equal(parseGitHubRepository('https://github.com/dwgx/WindsurfAPI'), 'dwgx/WindsurfAPI');
    assert.equal(parseGitHubRepository('git@github.com:dwgx/WindsurfAPI.git'), 'dwgx/WindsurfAPI');
    assert.equal(parseGitHubRepository('ssh://git@github.com/dwgx/WindsurfAPI.git'), 'dwgx/WindsurfAPI');
    assert.equal(parseGitHubRepository('https://github.com/someone/fork.git'), 'someone/fork');
    assert.equal(parseGitHubRepository('/tmp/origin.git'), '');
    assert.equal(parseGitHubRepository('https://gitlab.com/dwgx/WindsurfAPI.git'), '');
  });
});

describe('release attestation policy', () => {
  it('verifies a matching attestation and pins the release identity', async () => {
    const dir = writeAttestationDir();
    const cosign = fakeCosign();
    const result = await verifyReleaseAttestation({
      tag: TAG,
      commit: COMMIT,
      dir,
      runCosign: cosign.run,
    });

    assert.equal(result.status, 'verified');
    assert.equal(cosign.calls.length, 1);
    const call = cosign.calls[0];
    assert.equal(call.blobPath, join(dir, ATTESTATION_FILENAME));
    assert.equal(call.bundlePath, join(dir, ATTESTATION_BUNDLE_FILENAME));
    assert.equal(call.identity, DEFAULT_ATTESTATION_IDENTITY_REGEXP);
    assert.equal(call.issuer, DEFAULT_OIDC_ISSUER);
  });

  it('refuses a commit mismatch before cosign and before any mutation can run', async () => {
    const dir = writeAttestationDir({ attestation: validAttestation({ commit: OTHER_COMMIT }) });
    const cosign = fakeCosign();
    await assert.rejects(
      verifyReleaseAttestation({ tag: TAG, commit: COMMIT, dir, runCosign: cosign.run }),
      (err) => err.code === 'ERR_RELEASE_ATTESTATION_MISMATCH' && /commit/i.test(err.message),
    );
    assert.equal(cosign.calls.length, 0, 'cosign must not run after a commit mismatch');
  });

  it('refuses a tag mismatch even in warn mode', async () => {
    const dir = writeAttestationDir({ attestation: validAttestation({ tag: 'v9.9.9' }) });
    await assert.rejects(
      verifyReleaseAttestation({ tag: TAG, commit: COMMIT, dir, mode: 'warn', runCosign: fakeCosign().run }),
      (err) => err.code === 'ERR_RELEASE_ATTESTATION_MISMATCH',
    );
  });

  it('refuses missing material in required mode', async () => {
    const empty = tempDir();
    await assert.rejects(
      verifyReleaseAttestation({ tag: TAG, commit: COMMIT, dir: empty, mode: 'required', runCosign: fakeCosign().run }),
      (err) => err.code === 'ERR_RELEASE_ATTESTATION_MISSING',
    );
  });

  it('warns and proceeds on missing material in warn mode', async () => {
    const empty = tempDir();
    const warnings = [];
    const result = await verifyReleaseAttestation({
      tag: TAG,
      commit: COMMIT,
      dir: empty,
      mode: 'warn',
      log: (message) => warnings.push(message),
    });
    assert.equal(result.status, 'missing');
    assert.equal(result.mode, 'warn');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /attestation/i);
  });

  it('refuses an unsigned attestation in required mode but warns in warn mode', async () => {
    const dir = writeAttestationDir({ bundle: null });
    await assert.rejects(
      verifyReleaseAttestation({ tag: TAG, commit: COMMIT, dir, mode: 'required', runCosign: fakeCosign().run }),
      (err) => err.code === 'ERR_RELEASE_ATTESTATION_UNSIGNED',
    );

    const warnings = [];
    const result = await verifyReleaseAttestation({
      tag: TAG,
      commit: COMMIT,
      dir,
      mode: 'warn',
      runCosign: fakeCosign().run,
      log: (message) => warnings.push(message),
    });
    assert.equal(result.status, 'unsigned');
    assert.equal(warnings.length, 1);
  });

  it('refuses a bad signature in both modes', async () => {
    const dir = writeAttestationDir();
    for (const mode of ['warn', 'required']) {
      await assert.rejects(
        verifyReleaseAttestation({
          tag: TAG,
          commit: COMMIT,
          dir,
          mode,
          runCosign: fakeCosign({ status: 1 }).run,
        }),
        (err) => err.code === 'ERR_RELEASE_ATTESTATION_INVALID',
      );
    }
  });

  it('warns on a missing cosign binary in warn mode and refuses in required mode', async () => {
    const dir = writeAttestationDir();
    const missingCosign = () => {
      throw new ReleaseAttestationError('ERR_COSIGN_UNAVAILABLE', 'cosign not found');
    };

    const warnings = [];
    const result = await verifyReleaseAttestation({
      tag: TAG,
      commit: COMMIT,
      dir,
      mode: 'warn',
      runCosign: missingCosign,
      log: (message) => warnings.push(message),
    });
    assert.equal(result.status, 'cosign-unavailable');
    assert.equal(warnings.length, 1);

    await assert.rejects(
      verifyReleaseAttestation({ tag: TAG, commit: COMMIT, dir, mode: 'required', runCosign: missingCosign }),
      (err) => err.code === 'ERR_COSIGN_UNAVAILABLE',
    );
  });

  it('turns a real missing binary and a real non-zero exit into typed errors', () => {
    assert.throws(
      () => runCosignVerifyBlob({ cosign: 'definitely-not-cosign-windsurfapi', bundlePath: 'b', blobPath: 'a' }),
      (err) => err.code === 'ERR_COSIGN_UNAVAILABLE',
    );
    assert.throws(
      () => runCosignVerifyBlob({
        cosign: 'cosign',
        bundlePath: 'b',
        blobPath: 'a',
        spawn: () => ({ status: 3, stdout: '', stderr: 'certificate identity mismatch' }),
      }),
      (err) => err.code === 'ERR_RELEASE_ATTESTATION_INVALID' && /identity mismatch/.test(err.message),
    );
  });
});

describe('release attestation generation', () => {
  it('hashes every named asset deterministically, sorted by release-asset name', async () => {
    const root = tempDir('wa-attestation-gen-');
    writeFileSync(join(root, 'a.bin'), 'alpha\n', 'utf8');
    writeFileSync(join(root, 'b.bin'), 'beta\n', 'utf8');

    const attestation = await buildReleaseAttestation({
      tag: TAG,
      commit: COMMIT.toUpperCase(),
      tree: TREE,
      root,
      assets: { 'b.bin': 'b.bin', 'a.bin': 'a.bin' },
    });

    assert.equal(attestation.tag, TAG);
    assert.equal(attestation.commit, COMMIT);
    assert.equal(attestation.tree, TREE);
    assert.equal(attestation.assets['a.bin'], sha256('alpha\n'));
    assert.equal(attestation.assets['b.bin'], sha256('beta\n'));

    const text = serializeReleaseAttestation(attestation);
    assert.ok(text.endsWith('\n'));
    assert.ok(text.indexOf('"a.bin"') < text.indexOf('"b.bin"'), 'asset keys must be sorted');
    assert.deepEqual(parseReleaseAttestation(text), attestation);
  });

  it('runs the generator CLI against the release layout', () => {
    const root = tempDir('wa-attestation-cli-');
    mkdirSync(join(root, 'dist-windows'), { recursive: true });
    mkdirSync(join(root, 'dist-macos'), { recursive: true });
    writeFileSync(join(root, 'dist-windows', 'windsurfapi.exe'), 'exe\n');
    writeFileSync(join(root, 'dist-windows', 'windsurfapi-windows.zip'), 'winzip\n');
    writeFileSync(join(root, 'dist-macos', 'windsurfapi-macos-arm64'), 'mac\n');
    writeFileSync(join(root, 'windsurfapi-macos.zip'), 'maczip\n');
    writeFileSync(join(root, 'SHA256SUMS'), 'sums\n');
    const out = join(root, 'release-attestation.json');

    const result = spawnSync(process.execPath, [
      GENERATOR,
      '--tag', TAG,
      '--commit', COMMIT,
      '--tree', TREE,
      '--root', root,
      '--out', out,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const attestation = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(attestation.assets).sort(), [
      'SHA256SUMS',
      'windsurfapi-macos-arm64',
      'windsurfapi-macos.zip',
      'windsurfapi-windows.zip',
      'windsurfapi.exe',
    ]);
    assert.equal(attestation.assets['SHA256SUMS'], sha256('sums\n'));
    assert.equal(attestation.assets['windsurfapi.exe'], sha256('exe\n'));
  });
});

describe('verify-release-attestation CLI', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = spawnSync(process.execPath, [VERIFIER, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--mode/);
  });

  it('exits 1 for a missing attestation in required mode', () => {
    const empty = tempDir();
    const result = spawnSync(process.execPath, [
      VERIFIER, '--tag', TAG, '--commit', COMMIT, '--dir', empty, '--mode', 'required',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation/i);
  });

  it('warns and exits 0 for a missing attestation in warn mode', () => {
    const empty = tempDir();
    const result = spawnSync(process.execPath, [
      VERIFIER, '--tag', TAG, '--commit', COMMIT, '--dir', empty, '--mode', 'warn',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning/i);
  });

  it('exits 1 for a commit mismatch', () => {
    const dir = writeAttestationDir({ attestation: validAttestation({ commit: OTHER_COMMIT }) });
    const result = spawnSync(process.execPath, [
      VERIFIER, '--tag', TAG, '--commit', COMMIT, '--dir', dir, '--mode', 'warn',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commit/i);
  });

  const posixIt = process.platform === 'win32'
    ? (name, fn) => it(name, { skip: 'requires a POSIX host to exec a shebang fake cosign' }, fn)
    : it;

  posixIt('verifies a matching attestation through a real cosign process', () => {
    const dir = writeAttestationDir();
    const fake = join(dir, 'fake-cosign');
    const log = join(dir, 'cosign.log');
    writeFileSync(fake, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_COSIGN_LOG"\nexit 0\n');
    chmodSync(fake, 0o755);

    const result = spawnSync(process.execPath, [
      VERIFIER, '--tag', TAG, '--commit', COMMIT, '--dir', dir, '--cosign', fake,
    ], { encoding: 'utf8', env: { ...process.env, FAKE_COSIGN_LOG: log } });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified/i);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^verify-blob /);
    assert.ok(calls[0].includes(DEFAULT_ATTESTATION_IDENTITY_REGEXP));
    assert.ok(calls[0].includes(DEFAULT_OIDC_ISSUER));
  });
});
