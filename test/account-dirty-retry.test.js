// accounts.json dirty bookkeeping — a FAILED persistence must keep the retry signal.
//
// Contract under test: `_dirty` means "memory holds state the on-disk file does not
// prove". Only a save that actually completed (durable temp write + publish) may
// clear it, and a save that failed must set it — including a save that started on a
// clean pool, and including the case where the rename published but the parent
// directory fsync could not prove the directory entry durable (fs-atomic marks that
// error `renamePublished`).
//
// Why it matters: `_dirty` is the ONLY retry trigger for lazy state (spend counters,
// rolling health window, cooldown deadlines). `flushDirty()` runs on a 30s timer and
// returns immediately when the flag is clear — so a writer that clears the flag before
// attempting the write converts one transient `EIO`/`ENOSPC` into "this batch sits in
// memory until some unrelated mutation happens to re-arm the flag", and the periodic
// flush can never recover it.
//
// Faults are injected at the real syscall boundary (node:fs wrapped, then re-published
// with syncBuiltinESMExports), scoped to this test's synthetic accounts.json temp file
// and its parent directory. `saveAccounts` / `saveAccountsSync` are never replaced, so
// the production composition — writeFileSyncDurable (temp write + fsync) →
// renameSyncWithRetry (rename + parent-dir fsync) — runs unchanged.
//
// Each case owns its own account key, so a case that fails early cannot change what a
// later case observes on disk.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  addAccountByKey, removeAccount, recordAccountSpend,
  saveAccountsSync, __flushDirtyAccounts, __isAccountsDirty, __setModelCatalogDeps,
} from '../src/auth.js';
import { writeFileSyncDurable } from '../src/fs-atomic.js';
import { config } from '../src/config.js';

const DATA_DIR = resolve(config.sharedDataDir || config.dataDir);
const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');
const EMAIL = 'state-dirty@example.invalid';
const KEY = n => `state-dirty-${n}$test`;

// ─── fs boundary: real functions, wrapped, scoped to this test's paths ───────

const fsCjs = createRequire(import.meta.url)('node:fs');
const real = {
  openSync: fsCjs.openSync,
  closeSync: fsCjs.closeSync,
  writeSync: fsCjs.writeSync,
  fsyncSync: fsCjs.fsyncSync,
  renameSync: fsCjs.renameSync,
};

const fdPath = new Map();
const armed = { writeEio: false, dirFsyncEio: false };
const stats = { tempOpens: [], renames: [] };

const isAccountsTemp = p => typeof p === 'string' && p.startsWith(`${ACCOUNTS_FILE}.`) && p.endsWith('.tmp');
const isDataDir = p => typeof p === 'string' && resolve(p).toLowerCase() === DATA_DIR.toLowerCase();
const injectedEio = where => Object.assign(new Error(`injected EIO at ${where}`), {
  code: 'EIO', errno: -4095, syscall: 'write',
});

function installFsBoundary() {
  fsCjs.openSync = function (path, ...rest) {
    const fd = real.openSync.call(this, path, ...rest);
    fdPath.set(fd, String(path));
    if (isAccountsTemp(path)) stats.tempOpens.push(basename(String(path)));
    return fd;
  };
  fsCjs.closeSync = function (fd, ...rest) {
    try { return real.closeSync.call(this, fd, ...rest); } finally { fdPath.delete(fd); }
  };
  fsCjs.writeSync = function (fd, ...rest) {
    // One-shot: the injected failure belongs to the next temp-file write only.
    if (armed.writeEio && isAccountsTemp(fdPath.get(fd))) { armed.writeEio = false; throw injectedEio('accounts temp write'); }
    return real.writeSync.call(this, fd, ...rest);
  };
  fsCjs.fsyncSync = function (fd, ...rest) {
    if (armed.dirFsyncEio && isDataDir(fdPath.get(fd))) { armed.dirFsyncEio = false; throw injectedEio('accounts dir fsync'); }
    return real.fsyncSync.call(this, fd, ...rest);
  };
  fsCjs.renameSync = function (from, to, ...rest) {
    if (isAccountsTemp(from)) stats.renames.push(basename(String(from)));
    return real.renameSync.call(this, from, to, ...rest);
  };
  syncBuiltinESMExports();
}

function restoreFsBoundary() {
  for (const [name, fn] of Object.entries(real)) fsCjs[name] = fn;
  fdPath.clear();
  syncBuiltinESMExports();
}

