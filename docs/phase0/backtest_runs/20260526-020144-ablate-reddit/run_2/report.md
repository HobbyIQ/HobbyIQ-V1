# Backtest run — 2026-05-26T02-01-45-708Z-r2

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T02:01:45.708Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.2367.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 31.08 | 36.85 |
| MAPE signal-off | 27.03 | 33.73 |
| **MAPE delta** (off - on) | **-4.05** | **-3.12** |
| Wilcoxon p-value | 0.241121 | 0.236724 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 42.86 | -7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 38.10322602552957 | 34.741891521038085 | -3.361334504491488 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 12.59 | 19.58 | 20 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 5.03 | 2 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 10.4 | 6.16 | 20 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 18.45 | 11.68 | 10 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 50.19 | 37.67 | 5 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 67.22 | 40.47 | 0.8 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
