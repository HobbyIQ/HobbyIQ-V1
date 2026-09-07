# TCA flow check — 2026-09-07

One week before go-live (~2026-09-14). End-to-end measurement of the
`tca-ebay` sales ingest: schedule and runs, landing volume, identity
quality, the freshness canary, and the write-path guard.

Read-only against prod. No writes, no config changes, no runner dispatches.

## Verdict by stage

| Stage | Verdict | One line |
|---|---|---|
| 1. Schedule + runs | **RED** | 8 consecutive reds since 2026-09-06T00:59Z (15 of 29 runs red over 7d); match-enricher skipped 8 times |
| 2. Landing volume | **GREEN** | 20.7k–27.6k rows/day since 09-03, steady; parks 32/24h (0.13%) — the guard is not over-refusing |
| 3. Identity quality | **GREEN** | Every axis improved vs the 08-31 baseline; catalog-backed 30.7% → 42% |
| 4. Freshness canary | **AMBER** | Green, but at 26,752 vs a 25,000 floor — 7% of headroom, and it cannot see the cron is dead |
| 5. Write-path bypass | **GREEN** | 0 bypass writers; `guardSoldCompDoc` is applied at both doors |

**Overall: AMBER.** No data loss and no bad rows — the pool is being fed by
the webhook and identity quality is the best it has been. But the scheduled
firehose has been red for two days, the match-enricher has not run in that
window, and the canary cannot tell the difference.

## 1. Schedule and runs

`.github/workflows/tca-firehose-ingest.yml` — crons at 00:05 / 06:05 / 12:05 /
18:05 UTC (40 min budget on the reset-window run, 12 on the platform-lag
passes). It is the only TCA workflow; `match-enricher` is its second job
(`needs: ingest`), and there is no separate normalize/watcher workflow.

| Run (UTC) | Firehose | Enricher | fetched | written | skipped | unaccounted |
|---|---|---|---|---|---|---|
| 09-07 18:24 | failure | skipped | 0 | 0 | — | `COSMOS_CONNECTION_STRING required` |
| 09-07 12:32 | failure | skipped | — | — | — | reconciliation |
| 09-07 06:44 | failure | skipped | — | — | — | reconciliation |
| 09-07 00:58 | failure | skipped | 19,109 | 9,177 | 9,719 | 213 (1.11%) |
| 09-06 18:21 | failure | skipped | — | — | — | reconciliation |
| 09-06 12:26 | failure | skipped | 36,230 | 4,177 | 31,671 | reconciliation |
| 09-06 06:31 | failure | skipped | 36,230 | 7,319 | 28,541 | reconciliation |
| 09-06 00:59 | failure | skipped | 18,058 | 1,734 | 16,225 | reconciliation |
| 09-05 18:21 → 09-03 00:54 | success ×12 | success ×12 | — | — | — | — |

**runs7d: 14 ok / 15 failed** over the full 7-day window (2026-08-31T20:00Z
onward, 29 scheduled runs). The window opens on a second, earlier red streak —
09-01 01:04 through 09-02 12:32, seven consecutive failures — then twelve
consecutive greens from 09-02 18:26 to 09-05 18:21, then the current eight.
The table above shows the tail; the current streak is the one this PR fixes.

The earlier streak is a THIRD, unrelated shape and is already over: those runs
pulled genuinely nothing (`pages=0 fetched=0 written=0 errors=0`, elapsed 31s),
which is why 09-01 and 09-02 land at 345 and 151 rows in the volume table. That
is the feed itself having no data to give on those days, not a reporting or
plumbing defect, and it recovered on its own at 09-02 18:26.

Two DIFFERENT reds, which the workflow reported with the same sentence:

1. **09-06 00:59 → 09-07 12:32 (7 runs) — reconciliation shortfall.** These
   runs *worked*: they fetched and wrote thousands of rows. `reportWrites`
   set exit 4 because the unaccounted remainder exceeded the 0.5% tolerance
   (09-07 00:58: 213 of 19,109 = 1.11%). Those runs predate the #1954
   workflow fix, so the old `node … && PLATFORMS_OK=… || echo "failed or
   quota-capped"` one-liner folded exit 4 in with a fetch failure and printed
   `TCA ingest wrote nothing on every platform` over a run that had just
   written 9,177 rows.

