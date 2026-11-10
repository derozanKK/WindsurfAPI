// install-ls.sh must resolve a *pinned* release from the upstream manifest,
// verify the archive sha256 and the inner binary sha256, and fail closed.
//
// These tests are hermetic: the manifest points at a local tar.gz built in a
// temp dir, and every URL is file://. No network, no 345 MB download.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'install-ls.sh');
const PINS_FILE = join(ROOT, 'ls-pins.json');

const MEMBER = 'Devin/resources/app/extensions/windsurf/bin/language_server_linux_x64';
const COMMIT = '0b186d6e13a1a48a46430c51fe414dd0747d46f6';
const FAKE_BINARY = Buffer.from('#!/bin/sh\necho fake-language-server\n');

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.WINDSURFAPI_TEST_BASH,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}
const BASH = findBash();

// Git Bash/Node disagree about C:\ vs C:/. Forward slashes work for both.
const shPath = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Minimal POSIX ustar writer: one regular file, then the two zero end blocks.
// Avoids depending on the host's tar layout/flags for fixture creation.
function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function makeTarGz(name, content) {
  const padding = (512 - (content.length % 512)) % 512;
  return gzipSync(Buffer.concat([
    tarHeader(name, content.length),
    content,
    Buffer.alloc(padding),
    Buffer.alloc(1024),
  ]));
}

function fixture({ archiveShaOverride, binaryShaOverride } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lsinstall-test-'));
  TEMP_DIRS.push(dir);

  const archive = makeTarGz(MEMBER, FAKE_BINARY);
  const archivePath = join(dir, 'fake.tar.gz');
  writeFileSync(archivePath, archive);

  const archiveSha = sha256(archive);
  const binarySha = sha256(FAKE_BINARY);
  const pinnedArchiveSha = archiveShaOverride || archiveSha;
  const pinnedBinarySha = binaryShaOverride || binarySha;

  const pins = {
    schemaVersion: 1,
    releases: [
      {
        version: '3.10.67',
        channel: 'stable',
        source: 'upstream',
        releasedAt: '2026-10-12T00:36:55Z',
        commit: COMMIT,
        targets: {
          'linux-x64': {
            archive: 'fake.tar.gz',
            archiveSha256: pinnedArchiveSha,
            member: MEMBER,
            binarySha256: pinnedBinarySha,
          },
        },
      },
      {
        version: '3.5.17',
        channel: 'stable',
        source: 'mirror',
        releasedAt: '2026-07-20T06:30:42Z',
        commit: '2c489dfc762456657db8662309c0d5e76e886397',
        releaseTag: 'v3.5.17',
        targets: {
          'linux-x64': {
            archive: 'language_server_linux_x64.gz',
            archiveSha256: '7e0130724843bb627ed904fae062c31e1ced44179818982d0ea5c600a407ec3b',
            compression: 'gzip',
            binarySha256: '0555f88967b6f9e51c4a78e5af9434f885826f894f2508ed69ebffa4cc90b59d',
            binaryBytes: 190937480,
          },
        },
      },
    ],
  };

  const manifest = [
    {
      // A newer, unpinned upstream release. Default selection must ignore it.
      version: '3.11.0',
      manifest: {
        'linux-x64': {
          url: pathToFileURL(archivePath).href,
          sha256hash: 'f'.repeat(64),
          version: 'a'.repeat(40),
          windsurfVersion: '3.11.0',
          timestamp: 1891765415000,
        },
      },
    },
    {
      version: '3.10.67',
      manifest: {
        'linux-x64': {
          url: pathToFileURL(archivePath).href,
          sha256hash: pinnedArchiveSha,
          version: COMMIT,
          windsurfVersion: '3.10.67',
          timestamp: 1791765415000,
        },
      },
    },
    {
      version: '3.12.0',
      manifest: {
        'linux-x64': {
          url: pathToFileURL(archivePath).href,
          sha256hash: archiveSha,
          version: 'b'.repeat(40),
          windsurfVersion: '3.12.0',
          timestamp: 1991765415000,
        },
      },
    },
  ];

  const pinsPath = join(dir, 'pins.json');
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(pinsPath, JSON.stringify(pins, null, 2));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    dir,
    pinsPath,
    manifestPath,
    archiveSha,
    binarySha,
    target: join(dir, 'install', 'language_server_linux_x64'),
  };
}

function run(args, env = {}) {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('WINDSURFAPI_LS_')) delete cleanEnv[key];
  }
  cleanEnv.WINDSURFAPI_LS_PLATFORM = 'linux-x64';
  Object.assign(cleanEnv, env);
  if (cleanEnv.LS_INSTALL_PATH) cleanEnv.LS_INSTALL_PATH = shPath(cleanEnv.LS_INSTALL_PATH);
  return spawnSync(BASH, [shPath(SCRIPT), ...args.map(shPath)], {
    encoding: 'utf8',
    env: cleanEnv,
    timeout: 60_000,
  });
}

