// install-ls.sh must do an atomic rename, not in-place overwrite.
//
// User report (2026-04-29): "LS 更新失败：curl -o /opt/windsurf/...
// 'Text file busy'". Linux refuses open(O_WRONLY|O_TRUNC) on a file
// currently being executed (ETXTBSY). Since the LS is running off
// the very binary install-ls.sh wants to replace, an in-place curl
// always fails on a live system.
//
// Fix: write to ${TARGET}.new.$$ then `mv -f` over the target.
// rename(2) just swaps the dirent to a new inode — running processes
// keep their old inode (now unlinked but still live), and the next
// exec reads the new inode. No service downtime, no ETXTBSY.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, '..', 'install-ls.sh'), 'utf8');

describe('install-ls.sh atomic rename (LS file-busy fix)', () => {
  test('writes to a tmp sibling instead of the target directly', () => {
    assert.match(SCRIPT, /TMP_TARGET="\$\{TARGET\}\.new\.\$\$"/,
      'must define TMP_TARGET as $TARGET.new.$$');

    // Manual modes write to the tmp target.
    assert.match(SCRIPT, /cp -f "\$INPUT_FILE" "\$TMP_TARGET"/,
      '--file must copy into $TMP_TARGET');
    assert.match(SCRIPT, /download "\$INPUT_URL" "\$TMP_TARGET"/,
      '--url must download into $TMP_TARGET');

    // Manifest mode downloads the archive to its own temp path, then
    // extracts the member into $TMP_TARGET.
    assert.match(SCRIPT, /download "\$URL" "\$TMP_ARCHIVE"/,
      'manifest mode must download the archive to $TMP_ARCHIVE');
    assert.match(SCRIPT, /> "\$TMP_TARGET"/,
      'extraction must write into $TMP_TARGET');

    // No download or copy may write the live target path.
    assert.doesNotMatch(SCRIPT, /(?:curl|cp|download)[^\n]*\s"\$TARGET"(?:\s|$)/,
      'no download/copy may write $TARGET directly');
  });

  test('atomic mv finalizes the install, after chmod', () => {
    // The chmod must happen on the tmp file (not target), then the
    // mv swaps the inode in one step. A reversed order would leave
    // the target without +x for a brief window.
    assert.match(SCRIPT, /chmod \+x "\$TMP_TARGET"\s*\n\s*mv -f "\$TMP_TARGET" "\$TARGET"/,
      'must chmod the tmp file then mv it onto $TARGET in that order');
  });

  test('cleans up the tmp files if the script aborts mid-run', () => {
    assert.match(SCRIPT, /trap cleanup EXIT/,
      'must register the cleanup trap on EXIT');
    assert.match(SCRIPT, /rm -f "\$TMP_TARGET" "\$TMP_SIDECAR" "\$TMP_ARCHIVE"/,
      'cleanup must remove the tmp binary, sidecar and archive');
    assert.match(SCRIPT, /trap - EXIT/,
      'must clear the trap after the successful install');
  });

  test('dry-run exits before creating the install directory', () => {
    const dryRunAt = SCRIPT.lastIndexOf('echo "install_path=$TARGET"');
    assert.ok(dryRunAt > 0, 'dry-run must print the plan');
    const mkdirAt = SCRIPT.indexOf('mkdir -p "$(dirname "$TARGET")"', dryRunAt);
    assert.ok(mkdirAt > dryRunAt, 'dry-run must return before mkdir');
  });
});
