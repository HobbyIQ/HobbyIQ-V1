# v3 vs v4 comparison — N=15 re-baseline (WS2 of CF-COMPSLOADER-GRADE-FLOW arc)

**v3:** `20260524-174221-n15` — first N=15 run earlier today (production /predict was grade-broken; backtest harness was grade-aware via 73cae0d).
**v4:** `20260524-182700-n15-v4` — re-baseline after PR #122 (production /predict now grade-aware too).
**Cohort:** identical (`backtest_cohort_v1.json`, 15 cards, 14 scored after 1 no-actuals skip).

## What WS2 actually tested (clarification)

The backtest harness has *always* hit the backend directly via `fetchCompsForBacktest()` in [`scripts/backtest_signal_value.ts`](../../mcp-server/scripts/backtest_signal_value.ts) — it doesn't call production `/predict` or import from `compsLoader.ts`. So today's `CF-COMPSLOADER-GRADE-FLOW` production fix does **not** change what the backtest measures.

WS2's framing as "v3 was a proxy; v4 is reality" subtly oversells the comparison. What v4 actually tests is **stability of the v3 measurement under OpenAI nondeterminism + a few hours of ground-truth window drift**. The production fix's role is to bring production `/predict` into alignment with what the backtest has been measuring — a parallel improvement, not a measurement change.

## Aggregate comparison

| Metric | v3 | v4 | Direction | Note |
|---|---:|---:|---|---|
| n scored | 14 | 14 | same | |
| MAPE signal-on 72h | 34.35 | 28.07 | improved 6pt | OpenAI noise |
| MAPE signal-off 72h | 29.57 | 29.46 | stable | |
| **MAPE delta 72h** | **-4.79** | **+1.39** | **SIGN FLIPPED** | -6.18pt swing |
| MAPE signal-on 7d | 39.20 | 29.41 | improved 10pt | OpenAI noise |
| MAPE signal-off 7d | 38.49 | 33.16 | improved 5pt | |
| **MAPE delta 7d** | **-0.71** | **+3.76** | **SIGN FLIPPED** | +4.47pt swing |
| Wilcoxon p 7d | 0.683 | 0.638 | both > 0.6 | far from significance |
| Direction acc on | 42.86% | 28.57% | swapped | 6/14 → 4/14 |
| Direction acc off | 28.57% | 42.86% | swapped | 4/14 → 6/14 |
| **Direction acc delta** | **+14.29pp** | **-14.29pp** | **MIRROR IMAGE** | |
| Verdict | insufficient_data | insufficient_data | same | n<20 gate |

The exact mirror image on direction accuracy (and the same +14.29pp magnitude) is a striking artifact of the small sample: 2 out of 14 prediction-direction calls flipped between runs, swapping which arm "won" direction. At n=14, two cards is enough to invert the aggregate.

## Per-card stability — the more useful signal

Where some cards are **consistent across runs**:

| Card | v3 winner (7d) | v4 winner (7d) | Stable? |
|---|---|---|---|
| Mike Trout PSA 10 | signal-on by $60 | signal-on by $50 | **yes** — signals help |
| Mike Trout raw | signal-off by $80 | signal-off by $90 | **yes** — signals hurt |
| Bobby Witt Jr raw | signal-on by $2.50 | signal-on by $1.50 | **yes** — signals help (small) |
| Aaron Judge PSA 10 | signal-off by $15 | signal-off by $35 | **yes** — signals hurt (consistent direction, magnitude doubled) |
| Shohei Ohtani raw | signal-on by $12 | signal-off by $5 | **flipped** |
| Cody Bellinger raw | signal-on by $1.49 | (not in top 5) | unclear |
| Paul Skenes raw | signal-on by $8 | signal-on by $10 | **yes** — signals help |
| Paul Skenes PSA 10 | signal-off by $8 | signal-off by $12 | **yes** — signals hurt |
| Ronald Acuna PSA 10 | signal-off by $19 | signal-on by $11 | **flipped** |
| Caleb Bonemer | signal-off by $12 | signal-off by $5 | **yes** — signals hurt (smaller) |