function planArgs(fx, extra = []) {
  return ['--manifest', fx.manifestPath, '--pins', fx.pinsPath, ...extra];
}

describe('ls-pins.json trust anchor', () => {
  test('pins the reviewed 3.10.67 archive and inner hashes', () => {
    const pins = JSON.parse(readFileSync(PINS_FILE, 'utf8'));
    assert.equal(pins.schemaVersion, 1);
    const release = pins.releases.find((r) => r.version === '3.10.67');
    assert.ok(release, '3.10.67 must be pinned');
    assert.equal(release.source, 'upstream');
    assert.equal(release.commit, COMMIT);

    const linux = release.targets['linux-x64'];
    assert.equal(linux.archiveSha256, '3295f8bdfb460180a7e96961c0a6156f108b6502684287f17b8b512246c35803');
    assert.equal(linux.binarySha256, '111901504bf6eda98fda45080aa28ca7b64ef935c586556d3f702be72da49d7a');
    assert.equal(linux.member, MEMBER);

    const darwinArm = release.targets['darwin-arm64'];
    assert.equal(darwinArm.archiveSha256, '8063233fcc937a9fdb53191ff25de5313b0a580f1b0eb6be6f660a154f40b817');
    assert.equal(darwinArm.binarySha256, 'e6481920bab182bafed14d8dca777e6fb9ad5ce8d6807284593a7aaf745a39cd');

    const darwinX64 = release.targets['darwin-x64'];
    assert.equal(darwinX64.archiveSha256, 'd805a02df276361fe311b4bb0564f20b2bb798c447a70283f1a25b9c040e4d78');
    assert.equal(darwinX64.binarySha256, 'eeb7eed62ebec891208ed442e3f9389cf43bf943295e96f06adf00ac41da4eea');
  });

  test('keeps 3.5.17 as an explicit pinned rollback', () => {
    const pins = JSON.parse(readFileSync(PINS_FILE, 'utf8'));
    const release = pins.releases.find((r) => r.version === '3.5.17');
    assert.ok(release, '3.5.17 must be pinned');
    assert.equal(release.source, 'mirror');
    assert.equal(release.releaseTag, 'v3.5.17');
    const linux = release.targets['linux-x64'];
    assert.equal(linux.compression, 'gzip');
    assert.equal(linux.archiveSha256, '7e0130724843bb627ed904fae062c31e1ced44179818982d0ea5c600a407ec3b');
    assert.equal(linux.binarySha256, '0555f88967b6f9e51c4a78e5af9434f885826f894f2508ed69ebffa4cc90b59d');
  });
});

