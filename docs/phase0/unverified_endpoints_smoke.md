# Unverified endpoints smoke — characterization

**Date:** 2026-05-26
**Status:** Read-only smoke + findings doc. No code changes shipped.
**Scope:** Three endpoints listed in the carry-forward queue as unverified for broader coverage: `/api/compiq/search`, `/api/compiq/bulk-estimate`, `/api/compiq/analyze`.

## TL;DR

- **`/api/compiq/search` works correctly** for full structured queries (player + year + product). Returns expected estimate. Degrades gracefully for partial/typo queries.
- **`/api/compiq/bulk-estimate` does not exist.** The actual endpoint is `/api/compiq/bulk`. Smoke ran against `/bulk`.
- **`/api/compiq/bulk` has a latent content defect.** Returns `source: no-recent-comps` (zero comps) for queries that work fine on `/search` and `/estimate`. Cause identified — CH-identity guard interaction with the bulk handler's "pass whole query as playerName" pattern. Iso PortfolioIQViewModel.refreshPortfolio() is the consumer and is currently affected.
- **`/api/compiq/analyze` does not exist.** No route registration. Only reference is a stale comment in `compiqService.ts`. iOS may or may not call this; if it does, it's getting 404 in production.

## Endpoint discovery

### `/api/compiq/search` ([compiq.routes.ts:291](../../backend/src/routes/compiq.routes.ts#L291))

**Comment:** "Used by DashboardView free-text search"
**Input:** `{ query: string }` (free-text)
**Output:** Full estimate shape (`marketTier`, `buyZone`, `holdZone`, `sellZone`, `fairMarketValueLive`, `predictedPrice`, `predictedPriceRange`, `trendAnalysis`, `confidence`, `compsUsed`, `compsAvailable`, `source`, ...)
**Implementation:** `parseCardQuery(query)` → `requestFromParsed(parsed)` → `computeEstimate(body)` → response projection
**Test coverage:** None dedicated (no `compiqSearch*.test.ts` file)

### `/api/compiq/bulk` (not `/bulk-estimate`) ([compiq.routes.ts:923](../../backend/src/routes/compiq.routes.ts#L923))

