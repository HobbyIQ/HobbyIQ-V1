# Backtest run — 2026-05-24T18-27-06-980Z

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T18:27:06.980Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.6378.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 28.07 | 29.41 |
| MAPE signal-off | 29.46 | 33.16 |
| **MAPE delta** (off - on) | **1.39** | **3.76** |
| Wilcoxon p-value | 0.683239 | 0.637767 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 28.57 | 42.86 | -14.29 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 15.891780757908505 | 11.219101911125644 | -4.67267884678286 |
| conf_40_59 | 13 | 30.447725697057766 | 34.85277122412349 | 4.40504552706572 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 11.46 | 23.14 | 55 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 10.2 | 14.29 | 50 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 49.495000000000005 | 9.1 | 31.33 | 11 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 53.85 | 105.13 | 10 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 12 | 4.17 | 16.67 | 1.5 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 48.57 | 22.86 | 90 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 28.08 | 16.1 | 35 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 192.49 | 9.09 | 2.86 | 11.98 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 12.96 | 9.64 | 5 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 15.89 | 11.22 | 5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
