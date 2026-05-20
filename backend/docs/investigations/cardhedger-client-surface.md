# Card Hedger Client Surface (Read-Only Probe)

Date: 2026-05-17
Scope: Existing client at `backend/src/services/compiq/cardhedge.client.ts` only (no code changes).

## Public API exported by the client

### Card search and identity

1. `searchCards(query: string, limit = 10): Promise<CardHedgeCard[]>`
- Upstream endpoint: `POST /cards/card-search`
- Request body shape:
  - `search: string`
  - `category: "Baseball"`
  - `page: 1`
  - `page_size: 1..50`
- Return shape: array of `CardHedgeCard`
  - `card_id`, `player`, `set`, `year`, `number`, `variant`, plus passthrough fields from CH payload.
- Notes:
  - Client is hard-locked to baseball category for search.
  - Cached (key prefix `ch:search`, TTL 6h).

2. `identifyCard(query: string): Promise<{ card_id: string; confidence: number; [k: string]: any } | null>`
- Upstream endpoint: `POST /cards/card-match`
- Request body shape:
  - `query: string`
- Return shape:
  - `match` object from CH if confidence >= 0.80, else `null`.
- Notes:
  - Client enforces confidence floor 0.80.
  - Cached (key prefix `ch:match`, TTL 6h).

3. `findCompsByQuery(query, opts): Promise<{ card, sales, variantWarning, aiCategory }>`
- Composite method built on existing methods:
  - `identifyCard` -> token validation -> `searchCards` fallback(s) -> `getCardSales`
- Input shape:
  - `query: string`
  - `opts: { grade?: string; limit?: number }`
- Output shape:
  - `card: CardHedgeCard | null`
  - `sales: CardHedgeSale[]`
  - `variantWarning: string[]`
  - `aiCategory: string | null`

### Sales/comps retrieval

4. `getCardSales(cardId: string, grade = "Raw", limit = 20): Promise<CardHedgeSale[]>`
- Upstream endpoint: `POST /cards/comps`
- Request body shape:
  - `card_id: string`
  - `count: number`
  - `grade: string`
  - `include_raw_prices: true`
- Return shape: normalized `CardHedgeSale[]`
  - `price`, `date`, `grade`, `source`, `sale_type`, `title`, `url`
- Notes:
  - Maps CH `raw_prices` to normalized sale rows.
  - Cached (key prefix `ch:comps`, TTL 12h).

### Sibling helper (parallel-neighbor pricing helper)

5. `fetchSiblingParallelComps(opts): Promise<SiblingComp[]>`
- Composite helper to discover sibling cards via search and fetch comps per sibling card_id.
- Input shape:
  - `playerName`, optional `year`, optional `set`, optional `excludeCardId`, optional `grade`, optional limits.
- Output shape:
  - `SiblingComp[]` with `card_id`, `variant`, `number`, `title`, `price`, `soldDate`.

### Parsing/token utilities (query-time heuristics)

6. `extractRequiredTokens`, `cardMatchesTokens`, `tokenMismatches`, `stripAutoSetPhrases`, `stripGradingTokens`
- Used to constrain variants and remove noisy terms.
- Not upstream CH endpoints.

## Data model exported by the client

- `CardHedgeCard`
  - Defined keys: `card_id`, `player`, `set`, `year`, `number`, `variant`, `title`, `name`.
- `CardHedgeSale`
  - Defined keys: `price`, `date`, `grade`, `source`, `sale_type`, `title`, `url`.
- `SiblingComp`
  - Defined keys: `card_id`, `variant`, `number`, `title`, `price`, `soldDate`.

## Bulk/catalog capability check (from current client)

- No method currently accepts "return all cards for set X + year Y".
- All public query paths are per-query or per-card-id oriented:
  - free-text search (`card-search`)
  - AI single match (`card-match`)
  - comps by card_id (`comps`)
- No explicit bulk catalog endpoint/method is implemented in this client.

## Endpoint usage summary

- `POST /cards/card-search`
- `POST /cards/card-match`
- `POST /cards/comps`

No additional CH endpoint is used by this module.
