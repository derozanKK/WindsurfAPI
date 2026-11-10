# DashboardP1 — P1 audit closure (colour + layout)

- **Base:** `b201cc8e` (`feat/dashboard-color`, 2026-10-25)
- **Branch:** `feat/dashboard-p1`
- **Scope:** the P1 quick wins in `evidence/audit/KimiDashColor.md` and the P1 findings in `evidence/audit/KimiDashLayout.md`. No P2 structural work.

## 1. Colour P1 — measured before → after

Ratios are WCAG 2.2 sRGB; before values are the audit measurements on the pre-colour baseline (`c60d7469`), after values are the shipped tokens on this branch, measured by `scripts/check-dashboard-contrast.mjs` (all floors: 4.5 text, 3.0 UI/graphic, 1.08 ladder).

| Pair | Before light | After light | Before dark | After dark |
|---|---:|---:|---:|---:|
| `--accent-text` on `--surface` | 3.57 | **6.05** | 5.90 | **7.01** |
| `--success-text` on `--surface` | 3.68 | **6.02** | 5.01 | **7.84** |
| `--warn-text` on `--surface` | 3.62 | **5.93** | 8.12 | **8.59** |
| `--error-text` on `--surface` | 3.74 | **6.18** | 4.92 | **6.67** |
| `--info-text` on `--surface` | 3.53 | **6.14** | 6.29 | **8.30** |
| `--accent-text` on `--accent-soft` | 3.04 | **5.17** | 4.45 | **5.28** |
| `--success-text` on `--success-soft` | 3.10 | **5.07** | 3.77 | **5.87** |
| `--warn-text` on `--warn-soft` | 3.21 | **5.26** | 5.42 | **5.71** |
| `--error-text` on `--error-soft` | 3.14 | **5.20** | 3.84 | **5.20** |
| `--info-text` on `--info-soft` | 3.04 | **5.29** | 4.46 | **5.90** |
| `.btn-success:hover` label/fill (brightness filter) | 4.24 | **5.33** | 4.38 | **5.95** |
| `.btn-danger:hover` label/fill (brightness filter) | 4.16 | **5.47** | 4.31 | **6.10** |
| Focus indicator: wash-only → `--accent-focus` outline | 1.17 | **5.70** | 1.33 | **8.20** |
| Control boundary: `--border` → `--border-control` on `--surface` | 1.22 | **4.34** | 1.31 | **4.10** |
| `--border-control` on `--surface-2` / `--surface-3` | — | **4.12 / 4.00** | — | **4.03 / 3.89** |

Other P1 colour counts:

| Metric | Before (`b201cc8e`) | After |
|---|---:|---:|
| `filter: brightness(.92)` button hovers | 2 | **0** |
| `var(--muted)` / `var(--info-bg)` references | 3 | **0** |
| Undefined custom properties (contrast gate) | 3 | **0** |
| Literal `font-size` below 12 px | 90 | **0** |
| Uses of 9/10/11 px `--fs-3xs/2xs/xs` tokens | 24 | **0** |
| `.badge` base font-size | 11 px | **12 px** |
| `.badge-success` markup mapped to success variant | no | **yes** |

New tokens added in both themes: `--on-success`, `--on-warn`, `--on-error`, `--on-info`, `--success-hover`, `--warn-hover`, `--error-hover`, `--info-hover`.

## 2. Layout P1 — before → after

| # | Finding | After |
|---|---|---|
| 1 | Destructive confirm armed for immediate Enter | Danger dialogs focus **Cancel** first and never approve on a bare Enter; bulk delete above the visible page requires typing the exact selected count (`confirm.requireText`). |
| 2 | Overview failure leaves skeletons or stale KPIs | First failure paints an inline error card with reason + Retry; later failure keeps last-good KPIs and shows a persistent `overview-stale-banner` (“stale since [time]”) with Retry. Polling backs off 15 s → 30 s → 60 s and resets on success. Secondary `{success:false}` sources render unavailable, not zero/empty. |
| 3 | Delete reports success after a rejected DELETE | `deleteAccount` returns early on `!r || r.success === false`, keeps row/drawer/selection/caches, and shows an inline error + Retry. `resetErrors`, `resetStats`, `resetSystemPrompt`, `clearGlobalProxy`, `clearConversationPool` follow the same response gate. |
| 5 | Mobile rail / undersized targets | Below 720 px: top app bar + labelled off-canvas drawer (`#mobile-menu-btn`, `aria-expanded`, mask); settings search hidden unless the settings drawer is open; row menu, pagination, `.btn-xs`, filter inputs ≥44 px; desktop icon-rail links get runtime `title` + `aria-label`. |
| 8 | Settings writes claim saved before success | One in-flight write per key; control disabled + `aria-busy` + “Saving…” status; only a `{success:true}` envelope earns a success toast; failure restores the previous checkbox/value and leaves an inline Retry. `_putBackendSwitch` throws instead of toasting success on failure. |
| 9 | Global mobile `.table-wrap { overflow-x: visible }` clips every table | The override is scoped to `.accounts-table-wrap` only. Other `.table-wrap`s keep `overflow-x:auto` + `overscroll-behavior-inline:contain`, and are keyboard-focusable (`tabindex=0`, `role=region`, `aria-label`). |

## 3. Checks / tests / smoke

Run in the `feat/dashboard-p1` worktree:

```text
node scripts/check-dashboard-contrast.mjs   ✓ every token pair clears its WCAG floor in both themes
node scripts/check-dashboard-scale.mjs      ✓ account/usage surfaces use the spacing + type tokens
node scripts/check-dashboard-copy.mjs       ✓ account/usage scope is free of machine identifiers
node src/dashboard/check-i18n.js            ✓ All i18n checks passed
node --test --test-concurrency=1 test/dashboard-*.test.js
  ℹ tests 642  ℹ pass 642  ℹ fail 0
npm run smoke:dashboard
  DASHBOARD-SMOKE SUMMARY: 18/18 flows passed, 0 failed
node scripts/dashboard-cdp-check.mjs
  All dashboard CDP checks passed (zero console errors/exceptions)
```

`test/dashboard-p1-fixes.test.js` adds 23 assertions covering the colour tokens/pairs, typography floor, badge matrix, destructive-confirm defaults, delete response gating, settings rollback/serialization, overview lifecycle and mobile/table CSS.

## 4. Diffstat

See the final handoff report; the branch diff against `b201cc8e` is the authoritative diffstat.
