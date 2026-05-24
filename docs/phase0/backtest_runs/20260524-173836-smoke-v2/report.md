# Backtest run — 2026-05-24T17-38-44-017Z

**Cohort:** v1-seed | **N=5, scored=5**
**As-of date:** 2026-05-24T17:38:44.017Z
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Skipped:** 0 no-actuals, 0 prediction-failed

## Verdict — `insufficient_data`

> Insufficient data — n=? scored, p=n/a.

**Next workstream:** Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.

## Aggregate

| Metric | 72h | 7d |
|---|---:|---:|
| MAPE signal-on | 26 | 39.12 |
| MAPE signal-off | 32.64 | 44.38 |
| **MAPE delta** (off - on) | **6.65** | **5.26** |
| Wilcoxon p-value | — | — |

| Direction accuracy | signal-on | signal-off | delta (on - off) |
|---|---:|---:|---:|
| 7d direction acc % | 40 | 40 | 0 |

## By confidence band (7d)

| Band | n | MAPE on | MAPE off | delta |
|---|---:|---:|---:|---:|
| conf_80_plus | 0 | — | — | — |
| conf_60_79 | 0 | — | — | — |
| conf_40_59 | 5 | 39.12071266922801 | 44.382327776847426 | 5.261615107619413 |
| conf_under_40 | 0 | — | — | — |

## Top 5 cards where signals helped most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|raw|base | 350 | 14.29 | 25.71 | 40 |
| Aaron Judge|2017|Topps Update|US87|PSA 10|base | 292 | 2.74 | 7.53 | 14 |
| Cody Bellinger|2017|Topps Update|US159|raw|base | 2.96 | 136.15 | 170.27 | 1.01 |

## Top 5 cards where signals hurt most (7d)

| Card | actual | on err% | off err% | delta abs |
|---|---:|---:|---:|---:|
| Mike Trout|2011|Topps Update|US175|PSA 10|base | 1224.995 | 22.45 | 18.37 | 50 |
| Aaron Judge|2017|Topps Update|US87|raw|base | 39.99 | 19.98 | 0.03 | 7.98 |

## What this measurement does NOT prove

- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).
- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).
- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with `--repeats` to reduce noise.
- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.
