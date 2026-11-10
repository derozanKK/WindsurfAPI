# DashboardColor — coherent palette, AA status states, accent ramp

- **Base:** `c60d7469` (`master`)
- **Worktree:** `w130-dashboardcolor`
- **Branch:** `feat/dashboard-color`
- **Scope:** `src/dashboard/index.html` custom properties + colour-only declarations.
  No DOM restructure, no layout metrics, no copy/i18n strings.
- **Theme mechanism:** the existing `data-theme="dark"` attribute + `dashboard_theme`
  localStorage toggle is unchanged (the dashboard already has the state plumbing, so
  no second `prefers-color-scheme` path was added).

## 1. Audit — existing tokens are reused, not forked

Command required by the brief:

```bash
grep -o 'var(--[a-z-]*)' src/dashboard/index.html | sort | uniq -c
```

The audit found the dashboard already has one token system: `--surface` /
`--surface-2` / `--surface-3`, `--accent` / `--accent-hover` / `--accent-soft` /
`--on-accent`, the four status families, `--border` / `--border-strong`, and the
`--text-*` ladder. The ten most-used tokens before this pass:

| uses | token | role |
|---:|---|---|
| 97 | `--text-muted` | secondary label |
| 89 | `--text-dim` | tertiary label |
| 81 | `--accent` | brand fill / link (pre-pass) |
| 75 | `--border` | card / divider hairline |
| 70 | `--error` | danger fill / status |
| 54 | `--text` | body copy |
| 42 | `--warn` | warning fill / status |
| 41 | `--success` | success fill / status |
| 25 | `--surface` | card surface |
| 21 | `--border-strong` | strong divider / hover |

The new tokens are extensions of the **same** families — `--accent-{text,active,focus}`,
`--{success,warn,error,info}-text`, `--border-control`, `--gradient-accent` — not a
parallel palette. Every existing selector and class still resolves.

## 2. Palette table (before → after)

Hex values are the shipped token values. `—` means the token did not exist.
`rgba(...)` is shown with its resolved value on `--surface` where useful.

| token | role | light before | light after | dark before | dark after |
|---|---|---|---|---|---|
| `--bg` | page canvas | `var(--paper)` #f4f4f5 | `var(--paper)` #f4f4f5 | `var(--paper)` #080808 | `var(--paper)` #080808 |
| `--bg-elev` | field / inset step | `var(--paper)` #f4f4f5 | `var(--surface-2)` #ececee | `var(--paper-2)` #141414 | `var(--surface-2)` #1d1d1d |
| `--surface` | card surface | #ffffff | #ffffff | #141414 | #141414 |
| `--surface-2` | control / nested | `var(--paper-2)` #ececee | `var(--paper-2)` #ececee | #1d1d1d | #1d1d1d |
| `--surface-3` | raised / chips | `var(--paper-3)` #e2e2e5 | `var(--paper-3)` #e2e2e5 | #262626 | #262626 |
| `--border` | decorative hairline | rgba(24,24,27,.10) | rgba(24,24,27,.10) | rgba(255,255,255,.10) | rgba(255,255,255,.10) |
| `--border-strong` | strong divider / hover | rgba(24,24,27,.18) | rgba(24,24,27,.18) | rgba(255,255,255,.18) | rgba(255,255,255,.18) |
| `--border-control` | interactive boundary | — | rgba(24,24,27,.58) → #79797b | — | rgba(255,255,255,.42) → #777777 |
| `--accent` | brand fill / dot | #d06b49 | #d06b49 | #d97757 | #d97757 |
| `--accent-hover` | hover fill | #c86543 | #c86543 | #c86543 | #c86543 |
| `--accent-active` | pressed border | — | #b85738 | — | #b85f42 |
| `--accent-focus` | focus ring | — | #a84a2e | — | #e89a7d |
| `--accent-text` | AA link / label | — | #a3462b | — | #df8a6b |
| `--accent-soft` | accent wash | rgba(208,107,73,.14) | rgba(208,107,73,.14) | rgba(217,119,87,.20) | rgba(217,119,87,.20) |
| `--on-accent` | label on solid fills | #18181b | #18181b | #141414 | #141414 |
| `--gradient-accent` | header / summary wash | — | `linear-gradient(135deg, var(--accent-soft), transparent 72%)` | — | same recipe |
| `--success` | success fill / dot | #788c5d | #788c5d | #788c5d | #788c5d |
| `--success-soft` | success wash | rgba(120,140,93,.16) | rgba(120,140,93,.16) | rgba(120,140,93,.22) | rgba(120,140,93,.22) |
| `--success-text` | AA success label | — | #4f6b36 | — | #96b277 |
| `--warn` | warning fill / dot | #b07d1c | #b07d1c | #d9a257 | #d9a257 |
| `--warn-soft` | warning wash | rgba(217,162,87,.16) | rgba(217,162,87,.16) | rgba(217,162,87,.22) | rgba(217,162,87,.22) |
| `--warn-text` | AA warning label | — | #8a5a00 | — | #d9a95f |
| `--error` | danger fill / dot | #cc6658 | #cc6658 | #cc6658 | #cc6658 |
| `--error-soft` | danger wash | rgba(198,93,78,.14) | rgba(198,93,78,.14) | rgba(198,93,78,.22) | rgba(198,93,78,.22) |
| `--error-text` | AA danger label | — | #ad392c | — | #da8578 |
| `--info` | info fill / dot | #5b8cc0 | #5b8cc0 | #6a9bcc | #6a9bcc |
| `--info-soft` | info wash | rgba(106,155,204,.16) | rgba(106,155,204,.16) | rgba(106,155,204,.22) | rgba(106,155,204,.22) |
| `--info-text` | AA info label | — | #2a6599 | — | #7cb2ee |
| `--text` | body copy | `var(--ink)` #18181b | `var(--ink)` #18181b | `var(--ink)` #ededed | `var(--ink)` #ededed |
| `--text-muted` | secondary copy | #52525b | #52525b | #a1a1aa | #a1a1aa |
| `--text-dim` | tertiary copy | #626269 | #626269 | #90909a | #90909a |

