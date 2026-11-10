#!/usr/bin/env node
// Full-history secret scan: every blob reachable from ANY ref, plus the unreachable objects
// a rewrite leaves behind (amend / rebase / force-push / deleted branch). The working-tree
// scanner (scripts/secret-scan.mjs) cannot see a credential that was committed and later
// deleted; this one exists because "removed in a later commit" is not "removed from the
// repository" — the blob stays in the object database, and a clone still carries it.
//
// WHY NOT `gitleaks git --log-opts=--all`: gitleaks is the reference implementation and was
// run for the SEC-05 audit (v8.30.1, report in the wave evidence directory). It is not the
// CI gate for three reasons measured here:
//   1. It needs a binary downloaded per run (or a licensed action); this repo has zero
//      runtime and dev dependencies by design.
//   2. Its generic rules do not know this project's own credential shapes
//      (`devin-session-token$…`, `AMf-…` refresh tokens, `email----password` imports) — the
//      rules that do are in scripts/secret-rules.mjs and are shared with the tree scanner.
//   3. It walks `git log -p`, which never shows a blob that only exists as an unreachable
//      object; those are exactly the objects a force-push was meant to hide.
//
// WHAT IT PRINTS: rule, path, line, commit, and a truncated SHA-256 of the secret. The
// secret itself is never written to stdout, the JSON report, or the baseline file.
//
// EXIT: 0 clean (or every finding is baselined), 1 unbaselined findings, 2 scan failure.
// A partial scan never exits 0 — a missing blob, an unparsable batch stream, or a failed
// git command is a failure, not "nothing found".

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IGNORED_PATHS, findRuleMatches, lineForOffset } from './secret-rules.mjs';

const scriptRepoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Same extensions the working-tree scanner ignores. They are binary containers: a UTF-8
// decode of them produces noise, and a credential inside an image/zip is not something a
// text rule can find. Archives are out of scope by measurement, not by assumption — see
// HistorySecretScan.md for the archive count in this history.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'db', 'sqlite', 'exe', 'dll', 'so', 'dylib', 'node', 'bin', 'pdf', 'woff', 'woff2', 'ttf',
  'eot', 'mp4', 'mp3', 'wasm', 'jar', 'class', 'pyc', 'pdb', 'o', 'a', 'lib', 'iso', 'cab',
]);

function fail(message) {
  console.error(`history-secret-scan: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    repo: scriptRepoRoot,
    baseline: null,
    json: null,
    maxBytes: 1024 * 1024,
    unreachable: true,
    emitBaseline: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--repo') opts.repo = resolve(value());
    else if (arg === '--baseline') opts.baseline = resolve(value());
    else if (arg === '--json') opts.json = resolve(value());
    else if (arg === '--max-bytes') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) fail('--max-bytes must be a positive number');
      opts.maxBytes = n;
    } else if (arg === '--no-unreachable') opts.unreachable = false;
    else if (arg === '--emit-baseline') opts.emitBaseline = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/history-secret-scan.mjs [--repo DIR] [--baseline FILE] [--json FILE] [--max-bytes N] [--no-unreachable] [--emit-baseline] [--verbose]');
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!opts.baseline) opts.baseline = resolve(opts.repo, 'scripts/history-secret-scan.baseline');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(resolve(opts.repo, '.git'))) {
  fail(`${opts.repo} is not a git work tree — refusing to report a repository that was never read as clean`);
}

function git(args, { input = undefined, maxBuffer = 512 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd: opts.repo,
    input,
    maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
    // A pager would wait forever on a pipe; never let one start.
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) fail(`git ${args[0]} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().split('\n').slice(-3).join(' | ');
    fail(`git ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ''} — a partial scan is not a clean scan`);
  }
  return result.stdout;
}

// ── enumerate ────────────────────────────────────────────────────────────────────────────
const refs = git(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);

// `rev-list --objects` yields `<oid> <path>` for blobs AND trees (path may contain
// spaces) and a bare `<oid>` for commits/tags. Types are resolved below with one
// `cat-file --batch-check`: the object list is a candidate set, not a claim about type.
const objectPaths = new Map();
for (const line of git(['rev-list', '--all', '--objects']).split('\n')) {
  if (!line) continue;
  const space = line.indexOf(' ');
  if (space === -1) continue;
  const oid = line.slice(0, space);
  const path = line.slice(space + 1);
  if (!objectPaths.has(oid)) objectPaths.set(oid, path);
}

// Blob → { commit, path } where the blob was ADDED. Log order is newest-first, so the last
// assignment wins and the recorded commit is the oldest one that introduced those bytes.
const introducedBy = new Map();
{
  let currentCommit = null;
  const raw = git(['log', '--all', '--raw', '--no-abbrev', '--no-renames', '-m',
    '--diff-filter=AM', '--format=@@%H']);
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) { currentCommit = line.slice(2).trim(); continue; }
    if (!line.startsWith(':')) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const fields = line.slice(1, tab).split(' ');
    const newOid = fields[3];
    if (!newOid || !currentCommit) continue;
    introducedBy.set(newOid, { commit: currentCommit, path: line.slice(tab + 1) });
  }
}

