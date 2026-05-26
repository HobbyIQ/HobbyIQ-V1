# Multi-run backtest — 2026-05-26T00-05-55-643Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `unstable_high_variance`

**Recommendation:** Aggregate signs flip across runs → OpenAI nondeterminism dominates at this N. Recommended next: CF-BACKTEST-DETERMINISTIC (lock temperature=0 + seed) rather than CF-PHASE4B-BACKTEST.2 (N=100 expansion — would just multiply the noise).

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -5.39 | 2.59 | 0.213223 | 0 | insufficient_data |
| 2 | 14 | -4.38 | -1.68 | 0.779435 | 0 | insufficient_data |
| 3 | 14 | -4.91 | 0.28 | 0.789675 | 28.57 | insufficient_data |
| 4 | 14 | -4.34 | -0.44 | 0.952765 | -7.14 | insufficient_data |
| 5 | 14 | -6.18 | -7.13 | 0.959353 | 14.29 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | -5.04 | 0.77 | 1 |
| MAPE delta 7d | -1.28 | 3.62 | 0.6 |
| Direction-acc delta | 7.14 | 14.29 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 6
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 7
- **Mixed/flipping** (signal-on wins 31-69% of runs): 1

### Cards where signals CONSISTENTLY help

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 1 | 0.03 | 3.53 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 1 | 9.09 | 19.58 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 1 | 27.09 | 40.47 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 1 | 8.29 | 13.71 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0.8 | 8.11 | 11.89 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0.8 | 1.87 | 16.82 |

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0 | 13.31 | 0.85 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0 | 4.96 | 4.09 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 0.2 | 14.75 | 14.01 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0.2 | 34.91 | 21.41 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0 | 203.95 | 179.63 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0 | 24.27 | 4.25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0 | 112.63 | 112.63 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 5 | 0.6 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
