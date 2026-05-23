# MCP /predict rewire design — architectural mismatch resolution

**Date:** 2026-05-26
**Status:** Design only. Implementation is a separate subsequent workstream.
**Sources read:** `mcp-server/{compsLoader,server,pricing,backtest}.ts`, `backend/src/services/compiq/cardsight.router.ts`, `backend/src/routes/compiq.routes.ts`, `compiq-functions/fn-backtest-runner/__init__.py`, `docs/phase0/ch_removal_v2_plan.md`, current SESSION_HANDOFF.

## 1. Current state

### mcp-server side

**`compsLoader.ts` (90 LOC, single function `fetchPlayerComps`):**
Reads `compiq-signals/{playerSlug}/cardhedge.json` from Azure Blob Storage. The blob is written nightly by `fn-cardhedge-comps`. Returns `CardComp[]` projected from the blob's `raw_sales[]`. Each `CardComp` = `{ price: number, date: string, grade: string, source?: string, title?: string }`. Single fetch per player; returns ~27 comps spanning ALL cards the player has appeared on (including non-target reprints, wrong-year listings, etc.). No card-level identity in the returned shape — just title strings.

**`server.ts /api/compiq/predict` handler (lines 228-300):**
1. Validates body: `playerName`, `year`, `set`, `cardNumber` required.
2. If `body.recentComps` provided inline: use those. Else: `fetchPlayerComps(playerName, grade)`.
3. `filterCompsForCard(comps, playerName, year, setName)` — narrows player-level comps to card-level via title-token heuristics (year match + surname match + setName tokens + reprint/custom/shoebox blacklist). Falls back to unfiltered set when filtered < 5 OR < 30% of original.
4. Compute anchor price (caller > comp median).
5. Call `getPredictedPrice(card)` (pricing.ts).

**`pricing.ts` (~720 LOC):**
Consumes `card.recentComps: CardComp[]` for the SPECIFIC card (post-filter). Heavy use of `.title`, `.date`, `.price`, `.grade` fields. Key consumption points:
- Line 168: `card.recentComps.filter(c => last 30 days)` — H10 comp volume gating
- Line 328: `compsLast30` aggregation for analytics
- Line 383: `compsBlock` for OpenAI prompt context (top-N comps inlined into prompt)
- Line 662: `computeCompsAnalytics(card.recentComps)` — feeds the analytics block into the prompt

**Pricing.ts operates on already-filtered card-level comps.** The mismatch is isolated to compsLoader.ts; pricing.ts doesn't need to change.

**`backtest.ts` (lines 225-284):**
Groups predictions by player, then calls `fetchPlayerComps(player)` ONCE per player. Iterates each prediction within that player's pool: filters comps by post-prediction time window, computes scoring. The player-level batching is an optimization, not a structural requirement — predictions log `cardId` (per `predictionLog.ts`), so backtest could batch by cardId instead with similar efficiency if predictions per cardId are sufficiently dense.

### backend side

**`cardsight.router.ts findCompsRouted` (signature):**
`(query: string, opts: FindCompsRoutedOptions) => Promise<{ card, sales, variantWarning, aiCategory }>`. Returns CARD-LEVEL data: one card identity + that card's sales array. Under `CARDSIGHT_MODE=exclusive`, delegates to `findCompsViaCardsight` which calls `resolveCardId(toCardsightQuery(query, opts))` → `getPricing(cardId, {parallelId})` → `translateResponse`. Phase 2 v2 + defect #2/#5 fixes already in place.

**Existing routes that wrap this:**
- `POST /api/compiq/price` — accepts free-text query, calls `parseCardQuery` upstream, returns full estimate
- `POST /api/compiq/price-by-id` — accepts `cardHedgeCardId + query` (post-Phase-2: routes through Cardsight via meaningful-query fall-through if query is non-trivial)
- `POST /api/compiq/estimate` — accepts structured body (playerName, cardYear, product, parallel, grade)
- `POST /api/compiq/search-list` — **STILL USES CARD HEDGE searchCards** (not Cardsight). The catalog-enumeration path on iOS is currently CH-gated; Cardsight has `searchCatalog` as the analog but it's not wired to /search-list.

