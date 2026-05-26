# Multi-run backtest — 2026-05-26T12-21-15-603Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `stable_signals_hurt`

**Recommendation:** Stable result: signals consistently HURT accuracy across runs. Recommended next: CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — investigate which signals contribute negatively.

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -10.62 | -19.08 | 0.015906 | 7.14 | insufficient_data |
| 2 | 14 | -13.79 | -20.62 | 0.012792 | 14.29 | insufficient_data |
| 3 | 14 | -9.99 | -19.06 | 0.020795 | 0 | insufficient_data |
| 4 | 14 | -17.08 | -21.77 | 0.026231 | 7.14 | insufficient_data |
| 5 | 14 | -17.08 | -26.29 | 0.015022 | 14.29 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | -13.71 | 3.4 | 1 |
| MAPE delta 7d | -21.36 | 2.98 | 1 |
| Direction-acc delta | 8.57 | 5.98 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 1
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 12
- **Mixed/flipping** (signal-on wins 31-69% of runs): 1

### Cards where signals CONSISTENTLY help

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 1 | 3.85 | 19.58 |

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0.2 | 12.18 | 15.01 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0 | 28.95 | 28.95 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 0 | 11.03 | 1.03 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 0 | 72.57 | 36.46 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 0 | 11.34 | 10.67 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 5 | 0 | 16.77 | 6.16 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 0 | 97.77 | 15.08 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0 | 145.5 | 92.13 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0 | 40.01 | 18.12 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0 | 148.91 | 87.62 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0 | 29.73 | 8.11 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0 | 18.5 | 3.29 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0.6 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
