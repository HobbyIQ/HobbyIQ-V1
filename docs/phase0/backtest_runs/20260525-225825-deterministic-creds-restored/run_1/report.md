# Backtest run — 2026-05-25T22-58-58-989Z-r1

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-25T22:58:58.989Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.4328.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 27.83 | 36.49 |
| MAPE signal-off | 25.57 | 26.59 |
| **MAPE delta** (off - on) | **-2.25** | **-9.9** |
| Wilcoxon p-value | 0.959353 | 0.432767 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 28.57 | 28.57 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 1.873744217559923 | 0 |
| conf_40_59 | 13 | 39.15427800313777 | 28.488137892529792 | -10.666140110607977 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 12.59 | 20.93 | 100 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 6.16 | 10.4 | 20 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 44.475 | 46.15 | 57.39 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 5.03 | 12.53 | 3 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.915 | 4.66 | 12.17 | 0.67 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 13.31 | 0.85 | 44 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 30.07 | 19.58 | 30 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 25.22 | 8.29 | 25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.58 | 203.95 | 82.37 | 8 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
