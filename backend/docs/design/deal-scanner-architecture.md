# Deal Scanner — architecture memo

**Owner:** Drew · **Draft date:** 2026-07-10 · **Status:** design pass, pre-implementation

## Product intent

Turn the reference-catalog ladder into the flagship consumer surface: a live-scored feed of eBay listings where every listing gets a **structural value envelope** from print-run + tier, and any listing priced below that envelope pops as a **mispriced-deal alert**.

Why this is the flagship: the ladder covers 4,902 parallels across every product family. Even on cards with zero comps (Hartman-class, per Phase 5 v2), the scanner can still produce an honest floor and score against it. That's a categorical unlock that no comp-driven pricing engine can match.

## User stories

- **Buyer**: "Show me every listing in my watch categories that's currently below its structural floor by ≥20%, ranked by absolute dollar delta." → deal-feed view + push alerts.
- **Seller**: "This card I'm listing — how does my price compare to structural floor and to recent comps?" → listing-companion view (deferred to Phase 2 of scanner).
- **Investor**: "Alert me when any Superfractor / Padparadscha / Black /5 auto shows up below its floor." → watchlist alerts on scarce-tier cards.

## Scope this memo

**In scope for design.** The signal loop: eBay listings ingest → ladder-aware scoring → mispriced-deal detection → surfacing (feed + push).

**Out of scope for this memo.** iOS UI polish, buyer flow (auction sniping, offer suggestions), seller-facing pricing coach, cross-marketplace expansion (COMC / MySlabs / PWCC). Those are follow-ups after the signal loop proves itself.

## Design principles (carried from Phase 5)

1. **No additive blend.** Structural floor from the ladder OR comp-driven pricing — never both added together. The scanner's score is (listing_price / structural_floor) — one term, unambiguous.
2. **Confidence segmentation from day one.** Every scored listing carries the confidence tier of the ladder row that produced its floor (Verified / High / Medium). Downstream training + user surfacing can filter by confidence.
3. **Structural priors are floors, not point estimates.** A listing scoring at 0.9× floor is NOT necessarily a deal — it might just be a common card at fair market. Deal detection is (score < threshold) AND (thin-comp OR high-scarcity-tier) — the ladder's real value shows on rare tiers where comps don't exist.
4. **Idempotent + rate-limit-safe.** Same listing scored twice produces the same result. Scanner-side rate limits govern eBay call budget, not the scoring math.

## Architecture

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│  eBay Browse API     │    │   Listing Scorer     │    │  Scored Listings     │
│  (poll active        │───▶│   (per listing:      │───▶│  Cosmos container    │
│   listings by        │    │    parse title →     │    │  keyed by listing_id │
│   watch-cat + query) │    │    resolve to        │    │                      │
└──────────────────────┘    │    ParallelDoc →     │    └──────────┬───────────┘
                            │    lookup anchor →   │               │
                            │    floor = anchor    │               ▼
                            │      × tier_mult →   │    ┌──────────────────────┐
                            │    score = price /   │    │  Deal Detector       │
                            │      floor)          │    │  (score < threshold, │
                            └──────────────────────┘    │   confidence >= K,   │
                                                        │   tier is scarce)    │
                                                        └──────────┬───────────┘
                                                                   │
                                              ┌────────────────────┴───────────┐
                                              ▼                                ▼
                                    ┌──────────────────┐            ┌──────────────────┐
                                    │ /api/deals/feed  │            │ Push Alerts      │
                                    │ (ranked live     │            │ (via devices     │
                                    │  deals for       │            │  subscribed to   │
                                    │  watch cats)     │            │  matching        │
                                    └──────────────────┘            │  watchlists)     │
                                                                    └──────────────────┘
