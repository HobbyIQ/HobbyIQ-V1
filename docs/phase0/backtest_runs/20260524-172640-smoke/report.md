# Backtest run — 2026-05-24T17-26-48-098Z

**Cohort:** v1-seed | **N=5, scored=5**
**As-of date:** 2026-05-24T17:26:48.098Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 0 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=n/a.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 28.65 | 41.88 |
| MAPE signal-off | 20.97 | 37.81 |
| **MAPE delta** (off - on) | **-7.68** | **-4.07** |
| Wilcoxon p-value | — | — |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 20 | 20 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 0 | — | — | — |
| conf_40_59 | 5 | 41.88426739889606 | 37.812661176877235 | -4.071606222018822 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 39.99 | 6.28 | 25.03 | 7.5 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.96 | 119.59 | 136.15 | 0.49 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 350 | 40 | 14.29 | 90 |
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 28.57 | 8.57 | 70 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 14.98 | 5.03 | 3.98 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
