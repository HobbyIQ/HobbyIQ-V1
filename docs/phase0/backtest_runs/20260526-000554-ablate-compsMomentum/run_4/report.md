# Backtest run — 2026-05-26T00-05-55-643Z-r4

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:05:55.643Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.9528.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 35.84 | 33.91 |
| MAPE signal-off | 31.51 | 33.47 |
| **MAPE delta** (off - on) | **-4.34** | **-0.44** |
| Wilcoxon p-value | 0.286003 | 0.952765 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 42.86 | -7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 20.564459604691365 | 18.69071538713144 |
| conf_40_59 | 13 | 36.36964277167313 | 34.46100392018087 | -1.908638851492256 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 1.87 | 20.56 | 20 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 8.11 | 13.51 | 10 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 8.29 | 11.68 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 2.53 | 1 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 13.31 | 0.85 | 44 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 44.475 | 34.91 | 12.42 | 10 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 11.99 | 29.27 | 4.25 | 3 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 4.09 | 4.09 | 0 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 6.16 | 6.16 | 0 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