The base status hues and `--accent` stay the **fill/dot** colours: they clear the
3:1 graphical floor and carry `--on-accent` labels on solid fills. The new
`-text` twins are the AA label colours for `--surface` and the matching `-soft`
wash. That split is required because a single hex cannot simultaneously be a
light fill with dark `--on-accent` text and an AA dark label on a white surface.

## 3. Contrast proof (new pairs)

Machine checks:

```bash
node scripts/check-dashboard-contrast.mjs   # ✓ every token pair clears its WCAG floor
node --test test/dashboard-color-system.test.js
# ✔ 6 tests, 0 fail — surface ramp, accent states, text twins, control borders,
#   on-accent fills, and token-routing assertions
```

The extended gate computes the new pairs with WCAG 2.2 sRGB math. Floors:
**4.5:1 text**, **3:1 UI border / graphical object**, **1.08 surface ladder**.

| pair | light | dark |
|---|---:|---:|
| `--accent-text` on `--surface` | 6.05 | 7.01 |
| `--accent-text` on `--surface-2` | 5.13 | 6.41 |
| `--accent-text` on `--surface-3` | 4.68 | 5.75 |
| `--accent-text` on `--accent-soft` | 5.17 | 5.28 |
| `--success-text` on `--surface` / `--surface-2` / `--surface-3` | 6.02 / 5.10 / 4.66 | 7.84 / 7.17 / 6.44 |
| `--success-text` on `--success-soft` | 5.07 | 5.87 |
| `--warn-text` on `--surface` / `--surface-2` / `--surface-3` | 5.93 / 5.02 / 4.58 | 8.59 / 7.86 / 7.06 |
| `--warn-text` on `--warn-soft` | 5.26 | 5.71 |
| `--error-text` on `--surface` / `--surface-2` / `--surface-3` | 6.18 / 5.24 / 4.78 | 6.67 / 6.11 / 5.48 |
| `--error-text` on `--error-soft` | 5.20 | 5.20 |
| `--info-text` on `--surface` / `--surface-2` / `--surface-3` | 6.14 / 5.20 / 4.75 | 8.30 / 7.59 / 6.82 |
| `--info-text` on `--info-soft` | 5.29 | 5.90 |
| `--border-control` on `--surface` / `--surface-2` / `--surface-3` | 4.34 / 4.12 / 4.00 | 4.10 / 4.03 / 3.89 |
| `--accent-focus` on `--surface` | 5.70 | 8.20 |
| `--accent-active` on `--surface` | 4.71 | 4.17 |
| `--on-accent` on `--accent` / `--accent-hover` | 4.96 / 4.55 | 5.90 / 4.74 |
| `--on-accent` on `--success` / `--warn` / `--error` / `--info` | 4.82 / 4.89 / 4.73 / 5.03 | 5.01 / 8.12 / 4.92 / 6.29 |

