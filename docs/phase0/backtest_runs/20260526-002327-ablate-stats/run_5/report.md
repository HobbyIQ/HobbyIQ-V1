# Backtest run — 2026-05-26T00-23-28-902Z-r5

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:23:28.902Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1394.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 39.85 | 43.08 |
| MAPE signal-off | 29.54 | 32.67 |
| **MAPE delta** (off - on) | **-10.31** | **-10.41** |
| Wilcoxon p-value | 0.015022 | 0.139414 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 21.43 | 28.57 | -7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 44.809928184469335 | 33.59834421747834 | -11.211583966990993 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 12.59 | 19.58 | 20 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 8.28 | 10.4 | 10 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 2.53 | 1 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.915 | 4.66 | 10.26 | 0.5 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 15.01 | 0.85 | 50 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 44.475 | 91.12 | 34.91 | 25 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 28.6 | 21.83 | 10 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 15.99 | 162.66 | 112.63 | 8 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
