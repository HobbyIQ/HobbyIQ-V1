# CompIQ Pricing Regression Harness

The harness is the **engine of record** for pricing correctness. Every change
to `services/compiq/**` or `modules/compiq/**` must pass it before merge.

This PR (Step 0) ships the harness infrastructure. Tier 1 corpus and the
Tier 3 collector arrive in separate PRs.

---

## Layout

```
backend/harness/
├── README.md                  ← this file
├── clock.ts                   ← Clock interface + Frozen/System impls
├── types.ts                   ← HarnessCase, HarnessResult, CaseConfidence
├── snapshot.ts                ← stable-key JSON serializer
├── diff.ts                    ← human-readable + full JSON diff
├── runner.ts                  ← tier runner with perf budgets
├── corpus/
│   ├── tier1.json             ← committed; 20 canonical cases (PR #3)
│   ├── tier2.json             ← committed; ~100 edge cases (later)
│   └── tier3.jsonl            ← .gitignored; pulled from Cosmos in CI
├── __snapshots__/             ← committed baselines (Tier 1 + 2)
│   └── tier3/                 ← .gitignored
└── regression.test.ts         ← vitest entry; runs all tiers
```

---

## Running locally

```bash
cd backend
npm run test:harness            # all tiers
npm run test:harness -- --tier=1   # Tier 1 only
npm run test:harness -- --tier=1,2 # Tier 1 + 2 (skips Tier 3 fetch)
```

The `--tier` flag is honored via `HARNESS_TIERS` env var
(comma-separated, default `1,2,3`).

---

## Perf budgets (hard caps — enforced in CI)

| Tier | Cases | Budget |
| ---- | ----- | ------ |
| 1    | 20    | 30 s   |
| 2    | ~100  | 2 min  |
| 3    | ≥1000 | 5 min  |

If a tier blows its budget, fix the harness (parallelize, slice the corpus)
**before** adding more cases. A slow harness gets skipped; a skipped
harness defeats the purpose.

---

## Determinism rules

Given identical inputs and an identical injected `Clock`, the engine
produces identical outputs. Period.

- Stages, pipeline, and models must take `Clock` via constructor or
  function arg. No bare `Date.now()` or `new Date()` calls.
- Adapters (Card Hedge, Cosmos, eBay) and config files are exempt.
- A pre-commit lint check enforces this — see
  `backend/harness/scripts/check-determinism.mjs` (wired in Step 2 once
  `stages/` and `pipeline/` dirs exist).

---

## Adding a Tier 1 case

1. Open `corpus/tier1.json`.
2. Append a `HarnessCase` object with `query`, `expectedPriceRange`,
   `expectedMarketState`, `expectedStrategy`, `expectedConfidenceBand`,
   and `notes`.
3. Set `confidence` to `"high"` (you verified the expected) or
   `"suspicious"` (the monolith returns this number but it looks wrong
   to you and you want it overridden before lock).
4. Bump `revision` if you are intentionally changing an existing case;
   set `revisionReason` to a one-sentence explanation.
5. Run `npm run test:harness -- --update-snapshots --tier=1` to
   regenerate baselines.
6. Open a PR. Tier 1 changes require explicit owner approval.

---

## Regenerating baselines (Tier 1 / Tier 2)

**Do not regenerate baselines as part of a feature PR.** Baseline drift
is a deliberate action with a separate PR and an ADR
(`docs/decisions/`) explaining the change.

When a baseline change is intentional:

```bash
npm run test:harness -- --update-snapshots --tier=1
git add backend/harness/__snapshots__/tier1/
git commit -m "harness: refresh tier1 baselines (see ADR-NNNN)"
```

---

## Failure modes

| Situation | Behavior |
| --------- | -------- |
| Tier 1 case fails assertions | PR **blocked** |
| Tier 1 diff vs. baseline (no `--update-snapshots`) | PR **blocked** |
| Tier 2 diff vs. baseline | PR **blocked** |
| Tier 3 Cosmos unreachable | Tier 3 marked `skipped: infrastructure-unavailable`; PR **not blocked**; next PR re-runs Tier 3 against both commits |
| Perf budget exceeded | PR **blocked** with budget overrun summary |

Skipped tiers are loud, never silent.

---

## Snapshot diff format

Snapshots are JSON, pretty-printed, sorted keys, with a stable subset of
fields (timestamps, request IDs, cache keys stripped). The diff tool
emits:

1. **Summary** — counts of changed cases, magnitude distribution, top 10
   largest price diffs.
2. **Full delta** — per-field JSON diff for everything else.

Triage a 1,000-case Tier 3 diff in two minutes by reading the summary
first; drill into the delta only for cases that exceed thresholds.
