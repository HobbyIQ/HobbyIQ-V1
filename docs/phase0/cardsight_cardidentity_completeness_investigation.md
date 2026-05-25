# CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS — Investigation Findings

**Date:** 2026-05-25
**Workstream type:** Read-only investigation + 1 live API probe.
**Time budget:** 1-2 hours.
**Investigation question:** Does Cardsight expose `setName` / `year` (or
equivalent metadata) via an endpoint or response shape we're not currently
consuming? If yes, can we retire the `parsedQuery` fallback in
`fetchSiblingSales` (introduced B.4.c, preserved e2d5864) and make
`cardIdentity` the true source of truth?

**Headline outcome:** **YES — `/catalog/cards/{id}` returns rich metadata
including `releaseName` ("Bowman Chrome"), `setName` ("Base Set"),
`releaseYear` ("2018"), `parallels[]`, `attributes[]`, and `releaseId`
/ `setId` entity references.** The data is available via the existing
`getCardDetail` endpoint already wrapped in `cardsight.client.ts`. **But
a pre-existing field-mapping bug in `_getCardDetail` prevents the
backend from consuming it correctly today.**

## 1. Current state — how cardIdentity is constructed today

[`findCompsViaCardsight`](../../backend/src/services/compiq/cardsight.router.ts#L140)
builds `baseCard` from the `pricing.card` object embedded in
`getPricing(cardId)`'s response, at lines 174-189:

```ts
const baseCard: CardHedgeCard = {
  card_id: mapped.cardId,
  title: pricing.card?.name ?? undefined,
  player: pricing.card?.player ?? pricing.card?.name ?? undefined,
  set: pricing.card?.setName ?? undefined,
  year: pricing.card?.year ?? undefined,
  number: pricing.card?.number ?? undefined,
  variant: mapped.parallelId ?? undefined,
};
```

This `baseCard` becomes the `cardIdentity` consumed downstream by
`fetchComps`, `fetchSiblingSales`, and others.

**Observed gap (B.4.c.3 diagnostic, 2026-05-25)**: `pricing.card?.setName`
and `pricing.card?.year` come back undefined for Cardsight-exclusive
resolved cards, leaving `cardIdentity.set = null` and
`cardIdentity.year = null`. This is what triggered the parsedQuery
fallback chain in `fetchSiblingSales`.

## 2. Hypothesis tested

The B.4.c-era assumption was that Cardsight simply doesn't expose
setName/year — that pricing.card is the only place those fields could
live, and they're not there. The investigation tested whether the
separate `getCardDetail` endpoint (already wrapped in
`cardsight.client.ts:261-319` via `_getCardDetail`) returns richer
metadata.

## 3. Findings — live API probe of `/catalog/cards/{ohtani-uuid}`

Direct call to `https://api.cardsight.ai/v1/catalog/cards/9551abef-ed4b-4662-bcd3-181549e704b2`
with the production API key. Full response:

```json
{
  "id": "9551abef-ed4b-4662-bcd3-181549e704b2",
  "name": "Shohei Ohtani",
  "number": "1",
  "releaseName": "Bowman Chrome",
  "setName": "Base Set",
  "releaseYear": "2018",
  "releaseId": "6881a376-56c9-4df6-9b81-61310e9cf707",
  "setId": "ff0230ac-e699-48db-a339-885ba412d964",
  "parallelCount": 8,
  "parallels": [
    { "id": "...", "name": "Blue Refractor",    "numberedTo": 150 },
    { "id": "...", "name": "Gold Refractor",    "numberedTo": 50 },
    { "id": "...", "name": "Green Refractor",   "numberedTo": 99 },
    { "id": "...", "name": "Orange Refractor",  "numberedTo": 25 },
    { "id": "...", "name": "Purple Refractor",  "numberedTo": 250 },
    { "id": "...", "name": "Red Refractor",     "numberedTo": 5 },
    { "id": "...", "name": "Refractor",         "numberedTo": 499 },
    { "id": "...", "name": "SuperFractor",      "numberedTo": 1 }
  ],
  "attributes": ["MLB-LAA", "RC"]
}
```

**Field-by-field availability via `/catalog/cards/{id}`:**

| Field | Present? | Value example | Notes |
|-------|----------|---------------|-------|
| `id` | ✅ | UUID | Card identity |
| `name` | ✅ | "Shohei Ohtani" | Equals the player name in this case |
| `number` | ✅ | "1" | Card number |
| `releaseName` | ✅ | "Bowman Chrome" | **This is the user's "product"** |
| `setName` | ✅ | "Base Set" | Subset within release |
| `releaseYear` | ✅ | "2018" | **String, NOT number; field name is `releaseYear` not `year`** |
| `releaseId` | ✅ | UUID | Release entity reference |
| `setId` | ✅ | UUID | Set entity reference |
| `parallels[]` | ✅ | 8 parallels with id/name/numberedTo | Useful for V2 Approach B (parallel enumeration) |
| `attributes[]` | ✅ | `["MLB-LAA", "RC"]` | Team + rookie flag |
| `player` | ❌ | NOT in response | Player attribution gap remains |
| `parallelCount` | ✅ | 8 | Bonus enumeration field |

### Pre-existing mapping bug surfaced

[`_getCardDetail`](../../backend/src/services/compiq/cardsight.client.ts#L286-L319) maps the response at lines 300-308:

```ts
return {
  id: body.id ?? cardId,
  name: body.name ?? "",
  number: body.number ?? "",
  releaseName: body.releaseName ?? "",
  setName: body.setName ?? "",
  year: body.year ?? 0,             // ← BUG: API returns body.releaseYear (string)
  parallels: Array.isArray(body.parallels) ? (body.parallels as CardsightParallel[]) : [],
};
```

**Mapping bug**: `body.year` is never present in the API response (the
field is `body.releaseYear`, as a string). The mapper always returns
`year: 0` regardless of the actual data. This affects every existing
caller of `getCardDetail` (mapper's disambiguation path, the parallel-
resolution path) — they all see `year: 0`.

**Note also**: the `CardsightCardDetail` TypeScript interface declares
`year: number`, but the API actually returns a string. The mapper would
need either string-to-number coercion or a type-shape change.

The mapper does correctly read `body.setName` and `body.releaseName`,
so those fields ARE plumbed through getCardDetail today — but no
caller currently consumes them.

### What pricing.card returns vs what getCardDetail returns

For the same Ohtani card_id, the two endpoints have asymmetric responses:

- `getPricing(cardId).card` → sparse: only `id`, `name`, `number` (per
  B.4.c.3 observation; `setName`/`year` came back undefined)
- `getCardDetail(cardId)` → rich: `releaseName`, `setName`, `releaseYear`,
  `parallels[]`, `attributes[]`, `releaseId`, `setId`

This is a Cardsight API design choice, not a consumption-layer mapping
gap. **Two different endpoints; two different completeness levels.**

## 4. Recommendation

**Implementation feasible — retire parsedQuery fallback after fix.**

### Path forward (if approved)

**Step 1 — Fix the `_getCardDetail` mapping bug** (~30 min)
- Map `body.releaseYear` to the year field (with string-to-number
  coercion, OR widen the type to accept `string | number`)
- Verify the mapper's existing callers (cardsight.mapper.ts uses
  `detail.number` and `detail.parallels` — unaffected by the year
  change; should be backward-compatible)

**Step 2 — Augment `findCompsViaCardsight` to call `getCardDetail`**
(~30-45 min)
- After `getPricing` resolves, also call `getCardDetail(mapped.cardId)`
  to populate the rich metadata fields
- Build `baseCard` with `set: detail.setName`, `year: detail.year`,
  `releaseName: detail.releaseName`
- Two parallel calls add ~latency for the detail probe; if Cardsight's
  cache is warm both will be fast. May want to opportunistically use
  the existing `detail` from cardsight.mapper.ts when it's already
  been fetched during disambiguation (avoid double-fetch)

**Step 3 — Retire parsedQuery fallback** (~30 min)
- Once cardIdentity carries setName/year reliably, the
  `siblingFallback` parameter in `fetchSiblingSales` becomes dead
  code path
- Remove `SiblingSalesFallback` interface + caller wiring
- Update tests to drop fallback-related cases
- Diagnostic logs evolve: drop `(cardIdentity.set=... fallback.set=...)`
  line since cardIdentity is now the truth

**Total estimated scope**: **~1.5-2 hours** implementation + tests + smoke.

### Tradeoffs

- ✅ `cardIdentity` becomes true source of truth (cleaner abstraction)
- ✅ Closes a known bug (the `body.year` mapping issue affects
  mapper's existing code paths too, even though no one consumes
  `detail.year` directly today)
- ✅ Surfaces `releaseId` / `setId` UUIDs that could enable more
  precise sibling discovery in V2 (e.g., "all cards in release X"
  via a hypothetical Cardsight endpoint)
- ✅ `parallels[]` rich enough to support V2 Approach B (parallel
  enumeration for Layer 3 backstop)
- ⚠️ Adds one extra Cardsight API call per `findCompsViaCardsight`
  invocation (`getCardDetail`). Mitigations: existing cardsight.client
  `cacheWrap` for `getCardDetail` is 24h TTL (vs 6h for pricing) — so
  detail is heavily cached. Worst-case worth measuring after deploy.
- ⚠️ Player attribution still NOT solved — `getCardDetail` doesn't
  return `player` either. The current `pricing.card?.player ??
  pricing.card?.name` fallback chain stays. Out of scope here.

### Alternative considered — direct in-fetchSiblingSales `getCardDetail` call

We could skip Step 2 entirely and have `fetchSiblingSales` itself
call `getCardDetail` when cardIdentity is sparse, rather than
plumbing the data through `findCompsViaCardsight`. Rejected because:

- Adds duplicated logic at the sibling-discovery layer (
  `fetchSiblingSales` shouldn't know about `getCardDetail`)
- Doesn't fix the root issue (cardIdentity is structurally incomplete);
  just patches one symptom
- Other consumers (e.g., future code reading `card.set` from
  cardIdentity) wouldn't benefit

Step 2 (augment `findCompsViaCardsight`) is the cleaner architectural
choice.

## 5. Implementation scope estimate

**~1.5-2 hours** for the full path (fix mapper bug → augment
findCompsViaCardsight → retire parsedQuery fallback) including tests
and live smoke. Risk: low — bug fix + one new API call + cleanup of
recently-introduced fallback code.

**Implementation is a separate workstream.** This investigation
documents the finding and recommendation; the implementation requires
separate authorization (same pattern as CF-CARDSIGHT-SIBLING-DISCOVERY
investigation → implementation split).

## Cross-references

- [CF-CARDSIGHT-SIBLING-DISCOVERY investigation](./cardsight_sibling_discovery_investigation.md) at 84d8f85
- B.4.c (`2ce306d`) — Layer 3 implementation that introduced cardIdentity sparsity gate
- e2d5864 — CF-CARDSIGHT-SIBLING-DISCOVERY Approach A implementation (parsedQuery fallback preserved here)
- Cardsight API surface inventory: [cardsight_sold_comp_capability.md](./cardsight_sold_comp_capability.md)
- Cardsight catalog coverage characterization: [cardsight_coverage_characterization.md](./cardsight_coverage_characterization.md)