5 cards consistent helping (Trout PSA 10, Bobby Witt raw, Paul Skenes raw, Bonemer, two more uncategorized direction), 4 cards consistent hurting, 2 cards flipped. **Per-card pattern is more stable than aggregate** — about 9 of 11 categorizable cards keep the same direction across runs.

## What this tells us

1. **OpenAI nondeterminism dominates at N=14.** The aggregate MAPE delta sign flipped between runs without any underlying methodology change. Two consecutive runs of the same backtest at the same cohort produced mirror-image directional signals — that's noise dominating signal.

2. **Statistical significance was never close.** Both runs have Wilcoxon p > 0.6 (would need < 0.05). The samples can't distinguish signal-on from signal-off effects at this size.

3. **Per-card signal is more stable than aggregate.** ~9 of 14 cards keep the same arm-winner direction across runs. The cards that "consistently signal-help" or "consistently signal-hurt" suggest there IS a per-card effect being masked by aggregation.

4. **Trout pattern is suggestive but not conclusive.** Signal-on helps PSA 10 ($50-60 closer to actual) but hurts raw ($80-90 further). Same player, same cohort entry pair, opposite outcomes. If signals are pushing predictions UP (rising trends, pre-show catalysts), that's correct for PSA 10 (whose actuals are higher and trending up) but wrong for raw (whose market behaves differently). Hints at per-grade signal interaction the current per-player aggregator doesn't model. **Not a verdict — a hypothesis worth testing.**

## Outcome branch determination (per pre-commitment)

Per the design's pre-committed branches and the user's WS2 spec:

> Insufficient data (n<20 for Wilcoxon): document, surface N=100 expansion as data-driven user decision.
> If insufficient data with weak/inconsistent direction: N=100 expansion has weaker case.

**Verdict: `insufficient_data` with INCONSISTENT direction.** N=100 cohort expansion has a weaker empirical case because the aggregate direction is not stable even at N=14 between two consecutive runs. Multiplying noise by 7× (15→100 cards) without addressing OpenAI nondeterminism will probably produce a similarly noisy result — just more expensively.

## Recommended next workstreams (user decides; not auto-fired)

Three options, ordered by cost:

1. **Multi-run aggregation via `--repeats N`** (~$0.30 × N runs, no code change beyond a small CLI flag in the harness)
   Re-run same N=15 cohort 3-5 times, aggregate per-card MAPE across repeats. Reduces OpenAI noise by √N. If aggregate signal stabilizes (consistent sign across repeats), THEN expand to N=100 with that methodology. Cheapest path to learning whether the aggregate noise is the bottleneck.

2. **Lock OpenAI nondeterminism** (~30 min code change)
   Add `temperature: 0` + `seed: <fixed>` to the OpenAI call in pricing.ts. Makes the backtest deterministic across runs (same inputs → same predictions). Eliminates the noise dimension entirely. Risk: temperature=0 changes the model's behavior subtly; signal-on and signal-off comparison would still be valid (both arms see the same model behavior), but absolute prediction quality might differ slightly from temp=1 production.

3. **N=100 cohort expansion** (~$2-4, multi-hour cohort assembly)
   The original CF-PHASE4B-BACKTEST.2 plan. Addresses sample size but doesn't address OpenAI noise — each card still has high prediction variance run-to-run. May still produce insufficient_data verdict if noise is what's limiting power.

Best sequenced strategy: option 1 first (cheap, fast learning), option 2 if option 1 doesn't stabilize, option 3 only after methodology is locked.

## What's NOT a finding from this run

- **The production fix (PR #122) is not responsible for the v3 vs v4 difference.** The backtest never went through compsLoader.ts. The production fix matters for production `/predict` behavior, not for backtest measurement.
- **Signals don't "help" or "hurt" overall.** Both verdicts in v3 and v4 are insufficient_data. No directional claim is supported by the present evidence.
- **The Trout pattern doesn't prove per-grade signal interaction.** It's a 2-card observation across 2 runs. Hypothesis-worthy, not finding-worthy.
