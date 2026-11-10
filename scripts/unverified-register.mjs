#!/usr/bin/env node
/**
 * Regenerate `docs/UNVERIFIED.md` — the cross-release register of every claim a release
 * note itself filed under a "尚未验证" section.
 *
 * WHY THIS EXISTS. Each release note carries its own "what we did not measure" list, and
 * those lists only ever grow: v3.141.592654 states the newest gaps, and the 65 historical
 * bullets before it were reachable only by opening 24 files one at a time. The audit that
 * asked for this register counted the bullets by hand; nobody can do that every release.
 * So the notes stay the source of truth and this script derives the index from them — the
 * register cannot disagree with the notes because it is not written by hand at all.
 *
 * THE MARKER IS THE STATUS. A bullet's state is whatever marker it starts with:
 *
 *   `[VERIFIED]`   → 已复核  the claim was re-checked, and the bullet carries the record
 *   `[UNVERIFIED]` → 仍缺    still unmeasured
 *   `[FIXED]`      → 已修    the gap itself was closed
 *   no marker      → 仍缺, shown with `—` in the marker column
 *
 * Status therefore changes where the evidence lives (the release note), never here. A
 * generator that accepted hand-edits would drift from the notes on the next run, which is
 * exactly what `test/unverified-register.test.js` compares byte for byte.
 *
 * Run:  node scripts/unverified-register.mjs [--out <path>]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RELEASES_DIR = 'docs/releases';
export const REGISTER_FILE = 'docs/UNVERIFIED.md';
export const SECTION_WORD = '尚未验证';

export const STATUS = Object.freeze({
  VERIFIED: '已复核',
  UNVERIFIED: '仍缺',
  FIXED: '已修',
});

const MARKER_STATUS = new Map([
  ['VERIFIED', STATUS.VERIFIED],
  ['UNVERIFIED', STATUS.UNVERIFIED],
  ['FIXED', STATUS.FIXED],
]);

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const BULLET_RE = /^ {0,3}[-*+]\s+(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
// `[UNVERIFIED]`, `[UNVERIFIED]` inside backticks, and the bolded spellings all appear in
// the corpus. Anything else in the bracket position (`[NOTE]`, `[TODO]`) is NOT a marker:
// an unrecognised tag must not silently claim a status.
const MARKER_RE = /^(?:\*\*|__)?`?\[([A-Z][A-Z_]{2,})\]`?(?:\*\*|__)?/;

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function makeBullet(line, raw) {
  const match = raw.match(MARKER_RE);
  const marker = match && MARKER_STATUS.has(match[1]) ? match[1] : null;
  const body = marker ? raw.slice(match[0].length) : raw;
  return {
    line,
    marker,
    status: marker ? MARKER_STATUS.get(marker) : STATUS.UNVERIFIED,
    text: normalize(body),
  };
}

/**
 * Every section whose heading contains 尚未验证, with its top-level bullets.
 *
 * A section ends at the next heading of the same or a shallower level, so a `###` note
 * inside the section does not truncate it. Bullet continuation lines are the indented
 * ones — several notes wrap a single bullet over three lines.
 */
export function parseUnverifiedSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let section = null;
  let bullet = null;
  let fence = false;

  const flush = () => {
    if (section && bullet) section.bullets.push(bullet);
    bullet = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      const level = heading[1].length;
      if (section && level <= section.level) section = null;
      if (!section && heading[2].includes(SECTION_WORD)) {
        section = { heading: heading[2], line: i + 1, level, bullets: [] };
        sections.push(section);
      }
      continue;
    }

    if (!section) continue;

    const start = line.match(BULLET_RE);
    if (start) {
      flush();
      bullet = makeBullet(i + 1, start[1]);
      continue;
    }
    if (bullet && /^(?: {2,}|\t)\S/.test(line)) {
      bullet.text = normalize(`${bullet.text} ${line}`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flush();
  }
  flush();
  return sections;
}

export function versionOf(file) {
  const match = file.match(/^RELEASE_NOTES_v?(\d+(?:\.\d+)*)\.md$/);
  return match ? match[1] : null;
}

