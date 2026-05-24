# Backtest run — 2026-05-24T22-43-32-616Z-r2

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T22:43:32.616Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1330.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 38.45 | 45.37 |
| MAPE signal-off | 37.02 | 33.47 |
| **MAPE delta** (off - on) | **-1.43** | **-11.9** |
| Wilcoxon p-value | 0.861304 | 0.132957 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 64.29 | -28.57 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 15.891780757908505 | 17.76085229662165 | 1.8690715387131451 |
| conf_40_59 | 13 | 47.63269516432016 | 34.673443882676764 | -12.959251281643397 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 0 | 34.29 | 120 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 14.38 | 22.95 | 25 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 15.89 | 17.76 | 2 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.870000000000001 | 22.77 | 29.65 | 0.61 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 6.23 | 6.28 | 0.02 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 63.27 | 37.14 | 320 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 11.46 | 4.03 | 35 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 192.49 | 11.68 | 2.86 | 16.98 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 115.38 | 43.59 | 14 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.785 | 194.77 | 121.08 | 5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
