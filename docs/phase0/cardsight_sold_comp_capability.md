# Phase 0 — Cardsight sold-comp capability verification

**Captured:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope:** Read-only verification. No code changes.
**Time budget:** 15 min.
**Purpose:** Pre-flight check before any Card Hedge removal work. The user directive is "remove CH ASAP, use Cardsight for all sold-comp data." This document verifies whether that's possible.

**Headline — Conclusion (b): Cardsight provides sold-comp data via a different endpoint and bundling shape, and the backend integration partially exists.** Cardsight's `GET /v1/pricing/{cardId}` endpoint returns sold-comp records identical-in-fields to Card Hedge's `raw_sales` (price, date, source, title, url). A backend router function `getCardSalesRouted` already wires it. **However, under current `CARDSIGHT_MODE=exclusive`, that router returns an EMPTY array for cardhedge-namespace `cardId` values** (which is what the iOS app currently sends), making the integration functionally dead despite being wired. Production sold-comps today flow exclusively through the MCP server's `compsLoader.fetchPlayerComps()` reading the Card Hedge blob — that's the path Card Hedge removal would actually need to redirect. **Sold-comp data is available; some integration work remains** — primarily a cardId-namespace translation layer (or migration to Cardsight-namespace IDs from the iOS app side), plus an MCP-side rewire from blob to Cardsight live calls.

## 1. Card Hedge data shape (what `compsLoader` currently consumes)

`mcp-server/cardhedge.ts:71-78` defines `CachedSale`:

```ts
interface CachedSale {
  price: number;
  date: string;
  grade: string;
  source: string;
  title?: string;
  url?: string;
}
```

`mcp-server/compsLoader.ts:34-41` mirrors this and `fetchPlayerComps` projects each `raw_sales` element into `CardComp` (`pricing.ts:54-60`):

```ts
interface CardComp {
  price: number;
  date: string;
  grade: string;
  source?: string;
  title?: string;
}
```

The full blob payload (`CachedCardHedgePayload`) includes:
- `player`, `card_hedge_id`, `updated_at`, `raw_sales: CachedSale[]`

