# iOS ↔ Backend Field Remap Contract

**Owner:** Drew Vabulas
**Deadline:** iOS builds off this contract by Aug 24 for Sept 14 launch
**Prepared:** 2026-08-09 (Claude session 44ed1a3b)
**Repo:** `HobbyIQ-V1`

## Purpose

Backend response shapes changed during the 2026-08-08/09 launch-prep sprint. iOS's decoder types need adaptation to consume the new shapes. This document lists every changed contract so iOS can update in one bulk pass.

**Rule:** if a field's shape or presence differs from what iOS expects, iOS adapts. The backend contract is source-of-truth going forward.

---

## Endpoint 1: `POST /api/search/cards`

**Purpose:** freetext + cert card search. iOS calls this from `CardSearchView.swift` / `CompIQView.swift`.

### Request (unchanged)

```json
{
  "input": "2018 topps chrome update ohtani",
  "hint": "freetext"  // or "cert" — optional
}
```

### Response (changed)

```typescript
interface UnifiedSearchResponse {
  input: { raw: string, detectedMode: "freetext" | "cert" };
  candidates: CardIdentity[];  // may be empty
  warnings: string[];          // NEW STRINGS possible
}
```

**New warning strings iOS must handle:**

| Warning | Meaning | UI treatment |
|---|---|---|
| `"catalog_no_matches"` | Catalog has 0 matches for the query (new post-CH-decommission) | Show "No cards matched. Try broader keywords." — same as old `no_freetext_matches` |
| `"freetext_search_failed"` | Backend threw during search | Show generic "Search failed, try again" |

**Retired warnings** (iOS can remove decoder branches for these):
- `"no_freetext_matches"` — replaced by `"catalog_no_matches"`

**Title format changed** (cosmetic, no field name change):
- OLD: `"Shohei Ohtani 2018 2018 Topps Chrome Update Baseball Base #HMT1"` (year duplicated, sport suffix, Base noise)
- NEW: `"2018 Topps Chrome Update Shohei Ohtani #HMT1"` (year prefix, no sport suffix, no Base filler)

If iOS was doing any regex parsing on the `title` string, verify it still works with the new format.

---

## Endpoint 2: `POST /api/compiq/price-by-id`

**Purpose:** priced-card detail. iOS calls this from `CompIQPricedCardView.swift`.

### Request (unchanged)

```json
{
  "cardId": "hiq:baseball:2018:topps-chrome:hmt1:base:no-auto",
  "parallel": "Base",           // optional
  "gradeCompany": "PSA",        // optional
  "gradeValue": 10,             // optional
  "parallelId": null,           // Cardsight UUID variants only
  "parallelName": "Base"        // optional
}
```

**Key change:** `cardId` can now be an `hiq:...` slug — backend has fallback logic. Legacy bubble.io IDs still work too.

### Response (changed in field VALUES, not shape)

```typescript
interface PriceByIdResponse {
  success: boolean;
  cardsightCardId: string;      // NEW: may be an "hiq:..." slug
  summary?: string;
  marketTier?: { value?: number, high?: number };
  buyZone?: [number, number];   // always populated when FMV > 0
  holdZone?: [number, number];
  sellZone?: [number, number];
  fairMarketValueLive?: number | null;  // always populated when we have comps
  marketValue?: number | null;
  predictedPrice?: number | null;
  predictedPriceRange?: [number, number] | null;
  confidence?: number;
  approximate?: boolean;
  outOfScopeReason?: string | null;
  source?: string;              // NEW STRINGS possible (see below)
  recentComps?: RecentComp[];
  gradeBreakdown?: PriceGradeBreakdownEntry[];
  gradedEstimates?: PriceGradedEstimate[];
  cardImageUrl?: string | null;
  cardImageThumbUrl?: string | null;
  gradeUsed?: string | null;
  compsUsed?: number;           // now reflects OUR pool's comp count, not CH's
  compsAvailable?: number;
  daysSinceNewestComp?: number | null;
  lastSale?: { price?, soldDate?, grader?, gradeValue? } | null;
}
```

**New `source` strings iOS must handle:**

