# Multi-run backtest — 2026-05-25T22-58-58-989Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `stable_signals_hurt`

**Recommendation:** Stable result: signals consistently HURT accuracy across runs. Recommended next: CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — investigate which signals contribute negatively.

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -2.25 | -9.9 | 0.432767 | 0 | insufficient_data |
| 2 | 14 | -2.06 | -8.27 | 0.582919 | -7.14 | insufficient_data |
| 3 | 14 | -9.68 | -13.19 | 0.182315 | -14.29 | insufficient_data |
| 4 | 14 | -1.45 | -3.46 | 0.286003 | -21.43 | insufficient_data |
| 5 | 14 | -3.26 | -12.04 | 0.157939 | -14.29 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | -3.74 | 3.38 | 1 |
| MAPE delta 7d | -9.37 | 3.81 | 1 |
| Direction-acc delta | -11.43 | 8.15 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 4
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 9
- **Mixed/flipping** (signal-on wins 31-69% of runs): 1

### Cards where signals CONSISTENTLY help

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 0.8 | 5.03 | 11.02 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 1 | 33.78 | 50.5 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 5 | 1 | 6.16 | 10.4 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 1 | 4.66 | 12.53 |

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0 | 13.31 | 0.85 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 0 | 29.37 | 19.58 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 0 | 22.51 | 8.29 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0.2 | 46.15 | 46.15 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0 | 203.95 | 106.69 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0 | 50.38 | 50.38 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0.2 | 69.67 | 47.79 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0 | 13.51 | 8.11 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0 | 9.35 | 1.87 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0.6 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