2. **09-07 18:24 (1 run) — the #1954 fix itself is broken.** This run carried
   f5869a61 and its `case "$RC"` block, and still fell to `*)` — because the
   script died in 0.3s with `COSMOS_CONNECTION_STRING required`. See the
   defect below.

**Quota was never involved.** `x-ratelimit-remaining` was 200,000 on the
09-07 00:58 failure and 199,996 when measured for this report, against a
200,000/day limit. The daily-feed window is the unlimited one; the 2,000/day
per-platform cap in the runbook is not the binding constraint here. The
`::error::Daily TCA sales quota is exhausted` line is emitted whenever
`PLATFORMS_OK=0` regardless of the actual header, which is what sent the
2026-09-07 reader after a cap that was sitting at 199,998.

### Defect fixed in this PR — the env chain broke before `node`

`COSMOS_CONNECTION_STRING required` in 0.3s, with the connection string
resolved correctly one step earlier, has one cause: the child never got it.

The #1954 rewrite inserted its explanatory comment BETWEEN the last env
assignment and `node`, after a trailing backslash:

```sh
CRAWLER_ID="tca-…" \
# CF-TCA-EXIT-4-IS-NOT-A-QUOTA-CAP …
set +e
node scripts/tca-firehose-ingest.cjs
```

A backslash-newline continues onto the comment line; the comment then *ends*
the command. Every assignment in the chain bound to the next simple command —
`set +e`, a shell builtin, which discards them — and `node` ran as a separate
command with an empty environment.

Verified by extracting the real block from the YAML and executing it with a
stub in place of `node`:

```
origin/main   ENVCOUNT=0  COSMOS=<EMPTY>
this PR       ENVCOUNT=5  COSMOS=conn
```

The fix moves the comment above the chain and puts `set +e` before it, so the
chain runs unbroken into `node`. `backend/tests/tcaFirehoseEnvChain.test.ts`
pins it four ways (no comment inside the chain, every line continues, `set +e`
outside, and the executable ENVCOUNT=5 probe); all four fail against
`origin/main` and pass against this branch.

**Not fixed here (reported):** the reconciliation shortfall itself. Seven runs
exceeded the 0.5% tolerance with 1.1% unaccounted. That is a real accounting
gap in `tca-firehose-ingest.cjs` — rows fetched, neither written, skipped, nor
counted as errors — and it needs its own measurement of which rows go missing.
It is a separate change from the shell fix and is deliberately out of scope.

## 2. Landing — `sold_comps` where `source='tca-ebay'`