// Unreachable objects: left by amend, rebase, force-push, or a deleted branch. They are not
// reachable from any ref, so `git log -p` never shows them, but they are still in the object
// database and still come back with `git cat-file`. `--no-reflogs` keeps this deterministic:
// reflog entries are local state, not repository content.
let unreachableBlobs = [];
let unreachableCommits = [];
if (opts.unreachable) {
  const fsck = git(['fsck', '--unreachable', '--no-reflogs', '--no-progress']);
  for (const line of fsck.split('\n')) {
    const m = /^unreachable (blob|commit) ([0-9a-f]{40,64})$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'blob') unreachableBlobs.push(m[2]);
    else unreachableCommits.push(m[2]);
  }
}

// Unreachable blobs have no path of their own: `fsck` names the object, not the tree entry.
// Resolve them through the unreachable COMMITS' trees BEFORE scanning, because the fixture
// exemption is path-based — an unattributed blob is scanned as if it were not under test/,
// which turns a reviewed fixture into a finding and, worse, hides nothing but wastes the
// reviewer's attention. (Measured: the amended version of a test file was reported as a
// leak until this ran before the scan.)
const unreachableLocation = new Map();
if (unreachableBlobs.length && unreachableCommits.length) {
  const wanted = new Set(unreachableBlobs);
  for (const commit of unreachableCommits) {
    const tree = git(['ls-tree', '-r', '--full-tree', commit]);
    for (const line of tree.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const oid = line.slice(0, tab).split(' ')[2];
      if (wanted.has(oid) && !unreachableLocation.has(oid)) {
        unreachableLocation.set(oid, { commit, path: line.slice(tab + 1) });
      }
    }
    if (unreachableLocation.size === wanted.size) break;
  }
}

const pathOf = (oid) => objectPaths.get(oid) || unreachableLocation.get(oid)?.path || '<unreachable>';

// ── resolve types and sizes (one batch-check for every object) ──────────────────────────
const objectInfo = new Map();
{
  const allOids = [...objectPaths.keys()].concat(unreachableBlobs);
  // An empty repository has nothing to ask about, and `cat-file` answers an empty line
  // with ` missing` — which the parser would rightly call a corrupt stream.
  const out = allOids.length === 0 ? '' : git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: allOids.join('\n') + '\n' });
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    objectInfo.set(m[1], { type: m[2], size: Number(m[3]) });
  }
  // `fsck` just named the unreachable blobs, so an absent entry means the database changed
  // underneath this run. A missing object is a failed scan, never "nothing found".
  const unreadable = allOids.filter((oid) => !objectInfo.has(oid));
  if (unreadable.length) {
    fail(`${unreadable.length} object(s) could not be read (first: ${unreadable[0].slice(0, 12)}) — refusing a partial scan`);
  }
}

const blobSizes = new Map(
  [...objectInfo].filter(([, info]) => info.type === 'blob').map(([oid, info]) => [oid, info.size]),
);

const isBinaryPath = (path) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

const skippedLarge = [];
const skippedBinary = [];
const scanOids = [];
for (const [oid, size] of blobSizes) {
  const path = pathOf(oid);
  if (isBinaryPath(path)) { skippedBinary.push({ oid, path }); continue; }
  // The scanner's own source documents key-SHAPED fixtures to explain its rules; the tree
  // scanner skips the same files. Any other path is scanned.
  if (IGNORED_PATHS.has(path)) continue;
  if (size > opts.maxBytes) { skippedLarge.push({ oid, path, size }); continue; }
  scanOids.push(oid);
}

// ── read every candidate blob in one `cat-file --batch` stream ──────────────────────────
// The stream is `<oid> blob <size>\n<bytes>\n`; a size mismatch or a `missing` header means
// the object database changed under us, which is a failure, never "no findings".
const blobText = new Map();
if (scanOids.length) {
  const out = spawnSync('git', ['cat-file', '--batch'], {
    cwd: opts.repo,
    input: scanOids.join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_PAGER: 'cat' },
  });
  if (out.error) fail(`git cat-file failed to start: ${out.error.message}`);
  if (out.status !== 0) fail(`git cat-file exited ${out.status} — refusing a partial scan`);
  const buf = out.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) fail('truncated cat-file header — refusing a partial scan');
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) {
      if (/ missing$/.test(header)) fail(`object ${header.split(' ')[0]} disappeared during the scan — refusing a partial scan`);
      fail(`unparsable cat-file header: ${header.slice(0, 80)}`);
    }
    const [, oid, type, sizeText] = m;
    const size = Number(sizeText);
    if (type !== 'blob') continue;
    const end = pos + size;
    if (end > buf.length) fail(`truncated blob ${oid.slice(0, 12)} (${size} bytes declared) — refusing a partial scan`);
    blobText.set(oid, buf.toString('utf8', pos, end));
    pos = end + 1; // the single LF after the object body
  }
}

