# Backtest run — 2026-05-26T00-05-55-643Z-r2

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:05:55.643Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.7794.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 35.84 | 33.91 |
| MAPE signal-off | 31.46 | 32.23 |
| **MAPE delta** (off - on) | **-4.38** | **-1.68** |
| Wilcoxon p-value | 0.284503 | 0.779435 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 50 | 50 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 1.873744217559923 | 0 |
| conf_40_59 | 13 | 36.36964277167313 | 34.564196554945894 | -1.8054462167272334 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 6.16 | 10.4 | 20 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 8.29 | 11.68 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 5.03 | 2 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 27.09 | 40.47 | 0.4 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 13.31 | 0.85 | 44 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 44.475 | 34.91 | 12.42 | 10 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 11.99 | 29.27 | 4.25 | 3 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 4.09 | 4.09 | 0 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.915 | 15.87 | 15.87 | 0 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
