# HobbyIQ data schemas

Reference for every Cosmos DB container the backend reads/writes. One doc per container so remote Claude sessions + new team members can orient without spelunking through code.

Last verified: 2026-07-20 by Drew.

## Containers (all in `hobbyiq` database, `hobbyiq-comps` account, rg `rg-hobbyiq-dev`)

### `sold_comps` — unified transaction pool
- **Partition key**: `/cardId`
- **TTL**: 5 years (`SOLD_COMPS_TTL_YEARS=5`)
- **Row count**: ~2M as of 2026-07-20
- **Purpose**: single source of truth for observed sales. Every canonical FMV read filters this by `(cardId, parallel, grade, source)`.

Fields:
```
id                  string  — deterministic {source}::{sourceExternalId}
cardId              string  — CH cardId (canonical) or Cardsight UUID
playerName          string
cardYear            number | null
setName             string | null
product             string | null  — matches setName in most cases
parallel            string | null  — CH's variant string, PRESERVED as-is
cardNumber          string | null
isAuto              boolean
sport               string | null  — "baseball"/"football"/etc; inferred at write via inferSportFromContext
gradeCompany        string | null  — "PSA"/"BGS"/"SGC"/"CGC" or null for raw
gradeValue          number | null  — 10/9.5/9/etc; null for raw or ungraded slabs
price               number
soldAt              string  — ISO sale date
observedAt          string  — ISO write time
source              enum    — cardhedge / cardsight / ebay-user-purchase / ebay-user-sale / manual-user-entry / ebay-browse-ended
sourceExternalId    string  — canonical: `holding::{holdingId}` for user, `ch-daily::{cardId}::{soldAt}::{price*100}::{grade}` for CH backfill
contributorUserId   string | null  — user attribution when applicable
title               string | null
imageUrl            string | null
sellerHandle        string | null
verifiedByUser      boolean
confidence          number  — 0-1; 1.0 for user-verified, 0.9 for cert-linked CH, 0.8 for CH backfill, 0.7 for CH search
flaggedWrong        boolean?
```

**Read patterns** (all sub-second with 2026-07-19 composite indexes):
- `WHERE cardId = X` (partition scan) — canonical FMV lookup
- `WHERE sport = X AND soldAt >= T` (composite) — market movers
- `WHERE sport = X AND playerName = Y` (composite) — player detail
- `WHERE playerName = X AND soldAt >= T` (composite) — player trend
- `WHERE product = X AND soldAt >= T` (composite) — product trend
- `WHERE cardYear = X AND playerName = Y` (composite) — cohort backtest

**Write invariants**:
- Every source's `sourceExternalId` prefix is stable across paths (was buggy — see PR #613)
- `parallel` MUST come from the source (CH variant, holding parallel, request body), NEVER `input.parallel`
- `gradeCompany`/`gradeValue` MUST match the source tier (PR #613 fixed 4 grade-drop sites)
- Duplicates: run `detect-sold-comps-duplicates.cjs` + `apply-sold-comps-dedup.cjs` to consolidate

---

### `ch_daily_sales` — CardHedge nightly ingest
- **Partition key**: `/card_id`
- **Row count**: ~2M as of 2026-07-20, ~15K new/day
- **Purpose**: read-only source of CH's observed sales. Feeds sold_comps via nightly backfill + on-demand warm.

Fields (snake_case — CH's format):
```
card_id, player, year, card_set, card_set_type, variant, number, price
sale_date          — ISO timestamp
grader             — company-only: "PSA" / "BGS" / "SGC" / "Raw"
grade              — full tier string: "PSA 10" / "BGS 9.5" / "BGS AUTH" / "Raw"
description        — free text
image_url          — eBay thumbnail
listing_url        — direct link
sale_type, source  — CH-internal metadata
```

**Query gotchas**:
- Filter graded lookups on `c.grade = 'PSA 10'` (FULL tier), NOT `c.grader = 'PSA 10'`
- `c.grader = 'Raw'` for raw
- Fixed 2026-07-20 across canonicalFmv.warmPoolFromChDailySales + backfill script

---

### `sold_comps_daily` — rollup container
- **Partition key**: `/cardId`
- **Purpose**: per-(cardId, parallel, grade) daily aggregates so matched-cohort + market-movers don't hammer sold_comps directly.

Fields:
```
id             — `{cardId}::{parallel}::{gradeCompany}::{gradeValue}::{YYYY-MM-DD}`
cardId, sport, playerName, product, parallel
gradeCompany, gradeValue, cardNumber, cardYear
day            — YYYY-MM-DD
count          — sales that day in this SKU
sum, median, min, max
sources        — { cardhedge: N, ebay-user-purchase: N, ... }
observedAt
```

Populated by `sold-comps-daily-rollup.yml` workflow (nightly 7AM ET + manual dispatch).

---

### `portfolio` — user documents
- **Partition key**: `/userId`
- **TTL**: -1 (no expiry)
- **Purpose**: every user's holdings, watchlist, settings, price history.

Each doc:
```
userId              — same as partition key
holdings            — { holdingId: PortfolioHolding }
watchlist           — [{ cardId, ...}]
priceHistory        — { holdingId: [{ at, value, source }] }
importJobs          — { jobId: ImportJob }
settings            — user preferences
```

`PortfolioHolding` full field list lives in `src/types/portfolioiq.types.ts`. Key rules:
- `cardId` is the canonical CH cardId (after rematch)
- `resolvedMarketValue` is **deprecated** — use canonical FMV
- `gradeCompany`/`gradeValue` on the holding is the user-attested grade
- `certNumber` present when user cert-scanned or cert-typed
- `sellSideProjectedAtLastNotify`, `gradeArbNotifyLastAt` — notification state

---

### `ai_pricing_cache` — Redis-adjacent cache
Not documented here; used by canonical FMV for 15-min freshness. Ephemeral.

---

## Import / export contracts (user-facing data portability)

### Export portfolio
`GET /api/portfolio/export?format=xlsx|csv` (session-authed)

Returns a downloadable spreadsheet of the caller's holdings. Same fields as the composed portfolio wire format iOS sees on the dashboard. Content-Disposition attachment; iOS's share sheet handles the file.

### Import portfolio (bulk)
Async 2-step flow to handle large uploads without HTTP timeout:
1. `POST /api/portfolio/import/preview` — parse xlsx/csv, resolve identities, bucket into add / update / conflict / reject. Response includes `envelopes[]` for the commit step.
2. `POST /api/portfolio/import/commit` — write the envelopes; idempotency-token gated so retries don't double-apply.
3. `GET /api/portfolio/import/jobs/:jobId` — poll async preview status for >40-row imports.

Fields the importer recognizes: see `src/services/portfolioiq/import/headerAutoMap.ts` for the full column-header mapping (case-insensitive, handles common alias forms like `Card #`, `Card Number`, `SKU`, etc.).

### Bulk regrade
`POST /api/portfolio/holdings/regrade-batch` — apply a grade change across many holdings in one call. Used by iOS bulk-tag flow.

### Export contributed comps
`GET /api/portfolio/comps/export?format=csv` — shipped 2026-07-20 in PR #{TBD}. Downloads every comp the caller has contributed to sold_comps (source ∈ {manual-user-entry, ebay-user-purchase, ebay-user-sale}). Useful for tax records + audit trails.

### Manual comp add (single)
`POST /api/portfolio/manual-comps/add` — one-shot "I saw this sell" entry. Auto-emits to sold_comps with `confidence: 0.75`, `verifiedByUser: true`.