// ── scan ────────────────────────────────────────────────────────────────────────────────
const findings = [];
for (const [oid, text] of blobText) {
  if (text.includes('\u0000')) continue; // binary content behind a text-looking path
  const path = pathOf(oid);
  for (const match of findRuleMatches(text, path)) {
    const fingerprint = createHash('sha256').update(match.match).digest('hex').slice(0, 12);
    const reachable = introducedBy.get(oid) || null;
    const orphan = reachable ? null : unreachableLocation.get(oid) || null;
    const where = reachable || orphan;
    findings.push({
      rule: match.rule,
      path: where ? where.path : path,
      line: lineForOffset(text, match.index),
      commit: where ? where.commit : null,
      blob: oid,
      fingerprint,
      secretLength: match.match.length,
      unreachable: !reachable,
    });
  }
}

// ── baseline ────────────────────────────────────────────────────────────────────────────
// Identity is rule + secret fingerprint, not path: a credential that moved files is the same
// leak, and a line number is not stable across edits. The path in the file is documentation.
// An entry is `<rule> <path> <fingerprint|-> [reason...]`. `-` means "any value of this
// rule at this path": the last resort for a secret whose truncated hash would itself be a
// disclosure (a short, low-entropy key; an email address), because a 12-hex fingerprint of
// an 8-character key is brute-forceable. Every `-` entry costs path-level precision, so it
// must carry a reason and a reviewer.
const baseline = new Map();
const baselinePathScoped = new Map();
if (existsSync(opts.baseline)) {
  const text = readFileSync(opts.baseline, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [rule, path, fingerprint] = trimmed.split(/\s+/);
    if (!rule || !path || !fingerprint) fail(`${opts.baseline}: unparsable baseline line: ${trimmed.slice(0, 80)}`);
    if (fingerprint === '-') baselinePathScoped.set(`${rule} ${path}`, { rule, path, fingerprint });
    else baseline.set(`${rule} ${fingerprint}`, { rule, path, fingerprint });
  }
}

findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
const usedBaseline = new Set();
for (const finding of findings) {
  const key = `${finding.rule} ${finding.fingerprint}`;
  const pathKey = `${finding.rule} ${finding.path}`;
  if (baseline.has(key)) {
    finding.baselined = true;
    usedBaseline.add(key);
  } else if (baselinePathScoped.has(pathKey)) {
    finding.baselined = true;
    usedBaseline.add(pathKey);
  }
}

const unbaselined = findings.filter((f) => !f.baselined);
const staleBaseline = [...baseline.keys(), ...baselinePathScoped.keys()].filter((key) => !usedBaseline.has(key));

if (opts.emitBaseline) {
  // A fingerprint is a one-way hash, but "one-way" is only true for a high-entropy value:
  // an 8-character key or an email address can be recovered from a 12-hex prefix. Values
  // below 20 characters therefore emit `-` (path-scoped) instead of a hash.
  for (const finding of findings) {
    const pii = finding.rule === 'credentialed-email-example' || finding.rule === 'account-credential-pair';
    const short = finding.secretLength < 20;
    console.log(`${finding.rule} ${finding.path} ${pii || short ? '-' : finding.fingerprint}`);
  }
  process.exit(0);
}

for (const finding of findings) {
  const where = finding.commit ? finding.commit.slice(0, 12) : '<unreachable>';
  const suffix = finding.baselined ? ' [baselined]' : '';
  console.log(`${finding.path}:${finding.line} ${finding.rule} commit=${where} fp=${finding.fingerprint}${suffix}`);
}

for (const { path, size } of skippedLarge) {
  if (opts.verbose) console.error(`history-secret-scan: skipped ${path} (${size} bytes > --max-bytes)`);
}

if (opts.json) {
  writeFileSync(opts.json, JSON.stringify({
    tool: 'history-secret-scan',
    repo: opts.repo,
    refs: refs.length,
    commits: commits.length,
    blobsScanned: blobText.size,
    unreachableBlobs: unreachableBlobs.length,
    skippedBinary: skippedBinary.length,
    skippedLarge: skippedLarge.length,
    findings: findings.map(({ rule, path, line, commit, blob, fingerprint, baselined, unreachable }) => ({
      rule, path, line, commit, blob, fingerprint, baselined, unreachable,
    })),
  }, null, 2) + '\n');
}

console.error(`history-secret-scan: ${refs.length} refs, ${commits.length} commits, ${blobText.size} blobs scanned, ` +
  `${unreachableBlobs.length} unreachable blobs, ${skippedBinary.length} binary files skipped, ` +
  `${skippedLarge.length} large files skipped, ${findings.length} finding(s) (${unbaselined.length} unbaselined)`);
if (staleBaseline.length) {
  console.error(`history-secret-scan: ${staleBaseline.length} baseline entr${staleBaseline.length === 1 ? 'y is' : 'ies are'} stale (no matching finding) — remove or explain them`);
}
if (unbaselined.length) process.exitCode = 1;