// ─── observation helpers (all read the real on-disk file) ───────────────────

function accountOnDisk(key) {
  let rows;
  try { rows = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return null; }
  return Array.isArray(rows) ? rows.find(a => a.apiKey === key) ?? null : null;
}
const requestsOnDisk = key => accountOnDisk(key)?._totalSpend?.requests ?? 0;
const pendingTemps = () => readdirSync(DATA_DIR).filter(n => n.startsWith('accounts.json.') && n.endsWith('.tmp'));
const spend = (p, c, t) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: t });

const created = [];
function createAccount(key) {
  const account = addAccountByKey(key, EMAIL);
  created.push(account);
  assert.equal(accountOnDisk(key)?.apiKey, key, 'precondition: the fixture account is persisted');
  return account;
}

before(() => {
  // Offline: catalog sync is irrelevant here and must not fire real RPCs.
  __setModelCatalogDeps({ disableConnectSync: true, getCascadeModelConfigs: async () => ({ configs: [] }) });
  installFsBoundary();

  // Seam self-check: with the patch installed but before syncBuiltinESMExports the
  // real modules keep the pristine bindings and nothing would be injected — a probe
  // that silently measures nothing. Prove the boundary reaches src/fs-atomic.js.
  const selfCheckTarget = `${ACCOUNTS_FILE}.${process.pid}.selfcheck.tmp`;
  let selfCheckCode = null;
  armed.writeEio = true;
  try { writeFileSyncDurable(selfCheckTarget, 'seam-self-check'); } catch (e) { selfCheckCode = e?.code ?? null; }
  assert.equal(armed.writeEio, false, 'the fs-boundary injection was consumed at the real write');
  assert.equal(selfCheckCode, 'EIO', 'the injection must reach src/fs-atomic.js ESM bindings');
  try { unlinkSync(selfCheckTarget); } catch {}

  stats.tempOpens.length = 0;
  stats.renames.length = 0;
});

beforeEach(() => {
  // Every case starts from a settled pool with a healthy boundary; a case that
  // leaves dirt behind must not leak it into the next one.
  armed.writeEio = false;
  armed.dirFsyncEio = false;
  __flushDirtyAccounts();
  assert.equal(__isAccountsDirty(), false, 'precondition: the pool starts clean');
});

after(() => {
  try { __flushDirtyAccounts(); } catch {}
  for (const account of created) removeAccount(account.id);
  __setModelCatalogDeps(null);
  restoreFsBoundary();
});

