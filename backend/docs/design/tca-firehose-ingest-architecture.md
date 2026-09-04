# thecardapi eBay Firehose Ingest — architecture memo

**Owner:** Drew · **Draft date:** 2026-08-02 · **Status:** design pass, pre-implementation · **Decision needed:** Pro tier ($$/mo) subscription + go/no-go on ingest job

## Product intent

Turn HobbyIQ from an **on-demand pricing engine** (user query → CH `/cards/comps` → maybe cached) into a **pre-loaded firehose** where every eBay sports sale is ingested continuously and lives in `sold_comps` before any user asks. When a user searches, they hit our indexed pool with zero API-call latency.

**Why this matters:** verified 2026-08-02 that 82% of graded eBay sales in the last few days are missing from BOTH `sold_comps` AND `ch_daily_sales`. CH's on-demand + nightly-ingest model is fundamentally not comprehensive — even flagship cards (Ohtani 2018 Topps Chrome Update HMT1 PSA 10 $850, LeBron 2003-04 Topps #221 $892, Luka 2024-25 One and One Downtown $2,994) landed in eBay but never in our pool. thecardapi's `/sales` covers 6.7M eBay records queryable today with continuous ingest; adding it as an ingest source closes the coverage gap without changing our query surface.

## User stories

- **Buyer**: "Show me the latest sales of a rare parallel I'm watching" → results include TODAY's sales, not just the ones someone else queried.
- **Seller**: "Price my card against the last 30 days of comps" → the pool is comprehensive across all eBay grading tiers, not a curated CH subset.
- **Deal scanner**: "Alert me when a card sells below its floor" → the scanner sees every eBay sale, not just the 18% CH surfaces.
- **Portfolio FMV**: "What's my card worth right now" → FMV is projected from a pool that includes every recent sale of the card and its siblings.

## Scope this memo

**In scope.** The ingest pipeline: thecardapi `/sales` → dedup/reshape → `sold_comps` write → async title-matching for identity enrichment. Includes cron cadence, quota budgeting, retry/backoff, provenance labeling, monitoring.

**Out of scope.** UI changes (search already reads sold_comps unchanged), CH replacement (we keep CH for its structured metadata + PWCC/Alt/mySlabs marketplaces), thecardapi auction-house data (0 records queryable today; separate follow-up when their backfill lands).

## Design principles

1. **Additive, not replacing.** thecardapi lands as a new source alongside `cardhedge` and `cardsight`. Every record tagged `source: "tca-ebay"`. Existing CH pipelines keep running. If TCA breaks we degrade to today's on-demand model, no regression.
2. **Persist raw first, enrich async.** The 82% of TCA rows without `player`/`card_set` populated still get written — they carry `title` + `listing_url` + `price` + `sold_at`. A separate async pass runs our own title→identity matcher against `card_catalog` and populates `playerName`/`setName`/`cardNumber`/`hobbyiqCardId` when a match is found. Unmatched rows stay in the pool with `__pendingMatch: true` — they still contribute to volume stats, and can be re-matched later as `card_catalog` grows.
3. **Idempotent by TCA `id`.** thecardapi assigns each sale a deterministic id (e.g. `tcgplayer-253199-2026-08-02T20:56:49.163+00:00-0-0.24`). We use it verbatim as `sourceExternalId` in `sold_comps`. Same TCA row seen twice → single sold_comps entry. No duplicate math.
4. **Cursor state persisted.** Cron job stores the last-processed TCA cursor in `crawl_state` container. On crash/retry, resumes from checkpoint. On cold start (no state), pulls the full 2.95M sports-eBay backfill from oldest.
5. **Quota-aware backpressure.** Cron sleeps when it approaches daily quota (~180K/200K daily budget = pause until midnight UTC). Explicit budget accounting so we never trip a 429 storm.

## Architecture

