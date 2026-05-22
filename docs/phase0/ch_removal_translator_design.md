# Phase 0 — ID namespace translator design for Card Hedge removal

**Captured:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope:** Read-only investigation + design. No code shipped. No translator implementation.
**Time budget:** 60–90 min.

**Headline — recommendation reframes the problem.** A direct cardHedgeCardId → Cardsight cardId translator is **not the right architecture** because (a) the existing `resolveCardId` function in `backend/src/services/compiq/cardsight.mapper.ts:73` already maps **structured attributes** (`playerName`, `cardYear`, `product`, `parallel`) to Cardsight cardIds, and (b) the `/api/compiq/price-by-id` request body already includes a `query` field alongside `cardHedgeCardId` — so the structured attributes are recoverable per-request via the existing `parseCardQuery` parser. **The fix is a routing change, not a new translator:** rewire `compiqEstimate.service.ts`'s `getCardSalesRouted(cardHedgeCardId, ...)` call to use `findCompsRouted(query, opts)` instead, which already goes through `resolveCardId` → `getPricing`. This is **a single-PR backend change**, not a translator-build workstream. The cardHedgeCardId becomes a cache key (which it already is) instead of a fetch key.

## 1. ID surface inventory

### Sample of cardHedgeCardId values from comp_logs (distinct)

Only 6 distinct values in the comp_logs container (last 444 rows lifetime). Plus an earlier Phase 0 doc (`docs/phase0/cardsight_coverage_2026-05-21_sources.md`) captured 12 distinct cardIds in the 30-day Axis 2 cohort from App Insights warn-line traces. Union of both sets is bounded at ~15 known production cardIds, with two namespaces:

- **Bubble.io-style:** `\d{13}x\d{18}` (e.g. `1769294194944x719861363807160400`, `1586812246197x228181943611293700`) — 13 of 15 observed
- **UUID:** `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (e.g. `496a7e19-b26d-4f48-9fae-e66d6961c27a`, `fc2abed8-650b-46f6-a122-8ba2773a31cf`) — 2 of 15 observed

Both namespaces are **opaque external identifiers** assigned by Card Hedge. No internal structure encodes player/year/set/parallel.

### Card Hedge blob inventory cardIds

The 6 active player blobs each carry a top-level `card_hedge_id` (representing the canonical card for that player's `_DEFAULT_PLAYERS` slot, e.g. Mike Trout 2011 Topps Update RC). These match the Bubble.io-style namespace.

### Test fixture cardIds

`backend/harness/tier1/baselines/case-*.json` carries `cardHedgeCardId` values for ~10 test cases. All Bubble.io-style. Used by the regression harness.

### Cardsight ID surface

`CardsightCatalogResult.id`, `CardsightCardDetail.id`, `CardsightParallel.id` are all `string` in the TypeScript interface. The Cardsight API returns these as opaque external identifiers (presumably their own internal catalog primary keys). No example values are present in the repo source — they'd need live API calls or production telemetry to sample.

### Is there a deterministic transformation between the two?

**No.** Both spaces are opaque external IDs assigned by independent systems (Card Hedge's Bubble.io app vs. Cardsight's catalog database). There is no algorithmic transformation — any mapping requires either (a) lookup, (b) re-resolution from underlying card attributes, or (c) capturing the join elsewhere.

## 2. Architectural reframe — `resolveCardId` already does the heavy lifting

**Critical finding from Step 1 investigation:** `backend/src/services/compiq/cardsight.mapper.ts` exports `resolveCardId(input: CompIQQueryInput): Promise<CardsightResolution>`, which is documented as **Phase 1 of migration per ADR-cardsight-migration-2026-05-18**. The function takes:

```ts
interface CompIQQueryInput {
  playerName: string;        // required
  cardYear?: string | number;
  product?: string;          // "topps chrome", "bowman draft chrome", etc.
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: string;
}
```

…and produces:

```ts
interface CardsightResolution {
  cardId: string | null;     // Cardsight cardId
  parallelId: string | null;
  matchConfidence: "exact" | "likely" | "none";
  warnings: string[];
}
```

Resolution strategy (per the function's docstring):
1. Build combined query: `{playerName} {cardsightReleaseName}` via internal `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary
2. Call `searchCatalog` with `year` + `segment=baseball`
3. Filter by `setName` pattern match
4. If parallel requested, call `getCardDetail` to resolve `parallelId`

This function is **already invoked** by `cardsight.router.ts:findCompsRouted` at line 151. So the path from "structured attributes" to "Cardsight cardId" exists and is wired into one router function. **What's missing is routing the `/price-by-id` request through this path instead of the cardId-keyed `getCardSalesRouted` path.**

