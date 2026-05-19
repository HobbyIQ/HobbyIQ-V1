# ADR: Replace Card Hedge with Cardsight as CompIQ Pricing Data Source

**Status:** Proposed (May 18, 2026)

---

## Context

### Current State
CompIQ's pricing engine currently depends exclusively on Card Hedge AI as its sold-data source. The Card Hedge integration (`backend/src/services/compiq/cardhedge.client.ts`) provides three primary functions:
- `searchCards(query, limit)` — catalog search returning player + product metadata
- `identifyCard(query)` — AI-driven card matching with confidence scoring
- `getCardSales(cardId, grade, limit)` — historical sold comp data with raw and graded filtering

The pricing engine (`compiqEstimate.service.ts`) calls these functions across 5 call sites (lines 606, 628, 709, 713, 755) to populate comp data for both free-text queries and pinned card ID lookups.

### Migration Driver
Card Hedge has become an operational liability:
- **Unresponsive vendor support:** Issues reported 3+ weeks ago remain unresolved
- **Stale data:** Baseline cases (May 18, 2026) show thinned comp counts (e.g., Wander Franco: 4 comps vs. 10+ expected)
- **Declining reliability:** Comp supply for even high-volume cards (Ohtani 2018 Topps Chrome RC) has degraded significantly

Cardsight has proven responsive, willing to address specific data gaps, and is contractually available on paid tier as of May 18, 2026.

### Cardsight Evaluation Findings (May 18, 2026)

**Strengths:**
- **Structural parallel cataloging:** 24 parallels for 2024 Bowman Chrome Leo De Vries Prospect Autographs, each with own UUID and `numberedTo` field
- **Multi-grader coverage:** PSA, SGC, BGS, TAG, Arena Club, CGC in single response
- **Depth on high-volume cards:** 1432 records for 2018 Topps Chrome Ohtani RC PSA 10 vs. Card Hedge's 27
- **Fresh data:** Sales from current day across test cards
- **Reasonable latency:** 100–500ms typical for catalog + pricing calls