```
┌─────────────────────────┐   ┌──────────────────────────┐   ┌───────────────────────┐
│  thecardapi /sales      │   │  TCA Ingest Cron         │   │  crawl_state          │
│  cursor-paginated       │◀──│  (every 15 min)          │──▶│  Cosmos container     │
│  1000 rows/req          │   │  - fetch page            │   │  { cursor, quotaUsed, │
│  200K/day @ Pro tier    │   │  - dedup by TCA id       │   │    lastRunAt }        │
└──────────┬──────────────┘   │  - reshape → sold_comps  │   └───────────────────────┘
           │                  │  - update cursor         │
           │                  └──────────┬───────────────┘
           │                             │
           │                             ▼
           │                  ┌──────────────────────────┐
           │                  │  sold_comps upsert       │
           │                  │  { source: "tca-ebay",   │
           │                  │    sourceExternalId:     │
           │                  │      "<tca_id>",         │
           │                  │    tcaListingUrl: "...", │
           │                  │    __pendingMatch: true  │  ── most rows start here
           │                  │      (if no player)      │
           │                  │  }                       │
           │                  └──────────┬───────────────┘
           │                             │
           │                             ▼
           │                  ┌──────────────────────────┐
           │                  │  Async Identity Matcher  │
           │                  │  (batch, every 15 min)   │
           │                  │  - title → card_catalog  │
           │                  │  - lookup (player, year, │
           │                  │    setName, cardNumber)  │
           │                  │  - compute hobbyiqCardId │
           │                  │  - clear __pendingMatch  │
           │                  └──────────┬───────────────┘
           │                             │
           │                             ▼
           │                  ┌──────────────────────────┐
           │                  │  sold_comps (indexed)    │
           └─────────────────▶│  ready for search reads  │
                              └──────────────────────────┘
```

## Storage schema

### New `sold_comps` fields

Existing schema unchanged. Add three fields to rows written by this pipeline:

| Field | Type | Purpose |
|---|---|---|
| `source` | `"tca-ebay"` | Provenance. Enables filtering + attribution + calibration by source. |
| `sourceExternalId` | `string` | TCA's row id, verbatim. Format: `<platform>-<catalogId>-<isoTs>-<seq>-<price>`. |
| `tcaListingUrl` | `string` | eBay item URL for verification / dead-listing detection. |
| `__pendingMatch` | `boolean` | `true` when the row was written without structured player/set — enrichment queue picks it up. |
| `__tcaIngestedAt` | `string` (ISO) | When we wrote the row. |

### `crawl_state` container (NEW)

Single document per crawler:

```json
{
  "id": "tca-ebay-firehose",
  "cursor": "<opaque base64 from TCA>",
  "quotaUsedToday": 47823,
  "quotaResetAt": "2026-08-03T00:00:00Z",
  "lastRunAt": "2026-08-02T21:15:00Z",
  "totalRowsWritten": 1204853,
  "lastError": null
}
```

Partition key `/id`. Single document. Trivial container, ~1KB storage.

## Ingest cadence

**Cron frequency (as designed):** every 15 min via GitHub Actions (matches existing `Daily 5AM ET Refresh & Deploy` pattern; new workflow `TCA Firehose Ingest`).

**Cron frequency (as shipped, current 2026-09-04).** The every-15-min cadence
was retuned twice and no longer holds; `.github/workflows/tca-firehose-ingest.yml`
is authoritative. Four scheduled runs per day, all `APPLY=true`:

| Cron (UTC) | Role | `MAX_MINUTES` | Job `timeout-minutes` |
| --- | --- | --- | --- |
| `5 0 * * *` | Reset-window run — opens the fresh 200K/day cap and walks the backlog | 40 | 50 |
| `5 6 * * *` | Platform-lag pass (CF-TCA-PLATFORM-LAG) | 12 | 50 |
| `5 12 * * *` | Platform-lag pass | 12 | 50 |
| `5 18 * * *` | Platform-lag pass | 12 | 50 |

Manual `workflow_dispatch` defaults to 15 minutes.

Why the 00:05 run is budgeted differently (CF-TCA-RESET-WINDOW-BUDGET, Drew
2026-09-04): `max_minutes` is only ever populated by `workflow_dispatch`, so
every cron fell through to the same 12-minute fallback. The reset-window run
was therefore stopping on *our* wall clock while the cursor was preserved and
the quota was nowhere near exhausted — a budget binding on the abundant
resource instead of the scarce one. The workflow now tells the crons apart via
`github.event.schedule` (the same mechanism `promote-staging-pending.yml`
uses), so only the 00:05 run gets the larger window; the platform-lag passes
re-pull yesterday as each platform publishes and do not need it. The
match-enricher job tracks the same budget, or a 40-minute pull leaves its extra
rows `__pendingMatch` for a full day.