```

## Data flow — end to end

1. **Poll trigger** — cron every N minutes fetches "active listings, sold=false, updated in the last N min" from eBay Browse API for each active watch category. Bounded budget: M queries per hour based on eBay API quota.

2. **Ingest** — for each listing raw payload, extract `(title, listing_id, price, seller_feedback, listing_url, image, item_id, condition)`. Persist to `ebay-listings-raw` Cosmos container (partition `/watchCategory`), TTL 48h.

3. **Score** — for each new/updated listing:
   1. Parse title → structured `(year, product, playerName, cardNumber, parallel, isAuto)` via the existing `SearchIQOrchestrator` parser.
   2. Resolve to `ParallelDoc` via `/api/reference/parallels/resolve` (Cosmos, cached in-process).
   3. Compute anchor: try player-scoped `fetchCompsByPlayer` first, fall through to `fetchProductYearMedianAnchor` (Phase 5 v2, once flag on).
   4. Compute floor = `anchor.median × floorForPrintRunByClass(parallelDoc.printRun, cardClass)`.
   5. Compute score = `listing.price / floor`. Persist `(listingId, floor, score, confidence, source)` to `ebay-listings-scored` container (partition `/watchCategory`), TTL 48h.

4. **Detect deals** — cron every N minutes over `ebay-listings-scored`:
   - `score < 0.8` (20%+ below floor) AND
   - `confidence != "Medium"` (v1 excludes Medium-confidence-floor listings to avoid false positives from unverified ladder rows) AND
   - `parallelDoc.printRun <= 50` (scarce tier — the ladder is most reliable here).
   Emit `deal_detected` event with `(dealId, listingId, score, structuralFloor, deltaDollars)` to `deals-feed` container.

5. **Surface**:
   - **Feed**: `GET /api/deals/feed?watchCategory=...&limit=25` — returns latest N `deal_detected` rows ordered by `deltaDollars DESC`.
   - **Alerts**: on each `deal_detected` write, push to matching watchlist subscribers via existing `devices/alerts` infra. Push copy: "Deal: [title] at $X (structural floor $Y, delta $Z)".

## Cosmos containers

| Container | PK | TTL | Purpose |
|---|---|---|---|
| `ebay-listings-raw` | `/watchCategory` | 48h | eBay Browse API payloads, deduped by `listing_id` |
| `ebay-listings-scored` | `/watchCategory` | 48h | Per-listing `(floor, score, confidence)` |
| `deals-feed` | `/watchCategory` | 7d | Deal-detected events for feed + alerts |

RU budget target: 800 RU/s shared across the three containers (raw ingest is by far the heaviest — bulk writes at CH-ingest scale ~10 writes/s).

## API surface

- `GET /api/deals/feed?watchCategory=&limit=` — ranked deals, latest deltaDollars-descending.
- `GET /api/deals/:dealId` — deal detail (listing + floor + score + attribution).
- `POST /api/deals/watchcategories` — user CRUD for watch categories (subset of the reference-catalog `productKey` list, or free-text queries).
- `GET /api/deals/scores?listing_id=` — inverse-lookup for a specific listing (used by seller-companion view later).

Auth: same JWT pattern as the rest of the app. Watchlist writes require ownership; feed reads are gated on subscription tier (Investor / Pro Seller — Phase 5 memory notes the tier lock).

## Rollout — PR sequence

- **PR 1 — this memo** (docs only, no code). Reviewable in isolation.
- **PR 2 — eBay ingest pipeline.** Browse API client + `ebay-listings-raw` container + cron job + rate-limit budget. No scoring yet.
- **PR 3 — scoring engine.** Extract-parse-resolve-anchor-floor logic + `ebay-listings-scored` container. Reuses `SearchIQOrchestrator` parser and `fetchProductYearMedianAnchor` from Phase 5 v2. Behind `DEAL_SCANNER_SCORING_ENABLED` flag.
- **PR 4 — deal detector + feed endpoint.** `deals-feed` container + `GET /api/deals/feed`. Behind `DEAL_SCANNER_DETECTION_ENABLED` flag.
- **PR 5 — push alerts wire-up.** Existing `devices/alerts` infra + matching-watchlist fanout. Behind `DEAL_SCANNER_ALERTS_ENABLED` flag.
- **PR 6 — iOS deal-feed view.** SwiftUI + `/api/deals/feed` binding. Uses standard app card-cell components.

Each PR ships behind its own flag so we can gate them independently. PR 3 without PR 4 → scoring populates but never surfaces. PR 4 without PR 5 → feed available but no notifications. Etc.

## Risks + open questions

1. **eBay API quota.** Browse API has request-per-day ceilings. Need to size N watch categories × poll cadence to stay under. Instrument RU + API-call budget early.
2. **Title-parsing fidelity.** The existing parser handles known formats well. eBay seller titles are LESS clean than CH's structured data. Need a title-parse-fail bucket + fallback: unrecognized listings get `confidence: "unparsed"` and are excluded from deal detection.
3. **False positives from grading arbitrage.** A raw card selling for 30% of PSA-10 comp isn't a deal — it's just a raw card. The floor lookup MUST account for the listing's grade (parse-out "PSA 9", "BGS 9.5", "Raw" from title). Grade-agnostic floor + grade-adjustment multiplier.
4. **Auction vs BIN.** eBay auctions with 5 days left aren't scored the same as Buy-It-Now. v1 scope: BIN only. Auctions in Phase 2.
5. **Medium-confidence exclusion is aggressive.** 64% of ladder rows are Medium (per audit 2026-07-10). Deal detection excluding all of them means v1 covers only ~36% of the ladder's coverage. Phase 2 verification will lift Medium rows to High and unlock the rest.

## Metrics — what "working" looks like

Instrument from day one:
- **Scanning coverage**: % of ingested listings that produce a score (parse success × ladder resolve success).
- **Deal rate**: deals-per-1k-scored-listings, by watch category + confidence tier.
- **Precision proxy**: % of deals that end in listings actually selling at or above the structural floor within 30d. Directly measures whether the floor is honest.
- **User engagement**: deal-feed opens, deal-detail views, push-alert click-throughs.

Target for v1: precision proxy ≥ 60% (three in five detected deals really are underpriced). If we hit that, the scanner works. Below that, the ladder needs more triage before we widen exposure.