Counted by `observedAt` (the canary's own axis) rather than `_ts`.

| Day (ending) | Rows |
|---|---|
| 2026-08-25 | 101,035 |
| 2026-08-26 | 14,592 |
| 2026-08-27 | 12,503 |
| 2026-08-28 | 8,188 |
| 2026-08-29 | 434,606 |
| 2026-08-30 | 3,820 |
| 2026-08-31 | 447 |
| 2026-09-01 | 345 |
| 2026-09-02 | 151 |
| 2026-09-03 | 23,371 |
| 2026-09-04 | 27,581 |
| 2026-09-05 | 20,673 |
| 2026-09-06 | 25,733 |
| 2026-09-07 | 25,031 |

Volume is **steady at 20.7k–27.6k/day since 09-03** and did not collapse when
the guard landed. The 08-31 → 09-02 trough (151–447/day) matches the canary's
own red window on 09-06 and predates the guards.

Rows are still landing right now (newest `observedAt` 2026-09-07T18:37Z,
0.1h before the last canary run) **even though the cron has been red for two
days** — because the live writer is the TCA **webhook**
(`backend/src/routes/tcaWebhook.routes.ts`), not the cron. That is why the
outage has been invisible: the webhook keeps the pool fed and the canary green
while the scheduled backlog-drainer does nothing.

### Parks since the guard

`identityUnverified = true` on tca-ebay rows in the last 24h: **32** of
~25,031 (**0.13%**). Enumerated by reason, all 32 are the same class:

| Reason | 2026-09-07 | Total |
|---|---|---|
| `split-identity` | 32 | **32** |
| sport-unresolved | 0 | 0 |
| malformed-key | 0 | 0 |

So the two classes #1939 measured — 8,102 malformed `hiq:` keys and the
sport-defaulted split — are **no longer being produced**: nothing in the last
24h parked for a malformed key or an unresolved sport. What still parks is the
genuine case the guard exists for, a sale whose two identity fields disagree
and where no attestation resolves it (e.g. `2000 Upper Deck Black Diamond #T8
Barry Bonds Constant Threat`). The 500-row samples below contain zero parked
rows, consistent with 0.13%.

Neither failure mode is present:
- **Not a park flood** — 0.13% is far too small to be the guard catching a
  large class that used to be written wrong.
- **Not over-refusal** — written volume is unchanged across the guard's
  arrival (25.7k on 09-06, 25.0k on 09-07, against a 20.7k–27.6k band).

The guard is doing exactly what #1929/#1939/#1941 intended: parking a thin
tail and letting the rest through.

## 3. Identity quality — 500-row samples

Sampled `source='tca-ebay'` over the last 24h and over 2026-08-31 (pre-fix).
Catalog-backed = the row's `hobbyiqCardId` resolves to a `card_catalog` row
(150 distinct slugs checked per sample).

| Measure | last 24h | 2026-08-31 | Direction |
|---|---|---|---|
| rows sampled | 500 | 432 | — |
| unknown / empty setName | 2.8% | 9.5% | **better** |
| missing cardNumber | 0 | 18 | **better** |
| missing cardYear | 0 | 0 | flat |
| parked (`identityUnverified`) | 0 | 0 | flat |
| `hobbyiqCardId` ≠ `cardId` | 5.6% | 31.5% | **much better** |
| grader in slug but not in title | 1.8% | 0.9% | slightly worse |
| catalog-backed slugs | **42.0%** | 30.7% | **better** |

Sport mix over the 24h sample: baseball 398, football 42, basketball 26,
hockey 15, pokemon 9, non-sport 6, mma 2, soccer 1, wrestling 1. JA/EN market
agreement is not measurable on these rows — no `market` field is written by
this lane; Pokémon rows (9/500) carry `sport='pokemon'` and an English set
name, with no JA/EN split recorded either way.

The headline is the **slug/cardId divergence dropping 31.5% → 5.6%** and
catalog-backing rising by ~11 points. That is the #1939/#1941 identity work
showing up in the data.

The residual 5.6% is real and worth a look after go-live. Example from the
current feed — `tca-ebay::287353080376`:

```
title           MICHAEL JORDAN 1991-92 NBA HOOPS #317 - MILESTONES - GRADED PSA 8 NM-M
hobbyiqCardId   hiq:basketball:1991:panini-hoops:317:base:no-auto:cgc-9
cardId          hiq:basketball:1991:nba-hoops:317:base:no-auto
```

Two disagreements in one row: `panini-hoops` vs `nba-hoops` for the same card,
and a **`cgc-9` grade on a title that says PSA 8**. The grade-token rule is
"grade from grader token only"; this row has a grader in the slug that the
title contradicts. 1.8% of the sample shows that shape.

## 4. Freshness canary

`.github/workflows/sold-comps-freshness-canary.yml`, every 6h at :30.
`MAX_STALENESS_HOURS=25`, `MIN_ROWS_24H=tca-ebay=25000`.

Last 4 runs green. Before that, three consecutive failures on 09-06
(01:12, 06:45, 12:40) — the same window as the volume trough.

Latest run (09-07 18:40):

```
tca-ebay   latest observedAt 2026-09-07T18:37:07Z   0.1h stale
tca-ebay   rows (last 24h) 26752   floor 25000   ok
tca-ebay   last full day 26348  baseline 16229  floor 8114   ok
```

**AMBER, for two reasons.**

The row floor passes with **7% of headroom** (26,752 vs 25,000). Four of the
last fourteen days would have failed it. A floor that close to the working
volume will flap.

More importantly, **the canary cannot see that the cron is dead.** Its two
axes are staleness and 24h row count, and the webhook satisfies both on its
own — which is precisely the failure shape `freshnessCanaryRowFloor.test.ts`
was written for ("the canary could not tell the firehose from the webhook
trickle"). MIN_ROWS_24H added a second axis but not a second *source*: eight
consecutive dead cron runs produced no canary signal at all. Distinguishing
webhook-fed from cron-fed volume is the missing axis.

On contamination: an early `_ts`-ordered sample suggested most `tca-ebay` rows
were REA/TCGplayer. Measured on the canary's `observedAt` axis, non-eBay rows
under the `tca-ebay` label are **0.2% of the last 24h** (56 TCGplayer, 0 REA)
and do **not** inflate the count. The REA rows are a backfill with old
`observedAt` values. Worth noting but not a canary defect:
`tcaWebhook.routes.ts:393` hardcodes `persistVendorSalesToPool("tca-ebay", …)`
while the payload carries a `platform` field, so auction-house and TCGplayer
sales are labelled `tca-ebay`. It is a source-attribution wart, not a live
distortion, and is left alone in this PR.

## 5. Bypass writers — 0

Grep of `main` for writers into `sold_comps`: the only vendor-sales write is
`persistVendorSalesToPool.service.ts:1955`. It does **not** call
`recordSoldComp`, and that is deliberate, not a bypass — #1941 applies the
same predicate at the second door:

```ts
// ── THE WRITE DOOR — CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07) ──
// The SAME predicate `recordSoldComp` applies, applied here. Not a
// second guard — the one function, at the second door.
const verdict = guardSoldCompDoc(doc as Record<string, unknown>, {
  attestedSport: sportDefaulted ? null : doc.sport ?? null,
  …
  guardedBy: "persistVendorSalesToPool:split-identity-guard",
});
```

Confirmed on live rows: fresh tca-ebay documents carry the guard's fields
(`identityUnverified` and, where parked, `identityUnverifiedReason` /
`identityUnverifiedBy` / `identityUnverifiedAt`), and the twin-address rule
fires in the ingest logs (`twin_address_refused` with `wouldWriteAt` /
`alreadyAt`). Every TCA row goes through the guard. **bypassWriters = 0.**

## What to do before go-live

1. **Merge this PR and dispatch the firehose once manually** to confirm a
   green scheduled run end-to-end (it also un-skips the match-enricher, which
   has not run since 09-05).
2. **Measure the 1.1% reconciliation shortfall** — which fetched rows are
   neither written, skipped, nor errored. Until that is closed, every run that
   pulls a large page will be red on a real but unexplained gap.
3. **Give the canary a cron-vs-webhook axis.** Eight dead cron runs produced
   no alert. Consider a per-writer floor rather than a per-source one.
4. Lower-priority: the 5.6% slug/cardId divergence and the PSA-title/CGC-slug
   shape; and `tcaWebhook.routes.ts:393` labelling every platform `tca-ebay`.

## Evidence

- Runs: `gh run list --workflow=tca-firehose-ingest.yml`, `gh run view --log-failed`
- Volume/parks/samples: Cosmos `hobbyiq.sold_comps`, `observedAt`-windowed
  counts and bounded `TOP 500` samples; `card_catalog` for slug backing
- Quota: `x-ratelimit-remaining` from `thecardapi.com/api/v1/market/sales`
- Shell defect: the block extracted from the YAML and executed both ways
  (`ENVCOUNT=0` on `origin/main`, `ENVCOUNT=5` on this branch)

**Note on `sold_comps` throughput:** the container's offer reads
`offerThroughput: 100` RU/s (autoscale max 40,000), against a documented 10k
floor. Every cross-partition `COUNT` in this check ran for minutes or timed
out at 100 RU/s; the measurements here use bounded windows and `TOP N` samples
for that reason. Flagged for the owner — a live config read only, unchanged.
