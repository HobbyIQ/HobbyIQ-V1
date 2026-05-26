# Backtest run — 2026-05-26T00-41-49-711Z-r1

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T00:41:49.711Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1235.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 45.49 | 48.67 |
| MAPE signal-off | 32.76 | 37.53 |
| **MAPE delta** (off - on) | **-12.72** | **-11.14** |
| Wilcoxon p-value | 0.003346 | 0.123485 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 28.57 | 28.57 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 20.564459604691365 | 20.564459604691365 | 0 |
| conf_40_59 | 13 | 50.83130868532211 | 38.83600472853148 | -11.995303956790629 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 27.09 | 40.47 | 0.4 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 112.77 | 50.19 | 25 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 21.62 | 8.11 | 25 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 28.6 | 21.83 | 10 |
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 8.28 | 6.16 | 10 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 84.36 | 16.2 | 6.1 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
