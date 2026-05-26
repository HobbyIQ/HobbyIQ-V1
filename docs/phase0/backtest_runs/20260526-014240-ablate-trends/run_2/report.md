# Backtest run — 2026-05-26T01-42-42-431Z-r2

**Cohort:** v1-seed | **N=15, scored=14**
**As-of date:** 2026-05-26T01:42:42.431Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 1 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=0.8590.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 30.9 | 35.67 |
| MAPE signal-off | 27.43 | 36.44 |
| **MAPE delta** (off - on) | **-3.46** | **0.77** |
| Wilcoxon p-value | 0.284503 | 0.858955 |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 35.71 | 35.71 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 1 | 6.546423064342783 | 20.564459604691365 | 14.018036540348582 |
| conf_40_59 | 13 | 37.91496494926733 | 37.6642914473166 | -0.2506735019507289 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 286 | 9.09 | 19.58 | 30 |
| Caleb Bonemer|2024|Bowman Draft Chrome|CPA-CBO|raw|Chrome Prospect Autograph | 107.005 | 6.55 | 20.56 | 15 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 0.03 | 5.03 | 2 |
| Ronald Acuna Jr|2018|Topps Update|US250|raw|base | 8.95 | 16.2 | 32.96 | 1.5 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.99 | 37.12 | 40.47 | 0.1 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 353 | 15.01 | 0.85 | 50 |
| Shohei Ohtani|2018|Topps Update|US1|raw|base | 147.745 | 18.45 | 11.68 | 10 |
| Paul Skenes|2024|Topps Chrome Update|USC53|PSA 10|base | 185 | 13.51 | 8.11 | 10 |
| Ronald Acuna Jr|2018|Topps Update|US250|PSA 10|base | 39.95 | 50.19 | 37.67 | 5 |
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1199 | 4.09 | 4.09 | 0 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
