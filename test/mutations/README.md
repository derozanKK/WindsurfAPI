# Mutation specs

Checked-in mutation runs for `scripts/mutate-verify.mjs`:

```bash
npm run mutate -- test/mutations/<name>.json
```

## Why these are in the repo

The ledger's trust rests on mutation verification — "a test that has never failed is not a
test". But historically each run lived only in whoever's terminal produced it, so the claim
"5 mutations, all CAUGHT" in a release note could not be re-checked by the next person, and
a guard that silently stopped biting after a refactor would keep its old reputation.

A spec here makes the claim executable. If an assertion decays, `npm run mutate` says so.

## What a spec asserts

`expectCaught: true` (the default) means the suite MUST fail under that mutation.
`expectCaught: false` marks a **documented survivor** — a mutation the suite knowingly does
not catch. Those are not oversights to be fixed later; each one should be explained in the
`name` and in the ledger, because "this guard cannot cover that" is a real finding worth
keeping (see AUDIT-LEDGER round 8 on the `WAITABLE` allowlist).

## The guards that matter more than the specs

`mutate-verify.mjs` refuses to run at all when:

- **the working tree is dirty** — the loop's own `git checkout HEAD --` restore would
  destroy an uncommitted fix, and every mutation afterwards would measure "fix missing"
  instead of "mutation applied". That failure looks exactly like the mutation being caught,
  so it reads as success. Recorded in ledger round 4, then hit again in round 8 by the
  person who wrote it down;
- **the baseline is not green, or does not match `expectBaselinePass`** — a `SURVIVED`
  verdict is meaningless if the suite was not running. Round 3 collected four false
  `SURVIVED` results from a suite that never executed. A baseline that node CANCELLED is
  reported as **truncated**, not as a failing suite: on node 22 a legitimate run reported
  `pass=99 fail=0 cancelled=95` when the event loop drained before the rest of the suite
  ran, and calling that red sent the reader after assertions that never executed;
- **an anchor does not match exactly once** — a non-matching `replace()` is a silent no-op
  that reports `SURVIVED` while nothing was ever mutated.

It also restores with `git checkout HEAD --` rather than `git checkout --`, because the
latter reads the **index**: anything staged mid-run would be reinstated instead of HEAD.
Round 7 lost a revert that way.