**Note:** The endpoint name in the carry-forward queue was `/bulk-estimate`. The actual route is `/bulk`. iOS PortfolioIQViewModel.refreshPortfolio() is the documented consumer (per the route's comment).
**Input:** `{ queries: string[] }` (array of free-text queries; cap=20)
**Output:** `{ requested, succeeded, failed, results: [{ query, status: "ok"|"error", data, error }] }`
**Implementation:** `Promise.allSettled(queries.map(q => computeEstimate({ playerName: q.trim() })))` — **passes the entire query as `playerName` with no parsing**
**Test coverage:** `compiqBulkShape.test.ts` covers response shape, not content correctness

### `/api/compiq/analyze` — DOES NOT EXIST

Comprehensive grep across `backend/src/routes/**` confirms no `router.post("/analyze"...)` or equivalent. The only reference in the codebase is `compiqService.ts:1`:

```typescript
// Legacy/mock CompIQ analysis for /price, /search, /analyze only. Not used for /estimate.
```

This is a stale comment in a legacy/mock service file. iOS clients calling `/api/compiq/analyze` would receive `404 Route POST /api/compiq/analyze not found`.

## Smoke results

All tests ran against production hobbyiq3 at SHA `190604b` (current main HEAD).

### `/api/compiq/search`

| # | Query | Status | Source | FMV | Comps | Latency | Note |
|---|---|---:|---|---:|---:|---:|---|
| T1 | `"Mike Trout"` | 200 | no-recent-comps | null | 0 | 335ms | Player-only — expected weak result |
| T2 | `"Mike Trout 2011"` | 200 | live | $79 | 25 | 2662ms | Resolves to a DIFFERENT Trout 2011 card (likely a Bowman insert, not the TU RC). 25 comps but $79 ≠ TU RC's ~$333 — surfaces wrong card for partial query |
| T3 | `"Mike Trout 2011 Topps Update"` | 200 | live | **$265** | **15** | 468ms | Correct demo card, matches yesterday's defect #13 v2 smoke (minor FMV variation from comp churn) |
| T4 | `"Mike Trou"` (typo) | 200 | no-recent-comps | null | 0 | 1702ms | Parser doesn't recover; reasonable |
| T5 | `"Smith"` (common name) | 200 | no-recent-comps | null | 0 | 2094ms | Can't disambiguate; reasonable |
| T6 | `""` (empty) | 400 | n/a | n/a | n/a | 44ms | Proper 400 rejection with `Missing "query" field` |

### `/api/compiq/bulk`

| # | Input | Status | Items | OK/Err | Latency | Note |
|---|---|---:|---:|---|---:|---|
| T1 | array of 5 demo cards | 200 | 5 | 5/0 | 750ms | **All 5 returned `source: no-recent-comps`, FMV null, compsUsed 0** — broken |
| T2 | array of 1 demo card | 200 | 1 | 1/0 | 47ms | Same defect (no-recent-comps) |
| T3 | empty array `[]` | 400 | n/a | n/a | 38ms | Proper 400 rejection |
| T4 | `null` queries | 400 | n/a | n/a | 41ms | Proper 400 rejection |

### `/api/compiq/analyze`

| # | Input | Status | Note |
|---|---|---:|---|
| T1 | demo card body | 404 | `Route POST /api/compiq/analyze not found` |

## Findings

### Finding 1: `/api/compiq/bulk` returns 0 comps for queries that work on `/search` and `/estimate` — DEFECT

**Severity:** High. iOS `PortfolioIQViewModel.refreshPortfolio()` is the documented consumer. Portfolio refresh currently produces no-recent-comps for any card whose set name appears in the query string. Pre-launch the impact is limited (no real users); post-launch this would degrade the portfolio screen for every iOS user with multi-card holdings.

**Reproduction:**

| Endpoint | Query | Source | FMV | Comps |
|---|---|---|---:|---:|
| `/search` | `"Mike Trout 2011 Topps Update"` | live | $265 | 15 |
| `/estimate` | `{playerName:"Mike Trout", cardYear:2011, product:"Topps Update"}` | live | $265 | 15 |
| `/bulk` | `{queries:["Mike Trout 2011 Topps Update"]}` | **no-recent-comps** | **null** | **0** |

Same input, same backend resolution path (computeEstimate), three different outcomes. /bulk is the outlier.

**Root cause (analyzed against current code):**

The `/bulk` handler at [compiq.routes.ts:934](../../backend/src/routes/compiq.routes.ts#L934) calls:

```typescript
const est = await computeEstimate({ playerName: query.trim() });
```

It passes the entire query string as `playerName` without parsing. So for `"Mike Trout 2011 Topps Update"`:
- `body.playerName = "Mike Trout 2011 Topps Update"` (full string)
- `body.cardYear`, `body.product` = undefined

Inside `computeEstimate`, the defensive parseCardQuery fallback (defect #11) fires correctly:
- `needsParseFallback` = TRUE (year regex matches; cardYear/product undefined)
- `parsed = {playerName: "Mike Trout", year: 2011, set: "Topps Update", ...}`
- `queryContext` = `{playerName: "Mike Trout", cardYear: 2011, product: "Topps Update", ...}`

So far so good — resolveCardId gets clean queryContext and resolves correctly (just like /search).

**The breaking interaction is the CH-identity guard at [compiqEstimate.service.ts:1194-1219](../../backend/src/services/compiq/compiqEstimate.service.ts#L1194-L1219):**

```typescript
if (fetched.card && body.playerName && !body.cardHedgeCardId) {
  const wanted = body.playerName
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter((t) => t.length >= 4);
  const haystack = ((fetched.card.player ?? "") + " " + (fetched.card.title ?? "")).toLowerCase();
  const missingSurnames = wanted.filter((t) => !haystack.includes(t));
  if (wanted.length > 0 && missingSurnames.length > 0) {
    // discards ALL comps
  }
}
```

The guard uses `body.playerName` (the raw input — `"Mike Trout 2011 Topps Update"`), splits it on whitespace, filters tokens ≥ 4 chars:

```
"Mike Trout 2011 Topps Update" → ["mike", "trout", "topps", "update"]  (2011 dropped as <4 chars)
```

Then checks ALL tokens against the haystack = `card.player + " " + card.title`. For the resolved Mike Trout TU card, the haystack from Cardsight is approximately `"mike trout mike trout"` (per the defect #7 fix where `pricing.card.name` falls back to `pricing.card.player`).

- `"mike"` ✓ (in haystack)
- `"trout"` ✓
- `"topps"` ✗ (NOT in card name)
- `"update"` ✗ (NOT in card name)

`missingSurnames = ["topps", "update"]` — non-empty → guard fires → **all comps discarded** → response becomes `no-recent-comps`.

For `/search` this doesn't happen because `requestFromParsed` produces `body.playerName = "Mike Trout"` (clean). The guard tokenizes just `["mike", "trout"]`, both in haystack, guard passes.

The CH-identity guard was designed for the Card Hedge era where iOS sent `playerName: "Mike Trout"` cleanly via the structured `/estimate` endpoint. The `/bulk` handler's choice to pass the whole free-text query as playerName violates the guard's assumption.

**Why test coverage missed this:**
- `compiqBulkShape.test.ts` tests response shape (object keys, types) but not content correctness for known-good cards
- No end-to-end smoke harness for /bulk with realistic queries existed before today

**Fix scope (NOT shipping today, captured as carry-forward):**

Two options, both small:

- **Option A — /bulk handler does parseCardQuery upstream (matches /search pattern).** Replace `computeEstimate({ playerName: query.trim() })` with `computeEstimate(requestFromParsed(parseCardQuery(query.trim())))`. ~3 LOC. Cleanest fix; treats /bulk symmetric to /search.

- **Option B — CH-identity guard tokenizes only the FIRST 2-3 surname tokens** instead of all ≥4-char tokens. ~5 LOC in `compiqEstimate.service.ts`. More robust but changes a guard that other code paths rely on.

**Recommendation: Option A.** Matches /search's existing parsing pattern. No risk to other endpoints. Future PR scope ~5-10 LOC including a test.

**Update 2026-05-27: Pre-implementation verification revised the F1 characterization.**

iOS `PortfolioIQViewModel.refreshPortfolio` uses a `TaskGroup` over per-card `/api/compiq/estimate` calls (via `APIService.shared.estimateCardDirect` at [CompatibilityShims.swift:2848-2883](../../HobbyIQ/CompatibilityShims.swift#L2848-L2883)), **NOT `/bulk`**. The endpoint has zero observed traffic in 7d App Insights window and no observed consumer in iOS Swift source as of 2026-05-27. The route's prior comment attributing it to `PortfolioIQViewModel.refreshPortfolio()` was stale or aspirational.

Defect remains real (set-bearing queries return `no-recent-comps` per yesterday's smoke). **Severity downgraded** from "High — affects portfolio refresh" to "broken endpoint with no current consumer."

Fix deferred until consumer identification. If the MCP rewire workstream's Phase 1 (`/api/compiq/comps-by-player` endpoint) produces an internal consumer for player-level aggregation, F1's fix may become a prerequisite for that consumer — the parseCardQuery-upstream pattern (Option A above) would be the same pattern applied to a different endpoint.

The `/bulk` route comment in `compiq.routes.ts` updated this session to reflect the actual state.

### Finding 2: `/api/compiq/search` returns wrong card for partial year-only queries — behavior gap, not defect

**Severity:** Low. iOS DashboardView likely sends full structured queries; partial queries are unusual. But the behavior surfaces as "$79 fmv for Mike Trout 2011" which looks like the demo Trout RC ($333) without being it.

**Reproduction:** `/search "Mike Trout 2011"` returns `source=live, fmv=$79, compsUsed=25`. This is a real Cardsight resolution to SOME Trout 2011 card (likely a Bowman insert or scout-list card from the Q1 catalog probe — Trout 2011 catalog has 16 candidates spanning Bowman, Bowman Chrome, Bowman Draft, Finest, Topps Update). With the year-only query, resolveCardId picks `candidates[0]` (or whichever pricing-probe selects).

**Not a defect** because the system is doing its best with the incomplete input. Worth noting iOS Dashboard's free-text search can present users with non-demo cards under partial queries; the UI might want to require year + set or surface the resolved cardIdentity prominently so users can verify.

**Carry-forward:** Note in iOS Dashboard's free-text search UX — surface resolved card identity (player + year + set + number) prominently so users can confirm or refine.

### Finding 3: `/api/compiq/analyze` does not exist — coverage gap, possibly stale iOS reference

**Severity:** Unknown (depends on whether iOS actually calls it).

`/api/compiq/analyze` was listed in the workstream spec as "iOS endpoint, unknown shape." Discovery confirms no such route exists in `backend/src/routes/**`. Only reference is a comment in `compiqService.ts` saying it's a "legacy/mock" service alongside `/price` and `/search`.

**Three possibilities:**

1. iOS never called this endpoint; the spec's reference was speculative
2. iOS used to call this; backend route was removed at some point but iOS reference wasn't cleaned up
3. iOS calls this under some flow not yet tested; would be silently 404ing in production

**Verification next step (not in this workstream):**

- Grep iOS Swift source for `compiq/analyze` references (if iOS code is in this repo)
- Check App Insights `requests` table for any `POST /api/compiq/analyze` entries over the last 24h (would show 404s if iOS is calling)

**Carry-forward:** Confirm whether iOS calls `/api/compiq/analyze`. If yes, decide between adding the route or fixing iOS to not call. If no, remove the stale comment in `compiqService.ts`.

## Carry-forward queue (new items from this smoke)

| # | Item | Severity | Scope estimate |
|---|---|---|---|
| F1 | `/api/compiq/bulk` returns 0 comps for set-bearing queries (CH-identity guard interaction) | High (affects iOS portfolio refresh) | ~5-10 LOC + test, Option A above |
| F2 | iOS Dashboard free-text search can surface non-demo cards on partial queries (e.g. year-only) | Low (UX guidance) | Out of backend scope; iOS UX consideration |
| F3 | `/api/compiq/analyze` route doesn't exist; iOS may still call it | Unknown | Verify iOS call pattern first; then either add route or remove iOS reference |
| F4 | No end-to-end smoke harness for `/bulk` with content correctness (only shape-test exists) | Low | Add to a test backfill workstream |

**None of these block the current MCP rewire workstream or any other in-flight work.**

## What this smoke does NOT do

- Doesn't fix `/api/compiq/bulk` (F1) — that's a separate small PR workstream
- Doesn't verify whether iOS calls `/api/compiq/analyze` — needs iOS code grep + App Insights query
- Doesn't add test coverage for the discovered defects
- Doesn't audit OTHER endpoints (`/cardsearch`, `/what-if`, `/grade-premium`, `/sell-window`) — those have their own coverage assumptions that may also be unverified

## Suggested next actions (not authorized, captured for the queue)

1. **Small PR for F1 — fix `/bulk` handler to parseCardQuery upstream.** ~30-60 min including tests + smoke. Touches one file (`compiq.routes.ts`). Independent of MCP rewire.
2. **iOS code grep for `/api/compiq/analyze` references** — 10 min read-only investigation to determine F3's severity.
3. **Stale `compiqService.ts:1` comment cleanup** — trivial, cosmetic. Can bundle with F1 fix PR if scope allows.

Out of scope without explicit authorization.
