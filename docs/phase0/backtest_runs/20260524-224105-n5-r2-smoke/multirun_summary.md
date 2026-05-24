# Multi-run backtest — 2026-05-24T22-41-14-308Z (--repeats=2)

**Cohort:** v1-seed | **N=5 × 2 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `insufficient_data`

**Recommendation:** Too few scored pairs even with repeats. Investigate cardsight comp coverage in ground-truth window before expanding cohort.

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 5 | -10.4 | -21.91 | — | 0 | insufficient_data |
| 2 | 5 | 11.61 | 4.78 | — | 0 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | 0.6 | 15.56 | 0.5 |
| MAPE delta 7d | -8.56 | 18.87 | 0.5 |
| Direction-acc delta | 0 | 0 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 0
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 2
- **Mixed/flipping** (signal-on wins 31-69% of runs): 3

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 2 | 0 | 14.29 | 1.43 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 2 | 0 | 26.37 | 21.23 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 2 | 0.5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 2 | 0.5 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2 | 0.5 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
