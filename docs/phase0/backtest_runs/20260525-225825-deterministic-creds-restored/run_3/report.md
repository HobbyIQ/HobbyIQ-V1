# Backtest run — 2026-05-25T22-58-58-989Z-r3

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-25T22:58:58.989Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.1823.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 34.04 | 37.23 |
| MAPE signal-off | 24.35 | 24.04 |
| **MAPE delta** (off - on) | **-9.68** | **-13.19** |
| Wilcoxon p-value | 0.116664 | 0.182315 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 14.29 | 28.57 | -14.29 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 1.873744217559923 | 1.873744217559923 | 0 |
| conf_40_59 | 13 | 39.94919555175841 | 25.746481606268397 | -14.20271394549001 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Shohei Ohtani|2018|Topps Update|US1|PSA 10|base | 471 | 6.16 | 10.4 | 20 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.915 | 4.66 | 12.17 | 0.67 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 33.78 | 50.5 | 0.5 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 12.59 | 4.09 | 102 |
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 13.31 | 0.85 | 44 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 26.57 | 19.58 | 20 |
| Paul Skenes|2024|Topps Chrome Update|USC53|raw|base | 18.27 | 91.57 | 36.84 | 10 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
