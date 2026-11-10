# ThemeRevert — dashboard palette back to the pre-workbuddy2api-hub look

- **Base:** `19ff92e` (`release/3.10.0`), worktree `w84-theme`, branch `fix/theme-revert`.
- **Change:** `src/dashboard/index.html` only — the two token blocks plus one warm
  `box-shadow` literal. 97 insertions / 97 deletions, **net line count unchanged** (the
  escape-callsite guard pins absolute line numbers; a net-zero diff keeps every pin valid).
- **Not touched:** layout, grid, spacing/type/radius scales, `--acct-row-pad-y` (44 px row
  budget), chart rendering, any JS, i18n, typography (no Google Fonts re-introduced).
- **Screenshots:** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/theme-revert-shots/shots/`
  (the repo tracks no PNGs, so the images live in the lane artifacts).

## 1. Where the old palette lives

The warm "Workshop Paper" palette came in with the account-UI merge, not with the P2
token pass:

```
062b425 feat(dashboard): merge account management into one page
        "workshop-paper tokens (light+dark) … via UIResearch §2.1 / UIPlan card A"
```

Its parent `e9be4da` (`fix(dashboard): classify OAuth-only accounts and add email-code
login`) is the last commit with the cool-neutral theme:

```bash
git show e9be4da:src/dashboard/index.html
#   /* ── Cool-neutral light theme (KiroStudio-style: no warm cast) ── */
#   --paper #fafafa  --paper-2 #f4f4f5  --paper-3 #ececee  --ink #18181b
#   --accent #d97757 (clay)  --blue #6a9bcc  --green #788c5d  --warn #d9a257
#   [data-theme="dark"]  --paper #0a0a0a  --surface #141414  --accent #d97757
```

Restored from that block: every surface/ink/accent/status/chart/shadow/scrim/tip token.
Tokens that did **not** exist then but are referenced by today's CSS were kept and
re-valued against the restored ladder: `--prov-*`, `--brand-*`, `--space-*`, `--fs-*`,
`--radius-*`, `--text-faint`, `--on-accent`, `--think`, `--scrim`.

## 2. The old palette fails the shipped gate — every deviation is measured

`scripts/check-dashboard-contrast.mjs` postdates the old palette (no `--on-accent`,
`--prov-*`, `--brand-*` then), so the audit re-runs the same floors and formulas over the
old values with `--on-accent` standing in for the literal `#fff` the old `.btn-primary`
used:

```bash
node theme-revert-shots/old-palette-ratios.mjs <w84-theme> e9be4da   # 13 FAIL lines
```

| theme | pair | old ratio | floor |
|---|---|---|---|
| light | `--surface` vs `--paper` | 1.04 | 1.08 |
| light | `--surface-3` vs `--surface-2` | 1.07 | 1.08 |
| light | `--text-dim` on surface | 2.56 | 4.5 |
| light | `--warn` on surface | 2.27 | 3 |
| light | `--info` on surface | 2.93 | 3 |
| light | `--on-accent` on `--accent` | 3.12 | 4.5 |
| light | `--text-dim` on `--surface-3` | 2.17 | 3 |
| light | `--warn` on `--warn-soft` | 2.01 | 3 |
| light | `--info` on `--info-soft` | 2.52 | 3 |
| light | `--accent` on `--accent-soft` | 2.71 | 3 |
| dark | `--surface` vs `--paper` | 1.07 | 1.08 |
| dark | `--text-dim` on surface | 3.81 | 4.5 |
| dark | `--on-accent` on `--accent` | 3.12 | 4.5 |

So an exact byte-for-byte restore would ship a red gate. Each deviation is the smallest
move in the same hue family that clears its floor; everything not listed is the old value.

| token | pre-workbuddy | shipped | why |
|---|---|---|---|
| light `--paper` | `#fafafa` | `#f4f4f5` | surface/paper 1.04 → 1.10 |
| light `--paper-2` | `#f4f4f5` | `#ececee` | ladder step after paper moved (surface-2 vs surface 1.18) |
| light `--paper-3` | `#ececee` | `#e2e2e5` | surface-3 vs surface-2 1.07 → 1.10 |
| light `--text-muted` | `#71717a` | `#52525b` | dim had to take `#71717a`; muted steps one zinc rung darker to keep the hierarchy (7.73 on surface) |
| light `--text-dim` | `#a1a1aa` | `#71717a` | 2.56 → 4.83 |
| light `--accent` | `#d97757` | `#d06b49` | accent-on-accent-soft 2.71 → 3.04 (3.57 on surface) |
| light `--accent-hover` | `#c56245` | `#c86543` | ink label on hover fill 4.39 → 4.55 |
| light `--on-accent` | `#fff` (literal) | `#18181b` | white on clay 3.12 → ink 4.96; clay stays the signature hue |
| light `--warn` | `#d9a257` | `#b07d1c` | 2.27 surface / 2.01 soft → 3.62 / 3.21 |
| light `--info` | `#6a9bcc` | `#5b8cc0` | 2.93 surface / 2.52 soft → 3.53 / 3.04 |
| light `--error` | `#c65d4e` | `#cc6658` | ink label on the danger fill 4.28 → 4.73 (dot on soft 3.14) |
| dark `--paper` | `#0a0a0a` | `#080808` | surface/paper 1.07 → 1.09 |
| dark `--surface-2` | `#1c1c1c` | `#1d1d1d` | 1.08 exactly → 1.09 |
| dark `--text-dim` | `#71717a` | `#90909a` | 3.81 → 5.83 |
| dark `--accent-hover` | `#c56245` | `#c86543` | ink label on hover fill 4.39 → 4.74 |
| dark `--on-accent` | `#fff` (literal) | `#141414` | white on clay 3.12 → ink 5.86 |
| dark `--error` | `#c65d4e` | `#cc6658` | ink label 4.45 → 4.92 |