### Before: why the `-text` twins were necessary

Using the old base hues as text on their own soft wash failed AA in both themes:

| pair | light before | dark before |
|---|---:|---:|
| `--accent` on `--accent-soft` | 3.04 | 4.45 |
| `--success` on `--success-soft` | 3.10 | 3.77 |
| `--warn` on `--warn-soft` | 3.21 | 5.42 |
| `--error` on `--error-soft` | 3.14 | 3.84 |
| `--info` on `--info-soft` | 3.04 | 4.46 |
| old `--border-strong` on `--surface` (UI boundary) | 1.47 | 1.72 |

## 4. Surface / elevation ramp

The ramp is the existing `--paper` → `--surface` → `--surface-2` → `--surface-3`
ladder; `--bg-elev` is now the field step of that same ramp in both themes
(previously it was `--paper` in light and `--paper-2` in dark, so fields did not
sit on a consistent rung). Shadows pair with it: `--shadow-sm` (card) →
`--shadow` (hover/popover) → `--shadow-lg` (modal). Adjacent-step ratios:

| step | light | dark |
|---|---:|---:|
| `--surface` vs `--paper` | 1.10 | 1.09 |
| `--surface-2` vs `--surface` | 1.18 | 1.09 |
| `--surface-3` vs `--surface-2` | 1.10 | 1.11 |

## 5. Accent gradient for header / summary cards

- `.page-header::before` paints `var(--gradient-accent)` on an absolutely
  positioned pseudo-element (`inset: -10px -14px`, `z-index: -1`). It adds no
  box to the flow, so the header's 24px rhythm and all wrapping are unchanged.
- `.metrics-grid .card` gets the same wash via `background-image:
  var(--gradient-accent)`, layered over the existing `background: var(--surface)`
  and existing status left rails. No border, padding, grid or content changes.
- The recipe is one token built from the existing `--accent-soft`, so light and
  dark share the same definition and the gradient can never drift from the accent.

## 6. Checks

All run in the worktree on this branch:

```text
node scripts/check-dashboard-contrast.mjs
✓ dashboard palette: every token pair clears its WCAG floor in both themes

node scripts/check-dashboard-copy.mjs
✓ dashboard copy: account/usage scope is free of machine identifiers

node scripts/check-dashboard-scale.mjs
✓ dashboard scale: account/usage surfaces use the spacing + type tokens

node src/dashboard/check-i18n.js
✓ All i18n checks passed!

node --test --test-concurrency=1 test/dashboard-*.test.js
ℹ tests 619
ℹ pass 619
ℹ fail 0
```

The serial run includes `test/dashboard-color-system.test.js` (6 assertions over
the new pairs) and the existing `dashboard-ui-p2.test.js` contrast gate.

## 7. `git diff --stat`

```text
 evidence/DashboardColor.md                | 208 ++++++++++++++++++
 scripts/check-dashboard-contrast.mjs      |  64 +++++-
 src/dashboard/index.html                  | 335 +++++++++++++++++-------------
 test/dashboard-color-system.test.js       | 122 +++++++++++
 test/dashboard-devin-cards-render.test.js |   2 +-
 test/dashboard-escape-callsites.test.js   |  57 ++---
 6 files changed, 613 insertions(+), 175 deletions(-)
```

## 8. Layout / behaviour guard

- `src/dashboard/index.html`: the diff changes custom-property values, `color`
  declarations, `border-color`/`background-image` declarations, and adds one
  absolute pseudo-element. No `padding`, `margin`, `width`, `height`, `gap`,
  grid, font-size or DOM text changes.
- No i18n file changed; `check-i18n` and `check-dashboard-copy` are green.
- The existing light/dark toggle (`data-theme="dark"` + `dashboard_theme`) is
  untouched; both themes are covered by every new contrast pair.
- `test/dashboard-escape-callsites.test.js` line pins moved by the insertion
  (the guard is deliberately line-sensitive); the reviewed entries were
  re-anchored to the same live sites, and its five tests stay green.
