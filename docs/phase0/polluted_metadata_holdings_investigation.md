# CF-POLLUTED-METADATA-HOLDINGS — Investigation Findings

**Date:** 2026-05-26
**Workstream type:** Read-only Cosmos investigation. No code changes, no
migrations. Findings inform next-CF scope + authorization.

**Major finding (changes the framing):** The "polluted metadata" symptom
is actually a **field-name contract mismatch** between the iOS write
path and the backend pricing read path. The data is present in Cosmos
under different field names than the pricing code reads. This is a
fundamentally easier fix than the diagnostic CF assumed.

---

## 1. Polluted-holdings characterization (Phase 1)

### Cohort

- **User:** `admin-testing-hobbyiq`
- **Total holdings:** 24
- **By the strict `cardYear` + `product` check:** 24/24 "polluted"
- **By practical extraction from on-disk data:** 13/24 have year + setName
  populated (under different field names); 11/24 are test fixtures with
  sparse metadata

### Two distinct data shapes coexist in production

**Shape A — iOS-real holdings (13 docs, UUID-style uppercase-hex IDs):**

```json
{
  "id": "8053921B-E6B6-491D-8F7E-39553C5E7507",
  "playerName": "Caleb Bonemer",
  "year": 2024,                                ← NOT cardYear
  "setName": "Bowman Chrome",                  ← NOT product
  "cardName": "2024 Bowman Chrome Blue",       ← NOT cardTitle
  "parallel": "Blue",
  "grade": "...",
  "purchasePlatform": "Ebay",
  "purchaseDate": "Apr 25, 2026",
  ...
}
```

Field names written: `year` / `setName` / `cardName`. **None of these
are read by the pricing code.**

**Shape B — test fixtures (11 docs, IDs like `test-holding-1`,
`ebay-sale-partial`, etc.):**

```json
{
  "id": "test-holding-1",
  "playerName": "Paul Skenes",
  "cardTitle": "2024 Bowman Chrome Auto",      ← canonical typed name
  "purchasePrice": 100,
  "quantity": 1,
  "totalCostBasis": 100,
  ...
}
```

Field names written: `cardTitle` (canonical). No `cardYear` / `product` /
`setName` / `year`. These test fixtures genuinely lack structured
metadata — they were inserted with display-text-only fields.

### Pattern analysis

| Dimension | Finding |
|---|---|
| `purchaseSource` field | 0/24 populated (field absent on every holding) |
| `purchaseDate` | 2/24 populated (Apr 25, May 9, 2026) — most are missing |
| `clientId` (iOS upsert indicator) | 0/24 populated |
| ID format: UUID v4 (uppercase) | 13/24 — iOS-real data |
| ID format: test-* / ebay-* | 11/24 — test fixtures |
| ALL CAPS playerName | 12/24 — includes variant text bleeding into player field |
| Mixed-case structured playerName | 12/24 |

### What's actually in the iOS-real holdings (13 docs)

| ID | playerName | year | setName | parallel |
|---|---|---:|---|---|
| 8053921B... | Caleb Bonemer | 2024 | Bowman Chrome | Blue |
| 9A76C334... | BOBBY COX | 1969 | Topps | (empty) |
| EED0F004... | MIKE TROUT WAL-MART BORDER | 2011 | Topps Update | Blue |
| F47AC10B... | Mike Trout | 2021 | Topps Chrome | (empty) |
| 6D217E3D... | Caleb Bonemer | 2024 | Bowman Chrome | Blue |
| 7BCB0A21... | PROSPECT AUTOGRAPHS LEO DE VRIES PROSPECT AU- RAYWAVE | 2024 | Bowman Chrome | Blue |
| 391ED290... | PROSPECT AUTOGRAPHS JOHN GIL CHR PROS - MINI DIA | 2025 | Bowman Chrome | Gold |
| C5C44FCC... | MIKE TROUT WAL-MART BORDER | 2011 | Topps Update | Blue |
| 05CD40AC... | TRADED TIFFANY GREG MADDUX TIFFANY | 1987 | Topps | TIFFANY |
| 4C327096... | TRADED TIFFANY GREG MADDUX TIFFANY | 1987 | Topps | TIFFANY |
| 0E7AAE4D... | CHROME PROSPECT AUTOGRAPHS GAGE WOOD CHR PROSPECT - REF | 2025 | Bowman Draft | Gold |
| 3FBBD31C... | TRADED KEN GRIFFEY JR. | 1989 | Topps | (empty) |
| 60BD6FEC... | TRADED KEN GRIFFEY JR. | 1989 | Topps | (empty) |
| EE9C49BD... | CHROME PROSPECT AUTOGRAPHS CALEB BONEMER CHR PROSPECT AU- SHIM | 2024 | Bowman Draft | Gold |
| 30E4E5F2... | PROSPECT AUTOGRAPHS TOMMY WHITE CHR PROS -MINI DIAMOND | 2025 | Bowman Chrome | CHR PROS AUTO-MINI DIAMOND |

