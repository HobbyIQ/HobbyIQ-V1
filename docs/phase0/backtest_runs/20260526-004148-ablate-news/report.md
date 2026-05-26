# Multi-run backtest — 2026-05-26T00-41-49-711Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `stable_signals_hurt`

**Recommendation:** Stable result: signals consistently HURT accuracy across runs. Recommended next: CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — investigate which signals contribute negatively.

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -12.72 | -11.14 | 0.123485 | 0 | insufficient_data |
| 2 | 14 | -16.31 | -16.77 | 0.138641 | 0 | insufficient_data |
| 3 | 14 | -9.97 | -15.11 | 0.33288 | -7.14 | insufficient_data |
| 4 | 14 | -12.61 | -8.27 | 0.114128 | -7.14 | insufficient_data |
| 5 | 14 | -14.28 | -12.6 | 0.046853 | 0 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | -13.18 | 2.34 | 1 |
| MAPE delta 7d | -12.78 | 3.33 | 1 |
| Direction-acc delta | -2.86 | 3.91 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 1
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 8
- **Mixed/flipping** (signal-on wins 31-69% of runs): 5

### Cards where signals CONSISTENTLY help

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 1 | 10.49 | 19.58 |

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0 | 4.25 | 0.85 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0 | 4.09 | 4.09 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0 | 109.77 | 47.69 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0 | 203.95 | 164.44 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0 | 10.09 | 4.25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0 | 153.33 | 126.67 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0 | 15.67 | 8.11 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0 | 20.56 | 20.56 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 0.4 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 0.6 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 0.4 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 5 | 0.4 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 0.4 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