**The 200K/day cap is shared.** Three workflows hold `TCA_API_KEY`:
`tca-firehose-ingest.yml`, `portfolio-priority-pull.yml` and
`promote-staging-pending.yml`. The priority pull ran at 00:00 UTC with a
15-minute budget and so was still draining the cap when the firehose's 00:05
run started — the exact condition the firehose's own CF-TCA-QUOTA-VISIBILITY
guard reports as "something else is draining the 200K/day cap before this cron
runs". It moved to **21:00 UTC** (CF-TCA-QUOTA-WINDOW, Drew 2026-09-04), which
leaves ~2h45m of slack before the 00:00 reset and gives the firehose the fresh
day's cap to itself. `backend/tests/tcaQuotaWindowAndBudget.test.ts` pins the
non-overlap and the per-schedule budget.

**Per-run behavior:**

1. Read `crawl_state` (get cursor + quota state)
2. If `now >= quotaResetAt`: `quotaUsedToday = 0`, `quotaResetAt = midnight UTC + 24h`
3. If `quotaUsedToday >= 180000` (safety buffer under 200K Pro cap): skip run, log
4. Loop: fetch page (1000 rows), dedup, upsert to sold_comps, advance cursor
5. Break loop when: page returns 0 rows / no cursor / quota approaches limit / 12 min elapsed
6. Persist final cursor + updated quota to `crawl_state`
7. Emit summary event to App Insights

