# CardHedge Decommission — Phase 1 grep + Phase 2 plan

**Date:** 2026-05-30
**CF:** CF-CARDHEDGE-DECOMMISSION-FULL
**Phase:** 1 of N (read-only enumeration; Phase 2 implementation is the NEXT CF)
**Authority anchor:** Option B sequence step 3 ([4187a7e](https://github.com/HobbyIQ/HobbyIQ-V1/commit/4187a7e)) — backend-out-then-UI ordering
**Prior anchors:**
- W5-Windows ([06b585d](https://github.com/HobbyIQ/HobbyIQ-V1/commit/06b585d)) — user-facing endpoint migration (`/api/compiq/cardsearch` + `/api/compiq/search-list` deletion)
- R1 cardsightCardId on PortfolioHolding ([bf836c0](https://github.com/HobbyIQ/HobbyIQ-V1/commit/bf836c0)) — structural foundation for the identity story replacing CardHedge
- InventoryIQ design ([06a5d4e](https://github.com/HobbyIQ/HobbyIQ-V1/commit/06a5d4e)) — Section 6.2 W2/R2 boundary
- CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25) — already renamed `cardhedge` signal key → `compsMomentum` at the aggregator layer; function file name stayed `fn-cardhedge-comps`

## Framing

"Everything is Cardsight." CardHedge is dead strategically and being made dead in code via this CF. W5-Windows shipped the user-facing endpoint migration. This Phase 1 enumerates the rest. Phase 2 (a separate next CF) implements the removal.

**Scope discipline:** Read-only. No code changes, no env-var removal, no Function disable, no subscription cancellation. The deliverable is this document.

**Sequence reminder:** B-sequential per Option B lock. Not parallel with any other CF.

---

# Section 1 — Full CardHedge footprint enumeration

Repo-wide grep (case-insensitive `cardhedge|CardHedge|CARD_HEDGE`): **162 files, 1460 total occurrences** (excluding `node_modules`, `backend/dist/`, `deploy.zip` artifacts). Below each finding is classified into one of five categories defined in the kickoff (Cat 1 deletion / Cat 2 migration / Cat 3 naming / Cat 4 docs / Cat 5 infra). Phase 1 did **not** surface any reference requiring a Category 6.

## 1.1 — Category 2 (migration required)

The live runtime CH surface that must be replaced with Cardsight equivalents BEFORE deletion.

### 1.1.1 `/api/compiq/price-by-id` (compiq.routes.ts:736-887)

The single remaining user-facing CH-rooted endpoint. Threads `cardHedgeCardId` from request body through `computeEstimate` and echoes it back in the response.

| Symbol | File | Line | Notes |
|--------|------|------|-------|
| `cardHedgeCardId` input field | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L739-L741) | 739-741 | REQUIRED, 400 if missing |
| Cache key | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L743-L746) | 743-746 | `compiq:price-by-id:v3:${cardHedgeCardId}\|${gradeCompany}${gradeValue}` |
| `computeEstimate` call | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L748-L754) | 748-754 | passes `cardHedgeCardId` through `CompIQEstimateRequest` |
| Response echo | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L766) | 766, 816 | `cardHedgeCardId` echoed at top level of 200 + 400 responses |
| Telemetry write | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L862-L882) | 862-882 | `cardIdSource="cardhedge"`, `cardId: cardHedgeCardId` |

Detailed migration analysis in Section 2A.

### 1.1.2 `CompIQEstimateRequest.cardHedgeCardId` (compiq.types.ts:18)

The request shape consumed by `computeEstimate` (and several other compiq routes that thread the field through).

| Symbol | File | Line | Notes |
|--------|------|------|-------|
| `cardHedgeCardId?: string` | [backend/src/types/compiq.types.ts](backend/src/types/compiq.types.ts#L18) | 18 | Type-level; threads through every estimate call site |
| Pinned-card pricing path | [backend/src/services/compiq/compiqEstimate.service.ts](backend/src/services/compiq/compiqEstimate.service.ts#L1475) | 1475 | `fetchComps(cardTitle, cardHedgeGrade, body.cardHedgeCardId, queryContext)` |
| Fallback gate | [backend/src/services/compiq/compiqEstimate.service.ts](backend/src/services/compiq/compiqEstimate.service.ts#L1547) | 1547 | `if (fetched.card && body.playerName && !body.cardHedgeCardId)` |

### 1.1.3 `cardsight.router.ts` CH-namespace fallback layer

The router that decides "fetch from CH or Cardsight." Under `CARDSIGHT_MODE=exclusive` (current production), CH-namespaced cardIds return `[]` and Cardsight handles everything; under `off` or `shadow`, CH is the primary. Phase 2 removes the CH branch entirely.

| Symbol | File | Line | Notes |
|--------|------|------|-------|
| Type imports | [backend/src/services/compiq/cardsight.router.ts](backend/src/services/compiq/cardsight.router.ts#L26-L28) | 26-28 | `CardHedgeCard`, `CardHedgeSale` from cardhedge.client |
| `csToChCard()` translation | [backend/src/services/compiq/cardsight.router.ts](backend/src/services/compiq/cardsight.router.ts#L138-L139) | 138-145 | Cardsight result → CardHedge shape (only used in shadow mode for parity comparison) |
| `cardIdSource` routing | [backend/src/services/compiq/cardsight.router.ts](backend/src/services/compiq/cardsight.router.ts#L450-L492) | 450-492 | `"cardhedge" \| "cardsight"` discriminant |
| `primary_mode_cardhedge_namespace_only` warn | [backend/src/services/compiq/cardsight.router.ts](backend/src/services/compiq/cardsight.router.ts#L484-L492) | 484-492 | Defensive log when exclusive mode receives a CH id |
| `findCompsRouted` / `searchCardsRouted` / `getCardSalesRouted` | exports | — | Three routing functions wrapping each CH function with the cardsight-or-fallback decision |

### 1.1.4 `compsByPlayer.service.ts` (1 reference)

Used at [`compsByPlayer.service.ts`](backend/src/services/compiq/compsByPlayer.service.ts) — single reference; let Phase 2 inspect whether it's a live call or comment context.

### 1.1.5 `compiqEstimate.service.ts` (21 references)

Beyond the threading of `cardHedgeCardId` through `fetchComps` (cataloged above), this file consumes the `CardHedgeCard`/`CardHedgeSale` types broadly and logs `[compiq.fetchComps] Card Hedge ...` lines. Most references are part of the live-comp-fetch fallback path that goes away when `cardsight.router.ts` is collapsed. Inventory:

| Reference type | Count | Notes |
|----------------|-------|-------|
| Type imports `CardHedgeCard`, `CardHedgeSale` | 1 import | Lines 6, 26-28 |
| `cardHedgeGrade` local variable (read from body.gradingCompany / gradingValue) | ~8 sites | Used as grade tag for fetches and telemetry — `cardHedgeGrade` is name-only; the variable holds the user-input grade string, not a CH-internal grade. Cat 3 naming. |
| `[compiq.fetchComps] Card Hedge` log lines | ~4 sites | Cat 4 (log message) |
| `body.cardHedgeCardId` reads | 2 sites | Lines 1475, 1547 (already cataloged) |
| `card_id`/`card.card_id` field access on CH responses | several | Cat 1 dead with CH client removal |

### 1.1.6 mcp-server live CH integrations

The MCP server has its OWN CardHedge integration, separate from backend. **Phase 2 must address this — not just backend.**

| Symbol | File | Line | Notes |
|--------|------|------|-------|
| `cardhedge.ts` full client | [mcp-server/cardhedge.ts](mcp-server/cardhedge.ts) | 14, 80, 159-160, 195 | Calls `api.cardhedger.com` directly; writes `{slug}/cardhedge.json` blobs |
| `primePlayerComps` / `lookupCardImage` | [mcp-server/server.ts:46](mcp-server/server.ts#L46) | 46 | Imported into MCP server entry point |
| `compsLoader.ts` legacy blob-read note | [mcp-server/compsLoader.ts:3-4](mcp-server/compsLoader.ts#L3-L4) | 3-4 | Comment-only — current path is HTTP to backend, not blob read. The blob path comment is historical. |
| `pricing.ts` signal rename note | [mcp-server/pricing.ts:100-101](mcp-server/pricing.ts#L100-L101) | 100-101 | Comment-only |

### 1.1.7 Function app live CH integrations

Two functions still make live CH calls:

| Function | File | Frequency | Notes |
|----------|------|-----------|-------|
| `fn-cardhedge-comps` | [compiq-functions/fn-cardhedge-comps/function.py](compiq-functions/fn-cardhedge-comps/function.py) | nightly 02:00 UTC | Writes `compiq-signals/{slug}/compsMomentum.json` (signal key already renamed per CF-CARDHEDGE-SIGNAL-RENAME). Calls `search_cards` + `get_card_sales` against `api.cardhedger.com`. |
| `fn-nightly-comp-prefetch` | [compiq-functions/fn-nightly-comp-prefetch/function.py:28](compiq-functions/fn-nightly-comp-prefetch/function.py#L28) | nightly | Imports `get_card_sales, search_cards` from `shared.cardhedge`. Also reads `card.get("cardHedgeId")` from cohort metadata at line 112. |
| `shared/cosmos_floor.py` | [compiq-functions/shared/cosmos_floor.py](compiq-functions/shared/cosmos_floor.py) | imported by other functions | Uses `get_card_sales`, `search_cards` from `shared.cardhedge` as the "primary data source" per the module docstring. |

Detailed Function-app analysis in Section 2B.

## 1.2 — Category 1 (pure deletion, no replacement)

Removable after Category 2 migrations complete.

| Artifact | Path | Notes |
|----------|------|-------|
| Backend CH client | [backend/src/services/compiq/cardhedge.client.ts](backend/src/services/compiq/cardhedge.client.ts) | Full file delete (32 references all internal-export self-reference). 295 LOC est. |
| MCP server CH file | [mcp-server/cardhedge.ts](mcp-server/cardhedge.ts) | Full file delete after consumers migrated |
| Shared Python CH module | [compiq-functions/shared/cardhedge.py](compiq-functions/shared/cardhedge.py) | Full file delete after `fn-cardhedge-comps` + `fn-nightly-comp-prefetch` + `cosmos_floor.py` migrated |
| Azure Function dir | [compiq-functions/fn-cardhedge-comps/](compiq-functions/fn-cardhedge-comps/) | Whole directory delete (after schedule disable) |
| Tests for CH client | 6 files | `cardhedgeAutoProspectIdentity.test.ts`, `cardhedgeFindCompsByQuery.test.ts`, `cardhedgeFindCompsByQuery.aiCategory.test.ts`, `cardhedgeGradeStripping.test.ts`, `cardhedgeIdentifyCard.noCategoryHint.test.ts`, `cardhedgeIdentifyParser.test.ts`. All exercise behavior of code being deleted. |
| Cardsight router CH branches | [cardsight.router.ts](backend/src/services/compiq/cardsight.router.ts) | After collapse: delete all `cardIdSource: "cardhedge"` branches, `csToChCard`, the `findCompsRouted/getCardSalesRouted/searchCardsRouted` wrappers can either flatten (no more routing decision) or be deleted (rename direct Cardsight calls back to simpler names) |
| `cardsight.router.test.ts` CH cases | [backend/tests/cardsight.router.test.ts](backend/tests/cardsight.router.test.ts) | ~50% of file is CH-branch coverage; surviving cases retest cardsight-only routing or get deleted with the router itself |
| Investigation scripts | [backend/scripts/parallels-2b-*.ts](backend/scripts/) | 2 files reference `api.cardhedger.com` directly; one-shot research scripts. Cat 1 delete OR Cat 4 archive — Drew choice. |
| GitHub workflow | [.github/workflows/ch-monitor.yml](.github/workflows/ch-monitor.yml) | 10 references — likely a "is CH up?" monitor workflow. Delete after subscription cancelled. |

## 1.3 — Category 3 (naming/refactor decisions)

Symbols whose NAMES carry CardHedge branding but whose VALUES are vendor-neutral. Decision: rename to vendor-neutral OR accept as legacy name.

| Symbol | File | Drew-decision options |
|--------|------|-----------------------|
| `cardHedgeCardId` on `CompIQEstimateRequest` | [compiq.types.ts:18](backend/src/types/compiq.types.ts#L18) | (a) rename `cardHedgeCardId` → `cardsightCardId` on the type + all routes that consume it (~10 sites) (b) add `cardsightCardId` alongside, deprecate `cardHedgeCardId`, keep both for transition (c) leave as legacy name |
| `cardHedgeGrade` local variable in `compiqEstimate.service.ts` | ~8 sites | Value is the user-supplied grade string ("PSA 10", "Raw") — no CH-internal semantic. (a) rename to `grade` or `effectiveGrade` (b) leave as legacy name |
| iOS Swift `cardHedgeCardId` field on `CompIQHit`, `CompIQDetail`, response models | [HobbyIQ/CompIQSearchModels.swift](HobbyIQ/CompIQSearchModels.swift#L15) | 5 separate Swift Codable structs. JSON wire key is `card_id` (line 51 `case cardHedgeCardId = "card_id"`). (a) rename Swift field; wire key stays `card_id` (b) rename wire key too (requires backend + iOS coordinated ship) (c) leave as legacy name |
| iOS `APIService.priceByCardId(cardHedgeCardId:)` | [HobbyIQ/APIService.swift:106](HobbyIQ/APIService.swift#L106) | Method signature uses parameter label `cardHedgeCardId`. Rename or accept. |

**Empirical correction to InventoryIQ design Section 1:**

The InventoryIQ design ([06a5d4e](docs/phase0/inventoryiq_design_2026-05-30.md)) line 111, 548, 604 stated that `cardHedgeCardId` was persisted on `PortfolioLedgerEntry`. **Phase 1 empirical grep refutes this.** `cardHedgeCardId` does NOT appear on either `PortfolioHolding` or `PortfolioLedgerEntry` ([backend/src/types/portfolioiq.types.ts](backend/src/types/portfolioiq.types.ts) and [portfolioStore.service.ts:198-255](backend/src/services/portfolioiq/portfolioStore.service.ts#L198-L255)). The "deferred cleanup / asymmetry" narrative was based on a doc-misstatement.

**Net consequence:** No Cosmos schema migration needed for user docs. No data rewrites required. The Category 3 surface is purely API-shape (compiq request types, telemetry corpus historical entries, iOS Codable contracts) — not user-data.

## 1.4 — Category 4 (documentation cleanup)

Active docs that mention CH "as if alive" — these need editing to past tense. Historical docs (decision records, investigations, finished-roadmap entries) stay as-is — they captured truth at the time of writing.

### 1.4.1 Active docs (need updates after Phase 2 ships)

| File | Lines | Note |
|------|-------|------|
| [.github/copilot-instructions.md](.github/copilot-instructions.md) | 24 occurrences | Instructions to Copilot/AI agents — should drop "primary CardHedge source" language; replace with "Cardsight catalog + cert-grader registry" framing |
| [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) | 138 occurrences (this is the BIG one) | Many entries reference CH integration as if active. Updates: (a) move closed-CF entries to Closed section (b) update CF-CARDHEDGE-DECOMMISSION-FULL backlog entry → Closed once Phase 2 ships (c) any "CH is the primary source" framing should flip to past tense |
| [docs/HOBBYIQ_ROADMAP_2026-05-28.md](docs/HOBBYIQ_ROADMAP_2026-05-28.md) | 12 occurrences | Active roadmap. Phase 4a section ("Backend cache layer") and Phase 3 ("CH decommission") need updates after Phase 2 ships |
| [docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md](docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md) | 16 occurrences | Forward-looking roadmap — references CH integrations that will not exist post-Phase-2 |
| [backend/docs/parallels-reference-schema.md](backend/docs/parallels-reference-schema.md) | 1 occurrence | Drop CH-specific framing |
| [backend/docs/investigations/*.md](backend/docs/investigations/) | 5 occurrences across `drake-baldwin-revalidation-adr-0003.md` + `neighbor-synthesis-cleanup-pass.md` + parallels-reference-schema | Historical. Leave as-is (these record past investigations). |

### 1.4.2 Historical docs (leave as-is)

These are decision records / investigations that captured truth at the time of writing. Modifying them would distort the historical record.

- All `docs/phase0/backtest_runs/**/results.json` (24 each — these are test artifacts; CardHedge is in the JSON as a data-source label for runs executed when CH was live)
- All `backend/harness/tier1/baselines/*.json` (snapshot baselines)
- All `docs/phase0/finding*.md`, `docs/phase0/ch_removal_*.md`, `docs/phase0/cardhedge_signal_rename_design.md` — investigation records
- `docs/phase0/SESSION_HANDOFF_2026-05-21.md` — historical handoff
- `docs/ROADMAP_RECONCILIATION_2026-05-28.md` — historical roadmap reconciliation
- `backend/docs/decisions/ADR-cardsight-migration-2026-05-18.md` — ADR
- All `docs/phase0/cardsight_*.md` investigations — historical
- `docs/phase0/inventoryiq_design_2026-05-30.md` — the empirical correction noted in 1.3 above is honest accounting, NOT a rewrite of the historical doc

### 1.4.3 Active code comments (cleanup with their files)

Inline code comments that say "Card Hedge" / "CH" / "primary CardHedge source" — these update naturally when Phase 2 modifies the files. Not separately enumerated.

## 1.5 — Category 5 (infra / business)

### 1.5.1 Azure Function app

| Component | Action | Sequence note |
|-----------|--------|---------------|
| `fn-cardhedge-comps` schedule | Disable timer trigger before deleting code | **First** in Cat 5 sequence |
| `fn-cardhedge-comps` blob writes to `compiq-signals/{slug}/cardhedge.json` | Stop writing after schedule disable; existing blobs persist | See Section 2B for delete-vs-archive decision |
| `fn-nightly-comp-prefetch` calls to `shared.cardhedge` | Migrate to Cardsight pricing API OR disable function | Decision in Section 2B |
| `shared/cardhedge.py` | Delete after both consumer functions migrated/disabled | |
| `shared/cosmos_floor.py` | Migrate its `shared.cardhedge` imports to Cardsight equivalents | Read-path dependency; migrate before deleting `cardhedge.py` |

### 1.5.2 App Service environment

| Setting | Action |
|---------|--------|
| `CARD_HEDGE_API_KEY` in HobbyIQ3 App Settings | Remove after `cardhedge.client.ts` deletion lands and rolling-deploy stable |
| `CARD_HEDGE_API_KEY` in Function App settings | Remove after `fn-cardhedge-comps` + `fn-nightly-comp-prefetch` + `cosmos_floor.py` migrations complete |
| `CARDSIGHT_MODE` env var | This is the cardsight.router.ts mode toggle — `exclusive` is current; can remove ENTIRE flag when router collapses |
| Any `CARD_HEDGE_*` in `.env.local` etc. | Remove from any local dev configs |

### 1.5.3 CI/CD

| Component | Action |
|-----------|--------|
| `.github/workflows/ch-monitor.yml` | Delete the workflow file after subscription cancelled |
| Any CI references to CH env vars (likely none — but Phase 2 should grep `secrets.CARD_HEDGE` to confirm) | |

### 1.5.4 Business actions (post-code-removal)

| Action | Trigger |
|--------|---------|
| Cancel CardHedge subscription (cardhedger.com account) | Last in CF — after all code/infra removed, after `CARD_HEDGE_API_KEY` confirmed removed from every settings surface, after stable for ≥48h with zero CH-call telemetry |
| Secret rotation per `docs/security/SECRET_ROTATIONS.md` | Mark `CARD_HEDGE_API_KEY` as retired in that doc when removed |

---

# Section 2 — Special focus areas

## 2A. `/api/compiq/price-by-id` migration

### Current behavior

POST `/api/compiq/price-by-id` body shape:
```json
{
  "cardHedgeCardId": "abc123",  // REQUIRED; 400 if missing
  "query": "Aaron Judge 2017",  // optional free-text companion (used for cache key + telemetry)
  "gradeCompany": "PSA",        // optional
  "gradeValue": 10              // optional
}
```

Returns a CompIQ estimate response with `cardHedgeCardId` echoed at top level, plus the full FMV/trend/recentComps/cardIdentity payload. Cache key incorporates `cardHedgeCardId`; cache TTL is `CACHE_TTL_SECONDS`. Telemetry writes a corpus entry with `cardIdSource="cardhedge"` and `cardId: cardHedgeCardId`.

The cardHedgeCardId flows through `computeEstimate → fetchComps(cardTitle, cardHedgeGrade, body.cardHedgeCardId, queryContext)` ([compiqEstimate.service.ts:1475](backend/src/services/compiq/compiqEstimate.service.ts#L1475)). Under `CARDSIGHT_MODE=exclusive` the router redirects to Cardsight and the CH id returns empty — meaning **/api/compiq/price-by-id with a CH id already returns no-comps in production today**. Pinning is effectively broken; the iOS picker uses cardsearch (Cardsight) and would need a Cardsight cardId for pinning to work — but the route only accepts `cardHedgeCardId`.

### Cardsight equivalent

The closest Cardsight pricing surface (per InventoryIQ design Section 2 + recent SDK investigation):

- `get_card_pricing(cardId)` — single-card pricing by Cardsight UUID
- `get_card_pricing_bulk(cardIds[])` — batch (1-100) by Cardsight UUID

Either returns a pricing response with sold/asking data the route can shape into the existing `marketTier / buyZone / holdZone / sellZone / predictedPrice / trendIQ` envelope.

### Field mapping

| Current request | Cardsight migration |
|-----------------|---------------------|
| `cardHedgeCardId: string` | `cardsightCardId: string` (with prefix-strip per R1's normalizer pattern) |
| (no equivalent) | Optional `query` continues to work as a free-text companion |
| `gradeCompany`, `gradeValue` | Same shape; threaded into Cardsight pricing call |

| Current response field | Cardsight migration |
|------------------------|---------------------|
| `cardHedgeCardId` echo | `cardsightCardId` echo |
| `marketTier / buyZone / holdZone / sellZone` | Shape unchanged; populated from Cardsight pricing |
| `predictedPrice / predictedPriceRange / predictedPriceAttribution` | Shape unchanged; populated from internal prediction layer (which already uses Cardsight under exclusive mode) |
| `trendIQ` | Shape unchanged |
| `recentComps[]` | Shape may need adjustment depending on Cardsight comp granularity; Phase 2 verifies |
| `cardIdentity` | Shape unchanged; populated from Cardsight catalog lookup |

### Risk assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cardsight `get_card_pricing` may not expose all the fields `compiqEstimate.service.ts` currently extracts from CH comps (sale_type, source, url per CardHedgeSale) | Medium | Phase 2 verifies via empirical Cardsight probe before route migration; if gap exists, surface for Drew decision (degrade those fields OR don't migrate the route yet) |
| iOS picker → /price-by-id flow is broken in the gap-window per W5-Windows operational note | Already-existing | Resolves on this migration ship; iOS sends Cardsight cardId from cardsearch → /price-by-id accepts it |
| Cache key change | Low | New cache namespace (`compiq:price-by-id:v4` or rename to `:cardsight:`) — existing v3 cache becomes orphan, expires via TTL |
| Telemetry corpus history | Low | New entries get `cardIdSource="cardsight"`. Historical entries with `cardIdSource="cardhedge"` stay as historical record. |

### Backward compat option (Drew decision)

Two viable shapes for the migrated route:

| Option | Body | Response | Cost | Note |
|--------|------|----------|------|------|
| **Hard cutover** | Accepts `cardsightCardId` only; 400 on `cardHedgeCardId` | `cardsightCardId` echo only | iOS rebuild required before ship; no transitional shape | Cleanest. Aligns with W5-iOS rebuild that's coming anyway. |
| **Soft transition** | Accepts either field (prefer cardsight, fall back to CH-id-as-text-query) | Returns whichever was sent | iOS keeps shipping `cardHedgeCardId` until W5-iOS lands | Avoids picker-broken gap-window extension but adds two-shape code path |

**Recommendation pending Phase 2 kickoff:** Hard cutover aligns with W5-iOS coordination — picker is currently broken anyway, no gap window to preserve. But Drew's call.

## 2B. `fn-cardhedge-comps` Azure Function cleanup

### Schedule + cadence

Nightly 02:00 UTC ([compiq-functions/fn-cardhedge-comps/__init__.py](compiq-functions/fn-cardhedge-comps/__init__.py)) — timer trigger via `wrap_signal_writer("compsMomentum", get_cardhedge_signal, ...)`.

### What it writes to blob

Per [function.py](compiq-functions/fn-cardhedge-comps/function.py):
- For each tracked player: `search_cards(playerName)` → top-hit `card_id` → `get_card_sales(card_id, limit=25)` → reduce to comps-momentum signal payload
- Payload shape: `{ player, multiplier, signal, comp_count, updated_at, card_hedge_id, card_hedge_title, raw_sales[], updated_at }`
- Storage: `compiq-signals/{playerSlug}/compsMomentum.json` (rename per CF-CARDHEDGE-SIGNAL-RENAME)

### Whether anything consumes these blobs currently

Yes. `compsMomentum.json` is read by the signal aggregator → `compsMomentum` price-class signal at weight 0.20 ([memory anchor: compsMomentum weight lock](memory)). This signal is **load-bearing** for the prediction layer.

### Migration options

| Option | Description | Cost | Note |
|--------|-------------|------|------|
| **A. Migrate to Cardsight pricing** | Rewrite `get_cardhedge_signal` to use Cardsight's `pricing.bulk` endpoint; keep blob path + payload shape stable so the aggregator's consumer doesn't change | Medium. Requires writing a Python Cardsight client (mirror of `compiq-functions/shared/cardsight.py` if it exists, or new) | Preserves the compsMomentum signal cleanly. Aligns with "everything is Cardsight" framing. |
| **B. Retire the function entirely** | Disable `fn-cardhedge-comps`; rely on Cardsight live pricing at prediction time (no nightly prefetch) | Low for the function side; high for the prediction side (currently the aggregator depends on the nightly blob; switching to live would change the latency + RU profile) | Removes the entire nightly pipeline. But compsMomentum signal value at 0.20 weight is structural per project memory. |
| **C. Keep CH alive longer** | Don't decommission this function until Cardsight pricing is empirically proven for the compsMomentum use case | Status quo cost (CH subscription continues) | Defeats the CF's purpose. |

### Blob retention

Existing `compsMomentum.json` blobs persist until manually deleted. Three sub-options:

| Sub-option | Action | Note |
|------------|--------|------|
| **i. Delete on Phase 2 ship** | Run a one-time cleanup script that drops the `compiq-signals/*/compsMomentum.json` blob set (and any leftover `cardhedge.json` blobs from pre-CF-CARDHEDGE-SIGNAL-RENAME) | Cleanest. Storage cost is minimal but trace-cleanliness matters. |
| **ii. Archive to cold storage** | Move to an `archive/` prefix; leave the canonical write-path empty post-migration | If there's any chance of forensic value (signal-regression debugging) |
| **iii. Leave in place** | No blob cleanup; the path just stops being written | Cheapest. Accepts storage clutter. |

**Recommendation pending Phase 2 kickoff:** Migration option A + blob sub-option i — preserves the compsMomentum signal value while removing the CH dependency. But if Cardsight pricing.bulk empirical verification reveals capability gaps for this use case, fall back to discussing options B/C with Drew.

### Sequencing constraint

- Disable schedule BEFORE deleting code that the schedule references
- Migrate `fn-nightly-comp-prefetch` and `cosmos_floor.py` in parallel with `fn-cardhedge-comps` (they all depend on `shared/cardhedge.py`)
- Delete `shared/cardhedge.py` last, after all consumers migrated
- Remove `CARD_HEDGE_API_KEY` from Function App settings after `shared/cardhedge.py` deleted

## 2C. `cardHedgeCardId` field naming decision

### Empirical correction

Per Section 1.3 honest accounting: `cardHedgeCardId` is NOT on `PortfolioHolding` or `PortfolioLedgerEntry`. The InventoryIQ design's "ledger asymmetry" framing was based on a doc-misstatement that did not survive Phase 1 empirical inspection. **There is no user-data migration here.**

What `cardHedgeCardId` DOES exist as:

| Surface | File | Decision flavor |
|---------|------|-----------------|
| Request type `CompIQEstimateRequest.cardHedgeCardId` | [backend/src/types/compiq.types.ts](backend/src/types/compiq.types.ts) | Backend-internal type; rename has 1:1 type cost + 4-5 call-site renames |
| Route input field for `/api/compiq/price-by-id` | [backend/src/routes/compiq.routes.ts](backend/src/routes/compiq.routes.ts#L739) | API contract; rename requires iOS coordination |
| Telemetry corpus entries (historical) | [backend/src/models/corpusEntry.ts](backend/src/models/corpusEntry.ts) | Historical record — existing entries with `cardIdSource="cardhedge"` stay as-is (historical truth). New entries use `cardIdSource="cardsight"`. |
| iOS Swift Codable `CompIQHit.cardHedgeCardId` etc. | [HobbyIQ/CompIQSearchModels.swift](HobbyIQ/CompIQSearchModels.swift) (5 structs) | Wire key currently `card_id`; Swift field name is the question |

### Three sub-decisions

**Sub-decision C1 — Backend `CompIQEstimateRequest.cardHedgeCardId`:**

| Option | Description | Recommended? |
|--------|-------------|--------------|
| Rename to `cardsightCardId` (with prefix-strip via R1's normalizer pattern) | Clean canonical name | Yes — aligns with R1's `cardsightCardId` on PortfolioHolding |
| Add `cardsightCardId` alongside, deprecate `cardHedgeCardId` | Soft transition | Only if Soft Transition for 2A is chosen |
| Leave as legacy name | Cheapest but inconsistent with R1 | No |

**Sub-decision C2 — Wire key for `/api/compiq/price-by-id`:**

| Option | Wire body field name | iOS coordination |
|--------|----------------------|------------------|
| `cardsightCardId` | Coordinated rename | Required; aligns with W5-iOS rebuild |
| `card_id` (drop the vendor prefix; just call it the card id) | Most vendor-neutral | Requires backend + iOS coordination but ages well |
| Accept both during transition | Soft transition | Two-shape code path |

**Sub-decision C3 — iOS Swift Codable field name:**

The 5 Swift structs that have `cardHedgeCardId` as the Swift field name + wire key `card_id`:

| Option | Swift field name | Wire key | Note |
|--------|-----------------|----------|------|
| Rename Swift only | `cardsightCardId` | `card_id` (unchanged) | Decouples Swift naming from CH brand without breaking wire compat |
| Rename Swift + wire | `cardsightCardId` | `cardsightCardId` (renamed) | Most consistent but requires backend coordinated ship |
| Leave Swift | `cardHedgeCardId` (legacy) | `card_id` | Cheapest; perpetuates the misleading Swift name |

**Recommendation pending Phase 2 kickoff:** Sub-C1 = rename. Sub-C2 = rename wire to `cardsightCardId` and coordinate with W5-iOS. Sub-C3 = rename Swift field AND wire to align with W5-iOS rebuild. This is the cleanest end state and W5-iOS is the natural integration point. But Drew's call.

---

# Section 3 — Sequenced removal plan for Phase 2

Phase 2 must order operations to avoid (a) breaking live functionality, (b) referencing deleted code from still-live callers, (c) leaving an orphan schedule firing against missing functions.

## Sequence

```
1. [BACKEND] Migrate /api/compiq/price-by-id from CH to Cardsight (Sub-C1 + 2A)
   - Add cardsightCardId field to CompIQEstimateRequest (with normalizer per R1 pattern)
   - Wire computeEstimate path to use cardsightCardId when present
   - Update route to accept cardsightCardId (with prefix-strip)
   - Update tests
   - Ship + verify
   - Update iOS Codable to send cardsightCardId (Sub-C2 + Sub-C3)
   - Ship iOS (or wait for W5-iOS coordinated rebuild — Drew decision)

2. [INFRA] Disable fn-cardhedge-comps schedule (don't delete code yet)
   - Azure Function app: disable timer trigger only
   - Verify: blob path stops getting written
   - Wait 24-48h for confirmation no downstream breakage

3. [INFRA] Migrate fn-cardhedge-comps to Cardsight pricing (2B option A)
   - New Cardsight Python client (or extend an existing one)
   - Rewrite get_cardhedge_signal to use Cardsight pricing.bulk
   - Re-enable schedule
   - Verify compsMomentum.json blob writes resume with same payload shape

4. [INFRA] Migrate fn-nightly-comp-prefetch + cosmos_floor.py to Cardsight
   - Same pattern: replace shared.cardhedge imports with Cardsight equivalents
   - Verify pre-fetched data matches expected shape

5. [CODE DELETION] Backend
   - Collapse cardsight.router.ts: remove CH branches, drop type imports
   - Delete cardhedge.client.ts
   - Delete 6 cardhedge test files
   - Delete backend/scripts/parallels-2b-*.ts (or archive per Cat 1)
   - Run full test suite — confirm green

6. [CODE DELETION] MCP server
   - Delete mcp-server/cardhedge.ts
   - Remove import from server.ts
   - Verify MCP server still operates (no consumer breakage)

7. [CODE DELETION] Function app shared
   - Delete shared/cardhedge.py
   - Delete fn-cardhedge-comps directory
   - Verify remaining functions still operate

8. [INFRA] Env var removal
   - Remove CARD_HEDGE_API_KEY from HobbyIQ3 App Settings
   - Remove CARD_HEDGE_API_KEY from Function App settings
   - Remove CARDSIGHT_MODE env var (no longer relevant once router collapses)

9. [DOCS] Cat 4 cleanup
   - Update copilot-instructions.md
   - Update SESSION_HANDOFF (move backlog entry to closed)
   - Update HOBBYIQ_ROADMAP_2026-05-28.md
   - Update HOBBYIQ_ROADMAP_2026Q2_Q3.md
   - Mark CARD_HEDGE_API_KEY retired in SECRET_ROTATIONS.md

10. [INFRA] Stability watch
    - 48h post-deploy with zero CH-call telemetry, zero compsMomentum signal regressions, zero 5xx on /api/compiq/price-by-id

11. [BUSINESS] Cancel CardHedge subscription
    - After 48h stable: cancel cardhedger.com account
    - Delete .github/workflows/ch-monitor.yml after cancellation

12. [INFRA] Blob cleanup (2B sub-option i)
    - One-time script to drop compiq-signals/*/cardhedge.json (historical, pre-rename) and any remaining CH-named artifacts
```

## Sequence rationale

- **Steps 1-4 are migrations** (Cat 2) — must come before Cat 1 deletions or migration paths break
- **Steps 2-4 can parallelize** but sequencing them lets each verify independently before the next
- **Step 5-7 are deletions** (Cat 1) — code can go once Cat 2 migrations have stabilized
- **Step 8 (env var removal)** waits until step 7 — env-var references in code would cause startup failures if removed first
- **Step 9 (docs)** can interleave anywhere after step 7 but cleanest after code is gone (so docs reflect actual state)
- **Step 10 (stability watch)** is a hard 48h gate before business action
- **Step 11 (subscription cancel)** is final — irreversible business action with non-trivial restore cost
- **Step 12 (blob cleanup)** is last — historical blobs aren't load-bearing; cleanup is just hygiene

## Honest sequencing concerns

- **Step 1 (price-by-id migration) coordination with iOS:** If hard cutover, the route ships ahead of iOS; iOS continues sending `cardHedgeCardId` and gets 400s. Two mitigations: (a) soft transition for steps 1-5 (accept both shapes), then hard cutover at step 6 once iOS is shipped; (b) coordinate W5-iOS to ship adjacent. Drew's call at Phase 2 kickoff.
- **Step 3 (fn-cardhedge-comps Cardsight migration) is the highest-risk migration**: it touches the compsMomentum signal which is at 0.20 weight in the prediction layer (memory anchor: compsMomentum weight lock). If the Cardsight equivalent has different price-coverage characteristics, the signal value changes. Pre-step-3 empirical verification (sampling a few player slugs, comparing CH-derived vs Cardsight-derived compsMomentum values) is non-negotiable.
- **Step 5 cardsight.router.ts collapse is a big diff** — could be split into sub-steps if it surfaces unexpected coupling. Phase 2 should plan for this.

---

# Section 4 — Revised time estimate

**Original estimate (SESSION_HANDOFF backlog entry):** ~4-6h
**Revised estimate per Phase 1 findings:** **~10-16h** for the full sequence; **~5-7h** for Steps 1-2 alone (the immediate next CF following this Phase 1 grep).

### Per-step breakdown

| Step | Estimate | Notes |
|------|----------|-------|
| 1 — /price-by-id migration | ~2-3h | + iOS coordination if hard cutover |
| 2 — Function schedule disable | ~15min | Azure portal action |
| 3 — fn-cardhedge-comps Cardsight migration | ~3-4h | Highest risk; requires empirical verification + new Python Cardsight client |
| 4 — fn-nightly-comp-prefetch + cosmos_floor.py migrations | ~2-3h | Similar to step 3 but smaller surface |
| 5 — Backend code deletions (cardsight.router.ts collapse + cardhedge.client.ts delete + tests delete) | ~2h | Mostly mechanical once Cat 2 done |
| 6 — MCP server cardhedge.ts deletion | ~30min | |
| 7 — Function app shared deletion | ~30min | |
| 8 — Env var removal | ~15min | Azure portal |
| 9 — Docs cleanup | ~1h | SESSION_HANDOFF is the biggest item |
| 10 — Stability watch | 48h elapsed (active time ~30min for verification) | Calendar time, not effort |
| 11 — Subscription cancel | ~15min | Plus business confirmation |
| 12 — Blob cleanup | ~30min | One-time script |

### Why the estimate grew

- Original 4-6h estimate predated the Phase 1 empirical findings
- The MCP-server CH integration was likely underweighted in the original estimate
- The Function app side (shared/cardhedge.py + cosmos_floor.py + fn-nightly-comp-prefetch consumers + fn-cardhedge-comps migration) is substantial
- Empirical-verification gating on step 3 (compsMomentum signal preservation) adds non-coding time

### Phase 2 scoping recommendation

**Option α — Single Phase 2 CF covering Steps 1-12:** ~10-16h total, ~2 working days. Single ship, cleanest end state, longest coordination window.

**Option β — Split into two CFs:** Phase 2a covers Steps 1-2 (~3h, ships immediately); Phase 2b covers Steps 3-12 (~7-13h, ships after Phase 2a stable). Lower per-CF risk; more sequencing flexibility.

**Option γ — Three CFs:** Phase 2a (Steps 1-2), Phase 2b (Steps 3-4 — Function migrations), Phase 2c (Steps 5-12 — code/infra/business deletions). Smallest per-CF risk; longest total calendar time.

**Recommendation pending Drew Phase 2 kickoff:** Option β — Steps 1-2 are mechanical and decouple cleanly; Steps 3-12 share a verification window. But Drew's call.

---

# Section 5 — Phase 2 kickoff prep (explicit Drew decisions)

Phase 2 kickoff must resolve these decisions before implementation begins:

## D1 — `/api/compiq/price-by-id` migration mode (Section 2A)

- [ ] **Hard cutover** (clean, requires iOS coordination), OR
- [ ] **Soft transition** (accepts both shapes during transition window)

## D2 — `fn-cardhedge-comps` migration target (Section 2B)

- [ ] **Option A** — Migrate to Cardsight pricing, preserve compsMomentum signal, OR
- [ ] **Option B** — Retire function entirely, switch to live Cardsight at prediction time, OR
- [ ] **Option C** — Defer until empirically proven (would push CF out beyond Q2)

## D3 — Blob retention (Section 2B sub-option)

- [ ] **i. Delete on Phase 2 ship**, OR
- [ ] **ii. Archive to cold storage**, OR
- [ ] **iii. Leave in place**

## D4 — `cardHedgeCardId` naming sub-decisions (Section 2C)

- [ ] **C1** Rename `CompIQEstimateRequest.cardHedgeCardId` → `cardsightCardId`? (Yes/No/Soft-transition)
- [ ] **C2** Rename wire key for `/api/compiq/price-by-id`? (To `cardsightCardId` / to `card_id` / leave / soft-transition)
- [ ] **C3** Rename iOS Swift `cardHedgeCardId` field name + wire key? (Yes-both / Yes-Swift-only / leave / coordinate-with-W5-iOS)

## D5 — Phase 2 scoping (Section 4)

- [ ] **Option α** — Single Phase 2 CF (Steps 1-12), or
- [ ] **Option β** — Two CFs (Phase 2a: Steps 1-2, Phase 2b: Steps 3-12), or
- [ ] **Option γ** — Three CFs (Steps 1-2, 3-4, 5-12)

## D6 — Investigation scripts (Section 1.2 last row)

The two `backend/scripts/parallels-2b-*.ts` scripts reference `api.cardhedger.com` directly as one-shot research tooling.

- [ ] **Delete** with Cat 1, OR
- [ ] **Archive** to docs/phase0/investigations/

## D7 — Backend script telemetry corpus (Section 2C)

Historical corpus entries with `cardIdSource="cardhedge"` represent past truth.

- [ ] **Leave as historical record** (recommended — no rewrite of past entries), OR
- [ ] **Bulk update** to `cardIdSource="cardsight"` (high cost, low value, distorts history)

---

# Section 6 — Honest accounting

## 6.1 — InventoryIQ design Section 1 empirical correction

[`docs/phase0/inventoryiq_design_2026-05-30.md`](docs/phase0/inventoryiq_design_2026-05-30.md) (commit [06a5d4e](https://github.com/HobbyIQ/boards/blob/06a5d4e/)) stated at lines 111 / 548 / 604 that `cardHedgeCardId` was persisted on `PortfolioLedgerEntry`. Phase 1 empirical grep of [portfolioStore.service.ts:198-255](backend/src/services/portfolioiq/portfolioStore.service.ts#L198-L255) and the type system refutes this — neither `PortfolioHolding` nor `PortfolioLedgerEntry` has the field.

**Net consequences:**
- The "ledger asymmetry / deferred cleanup" framing in InventoryIQ design Section 3.1 + 4 R1 rationale was overclaim
- R1 (adding `cardsightCardId` to PortfolioHolding) is still load-bearing for the canonicalization-bug class it eliminates; that argument doesn't depend on the (now refuted) ledger claim
- This CF's Phase 2 scope is **smaller** than the original "ledger migration" framing implied — there is no user-data migration, no Cosmos rewrite, no per-user ledger backfill

This is recorded as honest accounting; the InventoryIQ design doc itself stays as-is (historical record of what was believed at the time of writing — Section 1.4.2 historical-doc principle).

## 6.2 — Phase 2 scope is bigger than the SESSION_HANDOFF estimate

Phase 1 enumeration surfaced:
- MCP-server CH integration (separate from backend)
- `fn-nightly-comp-prefetch` + `cosmos_floor.py` CH dependencies (separate from `fn-cardhedge-comps`)
- The full sequencing structure requires 12 steps not 9

Net effect: original 4-6h estimate is too low; revised 10-16h reflects the actual surface. Drew should plan accordingly when scheduling.

## 6.3 — Compounding-value framing for the v1.5 grader CF (CF-CARDSIGHT-GRADES-ENDPOINT)

R1's Section 6.2 architectural boundary question (W2 cert-grader registry vs R2 cardsightGradeId) becomes more urgent post-this-CF: once CardHedge is dead, the only grader-data source is Cardsight, which makes the R2 + W2 boundary a more immediate design decision. Phase 2 kickoff should consider whether to pull CF-CARDSIGHT-GRADES-ENDPOINT forward in the sequence.

## 6.4 — No Category 6 needed

Phase 1 did not surface any CardHedge reference that didn't fit into Categories 1-5. The five-category framing from the kickoff held empirically.

---

# Phase 1 → Phase 2 transition

This document is the complete Phase 1 deliverable. Phase 2 (a SEPARATE next CF) implements the removal per the sequenced plan in Section 3, gated on the explicit Drew decisions in Section 5.

**Hard rule reminder:** Phase 1 is READ-ONLY. Zero code changes, zero env-var removals, zero schedule disables, zero subscription actions. This document is the only artifact.

**Standing by for Drew review before Phase 4 commit.**