**The data is there. It's just named wrong relative to what the pricing
code reads.**

A secondary problem visible in the playerName column: 9 of these 15 have
variant/parallel text bleeding into `playerName` ("MIKE TROUT WAL-MART
BORDER", "TRADED TIFFANY GREG MADDUX TIFFANY", "PROSPECT AUTOGRAPHS LEO
DE VRIES PROSPECT AU- RAYWAVE"). This is a separate metadata-quality
issue — the iOS add-card path or upstream scan is concatenating extra
tokens into the player field. Card-scan source likely.

### Clean holdings (`cardYear` AND `product` both populated): **ZERO**

Even the 3 "live"-pricing-working cards (BOBBY COX, Mike Trout, Bobby
Witt Jr) DON'T have `cardYear` or `product` populated. They work because
their `playerName` + nothing else is enough for Cardsight catalog to
match cleanly when the player is unambiguous.

---

## 2. Add-card path audit (Phase 2)

### Backend `addHolding` endpoint

[`backend/src/services/portfolioiq/portfolioStore.service.ts:766-823`](backend/src/services/portfolioiq/portfolioStore.service.ts#L766-L823):

```typescript
export async function addHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const incoming = (req.body ?? {}) as Record<string, unknown>;
  const { id, ...rest } = incoming;
  const holding: PortfolioHolding = {
    ...(rest as Omit<PortfolioHolding, "id">),
    id: normalizeId(id),
  };
  // ...write to Cosmos as-is...
}
```

**Schemaless write.** Whatever iOS sends in `req.body` is spread directly
onto the holding and persisted. No validation, no field normalization,
no required-field check. The `(rest as Omit<PortfolioHolding, "id">)`
type cast is cosmetic — TypeScript can't enforce runtime field names.

### TS type definition vs. iOS write reality

[`backend/src/types/portfolioiq.types.ts:1-69`](backend/src/types/portfolioiq.types.ts) defines
the canonical names:

- `cardYear?: number`
- `product?: string`
- `setName?: string`
- `cardTitle?: string`

iOS writes (per Cosmos inspection):

- `year: number` — NOT in the TS type (phantom field)
- `setName: string` — IN the type
- `cardName: string` — NOT in the TS type (phantom field)
- `cardTitle: string` — IN the type (test fixtures only)

**Phantom fields `year` and `cardName` are stored alongside canonical
fields. iOS likely never received the canonical contract.**

### What pricing code reads

[`portfolioStore.service.ts:269-283`](backend/src/services/portfolioiq/portfolioStore.service.ts#L269-L283)
inside `autoPriceHolding`:

```typescript
const estimate = await computeEstimate({
  playerName: String(holding.playerName ?? "").trim(),
  cardYear: toNumber(holding.cardYear, 0) || undefined,   ← reads cardYear (undef)
  product: String(holding.product ?? "").trim() || undefined,  ← reads product (undef)
  parallel: String(holding.parallel ?? "").trim() || undefined,
  isAuto: Boolean(holding.isAuto),
  gradeCompany: String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim() || undefined,
  gradeValue: toNumber((holding as any).gradeValue, 0) || undefined,
});
```

Reads `holding.cardYear` and `holding.product` — both undefined for the
13 iOS-real holdings. The `holding.year` and `holding.setName` fields
that ARE populated are never consulted.

`repriceHoldingsForUser` ([line 1488-1496](backend/src/services/portfolioiq/portfolioStore.service.ts#L1488-L1496))
has the same read pattern.

### Add-card paths inventory

1. **`POST /api/portfolio/holdings`** (manual add via iOS) — schemaless
   spread; produces the 13 iOS-real polluted holdings
2. **Direct Cosmos inserts** (test fixtures, ebay-* IDs) — sparse
   metadata, used for test scenarios; produces the 11 test-style docs
3. **eBay webhook ITEM_SOLD** ([ebayWebhook.routes.ts](backend/src/routes/ebayWebhook.routes.ts))
   — updates existing holdings or creates `ebay-sale-*` docs with
   minimal metadata (cardTitle only); produces test/integration data
4. **CSV import path** — not visible in current backend code; may be
   iOS-only

**Root cause:** the schemaless `addHolding` spread + iOS sending phantom
field names that don't match the type contract.

---

## 3. cardTitle parsing feasibility (Phase 3) — mostly moot

Re-evaluated in light of Phase 1 finding. Parsing was framed as the
fallback when metadata is missing. Reality:

- 13/24 holdings have year + setName populated (just under wrong names)
  → no parsing needed; field-name shim suffices
- 9/24 are sparse-metadata test fixtures → parsing irrelevant (they're
  test data)
- 2/24 (`test-holding-playerid-2` "Fake 2099 Phantom") are deliberately
  invalid test cases → parsing irrelevant

### For the test holdings that DO have cardTitle (e.g., "2024 Bowman Chrome Auto")

Regex extraction works perfectly when the cardTitle starts with year +
product:

| cardTitle | yearMatch | productMatch |
|---|---|---|
| "2024 Bowman Chrome Auto" | 2024 ✓ | "Bowman Chrome" ✓ |
| "2020 Bowman Chrome" | 2020 ✓ | "Bowman Chrome" ✓ |
| "Fake 2099 Phantom" | 2099 ✓ | (none) — no real product line |

**8/24 holdings (33%) had BOTH year + product extractable from
cardTitle.** These are mostly test fixtures.

For the iOS-real holdings, parsing playerName is hopeless — playerName
is contaminated with variant text ("MIKE TROUT WAL-MART BORDER",
"PROSPECT AUTOGRAPHS LEO DE VRIES PROSPECT AU- RAYWAVE") and contains
no year or product line on its own. But the iOS-real holdings DON'T
need parsing — they have the data in `year` + `setName`.

**Parsing path is NOT the right fix for the dominant cohort.**

---

## 4. Fix approach recommendations (Phase 4)

The original CF described four options (A/B/C/D). Phase 1's field-name
finding adds a fifth option that's lower-risk and higher-leverage than
any of the originals.

### Option E (NEW — recommended) — Backend field-name compatibility shim

**Approach:**

- In `autoPriceHolding` and `repriceHoldingsForUser`: read with fallback
  to alt field names:
  ```typescript
  cardYear: toNumber(holding.cardYear ?? (holding as any).year, 0) || undefined,
  product: String(holding.product ?? holding.setName ?? "").trim() || undefined,
  ```
- Two-line change per read site (~4 lines total)
- Doesn't touch Cosmos data
- Doesn't change iOS contract
- Doesn't change the TS type (could later add `year`/`cardName` as
  legacy aliases or document the iOS divergence)

**Scope:** ~30 min implementation + unit test + production smoke

**User-facing impact:** 13/24 holdings (iOS-real cohort) now pass clean
`cardYear` + `product` to `computeEstimate` → catalog lookup gets the
right card → pricing path can succeed (subject to CF-VARIANT-FILTER-
LOOSENING for variant filter rejections).

**Risk level:** LOW. Pure read-path fallback; no write changes; no
schema change; no data mutation.

### Option A — Forward-only validation

Block future polluted entries by validating `addHolding` requires
`cardYear` + `product`. iOS must update to send canonical names.

**Scope:** ~1-2h backend + corresponding iOS work (separate workstream).
**Risk:** breaks iOS pending its update; doesn't help existing 13 holdings.

### Option B — Backfill migration

One-time script: for each holding, copy `year` → `cardYear` and
`setName` → `product` if the canonical field is empty.

**Scope:** ~1-2h script + careful production write.
**Risk:** mutates production data; if anything goes wrong, hard to
unwind. Idempotent + dry-run-able mitigates.

### Option C — Conservative wildcard catalog lookup

When pricing receives sparse params (cardYear + product both empty),
have the backend's Cardsight catalog wildcard refuse to guess and
return null cardIdentity instead. Stops the wrong-card downstream
damage but doesn't unlock real pricing.

**Scope:** ~1-2h backend.
**Risk:** medium — affects pricing for cards that legitimately have
sparse user-supplied data; needs careful threshold tuning.

### Option D — Combined approach

E + A + (B or iOS contract fix). Maximally robust; longest scope.

### Recommendation

**Ship Option E first.** Highest immediate value, lowest risk, smallest
scope. Affects the 13 iOS-real holdings (54% of user's inventory).

After E lands and is verified:

- Open **CF-IOS-FIELD-CONTRACT-FIX** (Option A) — update iOS to send
  canonical `cardYear` / `product` / `cardTitle` so future writes are
  contract-compliant. Backend keeps the shim for backward compat.
- Open **CF-PORTFOLIO-METADATA-BACKFILL** (Option B) — one-time
  migration to canonicalize existing docs. Optional once shim is in
  place; cosmetic for type consistency.
- Defer **Option C** until E + A + B prove insufficient — the
  conservative-wildcard fix addresses a smaller cohort (truly sparse
  metadata, ~9 test fixtures) and may not be needed if those are
  cleaned up.

### Separate secondary finding — playerName contamination

9 of the 13 iOS-real holdings have variant text bleeding into
`playerName`: "MIKE TROUT WAL-MART BORDER", "PROSPECT AUTOGRAPHS LEO
DE VRIES PROSPECT AU- RAYWAVE", etc. This is a different problem from
field naming — it's an iOS card-scan path concatenating tokens into the
player field. Even with Option E fixing year + setName, these holdings
will still struggle with Cardsight catalog lookup because the player
name itself is polluted.

**New CF surface: CF-PLAYERNAME-NORMALIZATION** (separate workstream).
Could be addressed by either:
- iOS scan path: extract player name as a structured field (not free-
  text concatenation)
- Backend normalization: regex strip known variant tokens from playerName
  before catalog query

---

## 5. Recommended next workstream scope + authorization gate

**Immediate (highest leverage):**

- **CF-AUTOPRICE-FIELD-NAME-SHIM** (NEW, MEDIUM, ~30 min):
  - Backend read-path fallback: `cardYear ?? year`, `product ?? setName`
  - One unit test covering the shim
  - Deploy + sweep + Cosmos re-query to verify 13 iOS-real holdings now
    flow through pricing path successfully
  - This is the most-direct fix for "why 19/24 holdings get wrong
    cardIdentity"

**Sequenced after shim lands:**

- **CF-PLAYERNAME-NORMALIZATION** (NEW, MEDIUM, ~2-3h):
  - Address the 9 holdings with variant text in playerName
  - Likely iOS-side scan-path fix; backend regex strip as fallback
- **CF-IOS-FIELD-CONTRACT-FIX** (NEW, MEDIUM, ~2-3h):
  - Update iOS to send canonical field names
  - Backend shim becomes redundant but stays for old data
- **CF-PORTFOLIO-METADATA-BACKFILL** (NEW, LOW, ~1-2h, cosmetic):
  - One-time migration to canonicalize on-disk field names
  - Optional after iOS contract fix

**Deferred:**

- Original Options A/B/C/D from the investigation prompt — superseded
  by Option E + the three sequenced CFs above

### Authorization gate

This investigation surfaces a different problem than the originating CF
assumed. Recommend HALTing for user decision:

1. Approve CF-AUTOPRICE-FIELD-NAME-SHIM scope as the immediate fix?
2. Confirm the 3 sequenced CFs as the right follow-up structure, or
   prefer a different decomposition?
3. Should this investigation's findings be amended back to the original
   CF-POLLUTED-METADATA-HOLDINGS in the handoff, or treated as new CFs
   that supersede it?

---

## 6. Cross-references

- `cb9fe64` — CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING (sibling-rescue
  fix that didn't deliver value because of this CF's root cause)
- `4b88fb5` — deployed SHA of the sibling-rescue fix
- `d04ec27` — CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS Phase 1 (parallel
  workstream)
- [backend/src/services/portfolioiq/portfolioStore.service.ts](backend/src/services/portfolioiq/portfolioStore.service.ts)
  — addHolding (schemaless spread) + autoPriceHolding (reads wrong fields)
- [backend/src/types/portfolioiq.types.ts](backend/src/types/portfolioiq.types.ts)
  — canonical PortfolioHolding type that iOS isn't matching