Filled blocks that take `--on-accent` all clear AA text in both themes with the shipped
values: accent 4.96 / hover 4.55 / success 4.82 / warn 4.89 / error 4.73 / info 5.03
(light) and 5.90 / 4.74 / 5.01 / 8.12 / 4.92 / 6.29 (dark).

## 3. Shipped palette

| token | light | dark |
|---|---|---|
| `--paper` / `--paper-2` / `--paper-3` | `#f4f4f5` / `#ececee` / `#e2e2e5` | `#080808` / `#141414` / `#1f1f1f` |
| `--surface` / `--surface-2` / `--surface-3` | `#ffffff` / `var(--paper-2)` / `var(--paper-3)` | `#141414` / `#1d1d1d` / `#262626` |
| `--ink` / `--text` / `--text-muted` / `--text-dim` / `--text-faint` | `#18181b` / `--ink` / `#52525b` / `#71717a` / `#a1a1aa` | `#ededed` / `--ink` / `#a1a1aa` / `#90909a` / `#71717a` |
| `--border` / `--border-strong` | `rgba(24,24,27,.10)` / `.18` | `rgba(255,255,255,.10)` / `.18` |
| `--accent` / `--accent-hover` / `--on-accent` | `#d06b49` / `#c86543` / `#18181b` | `#d97757` / `#c86543` / `#141414` |
| `--success` / `--warn` / `--error` / `--info` | `#788c5d` / `#b07d1c` / `#cc6658` / `#5b8cc0` | `#788c5d` / `#d9a257` / `#cc6658` / `#6a9bcc` |
| `--chart-req` / `--chart-succ` / `--chart-err` | `#4c9aff` / `#4a9d6a` / `#e0524a` | inherits light (old behaviour) |
| `--tip-bg` / `--tip-fg` | `rgba(24,24,27,.98)` / `#fafafa` | `rgba(28,28,30,.98)` / `var(--text)` |
| `--grid` / `--scrim` | `rgba(24,24,27,.09)` / `rgba(24,24,27,.45)` | `rgba(255,255,255,.09)` / `rgba(0,0,0,.55)` |

Full 81-row before/after token table: `theme-revert-shots/token-diff.md`
(`node token-diff.mjs <w84-theme> 19ff92e`).

## 4. Gates

```bash
node scripts/check-dashboard-contrast.mjs
# ✓ dashboard palette: every token pair clears its WCAG floor in both themes
node scripts/check-dashboard-scale.mjs
# ✓ dashboard scale: account/usage surfaces use the spacing + type tokens
node scripts/check-dashboard-copy.mjs
# ✓ dashboard copy: account/usage scope is free of machine identifiers
```

The two dashboard gates are also asserted from the suite (`dashboard-ui-p2.test.js`
calls `lintDashboardContrast()`; `check:ui` runs both).

## 5. Tests

```bash
node --test --test-concurrency=1 test/dashboard-*.test.js
# ℹ tests 517   ℹ pass 517   ℹ fail 0   ℹ duration_ms 25831.5
```

Serial is required here: a default parallel run lets `dashboard-credentials-route` and
another settings test race on the shared runtime config and flakes one credentials test
(reproduced green in isolation and in the serial run). No palette test failed in either
mode.

## 6. Screenshots + geometry

Captured with headless Chrome (CDP, `theme-revert-shots/shot.mjs`) against the real
server (`PORT=3996 DASHBOARD_PASSWORD=uiprobe DATA_DIR=<fixture> node src/index.js`,
5 fixture accounts), themes forced via `localStorage.dashboard_theme`, toasts from the
fixture 401s removed before capture.

| viewport | before | after |
|---|---|---|
| 1440×900 overview (light) | `before-overview-1440-light.png` | `after-overview-1440-light.png` |
| 1440×900 overview (dark) | `before-overview-1440-dark.png` | `after-overview-1440-dark.png` |
| 390×844 overview (light) | `before-overview-390-light.png` | `after-overview-390-light.png` |
| 390×844 overview (dark) | `before-overview-390-dark.png` | `after-overview-390-dark.png` |
| 1440×900 accounts (light) | `before-accounts-1440-light.png` | `after-accounts-1440-light.png` |
| 390×844 accounts (light) | `before-accounts-390-light.png` | `after-accounts-390-light.png` |

Measured from the same run (`before.json` / `after.json`, identical in both):

- accounts row height at 1440: **44 px** before and after;
- page horizontal overflow at 1440 and 390: **0**; table-wrap overflow **0**;
- wrapped badges: **0**;
- 390 accounts rows stack to 261 px cards — the existing responsive layout, unchanged.

Computed styles after (`computed-styles.json`) confirm the palette reached the browser:

```
light  body  rgb(244,244,245) / rgb(24,24,27)   .btn-primary rgb(208,107,73) on rgb(24,24,27)
dark   body  rgb(8,8,8) / rgb(237,237,237)      .btn-primary rgb(217,119,87) on rgb(20,20,20)
```

## 7. Reproduce

```bash
cd <w84-theme>
node scripts/check-dashboard-contrast.mjs && node scripts/check-dashboard-scale.mjs
PORT=3996 DASHBOARD_PASSWORD=uiprobe DATA_DIR=<fixture-dir> node src/index.js &
cd C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/theme-revert-shots
BASE=http://127.0.0.1:3996 node shot.mjs after
```