| Source | Origin | UI treatment |
|---|---|---|
| `"direct-comp"` | Real recent comps in our own pool matched the exact slug | Show "N recent comps used" |
| `"canonical-fmv"` | Our canonical-fmv path served (has real comps but not marked direct-comp) | Show "N recent comps used" |
| `"product-family-projection"` | Projected from sibling cards in same product family | Show "Projected from similar cards" |
| `"parallel-floor-projection"` | Projected from base + parallel scarcity ratio | Show "Projected from scarcity" |
| `"scarcity-prior-floor"` | Scarcity-based floor estimate | Show "Scarcity estimate" |
| `"reference-catalog-baseline"` | Reference-catalog baseline (Tier 6) | Show "Reference estimate" |
| `"setdoc-baseline"` | Set-doc baseline (Tier 7) | Show "Set-doc estimate" |
| `"no-recent-comps"` | We have the card in catalog but no recent sales | Show "No recent sales" empty state |
| `"catalog-miss"` | Card not in catalog | Show "Not in catalog" state |
| `"tiered-momentum-card"` | Momentum-based tier-fallback | Show "Momentum estimate" |
| `"unsupported_sport"` | Sport not yet supported (Pokemon, etc.) | Show "Coming soon" state |

For any `source` iOS doesn't recognize, default to `"Live pricing"` label — future-proof.

**FMV surface changes:**
- `fairMarketValueLive` — was often null on legacy path, now populated whenever `compsUsed > 0`
- `compsUsed` / `compsAvailable` — now reflect actual sold_comps count, not CH cache. Real numbers.
- `buyZone` / `holdZone` / `sellZone` — always populated when FMV > 0. iOS should display these prominently in the "Trading Zones" section.

---

## Endpoint 3: `POST /api/compiq/canonical-fmv` — RECOMMENDED for new iOS work

**Purpose:** authoritative FMV read for a canonical slug. New endpoint iOS should prefer over price-by-id for fresh integrations.

### Request

```json
{
  "cardId": "hiq:baseball:2018:topps-chrome:hmt1:base:no-auto",
  "parallel": "Base",
  "gradeCompany": null,     // or "PSA" / "BGS" / "SGC" / "CGC"
  "gradeValue": null,       // or 10 / 9.5 / 9 / etc.
  "cardYear": 2018,
  "product": "Topps Chrome Update",
  "player": "Shohei Ohtani",
  "cardNumber": "HMT1",
  "freshCompute": false     // set true to skip cache
}
```

### Response

```typescript
interface CanonicalFmvResponse {
  fmv: number;                   // the number to show
  method: string;                // "direct-comp" | "product-family-projection" | ...
  confidence: number;            // 0-1
  provenance: {
    summary: string;             // human-readable: "718 same-parallel user comps · regression +4.9%/mo"
    comps: Array<{
      price: number;
      soldAt: string;            // ISO
      source: string;            // "cardhedge" | "cardsight" | "tca-ebay"
      parallel: string;
      verifiedByUser: boolean;
    }>;
    trendPctPerMonth: number | null;
    multipliers: Record<string, number>;
  };
  computedAt: string;            // ISO
  gradeLadder: {
    family: string;              // "topps-chrome-update" etc.
    sampleSize: number;
    tiers: Array<{
      grader: string;            // "Raw" | "PSA 10" | "PSA 9" | "BGS 10" | ...
      medianRatio: number;       // e.g., PSA 10 might be 5.04x raw
      fmv: number;               // grader-specific FMV
    }>;
  };
  recentRange: {
    n: number;                   // comp count
    min: number;
    p25: number;
    median: number;
    p75: number;
    max: number;
  };
  buyPrice: {
    buyPrice: number;            // recommended buy target
    confidence: number;
    context: string;             // "flip" | "hold" | etc.
    economics: {
      fmv: number;
      ebayFeePct: number;
      ebayFeeFlat: number;
      targetMarginPct: number;
      sellerNetIfListedAtFmv: number;
    };
    summary: string;
  };
}
```

**iOS suggested treatment:**
- Main FMV number: `response.fmv`
- Confidence label: `response.confidence` (0-1 → % or "high/med/low" buckets)
- Comps count: `response.recentRange.n`
- Grade ladder table: iterate `response.gradeLadder.tiers`
- Recent comps list: `response.provenance.comps` (max ~20)
- Trend indicator: `response.provenance.trendPctPerMonth`
- Trading zones: derive from `response.fmv` OR use existing price-by-id endpoint if the shape is easier

