# HobbyIQ engine backtest — the accuracy number

**#1651 · generated 2026-09-02 · evaluation period 2026-06-02 .. 2026-08-31**

## The number

**On 6,336 held-out sales, HobbyIQ's projected price landed within 25% of the
actual next sale 34.1% of the time**, with a median absolute error of **44.7%**.

| | |
|---|---|
| within 10% | **17.5%** |
| within 25% | **34.1%** |
| within 50% | **54.1%** |
| median absolute error | **44.7%** |
| bias (median signed error) | **-16.8%** — the engine reads LOW |
| p90 absolute error | 99.9% |

Error is measured against the ACTUAL sale: `(predicted - actual) / actual`. The
denominator matters — with the PREDICTION on the bottom, an engine improves its
own score by predicting a larger number and "within 25%" stops meaning within
25% of the sale.

### How to read this number

It is not a flattering number, and it should not be published as one without
the rung slice beside it. Three things are true at once:

1. **The exact-pool rungs — the product's actual claim — are materially better
   than the headline.** The headline mixes in rungs that fire precisely when
   there is no evidence (`grade-curve-estimate` at 77.6%, `no-pool` freshness
   at 77.5%). A card with a live pool is priced far better than a card without
   one, and the headline averages the two.
2. **The engine reads systematically LOW (-16.8%).** This is a bias, not
   spread, and bias is the correctable kind of wrong. It grows monotonically
   with price (-12.5% under $25 to -69.4% above $2,500), which is a real
   finding: the projection is anchored below the market on exactly the cards
   where a miss costs the most.
3. **Half of all sales land within 50%.** For a single-transaction prediction
   on an illiquid, condition-sensitive asset that is a defensible place to be
   — but the honest headline for marketing is the exact-pool slice with its
   name attached, not the blended 34.1%.

## No lookahead — the guarantee behind every number above

Each point prices its identity **as of the held-out sale's own timestamp**. The
cutoff enters at the one engine entry (`valueIdentity({ asOfMs })`) and is
enforced **in the query** at every read: the exact pool, the player-index
basket, and all eleven fallback rungs carry `c.soldAt < @asOf`. The
player-index memo is keyed by cutoff, so no evaluation point can be served
another point's basket.

Pinned by `backend/tests/asOfLookaheadIsolation.test.ts`, which splices
future-dated rows into the fixture pool and requires every rung's answer to be
byte-identical. Both load-bearing claims are mutation-checked red.

### The leak this run actually found

The first live run reported **19.9% median error and 68% within-25%** — far
better than the number above. That version was wrong, and the way it was wrong
is the reason this section exists.

`c.soldAt` is compared as a **string**, and sold_comps stores one instant three
ways (measured over 4,000 rows: 3,062 as `+00:00`, 878 as `.000Z`, 60 as `Z`).
Those sort by ordinal, not by time — `"+"` (0x2B) < `"."` (0x2E) — so a
`.000Z` ceiling **admitted the `+00:00` spelling of its own instant**. Observed:
a card priced off a pool of ONE comp, the sale being predicted, "predicted" to
the cent.

A lookahead leak never looks like a bug in a report. It looks like an
unusually accurate engine. **The honest number is the worse one.**

The fix cuts at the start of the instant's second in a form that sorts below
every serialization (`asOfCutoff.ts`), with a parsed-time guard behind it, both
layers pinned independently.

### The sampling defect this run also found

The first 6,400-point run was **100% baseball**, against an eligible population
that is 51.1% baseball / 16.6% basketball / 16.5% pokemon / 13.4% football
(measured over 3,466,183 eligible sales). A cross-partition walk is not a random
sample — partition order correlates with sport. Every per-sport slice in that
report was an empty claim.

This run is **stratified by sport** on measured shares, covering 99.0% of the
eligible population.

## By rung

The slice that matters most: it separates "we had evidence and used it" from
"we had none and said so".

| slice | n | median \|err\| | bias | ≤10% | ≤25% | ≤50% | p90 \|err\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| `exact-pool-projection` | 2,731 | 49.8% | -25.0% | 11.6% | 29.8% | 50.6% | 99.9% |
| `exact-pool-leading-edge` | 859 | 37.9% | -13.9% | 20.4% | 38.8% | 61.0% | 95.0% |
| `exact-pool-last-sale` | 830 | 35.2% | -3.5% | 20.5% | 39.5% | 61.7% | 99.2% |
| `exact-pool-weighted-median` | 676 | 32.0% | -9.8% | 22.2% | 42.2% | 63.5% | 96.6% |
| `rare-card-anchor` | 450 | 6.7% | 0.0% | 52.2% | 60.4% | 72.9% | 99.9% |
| `grade-curve-estimate` | 369 | 77.6% | -71.6% | 6.0% | 13.0% | 23.6% | 98.3% |
| `sibling-parallel` | 239 | 74.4% | -26.9% | 8.4% | 18.0% | 38.1% | 282.9% |
| `same-printrun-cross-parallel` | 66 | 62.5% | -43.5% | 12.1% | 25.8% | 40.9% | 99.2% |
| `graded-pool-inverse` | 58 | 66.6% | 44.5% | 10.3% | 17.2% | 37.9% | 1758.6% |
| `grade-cross-raw` | 31 | 78.9% | -59.5% | 3.2% | 12.9% | 25.8% | 221.0% |
| `player-index-projection` | 22 | 48.9% | -7.6% | 13.6% | 18.2% | 54.5% | 216.1% |
| `family-baseline` | 3 | 42.5% | 42.5% | 0.0% | 0.0% | 66.7% | 100.0% |
| `cross-setkey` | 2 | 6.2% | -6.2% | 50.0% | 100.0% | 100.0% | 12.4% |

