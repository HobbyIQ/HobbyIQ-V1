# Backtest run — 2026-05-26T12-21-15-603Z-r3

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T12:21:15.603Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.0208.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 33.86 | 44.92 |
| MAPE signal-off | 23.88 | 25.87 |
| **MAPE delta** (off - on) | **-9.99** | **-19.06** |
| Wilcoxon p-value | 0.04086 | 0.020795 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 35.71 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 17.370892018779344 | 3.286384976525822 | -14.084507042253522 |
| conf_40_59 | 13 | 47.04067866204541 | 27.602081641072523 | -19.438597020972885 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 3.85 | 19.58 | 45 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 11.969999999999999 | 42.02 | 50.38 | 1 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 16.77 | 6.16 | 50 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 29.73 | 8.11 | 40 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 37.475 | 126.82 | 60.11 | 25 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 106.5 | 17.37 | 3.29 | 15 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 95.53 | 16.2 | 7.1 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
