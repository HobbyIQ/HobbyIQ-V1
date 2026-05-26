# Backtest run — 2026-05-26T12-21-15-603Z-r1

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T12:21:15.603Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.0159.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 34.49 | 46.63 |
| MAPE signal-off | 23.88 | 27.54 |
| **MAPE delta** (off - on) | **-10.62** | **-19.08** |
| Wilcoxon p-value | 0.028056 | 0.015906 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 42.86 | 35.71 | 7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.187793427230048 | 3.286384976525822 | -16.901408450704224 |
| conf_40_59 | 13 | 48.65925277649172 | 29.40738957487764 | -19.25186320161408 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 0.85 | 15.01 | 50 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 3.85 | 19.58 | 45 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 16.77 | 6.16 | 50 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 29.73 | 8.11 | 40 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 106.5 | 20.19 | 3.29 | 18 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 37.475 | 166.84 | 126.82 | 15 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 101.12 | 16.2 | 7.6 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