### Why `/price-by-id` currently dead-paths

The `/api/compiq/price-by-id` handler (`backend/src/routes/compiq.routes.ts:778`) accepts `{cardHedgeCardId, query, gradeCompany, gradeValue}`. The handler builds a `CompIQEstimateRequest` and calls `computeEstimate(body)`. Inside `computeEstimate` (`compiqEstimate.service.ts:710`), the call is:

```ts
const sales = await getCardSalesRouted(pinnedCardId, grade, 25, { cardIdSource: "cardhedge" });
```

Under `CARDSIGHT_MODE=exclusive` with `cardIdSource: "cardhedge"`, the router returns `[]` (per `cardsight.router.ts:388`). **The text `query` field — which contains the structured attribute information — is sent by iOS but never used for sales resolution.**

### The iOS-side data is already sufficient

The `/price-by-id` handler accepts a `query` field per its signature:

```ts
const { cardHedgeCardId, query, gradeCompany, gradeValue } = req.body || {};
```

iOS sends this query whenever it pins a cardId for a refresh/lookup. The query is the text description (e.g., `"2024 Bowman Draft Chrome Gold Wave Auto Caleb Bonemer PSA 9"`). `parseCardQuery` (in `backend/src/services/compiq/cardQueryParser.ts`, used by `/api/compiq/price` route) already extracts structured attributes from such text:

```
{ playerName, year, brand, set, parallel, isAuto, isPatch, isRookie, printRun,
  cardNumber, grade, gradingCompany, confidence }
```

The mapping from `parseCardQuery`'s output to `resolveCardId`'s `CompIQQueryInput` is structurally trivial (rename `year` → `cardYear`, derive `product` from `brand` + `set`, pass-through `parallel`/`gradeCompany`/`gradeValue`).

## 3. Three mapping strategies — analysis

### Strategy A — Static lookup table in code/config

**Shape:** A constant `Map<cardHedgeCardId, CompIQQueryInput>` shipped in the codebase. For each known production cardHedgeCardId, hard-code the structured attributes.

**Estimated size:** ~15 known production cardIds today (per the Axis 2 cohort + comp_logs). Realistic bound: ~100–500 entries depending on how many cards the iOS app's full user base has historically pinned. Could be enumerated once via App Insights backfill or Cosmos comp_logs scan.

**Pros:** Deterministic, fast, zero runtime cost, easy to audit.
**Cons:** Snapshot in time. New cards pinned by iOS users after CH removal would not be in the table — they'd have to fall through to a runtime path anyway. Maintenance burden: someone has to update the table when new cards trend.

**Failure mode:** unknown cardHedgeCardId → table miss → must fall back to runtime resolution OR return empty.

**Build effort:** Low. Maybe 1 hour to gather all known cardIds + structured attributes (requires CH access while it still works), 1 hour to commit the table.

### Strategy B — Cosmos DB lookup table

**Shape:** A new Cosmos container `cardId_translations` partitioned by `cardHedgeCardId`. Stores the same `CompIQQueryInput` per cardId.

**Pros:** Queryable, upsertable, scales without code changes.
**Cons:** Another data store. Another auth path. Another container with its own provisioning, RU budget, monitoring. Workstream 2 already documented the COSMOS_KEY shared-defect risk in Python paths — adding another Cosmos dependency in Node has the AAD fallback but is still infra weight.

**Failure mode:** cache miss → fall back to runtime resolution.

**Build effort:** Medium. 2–4 hours: Cosmos container provisioning, repository code, upsert paths, integration with existing prediction flow.

### Strategy C — Runtime resolution via the text query iOS already sends

**Shape:** No translator data store at all. In `/price-by-id`'s `computeEstimate` call chain, replace the `getCardSalesRouted(cardHedgeCardId, ...)` call with `findCompsRouted(query, opts)` (already exists). `findCompsRouted` runs `parseCardQuery` (or its equivalent in the router's `toCardsightQuery` mapper) → `resolveCardId(structured)` → `getPricing(cardsightCardId)`.

**Pros:**
- **No new infrastructure.** No lookup table to populate, no Cosmos container to provision.
- **No maintenance burden.** New cards work automatically.
- **Leverages existing code.** `resolveCardId` already implemented and tested; `findCompsRouted` already wired.
- **Cardsight catalog coverage is naturally inherited:** if Cardsight has the card, the system serves it.
- **cardHedgeCardId continues to serve as the cache key** (it already is at compiq.routes.ts:786) — predictions cache correctly under existing Redis TTL.

