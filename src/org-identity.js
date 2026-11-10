/**
 * Org/team identity for pool-level arithmetic.
 *
 * Some pool numbers are ORGANIZATION-scoped, not account-scoped: the on-demand
 * `$` balance on Teams plans is read from the same team for every member, so
 * summing it once per account multiplies the pool total by the team size (the
 * 3.9.53 KPI did exactly that and said so in a code comment). To add balances
 * up honestly the dashboard needs one identity per billing owner.
 *
 * That identity is shared with the ACU reader (`dashboard/acu-usage.js`), which
 * already resolves the real app.devin.ai org per account. Once a panel read has
 * resolved an org, `rememberAccountOrg` records the mapping and the learned
 * `orgref-…` handle is authoritative. Before that (or for a pool with no Devin
 * session token) the team id carried by GetUserStatus is the next-best
 * identity. Nothing is guessed: an account with no known org/team is its own
 * billing owner.
 *
 * The handle is the same non-reversible `orgref-<hash>` the ACU panel shows, so
 * a raw org/team id never leaves the server.
 */

import { createHash } from 'node:crypto';

/** Cap on remembered account→org mappings (a pool is far smaller than this). */
const MAX_LEARNED = 4096;

/** accountId → orgRef, filled by the ACU reader's membership resolution. */
const learned = new Map();

/**
 * Stable, non-reversible handle for an org/team id. Kept byte-identical to the
 * ACU panel's handle so the two views name the same org the same way.
 */
export function orgRefOf(orgId) {
  return `orgref-${createHash('sha256').update(String(orgId || '')).digest('hex').slice(0, 12)}`;
}

/** Record the org an account was resolved into (called by the ACU reader). */
export function rememberAccountOrg(accountId, orgId) {
  const id = String(accountId || '');
  if (!id || !orgId) return;
  if (!learned.has(id) && learned.size >= MAX_LEARNED) {
    const oldest = learned.keys().next().value;
    if (oldest !== undefined) learned.delete(oldest);
  }
  learned.set(id, orgRefOf(orgId));
}

/** The learned org handle for an account, or '' when it was never resolved. */
export function learnedOrgRefOf(accountId) {
  return learned.get(String(accountId || '')) || '';
}

/** Test seam: drop every learned mapping. */
export function __resetOrgIdentityForTest() {
  learned.clear();
}

/**
 * Billing-owner key for one account.
 *
 * Order: ACU-resolved org → GetUserStatus team id → the account itself. The
 * first two are namespaced apart (`org:` vs `team:`) because the Devin org id
 * and the Windsurf team id live in different id spaces; merging them on the
 * string alone would invent a shared balance that was never observed.
 *
 * @returns {{key: string, source: 'org'|'team'|'account'}}
 */
export function balanceGroupOf(account) {
  if (!account || typeof account !== 'object') return { key: 'account:', source: 'account' };
  const id = String(account.id || '');
  const known = learnedOrgRefOf(id);
  if (known) return { key: `org:${known}`, source: 'org' };
  const teamId = String(account?.userStatus?.teamId || '').trim();
  if (teamId) return { key: `team:${orgRefOf(teamId)}`, source: 'team' };
  return { key: `account:${id}`, source: 'account' };
}