function compareEntries(a, b) {
  const pa = a.version ? a.version.split('.').map(Number) : null;
  const pb = b.version ? b.version.split('.').map(Number) : null;
  if (pa && pb) {
    const width = Math.max(pa.length, pb.length);
    for (let i = 0; i < width; i += 1) {
      const delta = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (delta) return delta;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Every release note that carries at least one 尚未验证 section, newest release first. */
export function collectEntries({ root = ROOT } = {}) {
  const dir = join(root, RELEASES_DIR);
  const files = readdirSync(dir)
    .filter((name) => /^RELEASE_NOTES_.*\.md$/.test(name))
    .sort();
  const entries = [];
  for (const name of files) {
    const sections = parseUnverifiedSections(readFileSync(join(dir, name), 'utf8'));
    if (sections.length) entries.push({ name, version: versionOf(name), sections });
  }
  entries.sort(compareEntries);
  return { scanned: files.length, entries };
}

const cell = (text) => normalize(text).replace(/\|/g, '\\|');
const markerCell = (bullet) => (bullet.marker ? `\`[${bullet.marker}]\`` : '—');

function countBy(rows, predicate) {
  return rows.filter(predicate).length;
}

export function renderRegister({ scanned, entries }) {
  const allBullets = entries.flatMap((entry) => entry.sections.flatMap((section) => section.bullets));
  const verified = countBy(allBullets, (b) => b.status === STATUS.VERIFIED);
  const unverified = countBy(allBullets, (b) => b.status === STATUS.UNVERIFIED);
  const fixed = countBy(allBullets, (b) => b.status === STATUS.FIXED);
  const unmarked = countBy(allBullets, (b) => !b.marker);
  const sectionCount = entries.reduce((sum, entry) => sum + entry.sections.length, 0);

  const out = [];
  out.push('# 尚未验证登记册 / Unverified register');
  out.push('');
  out.push('> **自动生成，不要手改。** 来源是 `docs/releases/*.md` 里标题含「尚未验证」的小节；改完那些');
  out.push('> 小节后运行 `node scripts/unverified-register.mjs`。`test/unverified-register.test.js` 会重新');
  out.push('> 生成并与本文件逐字节比较，任何漂移都是失败。');
  out.push('>');
  out.push('> 状态只看 bullet 开头的 marker：`[VERIFIED]` → **已复核**（bullet 里要带复核记录），');
  out.push('> `[FIXED]` → **已修**，`[UNVERIFIED]` → **仍缺**；没有 marker 的同样按 **仍缺** 计，marker 列');
  out.push('> 写 `—`。登记册本身不重新测量任何东西：一条从「仍缺」变成「已复核」，必须先在对应');
  out.push('> release note 里补上 marker 和证据，再重新生成本文件。');
  out.push('');
  out.push('## 总量');
  out.push('');
  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push(`| 扫描 | \`${RELEASES_DIR}/*.md\` 共 ${scanned} 个文件 |`);
  out.push(`| 命中 | ${entries.length} 个文件 / ${sectionCount} 个小节 |`);
  out.push(`| bullet | ${allBullets.length} 条 |`);
  out.push(`| 已复核 | ${verified} |`);
  out.push(`| 仍缺 | ${unverified} |`);
  out.push(`| 已修 | ${fixed} |`);
  out.push(`| 无 marker | ${unmarked} |`);
  out.push('');

  if (!entries.length) {
    out.push('没有任何 release note 带「尚未验证」小节。');
    out.push('');
    return `${out.join('\n')}`;
  }

  out.push('## 按 release');
  out.push('');
  out.push('| release | 小节 | bullet | 已复核 | 仍缺 | 已修 | 无 marker |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const entry of entries) {
    const rows = entry.sections.flatMap((section) => section.bullets);
    const cells = [
      `[${entry.version ?? entry.name}](releases/${entry.name})`,
      entry.sections.length,
      rows.length,
      countBy(rows, (b) => b.status === STATUS.VERIFIED),
      countBy(rows, (b) => b.status === STATUS.UNVERIFIED),
      countBy(rows, (b) => b.status === STATUS.FIXED),
      countBy(rows, (b) => !b.marker),
    ];
    out.push(`| ${cells.join(' | ')} |`);
  }
  out.push('');

  for (const entry of entries) {
    const rows = entry.sections.flatMap((section) => section.bullets);
    out.push(`## ${entry.version ?? entry.name} — \`${RELEASES_DIR}/${entry.name}\``);
    out.push('');
    out.push(
      `${entry.sections.length} 个小节 · ${rows.length} 条：`
      + `已复核 ${countBy(rows, (b) => b.status === STATUS.VERIFIED)} · `
      + `仍缺 ${countBy(rows, (b) => b.status === STATUS.UNVERIFIED)} · `
      + `已修 ${countBy(rows, (b) => b.status === STATUS.FIXED)}`
      + `（无 marker ${countBy(rows, (b) => !b.marker)}）`,
    );
    out.push('');
    for (const section of entry.sections) {
      out.push(`小节 \`## ${section.heading}\`（\`:${section.line}\`）`);
      out.push('');
      if (!section.bullets.length) {
        out.push('（空小节）');
        out.push('');
        continue;
      }
      out.push('| # | 位置 | bullet | marker | 状态 |');
      out.push('|---:|---|---|---|---|');
      section.bullets.forEach((bullet, index) => {
        out.push(
          `| ${index + 1} | \`${entry.name}:${bullet.line}\` | ${cell(bullet.text)} | `
          + `${markerCell(bullet)} | ${bullet.status} |`,
        );
      });
      out.push('');
    }
  }

  return `${out.join('\n')}`;
}

export function buildRegister({ root = ROOT } = {}) {
  return renderRegister(collectEntries({ root }));
}

function parseArgs(argv) {
  const options = { out: REGISTER_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out needs a path');
      options.out = value;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
      if (!options.out) throw new Error('--out needs a path');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    const { out } = parseArgs(process.argv.slice(2));
    const target = resolve(ROOT, out);
    const body = buildRegister();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
    const bullets = body.match(/^\| \d+ \| `/gm)?.length ?? 0;
    console.log(`Wrote ${out} (${bullets} bullets)`);
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
