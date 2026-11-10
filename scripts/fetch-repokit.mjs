#!/usr/bin/env node
// Fetch the banner generator from a commit-pinned dwgx/DWGX and verify every byte
// against repo-kit.lock.json before writing anything.
//
// WHY: banner.yml runs this Python while holding a token that can push to this
// repository. A mutable branch upstream is remote code execution here. The lock makes
// the fetch content-addressed: the commit freezes the URL, and the per-file sha256
// catches a compromised CDN or a rewritten upstream.
//
// CONTRACT: exit 0 only after all four files match the lock. A malformed lock, a
// missing file, a non-200, or any hash mismatch exits 1 and leaves --dest without a
// build.py (or any of the other three generator files) — verification happens
// entirely in memory before the first write. On success --dest is replaced wholesale
// from a fresh staging directory, so no extra module (e.g. tomllib.py) or package
// (build/) can survive and shadow what Python imports.
//
// Usage: node scripts/fetch-repokit.mjs --dest <dir> [--lock <file>] [--base <url>]
//   --base overrides https://raw.githubusercontent.com/dwgx/DWGX/<commit>/repo-kit;
//   tests pass a file:// URL so they never touch the network.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_FILES = ['build.py', 'styles.py', 'styles_ink.py', 'ink.py'];
const DEFAULT_LOCK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'repo-kit.lock.json');
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { dest: null, lock: DEFAULT_LOCK, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dest' || arg === '--lock' || arg === '--base') {
      const value = argv[i + 1];
      if (!value) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/fetch-repokit.mjs --dest <dir> [--lock <file>] [--base <url>]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!options.dest) fail('--dest is required');
  return options;
}

function validateLock(raw) {
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (error) {
    fail(`lock is not valid JSON: ${error.message}`);
  }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) fail('lock must be a JSON object');
  if (typeof lock.commit !== 'string' || !COMMIT_RE.test(lock.commit)) {
    fail(`lock commit must be a 40-hex commit SHA, got ${JSON.stringify(lock.commit)}`);
  }
  const files = lock.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('lock files must be an object');
  const names = Object.keys(files).sort();
  const expected = [...REQUIRED_FILES].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail(`lock must name exactly ${REQUIRED_FILES.join(', ')}; got ${names.join(', ') || '(none)'}`);
  }
  for (const name of REQUIRED_FILES) {
    if (typeof files[name] !== 'string' || !SHA256_RE.test(files[name])) {
      fail(`lock hash for ${name} must be a 64-hex sha256`);
    }
  }
  return lock;
}

function sourceUrl(base, name) {
  const root = /^[a-z][a-z0-9+.-]*:\/\//i.test(base)
    ? base
    : pathToFileURL(resolve(base)).href;
  return new URL(name, root.endsWith('/') ? root : `${root}/`);
}

async function readSource(url) {
  if (url.protocol === 'file:') {
    try {
      return await readFile(fileURLToPath(url));
    } catch (error) {
      throw new Error(`cannot read ${url.href}: ${error.message}`);
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported base protocol: ${url.protocol}`);
  }
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`${url.href} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function assertSafeDest(dest) {
  if (dest === parse(dest).root) fail('--dest must not be a filesystem root');
  const cwd = resolve('.');
  if (dest === cwd || cwd.startsWith(dest.endsWith(sep) ? dest : `${dest}${sep}`)) {
    fail('--dest must not be the current working directory or one of its parents');
  }
}

// Any failure after --dest is known removes the destination itself. Keeping the
// directory and deleting only the four names would let a pre-existing build/ package
// or build.pyc shadow the missing build.py; the destination is dedicated output, so
// fail closed by removing it entirely.
async function discardDestination(dest) {
  await rm(dest, { recursive: true, force: true });
}

// Build the complete set in a fresh directory next to --dest, then swap it into place.
// The destination therefore contains exactly the four verified files: a leftover
// tomllib.py, build/ package or any other import-shadowing path cannot survive.
async function replaceDestination(dest, files) {
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.repokit-stage-'));
  try {
    for (const name of REQUIRED_FILES) {
      await writeFile(join(staging, name), files.get(name), { mode: 0o644 });
    }
    let backup = null;
    let exists = false;
    try {
      await lstat(dest);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists) {
      backup = join(parent, `.repokit-old-${process.pid}-${Date.now()}`);
      await rename(dest, backup);
    }
    try {
      await rename(staging, dest);
    } catch (error) {
      if (backup) await rename(backup, dest).catch(() => {});
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dest = resolve(options.dest);
  await assertSafeDest(dest);
  try {
    let raw;
    try {
      raw = await readFile(options.lock, 'utf8');
    } catch (error) {
      fail(`cannot read lock ${options.lock}: ${error.message}`);
    }
    const lock = validateLock(raw);

    const base = options.base
      || `https://raw.githubusercontent.com/dwgx/DWGX/${lock.commit}/repo-kit`;
    const verified = new Map();
    for (const name of REQUIRED_FILES) {
      let bytes;
      try {
        bytes = await readSource(sourceUrl(base, name));
      } catch (error) {
        fail(`${name}: ${error.message}`);
      }
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== lock.files[name]) {
        fail(`${name}: sha256 mismatch (lock ${lock.files[name]}, fetched ${actual})`);
      }
      verified.set(name, bytes);
    }

    // Every byte is verified before this line, so a mismatch can never leave build.py
    // (or a partial set) in the directory Python imports from.
    await replaceDestination(dest, verified);
    console.log(`fetch-repokit: verified ${REQUIRED_FILES.length} files from dwgx/DWGX@${lock.commit}`);
  } catch (error) {
    await discardDestination(dest).catch(() => {});
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error(`fetch-repokit: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
