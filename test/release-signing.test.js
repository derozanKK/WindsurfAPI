// SEC-04 release signing.
//
// The release workflow signs the four published binaries/zips and SHA256SUMS
// with cosign keyless (GitHub OIDC, no repository secret), then publishes
// <name>.sig, <name>.pem and <name>.sigstore.json. This file pins the wiring
// (permission, pinned signer, signed file list, upload list, ordering) and the
// verifier that users run against a download. It cannot prove that GitHub's
// OIDC exchange succeeds in a real run; that is only observable on a tag build.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IDENTITY_REGEXP,
  DEFAULT_OIDC_ISSUER,
  MANIFEST_NAME,
  RELEASE_ASSETS,
  parseManifest,
  runCosignCommand,
  verifyDirectory,
} from '../scripts/verify-release-assets.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const signingDoc = readFileSync(new URL('../docs/RELEASE-SIGNING.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const readmeEn = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8');
const releaseRunbook = readFileSync(new URL('../docs/releases/README.md', import.meta.url), 'utf8');
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
const verifierScript = fileURLToPath(new URL('../scripts/verify-release-assets.mjs', import.meta.url));

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `expected ${name} job in release workflow`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Workflow path -> release-asset name, in the order the workflow signs them. */
const SIGNED_FILES = [
  ['dist-windows/windsurfapi.exe', 'windsurfapi.exe'],
  ['dist-windows/windsurfapi-windows.zip', 'windsurfapi-windows.zip'],
  ['dist-macos/windsurfapi-macos-arm64', 'windsurfapi-macos-arm64'],
  ['windsurfapi-macos.zip', 'windsurfapi-macos.zip'],
  [MANIFEST_NAME, MANIFEST_NAME],
];

const release = jobBlock('release');
const signStepStart = release.indexOf('Sign the published assets and SHA256SUMS');
const signStep = release.slice(signStepStart, release.indexOf('Create GitHub Release'));

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function writeDownload(dir, { tamper = null, manifestExtra = '' } = {}) {
  const bodies = new Map();
  for (const name of [...RELEASE_ASSETS, MANIFEST_NAME]) {
    const body = `${name} bytes\n`;
    bodies.set(name, body);
    writeFileSync(join(dir, name), body);
  }
  for (const name of [...RELEASE_ASSETS, MANIFEST_NAME]) {
    for (const suffix of ['.sigstore.json']) {
      writeFileSync(join(dir, `${name}${suffix}`), `signature material for ${name}\n`);
    }
  }
  if (tamper) writeFileSync(join(dir, tamper), 'tampered bytes\n');
  const manifest = RELEASE_ASSETS.map((name) => `${sha256(bodies.get(name))}  ${name}`).join('\n');
  writeFileSync(join(dir, MANIFEST_NAME), `${manifest}\n${manifestExtra}`);
}

function tempDownload(options) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-signing-'));
  writeDownload(dir, options);
  return dir;
}