**Quirks to handle in design:**
- Player-only catalog search returns boutique products ranked above base cards; combined "player + release name" query is the working pattern
- The `/v1/catalog/cards` endpoint's `player=` filter parameter is silently ignored
- The `/v1/pricing/{card_id}` endpoint's `grade=` filter parameter is silently ignored; grade filtering must be done in code by walking response structure
- Parallel attribution on individual sale records is empty; parallel filtering requires `?parallel_id=` query param on pricing endpoint
- Some baseball cards have catalog entries but zero pricing data
- Catalog terminology requires learning ("Chrome Prospect Autographs" vs. CompIQ's "Prospects Autographs")
- The `/v1/subscription` endpoint returns the API key in plaintext (must not be called in logged code paths)

---

## Decision

Replace Card Hedge with Cardsight as the primary and only pricing data source for CompIQ baseball card pricing. Execution will proceed in phases (described in Migration Plan) with shadow-mode validation before cutover.

---

## Architecture

### High-Level Data Flow

```
iOS/API User Query
        ↓
compiqEstimate.service.ts
        ↓
        ├─ Mapping Layer: CompIQ query → Cardsight catalog query
        ├─ Cardsight Catalog API: resolve player + product to base card_id
        ├─ Cardsight Card Detail API: fetch parallel list if applicable
        ├─ Cardsight Pricing API: fetch raw + graded sales records
        ├─ Translation Layer: Cardsight response → Card Hedge comp shape
        └─ Engine Consumes: RawComp[] (shape unchanged from Card Hedge)
        ↓
Pricing Model (Mechanism 1, Mechanism 2, etc.)
        ↓
Predicted Price + Confidence
```

The engine's internal comp shape (`interface RawComp { price: number; title: string; soldDate: string; }`) remains unchanged. The translation layer absorbs all Cardsight-to-Card Hedge structural differences.

### File Structure

**New files to create:**
- `backend/src/services/compiq/cardsight.client.ts` — Cardsight API wrapper with function signatures matching Card Hedge consumer expectations
- `backend/src/services/compiq/cardsight.mapper.ts` — Release name, set name, and parallel name dictionaries; catalog disambiguation logic
- `backend/src/services/compiq/cardsight.translator.ts` — Cardsight response shape → `RawComp[]` translation

**Existing files to modify:**
- `backend/src/services/compiq/compiqEstimate.service.ts` — Add feature flag `CARDSIGHT_ENABLED`; conditional routing at call sites (lines 606, 628, 709, 713, 755)
- `backend/harness/tier1/_helpers.ts` — Update test cases with Cardsight baseline expectations
- `backend/harness/tier1/baselines/*.json` — Refresh all 25 baseline files post-cutover

**Files to deprecate (post-cutover):**
- `backend/src/services/compiq/cardhedge.client.ts` — Mark as deprecated; retain for 90 days as cold backup

**Files to delete (final cleanup, >90 days post-cutover):**
- `backend/src/services/compiq/cardhedge.client.ts`
- `backend/src/services/compiq/ebayFallback.ts` (already dead code; unrelated but safe to remove in same PR)

### Cardsight Client Module (`cardsight.client.ts`)

**Exports:**
```typescript
export interface CardsightCard {
  card_id: string;
  name: string;
  number: string;
  set: { set_id: string; name: string; year: number; release: string };
  parallels?: Array<{ id: string; name: string; numberedTo?: number }>;
}

export interface CardsightSale {
  price: number;
  date: string | null;
  grade: string;        // "Raw" or grading company + grade (e.g. "PSA 10")
  source: string;
  title: string;
  url: string | null;
}

export async function searchCatalog(
  query: string,
  filters?: { year?: number; segment?: string; take?: number }
): Promise<CardsightCard[]>

export async function getCardDetail(cardId: string): Promise<CardsightCard | null>

export async function getPricing(
  cardId: string,
  options?: { parallelId?: string; grade?: string; limit?: number }
): Promise<CardsightSale[]>

export async function findCompsByQuery(
  playerName: string,
  options?: {
    cardYear?: number;
    product?: string;
    parallel?: string;
    grade?: string;
    limit?: number;
  }
): Promise<{
  card: CardsightCard | null;
  sales: CardsightSale[];
  variantWarning: string[];
  aiCategory: string | null;  // always null for Cardsight (no AI match service)
}>
```

**Auth:**
- Header: `X-API-Key: process.env.CARDSIGHT_API_KEY`
- Timeout: 20 seconds (match Card Hedge)
- Retry: exponential backoff on 429/500+ (not present in Card Hedge; add as strength over CH)

**Catalog Search — Baseball-Only Filter:**
- All `searchCatalog()` calls pass `segment=baseball` as a query parameter
- This filters the Cardsight catalog to baseball cards only
- Non-baseball cards (basketball, football, etc.) are excluded at the API layer, not in CompIQ code
- Example: `searchCatalog("Michael Jordan", { segment: "baseball", year: 1986, take: 20 })` returns zero results
- Verified during May 18, 2026 evaluation: queries for non-baseball players with `segment=baseball` filter returned 0 results

**Non-Baseball Card Handling:**
- `aiCategory` field is always returned as `null` by `cardsight.client.ts` (Cardsight has no AI card categorization service like Card Hedge)
- Non-baseball detection is handled by the Cardsight API's `segment=baseball` filter (not by CompIQ engine logic)
- When a non-baseball card is queried:
  1. Mapper layer calls `searchCatalog()` with `segment: "baseball"`
  2. Cardsight returns zero catalog results (no baseball match)
  3. Mapper detects zero results and returns empty comp list to engine
  4. Engine's existing zero-comp handling produces a "no data found" response to the user
- Functionally equivalent to Card Hedge's unsupported-sport behavior but delegated to API layer
- Scope: CompIQ is baseball-only per product requirements; segment filter is sufficient for scope
- Future expansion: If CompIQ adds football or basketball, `segment` parameter can be parameterized from input
- Technical debt: Card Hedge's aiCategory-based unsupported-sport guard (in `compiqEstimate.service.ts`) becomes vestigial after cutover; mark for cleanup in PR #8 but do NOT delete during migration itself

**Error Handling:**
- Return `[]` on any HTTP error or network timeout (match Card Hedge behavior)
- Log errors at WARN level with function name and query for debugging
- Do NOT expose API key in error messages

**Caching:**
- Catalog search: 6 hours (match Card Hedge)
- Card detail: 24 hours (includes parallel metadata; can be longer than comps)
- Pricing: 6 hours (match Card Hedge comps TTL)
- Cache keys: `cs:catalog:{query}`, `cs:detail:{card_id}`, `cs:pricing:{card_id}` (avoid "ch:" prefix to prevent cross-module cache collision)

### Mapping Layer (`cardsight.mapper.ts`)

**Release Name Dictionary:**
```typescript
const COMPIQ_TO_CARDSIGHT_RELEASES: Record<string, string> = {
  "Topps Chrome": "Topps Chrome",
  "Topps Chrome Update": "Topps Chrome Update",
  "Bowman Chrome": "Bowman Draft Chrome",  // Note: Cardsight uses "Bowman Draft Chrome"
  "Bowman Draft": "Bowman Draft",
  "Bowman Draft Chrome": "Bowman Draft Chrome",
  "Panini Prizm": "Panini Prizm",
  "Donruss": "Donruss",
  // ... add all supported products
}
```

**Set Name Disambiguation Rules:**
```typescript
const CARDSIGHT_SET_PATTERNS: Record<string, RegExp> = {
  "Topps Chrome Base": /^Base Set$/,
  "Topps Chrome Refractor": /^Refractor$/,
  "Topps Chrome Prospect Auto": /^Chrome Prospect Autograph/,
  // ... expand as needed
}
```

**Parallel Name Normalization:**
```typescript
function normalizeParallel(compiqParallel: string | null): string | null {
  if (!compiqParallel) return null;
  // Cardsight parallel names: "Blue Raywave Refractor", "Gold Wave Refractor", etc.
  // CompIQ parallel names may have casing/spacing diffs
  const normalized = compiqParallel
    .split(/[\s-]+/)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
  return normalized;
}
```

**Catalog Search Strategy:**
1. Build query as `"{playerName} {releaseName}"` (e.g., "Shohei Ohtani Topps Chrome")
2. Call `/v1/catalog/search?q={query}&year={year}&segment=baseball&take=20`
3. Filter results: `releaseName === dictLookup(compiqProduct)` AND `setName` matches expected pattern
4. If no exact match, use heuristic: "best seller" ranking within Baseball segment (first result is most likely)
5. Validate returned card before pricing call (see Error Cases)

**Parallel Disambiguation:**
- When `compiqParallel` is provided, call `/v1/catalog/cards/{card_id}` to fetch `parallels[]`
- Match `parallel.name` against normalized `compiqParallel` (case-insensitive substring match)
- If parallel found, use `parallel.id` as `?parallel_id=` param on pricing call
- If parallel not found, log WARN and fetch base card pricing (fall back to raw + all graded)

### Translation Layer (`cardsight.translator.ts`)

**Objective:** Convert Cardsight's nested graded structure into Card Hedge's flat comp list, filtering graded response to requested grade(s).

**Input Shape (Cardsight `/v1/pricing/{card_id}` response):**
```json
{
  "card": { "card_id", "name", "number", "set": {...} },
  "raw": {
    "count": 50,
    "records": [
      { "title": "...", "price": 950, "date": "2026-05-18T...", "source": "eBay", ... }
    ]
  },
  "graded": [
    {
      "company_name": "PSA",
      "grades": [
        {
          "grade_value": "10",
          "count": 98,
          "records": [
            { "title": "...", "price": 1200, "date": "2026-05-17T...", ... }
          ]
        },
        { "grade_value": "9", "count": 45, "records": [...] }
      ]
    },
    { "company_name": "SGC", "grades": [...] }
  ],
  "meta": { "total_records": 500, "last_sale_date": "2026-05-18", ... }
}
```

**Output Shape (Card Hedge-compatible):**
```typescript
interface RawComp {
  price: number;
  title: string;
  soldDate: string;
}
```

**Translation Algorithm with Grade Filtering:**

Note: Cardsight's `grade=` query parameter is silently ignored; grade filtering must be performed in code post-fetch.

**Inputs to translation function:**
- `response` — Cardsight pricing API response
- `requestedGradeCompany` — user's grading company (e.g., "PSA", "SGC", or null/empty for raw-only)
- `requestedGradeValue` — user's grade value (e.g., "10", "9.5", or null/empty for raw-only)

**Processing logic:**

1. **Determine request type:** Is this a raw-only request, graded-only request, or mixed?
   - Raw-only: `requestedGradeCompany` is null/empty/undefined
   - Graded-only: `requestedGradeCompany` is specified (e.g., "PSA"), treat `requestedGradeValue` as specific grade or all grades for that company
   - Mixed: Not supported in current CompIQ flow; treat as graded-only per gradeCompany

2. **Extract graded sales (if gradeCompany specified):**
   - Walk `response.graded[]` array
   - Find company entry where `company_name` (case-insensitive) === `requestedGradeCompany`
   - If company NOT found: log WARN, return empty graded list (do NOT include raw)
   - Within matched company, walk `grades[]` array:
     - If `requestedGradeValue` specified: find grade where `grade_value` === `requestedGradeValue`
     - If `requestedGradeValue` NOT specified: include ALL grades in company
   - If grade(s) NOT found within company: log WARN, return empty graded list (do NOT include raw)
   - For each matching grade entry, map `grade.records[]` → `RawComp[]` with grade field set to `"{company_name} {grade_value}"` (e.g., "PSA 10")
   - Concatenate all matching grades into single array

3. **Extract raw sales (if applicable):**
   - ONLY include raw sales if `requestedGradeCompany` is null/empty (raw-only request)
   - EXCLUDE raw sales if graded company was specified (even if graded company returned 0 records)
   - If raw-only: map `response.raw.records[]` → `RawComp[]` with grade field set to "Raw"

4. **Combine results:**
   - If graded-only: return graded records only
   - If raw-only: return raw records only
   - Do NOT mix raw and graded in same response

5. **Sort by date (descending):** Most recent first, matching engine's expectations

6. **Parallel filtering:**
   - If pricing call was made with `?parallel_id={id}`, assume records are already filtered to that parallel
   - If base card pricing (no parallel specified), records contain all parallels; log WARN "Unfiltered parallel data returned"

7. **Handle empty results:** Return `[]` (matching Card Hedge)

**Edge Cases:**

- **gradeCompany specified, no matching company in response:**
  - Example: user requests "SGC 10" but Cardsight has only PSA data
  - Behavior: return empty list, log WARN, do NOT fall back to raw
  - Engine treats as "no comps found for grade"

- **gradeCompany + gradeValue specified, grade not found within company:**
  - Example: user requests "PSA 10" but Cardsight has PSA 9, PSA 8 only
  - Behavior: return empty list, log WARN, do NOT include other PSA grades
  - Engine treats as "grade unavailable"

- **gradeCompany specified but NO grades array:**
  - Example: company_name exists but grades is empty/missing
  - Behavior: return empty list, log WARN

- **gradeCompany not specified (raw-only request):**
  - Include only `response.raw.records[]`, skip all graded[]

### Error and Edge Cases

**Case 1: Cardsight catalog returns 0 results**
- Log WARN with query and fallback expectations
- Return `{ card: null, sales: [], variantWarning: ["cardsight_no_catalog_match"], aiCategory: null }`
- Engine treats as "no comps" and falls back to historical average or manual floor

**Case 2: Catalog entry exists, pricing returns 0 records**
- Log WARN with card_id
- Return `{ card: {...}, sales: [], variantWarning: ["cardsight_no_pricing_data"], aiCategory: null }`
- Signal to user/support that a catalog gap needs attention

**Case 3: Cardsight rate limit hit (HTTP 429)**
- Exponential backoff with jitter (e.g., 1s, 2s, 4s, 8s)
- After 3 retries, return `[]` and log ERROR
- Trigger alert to ops (optional: set flag to downgrade to Card Hedge fallback temporarily)

**Case 4: Cardsight API outage**
- HTTP 500+ after retries
- Return `[]` and log ERROR
- Feature flag `CARDSIGHT_ENABLED` can be reverted to false in Config if outage is sustained

**Case 5: Search ranking returns wrong card**
- **Example:** "Michael Jordan 1986 Fleer" returns 1996 Jordan Upper Deck as first result
- **Mitigation:** After catalog search, validate returned card by checking:
  - Player name substring match in response.card.name
  - Release name exact match with dictionary lookup
  - Year match (within 1 year due to late releases)
- If validation fails, try second candidate, then fallback to no match

**Case 6: Parallel attribution missing on records**
- Cardsight's individual sale `records[].parallel_name` is empty
- **Already handled in mapper:** Use `?parallel_id=` query param to filter at API level
- If parallel_id not used (base card pricing), all parallels mixed in response
- Engine's existing parallel filter (cardQueryParser) will apply post-fetch; Cardsight can't do better without API change

**Case 7: Multiple grading companies (PSA + SGC + BGS)**
- Engine was historically called with a single grade (e.g., "PSA 10")
- Cardsight returns all graders in one response
- **Translation layer responsibility:** Walk all companies; concatenate all matching-grade records into single list
- Engine's confidence model may need recalibration to handle multi-grader depth (PSA 10: 98 records + SGC 10: 45 records = 143 total)

**Case 8: Outlier sales (e.g., $4000 Ohtani)**
- Ohtani evaluation found a $4000 sale with mismatched title ("2018 Topps Chrome Shohei Ohtani RC #150 PSA 10 GEM MINT eBay Authenticated" → actual graded at PSA 8)
- Engine's existing outlier detection / variance logic applies post-fetch
- **No Cardsight-specific mitigation needed** (title mismatch filtering is optional quality gate, not required for functional parity)

---

## Migration Plan — PR Sequence

### Phase 1: Foundation (No Breaking Changes)

**PR #1: Add Cardsight Client Module**
- Files: `backend/src/services/compiq/cardsight.client.ts`
- Exports: `searchCatalog()`, `getCardDetail()`, `getPricing()`, `findCompsByQuery()`
- Caching: Integrated via `cacheWrap()`, no disk I/O
- Auth: Read `CARDSIGHT_API_KEY` from env
- Tests: Unit tests for each function with mocked API responses
- Risk: Low (new module, not yet called)

**PR #2: Add Mapping Layer**
- Files: `backend/src/services/compiq/cardsight.mapper.ts`
- Exports: Release/set/parallel dictionaries; `buildCatalogQuery()`, `normalizeParallel()`, `validateCardMatch()`
- Tests: Unit tests on dictionary coverage, test card set matching
- Risk: Low (utilities, no production calls yet)

**PR #3: Add Translation Layer**
- Files: `backend/src/services/compiq/cardsight.translator.ts`
- Exports: `toRawComps()` function converting Cardsight response to `RawComp[]`
- Tests: Unit tests with real Cardsight API response samples from evaluation
- Risk: Low (translation utility, no production calls yet)

### Phase 2: Shadow Mode (Parallel Running)

**PR #4: Shadow Mode Behind Feature Flag**
- File: `backend/src/services/compiq/compiqEstimate.service.ts`
- Change: Add `CARDSIGHT_ENABLED` feature flag (default: false)
- At lines 606, 628, 709, 713, 755: Branch on flag; call Cardsight if enabled, Card Hedge if disabled

**Shadow Mode Logging Structure:**

Log both Card Hedge and Cardsight results in parallel. Logging schema (structured JSON):
```typescript
{
  source: "card_hedge" | "cardsight",
  queryHash: "<sha1(playerName+year+product+parallel+grade)>",  // dedupe tool
  requestTimestamp: "<ISO8601>",
  card: CardsightCard | CardHedgeCard | null,
  sales: RawComp[] | CardHedgeSale[],
  variantWarning: string[],
  aiCategory: string | null,  // always null for Cardsight; may be "Baseball", "Basketball", etc. for Card Hedge
  compsCount: number,
  durationMs: number
}
```

Logging destination: Structured logging (suggested `backend/logs/shadow-mode/{YYYY-MM-DD}.jsonl` or equivalent; implementer choice in PR #4 code review). Each shadow query should append one line of JSON to shadow log, not to console. This enables post-processing to compare Cardsight vs Card Hedge coverage and pricing.

**Tests:** Harness runs against Card Hedge (primary). Shadow mode test suite calls both providers for same inputs and logs divergence metrics.

**Risk:** Medium (introduces feature flag logic; potential for flag states to diverge)

**Shadow Mode Success Criteria (Minimum Viable):**

Before proceeding to PR #5 (baseline refresh), shadow mode must complete AND meet all of the following:

1. **Duration:** Minimum 2 calendar weeks of production shadow traffic (to capture day-of-week effects and market variations)

2. **Cardsight Coverage:** For cards where Card Hedge returned data, Cardsight must return data for at least 80% of shadow queries
   - Rationale: Identifies systematic coverage gaps early
   - Exception: Cards that were catalog-only (no pricing in Cardsight) must be logged separately and reviewed

3. **Tier 1 Baseline Coverage:** Cardsight must return comp data for at least 20 of the 25 Tier 1 test cases (80% pass rate)
   - Rationale: Ensures migration can support production workload; 5-case tolerance for known limitations
   - Cases with 0 Cardsight comps must be manually reviewed (why? catalog gap? pricing gap? real zero-liquidity card?)

4. **Price Divergence Review:** Any case where Cardsight and Card Hedge produce predicted prices diverging by >50% must be manually reviewed
   - Rationale: Catches data quality issues or fundamental comp set differences
   - Review decision: Is the divergence justified (real market shift, Cardsight has more recent data) or a data problem?
   - Decision: document in PR #4 review or PR #5 blocker comment

5. **No Cardsight Outages:** Zero sustained (>1 hour) Cardsight API outages during shadow period
   - Rationale: Demonstrates API reliability before cutover
   - Transient errors (<1 min) logged but not blockers

**Unblock Criteria for PR #5:**

PR #5 (baseline refresh) can proceed only when:
- Shadow mode has run for ≥2 calendar weeks
- All success criteria above are met OR documented exceptions are approved in writing
- Any >50% price divergence cases are resolved (confirmed data issue or acceptable market difference)

### Phase 3: Baseline Refresh

**PR #5: Refresh Tier 1 Harness Baselines**
- Files: All 25 files under `backend/harness/tier1/baselines/*.json`
- Process: Run harness against Cardsight-only (flag forced true); capture Cardsight baseline outputs; commit as new baselines
- Document: ADR entry explaining baseline drift driver (comp source change, not engine regression)
- Tests: All 25 Tier 1 cases pass with Cardsight data
- Risk: High (baseline updates are visible but expected)
- Blockers: Shadow mode must have revealed and mitigated any critical gaps (e.g., missing catalog entries)

### Phase 4: Cutover

**PR #6: Enable Cardsight as Primary (Cutover PR)**
- Files: `backend/src/services/compiq/compiqEstimate.service.ts` (flip flag default to true)
- Feature flag remains in code for easy rollback
- Tests: All Tier 1 pass; manual smoke tests on production endpoints
- Risk: High (cutover irreversible without flag revert + Card Hedge keys still active)
- Monitoring: Alert on Cardsight error rates, 500+ responses, rate limiting

### Phase 5: Cold Backup Retention

**PR #7: Mark Card Hedge as Deprecated**
- File: `backend/src/services/compiq/cardhedge.client.ts`
- Change: Add `@deprecated` JSDoc; comment explaining 90-day retention policy
- Tests: None (read-only documentation)
- Risk: Low

### Phase 6: Cleanup (90+ Days Post-Cutover)

**PR #8: Remove Card Hedge Client & ebayFallback**
- Files: Delete `backend/src/services/compiq/cardhedge.client.ts` and `backend/src/services/compiq/ebayFallback.ts`
- Remove import from `compiqEstimate.service.ts`
- Tests: Ensure no remaining references to deleted modules
- Risk: Low (only after 90 days, flag tested, no emergency rollbacks needed)

---

## Harness Implications

### Baseline Refresh Required
All 25 Tier 1 baseline files will require refresh because:
1. **Comp data source changes:** Cardsight returns 10–100x more sales than Card Hedge for popular cards (Ohtani: 27 → 1432)
2. **Parallel depth:** Cardsight disambiguates parallels; Card Hedge conflates them
3. **Grader diversity:** Cardsight includes SGC, BGS, TAG; Card Hedge was PSA-only
4. **Price distributions:** Multi-grader data shifts percentile calculations (p50, p75) and volatility estimates

### Refresh Discipline
- Before cutover, run harness against Cardsight in shadow mode (flag forced true)
- Document baseline drift in ADR as expected (comp source change, not regression)
- Capture Cardsight outputs; commit as new baselines in PR #5
- Use same discipline as `ADR-tier1-baseline-refresh-2026-05-18.md`

### Tier 2/3 Implications
- Tier 2 (intermediate liquidity) and Tier 3 (thin liquidity) are future phases; currently unimplemented
- No blocking dependencies for Cardsight migration
- Recommend seeding Tier 2/3 baselines with Cardsight data if/when those tiers are enabled

---

## Cost & Tier Considerations

### Cardsight Pricing Tier
- **Current plan:** Paid tier as of May 18, 2026
- **Projected API call volume:** ~100–300 calls/day during shadow mode (logging both CH + CS); ~100–200 calls/day post-cutover (CS only)
- **Seasonal spikes:** 2–3x during set releases, playoff season
- **Rate limits:** Confirm with Cardsight support before cutover

### Monitoring
- Track API calls per day and per endpoint in first 30 days
- Alert if usage approaches tier limits
- Prepare cost projection for annual commitment

### Tier Lock Requirement
Before proceeding to PR #4 (shadow mode), negotiate written commitment from Cardsight on:
- Pricing tier locked for 12 months at agreed call volume (e.g., 500 calls/day)
- No unilateral rate limit reductions without 30 days notice

---

## Vendor Commitments to Secure in Writing

**Before cutover (PR #6), Cardsight must provide:**

1. **Uptime SLA:** Minimum 99.5% availability; response within 5 seconds p99
2. **Data gap process:** Defined escalation for missing catalog entries or pricing data
   - User submits card details
   - Cardsight confirms catalog entry or adds within 48 hours
   - Cardsight provides pricing data source / update timeline
3. **API stability:** 30 days notice before breaking changes (endpoint signature, field removal, filter behavior changes)
4. **Tier pricing:** Locked rate for agreed call volume; pricing adjustments only annually
5. **Support contact:** Designated technical contact for emergency outages

---

## Rollback Plan

### 90-Day Cold Backup Retention
- Keep `CARD_HEDGE_API_KEY` active in production config for 90 days post-cutover
- Keep `cardhedge.client.ts` in repo (marked deprecated but functional)
- Feature flag `CARDSIGHT_ENABLED` remains in code for easy revert

### Emergency Revert Procedure
If Cardsight suffers sustained outage (>30 min) or data quality catastrophe:
1. Flip `CARDSIGHT_ENABLED = false` in production config
2. Deploy change (5 min)
3. Monitor Card Hedge error rates (may be higher due to stale keys / rate limits)
4. Notify Cardsight support of revert reason
5. Plan root cause investigation + restart once stability confirmed

### Post-Cutover Testing
- Daily smoke tests for first 7 days: fetch estimate for 5 high-volume cards, validate non-null prices
- Weekly spot-check: compare Cardsight comp counts vs. expected ranges (Ohtani: 500+, etc.)

---

## Open Questions

1. **Variant mismatch detection:** Card Hedge has sophisticated token-based variant validation (`cardMatchesTokens()`, `tokenMismatches()`). Cardsight's parallel-specific querying may make this redundant, or it may still be needed as a fallback when parallel matching fails. Clarify scope during PR #1 review.

2. **Multi-grader data:** Engine historically processed single-grade filters (e.g., "PSA 10"). When Cardsight returns PSA + SGC + BGS in one response, how should the engine weight across graders?
   - Option A: Blend all graders equally (current plan, see translation layer)
   - Option B: Filter to PSA-only for backward compatibility
   - Option C: Confidence-weight graders by liquidity
   - Recommend: Option A (more data is better), but confirm in PR #4 review

3. **Ohtani $4000 outlier:** Evaluation found a $4000 sale with mismatched title. Cardsight confirmed the listing error. Should the translation layer implement optional title/parallel validation to filter obvious data quality issues?
   - Recommendation: Optional; implement in PR #3 as utility, enable conditionally in PR #4 shadow mode

4. **Missing catalog entries:** Cardsight will have gaps (rare/boutique cards, new releases). Should CompIQ require fallback to Card Hedge for catalogs misses, or fail gracefully?
   - Recommendation: Fail gracefully (return zero comps, log WARN for user/support to escalate to Cardsight)

5. **Tier 2/3 harness:** Current plan is Tier 1 only. What's the timeline for Tier 2/3 baseline creation? Should Cardsight data be used, or should CH remain cold backup until all tiers seeded?
   - Recommendation: Seed Tier 2/3 with Cardsight data in parallel track; don't block Tier 1 cutover

---

## References

- **Card Hedge limitations:** Evaluation findings, unresponsive vendor, stale data — documented in meeting notes May 17–18, 2026
- **Cardsight evaluation findings:** This document's Context section; detailed API response shapes from probe May 18, 2026
- **Cardsight API docs:** https://cardsight.ai/documentation/api-reference
- **Cardsight Node SDK:** https://github.com/CardSightAI/cardsightai-sdk-node (optional; direct HTTP wrapper sufficient for now)
- **CompIQ existing data layer:** [backend/src/services/compiq/cardhedge.client.ts](../../../src/services/compiq/cardhedge.client.ts)
- **CompIQ pricing engine:** [backend/src/services/compiq/compiqEstimate.service.ts](../../../src/services/compiq/compiqEstimate.service.ts#L755) (primary call site line 755)
- **Tier 1 harness discipline:** [backend/harness/tier1/README.md](../../../harness/tier1/README.md)
- **Prior baseline refresh ADR:** [backend/docs/decisions/ADR-tier1-baseline-refresh-2026-05-18.md](./ADR-tier1-baseline-refresh-2026-05-18.md)
- **Feature flagging pattern:** See `compiqEstimate.service.ts` line ~100 for existing boolean flag patterns (e.g., `COMPIQ_NEIGHBOR_SYNTHESIS`)
