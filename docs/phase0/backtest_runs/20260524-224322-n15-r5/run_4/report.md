# Backtest run — 2026-05-24T22-43-32-616Z-r4

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T22:43:32.616Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1823.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 26.54 | 30.82 |
| MAPE signal-off | 54.52 | 70.49 |
| **MAPE delta** (off - on) | **27.98** | **39.67** |
| Wilcoxon p-value | 0.109421 | 0.182338 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 28.57 | 7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 2.798934629222938 | 29.909817298257085 | 27.110882669034147 |
| conf_40_59 | 13 | 32.976479692411345 | 73.61493002884384 | 40.6384503364325 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 22.45 | 42.86 | 250 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.785 | 47.38 | 489.54 | 30 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 2.8 | 29.91 | 29.01 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 1.23 | 25.03 | 9.52 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 66.67 | 84.62 | 3.5 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 14.65 | 6.16 | 40 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 14.38 | 7.53 | 20 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 49.495000000000005 | 39.15 | 17.18 | 10.87 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 9.64 | 6.32 | 5 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.870000000000001 | 37.99 | 12.74 | 2.24 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
