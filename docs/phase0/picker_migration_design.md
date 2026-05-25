# CF-PICKER-MIGRATE-TO-CARDSIGHT — Design Phase

**Date:** 2026-05-25
**Workstream type:** Locked design. No implementation in this commit.
**CF reference:** Captured in [aff2245] as blocking prerequisite to
CF-CARDHEDGE-FULL-REMOVAL.

**Headline:** Migrate `/api/compiq/cardsearch` and `/api/compiq/search-list`
from CardHedge's `searchCards` to Cardsight's `searchCatalog` +
`getCardDetail` + `/v1/images/cards/{id}`. Four design questions locked
under D-clean (coordinated iOS + backend deploy via TrendIQ Phase 2).
Implementation is a separate future workstream; this doc ships locked
decisions for cleared-context action.

## 1. Current state — Phase 1.1 inventory

### 1.1.a — Picker endpoints

**`/api/compiq/cardsearch`** ([compiq.routes.ts:292-342](../../backend/src/routes/compiq.routes.ts#L292-L342))

- Request: `{query: string, limit?: number}` (cap 50, default 50)
- Calls: `searchCards(query.trim(), cap)` from `cardhedge.client`
- Response: `{ok: true, hits: [{card_id, title, player, year, set, card_number, variant, image_url}]}`
- No caching (no `cacheWrap`)
- Image normalization tries 5 CardHedge fields: `front_image_url, image_url, front_image, image, images[0].url`
- Title fallback chain: `description → title → name → "${year} ${set} ${player} #${number}"`
- iOS use: variant picker — shows thumbnails

**`/api/compiq/search-list`** ([compiq.routes.ts:736-842](../../backend/src/routes/compiq.routes.ts#L736-L842))

- Request: `{query: string}` only
- Calls: `searchCards(query.trim(), 30)` via dynamic import
- Response: `{success, query, count, filters: {wantsAuto, wantedColors}, results: [...]}` capped at 20
- Cached 15min (`cacheWrap` key `compiq:search-list:v2:${normalized_query}`)
- Per-row shape: `{cardHedgeCardId, player, set, year, number, variant, isAutograph, title, displayLabel}`
- Autograph detection regex against blob of `set+number+title+name+variant`:
  - `AUTO_TEXT_RE: /\b(auto|autograph|autographs|signature|signed)\b/i`
  - `AUTO_NUMBER_RE: /(^|[^a-z])(cpa|cda|bdpa|cra|cdra|prospect ?auto|1st\s*pa|pa-|-au\b|ap-|rap)/i`
- Color scoring + rookie boost ranking with stable sort
- Filter: when `wantsAuto`, hide non-autograph variants entirely
- iOS use: card picker — text-only display via `displayLabel`

### 1.1.b — `cardhedge.client.searchCards`

- POST `/cards/card-search`
- Body: `{search, category: "Baseball", page: 1, page_size: clamp(limit, 1, 50)}`
- Returns `CardHedgeCard[]`: `{card_id, player?, set?, year?, number?, variant?, title?, name?}`
- Hard-locked to category="Baseball"

### 1.1.c — Cardsight equivalent surface

| Field | searchCatalog | getCardDetail | Notes |
|-------|---------------|---------------|-------|
| `id` | ✅ | ✅ | UUID |
| `name` | ✅ | ✅ | Often = player name |
| `number` | ✅ | ✅ | Card number |
| `releaseName` | ✅ | ✅ | Product line ("Bowman Chrome") |
| `setName` | ✅ | ✅ | Subset ("Base Set", "Chrome Prospect Autographs") |
| `releaseYear` | ✅ (year string) | ✅ (releaseYear string) | Coerced via mapper post-a6c6dd9 |
| `player` | ❌ usually undefined | ❌ | Gap remains |
| `parallels[]` | ❌ | ✅ `{id, name, numberedTo}` | Rich variant enumeration |
| `attributes[]` | ❌ | ✅ `["MLB-LAA", "RC"]` or `["AUTO"]` | Per probe 2026-05-25 |
| `manufacturerName` | ✅ ("Topps") | ❌ | Bonus field on search response |
| `relevance` | ✅ (search ranking score) | ❌ | searchCatalog only |
| Card images | ❌ | ❌ | Available via separate endpoint `/v1/images/cards/{id}` per Cardsight vendor response |

Caches: catalog 6h, detail 24h. Both hard-locked to `segment=baseball`.

### 1.1.d — iOS contract inference

No backend tests for either picker endpoint exist. iOS contract inferred
from response shapes:

- `/cardsearch` per row: `card_id, title, player, year, set, card_number,
  variant, image_url`. **iOS variant picker renders thumbnails.**
- `/search-list` per row: `cardHedgeCardId, player, set, year, number,
  variant, isAutograph, title, displayLabel`. **iOS card picker
  text-only via displayLabel.**

### 1.1.e — Probe-vs-docs lesson (worth capturing)

The image-availability probe missed Cardsight's `/v1/images/cards/{id}`
endpoint because the probe guessed endpoint patterns
(`/catalog/cards/{id}/images`, `/images/{id}`, etc.) rather than the
actual structure `/images/cards/{id}`. Cardsight vendor docs would
have surfaced the right endpoint immediately.

**Lesson for future API exploration**: prefer documented endpoint
inventory over guessed patterns. If a vendor provides API docs,
Phase 1.1's primary reference should be those docs — guessed probes
are a fallback when docs are unavailable.

## 2. Why migration is needed

Per CardHedge scope correction at `aff2245`:

- Cardsight migration replaced the PRICING path (`/price`, `/price-by-id`,
  `/bulk` via `computeEstimate` → `cardsight.router` exclusive branch).
- PICKER path (`/cardsearch`, `/search-list`) is still CardHedge-direct.
- CardHedge subscription cancelled 2026-05-19 but API key may remain live
  through billing cycle.
- **CardHedge cannot be deleted from active code until picker migration
  ships** (CF-CARDHEDGE-FULL-REMOVAL blocker).

## 3. Context shift acknowledged

Yesterday's analysis (under "Question D pre-locked as D1 strict
preservation") chose A1 composite encoding (`cardHedgeCardId =
"${cardId}.${parallelId}"`) as the optimal under-constraint solution.
This pass relaxes D and supersedes that choice with A5.

**Context update**: sole-user pre-launch product. iOS rebuilds are free
when coordinated with backend deploy. D1 strict preservation was
over-applied for general "production safety" framing that doesn't
apply here.

**A1 reasoning preserved for reference** in case future contexts re-impose
strict preservation. The locked design supersedes with A5 under D-clean.

## 4. Question A — Variant disambiguation (LOCKED: A5)

### Decision

**A5 — Separate `parallelId` field on picker response.** Each picker row
carries `cardId` (Cardsight UUID) + `parallelId` (nullable string). One
Cardsight card with N parallels produces N+1 picker rows: 1 base row
(`parallelId: null`) + N parallel rows (each with their `parallelId`).

`/price-by-id` accepts `{cardId, parallelId?}` — type-safe, no parsing.

### Sub-decision A.i — Field naming

Standardize on **camelCase** across the picker response. Locked renames
bundled with this migration:

- `cardHedgeCardId` → `cardId` (drop legacy contract debt; CardHedge name
  was permanent contract debt baked into iOS clients)
- `card_number` → `cardNumber`
- `image_url` → `imageUrl`
- New field: `parallelId` (camelCase)

### Sub-decision A.ii — Variant string composition

Single `variant` field combines parallel name + numbered-to + autograph
suffix into one picker-ready display string. Composition rules:

**Rules:**

1. If parallel exists: start with `parallel.name` (e.g., "Blue Refractor")
2. If `isAutograph` true: append ` Auto` if not already present in name
   (case-insensitive check)
3. If `parallel.numberedTo` present: append ` /${numberedTo}`
4. If no parallel AND no autograph: `variant = null`
5. If no parallel AND autograph: `variant = "Auto"`

**Worked examples:**

- Bonemer Blue Refractor (auto card, /150 parallel) → `"Blue Refractor Auto /150"`
- Bonemer base auto (no parallel) → `"Auto"`
- Ohtani 2018 Bowman Chrome #1 base raw (non-auto) → `null`
- Ohtani Refractor /499 (non-auto) → `"Refractor /499"`
- Hypothetical Topps Heritage Auto Red /5 (auto + numbered + colored parallel) → `"Red Auto /5"`

**Implementation phase must:**

1. Verify whether Cardsight's `parallels[].name` already includes /N info
   (if yes, backend doesn't double-append; if no, backend appends).
   Bonemer's probe showed `numberedTo` as a separate numeric field
   (`numberedTo: 150`); name is just `"Blue Refractor"`. So backend
   appends.
2. Compose `variant` deterministically per these rules.
3. Unit-test all five worked examples plus edge cases (empty
   parallel.name, parallel name already containing "Auto",
   parallel.numberedTo missing, etc.).

### Locked `/cardsearch` per-row shape

```ts
{
  cardId: string;              // Cardsight UUID
  parallelId: string | null;   // null for base, UUID for parallels
  player: string | null;
  year: number | null;
  set: string | null;          // releaseName from Cardsight (product line)
  cardNumber: string | null;   // Cardsight `number`
  variant: string | null;      // composed per A.ii rules
  isAutograph: boolean;        // per B3
  title: string | null;
  imageUrl: string | null;     // /v1/images/cards/{cardId} URL per C.i.a
}
```

### Locked `/search-list` per-row shape

```ts
{
  cardId: string;              // Cardsight UUID
  parallelId: string | null;
  player: string | null;
  year: number | null;
  set: string | null;
  number: string | null;       // kept as `number` to match prior /search-list shape
                               // (NOTE: inconsistent with /cardsearch's `cardNumber`;
                               // alternative is to rename here too for full
                               // consistency — implementation phase decides)
  variant: string | null;
  isAutograph: boolean;
  title: string | null;
  displayLabel: string;        // "YEAR SET PLAYER #NUMBER VARIANT" preserved
}
```

Note: `/search-list` does NOT carry `imageUrl` (text-only picker — unchanged).

### Reasoning summary

- D1 strict preservation forecloses A5 (additive field), A2 (new endpoint), A3 (silently mispredicting variant)
- D-clean enables A5 with the rename to `cardId` cleaning up legacy
  CardHedge naming debt
- Cleanest data model; type-safe deserialization; no composite parsing
- Better App Insights debug visibility (filter `where parallelId is null`)
- No legacy contract debt accumulated; rename completes the migration

### Rejected alternatives (reasoning preserved)

- **A1 (composite encoding)**: yesterday's choice under D1 strict; now
  obsolete. A1 baked synthetic encoding semantics into a legacy field
  name; A5 with rename to `cardId` breaks both forms of debt at once.
- **A2 (two-step UX)**: changes iOS interaction (base picker → tap →
  parallel picker → tap). Worse picker UX than A5; A5 keeps one-step
  picker.
- **A3 (auto-pick most-recent-sold parallel)**: silently mispredicts
  variant. User owning Blue Refractor specifically gets Base pricing.
  Rejected on correctness grounds.

## 5. Question B — Autograph detection (LOCKED: B3 hybrid)

### Decision

**B3 hybrid** — backend computes `isAutograph: boolean` internally
using a hybrid of `attributes[]` and setName regex:

```ts
isAutograph = attributes?.includes("AUTO")
           || /\b(auto|autograph|autographs|signature|signed)\b/i.test(setName ?? "")
```

Both signals come from `getCardDetail` which is being called per
search result anyway (under A5, getCardDetail is needed for parallels[]).
Attributes[] is free; setName is from the same response.

### Worked examples (from probes 2026-05-25)

- Bonemer Chrome Prospect Autographs: `attributes: ["AUTO"]` + `setName: "Chrome Prospect Autographs"` → `isAutograph: true` (both signals fire)
- Ohtani 2018 Bowman Chrome #1: `attributes: ["MLB-LAA", "RC"]` + `setName: "Base Set"` → `isAutograph: false`
- Hypothetical card with curation gap (no AUTO in attributes but setName carries "Auto"): setName regex catches it
- Hypothetical curated card with AUTO attribute but unusual setName: attributes[] catches it

### Defensive design choice

Both signals included for resilience:

- If Cardsight stops curating `attributes[]` for some cards → setName regex catches them
- If Cardsight changes setName conventions (e.g., different capitalization) → `attributes[]` catches them

### Inherited semantics under A5

All N+1 picker rows for a given Cardsight card share the same
`isAutograph` value. The parent's setName + attributes determine the
boolean once; every row (base + all parallels) inherits.

### Dropped from current /search-list

`AUTO_NUMBER_RE` prefix-regex (`CPA-`, `CDA-`, `BDPA-`, `1stPA`, `PA-`,
`-AU`, `AP-`, `RAP`) is **DROPPED**. It was CardHedge-era defensive
complexity for cards CH didn't tag explicitly. Cardsight tags
autographs in TWO places (`attributes[]` + `setName`); number-prefix
regex no longer needed.

### Variant string interaction (A.ii × B3)

When `isAutograph` is true, A.ii rule 2 appends ` Auto` to the variant
string (unless the parallel name already contains "auto"
case-insensitively). Cardsight observation: none of Bonemer's 22
parallels include "auto" in `parallel.name` — autograph is entirely a
parent-card signal. So the suffix-append is the consistent behavior.

### Implementation tests required

- Bonemer Blue Refractor variant string: `"Blue Refractor Auto /150"`
- Bonemer base auto: `variant = "Auto"`
- Ohtani base raw: `variant = null`
- Ohtani Refractor /499: `variant = "Refractor /499"`
- Edge: empty setName, attributes[] missing entirely, setName mixed case
  ("AutoGraphs"), parallel.name with embedded "/N" (verify no
  double-append)

## 6. Question C — Image strategy (LOCKED: C.i.a)

### Decision

**C.i.a — single `imageUrl` field on `/cardsearch` only.** `/search-list`
remains text-only.

### Field semantics

- `imageUrl: string | null` on `/cardsearch` response per row
- Value: `https://api.cardsight.ai/v1/images/cards/{cardId}` (or
  Cardsight placeholder fallback per documented 404 behavior)
- Renamed from `image_url` per A.i camelCase consistency

### Reasoning

- Only `/cardsearch` consumes images (per Phase 1.1.d inferred
  contract; per the handler's own comment). `/search-list` is text-only.
- Picker rows are thumbnail-sized; one URL suffices
- Detail view consumes pricing endpoints (which already include
  `listingImage`), not /cardsearch — image-needs decoupled
- Exposing two fields (thumbnail + full) when only one is consumed
  adds shape complexity without value

### Deferred to implementation phase

- Per-parallel image URL composition: does Cardsight's
  `/v1/images/cards/{id}` accept `parallelId` for parallel-specific
  images? Or do parallels share the base image? Unknown without probe.
- Exact placeholder fallback parameter (Cardsight vendor noted
  placeholder is supported; specific parameter form is implementation
  detail)
- Sizing params if Cardsight's endpoint supports thumbnail vs full
  query params

### Cardsight capabilities beyond picker scope (future awareness)

Per Cardsight vendor response, these capabilities exist but are NOT
in CF-PICKER-MIGRATE-TO-CARDSIGHT scope:

- `/v1/identify/card` — image upload for card identification (defaults
  to baseball segment). Potentially useful for iOS card-scan flows in
  a future workstream.
- Comp/pricing endpoints include `source`, `listingUrl`, `listingImage`
  fields. Could enhance the price-view UI with listing thumbnails
  (separate future workstream).

## 7. Question D — iOS contract (LOCKED: D-clean)

### Decision

**D-clean** — coordinated iOS + backend deploy as part of TrendIQ
Phase 2 work. Backend ships clean shape; iOS Phase 2 updates iOS to
consume the new shape.

### Field renames in this migration

- `cardHedgeCardId` → `cardId` (drops legacy contract debt)
- `card_number` → `cardNumber` (camelCase consistency)
- `image_url` → `imageUrl` (camelCase consistency)

### Additive field

- `parallelId: string | null` — new field per A5

### Request shape changes

- `/price-by-id` accepts `{cardId, parallelId?}` (was `{cardHedgeCardId}`).
- `/cardsearch` and `/search-list` requests are unchanged (free-text
  query in, structured rows out).

### iOS coordination plan

- Backend ships migration with new picker contract
- iOS Phase 2 work (separate session) updates iOS to consume:
  - `cardId` instead of `cardHedgeCardId` (rename)
  - `parallelId` as a new field passed back to `/price-by-id`
  - `cardNumber`, `imageUrl` field renames
- Backend deploy + iOS App Store update ship together

### Contract debt cleanup acknowledged

`cardHedgeCardId` was permanent contract debt — a field name baked into
iOS clients after the deprecated CardHedge provider, persisting via
backward-compat under D1 strict preservation. D-clean retires that
debt. Other naming inconsistencies (`card_number` snake_case vs
`cardHedgeCardId` camelCase in same response) also cleaned up in one
migration moment.

## 8. Implementation scope estimate (honest)

**Total: ~6-9 hours focused work, single PR.**

| Phase | Work | Estimate |
|-------|------|----------|
| A | `/cardsearch` migration: searchCatalog + getCardDetail fan-out, A5 row composition, imageUrl URL composition, A.ii variant strings, B3 autograph detection, A.i field renames | ~2-3h |
| B | `/search-list` migration: same fan-out + ranking logic adapted from CardHedge field names to Cardsight; preserve color scoring + autograph-filter UX | ~1.5-2h |
| C | `/price-by-id` request-shape update: accept `{cardId, parallelId?}`, drop cardHedgeCardId from contract | ~30-45min |
| D | Tests: new picker test files (no existing coverage), A.ii variant string examples, B3 autograph edge cases, integration tests for picker → /price-by-id | ~1-1.5h |
| E | Cleanup: update 5 test files that mock cardhedge.client.searchCards for non-picker scenarios; remove dead picker-related imports | ~30-45min |
| F | Live smoke + production verification (separate deploy authorization) | ~30-45min |

**Why this is at the HIGH end of expected ~4-6h range:**

- TWO endpoints needing migration, not one
- N+1-row composition under A5 requires per-result getCardDetail
  fan-out (extra complexity vs CardHedge's flat-row response)
- No existing test coverage = new test files needed
- 5 peripheral test files indirectly affected by removing
  cardhedge.client.searchCards usage

**Recommended at authorization time**: full 6-9h scope, not
sub-scoped. Reasons:

- Both endpoints must migrate for CF-CARDHEDGE-FULL-REMOVAL to close
- Test coverage is non-negotiable for iOS-facing migration with no
  existing safety net
- Half-migration creates worse intermediate state than current state

## 9. Risks + open questions for implementation phase

- **Per-result getCardDetail fan-out latency**: pickers fan out
  N×detail calls. 24h cache mitigates after first hit, but first-search
  of unfamiliar query may be slow. Mitigation options at implementation:
  bounded concurrency, fail-fast on detail failure, possibly pre-warm
  cache for popular tracked-player queries.
- **iOS image-cache storms**: picker open triggers N thumbnail fetches.
  Mitigation: lazy-load (only fetch visible rows), iOS Phase 2 decides.
- **Cardsight image endpoint per-parallel support**: unknown if
  `/v1/images/cards/{cardId}` accepts `parallelId`. Implementation
  probe required. If parallels share base image, picker still renders;
  if distinct images exist, backend includes parallelId in URL.
- **Color scoring + autograph filter UX from /search-list**: current
  logic ranks by query-color match + autograph match + rookie boost.
  Implementation must preserve this ranking adapted to Cardsight
  fields. Worked examples needed in tests.
- **Stale cached CardHedge cardIds in iOS local storage**: those
  values are 36-char CH UUIDs that fail under CARDSIGHT_MODE=exclusive
  today. After this migration, they still fail (no semantic change).
  iOS Phase 2 should clear stale cache on app update.

## 10. Cross-references

- [aff2245] — CardHedge scope correction surfacing this CF
- [a6c6dd9] — CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS investigation
  (getCardDetail shape, releaseName/setName/year semantics)
- [220f783] — CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS implementation
  (cardIdentity augmentation; relevant for understanding how
  releaseName flows through the system)
- Cardsight vendor response (image endpoint confirmed at
  `/v1/images/cards/{id}`; identify/listingImage capabilities noted
  for future)
- [docs/phase0/cardsight_sold_comp_capability.md] — Cardsight API
  surface inventory
- [docs/phase0/cardsight_coverage_characterization.md] — coverage gaps
  in `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary

## 11. Implementation authorization

Implementation is a **separate workstream authorization**. This design
ships locked decisions for a future session to act on with cleared
context. iOS Phase 2 coordination is the natural pairing: both ship
together.

When authorized, implementation should:

1. Open the implementation workstream with this doc as the spec
2. Confirm Cardsight image endpoint parameter form (placeholder
   fallback specifics; parallelId support) via small probe
3. Execute Phases A-F per the table in §8
4. Live smoke verifies new picker shape; iOS Phase 2 verifies
   client-side consumption
5. CF-CARDHEDGE-FULL-REMOVAL becomes unblocked
