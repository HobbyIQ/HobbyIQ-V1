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