### fn-backtest-runner

Thin proxy: timer-triggered Azure Function that POSTs to `${COMPIQ_MCP_URL}/api/compiq/admin/backtest/run` with admin-key auth. Doesn't carry data identity itself; the backtest logic lives in mcp-server/backtest.ts.

### Production traffic patterns

Per yesterday's compiq-mcp App Insights wiring (PR #118, b959dc3) + this session's check: zero `/predict` traffic in the last hour. iOS organic traffic is low pre-launch; backtest runs nightly. The rewire's failure surface in production is currently small, but the dependency on fn-cardhedge-comps writing blobs nightly is fragile — when CH access dies or fn-cardhedge-comps is decommissioned, MCP loses its data source entirely.

## 2. The architectural mismatch

**Concretely:**

```
CH blob shape (player-level)        Cardsight pricing response (card-level)
-----------------------------       --------------------------------------
{ player: "Mike Trout",             { card: { id, name, releaseName, ... },
  raw_sales: [                        raw: { count, records: [...] },
    { price, date, title, ... },      graded: [ { company, grades: [...] } ],
    { price, date, title, ... },      meta: { total_records, last_sale_date } }
    ... ~27 entries
  ] }
```

**Where the mismatch lives:**
- MCP queries `fetchPlayerComps(playerName)` once → expects player-level pool. Card-level Cardsight returns per-card.
- pricing.ts inside MCP already operates on card-level (post-filterCompsForCard). So once the player→card narrowing is done upstream of pricing.ts, pricing.ts is unaffected.
- backtest.ts uses player-level batching as an optimization. Card-level switch would require batching by cardId instead — feasible but a structural change.

**What breaks under card-level (Option A or C):**
- Backtest's "fetch once per player" optimization becomes "fetch once per cardId × N predictions." For a player with 20 predictions across 5 unique cards, that's 5 fetches instead of 1.
- /predict's "load comps + filter to card" becomes "load card directly" — slightly cleaner but requires enumerating cards upstream (player → cards) before pricing.

**What doesn't break:** pricing.ts (already card-level), CompComp shape (already card-agnostic at the type level), filterCompsForCard (becomes a no-op or post-filter rather than a primary narrowing step).

## 3. Three architectural options

### Option A — MCP calls backend per card

**Mechanism:**
1. MCP's `compsLoader.fetchPlayerComps(playerName)` replaced with:
   - Enumerate cards for player: call backend `/search-list` (gated on CH) OR Cardsight `searchCatalog` direct
   - For each card: call backend `/price-by-id` (which routes through Cardsight under exclusive mode)
   - Aggregate sales arrays from each card into a single `CardComp[]`
2. Card identity now flows MCP-side; backtest must change to per-prediction calls

**Implementation effort:** ~150-200 LOC in mcp-server. New backend dep: none new (reuses existing /price-by-id). Aggregation logic + parallel fanout + error tolerance.

**Blast radius:** MCP only. Backend unchanged.

**Data shape implications:** Same `CardComp[]` going into pricing.ts. The journey to get there changes.

**Backtest implications:** Substantial. backtest.ts currently groups by player; would need to group by cardId (which is available in predictionLog). Loses player-level batching savings; in the worst case backtest grows from "1 fetch per player × N players" to "1 fetch per prediction × N predictions" if predictions are sparse per cardId.

**Latency profile:** Cold path: 1 enumerate call + N × `/price-by-id` calls (parallel-fannable, but each is 2-9s p50 cold per Phase 2 measurements). N = catalog size for the player; can be 5-16 cards for top players. p95 cold can hit 20-30s.

