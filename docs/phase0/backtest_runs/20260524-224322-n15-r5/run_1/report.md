# Backtest run — 2026-05-24T22-43-32-616Z-r1

**Cohort:** v1-seed | **N=15, scored=13**
**As-of date:** 2026-05-24T22:43:32.616Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 1 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.8139.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 34.61 | 44.55 |
| MAPE signal-off | 38.97 | 46.04 |
| **MAPE delta** (off - on) | **4.36** | **1.5** |
| Wilcoxon p-value | 0.463071 | 0.813945 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 38.46 | 46.15 | -7.69 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 0 | — | — | — |
| conf_40_59 | 13 | 44.54687635827612 | 46.04263636508525 | 1.4957600068091281 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 6.12 | 38.78 | 400 |
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 14.29 | 21.43 | 25 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.870000000000001 | 21.08 | 80.38 | 5.26 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.96 | 68.58 | 144.93 | 2.26 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 22.93 | 0.33 | 34.01 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 28.08 | 21.23 | 20 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 49.495000000000005 | 56.38 | 41.43 | 7.4 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.785 | 194.77 | 121.08 | 5 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 105.13 | 79.49 | 5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