describe('release signing workflow', () => {
  it('gives the release job an OIDC token and pins the signer', () => {
    assert.match(release, /\bid-token:\s*write\b/,
      'keyless signing needs id-token: write; without it the job fails closed');
    assert.match(release, /uses:\s*sigstore\/cosign-installer@[0-9a-f]{40}\b/,
      'the signer must be pinned by commit SHA, not a mutable tag');
    assert.match(release, /cosign-release:\s*'v3\.\d+\.\d+'/,
      'the cosign release must be exact so the signing tool cannot drift');
    assert.doesNotMatch(release, /\$\{\{\s*secrets\./,
      'release signing must not consume repository secrets');
  });

  it('signs the Docker image digest in the docker job and documents it', () => {
    const docker = jobBlock('docker');
    assert.match(docker, /\bid-token:\s*write\b/,
      'the docker job must be able to obtain a Fulcio certificate');
    assert.match(docker, /cosign sign --yes "\$\{IMAGE\}@\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}"/,
      'the image must be signed by digest, not by a mutable tag');
    assert.match(docker, /image-digest\.txt/,
      'the signed digest must be published as image-digest.txt');
    assert.match(signingDoc, /image-digest\.txt/,
      'the signing doc must describe the Docker image digest asset');
    assert.match(signingDoc, /cosign verify\s+ghcr\.io\/dwgx\/windsurf-api@sha256:/,
      'the doc must show how to verify the image digest signature');
  });

  it('signs exactly the published assets plus SHA256SUMS, after hashing and before upload', () => {
    assert.ok(signStepStart > release.indexOf('Generate SHA256SUMS'),
      'the manifest must be generated before it is signed');
    assert.ok(release.indexOf('Install cosign') < signStepStart,
      'cosign must be installed before the signing step');
    assert.ok(signStepStart < release.indexOf('softprops/action-gh-release'),
      'signatures must exist before the release upload');

    const loop = /for f in \\\n([\s\S]*?); do/.exec(signStep);
    assert.ok(loop, 'the signing step must enumerate the signed files');
    const paths = loop[1]
      .split('\n')
      .map((line) => line.trim().replace(/\\$/, '').trim())
      .filter(Boolean);
    assert.deepEqual(paths, SIGNED_FILES.map(([path]) => path),
      'every published blob and the manifest must be signed exactly once');

    for (const [path, name] of SIGNED_FILES) {
      assert.ok(paths.includes(path), `${name} is published but not signed`);
    }

    assert.match(signStep, /--yes\b/, 'keyless signing is non-interactive');
    assert.match(signStep, /--bundle\s+"\$\{base\}\.sigstore\.json"/,
      'the bundle carries the Rekor proof that survives certificate expiry');
    assert.doesNotMatch(signStep, /--output-signature|--output-certificate/,
      'cosign v3 warns these flags away and ignores them; the bundle is the artifact');
    assert.match(signStep, /\[ -s "\$f" \]/, 'empty signature bundles must fail the release');
    assert.doesNotMatch(signStep, /--key\b/,
      'keyless signing must not reference a private key');
  });

  it('uploads the .sigstore.json bundle for every signed file', () => {
    const files = /files: \|([\s\S]*)$/.exec(release)[1];
    for (const pattern of ['*.sigstore.json']) {
      assert.ok(files.includes(pattern), `the release must publish ${pattern}`);
    }
    for (const [path] of SIGNED_FILES) {
      assert.ok(files.includes(path), `the release must publish ${path}`);
    }
    assert.match(files, /\n\s+SHA256SUMS\s*$/,
      'SHA256SUMS stays attached (the existing manifest test anchors on it)');
  });

  it('documents the exact verification identity and issuer', () => {
    assert.ok(signingDoc.includes('cosign verify-blob'),
      'the signing doc must show the verification command');
    assert.ok(DEFAULT_IDENTITY_REGEXP.includes(String.raw`\.github/workflows/release\.yml@refs/tags/v`),
      'the verifier identity must name the workflow that actually signs');
    assert.ok(signingDoc.includes(DEFAULT_IDENTITY_REGEXP),
      'the documented identity regexp must match the verifier default');
    assert.ok(signingDoc.includes(DEFAULT_OIDC_ISSUER),
      'the documented issuer must match the verifier default');
    assert.ok(signingDoc.includes('SHA256SUMS.sigstore.json'),
      'the manifest bundle is the trust anchor users verify first');
    assert.ok(signingDoc.includes('node scripts/verify-release-assets.mjs'),
      'the helper must be discoverable from the signing doc');
    assert.match(signingDoc, /v3\.10\.0/, 'the doc must say when signing started');
    assert.doesNotMatch(signingDoc, /BEGIN [A-Z ]*PRIVATE KEY|cosign\.key|minisign\.key/,
      'no key material may be documented or committed');
  });

  it('stops claiming releases are unsigned', () => {
    for (const [name, text] of [
      ['README.md', readme],
      ['README.en.md', readmeEn],
      ['docs/releases/README.md', releaseRunbook],
      ['docs/README.md', docsIndex],
    ]) {
      assert.doesNotMatch(
        text,
        /当前发布\*\*没有签名\*\*|releases are currently unsigned|releases are \*\*unsigned\*\*|unsigned-release path/i,
        `${name} still tells users releases are unsigned`,
      );
      assert.match(text, /RELEASE-SIGNING\.md/, `${name} must link the signing doc`);
    }
  });
});

describe('verify-release-assets manifest parsing', () => {
  it('accepts flat sha256sum lines, including the binary marker', () => {
    const entries = parseManifest(
      `${'a'.repeat(64)}  windsurfapi.exe\n${'b'.repeat(64)} *windsurfapi-macos.zip\n`,
    );
    assert.equal(entries.get('windsurfapi.exe'), 'a'.repeat(64));
    assert.equal(entries.get('windsurfapi-macos.zip'), 'b'.repeat(64));
  });

  it('rejects malformed, duplicate, nested and absolute entries', () => {
    assert.throws(() => parseManifest('deadbeef  windsurfapi.exe\n'), /not "<64 hex> <name>"/);
    assert.throws(
      () => parseManifest(`${'a'.repeat(64)}  windsurfapi.exe\n${'a'.repeat(64)}  windsurfapi.exe\n`),
      /more than once/,
    );
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  dist-windows/windsurfapi.exe\n`), /non-flat/);
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  ../windsurfapi.exe\n`), /non-flat/);
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  ..\n`), /non-flat/);
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  .\n`), /non-flat/);
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  /tmp/windsurfapi.exe\n`), /non-flat/);
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  C:windsurfapi.exe\n`), /non-flat/);
  });
});

