# CF-CARDSIGHT-COLLECTION-SURFACE-INVESTIGATION — collection management API surface enumeration + architecture A/B/C trade-off matrix

**Date:** 2026-05-30
**CF:** CF-CARDSIGHT-COLLECTION-SURFACE-INVESTIGATION (MEDIUM, captured during CF-CARDSIGHT-IDENTIFY-INTEGRATION Phase 1 on 2026-05-30; investigation completed same day)
**Status:** Read-only documentation review — NO code changes, NO live probes, NO SDK install
**Output:** This doc + a tight SESSION_HANDOFF.md ledger flip; no implementation produced
**Default decision preserved:** Architecture A (HobbyIQ-owned PortfolioHolding + Azure Blob photos, Cardsight as reference-only) — shipped at [c3a5c9e](https://github.com/HobbyIQ/HobbyIQ-V1/commit/c3a5c9e). This investigation does NOT change the default; it documents the trade-offs so future-Drew can make an informed B/C shift decision if a triggering condition surfaces.

---

## 1. Empirical surfacing — how this investigation started

During CF-CARDSIGHT-IDENTIFY-INTEGRATION Phase 1 (6-agent design workflow on 2026-05-30), Drew empirically discovered a Cardsight endpoint surface for user-collection persistence + per-user card image storage that extends beyond the identify/catalog/pricing reference surface previously catalogued in [`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md). The empirical signal was the URL pattern:

```
GET /v1/collection/{collectionId}/cards/{cardId}/image/thumb
```

This maps to the `get_collection_card_thumbnail` MCP tool from the 2026-05-29 enumeration ([`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md) §A2.2) — the prior doc had catalogued the tool name but didn't articulate the architectural implications of Cardsight's collection-management surface as a strategic question.