**Steady-state math:**
- ~2.95M sports-eBay backlog / 200K daily = ~15 days to catch up
- Post-catchup daily new volume est. ~40-60K/day (thecardapi's total ingest rate)
- Headroom: ~140K/day (comfortable buffer for auction-house feed once it lands)

## Dedup + write shape

**Dedup key:** TCA's `id` field, one-to-one map to `sourceExternalId`. Upsert by this id — same TCA row seen twice = no duplicate.

**sold_comps write shape (unmatched, most common):**
```json
{
  "id": "<generated>",
  "cardId": "<null-until-matched>",
  "source": "tca-ebay",
  "sourceExternalId": "ebay-2026-08-02-abc123-0-124.99",
  "title": "Mike Trout 2011 Topps Update #US175 Rookie",
  "price": 124.99,
  "soldAt": "2026-08-02T15:32:00Z",
  "sport": null,
  "cardYear": null,
  "playerName": null,
  "setName": null,
  "cardNumber": null,
  "parallel": null,
  "gradeCompany": null,
  "gradeValue": null,
  "isAuto": null,
  "printRun": null,
  "hobbyiqCardId": null,
  "confidence": 0.5,
  "imageUrl": "https://i.ebayimg.com/...",
  "tcaListingUrl": "https://www.ebay.com/itm/...",
  "__pendingMatch": true,
  "__tcaIngestedAt": "2026-08-02T21:15:00Z"
}
```

**sold_comps write shape (TCA already matched, ~18% of rows):**
Same as above, plus populated `sport`/`cardYear`/`playerName`/`setName`/`cardNumber`, plus computed `hobbyiqCardId`. `__pendingMatch: false`.

**Cardsight-unverified equivalent for TCA:** default `confidence: 0.5` (raw eBay listing, not vendor-authoritative). Bumps to 0.7 after successful catalog match, 0.8 after cross-source consensus (if CH also has it).

## Identity matcher

Runs as its own cron (`TCA Match Enricher`, every 15 min, offset 7 min from ingest so it processes what was just written).

Pass:
1. Query `sold_comps` for `__pendingMatch = true` rows, TOP 5000, oldest first (fair queue)
2. For each row, run title-parser (already exists: `parseCardQuery` in `backend/src/services/cardIdentity/parseCardQuery.ts`) to extract player/year/set/number/parallel candidates
3. Lookup against `card_catalog` for a match (identity tuple exact + fuzzy fallback)
4. On match: populate identity fields, compute `hobbyiqCardId`, set `__pendingMatch: false`, bump confidence to 0.7
5. On miss (`card_catalog` doesn't have this card): leave `__pendingMatch: true` for retry next round — as `card_catalog` grows (via the sold_comps → catalog backfill I already wrote), previously-unmatchable rows resolve later

**Expected match rate over time:**
- Day 1: ~18% (rows where TCA populated identity for us)
- Day 7 (post backfill from sold_comps → catalog running): ~50%
- Day 30 (post identity-matcher tuning + catalog backfill): 70-80%

Unmatched rows still contribute:
- Volume stats
- Player-agnostic price momentum ("Panini Prizm Football listings up 8% W/W")
- Long-tail search via title CONTAINS (the sold_comps supplement rung I just shipped)

## Quota budgeting

**Pro tier:** 200,000 sales/day, 90-day lookback.

**Consumption pattern:**
- 96 cron runs/day × ~2K rows/run avg = 192K/day at steady state
- Historical catchup at start: 15 days × 200K = 3M total (matches sports-eBay pool)
- Buffer: 8K/day slack for auction-house records once their backfill lands

**Guardrails:**
- 180K/day soft cap (skip further runs — persist state, resume tomorrow)
- Per-request 60s timeout
- Cursor advances only after successful sold_comps write batch (crash-safe)

**If we outgrow Pro:** move to Enterprise (custom limits, unlimited lookback). Trigger: sustained >180K/day for 7 consecutive days.

## Rate limit + retry

- Per-page 60s timeout with 3 retries on 5xx (500, 502, 503, 504) with exp backoff (1s, 5s, 30s)
- On 429: honor `Retry-After` header if present; else back off 60s and reduce concurrency to 1
- On 4xx (400, 401, 403): log + alert Drew, do NOT retry, halt cron (indicates auth/misconfig, requires human)

## Observability

App Insights custom events emitted per run:

| Event | Fields |
|---|---|
| `tca.ingest.run.start` | `runId`, `cursorFrom`, `quotaUsedToday` |
| `tca.ingest.page.fetched` | `runId`, `pageNum`, `rowCount`, `nextCursor` |
| `tca.ingest.row.written` | (batched) `runId`, `writtenCount`, `dedupSkipped`, `matched`, `pending` |
| `tca.ingest.run.complete` | `runId`, `totalWritten`, `totalQuotaUsed`, `elapsedMs`, `newCursor` |
| `tca.ingest.error` | `runId`, `code`, `message`, `retryAttempt` |
| `tca.match.run.complete` | `runId`, `rowsProcessed`, `matched`, `stillPending` |

KQL dashboard queries:
- Daily ingest volume trend
- Quota consumption vs 200K cap
- Match-rate percentage over time
- Error rate + last error timestamp

## Migration path

**Phase 0 (day 0):** subscribe to Pro tier, add `TCA_API_KEY` to HobbyIQ3 App Service settings (**HALT-for-confirm** per CLAUDE.md).

**Phase 1 (day 1-2):** ship ingest job + `crawl_state` container. Start with `SPORT=baseball` only + 50K/day soft cap. Verify:
- Rows land in sold_comps with correct shape
- Dedup works (re-run same page, same sold_comps state)
- No downstream breakage (search still returns same-or-better results)
- Match rate roughly matches the 18%/82% split observed today

**Phase 2 (day 3-14):** ramp to full sports + 180K/day cap. Historical catchup 2.95M rows. Match enricher active.

**Phase 3 (day 15+):** steady state. Monitor match rate; tune title parser as needed. Evaluate Enterprise upgrade if quota-bound.

## Rollback

If ingest goes wrong, three levels of rollback:

1. **Pause ingest cron** — disable the GH Actions workflow. Existing sold_comps rows stay (they're valid data). CH pipeline continues as today. Zero user impact.
2. **Quarantine TCA rows in search** — one-line change: add `AND source != 'tca-ebay'` to canonicalCardSearch's primary query. Rows still in container but invisible until fix.
3. **Purge TCA rows** — delete script filtered on `source = 'tca-ebay'`. Reversible only by re-running catchup. Nuclear option, reserved for data-quality catastrophe.

Rollback #1 is the default; #2 and #3 are escalations.

## Cost analysis

**thecardapi Pro tier:** ~$$$-$$$$/mo (need to confirm exact price with them; docs suggest Pro is between Builder ~$99 and Enterprise custom). Assume $299-499/mo range.

**Cosmos DB delta:**
- Storage: ~3M new sold_comps rows × ~800 bytes = ~2.4 GB additional (~$0.60/mo at hot-tier pricing)
- Writes: 2.95M initial catchup × 10 RU/write = 29.5M RU one-time (~$2 at current provisioned capacity, absorbed by burst); ongoing ~192K/day × 10 RU = ~1.9M RU/day (~$0.05/day)
- Reads: no new read cost — same search patterns
- **Net Cosmos delta:** <$5/mo ongoing after initial catchup

**Total incremental cost:** ~$300-500/mo (dominated by TCA subscription). Compared to: ~518K distinct cardIds observed in 6+ years vs ~2.95M we'll now cover — 5.7× coverage increase at $300-500/mo. Per-card cost drops from ~$0 (CH is fixed cost we're already paying) but per-sale coverage roughly quadruples.

## Open questions

1. **Pro vs Enterprise?** Pro (200K/day) covers steady state comfortably but not auction-house backfill if it drops in one burst. Enterprise negotiation could bundle bulk historical CSV of auction houses. → Answer via email response we drafted.
2. **Title matcher confidence threshold.** 82% of rows start unmatched. What confidence floor for auto-populating `hobbyiqCardId`? Recommend 0.75 (matches existing catalog verification hierarchy). Rows below 0.75 stay `__pendingMatch: true` for human review or better matcher iteration.
3. **Cross-source dedup.** If TCA has a Trout 2011 US175 sale and CH also has the same eBay item (via CH's own eBay crawl), we'll write TWO sold_comps rows for the same real-world sale. Impact: pool medians skew slightly toward high-volume sale prices (double-counted). Mitigation options: (a) accept the noise (~5% overlap based on our probe = minor); (b) cross-check by eBay item ID at write time (requires CH to also store eBay ids, which it currently doesn't); (c) periodic dedup job by (title, price, soldAt ±1min). Recommend (a) for MVP; revisit if calibration drift shows up.
4. **TCA date filter is broken on our current tier.** Same total count for 2020, today, and last-3-days. May be a tier restriction we haven't hit or a bug on their end. Need clarification from vendor before relying on `sale_date_from`/`sale_date_to`. Workaround: cursor-based pagination doesn't need date filters (walks in `date_desc` order); we just checkpoint cursor and don't re-fetch.
5. **What happens when card_catalog doesn't have a card yet?** Two answers: (a) the sold_comps → card_catalog backfill I already wrote (`backend/scripts/backfill-catalog-from-sold-comps.cjs`) closes the gap in the other direction — new sold_comps rows spawn new catalog entries; (b) the async matcher retries `__pendingMatch: true` rows every 15 min, so they resolve as catalog grows. Self-healing loop. *(2026-08-29: `backfill-catalog-from-sold-comps.cjs` was deleted in D5 PR 5 — sales never mint a catalog row (#1353); only (b) remains.)*

## Decision checklist

Before implementation:

- [ ] **Go/no-go on Pro tier subscription.** Cost: ~$300-500/mo.
- [ ] **Live prod config change:** add `TCA_API_KEY` to HobbyIQ3 App Service settings (HALT-for-confirm per project doctrine).
- [ ] **New Cosmos container `crawl_state`** (small, ~1KB, minimal cost).
- [ ] **New GH Actions workflow** `TCA Firehose Ingest` (cron every 15 min).
- [ ] **New source label `tca-ebay`** — downstream calibration doesn't yet segment on it; safe additive tag but calibration doctrine ([[project-calibration-from-our-pool-only]]) will want a source-agnostic view.
- [ ] Vendor email sent re: auction-house backfill timeline (drafted, awaiting your send).

## References

- [[project-persist-vendor-lookups-architecture]] — every CH/CS/eBay query grows our owned containers. TCA firehose extends this doctrine from on-demand to continuous.
- [[project-catalog-is-the-moat-not-vendor-apis]] — user requests answer from indexed pool. TCA feeds that pool.
- [[project-sold-comps-unified-pool]] — one container holds every observed transaction. TCA rows land here.
- `backend/scripts/backfill-catalog-from-sold-comps.cjs` — the complementary catalog backfill; TCA writes drive catalog growth, catalog growth improves TCA match rate. *(Deleted 2026-08-29, D5 PR 5 — sales never mint, #1353.)*
- Overlap probe results 2026-08-02: 82% of TCA graded sales missing from BOTH sold_comps + ch_daily_sales.