---

## Endpoint 4: rate limits added on all FMV endpoints

**These endpoints now return 402 `rate_limit_exceeded` for free-tier users over 5 checks/day:**

- `POST /api/compiq/price` (existed already)
- `POST /api/compiq/price-by-id` (existed already)
- `POST /api/compiq/canonical-fmv` (NEW rate-limit)
- `POST /api/compiq/hobbyiq-fmv` (NEW rate-limit)
- `POST /api/compiq/card-detail` (NEW rate-limit)
- `GET /api/compiq/cards/:cardId/recent-sales` (NEW rate-limit)
- `GET /api/compiq/cards/:cardId/listing-range` (NEW rate-limit)

### 402 response shape

```json
{
  "success": false,
  "error": "rate_limit_exceeded",
  "cap": "priceChecksPerDay",
  "limit": 5,
  "current": 5,
  "currentTier": "free",
  "requiredTier": "collector"
}
```

**iOS treatment:** show a paywall modal with:
- "You've used your 5 free price checks today"
- CTA "Upgrade to Collector — $12.99/mo" (link to Stripe checkout on web OR trigger IAP)
- CTA "Wait until tomorrow" (soft dismiss)

Paid tiers (Collector / Investor / Pro Seller) have `"unlimited"` cap — never hit 402. iOS can safely skip the paywall for those users.

---

## Endpoint 5: subscription entitlement mapping

**Backend `entitlements.ts` maps BOTH legacy + `.v2` product IDs to the same tier:**

| Product ID (App Store Connect) | Tier | Legacy ID (grandfathered) |
|---|---|---|
| `com.hobbyiq.collector.monthly.v2` | Collector ($12.99) | `com.hobbyiq.collector.monthly` |
| `com.hobbyiq.investor.monthly.v2` | Investor ($24.99) | `com.hobbyiq.investor.monthly` |
| `com.hobbyiq.proseller.monthly.v2` | Pro Seller ($49.99) | `com.hobbyiq.proseller.monthly` |

**iOS:** send whichever product ID the user is actually subscribed to. Backend handles the mapping. Never delete legacy IDs from App Store Connect (grandfathered users need them to renew).

**Cross-channel:** if a user subscribes on web via Stripe, backend grants the SAME tier entitlement. iOS should reflect subscription via `/api/entitlements/current` (or equivalent — grep backend for the exact route) — trust backend as source of truth, not local receipt cache.

---

## Endpoint 6: waitlist confirmation

**No API change, but new email flow live 2026-08-08:**

- Waitlist signup POST → backend triggers ACS Email confirmation from `drew@hobby-iq.com`
- Email is HobbyIQ-themed dark
- If iOS shows a "join waitlist" flow, no API change needed — just visual polish per spec

---

## What iOS does NOT need to change

- **Portfolio endpoints** (`/api/portfolioiq/*`) — no shape changes today
- **Alerts endpoints** — no changes
- **BuyerIQ endpoints** — no changes
- **ERP / inventory endpoints** — no changes
- **Auth endpoints** — no changes (Apple Sign-In still primary; Stripe checkout is web-only)
- **Cert lookup endpoints** — no changes
- **Image identification endpoints** — no changes
- **DailyIQ endpoints** — no changes

---

## Contract test suite iOS should build

After adapting, add these test cases to your iOS integration test file (whatever the existing pattern is):

1. `POST /api/search/cards` with `"2018 topps chrome update ohtani"` → assert `candidates.length >= 3`, top hit title includes "Ohtani" and doesn't include "2018 2018"
2. `POST /api/compiq/price-by-id` with an `hiq:` slug → assert `fairMarketValueLive > 0`, `compsUsed > 0`, `source` is one of the known strings
3. `POST /api/compiq/canonical-fmv` with an `hiq:` slug → assert `fmv > 0`, `gradeLadder.tiers.length > 5`, `recentRange.n > 0`
4. Any FMV endpoint → hit 6 times with a free-tier session → assert 6th returns 402 with `error: "rate_limit_exceeded"`
5. Get subscription entitlement → assert grandfathered legacy product ID resolves to same tier as new v2 ID

---

**End of contract.** Ping the backend session (this one) if any field shape has changed unexpectedly or a new `source` string needs decoding.
