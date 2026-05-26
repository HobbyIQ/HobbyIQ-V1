# Backtest run — 2026-05-26T00-41-49-711Z-r5

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:41:49.711Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.0469.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 47.05 | 50.13 |
| MAPE signal-off | 32.76 | 37.53 |
| **MAPE delta** (off - on) | **-14.28** | **-12.6** |
| Wilcoxon p-value | 0.001474 | 0.046853 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 35.71 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 52.40012934421157 | 38.83600472853148 | -13.564124615680093 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 12.59 | 19.58 | 20 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 18.45 | 21.83 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 2.53 | 1 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 9.35 | 0.85 | 30 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 105.26 | 50.19 | 22 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 10.4 | 6.16 | 20 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 78.77 | 16.2 | 5.6 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