**Failure modes:** Each card fetch can fail independently. Need explicit partial-data tolerance. Cardsight rate limit can cascade across the fanout (per defect #13 v2 finding).

### Option B — Backend grows player-level endpoint

**Mechanism:**
1. New backend endpoint `POST /api/compiq/comps-by-player`:
   - Input: `{ playerName, cardYear?, product?, parallel?, grade? }`
   - Implementation: `searchCatalog(playerName, {year: cardYear})` to enumerate Cardsight cards → for top-K candidates fetch `getPricing` in parallel (bounded by `MAX_PRICING_PROBES=8`, reusing Phase 2 v2's cap) → aggregate `translateResponse` outputs into a flat `CardComp[]` with cardId attached → return `{ comps, cardCount, cardIds, source: "cardsight" }`
   - LRU-cached per `playerName|year|product` key (reuses resolveCardId-style caching pattern)
2. MCP's `compsLoader.fetchPlayerComps` becomes a single HTTP call to backend's new endpoint, return type unchanged

**Implementation effort:** ~80-120 LOC in backend (new route + aggregation service) + ~15 LOC in MCP (compsLoader rewrite). Test additions on both sides.

**Blast radius:** Backend grows one endpoint. MCP changes one file. Touches the same Cardsight integration the backend already has.

**Data shape implications:** Same `CardComp[]` going into pricing.ts. compsLoader's external contract preserved.

**Backtest implications:** **Zero changes to backtest.ts.** Still calls `fetchPlayerComps(player)`. Player-level batching preserved.

**Latency profile:** Cold path: 1 backend call. Backend internally does 1 searchCatalog + N × getPricing (parallel, bounded by MAX_PRICING_PROBES). Backend's existing LRU cache absorbs warm calls. For warmed players, sub-second. For cold players, ~3-9s (bounded by cap × per-call latency).

**Failure modes:** Backend handles partial-data tolerance. If 6 of 8 cards return empty pricing, backend returns the 2 with data + a partial-data warning. MCP sees `comps + cardCount` and can reason about confidence. Cardsight rate limit isolated to backend; MCP doesn't see it directly.

### Option C — MCP gets its own Cardsight client

**Mechanism:**
1. Port `cardsight.router.ts`, `cardsight.mapper.ts`, `cardsight.client.ts`, `cardsight.translator.ts` from backend to mcp-server
2. MCP's compsLoader uses the ported Cardsight client directly
3. Backend's Cardsight integration unchanged
4. Two systems integrate with Cardsight independently

**Implementation effort:** ~400-600 LOC ported to mcp-server (the entire backend cardsight integration tree). Plus mcp-server-specific test additions. Plus dual-maintenance going forward.

**Blast radius:** mcp-server grows substantially. Backend unchanged.

**Data shape implications:** MCP becomes the aggregator for player-level comps; logic identical to Option B but lives in MCP.

**Backtest implications:** Zero changes if Cardsight client matches the player-aggregation pattern in MCP. Backtest still calls `fetchPlayerComps(player)`.

**Latency profile:** Same as Option B's internal latency — MCP does the work instead of backend. Saves one HTTP hop (~10-50ms) compared to Option B.

**Failure modes:** Same as Option B but the responsibility lives in MCP.

**Tech debt:** Two services integrate with Cardsight. Every Cardsight change (new dict entries, defect fixes, cap tuning) requires updates in TWO places. This is the same integration mistake that originally produced the CH-everywhere problem.

## 4. Recommendation: Option B

**Rewire MCP's `fetchPlayerComps` to call a new backend endpoint `/api/compiq/comps-by-player`.** Backend owns the Cardsight aggregation; MCP becomes a thin client.

### Reasoning

**Single integration point with Cardsight.** Option C duplicates the entire Cardsight integration tree (router + mapper + client + translator) into MCP. Every future Cardsight change — new dictionary entries, defect fixes (#10, #12, #13), cap tuning, error-handling refinements — would need to land in both places. This is the architectural debt that produced the original CH-everywhere mess. **Option B keeps a single integration surface.**

**MCP stays simple.** compsLoader becomes a single HTTP call (~15 LOC). pricing.ts unchanged. server.ts /predict handler unchanged. The cognitive footprint of MCP shrinks rather than grows.

**Backtest preserved.** backtest.ts still calls `fetchPlayerComps(player)` with no change to its call shape. Player-level batching optimization preserved. The "current state Phase C nightly backtest" workflow keeps working unchanged.

**Reuses existing infrastructure.** Backend already has:
- `cardsight.router` with the routing modes (off/shadow/primary/exclusive)
- `cardsight.mapper` with Phase 2 v2's defect-fix layers (resolveCardId selection, MAX_PRICING_PROBES=8, sorted-array parallelMatches, Bowman Chrome dispatch, dispatch fallback)
- LRU cache with warming for `resolveCardId`
- Defect #13 v2's serialized warming
- App Insights instrumentation

Option B inherits all of this. Option C would have to port-or-rebuild it.

**iOS unaffected.** iOS doesn't call MCP for /predict directly; it calls backend's /price /price-by-id /estimate. The rewire is invisible to iOS.

**Decommissioning fn-cardhedge-comps becomes possible.** Once Option B ships and is observably stable for ~7-14 days, fn-cardhedge-comps (the nightly Card Hedge blob writer) can be decommissioned. The blob storage container (`compiq-signals/*/cardhedge.json`) becomes unused and can be cleaned up in a separate workstream.

**Failure isolation.** Cardsight rate-limit issues (defect #13 family) stay contained to backend. MCP gets a clean `comps` array or a documented partial-data signal; doesn't have to reason about Cardsight's internal state.

### Why not Option A

Backtest implications are significant. The current "fetch once per player, score N predictions against that pool" pattern is a real efficiency win for backtest. Option A forces card-level fetches which scale with prediction count rather than player count. For a backtest cycle that scores 200 predictions across 30 players (current `fn-backtest-runner` limit), Option A multiplies fetch volume by ~3-7×.

Option A's primary upside is "MCP doesn't need a new backend endpoint." That's a small win against Option B's wider footprint — but Option B's footprint reuses code that already exists.

### Why not Option C

The dual-integration tax over time is real and compounds. Already in Phase 2 we shipped 5+ defect fixes in the Cardsight integration; the pattern is "Cardsight integration needs ongoing care." Maintaining two copies of that integration in two services is a maintenance burden we have evidence we'll regret.

### Maintenance debt comparison

| Option | Integrations with Cardsight | Code surfaces to maintain | Likely future Cardsight defect-fix cost |
|---|---|---|---|
| A | 1 (backend) | 1 | 1× |
| **B** | **1 (backend)** | **1** | **1×** |
| C | 2 (backend + MCP) | 2 | 2× per defect |

## 5. Implementation phasing

Two phases. Acceptance gate between them.

### Phase 1 — Backend grows `/api/compiq/comps-by-player`

**What ships:**
- New file `backend/src/services/compiq/compsByPlayer.service.ts` with `fetchPlayerComps(playerName, opts) => CompsByPlayerResponse`
- Internal implementation:
  1. Call `searchCatalog(playerName, { year: opts.cardYear, take: 25 })`
  2. Filter candidates by releaseName when `opts.product` provided (reuse `COMPIQ_TO_CARDSIGHT_RELEASES` dict)
  3. For top-K candidates (K=MAX_PRICING_PROBES=8), fetch `getPricing` in parallel
  4. Aggregate via `translateResponse` per card, flatten into single `comps[]` with cardId attached to each entry
  5. Return `{ comps: CardComp[], cardCount, cardIds: string[], source: "cardsight", warnings: string[] }`
- New route `backend/src/routes/compiq.routes.ts:POST /api/compiq/comps-by-player`
- LRU cache keyed on `playerName|year|product|grade` (reuse cache.service pattern)
- Unit tests covering: single-candidate, multi-candidate aggregation, partial-data (some cards 0 records), Cardsight error tolerance
- No MCP-side changes in Phase 1

**Acceptance gate:**
- Backend tests green
- `curl POST /api/compiq/comps-by-player {playerName:"Mike Trout"}` against deployed backend returns non-empty comps + valid cardIds
- Test against the 5 demo players (Trout, Ohtani, Judge, Witt, Bonemer): each returns comps; comp count comparable to or better than what CH blob has (Bonemer: 4 comps current; Trout: 15 comps current — within order of magnitude)
- Backend latency for cold call: p95 < 15s
- App Insights confirms the new dependency call pattern (1 searchCatalog + ≤8 getPricing per request)

**Smoke verification:** Existing Phase 2 v2 19/19 smoke continues to pass (no regression on /price /price-by-id /estimate). The new endpoint is additive.

### Phase 2 — MCP's compsLoader points at the new endpoint

**What ships:**
- `mcp-server/compsLoader.ts` rewritten: HTTP call to backend's `/api/compiq/comps-by-player` instead of blob read
- `mcp-server/.env.example` (or equivalent docs) — add `COMPIQ_BACKEND_URL` env var requirement
- compiq-mcp App Service config: set `COMPIQ_BACKEND_URL=https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net`
- MCP-side test: mock backend response, confirm compsLoader returns expected CardComp[]
- No changes to pricing.ts, server.ts, backtest.ts

**Acceptance gate:**
- MCP tests green
- `curl POST {compiq-mcp}/api/compiq/predict {...Mike Trout...}` returns valid prediction (compares to a baseline taken before the rewire)
- 3 demo cards (Trout, Ohtani, Witt) prediction round-trip works end-to-end
- Backtest dry-run via `/api/compiq/admin/backtest/run` produces output (sanity check, not full backtest cycle)
- compiq-mcp App Insights shows dependency on backend (`hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net`) replacing the prior blob dependency

**Smoke verification:** 3 demo cards via `/api/compiq/predict` return predictions consistent with pre-rewire behavior (compRange + sampleSize within ±20%).

### Phase 3 (separate workstream) — fn-cardhedge-comps decommission

Out of scope for this rewire. After Phase 2 ships and is observably stable for ≥7 days, schedule a follow-up workstream to:
- Disable fn-cardhedge-comps timer trigger
- Verify MCP /predict continues to function without nightly blob writes
- Clean up `compiq-signals/*/cardhedge.json` blob container
- Remove CH searchCards dependency from backend (`/search-list` route — likely needs Cardsight searchCatalog wiring as a parallel sub-workstream)

Not in scope for this design.

## 6. Backtest runner specifically

**Backtest under Option B: no changes required.**

`fn-backtest-runner` (the Azure Function) is unchanged — still POSTs to MCP's `/api/compiq/admin/backtest/run`. `mcp-server/backtest.ts` is unchanged — still groups predictions by player and calls `fetchPlayerComps(player)` once per player. The difference: under Phase 2 of the rewire, that `fetchPlayerComps(player)` call goes via HTTP to backend's new endpoint instead of blob read.

**Player-level batching optimization preserved.** Backtest's "fetch once, score N predictions" pattern is unaffected by the rewire.

**Pre-existing limitation (orthogonal to this rewire):** Backtest's accuracy depends on comp data continuing to flow into the system. Under fn-cardhedge-comps it was nightly blob writes; under the rewire it's live Cardsight calls. If Cardsight doesn't have a card's recent sales (which can happen for prospect cards, niche releases, etc.), backtest can't score predictions for those cards. This is a data-coverage issue, not a rewire issue.

**Carry-forward from prior sessions:** Backtest is currently "broken/limited" per the rollback session's Fix I+ deferral. This rewire doesn't fix that; it preserves the current call shape so whatever limitations exist today persist post-rewire. A backtest-quality workstream is a separate concern.

## 7. Acceptance criteria

### Phase 1 acceptance

- [ ] Backend test suite green (no regression on existing 799/799 baseline; new tests for compsByPlayer service pass)
- [ ] `tsc --noEmit` clean
- [ ] `POST /api/compiq/comps-by-player {playerName:"Mike Trout"}` returns valid `CompsByPlayerResponse` against deployed backend (post-merge, post-deploy)
- [ ] 5 demo players (Trout, Ohtani, Judge, Witt, Bonemer): each returns non-empty `comps[]`; `cardCount >= 1` for each
- [ ] LRU cache hit rate observable in App Insights (`compsByPlayer_cache_stats` event, modeled after existing `resolveCardId_cache_stats`)
- [ ] Existing Phase 2 v2 19/19 smoke continues to pass (no regression on /price /price-by-id /estimate)

### Phase 2 acceptance

- [ ] MCP test suite green
- [ ] `POST {compiq-mcp}/api/compiq/predict` returns valid prediction for 3 demo cards (Trout, Ohtani, Witt) end-to-end
- [ ] compiq-mcp App Insights shows dependency on backend (hobbyiq3 host) replacing the prior blob dependency
- [ ] Backtest dry-run via `/api/compiq/admin/backtest/run` (limit=10) produces non-empty output
- [ ] Latency: MCP /predict p95 within 1.5× of pre-rewire baseline (gives some headroom for the additional HTTP hop)

### Ship gate

Both phases pass acceptance independently. If Phase 1 fails or surfaces a fourth defect, HALT — don't ship Phase 2 against a broken Phase 1.

## 8. Risks and open questions

### Card-set selection for player aggregation

**Question:** When backend enumerates cards for "Mike Trout," Cardsight's `searchCatalog("Mike Trout")` could return dozens of cards across all years/releases. Do we aggregate ALL of them, or filter to recent/popular/demo-relevant?

**Risk:** If we aggregate all Trout cards, the comp pool gets contaminated with 1989 Topps Trout (doesn't exist but illustrates the point), prospect cards, obscure parallels. pricing.ts's `filterCompsForCard` would then have to do MORE filtering, not less.

**Proposed handling:** Phase 1 implementation uses `searchCatalog(playerName, {year: opts.cardYear, take: 25})` with year filter — narrows to a single year's worth of cards. If `opts.cardYear` is missing, default to "no year filter" and return up to 25 candidates (matching Cardsight's `take` default). Filtering by `opts.product` (releaseName) further narrows. MCP's caller (pricing.ts → filterCompsForCard) handles the final card-specific narrowing.

This is consistent with how /price + /price-by-id + /estimate handle the same problem today.

### Backend endpoint can't be reused as designed

**Question:** What if `/api/compiq/comps-by-player` clashes with existing routing patterns or naming?

**Risk:** Low. Backend's `compiq.routes.ts` has clear naming conventions (price, price-by-id, estimate, search-list, parse). `comps-by-player` slots in without conflict.

### pricing.ts depends on data shape details the rewire changes

**Question:** Does pricing.ts read any field that the rewire might inadvertently strip or change?

**Risk:** Low. CardComp shape is preserved end-to-end (`price, date, grade, source, title`). The only new field added is `cardId` (optional) — additive, doesn't break existing consumers.

**Verification:** Phase 2 acceptance includes "3 demo cards prediction round-trip works end-to-end" — covers the shape compatibility.

### Performance under load

**Question:** Does Option B introduce latency under iOS-organic load?

**Risk:** Medium. MCP's /predict adds one HTTP hop to backend per cold call. Warm calls (LRU-cached on backend) are sub-second. For iOS pre-launch volume, this is fine. Post-launch volumes haven't been characterized.

**Verification:** Phase 2 acceptance includes "latency p95 within 1.5× of pre-rewire baseline." If that fails, mitigation = LRU cache TTL tuning on backend or MCP-side request memoization.

### LRU cache + warming

**Question:** Phase 1's resolveCardId LRU cache + warming (defects #10/#13 v2) — does it serve the new pattern?

**Risk:** Low. compsByPlayer caches at a coarser grain (player+year+product+grade) than resolveCardId (player+year+product+parallel+cardNumber+grade+gradeValue). They cache at different layers and don't conflict. Both can be active simultaneously.

**Optional optimization:** Warm the compsByPlayer cache for the 10 CACHE_WARM_TARGETS players at startup, analogous to how resolveCardId is warmed today. Phase 1 should include this for symmetry. Cost: ~5 LOC.

### Cosmos `success=False` GET / calls + IMDS failures from compiq-mcp telemetry

**Question:** Do the success=False patterns observed in yesterday's compiq-mcp App Insights wiring relate to this rewire?

**Risk:** Low. Both are pre-existing DefaultAzureCredential / managed-identity patterns surfaced by the new instrumentation. They were happening before; we just see them now. Not related to /predict's data flow; related to predictionLog Cosmos writes + token-fetch attempts.

**Disposition:** Out of scope. Investigate as a separate observability follow-up after the rewire ships.

## 9. What this design does NOT do

- **Doesn't decommission `fn-cardhedge-comps`.** Separate workstream, gated on rewire stability + a parallel decision on /search-list's CH dependency.
- **Doesn't migrate the `cardHedgeCardId` schema field.** Cosmetic cleanup; out of scope.
- **Doesn't change LRU cache topology.** Compatible with existing cache; doesn't require new warming logic beyond an optional ~5 LOC add.
- **Doesn't redesign pricing.ts logic.** pricing.ts stays exactly as today.
- **Doesn't ship code.** This workstream is design only.
- **Doesn't fix the Cosmos `success=False` + IMDS observability patterns.** Surfaced incidentally; out of scope.
- **Doesn't address the "playerName cross-partition query" deferred Cosmos fix.** That waits for DailyIQ traffic to resume.
- **Doesn't reconcile `/search-list`'s CH dependency.** /search-list still uses CH searchCards; that's a separate workstream when fn-cardhedge-comps decommission is in scope.

## 10. Implementer checklist for next session

**Phase 1: backend `/api/compiq/comps-by-player` (estimated 90-120 min)**

1. Branch from main: `git checkout -b feat/comps-by-player-backend`
2. Read these files first to ground implementation:
   - `backend/src/services/compiq/cardsight.router.ts` (resolveCardId / findCompsRouted)
   - `backend/src/services/compiq/cardsight.mapper.ts` (MAX_PRICING_PROBES, resolveCardId)
   - `backend/src/services/compiq/cardsight.translator.ts` (translateResponse)
   - `backend/src/services/compiq/cardhedge.client.ts` (for the CardHedgeSale type, since CardComp's source shape needs alignment)
   - `backend/src/routes/compiq.routes.ts` (existing route patterns for layout)
3. Create `backend/src/services/compiq/compsByPlayer.service.ts`:
   - Export type `CompsByPlayerResponse = { comps: CardComp[], cardCount, cardIds, source, warnings }`
   - Export `fetchCompsByPlayer(playerName, opts)` function
   - Implementation: searchCatalog → release filter → pricing-probe fanout → translateResponse aggregation
   - Use existing `cardsight.client` exports
4. Add to `backend/src/routes/compiq.routes.ts`: `POST /api/compiq/comps-by-player` handler
   - Body validation: `playerName` required; `cardYear, product, parallel, grade` optional
   - Call `fetchCompsByPlayer` + wrap with `cacheWrap`
5. Add tests in `backend/tests/`:
   - `compsByPlayer.service.test.ts`: unit tests with mocked cardsight.client (single-candidate, multi-candidate aggregation, partial-data, Cardsight error tolerance)
   - Extend `compiq.routes` integration test (if exists) with happy-path /comps-by-player call
6. Optional Phase 1: add `Mike Trout`, `Shohei Ohtani`, etc. to a `CACHE_WARM_TARGETS_COMPS_BY_PLAYER` list and warm at startup (~5 LOC)
7. Run full backend test suite: `npx vitest run` — expect ≥800/800 (current baseline plus new tests)
8. `npx tsc --noEmit` clean
9. Local smoke: start backend locally, hit `POST /api/compiq/comps-by-player {playerName:"Mike Trout"}` — expect non-empty comps array
10. Open PR. HALT for eyeball approval.
11. Merge + deploy hobbyiq3 (standard slim-zip pattern, set GIT_SHA app settings)
12. Post-deploy verification:
    - 5 demo players via curl POST /comps-by-player; each returns non-empty
    - App Insights shows new endpoint requests + cardsight dependencies
    - Existing 19/19 demo smoke unchanged

**Phase 2: MCP rewires compsLoader (estimated 45-75 min)**

1. Branch from main: `git checkout -b feat/mcp-comps-from-backend`
2. Add `COMPIQ_BACKEND_URL` env var requirement; document in mcp-server README or comment
3. Rewrite `mcp-server/compsLoader.ts`:
   - Replace `fetchPlayerComps(playerName, preferredGrade)` body with: HTTP POST to `${COMPIQ_BACKEND_URL}/api/compiq/comps-by-player`
   - Parse response, return `CardComp[]` from `body.comps`
   - On HTTP error / timeout: return empty array (graceful degradation, same as current blob-miss behavior)
   - Keep `playerSlug()` export if anything else imports it (audit; if not used elsewhere, remove)
4. Update `mcp-server/compsLoader.test.ts` (or create) — mock the HTTP call, verify CardComp[] shape
5. Verify pricing.ts and server.ts unchanged (no edits)
6. Verify backtest.ts unchanged (`fetchPlayerComps` call site unchanged)
7. `npm run build` clean
8. Set `COMPIQ_BACKEND_URL` on compiq-mcp App Service via az CLI
9. Local smoke: start mcp-server locally with COMPIQ_BACKEND_URL pointing at deployed backend, hit `POST /api/compiq/predict` with 1-2 demo cards
10. Open PR. HALT for eyeball approval.
11. Merge + deploy compiq-mcp (slim-zip pattern from yesterday's PR #118)
12. Post-deploy verification:
    - 3 demo cards via curl POST /predict; each returns valid prediction
    - App Insights confirms backend dependency replacing prior blob dependency
    - compsLast30 / compRange / sampleSize within ±20% of pre-rewire baseline (capture pre-rewire baseline BEFORE Phase 2 ship)

**Rollback path:**
- Phase 1 rollback: redeploy hobbyiq3 from prior main SHA. New endpoint becomes 404; no other route affected.
- Phase 2 rollback: redeploy compiq-mcp from prior main SHA. compsLoader returns to blob-based pattern.
- fn-cardhedge-comps stays running during both phases as the fallback data source. No rollback risk.

**Hard rules for implementation session:**
- Phase 1 ships first. Phase 2 only if Phase 1 acceptance fully passes.
- If a sixth/seventh defect surfaces mid-implementation, HALT and characterize.
- If Phase 1's /comps-by-player produces noticeably worse comp coverage than fn-cardhedge-comps blobs (e.g., <30% of comp count for the 5 demo players), HALT and reconsider — that signal would invalidate the rewire's data-quality assumption.
- Each phase has independent deploy + verification cycles. No bundling.

---

## Open questions for the implementing session

1. **/search-list's CH dependency:** Should Phase 1 of THIS workstream also wire `/search-list` to Cardsight searchCatalog as a sibling endpoint? Pros: removes one more CH dependency. Cons: scope expansion; orthogonal to comps-by-player. **Default: defer to a separate workstream gated on rewire stability.**

2. **Cardsight searchCatalog `take` parameter:** Default is 20 candidates; demo players (Ohtani 2018 TU returned 16) suggest 25 is the right cap. Confirm via probe before locking.

3. **LRU cache warming for new endpoint:** Worth the ~5 LOC for symmetry with resolveCardId warming, OR YAGNI? Defer until Phase 1 smoke shows actual cold-call latency.

4. **`cardId` field in CardComp:** Adding it is non-breaking (optional). Does pricing.ts have any future use for it? If yes, populate now. If no, leave it off.

5. **Phase 2 latency budget:** The "p95 within 1.5×" gate is a guess. If Phase 2 acceptance shows latency creeping up (e.g., 2× or 3×), do we ship anyway with a follow-up perf workstream, or HALT and fix first? **Default: HALT and fix; latency regression on a critical path is a real issue.**

---

## Document anti-drift

This document is design-only. It does NOT modify any source file. Each phase's fixes are characterized with file:line references and LOC estimates; the implementation belongs to the next session.

Open design questions (called out in §8 + above) for the implementing session to resolve before writing code:
- Card-set selection strategy (year filter default, releaseName narrowing)
- `cardId` in CardComp inclusion decision
- LRU cache warming inclusion decision