Per Workstream A's live blob sampling: each player's `raw_sales` is 27 entries (CH's `/cards/comps` default page size), 100% `source: "ebay"` with real `ebay.com/itm/...` URLs and recent dates.

## 2. Cardsight data shape (what cardsight.client returns)

`backend/src/services/compiq/cardsight.client.ts:65-92` defines:

```ts
interface CardsightSaleRecord {
  title: string;
  price: number;
  date: string | null;
  source: string;
  url: string | null;
  image_url?: string | null;
}

interface CardsightPricingResponse {
  card?: CardsightCatalogResult;
  raw: { count: number; records: CardsightSaleRecord[] };
  graded: CardsightGradedCompany[];   // PSA, BGS, SGC, etc., each with grade buckets
  meta: { total_records: number; last_sale_date: string | null };
  notFound?: boolean;
}
```

Endpoint: `GET ${BASE_URL}/pricing/${cardId}` with optional `?parallel_id=...` (lines 326–365). Cached via `cacheWrap(cKey("cs:pricing", ...), _getPricing, PRICING_TTL_SEC)`.

**Field-level shape comparison vs. CH `CachedSale`:**

| Field | Card Hedge `CachedSale` | Cardsight `CardsightSaleRecord` |
|---|---|---|
| price | `number` | `number` |
| date | `string` (ISO) | `string \| null` |
| source | `string` (e.g. "ebay") | `string` |
| title | `string?` | `string` (required) |
| url | `string?` | `string \| null` |
| grade | `string` (per-record) | structural (raw bucket vs. graded[] bucket) |
| image_url | — | `string \| null?` (bonus) |
| sale_type | — | — |

**Grade representation is the only structural difference.** CH puts grade on each record; Cardsight separates raw sales from graded sales into different arrays/buckets. Trivially translatable.

## 3. Sold-comp consumption pattern in `pricing.ts`

`mcp-server/pricing.ts` consumes comps from a `CardComp[]` array on its input (`card.recentComps`). It uses these for:
- H10 comp-volume gating (`pricing.ts:154-207`): `last30`, `compCount` analysis
- Latest sale identification (`pricing.ts:328-331`): `compsLast30`, `compsLast7`
- Prediction blocks (`pricing.ts:383-384`, `662`): `compsBlock`, `computeCompsAnalytics(card.recentComps)`

**The MCP server gets its comps from `compsLoader.fetchPlayerComps()`:**

```
mcp-server/server.ts:223  →  comps = await fetchPlayerComps(playerName, body.grade);
mcp-server/backtest.ts:239 → comps = await fetchPlayerComps(player);
```

`fetchPlayerComps` reads ONLY the Card Hedge blob at `compiq-signals/{player-slug}/cardhedge.json` and projects `raw_sales` into `CardComp[]`. **There is no Cardsight integration in the MCP server.** mcp-server/server.ts and mcp-server/compsLoader.ts have zero Cardsight imports or calls.

## 4. Backend-side Cardsight integration (what already exists)

A separate Cardsight integration exists on the **backend side**:

- `backend/src/services/compiq/cardsight.client.ts` — the Cardsight HTTP client. `getPricing(cardId)` is the sold-comp endpoint.
- `backend/src/services/compiq/cardsight.router.ts:getCardSalesRouted(cardId, grade, limit, opts)` — routes sales requests through CARDSIGHT_MODE. Maps Cardsight's `CardsightPricingResponse` into the same `CardHedgeSale[]` shape the rest of the code expects:
  ```ts
  return translated.map((t) => ({
    price: t.price,
    date: t.soldDate ?? null,
    grade,
    source: "cardsight",   // note: identifiable source tag
    sale_type: null,
    title: t.title ?? null,
    url: null,             // current mapping discards Cardsight's URL
  }));
  ```
- `backend/src/services/compiq/compiqEstimate.service.ts:710` calls `getCardSalesRouted(pinnedCardId, grade, 25, { cardIdSource: "cardhedge" })` for the `/api/compiq/price-by-id` route. Line 629 calls it for sibling-card sampling.

So the backend has a complete `getCardSalesRouted → getPricing` path. The shape translation exists. The wiring into the prediction handler exists.

## 5. The trap — `CARDSIGHT_MODE=exclusive` returns empty for cardhedge-namespace IDs

Reading `cardsight.router.ts:343-395` carefully — the routing logic under `exclusive` mode:

```ts
// exclusive
if (cardIdSource === "cardhedge") {
  log.warn("primary_mode_cardhedge_namespace_only", { cardId });
  return [];     // ← EMPTY ARRAY
}
return cardsightSales();   // only reached when cardIdSource === "cardsight"
```

`cardIdSource` defaults to `"cardhedge"` (line 350: `opts?.cardIdSource ?? "cardhedge"`). And the iOS app and backend pass cardhedge-namespace IDs to `/api/compiq/price-by-id` per `copilot-instructions.md`'s documented architecture.

**Result:** in current production with `CARDSIGHT_MODE=exclusive`, the backend's `getCardSalesRouted` returns `[]` for every realistic call. The `primary_mode_cardhedge_namespace_only` warn log fires here — this is the same warn line whose ~9% capture rate was Phase 0 Finding 3 (W6 entry).

**This explains the 100% no-prediction-outcomes finding** from earlier today's diagnostics (Check 2 / Check 2.5): under exclusive mode, the backend prediction path with cardhedge cardIds returns empty comps; the prediction engine produces `no_recent_comps` outcomes 79% of the time and `variant_mismatch` 20% of the time, with `predictedPrice: null` for 100% of recent rows.

Meanwhile, the MCP server's `compsLoader.fetchPlayerComps` reads the CH blob (which is healthy per Workstream A — 27 real eBay-sourced comps per player) and serves MCP-side predictions normally. The two paths produce dramatically different comp coverage:

- Backend `/api/compiq/price-by-id`: **0 comps** (routed-empty under exclusive)
- MCP server `/predict`: **healthy comps** (read from CH blob)

## 6. Cardsight API documentation in the repo

- `.github/copilot-instructions.md`: **0 hits** for "Cardsight" (grep verified).
- `README.md`: **0 hits** for "Cardsight" (grep verified).
- Inline code comments in `cardsight.client.ts` document the endpoint URLs and types but no external doc link.
- `docs/phase0/cardsight_coverage_2026-05-21_sources.md` (from earlier session) discusses Cardsight catalog freshness only — not pricing.

The Cardsight API surface I can characterize from the client code:
- `GET /v1/catalog/search?segment=baseball&query=...` — catalog search
- `GET /v1/catalog/cards/{cardId}` — card detail (returns parallels)
- `GET /v1/pricing/{cardId}?parallel_id=...` — **sold-comp endpoint**

Auth: `X-API-Key` header (the env var name isn't in this scope of reading).

## 7. Conclusion — state (b)

**Cardsight provides sold-comp data via a different endpoint and bundling shape; the backend integration partially exists; substantive integration work remains.**

| Question | Answer |
|---|---|
| Does Cardsight have sold-comp data? | **YES.** `GET /v1/pricing/{cardId}` returns `raw.records: CardsightSaleRecord[]` + `graded[].grades[].records`. Field-level shape matches Card Hedge's `CachedSale` modulo grade-as-record-field vs. grade-as-bucket structure. |
| Is the backend integration to call Cardsight present? | **YES.** `cardsight.client.ts:getPricing` + `cardsight.router.ts:getCardSalesRouted` + invocation in `compiqEstimate.service.ts:629/710`. |
| Does that integration actually serve sold-comps to production today? | **NO.** Under `CARDSIGHT_MODE=exclusive` with the default `cardIdSource: "cardhedge"`, the router returns `[]` and only logs `primary_mode_cardhedge_namespace_only`. The same `[]` flows up to the prediction engine, which produces `no_recent_comps` outcomes for 79% of recent rows. |
| Where do production sold-comps actually come from today? | The **MCP server's `compsLoader.fetchPlayerComps`** reads the Card Hedge blob. This is the only live path producing healthy comps. Backend's `/api/compiq/price-by-id` does NOT serve healthy comps to iOS today. |
| What work is required to "use Cardsight for sold-comps" end-to-end? | (1) **cardId-namespace translation** — translate cardhedge-namespace IDs to Cardsight cardIds at some layer (router-side translator, or change the iOS app to fetch Cardsight cardIds directly via catalog lookup first). (2) **MCP-side rewire** — replace `compsLoader.fetchPlayerComps`'s CH-blob read with a Cardsight live call (or backend HTTP call to a Cardsight-served sales endpoint). (3) **Decommission `fn-cardhedge-comps`** (timer + blob writer) and the CH blob path. (4) **Verify or refactor backend's `cardsight.router.ts` `exclusive`-mode behavior** so it serves Cardsight sales for the current ID namespace, not empties. |

**The data is available. The router exists. The translation/wiring layer is the gap.** Removal is not impossible, but it's not "flip a config flag" either — it requires the translation layer and an MCP-side rewire as load-bearing work.

## Caveat — production data quality observation

Per today's diagnostic chain (Check 2 / Check 2.5 of the synthetic-soak abort), production /api/compiq/price-by-id is currently serving **0 successful predictions out of 200 recent rows** because the backend's Cardsight router returns empty for cardhedge IDs. If iOS users are getting any working price prediction today, it's via the MCP server path (`compsLoader.fetchPlayerComps` reading the CH blob), not via the backend's Cardsight integration. **Removing Card Hedge without first fixing the namespace gap would convert "predictions degraded under one path" into "predictions degraded everywhere."**

## Anti-drift note

This document characterizes capability and integration state. It does NOT propose a removal plan, a namespace-translation design, an MCP-side migration architecture, or a phased removal sequence. Those are downstream design decisions that should be made by the user with this verification as input.
