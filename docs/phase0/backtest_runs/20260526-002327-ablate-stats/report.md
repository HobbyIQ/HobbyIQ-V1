# Multi-run backtest — 2026-05-26T00-23-28-902Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `stable_signals_hurt`

**Recommendation:** Stable result: signals consistently HURT accuracy across runs. Recommended next: CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — investigate which signals contribute negatively.

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -3.81 | -5.88 | 0.444587 | -14.29 | insufficient_data |
| 2 | 14 | -7.01 | -11.03 | 0.182315 | -21.43 | insufficient_data |
| 3 | 14 | -8.36 | -15.3 | 0.388186 | -7.14 | insufficient_data |
| 4 | 14 | -3.74 | -4.96 | 0.260393 | -14.29 | insufficient_data |
| 5 | 14 | -10.31 | -10.41 | 0.139414 | -7.14 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | -6.65 | 2.87 | 1 |
| MAPE delta 7d | -9.52 | 4.2 | 1 |
| Direction-acc delta | -12.86 | 5.98 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 4
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 9
- **Mixed/flipping** (signal-on wins 31-69% of runs): 1

### Cards where signals CONSISTENTLY help

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 1 | 0.03 | 2.53 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 1 | 12.94 | 19.58 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 0.8 | 33.78 | 39.13 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 1 | 3.92 | 19.24 |

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0 | 15.01 | 0.85 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0.2 | 4.09 | 7.46 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 0 | 28.6 | 15.74 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0 | 73.13 | 21.42 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0 | 203.95 | 173.56 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0.2 | 3.42 | 4.25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0 | 162.66 | 112.63 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0 | 12.43 | 8.11 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0 | 20.56 | 16.82 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 5 | 0.4 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
