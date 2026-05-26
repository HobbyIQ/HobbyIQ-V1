# Backtest run — 2026-05-26T00-41-49-711Z-r3

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:41:49.711Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.3329.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 42.88 | 44.26 |
| MAPE signal-off | 32.91 | 29.15 |
| **MAPE delta** (off - on) | **-9.97** | **-15.11** |
| Wilcoxon p-value | 0.028056 | 0.33288 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 28.57 | 35.71 | -7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 46.08435567142102 | 29.81029221996221 | -16.27406345145881 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 8.28 | 10.4 | 10 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 18.45 | 21.83 | 5 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 5.03 | 16.2 | 1 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 33.78 | 40.47 | 0.2 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 112.77 | 50.19 | 25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.58 | 203.95 | 82.37 | 8 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 15 | 153.33 | 126.67 | 4 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 11.99 | 33.44 | 4.25 | 3.5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