describe('accounts.json dirty bookkeeping — persistence outcome owns the retry signal', () => {
  it('keeps the pool dirty when the lazy flush write fails', () => {
    createAccount(KEY(1));
    recordAccountSpend(KEY(1), spend(5, 5, 10));
    assert.equal(__isAccountsDirty(), true, 'a lazy mutation arms the flush');

    armed.writeEio = true;
    __flushDirtyAccounts();

    assert.equal(armed.writeEio, false, 'the injected EIO was consumed by the real temp-file write');
    assert.equal(__isAccountsDirty(), true, 'a failed save must leave the pool dirty for the next flush');
    assert.equal(requestsOnDisk(KEY(1)), 0, 'the failed save published nothing');
    assert.deepEqual(pendingTemps(), [], 'the failed temp file was cleaned up');
  });

  it('retries a failed batch on the next flush without waiting for another mutation', () => {
    createAccount(KEY(2));
    recordAccountSpend(KEY(2), spend(11, 4, 15));
    const opensBefore = stats.tempOpens.length;

    armed.writeEio = true;
    __flushDirtyAccounts();
    assert.equal(stats.tempOpens.length, opensBefore + 1, 'the flush attempted exactly one write');
    assert.equal(requestsOnDisk(KEY(2)), 0, 'the failed attempt published nothing');

    // Storage healthy again, NO new mutation: the periodic flush must recover the batch.
    __flushDirtyAccounts();
    assert.equal(requestsOnDisk(KEY(2)), 1, 'the pending batch reached disk on the next flush');
    assert.equal(accountOnDisk(KEY(2))._totalSpend.totalTokens, 15, 'with the mutated values');
    assert.equal(__isAccountsDirty(), false, 'the successful save cleared the flag');

    // And a clean pool still writes nothing (the flag is not left permanently armed).
    const opensAfterRetry = stats.tempOpens.length;
    __flushDirtyAccounts();
    assert.equal(stats.tempOpens.length, opensAfterRetry, 'a clean pool performs no further write');
  });

  it('marks the pool dirty when a direct save fails while previously clean', () => {
    assert.equal(__isAccountsDirty(), false, 'precondition: clean pool, nothing pending');

    armed.writeEio = true;
    created.push(addAccountByKey(KEY(3), EMAIL));   // its own saveAccounts() is the direct write

    assert.equal(armed.writeEio, false, 'the injected EIO was consumed by the real write');
    assert.equal(__isAccountsDirty(), true, 'a direct save failure from a clean pool must leave it dirty');
    assert.equal(accountOnDisk(KEY(3)), null, 'the failed save published nothing');

    __flushDirtyAccounts();
    assert.equal(accountOnDisk(KEY(3))?.apiKey, KEY(3), 'the retry persisted the in-memory account');
    assert.equal(__isAccountsDirty(), false, 'and cleared the flag');
  });

  it('keeps the pool dirty when saveAccountsSync fails, and its retry persists', () => {
    createAccount(KEY(4));
    recordAccountSpend(KEY(4), spend(3, 2, 5));
    assert.equal(__isAccountsDirty(), true, 'a lazy mutation armed the flag');

    armed.writeEio = true;
    saveAccountsSync();

    assert.equal(armed.writeEio, false, 'the injected EIO was consumed by the real write');
    assert.equal(__isAccountsDirty(), true, 'the sync flush must not consume the retry signal');
    assert.equal(requestsOnDisk(KEY(4)), 0, 'the failed sync flush published nothing');

    saveAccountsSync();
    assert.equal(__isAccountsDirty(), false, 'a successful sync flush clears the flag');
    assert.equal(requestsOnDisk(KEY(4)), 1, 'the retry landed on disk');
  });

  it('marks a clean pool dirty when a direct saveAccountsSync fails, and a later flush retries', () => {
    createAccount(KEY(6));
    assert.equal(__isAccountsDirty(), false, 'precondition: clean pool, nothing pending');

    armed.writeEio = true;
    saveAccountsSync();                          // direct sync save of an already-clean pool

    assert.equal(armed.writeEio, false, 'the injected EIO was consumed by the real write');
    assert.equal(__isAccountsDirty(), true, 'a failed sync save from a clean pool must leave the pool dirty');
    assert.equal(accountOnDisk(KEY(6))?.apiKey, KEY(6), 'the previously published account is untouched');

    // No new mutation is needed: the ordinary dirty flush is the retry.
    const renamesBefore = stats.renames.length;
    __flushDirtyAccounts();
    assert.equal(stats.renames.length, renamesBefore + 1, 'the retry published the current memory');
    assert.equal(__isAccountsDirty(), false, 'and cleared the flag');
    assert.equal(accountOnDisk(KEY(6))?.apiKey, KEY(6), 'the account survives the rewrite');
    assert.deepEqual(pendingTemps(), []);
  });

  it('keeps the retry signal when the parent-directory fsync fails after a published rename', () => {
    createAccount(KEY(5));
    recordAccountSpend(KEY(5), spend(9, 1, 10));
    const renamesBefore = stats.renames.length;

    armed.dirFsyncEio = true;
    __flushDirtyAccounts();

    assert.equal(armed.dirFsyncEio, false, 'the directory-fsync EIO was consumed after a real rename');
    assert.equal(requestsOnDisk(KEY(5)), 1, 'the rename had already published the new bytes');
    assert.equal(__isAccountsDirty(), true, 'an unproven directory entry must not consume the retry signal');
    assert.deepEqual(pendingTemps(), [], 'the consumed temp was renamed away, not left behind');

    // The retry must publish from a FRESH temp file: the previous one was consumed
    // by the successful rename, so re-renaming it is not an option.
    __flushDirtyAccounts();
    assert.equal(__isAccountsDirty(), false, 'the retry succeeded and cleared the flag');
    const published = stats.renames.slice(renamesBefore);
    assert.equal(published.length, 2, 'both attempts published');
    assert.notEqual(published[0], published[1], 'the retry republished from a fresh temp file');
    assert.equal(requestsOnDisk(KEY(5)), 1, 'the rewrite is idempotent — memory is not double-counted');
    assert.deepEqual(pendingTemps(), []);
  });
});
