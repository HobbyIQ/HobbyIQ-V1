# Backtest run — 2026-05-26T00-41-49-711Z-r2

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:41:49.711Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1386.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 45.07 | 48.28 |
| MAPE signal-off | 28.76 | 31.51 |
| **MAPE delta** (off - on) | **-16.31** | **-16.77** |
| Wilcoxon p-value | 0.007646 | 0.138641 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 28.57 | 28.57 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 50.41550826952169 | 32.35468149776826 | -18.060826771753426 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 8.28 | 10.4 | 10 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 27.09 | 40.47 | 0.4 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 112.77 | 37.67 | 30 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 16.22 | 8.11 | 15 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 28.6 | 21.83 | 10 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 84.36 | 16.2 | 6.1 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.58 | 203.95 | 127.96 | 5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