CF-CARDSIGHT-IDENTIFY-INTEGRATION shipped Architecture A (HobbyIQ-owned data, Cardsight reference-only) at [c3a5c9e](https://github.com/HobbyIQ/HobbyIQ-V1/commit/c3a5c9e). This investigation flips the open question to documentation-grade trade-off articulation so any future B/C decision rests on concrete cost/capability comparison rather than ad-hoc speculation.

### Scope discipline (verbatim from CF kickoff)

In scope:
- Read-only documentation review (Cardsight REST + SDK + MCP surface)
- Architecture A/B/C trade-off articulation with concrete implementation costs
- Strategic questions for future-Drew
- Output: this design doc

NOT in scope:
- Live probes against Cardsight collection endpoints (no credential exposure)
- Implementation of any collection-mirror logic
- Architecture decision (decision deferred until a triggering condition surfaces)
- Comparison to alternative vendors (Cardsight-focused only)

---

## 2. Cardsight collection API enumeration

Source authority: [`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md) §A2.2 enumerated the full 90-tool MCP surface via direct HTTP JSON-RPC against `mcp.cardsight.ai` (read-only protocol calls — `initialize`, `tools/list`, `resources/list`, `prompts/list`). The MCP server self-identifies as "**CardSightAI MCP Proxy v1.0.0**" — literally "MCP Proxy" — and the prior doc empirically confirmed 1:1 mapping between MCP tools and REST endpoints (the proxy proxies; it does not transform).

Per the 1:1 proxy invariant, each MCP tool corresponds to a REST endpoint at `api.cardsight.ai/v1/...`. REST paths below are **inferred** from the MCP tool names plus the empirical thumb-endpoint signal (which confirmed the `/v1/collection/{id}/cards/{id}/image/thumb` REST naming pattern). Paths NOT directly enumerated against REST are marked `(inferred)`.

### 2.1 Collections — collection lifecycle (12 tools)

| MCP tool | Inferred REST path | Read/write |
|---|---|---|
| `list_collections` | `GET /v1/collections` | read |
| `get_collection` | `GET /v1/collection/{id}` (inferred from thumb pattern) | read |
| `create_collection` | `POST /v1/collections` | **write** |
| `update_collection` | `PATCH /v1/collection/{id}` | **write** |
| `delete_collection` | `DELETE /v1/collection/{id}` | **write** |
| `list_collection_cards` | `GET /v1/collection/{id}/cards` | read |
| `add_collection_card` | `POST /v1/collection/{id}/cards` | **write** |
| `get_collection_card` | `GET /v1/collection/{id}/cards/{cardId}` | read |
| `update_collection_card` | `PATCH /v1/collection/{id}/cards/{cardId}` | **write** |
| `remove_collection_card` | `DELETE /v1/collection/{id}/cards/{cardId}` | **write** |
| `get_collection_analytics` | `GET /v1/collection/{id}/analytics` | read |
| `get_collection_breakdown` | `GET /v1/collection/{id}/breakdown` | read |

**Note:** `get_collection_analytics` and `get_collection_breakdown` are intriguing — Cardsight provides server-side aggregation over a collection. Shape NOT documented in fetchable sources (would require live probe to learn whether breakdown surfaces by manufacturer / year / parallel / grade tiers). Marked as `?` capability — present, shape unverified.

### 2.2 Collectors — user-account surface (5 tools, write-heavy)

| MCP tool | Inferred REST path | Read/write |
|---|---|---|
| `list_collectors` | `GET /v1/collectors` | read |
| `get_collector` | `GET /v1/collector/{id}` | read |
| `create_collector` | `POST /v1/collectors` | **write** |
| `update_collector` | `PATCH /v1/collector/{id}` | **write** |
| `delete_collector` | `DELETE /v1/collector/{id}` | **write** |

**Open question** (not resolvable from documentation): is a "collector" a Cardsight-side user account scoped per-tenant by API key, or a per-collection persona unrelated to identity? If a Collector entity is required to scope collections, then HobbyIQ would need to bootstrap a Collector for each HobbyIQ user OR re-use a single Collector for all HobbyIQ users + partition collections internally. Both have downstream implications captured in §4. **Unverified**.

### 2.3 Collection card images — per-card-per-user image storage (4-5 tools)

| MCP tool | Inferred REST path | Read/write |
|---|---|---|
| `get_collection_card_image` | `GET /v1/collection/{id}/cards/{cardId}/image` | read |
| `get_collection_card_thumbnail` | `GET /v1/collection/{id}/cards/{cardId}/image/thumb` | read (empirically confirmed) |
| `list_collection_set_progress` | `GET /v1/collection/{id}/sets/progress` | read |
| `get_collection_set_progress` | `GET /v1/collection/{id}/sets/{setId}/progress` | read |
| `get_collection_set_progress_parallel` | `GET /v1/collection/{id}/sets/{setId}/parallels/{parallelId}/progress` | read |

**Key inference:** Cardsight has per-collection-per-card image storage AND infrastructure to compute "set-completion progress" per collection. The latter would be valuable if HobbyIQ ever wanted to surface "how close are you to completing this set?" UX (not in current scope). Image storage at the collection-card-tuple level means an attached image is per-user-per-card, not catalog-card-shared.

**Image UPLOAD path NOT enumerated.** The 4-5 tools above are read-only. Cardsight presumably accepts image uploads via either (a) a separate REST endpoint not surfaced as an MCP tool (uploads are write-y and might be REST-only), (b) attached to `add_collection_card` / `update_collection_card` body as multipart, or (c) some other path. **Unverified.** This matters for architecture B/C cost — if uploads are multipart-on-add-card, the integration cost is moderate; if there's a separate two-step upload endpoint, costs increase.

### 2.4 Binders — sub-organization within collections (8 tools)

| MCP tool | Inferred REST path | Read/write |
|---|---|---|
| `list_binders` | `GET /v1/collection/{id}/binders` | read |
| `get_binder` | `GET /v1/binder/{id}` | read |
| `create_binder` | `POST /v1/collection/{id}/binders` | **write** |
| `update_binder` | `PATCH /v1/binder/{id}` | **write** |
| `delete_binder` | `DELETE /v1/binder/{id}` | **write** |
| `list_binder_cards` | `GET /v1/binder/{id}/cards` | read |
| `add_binder_card` | `POST /v1/binder/{id}/cards` | **write** |
| `remove_binder_card` | `DELETE /v1/binder/{id}/cards/{cardId}` | **write** |

Binders look like Cardsight's analog of "albums" or "sub-collections." Likely useful if HobbyIQ ever needed multi-tier portfolio grouping (e.g. "PC binder," "investment binder," "for-sale binder"). Currently HobbyIQ's PortfolioHolding has no binder concept; everything is single-flat per user.

### 2.5 Want lists — desired-cards surface (8 tools)

| MCP tool | Inferred REST path | Read/write |
|---|---|---|
| `list_lists` | `GET /v1/lists` | read |
| `get_list` | `GET /v1/list/{id}` | read |
| `create_list` | `POST /v1/lists` | **write** |
| `update_list` | `PATCH /v1/list/{id}` | **write** |
| `delete_list` | `DELETE /v1/list/{id}` | **write** |
| `list_list_cards` | `GET /v1/list/{id}/cards` | read |
| `add_list_card` | `POST /v1/list/{id}/cards` | **write** |
| `remove_list_card` | `DELETE /v1/list/{id}/cards/{cardId}` | **write** |

Want-lists are Cardsight's analog of "wishlist" / "watchlist." HobbyIQ has its own watchlist feature (separate model) — these are NOT federated today.

### 2.6 Auth model

Per the 1:1 proxy invariant + [`cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) precedent, the same `X-API-Key: $CARDSIGHT_API_KEY` header authenticates the entire surface. The MCP proxy accepts the key as either header or `?k=` query param.

**UNVERIFIED:**
- Whether HobbyIQ's current `CARDSIGHT_API_KEY` (currently scoped for catalog/pricing/identify reads + identify writes per CF-CARDSIGHT-IDENTIFY-INTEGRATION) has collection write permission, OR whether collection writes require a different API key tier (e.g. "developer" vs "production," "collector" account-bound key)
- Whether collection write operations count against the same ~8 req/s rate limit observed empirically on the catalog endpoints, or a separate (potentially tighter) write-rate limit
- How Cardsight's "free 750 calls/month" tier (marketing claim from prior doc §4) distributes across read-vs-write operations — collection writes might consume the same quota slot as catalog reads, or might be on a different quota
- Whether collection writes are billed differently from reads under Cardsight's paid tier (if any)

Each of these is a one-probe verification at any future B/C kickoff (a single `POST /v1/collections` returning 200 vs 401/402/403 would resolve auth scope + tier; a flurry of writes would surface rate limits). Out of scope for this read-only investigation.

### 2.7 Composability with identify endpoint (architectural observation, not a tool)

CF-CARDSIGHT-IDENTIFY-INTEGRATION shipped `POST /api/portfolio/identify` calling Cardsight's `POST /v1/identify`. The identify response includes a `card.id` (catalog UUID) for each detection. The collection surface uses the same UUID as `cardId` in `add_collection_card`. So architecturally, Cardsight supports the workflow:

```
identify → detection.card.id → add_collection_card({collectionId, cardId, gradeId?})
```

… as a composed "identify and persist" two-call flow. Cardsight does NOT (per the MCP tool enumeration) expose a single-call "identify-and-persist" combined operation. The 1:1 proxy nature means whichever flow we wanted, we'd compose it client-side or backend-side.

---

## 3. HobbyIQ current state — what we have today

### 3.1 PortfolioHolding model surface ([`backend/src/types/portfolioiq.types.ts`](../../backend/src/types/portfolioiq.types.ts))

```ts
export interface PortfolioHolding {
  id: string;                                  // HobbyIQ-internal Cosmos partition key
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  brand?: string;
  setName?: string;
  cardNumber?: string;
  product?: string;
  parallel?: string;
  // ... 80+ optional fields including:
  gradeCompany?: string;                       // PSA / BGS / SGC / CGC
  gradeValue?: number;
  certNumber?: string | null;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
  cardsightCardId?: string | null;             // R1 — Cardsight catalog FK (06a5d4e)
  cardsightGradeId?: string | null;            // R2 — Cardsight grade taxonomy FK (3a3ee0b)
  photos?: string[];                           // Azure Blob URLs (multi-photo support)
  clientId?: string;                           // iOS-generated stable identifier for upsert
  // pricing + analytics fields:
  fairMarketValue?: number;
  predictedPrice?: number | null;              // CF-NEXT-SALE-PREDICTION-LAYER (8bd2487)
  movementDirection?: string | null;           // CF-AUTOPRICE-PERSIST-TRENDIQ (12de7c1)
  // ... plus eBay listing back-references, freshness state, MLB playerId, etc.
}
```

**Key observations for the federation question:**

- HobbyIQ already adopted Cardsight FKs as **supplementary** identity (R1 cardsightCardId, R2 cardsightGradeId) — NOT as replacements. Holdings remain valid with text-only fields when Cardsight doesn't match.
- Photos are Azure Blob URLs in a HobbyIQ-controlled storage account (`stghobbyiqdev` / container `card-images`), provisioned via the existing SAS upload pattern at [`photoStorage.service.ts`](../../backend/src/services/photoStorage/photoStorage.service.ts). Vendor-independent.
- Pricing + analytics fields (FMV, predictedPrice, movement*, trend, recommendation, verdict, etc.) are HobbyIQ-computed and stored on the holding — these have no Cardsight-side equivalent.
- eBay listing back-references (`ebayOfferId`, `ebayListingId`, `ebayListingPublishedAt`) tie holdings into HobbyIQ's listing flow — also no Cardsight equivalent.

### 3.2 Current Cardsight client surface ([`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts))

Endpoints called:
- `GET /v1/catalog/search` — text search to enumerate candidate cards
- `GET /v1/catalog/cards/{cardId}` — detail with `parallels[]`
- `GET /v1/pricing/{cardId}` — completed-sales pricing (raw + graded by company/grade)
- `GET /v1/grades/companies` + drill-down — taxonomy resolver (R2 path, [`cardsightGradesTaxonomy.ts`](../../backend/src/services/cardsight/cardsightGradesTaxonomy.ts))
- `POST /v1/identify` — image-based card+grade detection (c3a5c9e, this CF's predecessor)

**No collection endpoints called.** No `list_collections`, no `add_collection_card`, no `get_collection_card_image`. The entire collection surface in Cardsight is currently un-integrated from HobbyIQ.

### 3.3 Image storage current state

- iOS PUTs slab images via the SAS upload flow at `POST /api/uploads/card-photo` → Azure Blob
- The permanent blob URL is stored on `PortfolioHolding.photos[]`
- CF-CARDSIGHT-IDENTIFY-INTEGRATION's `POST /api/portfolio/identify` downloads the blob bytes and forwards them to Cardsight identify — Cardsight RECEIVES the bytes but does NOT persist them to its own collection-card-image storage. The bytes are processed for detection and (per Cardsight's privacy/retention policy, NOT verified) presumably discarded after processing.

So: HobbyIQ holds the only persistent copy of slab images today. There is no parallel image stored on Cardsight's collection-card surface.

### 3.4 User scoping

PortfolioHolding is partitioned per-user in Cosmos. Each HobbyIQ user has their own holdings. No cross-user holding-sharing today.

If HobbyIQ federated to Cardsight collections, the natural model is one HobbyIQ-user-per-Cardsight-collection (or one Cardsight Collector per HobbyIQ user, each owning one or more collections). The exact federation pattern is a design call at any B/C kickoff.

---

## 4. Architecture A / B / C trade-off matrix

### 4.1 Definitions

**Architecture A — HobbyIQ-owned data, Cardsight reference-only (SHIPPED at c3a5c9e):**
- `PortfolioHolding` in Cosmos = source of truth
- Photos in Azure Blob = source of truth
- Cardsight calls: catalog search/detail, pricing, grades taxonomy, identify
- No collection endpoint integration

**Architecture B — Cardsight-owned data, HobbyIQ reference-only:**
- Cardsight collection-card = source of truth
- Images in Cardsight collection-card-image storage = source of truth
- HobbyIQ stores: per-user `cardsightCollectorId` + `cardsightCollectionId`; per-holding `cardsightCardId` (already on type) + `cardsightCollectionCardId` (new FK)
- HobbyIQ Cosmos becomes a thin index over Cardsight data: pricing / movement / analytics fields stay local (no Cardsight equivalent), but identity / image / parallel data lives on Cardsight

**Architecture C — Hybrid (HobbyIQ source-of-truth, Cardsight mirror for capability access):**
- `PortfolioHolding` in Cosmos = source of truth (unchanged from A)
- Photos in Azure Blob = source of truth (unchanged from A)
- Cardsight collection MIRROR: each HobbyIQ holding also persisted as a Cardsight collection-card; image dual-stored (Azure Blob original + Cardsight mirror); sync via write-back from HobbyIQ write paths
- Cardsight capability access: collection analytics, set progress, breakdown, want lists, binders — available as supplementary features when Cardsight's aggregation surface is useful

### 4.2 Trade-off matrix (concrete)

| Dimension | A (shipped) | B (Cardsight-owned) | C (Hybrid mirror) |
|---|---|---|---|
| **Implementation cost** | $0 (shipped) | ~40-80h — full rewrite of portfolioStore + photoStorage; iOS rewrite of all holding-list/detail surfaces; new error-mapping/retry/sync layer; cert+grade FK re-anchoring; eBay listing back-references stay HobbyIQ-side but cross-refs change | ~20-40h — mirror layer at write paths (create/update/delete holding); image-upload fan-out (Azure + Cardsight); reconciliation script for existing 23 holdings backfill; eventual-consistency reconciliation job |
| **Storage cost (monthly)** | Azure Blob (1×) + Cosmos | Cardsight (1×) + Cosmos (slim index) | Azure Blob (1×) + Cosmos + Cardsight mirror (1× extra image storage; Cardsight pricing unknown) |
| **Request-volume cost** | 1×/holding for identify + reprice; collection NOT touched | 1×/holding for every read (no Cosmos cache; user opens dashboard → N Cardsight reads/page) | 1×/holding write to BOTH Cosmos + Cardsight (2× write fan-out); reads stay Cosmos (no Cardsight fan-out) |
| **Rate-limit exposure** | Low (today's ~8 req/s observed limit is binding only during catalog estimate fan-out + identify) | HIGH — every PortfolioHolding read becomes a Cardsight call; at 100-tier launch traffic, holdings list-load could trip the rate limit immediately | MEDIUM — mirror writes fan out 2×; reads unchanged; sync-reconciliation job adds background pressure |
| **Vendor lock-in** | Low — Cardsight FKs (cardsightCardId, cardsightGradeId) supplementary; text-only fallback always works; data migration if leaving Cardsight = lose FKs but retain full holding data | HIGH — if Cardsight contract terminates / pricing changes / quality degrades, ALL primary identity + ALL images must be re-fetched from Cardsight before contract end; non-portable | LOW-MEDIUM — primary data stays HobbyIQ-side; Cardsight mirror is supplementary; leaving Cardsight = abandon the mirror, keep the source-of-truth |
| **Migration friction (off Cardsight)** | None (no primary data on Cardsight) | Heavy (full data export from Cardsight required before contract end; multi-week project) | Light (mirror is supplementary; abandon and continue) |
| **Capability access — collection analytics / breakdown** | None (Cardsight aggregation surface unused) | Native (analytics + breakdown are direct Cardsight calls) | Native after mirror sync (same as B once mirror is populated) |
| **Capability access — set progress** | None | Native | Native after mirror sync |
| **Capability access — want lists, binders** | None | Native (federated identity model) | Native if mirror layer extended to want-lists/binders |
| **Image fidelity** | Full (HobbyIQ controls original) | Cardsight's collection-card-image resolution / format / retention policy applies — **unverified** | Full original (Azure Blob) + whatever-Cardsight-gives mirror |
| **Multi-user data isolation** | Cosmos per-user partition; HobbyIQ controls auth boundary | Cardsight Collector-per-user; HobbyIQ → Cardsight auth boundary — **unverified** whether Cardsight supports tenant-scoped sub-accounts under one API key | Same as A for primary; mirror's user-scoping inherits B's model |
| **eBay listing back-references** | First-class (`ebayOfferId`, `ebayListingId`, `ebayListingPublishedAt` on PortfolioHolding) | Must layer back-references on top of Cardsight's collection-card record OR keep HobbyIQ-side shim that maps cardsightCollectionCardId → ebayOfferId | Unchanged from A |
| **HobbyIQ pricing/analytics fields** | First-class on PortfolioHolding (FMV, predictedPrice, movement*, recommendation, verdict, etc.) | Must layer on top of Cardsight's collection-card OR keep HobbyIQ-side shim that maps cardsightCollectionCardId → analytics | Unchanged from A |
| **Outage resilience** | Cardsight outage = identify down, catalog/pricing down, BUT holdings + photos remain readable from Cosmos+Blob; HobbyIQ continues serving stored data | Cardsight outage = HobbyIQ portfolio dashboard down; cannot read holdings | Cardsight outage = mirror writes fail (queued retry); reads unaffected; HobbyIQ continues serving |
| **Risk profile (data loss)** | Standard (Azure SLA on Cosmos + Blob) | Cardsight SLA + retention policy — **unverified** | Standard (HobbyIQ-side) + best-effort on mirror |

### 4.3 Capability matrix — what Cardsight collection surface offers that HobbyIQ doesn't have today

| Capability | Cardsight surface | HobbyIQ today | Net value (subjective, would-be-confirmed at B/C kickoff) |
|---|---|---|---|
| Collection analytics (server-side aggregation) | `get_collection_analytics` | Custom-built (PortfolioMovementDetailView, weekly brief, portfolio health score) — already shipped | Cardsight-native might be richer / cheaper to extend; HobbyIQ has custom IP (TrendIQ, movement signals, predictedPrice) Cardsight can't replicate |
| Collection breakdown (by manufacturer/year/parallel/grade tiers) | `get_collection_breakdown` | Custom-built via PortfolioInventoryView grouping | Cardsight-native could simplify HobbyIQ-side logic |
| Set completion progress | `list_collection_set_progress`, `get_collection_set_progress`, `get_collection_set_progress_parallel` | NOT implemented | Net-new capability if Cardsight provides it well; user-facing UX value unclear without product-research |
| Per-card image storage | `get_collection_card_image`, `get_collection_card_thumbnail` | Azure Blob with permanent URL on `photos[]` | Cardsight provides thumbnail variant out-of-box (HobbyIQ does NOT generate thumbnails today; iOS likely shows full-res on dashboard which is bandwidth-heavy at scale) |
| Sub-collection grouping (binders) | `*_binder_*` (8 tools) | NOT implemented | Net-new capability; UX value depends on whether users want multi-bucket portfolio grouping |
| Want lists | `*_list_*` (8 tools) | Custom WatchlistView in iOS | Cardsight-native might be richer (cross-card want lists); HobbyIQ's WatchlistView is bespoke |
| Identify → persist (combined) | NOT exposed as single call; compose via `identify` + `add_collection_card` | iOS-side: identify → user confirms → add holding (custom flow) | Federation via B/C makes the "identify → persist as Cardsight collection-card" path one fewer hop |

**Summary of capability comparison:** Cardsight's collection surface offers some net-new capabilities (set progress, binders, server-side analytics) but does NOT replace HobbyIQ's load-bearing custom IP (TrendIQ, predictedPrice, movement signals, eBay listing back-references, custom recommendation/verdict logic). The integration value is **supplementary**, not **substitutional**.

---

## 5. Strategic questions for future-Drew at any B/C kickoff

These are the questions that determine whether a triggering condition warrants a B or C shift. None of them is resolvable from documentation alone — each requires a product / UX / strategic call.

### 5.1 Does iOS UX have or want a "user manages a collection" feature that benefits from Cardsight's collection capabilities?

- HobbyIQ's product positioning is "actionable seller intelligence" (per [`project_product_actionable_seller_intelligence`] memory anchor) — timed action recommendations, not collection-management UX
- Set-completion progress, binders, want-lists are collection-management UX patterns adjacent to but distinct from seller intelligence
- **Decision input:** product roadmap — does v1+ include any of these collection-management features? If yes, Cardsight federation reduces backend-build cost. If no, the federation buy is for capabilities we don't surface.

### 5.2 Does HobbyIQ's image-storage strategy permit a vendor-side mirror or hand-off?

**Trigger framing:** Does HobbyIQ have legal/compliance commitments OR product-UX requirements that REQUIRE Azure Blob remain the sole image storage?

- Today: Azure Blob is HobbyIQ-side storage with controlled SAS upload pattern, blob-level access control, lifecycle policies under HobbyIQ control
- Architecture B would shift image source-of-truth to Cardsight; Architecture C would dual-store
- **If yes (commitments require Azure Blob):** A holds. Architecture B is off the table; C remains possible if mirror-copy is acceptable under the commitment
- **If no (no constraint):** revisit B and C; image-storage cost + Cardsight thumbnail-out-of-box capability become decision inputs (HobbyIQ does NOT generate thumbnails today; iOS likely shows full-res on dashboard which is bandwidth-heavy at scale)
- **Verification path:** legal/compliance review of Cardsight's image storage GDPR/CCPA/state-equivalent posture; product review of full-resolution vs re-rendered image fidelity tolerance

### 5.3 Does HobbyIQ's analytics surface need server-side aggregation Cardsight performs?

**Trigger framing:** Does HobbyIQ-side TrendIQ + movement + predictedPrice + recommendation logic scale at launch traffic? Does Cardsight's collection-scoped aggregation surface (`get_collection_analytics`, `get_collection_breakdown`, `*_set_progress`) produce UX-visible output HobbyIQ would otherwise build?

- Identify endpoint (`POST /v1/identify`) already works without collection persistence — CF-CARDSIGHT-IDENTIFY-INTEGRATION at c3a5c9e proves identify does not REQUIRE collection integration
- `get_collection_analytics`, `get_collection_breakdown`, `set_progress` endpoints REQUIRE a Cardsight collection to exist before they can be queried (federation is a hard precondition for these capabilities)
- **If yes (HobbyIQ analytics has scaling problem OR Cardsight aggregation produces UX-visible output):** revisit; the cost of federation B/C is offset by avoided HobbyIQ-side build cost OR by capability access
- **If no (HobbyIQ analytics scales fine, no UX demand for aggregation):** A holds. Cardsight's aggregation surface is unused capability with no payoff
- **Current empirical answer:** appears to be no — HobbyIQ's TrendIQ + movement signals + predictedPrice are HobbyIQ-IP (not aggregations Cardsight could perform); analytics scales fine at current single-user state; no surfaced demand for set-progress / binders / want-lists UX
- **Verification path:** launch-traffic load-test of HobbyIQ analytics scaling; product roadmap review of v1.5+/v2 features that would surface set-progress / breakdown / binders

### 5.4 Does HobbyIQ's API key model support multi-tenant collection scoping under Cardsight's auth model?

- **UNVERIFIED:** whether Cardsight supports tenant-scoped sub-accounts (one HobbyIQ API key → many Collectors → each Collector owns their own collections)
- **UNVERIFIED:** whether Cardsight has rate-limit / billing tiers that distinguish "platform key with sub-tenants" from "single-collector key"
- **Decision input:** these are questions to resolve in any B/C kickoff Phase 1, not before

### 5.5 What's the cost trajectory of Cardsight pricing as HobbyIQ scales?

- Today: HobbyIQ pays for catalog + pricing + identify reads (per-call against the observed ~8 req/s + free 750/month tier)
- B/C federation: HobbyIQ would also pay for collection writes + image storage at Cardsight tier (pricing **unverified**)
- **Decision input:** Cardsight pricing at 1K-user / 10K-user / 100K-user tiers — needs vendor-conversation OR account-dashboard inspection at decision time, NOT extractable from public docs

---

## 6. Recommendation — preserve Architecture A as default

**Default holds:** Architecture A as shipped at c3a5c9e is the right choice for current state. The investigation produces no new evidence to revisit it; it surfaces concrete trade-offs for future-Drew if any of the triggering conditions in §7 surface.

### 6.1 Why A holds today

- **Vendor independence is load-bearing for current product strategy.** HobbyIQ's value prop is "actionable seller intelligence" — the data IS the product. Storing the data on a vendor's collection surface is misaligned with that positioning.
- **HobbyIQ's pricing/analytics fields have no Cardsight equivalent.** TrendIQ, predictedPrice, movement signals, eBay listing back-references, custom recommendation/verdict logic — all are HobbyIQ-IP. Federation would require a HobbyIQ-side shim regardless, defeating the simplicity argument for federation.
- **Cardsight outage resilience** — Architecture A preserves dashboard read availability during a Cardsight outage; Architecture B does not.
- **Migration cost is sunk for A; B/C carries substantial implementation cost** (40-80h B; 20-40h C) without clear product-side justification.

### 6.2 Pre-conditions that would trigger revisiting B or C

If any of the following surface, run a follow-up CF to re-evaluate:

1. **Product decision to ship set-completion / binders / want-list features.** Cardsight's surface offers these out-of-box; HobbyIQ would otherwise build them. Federation breaks-even somewhere between "build all three custom in HobbyIQ" and "integrate Cardsight's surface."
2. **Cardsight pricing model change** that makes federation cheaper per request than HobbyIQ-side storage at HobbyIQ's expected scale.
3. **Cardsight publishes a "platform tenant" auth model** that supports HobbyIQ multi-tenant integration cleanly (today's auth model — single API key — doesn't obviously support tenant-isolated collection writes).
4. **HobbyIQ-side custom analytics surface stops scaling** (e.g. movement signal computation becomes too expensive at launch traffic) AND Cardsight's analytics surface produces output the product needs.
5. **A new HobbyIQ feature emerges that fundamentally requires Cardsight's collection scope** (e.g. cross-user collection sharing where Cardsight's identity model is the simpler primitive than building HobbyIQ-side sharing infra).

### 6.3 What NOT to do as a result of this investigation

Concrete antipatterns — these are the specific mistakes the investigation's findings let us name in advance:

- **Do NOT commit to Architecture B (or C) without first verifying that `CARDSIGHT_API_KEY` has collection write scope.** The current key is empirically known to work for catalog reads + pricing reads + identify POST; whether it grants `POST /v1/collections`, `POST /v1/collection/{id}/cards`, image-upload routes, etc. is **unverified** (§2.6 + §8). One read-only probe at any B/C CF Phase 1 resolves this; do not assume.
- **Do NOT assume Cardsight collection storage is free or quota-equivalent to catalog reads.** §2.6 and §8 explicitly flag pricing trajectory + per-endpoint quota distribution as unverified. Architecture B's monthly cost at 1K-user / 10K-user / 100K-user scale is unknown today; a B/C decision without a vendor pricing conversation OR `get_subscription` probe is decision-by-vibes.
- **Do NOT migrate existing PortfolioHolding records (23 today; thousands at launch) to Cardsight before verifying that data export is supported on contract termination AND that Cardsight collection deletes are recoverable for at least N days.** Cardsight's data-retention + portability policy is **unverified**; a migration without this confirmation creates non-portable single-vendor lock-in (matrix row "Migration friction (off Cardsight)" — Architecture B is "Heavy / multi-week project to export from Cardsight").
- **Do NOT ship Architecture B or C purely for backend simplicity.** Either architecture only pays off if iOS UX surfaces a concrete user-facing feature backed by Cardsight's collection capabilities (set-completion progress, binder/sub-collection management, want-lists, server-side analytics/breakdown that produces UX-visible output). A backend mirror without UX value adds complexity (sync, reconciliation, error-mapping) without product gain.
- **Do NOT pre-integrate collection writes "just in case."** YAGNI applies; integration cost is non-zero (~20-80h depending on architecture) and the trigger conditions are unrealized.
- **Do NOT change the c3a5c9e ship.** Architecture A is correct for current state; this investigation produces no evidence to revisit.

### 6.4 REST path verification is required Phase 1 work for any B/C CF — call-out

REST paths in §2 are **inferred** from a single empirical anchor: the 1:1 MCP-to-REST proxy behavior observed for catalog drill-down in [`cardsight_grades_endpoint_eval_2026-05-29.md`](cardsight_grades_endpoint_eval_2026-05-29.md) + the single thumb-endpoint signal Drew empirically discovered (`/v1/collection/{id}/cards/{id}/image/thumb`, matching `get_collection_card_thumbnail`).

**This CF did NOT verify collection REST paths empirically.** Any Architecture B or Architecture C implementation CF MUST include REST path verification as Phase 1 work — single read-only probes against each endpoint signature before committing to the integration shape. The inferences may be exactly right (the proxy invariant is robust where tested) or wrong at the edges (e.g. `POST /v1/collections` vs `POST /v1/collection`; PATCH vs PUT for updates; nested path style for binders/want-lists). Cost: ~10-15 read-only probes at any B/C CF Phase 1, well within the budget the unverified-items table in §8 already lines up.

This is not a hypothetical risk — it's the explicit reason §8 exists and why the §2 paths are flagged `(inferred)`. Do not treat the inferred paths as production-ready without verification.

---

## 7. Future CF candidates surfacing from investigation

These are captured here as named future CFs to make them findable when a trigger condition fires. They are NOT in any active backlog today; they exist as breadcrumbs.

### 7.1 CF-CARDSIGHT-COLLECTION-MIRROR (Architecture B implementation)

**Trigger:** decision to make Cardsight collection the source of truth.

**Scope:** rewrite portfolioStore.service.ts to back PortfolioHolding reads/writes via Cardsight collection endpoints; migrate 23 existing holdings; re-anchor cert + grade FKs to Cardsight collection-card records; iOS rewrite of holding-list/detail surfaces; new sync/reconciliation layer; eBay listing back-reference shim.

**Estimate:** ~40-80h depending on iOS surface area.

**Pre-flight:** verify auth scope (key has collection write permission), rate-limit tier (collection writes count), pricing trajectory, Collector entity semantics — each via single read-only probe.

### 7.2 CF-CARDSIGHT-COLLECTION-HYBRID (Architecture C implementation)

**Trigger:** decision to keep HobbyIQ as source of truth but add a Cardsight mirror for capability access.

**Scope:** add mirror writes to portfolioStore.service.ts create/update/delete paths (write fan-out to BOTH Cosmos and Cardsight); image upload fan-out to BOTH Azure Blob and Cardsight collection-card image storage; reconciliation script for 23 existing holdings backfill; eventual-consistency background sync job; analytics surface to consume Cardsight's `get_collection_analytics` / `get_collection_breakdown` / `set_progress` capabilities as supplementary insights.

**Estimate:** ~20-40h.

**Pre-flight:** same as §7.1 plus an image-upload write probe to learn whether uploads are multipart-on-add-card or two-step.

### 7.3 CF-CARDSIGHT-COLLECTION-UX-INTEGRATION

**Trigger:** product decision to surface user-collection UX (set progress, binders, want lists).

**Scope:** UX design + backend coordination — depends on which Cardsight-collection capabilities the UX wants to surface.

**Estimate:** unbounded until UX scope is defined.

**Pre-condition:** completion of either §7.1 or §7.2 (UX integration requires a Cardsight collection to exist).

### 7.4 CF-CARDSIGHT-COLLECTION-ANALYTICS-PROBE (lightweight investigation, smaller than full B/C)

**Trigger:** curiosity about whether Cardsight's server-side analytics surface produces meaningfully different output than HobbyIQ's custom analytics — could inform a partial-integration decision short of full B/C.

**Scope:** create a Cardsight test collection (single holding), populate via REST writes, probe `get_collection_analytics` / `get_collection_breakdown` / `set_progress` for response shape + content quality, write up findings.

**Estimate:** ~2-4h.

**Justification:** lower-cost than full B/C; would resolve the "Cardsight analytics quality" unknown that's currently an input to the §6 recommendation. Could be run before any of §7.1-§7.3 if product wants signal on whether Cardsight-native analytics is worth integrating.

---

## 8. Unverified items, captured honestly

This investigation operated read-only. The following items are NOT empirically confirmed and would require live probes at any B/C kickoff:

| Item | Verification method | Verification cost |
|---|---|---|
| Auth scope of `CARDSIGHT_API_KEY` on collection write endpoints | Single `POST /v1/collections` probe; observe 200 vs 401/402/403 | 1 call |
| Rate limit for collection writes | Burst write probe (10-20 sequential `POST`s in <1s); observe 429 timing | ~20 calls |
| Free-tier quota distribution (whether collection writes count separately) | `get_subscription` probe pre-and-post a small write burst; observe quota delta | 2-3 calls |
| Cardsight pricing at scale tier | Vendor conversation OR `app.cardsight.ai` dashboard inspection | Out-of-band |
| Image upload pattern (multipart-on-add vs two-step) | One `POST /v1/collection/{id}/cards` with multipart image body; observe success path | 1 call |
| Collection card image storage retention policy | Out-of-band (vendor docs / privacy policy) | Out-of-band |
| Collector entity semantics (multi-tenant scope) | `POST /v1/collectors` from one API key, then `list_collectors` from same key; observe whether returned list scopes by key or globally | 2 calls |
| Set-progress endpoint response shape and quality | Single `GET /v1/collection/{id}/sets/{setId}/progress` against a populated collection | 1 call |
| `get_collection_analytics` and `get_collection_breakdown` response shape | Single `GET` against a populated test collection | 2 calls |
| Cardsight outage resilience / SLA | Vendor docs / SLA contract | Out-of-band |
| Cross-grader cert federation (e.g. would Cardsight collection store certNumber + certGrader for a holding identified via PSA cert?) | `update_collection_card` probe with cert payload; observe accepted field set | 1 call |

**Total in-band verification cost** for a complete B/C-readiness empirical pass: ~30 calls — well within the rate-limit + free-tier budget; doable in a focused ~30-60min session at B/C kickoff.

---

## 9. References

- [c3a5c9e](https://github.com/HobbyIQ/HobbyIQ-V1/commit/c3a5c9e) — CF-CARDSIGHT-IDENTIFY-INTEGRATION; Architecture A shipped (the architectural baseline this investigation does not propose changing)
- [006176d](https://github.com/HobbyIQ/HobbyIQ-V1/commit/006176d) — CF-CARDSIGHT-GRADES-ENDPOINT-EVAL; precedent for read-only Cardsight surface investigation discipline
- [34ccfcb + 2aebd29](https://github.com/HobbyIQ/HobbyIQ-V1/commit/34ccfcb) — Cardsight published SDK + MCP tool enumeration ([`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md))
- [`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md) §A2.2 — primary source for MCP tool enumeration (37 collection-related tools across collections / collectors / collection card images / binders / want lists)
- [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) — current HobbyIQ Cardsight client (catalog + pricing + identify; no collection endpoints)
- [`backend/src/services/cardsight/identify.service.ts`](../../backend/src/services/cardsight/identify.service.ts) — CF-CARDSIGHT-IDENTIFY-INTEGRATION service surface (Architecture A's identify-only consumer)
- [`backend/src/services/cardsight/cardsightGradesTaxonomy.ts`](../../backend/src/services/cardsight/cardsightGradesTaxonomy.ts) — R2 grades taxonomy resolver (Architecture A's grades consumer)
- [`backend/src/services/photoStorage/photoStorage.service.ts`](../../backend/src/services/photoStorage/photoStorage.service.ts) — Azure Blob storage (Architecture A's image source-of-truth)
- [`backend/src/types/portfolioiq.types.ts`](../../backend/src/types/portfolioiq.types.ts) — `PortfolioHolding` model (Architecture A's source-of-truth)

---

## 10. Investigation scope discipline upheld

- ✅ Read-only documentation review only (no live Cardsight calls beyond what prior docs already captured)
- ✅ No SDK install
- ✅ No `cardsightai` package added to any HobbyIQ repo
- ✅ No code changes — pure documentation output
- ✅ No speculation beyond what documentation reveals; unknowns marked as "unverified" honestly
- ✅ No architecture decision proposed — Architecture A holds as default per c3a5c9e; B/C captured as future options with concrete trigger conditions
- ✅ No implementation of B or C
- ✅ No probe-credentials handled — investigation used prior-doc enumeration

This investigation outputs documentation + an updated handoff ledger; nothing else.