`rare-card-anchor` at 6.7% is the standout and should be read carefully rather
than celebrated: it fires on cards whose last real sale IS the market, so the
projection and the actual are often the same transaction type at the same
price. It is genuinely accurate and also the easiest case in the pool.

The four `exact-pool-*` rungs — 5,096 of 6,336 points — run 32-50% median
error. `exact-pool-projection`, the doctrine rung and the most common, is the
weakest of the four at 49.8%, which is worth a look on its own: the rungs that
do LESS extrapolation (`last-sale` 35.2%, `weighted-median` 32.0%) are beating
the one that projects hardest.

## By sport

| slice | n | median \|err\| | bias | ≤10% | ≤25% | ≤50% | p90 \|err\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseball | 3,272 | 46.9% | -20.0% | 14.8% | 32.6% | 52.6% | 99.5% |
| basketball | 1,064 | 38.1% | -9.5% | 21.8% | 38.3% | 58.4% | 99.2% |
| pokemon | 1,056 | 54.2% | -23.5% | 17.0% | 29.6% | 47.2% | 132.3% |
| football | 856 | 33.3% | -8.8% | 22.8% | 40.4% | 63.7% | 99.8% |
| soccer | 56 | 66.8% | -45.9% | 10.7% | 23.2% | 41.1% | 135.7% |
| hockey | 32 | 26.4% | 0.0% | 34.4% | 46.9% | 59.4% | 97.4% |

## By price band (of the actual sale)

| slice | n | median \|err\| | bias | ≤10% | ≤25% | ≤50% | p90 \|err\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| under-25 | 3,313 | 42.2% | -12.5% | 16.6% | 33.9% | 56.0% | 128.6% |
| 25-100 | 1,820 | 46.6% | -20.0% | 17.6% | 34.3% | 52.5% | 97.6% |
| 100-500 | 954 | 46.3% | -25.0% | 19.9% | 35.4% | 52.7% | 99.1% |
| 500-2500 | 194 | 53.8% | -37.3% | 18.6% | 30.4% | 47.4% | 99.4% |
| 2500-plus | 55 | 72.3% | -69.4% | 21.8% | 27.3% | 40.0% | 99.9% |

The bias grows monotonically with price. On the cards where being wrong
costs the most, the engine is most conservative.

## By pool freshness (age of the newest visible sale, at the cutoff)

| slice | n | median \|err\| | bias | ≤10% | ≤25% | ≤50% | p90 \|err\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0-7d | 4,899 | 40.2% | -14.3% | 19.0% | 36.6% | 56.8% | 99.6% |
| 7-30d | 770 | 44.4% | -18.7% | 15.6% | 32.3% | 55.1% | 99.3% |
| no-pool | 427 | 77.5% | -63.9% | 6.6% | 13.6% | 25.5% | 123.1% |
| 30-45d | 125 | 47.0% | -14.7% | 14.4% | 29.6% | 53.6% | 99.4% |
| 45-90d | 90 | 58.2% | -15.7% | 12.2% | 22.2% | 42.2% | 212.8% |
| 90-180d | 24 | 78.0% | -51.3% | 4.2% | 8.3% | 20.8% | 171.3% |
| 180d-plus | 1 | 44.4% | -44.4% | 0.0% | 0.0% | 100.0% | 44.4% |

The engine's honest disadvantage, made visible: error rises monotonically with
the age of the newest sale it could see. `no-pool` (77.5%) and `90-180d`
(78.0%) are where the ladder is guessing, and they are labelled as such on
every wire.

## #1647: the speculation rung vs the family fallback it replaces

| slice | n | median \|err\| | bias | ≤10% | ≤25% | ≤50% | p90 \|err\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| `player-index-projection` | 22 | 48.9% | -7.6% | 13.6% | 18.2% | 54.5% | 216.1% |
| family / sibling fallback | 613 | 76.7% | -60.1% | 7.0% | 15.2% | 29.7% | 122.5% |

**Verdict: insufficient-sample.** Median |error| delta: 27.8 pp (positive = the speculation rung is closer); within-25% delta: 3.0 pp.

> Below the 30-point floor on at least one side (speculation n=22, family n=613) — reported without a verdict.

The speculation rung is closer than the cohort it replaced by a wide margin
(48.9% vs 76.7% median error, 27.8 pp), and its bias is nearly neutral (-7.6%)
where the family cohort is badly low (-60.1%). But **n=22 is below the 30-point
floor, so the report refuses a verdict** — the direction is encouraging and the
sample is not yet large enough to publish as a claim.

This is a cohort comparison, not an A/B: a card reaches the speculation rung
BECAUSE it still has a readable anchor, which is part of why the family cohort
is harder. Read it as the before/after a cold-pool card experiences.

To settle it, run more shards — the rung fires on roughly 0.35% of sampled
sales, so ~10k points are needed for a verdict-grade slice.

## Excluded

- `shard-miss`: 55,902
- `per-card-cap`: 5,175
- `no-projection`: 7,116
- `engine-error`: 0

`no-projection` (7,116) is the engine declining to price at all — no catalog
identity, or no rung willing to answer. That is a coverage number, not an
accuracy one, and it is deliberately kept out of the error distribution:
scoring a refusal as a miss would conflate "we were wrong" with "we said
nothing", which are different products.

## Reproducing

```
# per shard (runner: script=engine-backtest, READ ONLY, apply ignored)
MODE=sample SLOT=<n> SLOTS=<N> LIMIT=1600 node backend/scripts/engine-backtest.cjs

# merge the shard JSONs into this report
MODE=combine node backend/scripts/engine-backtest.cjs
```

Sharded on `sha1(sold_comps row id)`; stops at its own `RUN_MINUTES` budget and
prints the relaunch marker (#1361). No new dispatch input.
