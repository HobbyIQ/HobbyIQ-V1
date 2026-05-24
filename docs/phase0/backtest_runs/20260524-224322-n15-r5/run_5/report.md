# Backtest run — 2026-05-24T22-43-32-616Z-r5

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T22:43:32.616Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.9165.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 22.88 | 37.06 |
| MAPE signal-off | 24.37 | 34.4 |
| **MAPE delta** (off - on) | **1.49** | **-2.67** |
| Wilcoxon p-value | 0.729891 | 0.916512 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 28.57 | 7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 15.891780757908505 | 14.018036540348582 |
| conf_40_59 | 13 | 39.77158004380247 | 35.82303152885941 | -3.948548514943063 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 14.29 | 40 | 90 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 10.4 | 16.77 | 30 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 1.87 | 15.89 | 15 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 9.64 | 12.96 | 5 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.785 | 54.75 | 121.08 | 4.5 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 62.88 | 14.29 | 595.24 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 25.8 | 9.25 | 48.33 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 105.13 | 79.49 | 5 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 192.49 | 11.68 | 9.09 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 12.53 | 4.98 | 3.02 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
