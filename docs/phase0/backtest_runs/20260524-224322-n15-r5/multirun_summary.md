# Multi-run backtest — 2026-05-24T22-43-32-616Z (--repeats=5)

**Cohort:** v1-seed | **N=15 × 5 runs**
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]

## Verdict — `unstable_high_variance`

**Recommendation:** Aggregate signs flip across runs → OpenAI nondeterminism dominates at this N. Recommended next: CF-BACKTEST-DETERMINISTIC (lock temperature=0 + seed) rather than CF-PHASE4B-BACKTEST.2 (N=100 expansion — would just multiply the noise).

## Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 13 | 4.36 | 1.5 | 0.813945 | -7.69 | insufficient_data |
| 2 | 14 | -1.43 | -11.9 | 0.132957 | -28.57 | insufficient_data |
| 3 | 14 | -1.95 | -1.77 | 0.239317 | 7.14 | insufficient_data |
| 4 | 14 | 27.98 | 39.67 | 0.182338 | 7.14 | insufficient_data |
| 5 | 14 | 1.49 | -2.67 | 0.916512 | 7.14 | insufficient_data |

## Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | 6.09 | 12.5 | 0.6 |
| MAPE delta 7d | 4.97 | 20.03 | 0.4 |
| Direction-acc delta | -2.97 | 15.69 | — |

Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.

## Per-card consistency (stable winners across runs)

- **Stable signal-helpers** (signal-on wins ≥70% of runs): 0
- **Stable signal-hurters** (signal-on wins ≤30% of runs): 6
- **Mixed/flipping** (signal-on wins 31-69% of runs): 8

### Cards where signals CONSISTENTLY hurt

| Card | runs scored | on win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 5 | 0.2 | 22.14 | 15.07 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 5 | 0.2 | 16.42 | 8.58 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 4 | 0.25 | 11.8 | 8.28 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 5 | 0.2 | 33.05 | 26.48 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 5 | 0.2 | 94.36 | 68.57 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 5 | 0.2 | 7.32 | 5.76 |

### Cards that FLIP across runs (noise candidates)

| Card | runs scored | on win-rate |
|---|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 5 | 0.6 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 5 | 0.4 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 5 | 0.6 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 5 | 0.4 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 5 | 0.6 |
| Juan Soto|2018|Topps Update|US300|raw|base | 5 | 0.6 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 5 | 0.4 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 5 | 0.6 |

## What this run does NOT prove

- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).
- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."
- If verdict is `unstable_high_variance`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.
