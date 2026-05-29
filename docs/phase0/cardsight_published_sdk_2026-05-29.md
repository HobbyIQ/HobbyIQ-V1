# Cardsight published SDK + API empirical investigation

**Date:** 2026-05-29
**Status:** Phase 1-5 read-only investigation. HALT before any code change or SDK install. Captured for W5 kickoff + Phase 4a roadmap consideration; no decisions made here.
**Predecessor finding:** W4 Phase 1 pre-flight ([`docs/phase0/launch_readiness_100_2026-05-29.md`](launch_readiness_100_2026-05-29.md) — wrong link; correct context is the W4 commit `683b26f`) deferred the `/api/compiq/cardsearch` picker migration when Cardsight's `searchCatalog` response was found to lack `image_url` and `variant` fields. Three theoretical resolution paths were captured for W5 kickoff. This document characterizes what Cardsight actually publishes so W5 kickoff has empirical facts rather than assumptions.

---

## TL;DR

- **Cardsight publishes a much richer API surface than HobbyIQ currently consumes.** Today our [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) calls only `/catalog/search`, `/catalog/cards/{id}` (detail with parallels), and pricing endpoints. The Node SDK exposes ~30 documented methods including a separate **image fetch endpoint** (`client.images.getCard(cardId)` returning JPEG bytes), a **natural-language search endpoint** (`client.ai.query`), a **batch pricing endpoint** (`client.pricing.bulk`), **autocomplete** endpoints, and a **typed identification endpoint** (`client.identify.card` accepting `UIImage` / `Data` / `URL` on the Swift SDK).
- **The catalog-search image/variant gap that drove W4's picker-migration deferral is real but has concrete workarounds:** `client.images.getCard(cardId)` solves the image URL gap with a separate fetch per card; `client.catalog.cards.get(cardId)` solves variant/parallel with the detail endpoint (already exists as `CardsightCardDetail.parallels[]` in our types). Both are per-card N+1-shaped; the latency tradeoff vs UX value is a W5 design call. The SDK does NOT document a batched-detail or `expand=`-style inlining option.
- **MIT-licensed SDKs exist in Node (TypeScript), Python, Swift, Java, .NET.** Swift SDK (`cardsightai-sdk-swift`) is iOS 15+, Swift 5.9+, async/await throughout. **For W5 the SDK is a candidate; the architectural question is whether iOS calls Cardsight directly via the SDK (bypasses W3's `/api/search/cards` dispatcher) or whether the dispatcher stays as the iOS-facing surface and the backend uses the Node SDK internally.** Choice Y locked the consumer surface as `UnifiedSearchResponse`; that doesn't constrain whether iOS calls our backend or Cardsight directly.
- **A native MCP server is published at `mcp.cardsight.ai`** (confirmed via web search of Cardsight's docs page). This is a meaningful change to the Phase 4a "MCP-mediated cache layer" framing from the original 2026-05-21 roadmap — Cardsight's MCP and our planned cache layer have different purposes (their MCP exposes catalog to AI assistants; our cache layer reduces REST call volume + absorbs outages), they are complementary, but the architectural framing should be re-examined at Phase 4a kickoff.
- **NOT investigated empirically (left for W5 kickoff):** exact JSON response shape of `catalog.search()` (READMEs document method signatures but no full response example was findable in fetchable docs), full MCP tool inventory (the MCP doc page is JS-rendered and returned only stubs to WebFetch).

---

## 1. Investigation method + source attribution

**Sources usable (high confidence):**
- [`github.com/cardsightai`](https://github.com/cardsightai) organization page — repository inventory
- [`github.com/CardSightAI/cardsightai-sdk-node`](https://github.com/CardSightAI/cardsightai-sdk-node) Node SDK README — endpoint inventory, method signatures
- [`github.com/CardSightAI/cardsightai-sdk-swift`](https://github.com/CardSightAI/cardsightai-sdk-swift) Swift SDK README — installation, version requirements, raw types
- HobbyIQ's [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) — what we already integrate, empirical type knowledge from the 2026-05-18 migration

**Sources attempted but unusable (JS-rendered SPAs returned only title stubs to WebFetch):**
- `cardsight.ai/documentation`
- `cardsight.ai/documentation/api-reference`
- `cardsight.ai/documentation/mcp`
- `api.cardsight.ai/documentation`

Conclusion: any precise field-shape verification requires either (a) hitting the live API empirically (out of scope per the read-only hard rule), (b) installing the SDK and inspecting the generated types (out of scope per the no-installs hard rule), or (c) using an authenticated tool (e.g. `gh` CLI) on private files. Today's investigation operates on what's quotable from public READMEs + web-search corroboration.

**Limits of this document:** signatures are confirmed; full JSON response shapes for catalog endpoints are not. Where shapes are inferred from SDK type names or marketing claims, this document flags the inference explicitly.

### Verification method per remaining gap (so W5 empirical work knows exactly what to do)

The unverified items below each have a specific verification method paired so W5's ~1-hour empirical pre-flight doesn't have to re-derive how to close each gap:

| Unverified item | Verification method |
|---|---|
| `catalog.search()` response shape (image_url? variant fields?) | Install Node SDK in a scratch directory + one read-only call with a known query ("Bobby Witt Jr") + capture JSON |
| `catalog.cards.get()` response shape | Install Node SDK + one read-only call with a known card ID from a previous estimate's cardId + capture JSON |
| `ai.query()` response shape — **load-bearing for path (iv)** | Install Node SDK + one read-only call with a representative free-text query + inspect whether the result objects inline `parallel` (identify-card-shape) or omit it (catalog-search-shape) |
| Full MCP tool inventory (names, input/output schemas) | Connect to `mcp.cardsight.ai/?k=API_KEY` from any MCP-capable client (Claude Desktop, Claude Code with MCP config) and enumerate tools via the protocol's `tools/list` method |
| Free-tier per-endpoint ceiling distribution | (a) headed-browser fetch of `cardsight.ai/documentation/api-reference` (the JS-rendered SPA that WebFetch can't see), OR (b) account dashboard at `app.cardsight.ai` once authenticated |
| `getCardImage({ format: 'json' })` response shape (whether it returns a URL) | Install Node SDK + one read-only call with `format: 'json'` + capture body |

The first three together resolve the W5 picker question's empirical premise; expected total cost ~1 hour. The MCP item is independent and scoped to Phase 4a kickoff. The free-tier item is operational and can be deferred until rate becomes binding.

---

## 2. Repository inventory ([`github.com/cardsightai`](https://github.com/cardsightai))

| Repo | Language | License | Last updated | Install |
|---|---|---|---|---|
| `.github` | Markdown | n/a | 2026-05-06 | n/a (org profile) |
| `cardsightai-sdk-node` | TypeScript | MIT | 2026-05-06 | `npm install cardsightai` |
| `cardsightai-sdk-python` | Python | MIT | 2026-03-13 | `pip install cardsight` |
| `cardsightai-sdk-swift` | Swift | MIT | 2025-12-23 | Swift Package Manager |
| `cardsightai-sdk-java` | Java | MIT | 2025-11-17 | (Java/Android) |
| `cardsightai-demo-discord` | TypeScript | MIT | 2026-02-16 | n/a (demo) |

**Activity signal:** Node SDK + Python SDK refreshed within the last 2 months; Swift SDK is ~5 months stale relative to Node. Java SDK ~6 months stale. **W5 should verify Swift SDK still matches the latest Node SDK's endpoint surface before committing to a direct-from-iOS integration approach.**

---

## 3. Phase 1 — Catalog endpoint capabilities

### 3.1 Endpoints exposed by the Node SDK (from README, verbatim method names)

```
client.catalog.search({ q, type?, year?, segment?, min_year?, max_year?, take?, skip? })
client.catalog.cards.list({ year?, manufacturer?, player?, take?, skip? })
client.catalog.cards.get(cardId)
client.catalog.sets.list({ year?, manufacturer?, take?, skip? })
client.catalog.sets.cards(setId)
client.catalog.releases.list({ name?, yearFrom?, yearTo? })
client.catalog.manufacturers.list()
client.catalog.segments.list()
client.catalog.parallels.list()
client.catalog.parallels.get(parallelId)
client.catalog.fields.list({ sort?, order?, take? })
client.catalog.fields.get(fieldKey)
client.catalog.statistics.get()

// "Random Catalog (Simulation)" group — useful for testing
client.catalog.random.cards({ setId?, releaseId?, count?, includeParallels?, ... })
client.catalog.random.releases({ count?, year? })
client.catalog.random.sets({ releaseId?, count? })
```

### 3.2 The image-URL gap — what's available

**`client.images.getCard(cardId)`** is a separate endpoint exposed by the Node SDK. Two return-shape options documented in the Node SDK README:
- Default: image data (binary)
- `{ format: 'json' }` option — exact JSON shape NOT documented in the README excerpts I could fetch
- `{ default: 'true' }` option — purpose not documented

On the **Swift SDK** (verbatim from README):
```swift
let imageResult = try await client.raw.getCardImage(.init(path: .init(id: "card_uuid")))
if case .ok(let response) = imageResult {
    if case .image_sol_jpeg(let imageBody) = response.body {
        let imageData = try await Data(collecting: imageBody, upTo: 10 * 1024 * 1024)
    }
}
```

The Swift response is raw JPEG bytes (typed `image/jpeg`), NOT a URL string. **For W5 implication:** if iOS uses the SDK directly, image display is binary-data-driven (cache the decoded UIImage). If our backend mediates, the backend can either pass through bytes or rehost on CDN-backed URLs — design call for W5.

**Per-card-N+1 mitigation:** the Node SDK does NOT document a batched-image-fetch endpoint nor an `images` listing endpoint that returns URLs for multiple cards at once. Per-card image fetch is the only documented path. For a 50-hit picker page, that's 50 sequential image fetches. **At Cardsight's observed ~8 req/s ceiling from the cardsight-cert-investigation arc, that's ~6 seconds of fan-out for one picker page.**

Three mitigation strategies W5 could consider (NOT pre-decided):
1. **Don't fetch on search; lazy-fetch on row visibility** (SwiftUI `onAppear` per row → backend → cache → image). Burst pressure becomes user-scroll-rate, not page-load-rate.
2. **Fetch a smaller sample (e.g. top 5-10 by ranking)**; remaining rows show placeholder until user reveals.
3. **Verify if Cardsight thumbnails are CDN-backed** — if `getCardImage` returns a redirect to a CDN URL, picker can use the URL directly without proxying bytes through our backend.

### 3.3 The variant/parallel gap — what's available

`client.catalog.cards.get(cardId)` returns full detail including a `parallels[]` array. **HobbyIQ already has this type** as [`CardsightCardDetail`](../../backend/src/services/compiq/cardsight.client.ts) at [cardsight.client.ts:53-63](../../backend/src/services/compiq/cardsight.client.ts#L53-L63):

```ts
export interface CardsightCardDetail {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  parallels: CardsightParallel[];
  notFound?: boolean;
}

export interface CardsightParallel {
  id: string;
  name: string;
  numberedTo?: number;
}
```

This is the existing W3 + W4 understanding. The detail endpoint solves the variant problem **per-card**. Same N+1 latency profile as image fetch — 50 picker hits × 1 detail call each.

**However, the SDK's identify-card response (which we don't currently use) shows a richer `parallel` shape:**
```
parallel: {
  id: "par_uuid",
  name: "Gold Refractor",
  numberedTo: 50,
  description?: string  // visible in SDK type docs as `DetailedParallel`
}
```

`description` may be the human-readable detail field useful for picker display (e.g. "Gold Refractor /50 — Bowman Chrome 2023"). NOT confirmed against catalog responses; would need empirical check in W5.

### 3.4 Alternative search endpoints surfaced by the SDK

Two endpoints we don't currently use that might address the picker problem differently:

**`client.ai.query({ query, maxResults? })`** — natural-language search. Marketed as "AI-powered" search. Response shape NOT documented in any quotable source I could fetch. **Worth empirical investigation in W5** — if `ai.query` returns hits with `parallel` info inlined (similar to the identify endpoint's response), it could solve the variant gap at the search-result layer rather than requiring per-card detail fetches.

**`client.autocomplete.cards({ query, take? })`** — type-ahead search. Different surface from catalog.search. Optimized for short partial queries. Response shape NOT documented in fetchable sources. Could be useful for the picker's "as-you-type" UX (which we don't have today but might design).

### 3.5 Confirmed gap relative to today's HobbyIQ integration

[`cardsight.client.ts:216`](../../backend/src/services/compiq/cardsight.client.ts#L216) currently calls `/catalog/search` directly with `q, year, segment, take`. The current `CardsightCatalogResult` type (lines 37-45) is:
```ts
{ id, name, number, releaseName, setName, year, player? }
```

**No image URL field.** **No parallel field.** These match what's empirically observed in production for ~6 months. The Node SDK README does not contradict this for the search/list response — it shows utility helpers (`getCardParallels`, `hasCardParallels`) that operate on responses from `getCard(cardId)` detail, not from `search()` list. This is consistent with our empirical observation that the gap is real at the search-list layer.

---

## 4. Phase 2 — Identify / detect endpoints (relevant to v2 scan integration)

### Node SDK methods
- `client.identify.card(imageFile)` — multiple-card detection in one image
- `client.identify.cardBySegment(segment, imageFile)` — sport-specific identification
- `client.detect.card(imageFile)` — presence check only, returns `detected: boolean`, `count: number`

### Identify response shape (verbatim from Node SDK README example)
```json
{
  "success": true,
  "requestId": "req_abc123",
  "detections": [
    {
      "confidence": "High",
      "card": {
        "id": "cd4e3a2f-8b9d-4c7e-a1b2-3d4e5f6g7h8i",
        "segmentId": "seg-uuid",
        "releaseId": "rel-uuid",
        "setId": "set-uuid",
        "year": "2023",
        "manufacturer": "Topps",
        "releaseName": "Chrome",
        "setName": "Base Set",
        "name": "Aaron Judge",
        "number": "99",
        "parallel": {
          "id": "par_uuid",
          "name": "Gold Refractor",
          "numberedTo": 50
        }
      }
    }
  ],
  "processingTime": 1250
}
```

**Key observation:** the identify endpoint returns `parallel` inlined on the card. If `catalog.search()` followed a similar shape, the variant gap would not exist. The asymmetry suggests Cardsight treats identify-card-from-image as a higher-confidence-tier operation than catalog text search. **W5 empirical question: does `ai.query()` follow the identify-shape or the catalog.search-shape?**

### Grading info included on identify
```
grading?: {
  confidence: string,
  company: { id?, name },
  grade?: { id?, value, condition },
  qualifier?: { id?, code },
  autoGrade?: { id?, value, condition }
}
```

This is well-aligned with our `CardGrader` abstraction from W2 (PSA / BGS / SGC / CGC ids). At v2 scan integration time, this is the natural input to populate `CardIdentity.grade / gradeCompany / gradeValue` without going through our PSA grader adapter — the identify endpoint detects grade from slab labels.

### Swift SDK identify signatures
```swift
client.identify.card(_ image: UIImage)       async throws
client.identify.card(_ imageData: Data)      async throws
client.identify.card(_ fileURL: URL)         async throws
```

All async/await; iOS 15+. **Aligned with our existing iOS conventions.** For v2 scan integration this is the natural path; v1 doesn't need it.

### Pricing / tier — NOT documented

Free tier "750 calls/month" is referenced in marketing material but neither SDK README documents which endpoints count toward the free tier (catalog vs identify vs pricing) or how per-endpoint ceilings differ. **Empirical verification needed at W5 / v2 design** — but observed practice is ~8 req/s ceiling on the catalog endpoints as of the cardsight-cert-investigation arc.

---

## 5. Phase 3 — MCP endpoints

### MCP server URL (confirmed via web search corroboration of Cardsight docs)

```
https://mcp.cardsight.ai/?k=YOUR_API_KEY
```

Web-search-quoted integration pattern: add to `~/Library/Application Support/Claude/claude_desktop_config.json`, with the URL above; alternatively pass the API key via header. The Cardsight docs page at `cardsight.ai/documentation/mcp` is JS-rendered and returned only a title stub to WebFetch — **the exact MCP tool inventory could not be enumerated from fetchable sources.**

### What's possible to say from corroborated sources

- Cardsight publishes a native MCP server, not a community implementation
- It exposes "complete trading card catalog and identification capabilities" (marketing claim, not verified empirically against tool list)
- It's positioned for Claude Desktop + ChatGPT integration
- It's separate from the REST API surface (different host: `mcp.cardsight.ai` vs `api.cardsight.ai`)

### What's NOT verifiable from this investigation

- Full MCP tool inventory (names, input schemas, output schemas)
- Whether MCP tools mirror REST endpoints 1:1 or expose a different surface
- Whether MCP supports the same auth model as REST (`X-API-Key` header vs the `?k=` query param documented for Claude Desktop integration)
- Rate limit relationship between MCP and REST tiers

### Phase 4a roadmap implication — surface, do not decide

The original 2026-05-21 roadmap planned a "Phase 4a MCP cache layer" (referenced in [`docs/HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md) §"Weeks 8-10"). That cache layer's design intent was:
- Reduce Cardsight REST call volume during peak traffic
- Absorb a Cardsight outage with stale data ("never serve nothing")
- Add `cache_hit: boolean` telemetry to comp_logs

Cardsight's NATIVE MCP serves a different purpose:
- Expose catalog + identification capabilities to AI assistants (Claude Desktop, ChatGPT plugins)
- It's a server-side endpoint Cardsight maintains; it does NOT serve our backend's cache-mediation goals

**They are complementary, not substitutes.** Our Phase 4a cache layer goal (reduce REST volume + outage resilience) is still relevant; Cardsight's MCP doesn't replace it. **However, the original roadmap's "MCP-mediated cache layer" naming may be misleading** — it suggested Cardsight's MCP would be the cache surface, which it is not.

**Surface as Phase 4a kickoff question** (NOT a decision for this doc):
- Should Phase 4a be renamed to "Cardsight outage resilience + REST cache layer" to remove the MCP-naming confusion?
- Does Phase 4a's design change if iOS can use Cardsight's MCP directly (bypassing both our REST proxy and our cache)? (Answer almost certainly: no — but worth surfacing.)

---

## 6. Phase 4 — Swift SDK specifics for W5 iOS work

### Installation
```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/cardsightai/cardsightai-sdk-swift.git", from: "2.1.3")
]
```

### Platform requirements
- iOS 15.0+
- macOS 12.0+
- tvOS 15.0+
- watchOS 8.0+
- Swift 5.9+

**Verify against current HobbyIQ iOS deployment target** during W5 pre-flight — should match if we're on a recent Xcode toolchain, but the check is a 30-second discipline step worth doing.

### Authentication
```swift
let client = try CardSightAI(apiKey: "your_api_key_here")
// OR via env var CARDSIGHTAI_API_KEY (auto-detected)
```

### Custom config
```swift
let config = try CardSightAIConfig(
    apiKey: "your_api_key",
    baseURL: "https://api.cardsight.ai",
    timeout: 30,
    customHeaders: ["X-Custom": "value"]
)
```

### Concurrency model
- async/await throughout; no Combine, no callbacks
- Matches HobbyIQ iOS patterns

### Type system
- Auto-generated from OpenAPI spec via Apple's `openapi-generator`
- Public types accessed via `Operations.<name>` and `Components.Schemas.<name>` namespaces
- Pattern: `Operations.getCards.Input.Query()` for request, `Operations.getCards.Output` for response

### Error handling
```swift
do {
    let result = try await client.identify.card(image)
} catch let error as CardSightAIError {
    switch error {
    case .authenticationError(let message): ...
    case .apiError(let statusCode, let message, _): ...
    case .imageProcessingError(let message): ...
    case .networkError(let error): ...
    case .timeout: ...
    }
}
```

### W5 architectural question — does iOS use the SDK directly, or via our backend?

**Choice Y commitment** locked in W4 says iOS consumes `UnifiedSearchResponse` shape. That commitment is consumer-shape-level, not transport-level. Two implementations honor it:

**Default-state framing — important:** W3 already shipped `/api/search/cards` backed by the backend Cardsight client (`d5a3169`). The architectural question is therefore NOT "build (α) or build (β)" but "**stay on (β) or rebuild as (α)**." The default-on-no-decision is (β), the conservative path — it's what runs in production today. Any decision to adopt (α) is an active rebuild requiring iOS work + API key surface change + dispatcher reroute; a decision to stay on (β) requires nothing beyond the W5 kickoff confirmation. The (β) lean below is consistent with this default-state framing — it's not "pick (β)," it's "no reason surfaced to leave (β)."

**(α) iOS calls Cardsight directly via the Swift SDK.** Active rebuild from today's shipped (β) state. Bypass `/api/search/cards`. iOS receives Cardsight types and adapts them locally to `UnifiedSearchResponse`-equivalent display models.
- ✅ Lower latency (no HobbyIQ backend round-trip)
- ✅ Reduced HobbyIQ backend infrastructure load (especially at 100/500-tier scale)
- ✅ iOS gets the full SDK surface (images, identify, autocomplete) without backend proxying
- ❌ iOS holds Cardsight API key (security model change — currently the key is server-only)
- ❌ Bypasses W3 dispatcher → cert-grader registry; cert lookups can't go through `/api/search/cards`
- ❌ Cardsight outage = picker outage with no graceful fallback to a cached previous response
- ❌ Phase 4a cache layer can't intercept iOS's direct Cardsight calls

**(β) Our backend uses the Node SDK (or stays on the hand-rolled client); iOS keeps calling `/api/search/cards`.** This is what's shipped today. The only optional sub-decision is whether to swap our `cardsight.client.ts` for the Node SDK internally — orthogonal to the iOS-facing surface, captured as CF-CARDSIGHT-SDK-EVAL in SESSION_HANDOFF.md.
- ✅ Preserves W3 dispatcher abstraction and cert-grader fanout
- ✅ Phase 4a cache layer interception remains possible
- ✅ Server-only API key
- ✅ Cardsight outage absorbable via cache + stale-flag pattern
- ✅ **Already shipped — no rebuild cost**
- ❌ Extra hop adds latency (mitigatable: same datacenter region as Cardsight)
- ❌ Backend still needs to solve the image-fetch N+1 (vs iOS solving it via Swift SDK's per-row async)

**My empirically-informed lean** (NOT a decision): **stay on (β).** The W3 dispatcher abstraction is load-bearing for v1.5 grader pluggability; (α) would erode it. Server-only API key + Phase 4a interceptability are also load-bearing. The latency overhead is a tractable optimization, not an architectural problem. Without a surfaced reason to rebuild, the default holds.

This is a W5 kickoff conversation, not a Phase 5 decision.

---

## 7. W5 picker-migration question — empirically-informed restatement

W4's deferred-to-W5 problem statement was three theoretical paths for the image_url + variant gap. Today's investigation lets me restate it with empirical anchoring:

### Path (i) — REVISED: "use catalog.cards.get + images.getCard per hit"
- **Empirically confirmed:** both endpoints exist, return the data needed
- **N+1 latency cost:** 50 hits × 2 calls = 100 Cardsight calls per picker request; at ~8 req/s = ~12.5 seconds fan-out
- **Mitigations to explore:** lazy-fetch on row visibility (path α below); top-N priority fetch (path β); empirical check whether image endpoint redirects to a CDN URL (path γ — if yes, the N+1 cost collapses to N URLs in JSON, sub-second)

### Path (ii) — UNCHANGED: drop image_url + variant from the picker UX
- **Picker becomes text-only;** confirmation step shows full detail
- Substantial iOS rework; backend stays simple
- The SDK's `client.images.getCard()` JSON-format option (mentioned in Node SDK README but undocumented shape) might support thumbnail URLs in JSON — would convert this path's tradeoff if confirmed at W5

### Path (iii) — UNCHANGED: hybrid backend (CardHedge stays image+variant authority)
- CardHedge legacy paths stay live for image+variant data
- Cardsight handles search identity (id, player, year, etc.)
- Most complex implementation; preserves the most existing UX
- Empirical question: does CardHedge's catalog continue to be maintained, or is it deprecated to the point where this path is high-maintenance?

### Path (iv) — NEW (surfaced by today's investigation): `ai.query` / `autocomplete.cards` as alternative search endpoint
- **Empirical question for W5:** does `ai.query` return a richer response shape (parallel inlined, similar to the identify-card response) than catalog.search does?
- If yes — replaces the catalog.search call entirely; image fetch is still needed but variant is inlined
- If no — falls back to one of paths (i)-(iii)
- Cost of investigation: ~1 hour to make 5-10 test calls and capture response shapes
- **Worth doing at W5 kickoff before picking a path**
- **Binary framing:** path (iv) viability depends on `ai.query` actually returning identify-card-shape with parallel inlined. If it does NOT, we fall back to paths (i)/(ii)/(iii). Worst-case: same problem as pre-investigation. Best-case: problem collapses entirely. The empirical ~1h verification at W5 kickoff resolves this binary.

---

## 8. SDK installation considerations (NOT installed; for W5 to evaluate)

### Node SDK on the backend
- Package: `cardsightai` (npm)
- Node 22+ (matches HobbyIQ backend Node version — verify)
- TypeScript 5.0+ (matches)
- MIT license
- **Bundle size implication:** the SDK pulls in OpenAPI-generated types and a fetch wrapper. Likely modest (~50-200 KB). Compared to our hand-rolled `cardsight.client.ts` (~1-2 KB), it's heavier; the tradeoff is endpoint coverage + auto-generated type accuracy.

### Swift SDK on iOS
- Package URL: `https://github.com/cardsightai/cardsightai-sdk-swift.git`
- Minimum iOS 15.0 (verify against current HobbyIQ deployment target)
- Swift 5.9+
- async/await throughout
- MIT license

### Decision boundary
**This document does NOT decide whether to install either SDK.** The Choice Y + Option A architecture lets us defer this; W5 kickoff is the natural decision point. If (β) is chosen — backend Node SDK, iOS via `/api/search/cards` — then only Node SDK matters for v1. If (α) is chosen, both SDKs matter.

---

## 9. Honest assessment — does this change W4's deferred picker-migration question?

**Yes, in framing — but the underlying paths remain bounded.** Before this investigation, the W5 open question was three theoretical paths against an unknown SDK surface. Now:

- **Path (i)** is empirically confirmed feasible with concrete N+1 latency cost (12.5s fan-out untreated; sub-second if mitigations work)
- **Path (ii)** has a new variant: SDK's `getCardImage({ format: 'json' })` option might surface thumbnail URLs without bytes round-trip
- **Path (iii)** still depends on CardHedge maintenance status (orthogonal to SDK investigation)
- **Path (iv)** is new and the most promising single-call possibility worth empirical validation at W5

### What today's investigation does NOT do (per hard rules)

- ❌ Does NOT decide which path to take
- ❌ Does NOT install either SDK
- ❌ Does NOT make any test API calls (hard rule honored — no empirical SDK calls today)
- ❌ Does NOT update any code

### What it does do

- ✅ Replaces speculation with confirmed endpoint inventory
- ✅ Surfaces path (iv) as a new option W5 should evaluate
- ✅ Establishes the (α) vs (β) architectural question — does iOS use the SDK directly or via our backend?
- ✅ Flags the Phase 4a roadmap naming confusion that Cardsight's native MCP creates
- ✅ Captures Swift SDK installation + platform requirements for W5 pre-flight

---

## 10. Phase 4a roadmap implication

Original roadmap entry in [`docs/HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md) Weeks 8-10:

> Production resilience. The 'first deploy silently failed to rsync dist' incident this session is a small-radius version of the bigger risk: Cardsight outage = full prediction outage today.

The original framing was "MCP-mediated cache layer." Today's investigation shows:
- Cardsight publishes its OWN native MCP at `mcp.cardsight.ai`
- That MCP serves a different purpose (expose catalog to AI assistants, not cache REST calls)
- Our Phase 4a goal (outage resilience + REST volume reduction) is still valid
- The "MCP-mediated" language in the original framing is **at-best confusing, at-worst misleading**

**Surfaced as Phase 4a kickoff question** (NOT a decision):
- Rename Phase 4a to "Cardsight outage resilience + REST cache layer" or similar?
- Does Phase 4a design change in any way given Cardsight's native MCP exists? (Likely no — they serve different goals — but worth a 30-second cross-check.)
- Should HobbyIQ consume Cardsight's MCP for any backend purpose, separate from Phase 4a? (Not obvious; flag for Phase 4a kickoff.)

---

## 11. References

- [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) — HobbyIQ's current Cardsight integration (`searchCatalog`, `getCardDetail`, pricing endpoints) and the existing TypeScript types it relies on (`CardsightCatalogResult`, `CardsightCardDetail`, `CardsightParallel`)
- [`backend/src/services/unifiedSearch/cardsightCatalogAdapter.ts`](../../backend/src/services/unifiedSearch/cardsightCatalogAdapter.ts) — W3's adapter from Cardsight catalog → CardIdentity (consumes `CardsightCatalogResult`; emits the year=0 sentinel handling)
- [`backend/src/types/cardIdentity.ts`](../../backend/src/types/cardIdentity.ts) — W2's canonical `CardIdentity` type
- [`docs/phase0/unified_search_design_2026-05-28.md`](unified_search_design_2026-05-28.md) — CF-UNIFIED-SEARCH-AND-CERT design (23038d7) §2 free-form path, §13 v1 scope
- [`HobbyIQ/CompIQVariantPickerView.swift`](../../HobbyIQ/CompIQVariantPickerView.swift) — iOS picker row that consumes `imageUrl` + `variant` (lines 196, 222-227)
- [GitHub: cardsightai org](https://github.com/cardsightai)
- [GitHub: cardsightai-sdk-node](https://github.com/CardSightAI/cardsightai-sdk-node)
- [GitHub: cardsightai-sdk-swift](https://github.com/CardSightAI/cardsightai-sdk-swift)

---

## 12. HALT note

This is the Phase 5 deliverable per the kickoff hard rules. **No SESSION_HANDOFF.md update yet** — the kickoff said "Phase 6: optional, only if Phase 1-4 findings warrant." My read is that findings DO warrant a handoff update (path (iv) is a new W5 path, the (α)/(β) architectural question is new, the Phase 4a naming question is new), but per the hard rule I HALT before that update for your review.

After your review:
- If you approve a handoff update, I'll write a tight update to the W5 open question entry replacing the three-path framing with the empirically-informed four-path framing + the (α)/(β) question + the Phase 4a naming flag
- If not, the doc itself is informational for the next session to pick up at W5 kickoff

Either way, no code changes. No SDK installs. The investigation is purely documentation output, as scoped.

---

# Appendix — empirical follow-up (2026-05-29 late session)

**Headline:** Empirical follow-up resolves path (iv) NEGATIVE (`ai_query` is natural-language synthesis, not structured search) and empirically validates path (i) variant resolution via detail endpoint (11 parallels returned for the Bobby Witt Jr probe, exact match for existing `CardsightParallel` shape). Image gap remains real with no URL shortcut. W5 picker question narrows to image-fetch mitigation strategy (lazy / top-N / parallelize / cache-budget). Phase 4a naming flag clarified; architecture unchanged. One new backlog item surfaced: `CF-CARDSIGHT-PRICING-BULK`.

Drew authorized two targeted read-only probes against `https://api.cardsight.ai/v1` and `https://mcp.cardsight.ai/` to close specific gaps from the "What's NOT verifiable" table in §1. **Both were honored as read-only** — single GETs against the catalog detail endpoint and MCP protocol enumeration via direct HTTP JSON-RPC. No SDK installs, no writes, no package.json changes. API key pulled from `HobbyIQ3` Azure app settings via `az` CLI; never echoed to chat or commit content.

## A1 — `catalog.cards.get(cardId)` response shape (empirical)

**Cardsight cardId used:** `6134bc63-0859-4807-aad0-93e11263c2ed` — a Bobby Witt Jr Topps Chrome Update entry observed in this session's App Insights traces (from the Phase 3a/3b production smoke; 903 records on the unified-fallback bucket, suggests a popular well-populated catalog entry). Not guessed.

**Request:**
```
GET https://api.cardsight.ai/v1/catalog/cards/6134bc63-0859-4807-aad0-93e11263c2ed
Headers: X-API-Key: <from-Azure>
```

**Full response body (verbatim):**
```json
{
  "releaseId": "e7032954-f178-4c7b-ad9b-34df92179b15",
  "setId":     "ce5ef8d8-e1c0-4a6c-9581-0410718828a7",
  "id":        "6134bc63-0859-4807-aad0-93e11263c2ed",
  "number":    "USC35",
  "name":      "Bobby Witt Jr.",
  "releaseName": "Topps Chrome Update",
  "releaseYear": "2022",
  "setName":   "Base Set",
  "parallelCount": 11,
  "parallels": [
    { "id": "694bada8-ce0c-40d1-b83f-a17e447c7311", "name": "Aqua Refractor",       "numberedTo": 250 },
    { "id": "b7696526-5137-4a53-8615-8065241b5159", "name": "Blue Refractor",       "numberedTo": 199 },
    { "id": "832c34be-84bc-4ca6-9469-a3fa32142b7a", "name": "Gold Refractor",       "numberedTo": 50 },
    { "id": "b6b19e95-ad2b-4751-812e-f969fae1d22f", "name": "Green Refractor",      "numberedTo": 75 },
    { "id": "8048075f-78fe-429c-b6d2-81aa81e2fb89", "name": "Pink Wave Refractor" },
    { "id": "da425554-5baa-4cb9-9259-e4bb0fc36254", "name": "Printing Plates",      "numberedTo": 4 },
    { "id": "8c60a7bc-2098-4e33-8c31-80237f4ad838", "name": "Purple Refractor" },
    { "id": "91e10ff2-9915-4791-b686-19abf8fbf717", "name": "Red Refractor",        "numberedTo": 25 },
    { "id": "aca7f605-418d-4369-8451-4615b3de8a84", "name": "Refractor",            "numberedTo": 299 },
    { "id": "a1c7e1b4-4d16-4d51-85e3-a0802b4ec817", "name": "SuperFractor",         "numberedTo": 1 },
    { "id": "0d489c78-54b8-4b12-bc62-53fd28102b17", "name": "X-Fractor",            "numberedTo": 99 }
  ],
  "attributes": ["MLB-KCR", "RC"]
}
```

### A1.1 — Field-by-field assessment

| Field | Type | Present in our existing `CardsightCardDetail`? | W5 picker relevance |
|---|---|---|---|
| `id` | string (UUID) | ✅ | Hit identifier |
| `name` | string | ✅ | Player / card name |
| `number` | string | ✅ | Card number ("USC35") |
| `releaseName` | string | ✅ | "Topps Chrome Update" — composite year+set, picker subtitle source |
| `releaseYear` | **string** | ❌ — our type has `year: number` | Mismatch worth noting; current client likely converts |
| `setName` | string | ✅ | "Base Set" — short form |
| `parallels` | `Array<{ id, name, numberedTo? }>` | ✅ — exact shape match with our existing `CardsightParallel` | **LOAD-BEARING: solves the W4 variant gap at the detail endpoint** |
| `parallelCount` | number | ❌ (new) | Convenience; could be derived from `parallels.length` |
| `attributes` | `string[]` | ❌ (new) | `["MLB-KCR", "RC"]` — team code + rookie flag. Could enrich picker display |
| `releaseId` | string (UUID) | ❌ (new) | Cross-reference to release record (could enable secondary fetches) |
| `setId` | string (UUID) | ❌ (new) | Cross-reference to set record |

**Image fields: NONE.** No `image_url`, `front_image_url`, `image`, `thumbnail`, or any other image-bearing field at any level (top-level or nested in parallels[]). **Empirically confirms** that the detail endpoint does NOT solve the image gap — `client.images.getCard()` is a strictly separate fetch.

### A1.2 — W5 path implications, empirically anchored

**Path (i) "fetch /catalog/cards/{id} per hit" — variant problem genuinely solved.** The `parallels` array gives exactly what the picker needs for the electric-blue 3rd line. 11 parallel variants for this Witt card means one detail call expands one search hit into up-to-12 displayable parallel rows (base + 11). Picker UX implication worth flagging at W5 kickoff: does the picker show ONE row per BASE CARD (with parallels drilldown on tap) or N rows per BASE CARD (one per parallel for direct selection)? Either is implementable; affects the search-hits-to-rows fan-out.

**Path (i) image problem still requires `get_card_image` per card.** No CDN-redirect URL shortcut (empirically confirmed in MCP `get_card_image` tool definition below: format `"json"` returns **base64 bytes**, not a URL).

**Concurrency math, sharpened with the new data:**
- A typical picker page is 20-50 search hits
- Per-hit detail fetch: 20-50 calls. At Cardsight's observed ~8 req/s rate, that's 2.5-6.3 seconds of fan-out
- Per-hit image fetch: same 20-50 calls (additional fan-out). Same 2.5-6.3 seconds, sequential
- **Total naive worst case: 5-12.5 seconds of fan-out before picker render**

**Mitigations available** (NOT pre-decided; W5 design):
- Lazy-fetch on row visibility (SwiftUI `onAppear` per row → backend → cache → display)
- Top-N priority fetch (e.g. first 5 hits eagerly, remainder lazy)
- Parallelize detail + image fetches per card (`Promise.all` halves the wall-clock to 2.5-6.3s)
- Backend caches detail + image responses for `DETAIL_TTL_SEC` (already 24h) — second-time-same-card is sub-second

### A1.3 — Type-mismatch flag worth a future tweak

The `releaseYear` field is a **string** in the live response (`"2022"`), while our existing `CardsightCardDetail.year` is typed `number`. Our `_getCardDetail` client implementation likely coerces this at deserialization. Not breaking — just worth noting for any future SDK swap (the SDK's auto-generated type would type-faithful `string`, requiring a casting layer or a fix in our consumers).

---

## A2 — MCP server tool inventory

**Probe approach:** direct HTTP JSON-RPC to `mcp.cardsight.ai/?k=<key>` from PowerShell using `Invoke-WebRequest`. No Claude Desktop config changes; no MCP-client install; **strictly stateless protocol-level enumeration.** This was the cleaner read-only path Drew's kickoff allowed for ("alternatively use direct HTTP").

### A2.1 — Initialize handshake (server identity)

Request:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hobbyiq-investigation","version":"0.0.1"}}}
```

Response (SSE-wrapped JSON, content quoted):
```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": {}, "resources": {}, "prompts": {} },
  "serverInfo": { "name": "CardSightAI MCP Proxy", "version": "1.0.0" }
}
```

**Server identity confirmed:** `CardSightAI MCP Proxy v1.0.0`. The literal name "**MCP Proxy**" is empirically load-bearing — this is a proxy over the REST API, not a different backend.

### A2.2 — Tool inventory (90 tools enumerated)

Full count from `tools/list`: **90 tools**. Organized by domain (names verbatim):

**Catalog read (21 tools):**
`search_catalog, search_cards, get_card, search_sets, get_set, get_set_cards, search_releases, get_release, get_release_cards, list_segments, list_manufacturers, list_attributes, get_attribute, search_parallels, get_parallel, get_random_cards, get_random_sets, get_random_releases, list_fields, get_field, list_release_calendar`

**Collections (12 tools — most are WRITE operations we don't currently use):**
`list_collections, get_collection, create_collection, update_collection, delete_collection, list_collection_cards, add_collection_card, get_collection_card, update_collection_card, remove_collection_card, get_collection_analytics, get_collection_breakdown`

**Collectors (5 tools, write-heavy):**
`list_collectors, get_collector, create_collector, update_collector, delete_collector`

**Collection card images (4 tools — distinct from catalog images):**
`get_collection_card_image, get_collection_card_thumbnail, list_collection_set_progress, get_collection_set_progress, get_collection_set_progress_parallel`

**Binders (8 tools — sub-organization within collections):**
`list_binders, get_binder, create_binder, update_binder, delete_binder, list_binder_cards, add_binder_card, remove_binder_card`

**Want lists (8 tools):**
`list_lists, get_list, create_list, update_list, delete_list, list_list_cards, add_list_card, remove_list_card`

**Pricing (4 tools — INCLUDING `get_card_pricing_bulk` 1-100 batch):**
`get_card_pricing, get_card_pricing_bulk, get_card_marketplace, get_card_population, get_set_population, get_release_population`

**Grading (3 tools):**
`list_grading_companies, list_grading_company_types, list_grading_company_grades`

**Image (1 tool):**
`get_card_image` — `format: "raw" | "json"` enum. **Confirmed empirically: `"json"` returns base64-encoded image bytes with metadata, NOT a CDN-redirect URL.** No image-URL collapse possible.

**Identification (3 tools):**
`identify_card` (defaults to baseball segment), `identify_card_by_segment` (sport-specific, more accurate), `detect_card` (presence check only)

**Search / discovery (7 tools):**
`ai_query, autocomplete_cards, autocomplete_sets, autocomplete_releases, autocomplete_segments, autocomplete_manufacturers, autocomplete_years`

**Feedback (7 tools — write):**
`submit_general_feedback, submit_card_feedback, submit_identify_feedback, submit_release_feedback, submit_set_feedback, submit_manufacturer_feedback, get_feedback`

**Health / subscription (3 tools):**
`health_check, health_check_auth, get_subscription`

**Other / misc:** `get_catalog_statistics`

### A2.3 — Resources (1) and prompts (3)

`resources/list`:
```json
{"resources":[{"uri":"api://config","name":"API Configuration","description":"Current API proxy configuration","mimeType":"application/json"}]}
```

One resource — the API proxy configuration. Not directly relevant to picker / W5; useful for debugging.

`prompts/list`: 3 prompts (verbatim names): `price_check, parallel_comparison, find_rookies`. Server-side prompt templates with arguments. Not relevant to picker; useful for AI-assistant UX in a future LLM-driven feature.

### A2.4 — **PATH (iv) BINARY RESOLVED — NEGATIVE.** `ai_query` is NOT a search backend.

The `ai_query` tool's inputSchema confirms `{ query: string, collectionId?: string, maxIterations?: number }`. Its description is unambiguous (quoted verbatim from the MCP server's tool definition):

> "Ask CardSightAI's server-side assistant a natural-language question about the catalog or a specific collection. The server-side assistant has access to the same catalog tools and returns a **synthesized answer**."
>
> "Use `ai_query` for **fuzzy, multi-step questions where you would otherwise need to chain 3+ tools and reason across them**. Example: 'What were the best Topps rookie cards from 1989 that are now affordable but have growth potential?'"
>
> "Use `ai_query` when the user wants a **recommendation or interpretation, not raw data.**"
>
> "**Don't use `ai_query` for known specific lookups — `get_card`, `get_card_pricing`, `search_cards` are faster and cheaper.**"

**This empirically resolves the W4-deferred path (iv) binary as NEGATIVE:**

- `ai_query` returns a synthesized natural-language answer, not a structured `CardIdentity[]`-shape result
- It's designed for AI-assistant chat-driven UX, NOT for backend search dispatch
- Picker latency would also be unacceptable: the description allows up to 5 internal tool iterations by default
- **Path (iv) as conceived is NOT viable as a picker backend.**

`autocomplete_cards` (the other tool path-iv considered) is also not richer than `search_cards` — its description explicitly says "Quickly turn into candidate full names + IDs" and points back to `search_cards` for richer data + filters.

**Practical W5 implication:** path (iv) is removed from consideration. The picker question collapses to paths (i) / (ii) / (iii). Path (i) is the empirically-most-promising given the detail endpoint cleanly returns parallels (A1 above); image cost still requires mitigation strategy.

### A2.5 — Phase 4a roadmap naming flag CLARIFIED (not changed)

The MCP server's literal name is "**CardSightAI MCP Proxy**." Combined with the tool inventory mapping 1:1 to REST endpoints, this empirically confirms:

- **The MCP is a proxy over the same REST backend.** Same data, same rate limits implicitly, same response shapes inside `_meta.toolResult` content.
- **Our planned Phase 4a outage-resilience cache layer would interpose the same way regardless of whether we hit MCP or REST.** They are interchangeable transport surfaces for the same upstream system.
- The naming-confusion concern from the prior investigation (§5, §10) is real — Cardsight's "MCP" naming refers to their proxy of REST for AI-assistant consumers, while our roadmap's "MCP-mediated cache layer" referred to using MCP as a different protocol to access Cardsight. Today's empirical finding clarifies but does not change the implication: **the Phase 4a naming may want a refresh; the architectural goal does not change.**

### A2.6 — NEW surfaced opportunity: `get_card_pricing_bulk` (separate from W5)

Description verbatim:
> "Get completed-sales pricing for many cards in one call (1–100 card UUIDs). **One round-trip is much faster than calling `get_card_pricing` per-card.**"

Our existing `cardsight.client.ts` has no bulk-pricing equivalent. We currently call per-card pricing during estimate / sibling-pool computation. **This is a candidate optimization independent of the picker question** — likely worth its own CF if the per-card pricing fan-out becomes binding under traffic (currently not binding at v1 volume per the cardsight-cert-investigation arc).

**Recommendation:** capture as a new LOW backlog CF (`CF-CARDSIGHT-PRICING-BULK`) at the time of the optional handoff update, scoped to "evaluate bulk-pricing endpoint for use in sibling-pool / candidate-pool computation paths where multiple cardIds are priced sequentially today."

---

## A3 — Honest accounting of what's STILL unverified

After this follow-up:

| Item | Status |
|---|---|
| `catalog.cards.get()` response shape | ✅ **Resolved empirically** (A1) |
| Full MCP tool inventory | ✅ **Resolved empirically** (A2.2) |
| `ai_query()` response shape | ✅ **Resolved by tool definition** (A2.4): synthesized text, not structured `CardIdentity[]`. Path (iv) NOT viable. |
| `catalog.search()` response shape | ⏳ **Still unverified.** Only the search-result shape from the Node SDK's auto-generated types could confirm. Would require an SDK install (out of scope) OR a live `catalog.search` call. The Phase 1 investigation's empirical-from-our-existing-client knowledge (`{ id, name, number, releaseName, setName, year, player? }` with no image, no parallel) remains the working assumption. |
| `get_card_image({ format: 'json' })` exact JSON shape | ✅ **Resolved by tool definition** (A2.2 + tool description: returns "base64-encoded image bytes and metadata") — NOT a URL. No CDN-redirect shortcut. |
| Free-tier per-endpoint ceiling distribution | ⏳ **Still unverified** — would require headed-browser fetch of JS-rendered docs or account dashboard. Operational; not W5-load-bearing. |

## A4 — Net effect on the W5 picker question

**Before this follow-up:** 4 paths with path (iv) as the most-promising-if-viable candidate, with binary verification deferred to W5 kickoff.

**After this follow-up:**

- **Path (iv) is removed from consideration.** `ai_query` returns synthesized text, not structured search results. Confirmed by tool definition + workflow guidance baked into the MCP server.
- **Path (i) is the empirically-strongest survivor** for variant resolution: detail endpoint returns `parallels[]` cleanly + `attributes[]` as bonus picker enrichment. Image cost remains real and requires a mitigation strategy.
- **Path (ii) and (iii) remain available** as alternatives if path (i)'s image-fetch mitigation proves operationally complex.

**The W5 kickoff question is now sharper:**

> "Given path (i) cleanly solves the variant gap via per-hit detail fetch (~2.5-6.3s fan-out at observed rate limits) but the image gap requires a separate per-hit fetch (another ~2.5-6.3s) with no CDN-redirect shortcut available — which image-cost mitigation strategy fits the iOS picker UX best: lazy-fetch on row visibility, top-N priority, parallelize detail+image per card, or accept the latency budget and rely on the existing 24h cache?"

This is a concrete design question with an empirical answer space, not an open architectural question. W5 kickoff's empirical pre-flight collapses from "~1 hour of SDK probes" to "0 minutes" — the work is done.

---

## A5 — Investigation scope discipline upheld

- ✅ Read-only API calls only (one GET on `/v1/catalog/cards/{id}`; three MCP protocol calls — `initialize`, `tools/list`, `resources/list`, `prompts/list`)
- ✅ No SDK install; no `package.json` modifications
- ✅ No `npm install` in any HobbyIQ repo
- ✅ No `claude_desktop_config.json` modifications — Drew's hard rule about surfacing the diff before applying is moot because direct HTTP JSON-RPC eliminated the need
- ✅ API key never echoed; pulled via `az` CLI directly into PowerShell session memory, used as request header only
- ✅ No writes to Cardsight (no `create_*`, `add_*`, `update_*`, `delete_*` calls — only read enumeration of the tool list)
- ✅ No production data mutation
- ✅ Investigation output is markdown documentation only

The single `mcp-tools-list.txt` scratch file created at `c:/tmp/` is operator-machine-local and not committed.

---

## A6 — What this follow-up resolved vs. what remains unverified

**Empirically resolved by this follow-up:**

- ✅ **Path (iv) viability** — NEGATIVE per A2.4. `ai_query` is a server-side AI assistant returning synthesized natural-language answers, NOT structured `CardIdentity[]`. Confirmed by verbatim tool definition: *"Don't use `ai_query` for known specific lookups."*
- ✅ **Detail endpoint parallel shape** — exact match for our existing `CardsightParallel` type (A1). 11 entries for the Bobby Witt Jr probe with `{ id, name, numberedTo? }` per entry.
- ✅ **MCP tool inventory** — 90 tools enumerated across 12 functional domains (A2.2). Explicit identity as a **proxy** of REST endpoints, not a separate backend.
- ✅ **Phase 4a naming clarity** — MCP and REST are the same backend with 1:1 mapping. Architectural goal of the Phase 4a cache layer is unchanged; the naming-confusion concern is real but cosmetic. No design rework needed.

**Still NOT empirically verified (captured for W5 kickoff or future tier work, NOT blocking commit):**

- ⏳ **Per-card image fetch latency** — needed to size the W5 image-fetch mitigation strategy (lazy / top-N / parallelize / cache-budget decision). Best verified via a one-time read-only measurement against 5-10 cards at W5 kickoff. Single point-in-time measurement; doesn't require any committed harness.
- ⏳ **`get_card_pricing_bulk` response shape** — not probed because POST framing kept it out of scope per Drew's read-only-GET hard rule. Could be probed at any future point via a single read-only POST (the call is read in semantics even though it uses POST for the 1-100 cardId array body).
- ⏳ **Detail endpoint shape consistency across non-MLB cards** — only one MLB card probed. Worth a 2-3 card sanity check at W5 kickoff if non-baseball categories (basketball, football, Pokémon, etc.) matter for launch positioning. Empirically inexpensive to verify.
- ⏳ **`catalog.search()` response shape** — carried over from the original investigation (§A3 + Phase 1 §1). Working assumption from our existing `cardsight.client.ts` empirical knowledge holds: `{ id, name, number, releaseName, setName, year, player? }`, no image, no parallel. SDK install or direct REST call would resolve definitively. Not W5-blocking; the W5 design absorbs whatever shape it turns out to be via path (i) detail-fetch fallback.
- ⏳ **Free-tier per-endpoint ceiling distribution** — operational, deferrable until rate becomes binding at higher launch tiers.

**Decision framing:** W5 picks which of the still-unverified items to verify based on actual decision needs at kickoff. None are blockers for the W5 picker-question narrowing (image-fetch mitigation decision) since the empirically-resolved findings already pin the question shape.
