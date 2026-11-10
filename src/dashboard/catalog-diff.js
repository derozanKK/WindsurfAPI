/**
 * Pure live-vs-snapshot catalog diff for the dashboard.
 *
 * The live rows are the account-scoped `GetCliModelConfigs` catalog; the
 * snapshot is the committed cold-start fallback. Neither is an entitlement
 * proof, so this reports set differences and alias resolution only — it never
 * says a selector is runnable for a given plan.
 */

function selectorOf(row) {
  if (typeof row === 'string') return row.trim();
  if (row && typeof row === 'object' && typeof row.selector === 'string') return row.selector.trim();
  return '';
}

function aliasOf(row) {
  return row && typeof row === 'object' && typeof row.alias === 'string' ? row.alias.trim() : '';
}

/**
 * @param {object} input
 * @param {Array<string|object>} input.live
 * @param {string[]} input.snapshot
 * @param {(name: string) => {selector: string, mapped: boolean}} [input.resolve]
 */
export function buildCatalogDiff({ live = [], snapshot = [], resolve = null } = {}) {
  const liveRows = [];
  const liveSet = new Set();
  for (const row of live) {
    const selector = selectorOf(row);
    if (!selector || liveSet.has(selector)) continue;
    liveSet.add(selector);
    liveRows.push({ selector, alias: aliasOf(row) || null });
  }
  const snapSet = new Set((snapshot || []).map(selectorOf).filter(Boolean));

  // An empty live catalog means "not synced yet", not "upstream has zero
  // models". Reporting every snapshot row as missing would be a false alarm.
  const synced = liveSet.size > 0;
  const added = synced ? [...liveSet].filter((s) => !snapSet.has(s)).sort() : [];
  const missing = synced ? [...snapSet].filter((s) => !liveSet.has(s)).sort() : [];

  const aliases = [];
  const seenAlias = new Set();
  for (const row of liveRows) {
    if (!row.alias || seenAlias.has(row.alias)) continue;
    seenAlias.add(row.alias);
    const r = resolve ? resolve(row.alias) : null;
    aliases.push({
      alias: row.alias,
      mapped: r ? !!r.mapped : null,
      selector: r?.selector || null,
    });
  }
  aliases.sort((a, b) => a.alias.localeCompare(b.alias));

  const unmapped = resolve
    ? [...liveSet].filter((s) => !resolve(s).mapped).sort()
    : [];

  return {
    synced,
    snapshotCount: snapSet.size,
    liveCount: liveSet.size,
    added,
    missing,
    aliases,
    unmapped,
    aliasCount: aliases.length,
    unmappedCount: unmapped.length,
  };
}
