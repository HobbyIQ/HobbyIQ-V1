# Backtest run — 2026-05-24T22-41-14-308Z-r2

**Cohort:** v1-seed | **N=5, scored=5**
**As-of date:** 2026-05-24T22:41:14.308Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 0 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=n/a.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 16.17 | 23.73 |
| MAPE signal-off | 27.78 | 28.52 |
| **MAPE delta** (off - on) | **11.61** | **4.78** |
| Wilcoxon p-value | — | — |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 20 | 20 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 0 | — | — | — |
| conf_40_59 | 5 | 23.734693662344906 | 28.515260579211667 | 4.780566916866761 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 5.03 | 37.48 | 12.98 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.96 | 68.58 | 85.81 | 0.51 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 6.12 | 2.04 | 50.01 |
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 14.29 | 2.86 | 40 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 24.66 | 14.38 | 30 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
