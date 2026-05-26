# Backtest run — 2026-05-26T00-05-55-643Z-r5

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:05:55.643Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.9594.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 36.29 | 31.32 |
| MAPE signal-off | 30.11 | 24.19 |
| **MAPE delta** (off - on) | **-6.18** | **-7.13** |
| Wilcoxon p-value | 0.109511 | 0.959353 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 57.14 | 42.86 | 14.29 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 20.564459604691365 | 18.69071538713144 |
| conf_40_59 | 13 | 33.58017187569977 | 24.46932893763466 | -9.110842938065108 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 1.87 | 20.56 | 20 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 8.29 | 11.68 | 5 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 8.11 | 10.81 | 5 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 2.53 | 1 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 13.31 | 0.85 | 44 |
| Juan Soto|2018|Topps Update|US300|raw|base | 6.58 | 203.95 | 82.37 | 8 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 44.475 | 23.66 | 12.42 | 5 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.915 | 15.87 | 10.26 | 0.5 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 4.09 | 4.09 | 0 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
