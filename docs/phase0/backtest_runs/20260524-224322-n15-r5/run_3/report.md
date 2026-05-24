# Backtest run — 2026-05-24T22-43-32-616Z-r3

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T22:43:32.616Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.2393.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 36.47 | 37.54 |
| MAPE signal-off | 34.52 | 35.78 |
| **MAPE delta** (off - on) | **-1.95** | **-1.77** |
| Wilcoxon p-value | 0.683239 | 0.239317 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 28.57 | 7.14 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 0 | — | — | — |
| conf_40_59 | 14 | 37.54197925502672 | 35.77668539774816 | -1.7652938572785573 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 192.49 | 2.86 | 9.09 | 11.98 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.785 | 135.81 | 223.66 | 5.96 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 12.48 | 4.98 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 49.495000000000005 | 37.39 | 41.43 | 2 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 20.73 | 10.2 | 128.89 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 28.08 | 14.38 | 40 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 13.15 | 6.16 | 32.92 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 18.94 | 4.99 | 21 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 20.56 | 15.89 | 5 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
