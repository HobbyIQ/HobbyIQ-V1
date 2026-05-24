# Backtest run — 2026-05-24T17-42-28-426Z

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-24T17:42:28.426Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.6832.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 34.35 | 39.2 |
| MAPE signal-off | 29.57 | 38.49 |
| **MAPE delta** (off - on) | **-4.79** | **-0.71** |
| Wilcoxon p-value | 0.753153 | 0.683239 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 42.86 | 28.57 | 14.29 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 29.909817298257085 | 18.69538806597822 | -11.214429232278864 |
| conf_40_59 | 13 | 39.9168054980249 | 40.00978949875551 | 0.09298400073060975 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 10.2 | 15.16 | 60.66 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 150.495 | 4.99 | 12.96 | 12 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 19.5 | 74.36 | 115.38 | 8 |
| Bobby Witt Jr|2022|Topps Chrome Update|USC10|raw|base | 12 | 4.17 | 25 | 2.5 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.96 | 119.59 | 169.93 | 1.49 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 51.43 | 28.57 | 80 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 49.495000000000005 | 41.43 | 3.02 | 19.01 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 22.95 | 17.81 | 15 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 29.91 | 18.7 | 12 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 192.49 | 9.09 | 4.94 | 7.98 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