describe('verify-release-assets directory verification', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function fixture(options) {
    const dir = tempDownload(options);
    dirs.push(dir);
    return dir;
  }

  it('verifies the manifest first, then every asset bundle, with the release identity', async () => {
    const dir = fixture();
    const calls = [];
    const result = await verifyDirectory(dir, {
      cosign: 'cosign',
      runCosign: (cosign, args) => { calls.push({ cosign, args }); },
    });

    assert.equal(result.signed.length, 5);
    assert.equal(result.manifestEntries, 4);
    assert.equal(calls.length, 5);
    assert.deepEqual(
      calls.map((call) => call.args[call.args.length - 1]),
      [MANIFEST_NAME, ...RELEASE_ASSETS].map((name) => join(dir, name)),
      'the manifest signature must be checked before the assets it vouches for',
    );
    for (const call of calls) {
      assert.equal(call.cosign, 'cosign');
      assert.equal(call.args[0], 'verify-blob');
      assert.ok(call.args.includes('--bundle'));
      assert.ok(call.args.includes('--certificate-identity-regexp'));
      assert.ok(call.args.includes(DEFAULT_IDENTITY_REGEXP));
      assert.ok(call.args.includes('--certificate-oidc-issuer'));
      assert.ok(call.args.includes(DEFAULT_OIDC_ISSUER));
    }
  });

  it('rejects a tampered asset even when every signature bundle verifies', async () => {
    const dir = fixture({ tamper: 'windsurfapi-windows.zip' });
    await assert.rejects(
      verifyDirectory(dir, { runCosign: () => {} }),
      /SHA-256 mismatch for windsurfapi-windows\.zip/,
    );
  });

  it('rejects a manifest that names an unpublished file', async () => {
    const dir = fixture({ manifestExtra: `${'c'.repeat(64)}  extra.bin\n` });
    await assert.rejects(
      verifyDirectory(dir, { runCosign: () => {} }),
      /does not publish: extra\.bin/,
    );
  });

  it('rejects an incomplete download before trusting any signature', async () => {
    const dir = fixture();
    unlinkSync(join(dir, 'windsurfapi.exe.sigstore.json'));
    await assert.rejects(
      verifyDirectory(dir, { runCosign: () => {} }),
      /missing release files .*windsurfapi\.exe\.sigstore\.json/,
    );
  });

  it('surfaces a cosign verification failure', async () => {
    const dir = fixture();
    await assert.rejects(
      verifyDirectory(dir, {
        runCosign: () => { throw new Error('certificate identity mismatch'); },
      }),
      /certificate identity mismatch/,
    );
  });
});

describe('verify-release-assets cosign process handling', () => {
  it('turns a non-zero exit into a verification error and a missing binary into a usage error', () => {
    // process.execPath stands in for cosign so the real spawn path runs on
    // every platform, including Windows where a shebang fake cannot exec.
    runCosignCommand(process.execPath, ['-e', 'process.exit(0)']);
    assert.throws(
      () => runCosignCommand(process.execPath, ['-e', 'process.exit(3)']),
      /cosign verification failed/,
    );
    assert.throws(
      () => runCosignCommand('definitely-not-cosign-windsurfapi', ['verify-blob']),
      (err) => err.exitCode === 2 && /cosign not found/.test(err.message),
    );
  });
});

describe('verify-release-assets CLI', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = spawnSync(process.execPath, [verifierScript, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--certificate-identity-regexp|--identity/);
  });

  it('exits 2 for an unknown option', () => {
    const result = spawnSync(process.execPath, [verifierScript, '--nope'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option: --nope/);
  });
});

// Windows CreateProcess cannot exec a shebang script, so the real spawn path
// is exercised on POSIX hosts (CI) while the injected-cosign tests above run
// everywhere.
const posixIt = process.platform === 'win32'
  ? (name, fn) => it(name, { skip: 'requires a POSIX host to exec a shebang fake cosign' }, fn)
  : it;

describe('verify-release-assets end to end', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  posixIt('runs one cosign verification per signed file', () => {
    const dir = tempDownload();
    dirs.push(dir);
    const fake = join(dir, 'fake-cosign');
    const log = join(dir, 'cosign.log');
    writeFileSync(fake, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_COSIGN_LOG"\nexit 0\n');
    chmodSync(fake, 0o755);

    const result = spawnSync(
      process.execPath,
      [verifierScript, '--dir', dir, '--cosign', fake],
      { encoding: 'utf8', env: { ...process.env, FAKE_COSIGN_LOG: log } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified 5 signed files and 4 manifest entries/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 5);
    for (const line of calls) assert.match(line, /^verify-blob /);
  });
  posixIt('pins the exact tag with --tag and rejects a lookalike version', () => {
    const dir = tempDownload();
    dirs.push(dir);
    const fake = join(dir, 'fake-cosign');
    const log = join(dir, 'cosign.log');
    writeFileSync(fake, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_COSIGN_LOG"\nexit 0\n');
    chmodSync(fake, 0o755);
    const result = spawnSync(
      process.execPath,
      [verifierScript, '--dir', dir, '--cosign', fake, '--tag', 'v3.10.0'],
      { encoding: 'utf8', env: { ...process.env, FAKE_COSIGN_LOG: log } },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const expected = String.raw`^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v3\.10\.0$`;
    for (const line of calls) assert.ok(line.includes(expected), `missing exact identity in: ${line}`);
    // The default regexp must not accept a longer version that merely starts the same.
    assert.ok(new RegExp(DEFAULT_IDENTITY_REGEXP).test('https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.10.0'));
    assert.ok(!new RegExp(DEFAULT_IDENTITY_REGEXP).test('https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.10.0-unrequested'));
  });

});