**Cons:**
- **One extra Cardsight API call per cache miss** (`searchCatalog` inside `resolveCardId`). Adds ~9 s p50 latency per earlier W6.1b finding (Cardsight `searchCatalog` is the slow leg).
- **Failure modes** if `query` text is missing or ambiguous: `resolveCardId` returns `cardId: null` → no comps → degraded prediction.
- **iOS dependency:** assumes the iOS app always sends `query` alongside `cardHedgeCardId`. Need to verify (see open questions below).

**Failure mode:** missing/bad query → resolveCardId returns null → empty comps. SAME outcome as today's dead-path.

**Build effort:** **SMALL.** Single-PR change in `compiqEstimate.service.ts:710` area to switch routing. Estimated 2–3 hours for: code change + tests + deploy + verification.

## 3.5 Coverage analysis

Of the 6 cardIds in comp_logs:
- All 6 have `query` text recorded (per Workstream 3's Check 2 sampling, all 200 rows have non-empty `query` field).
- Query strings observed are well-formed structured descriptions (e.g., `"2024 Bowman Draft Chrome Blue Auto Caleb Bonemer"`, `"2025 Bowman Draft Chrome Gold Auto Gage Wood PSA 9"`).
- `parseCardQuery` (already used by `/api/compiq/price`) handles these query shapes successfully — that's what builds the parsed-query output captured in the price response.

Of the 12 cardIds in the Axis 2 cohort (`cardsight_coverage_2026-05-21_sources.md`):
- All are listed with sample queries by the doc.
- All look parseable (per the doc's queries column).

**Cardsight catalog coverage for these queries:** the earlier W6.1b smell test ran 4 queries against `searchCatalog`; 4 of 4 valid queries returned results. The 1 "failed" query (Roman Anthony 2024 Bowman Chrome Prospects Auto) was an invalid card spec, not a catalog gap. **No category of card has been observed to fail catalog lookup.** Per the doc's caveat, this is a small sample — coverage at scale is unverified.

### Categories likely to fail Cardsight resolution

Per the prior coverage doc and known Cardsight behaviors:
- Cards Cardsight's catalog hasn't ingested yet (very new releases, obscure niche products)
- Cards where the parser misclassifies set/parallel (variant string ambiguity)
- Non-baseball cards (Cardsight is queried with `segment=baseball` in `resolveCardId`)

For these, Strategy C returns empty comps — **same as the current production behavior under `exclusive` mode.** Not worse; potentially better if Cardsight does have the card.

## 4. Recommendation

**Strategy C — Runtime resolution via existing text query.**

### Reasoning

1. **The architectural piece is already done.** `resolveCardId` exists, tested, in production, called by `findCompsRouted`. The only gap is which router function `/price-by-id` calls.
2. **No new data store.** No translation table, no Cosmos container, no maintenance burden. The cardHedgeCardId is reframed as a cache key (its current effective role) instead of a fetch key.
3. **Lowest build cost** (~3 hours focused session vs. days for a backfilled lookup table).
4. **No CH dependency to capture before removal.** The Strategy A/B "capture mappings before CH dies" framing is unnecessary because mapping happens per-request from text the iOS app already sends.
5. **Failure modes are no worse than current production.** Empty comps for un-resolvable queries match today's empty-array dead-path behavior.

### Where the change lives

- **Modify:** `backend/src/services/compiq/compiqEstimate.service.ts` lines ~700–752 (the `fetchComps` function block, especially line 710 where `getCardSalesRouted` is currently called). Replace the cardId-based call with a query-based `findCompsRouted` call.
- **Inputs:** the `query` field from `/price-by-id` body (already passed through).
- **Possibly modify:** `backend/src/routes/compiq.routes.ts:778-783` to ensure `query` is required (not just optional). Today it's optional and falls back to `cardHedgeCardId` as the playerName (line 791) — that path produces garbage and should be eliminated.
- **No changes:** `cardsight.router.ts`, `cardsight.mapper.ts`, `cardsight.client.ts` (all already capable). MCP server (`compsLoader.ts`) is a SEPARATE concern (covered in cardsight_sold_comp_capability.md) and not part of this translator design.

### Fallback behavior

When `resolveCardId` returns `cardId: null` (no catalog match):
- Return empty comps array
- Log a structured warning with the query + reason (`catalog_zero_results`, `release_name_filter`, etc. — already emitted by `resolveCardId`)
- Prediction proceeds with `no_recent_comps` outcome, same as current

When the request omits `query`:
- Two options: (a) return 400 with an explicit error (forces iOS to update), or (b) attempt resolution from `cardHedgeCardId` alone via a lookup-table fallback (Strategy A/B as a tiny secondary path for legacy clients).
- Recommendation: (a) for the primary build. iOS already sends `query` per the API contract; making it required is a one-line change with a clear error response. A Strategy-A fallback can be added later if telemetry shows missing-`query` requests in the wild.

### Build plan

| Step | Effort | Notes |
|---|---|---|
| 1. Make `query` required in `/price-by-id` handler (with 400 error otherwise) | 15 min | One-line change + return statement |
| 2. Modify `computeEstimate.service.ts` `fetchComps` path to route via `findCompsRouted(query, opts)` when `cardIdSource === "cardhedge"` | 1 h | Includes mapping `parseCardQuery` output to `CompIQQueryInput`, threading through `parallel` + `gradeCompany`/`gradeValue` |
| 3. Update `cardsight.router.ts` `exclusive`-mode behavior if needed so the new path isn't itself dead-branched | 30 min | May not be needed if findCompsRouted already works under exclusive |
| 4. Add unit/integration tests covering: known good query → comps, unknown query → empty comps, missing query → 400 | 45 min | |
| 5. Deploy to `hobbyiq3` and verify via known-good live request | 30 min | |
| 6. Watch comp_logs for outcome shift (no_recent_comps → ok rate increase) | passive | Day-1 observation |

**Total estimated effort: 2.5–3 hours focused session for steps 1–5. Step 6 is passive monitoring.**

This can be **built in one focused session.**

### Deploy + verification effort

Standard backend deploy via `scripts/deploy-with-build-info.ps1`. Verification: call `/api/compiq/price-by-id` with a known cardHedgeCardId + query, confirm response has non-empty `recentComps` and `predictedPrice > 0`. Confirm via `comp_logs` row inspection that the new path produces `outcome: ok` rather than `no_recent_comps`.

## 5. Open questions / risks

1. **Does iOS always send `query` with `cardHedgeCardId`?** The handler treats it as optional. Verifying this against actual iOS code (HobbyIQ/CompIQ*.swift) would confirm. If iOS sometimes sends only the cardId (e.g., on price-refresh without re-search), the proposed required-query change breaks those callsites. **Risk: medium.** Mitigation: phase-in with a fallback before requiring.

2. **Cardsight `searchCatalog` latency on every cache miss.** W6.1b observed p50 ~9–10s, occasionally 12s+. With current 15-min cacheWrap TTL, repeated queries are cheap; first-time/expired-cache queries pay the full latency. **Risk: medium.** Mitigation: extend the cacheWrap TTL for `/price-by-id`'s response (currently 15 min); or pre-cache popular cardIds via a backfill warmup.

3. **`resolveCardId` confidence levels are "exact" or "likely" or "none".** "Likely" means more than one catalog candidate matched — the function returns the top-ranked. The implementation includes a warning, but the routing logic discards it before reaching the user. **Risk: low for ship; medium for measurement.** Mitigation: surface the resolution confidence in the response payload so iOS can disclaim or downgrade displayed confidence.

4. **MCP server's `compsLoader.fetchPlayerComps` still reads the CH blob.** This translator design fixes the BACKEND `/price-by-id` path. The MCP server's `/predict` endpoint (called from where? `mcp-server/server.ts:223` per Workstream 3) is a separate path with its own consumer chain. Removing Card Hedge fully requires also rewiring `compsLoader` to call backend's Cardsight-served endpoint OR to call Cardsight directly. **Risk: high if missed.** Mitigation: explicit phase-2 workstream after this translator ships.

5. **Cardsight catalog coverage at scale.** 4-of-4 smell test is encouraging; full-population behavior unverified. **Risk: medium.** Mitigation: ship behind a feature flag with shadow-mode comparison (write both paths' results to comp_logs for a week before flipping).

6. **`compiq-mcp` has no App Insights wiring** (W3 finding). If the translator change affects MCP-side behavior — even indirectly — degradation could be invisible. **Risk: medium.** Mitigation: wire MCP App Insights before or alongside this change.

## 6. Reframing the workstream

The original framing was "design an ID namespace translator." The actual conclusion is **no new translator is needed.** The existing `resolveCardId` plus the existing `findCompsRouted` plus the existing iOS-sent `query` field cover the requirement. The work item is a **routing change** in one backend file (~2.5–3 hours), not a separate translator service.

Strategies A and B remain available as fallback mechanisms for missing-query requests if telemetry warrants. They are NOT recommended as the primary path.

## Anti-drift note

This document characterizes the design space and recommends Strategy C. It does NOT implement the routing change, modify `/price-by-id`, update `computeEstimate.service.ts`, or wire any new path. All of that is the build-session work that follows from this design.