describe('install-ls.sh manifest mode', () => {
  test('dry-run selects the newest pinned release, not the newest manifest entry', () => {
    const fx = fixture();
    const res = run(planArgs(fx, ['--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.equal(res.status, 0, res.stderr + res.stdout);

    assert.match(res.stdout, /^version=3\.10\.67$/m);
    assert.doesNotMatch(res.stdout, /^version=3\.11\.0$/m);
    assert.match(res.stdout, new RegExp(`^archive_sha256=${fx.archiveSha}$`, 'm'));
    assert.match(res.stdout, new RegExp(`^binary_sha256=${fx.binarySha}$`, 'm'));
    assert.match(res.stdout, new RegExp(`^member=${MEMBER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(res.stdout, /^source=upstream$/m);
    assert.match(res.stdout, /^pinned=1$/m);
    assert.match(res.stdout, /^install_path=/m);

    assert.equal(existsSync(dirname(fx.target)), false,
      'dry-run must not create the install directory');
  });

  test('installs after verifying the archive and the inner binary', () => {
    const fx = fixture();
    const res = run(planArgs(fx), { LS_INSTALL_PATH: fx.target });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /Archive sha256 verified/);
    assert.match(res.stdout, /Binary sha256 verified/);

    assert.equal(readFileSync(fx.target).equals(FAKE_BINARY), true,
      'installed bytes must match the pinned member');
    const sidecar = JSON.parse(readFileSync(`${fx.target}.version.json`, 'utf8'));
    assert.equal(sidecar.windsurfVersion, '3.10.67');
    assert.equal(sidecar.commit, COMMIT);
    assert.equal(sidecar.archiveSha256, fx.archiveSha);
    assert.equal(sidecar.binarySha256, fx.binarySha);
    assert.equal(sidecar.pinned, true);
    assert.equal(sidecar.resolver, 'upstream');
  });

  test('a local --file install removes a stale manifest sidecar', () => {
    const fx = fixture();
    const first = run(planArgs(fx), { LS_INSTALL_PATH: fx.target });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(existsSync(`${fx.target}.version.json`), true);

    const local = join(fx.dir, 'local.bin');
    writeFileSync(local, 'local-binary');
    const second = run(['--file', local], { LS_INSTALL_PATH: fx.target });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(readFileSync(fx.target, 'utf8'), 'local-binary');
    assert.equal(existsSync(`${fx.target}.version.json`), false,
      'a manual install must not leave manifest metadata for the old binary');
  });

  test('archive checksum mismatch exits non-zero and leaves the target untouched', () => {
    const fx = fixture({ archiveShaOverride: '0'.repeat(64) });
    mkdirSync(dirname(fx.target), { recursive: true });
    writeFileSync(fx.target, 'existing-binary');

    const res = run(planArgs(fx), { LS_INSTALL_PATH: fx.target });
    assert.notEqual(res.status, 0, 'installer must fail closed');
    assert.match(res.stderr, /Archive checksum mismatch/);
    assert.equal(readFileSync(fx.target, 'utf8'), 'existing-binary');
    assert.equal(existsSync(`${fx.target}.version.json`), false);
  });

  test('inner binary checksum mismatch exits non-zero and leaves the target untouched', () => {
    const fx = fixture({ binaryShaOverride: '1'.repeat(64) });
    mkdirSync(dirname(fx.target), { recursive: true });
    writeFileSync(fx.target, 'existing-binary');

    const res = run(planArgs(fx), { LS_INSTALL_PATH: fx.target });
    assert.notEqual(res.status, 0, 'installer must fail closed');
    assert.match(res.stderr, /Binary checksum mismatch/);
    assert.equal(readFileSync(fx.target, 'utf8'), 'existing-binary');
    assert.equal(existsSync(`${fx.target}.version.json`), false);
  });

  test('refuses a manifest that disagrees with the pin before downloading', () => {
    const fx = fixture();
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
    manifest.find((x) => x.version === '3.10.67').manifest['linux-x64'].sha256hash = '2'.repeat(64);
    writeFileSync(fx.manifestPath, JSON.stringify(manifest, null, 2));

    const res = run(planArgs(fx, ['--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not match the pin/);
  });

  test('requires --allow-unpinned for a version absent from the pins', () => {
    const fx = fixture();
    const denied = run(planArgs(fx, ['--version', '3.12.0', '--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /is not pinned/);

    const allowed = run(planArgs(fx, ['--version', '3.12.0', '--allow-unpinned', '--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    assert.match(allowed.stdout, /^version=3\.12\.0$/m);
    assert.match(allowed.stdout, /^pinned=0$/m);
    assert.match(allowed.stdout, /^binary_sha256=unpinned$/m);
  });

  test('--allow-unpinned still prefers a matching pin in auto mode', () => {
    const fx = fixture();
    const res = run(planArgs(fx, ['--allow-unpinned', '--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /^version=3\.10\.67$/m);
    assert.match(res.stdout, /^pinned=1$/m);
  });

  test('--allow-unpinned takes the newest manifest entry when no pin matches', () => {
    const fx = fixture();
    const pins = JSON.parse(readFileSync(fx.pinsPath, 'utf8'));
    pins.releases = pins.releases.filter((r) => r.source === 'mirror');
    writeFileSync(fx.pinsPath, JSON.stringify(pins, null, 2));

    const res = run(planArgs(fx, ['--allow-unpinned', '--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /^version=3\.12\.0$/m);
    assert.match(res.stdout, /^pinned=0$/m);
  });

  test('3.5.17 rollback requires --allow-mirror and resolves the explicit tag', () => {
    const fx = fixture();
    const denied = run(planArgs(fx, ['--version', '3.5.17', '--dry-run']), { LS_INSTALL_PATH: fx.target });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /mirror rollback pin/);

    // Mirror resolution must not need the upstream manifest at all.
    const allowed = run([
      '--version', '3.5.17', '--allow-mirror', '--dry-run',
      '--manifest', join(fx.dir, 'does-not-exist.json'),
      '--pins', fx.pinsPath,
    ], { LS_INSTALL_PATH: fx.target });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    assert.match(allowed.stdout, /^version=3\.5\.17$/m);
    assert.match(allowed.stdout, /^source=mirror$/m);
    assert.match(allowed.stdout, /^url=https:\/\/github\.com\/dwgx\/windsurf-ls-release\/releases\/download\/v3\.5\.17\/language_server_linux_x64\.gz$/m);
    assert.match(allowed.stdout, /^archive_sha256=7e0130/m);
    assert.match(allowed.stdout, /^binary_sha256=0555f8/m);
  });

  test('fails closed when the pins file is missing', () => {
    const fx = fixture();
    const res = run([
      '--manifest', fx.manifestPath,
      '--pins', join(fx.dir, 'missing-pins.json'),
      '--dry-run',
    ], { LS_INSTALL_PATH: fx.target });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /pins file not found/);
  });
});
