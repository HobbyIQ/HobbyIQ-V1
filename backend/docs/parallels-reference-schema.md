# Parallels Reference Catalog — Schema Design (Phase 1b)

**Issue:** #33 — Parallels Reference Project  
**Phase:** 1b (design only — no Cosmos infrastructure, no ingestion code, no data)  
**Status:** DRAFT for owner cold-review  
**Predecessor:** Phase 1a feasibility report (CH API investigation; see [tmp/parallels-explore/](../../tmp/parallels-explore/))  
**Successor:** Phase 2 (ingestion plan + initial catalog data) — separate prompt

---

## 0. Owner-locked corrections from Phase 1a

These four corrections supersede the agent's initial Phase 1a schema observations. They are the design baseline:

1. **Key includes year.** Use the full `set` string (e.g., `"2024 Bowman Chrome Baseball"`), not the year-agnostic `set_type` ("Bowman Chrome Baseball"). Print runs vary by year within the same set family.
2. **Field is `parallelName`, not `colorNormalized`.** Many parallels are not colors (`Mini-Diamond`, `Lava`, `International`, `Refractor`, `Aqua Raywave`). Color is an optional subfield, only populated when applicable.
3. **Autograph parallels are separate rows.** No tri-state flag. `isAutograph` is a boolean per row. Blue Refractor /150 and Blue Refractor Auto /150 are two distinct documents because they have different CH `number` prefixes, different print runs (usually), and different markets.
4. **Hierarchy modeled from the start.** Every row has `parentVariant` and `tierWithinSet`. CH provides no hierarchy; we own it.

---

## 1. Document model — three options evaluated

### Option A — Single collection

One document per `(set, parallelName, isAutograph)` triple, holding both curated attributes and the list of CH `card_id`s that match.

| Pro | Con |
|---|---|
| One read serves all parallel data for a card | `card_id → record` lookup is a CONTAINS-on-array query (cross-partition or full scan) |
| Simple to seed from YAML | Updating any single `card_id` requires read-modify-write of the parent doc (concurrency risk) |
| | Document size grows unbounded as CH adds more numbers (BCP-1 through BCP-150 all parallels per row) |

### Option B — Two collections **(RECOMMENDED)**

- **`parallel_attributes`** — owner-curated. One doc per `(set, parallelName, isAutograph)`. Holds `printRun`, `color`, `parentVariant`, `tierWithinSet`, `isAutograph`, `sourceCitation`. Small, slow-changing (~hundreds of docs per major set).
- **`ch_card_index`** — CH-derived. One doc per CH `card_id`. Holds `setRaw`, `numberRaw`, `variantRaw`, `player`, `rookie`, and the foreign key `attributeKey = "${set}|${parallelName}|${isAutograph?'auto':'base'}"`. Fast, append-only (~tens of thousands of docs at full scale).

| Pro | Con |
|---|---|
| Each collection has one clear write owner (humans vs ingestion job) | Two reads to fully resolve a card (mitigated: `ch_card_index` can denormalize `printRun` + `tier` on write) |
| Update a print run once → applies to all card_ids in that parallel | Schema migration must keep both sides in sync |
| `parallel_attributes` is small enough to fully load in memory or in Redis | |
| Natural partition keys differ (see §3) | |

### Option C — Three collections (adds `products`)

Adds a `products` collection keyed by `set`: release date, manufacturer, total parallels declared, source citations for set-level facts, scarcity-ordering policy.

| Pro | Con |
|---|---|
| Set-level metadata has a home (release date, manufacturer notes) | None of the queries in §1.1 actually need set-level metadata yet |
| Future: drives "how many parallels in this set?" UI | Premature — Phase 2 doesn't need it |

### 1.1 Query patterns to satisfy

| # | Query | How Option B answers it |
|---|---|---|
| Q1 | Given `card_id`, return parallel + print run + tier | `ch_card_index.get(card_id)` → returns `attributeKey` + denormalized `printRun`/`tier` (single read) |
| Q2 | Given `(set, parallelName, isAutograph)`, return curated attributes | `parallel_attributes.get(attributeKey)` (single point-read) |
| Q3 | Given `set`, enumerate all known parallels in scarcity order | `parallel_attributes` query: `WHERE set = @set ORDER BY tierWithinSet` (single-partition) |
| Q4 | Given `(set, parallelName)`, list all `card_id`s | `ch_card_index` query: `WHERE attributeKey = @key` (cross-partition if partitioned by something else — see §3) |

### 1.2 Decision

**Adopt Option B.** Justification:
- Q1, Q2, Q3 are point-reads or single-partition queries — fast and cheap
- Q4 is acceptable cross-partition because it's an admin/audit query, not a hot path
- Separates curator workflow (Git-tracked YAML → `parallel_attributes`) from ingestion (CH timer job → `ch_card_index`) cleanly
- Defer Option C until set-level UI demands it

---

## 2. Field-level specification

All field names use **camelCase**. All collections are read-heavy reference data. Timestamps are ISO-8601 strings.

### 2.1 `parallel_attributes`

| Field | Type | Required | Validation | Source | Example |
|---|---|---|---|---|---|
| `id` | string | yes | composite — see §4 | computed | `"2024 Bowman Chrome Baseball|Blue Refractor|base"` |
| `set` | string | yes | non-empty; matches a CH `set` value exactly (year-prefixed) | CH-aligned (curator transcribes from CH) | `"2024 Bowman Chrome Baseball"` |
| `parallelName` | string | yes | non-empty; title-case normalized form | curator | `"Blue Refractor"`, `"Mini-Diamond"`, `"Lava"`, `"Base"` |
| `color` | string \| null | optional | null when parallel has no color identity (`Refractor`, `Mini-Diamond`, `Lava`, `International`, `Base`) | curator | `"Blue"`, `"Red"`, `"Gold"`, `null` |
| `printRun` | number \| null | yes (nullable) | positive integer when present; null means unnumbered / unlimited (e.g., base Refractor) | curator | `150`, `5`, `null` |
| `isAutograph` | boolean | yes | strict boolean | curator | `false`, `true` |
| `parentVariant` | string \| null | yes (nullable) | when non-null, must equal another `parallelName` in the same `set`; null for the set's base | curator | `"Refractor"`, `null` |
| `tierWithinSet` | number | yes | positive integer; 1 = base, higher = rarer; ties allowed for siblings (see §6) | curator | `1`, `2`, `5` |
| `variantAliases` | string[] | optional | list of CH `variant` raw strings that map here | CH-derived during curation | `["Blue", "Blue Refractor"]` |
| `numberPrefixes` | string[] | optional | autograph rows only — which CH `number` prefixes identify this auto parallel | curator (from `AUTO_NUMBER_PREFIXES`) | `["CPA", "BCPA"]` |
| `sourceCitation` | object | yes | see §7 | curator | `{ type: "owner-knowledge", ... }` |
| `lastReviewedAt` | string | yes | ISO-8601 | curator | `"2026-05-16T00:00:00Z"` |
| `reviewedBy` | string | yes | identifier | curator | `"owner"`, `"web-research-2026-05-16"` |
| `schemaVersion` | number | yes | integer ≥ 1 | computed | `1` |

#### Why `variantAliases` is an array

CH's `variant` text is inconsistent — for the same parallel we see both `"Blue"` and `"Blue Refractor"` across different set rows. The curator records every observed CH spelling here so the resolver in §5 can map raw CH variant text → canonical `parallelName`.

### 2.2 `ch_card_index`

| Field | Type | Required | Validation | Source | Example |
|---|---|---|---|---|---|
| `id` | string | yes | equals `cardId` | computed | `"1727053909682x831982867305504800"` |
| `cardId` | string | yes | CH card_id (unique) | CH | `"1727053909682x831982867305504800"` |
| `set` | string | yes | non-empty | CH `set` field | `"2024 Bowman Chrome Baseball"` |
| `setType` | string | yes | non-empty | CH `set_type` (search rows only) | `"Bowman Chrome Baseball"` |
| `number` | string | yes | as returned by CH | CH `number` | `"31"`, `"CPA-PS"`, `"BCP-125"` |
| `variantRaw` | string | yes | CH `variant` verbatim | CH `variant` | `"Blue"`, `"Refractor"`, `"Aqua Raywave"` |
| `player` | string | yes | CH `player` | CH | `"Paul Skenes"` |
| `rookie` | boolean | optional | from CH search-row `rookie` | CH (search rows) | `false` |
| `attributeKey` | string \| null | yes (nullable) | foreign key into `parallel_attributes.id`; null = unresolved | computed by resolver (§5) | `"2024 Bowman Chrome Baseball|Blue Refractor|base"` |
| `attributeResolution` | string | yes | enum: `"matched"`, `"unmatched-variant"`, `"unmatched-auto-prefix"`, `"manual-override"` | computed | `"matched"` |
| `printRun` | number \| null | optional | denormalized from `parallel_attributes` for fast Q1 reads | denormalized | `150` |
| `tierWithinSet` | number \| null | optional | denormalized from `parallel_attributes` | denormalized | `3` |
| `isAutograph` | boolean \| null | optional | denormalized | denormalized | `false` |
| `lastSeenAt` | string | yes | ISO-8601, updated each ingestion run | ingestion | `"2026-05-16T02:30:00Z"` |
| `schemaVersion` | number | yes | integer ≥ 1 | computed | `1` |

#### Denormalization policy

The three denormalized fields (`printRun`, `tierWithinSet`, `isAutograph`) are written by ingestion at index-build time. When `parallel_attributes` changes, a rebuild job re-walks `ch_card_index` and refreshes them. **Reads never join across collections at runtime** — Q1 is a single point-read.

---

## 3. Partition key recommendation (not committed)

### 3.1 `parallel_attributes` — recommend `/set`

- **Cardinality:** ~hundreds of distinct `set` values at full scale. Each partition holds tens to low-hundreds of parallel docs.
- **Hot partition risk:** Low — curator writes are sparse; reads spread across whatever set the user's card belongs to.
- **Query alignment:** Q3 (enumerate parallels in a set) becomes single-partition. Q2 is a point-read regardless.
- **Alternative considered:** `/setType` — rejected because it collapses years and would make Q3 return cross-year noise.

### 3.2 `ch_card_index` — recommend `/set`

- **Cardinality:** matches `parallel_attributes`. Each partition holds the card_ids that belong to that set (~hundreds to low-thousands per major set).
- **Hot partition risk:** Low for reads (per-card lookups distribute by set). Moderate for ingestion writes during a single-set backfill — acceptable because backfill is rare.
- **Query alignment:** Q1 (point-read by `cardId`) requires the partition key, so the resolver must store `set` alongside `cardId`. Q4 becomes single-partition when filtered by `set`.
- **Alternative considered:** `/cardId` — rejected; would make Q4 cross-partition for every set enumeration.

### 3.3 Caveat

These are recommendations for Phase 2 to validate. Real-world write patterns (especially how often re-indexing happens after attribute edits) may justify revisiting. **Phase 2 must benchmark before committing.**

---

## 4. Identifier strategy

### `parallel_attributes.id`

Composite, deterministic, human-readable:

```
${set}|${parallelName}|${isAutograph ? "auto" : "base"}
```

Examples:
```
2024 Bowman Chrome Baseball|Base|base
2024 Bowman Chrome Baseball|Refractor|base
2024 Bowman Chrome Baseball|Blue Refractor|base
2024 Bowman Chrome Baseball|Blue Refractor|auto
2024 Bowman Chrome Baseball|Refractor|auto
```

Rationale:
- Deterministic → idempotent seeding from YAML
- Human-readable → debuggable in the Cosmos data explorer
- Includes year via `set` → satisfies owner correction #1
- Includes `isAutograph` as a discriminator → satisfies owner correction #3 (auto/base separation)

### `ch_card_index.id`

Equal to the CH `cardId`. CH IDs are already globally unique opaque strings (e.g., `1727053909682x831982867305504800`).

### Reserved characters

The pipe `|` is used as the delimiter. Curator MUST NOT introduce `|` into any `set` or `parallelName` value. Lint check: reject seed YAML containing `|` in those fields.

---

## 5. Number-to-parallel resolution algorithm

This is the core integration point — how does a CH card row (with raw `set`, `number`, `variantRaw`) land on a `parallel_attributes` document?

### 5.1 Algorithm

```
resolve(chCard) → attributeKey | null

1. set := chCard.set                                  // already canonical (CH owns it)
2. isAuto := detectAutograph(chCard.number, chCard.variantRaw, chCard.description)
3. canonicalParallel := normalizeVariant(chCard.variantRaw, set, isAuto)
4. if canonicalParallel == null:
      return ResolutionResult(null, "unmatched-variant")
5. key := `${set}|${canonicalParallel}|${isAuto ? "auto" : "base"}`
6. if parallelAttributes.exists(key):
      return ResolutionResult(key, "matched")
7. return ResolutionResult(null, isAuto ? "unmatched-auto-prefix" : "unmatched-variant")
```

### 5.2 `detectAutograph` — reuse existing constant

Source the autograph prefix list from the existing production constant `AUTO_NUMBER_PREFIXES` in [backend/src/services/compiq/cardhedge.client.ts](../src/services/compiq/cardhedge.client.ts) (lines 279–297):

```
CPA, BCP-A, BCPA, BPA, PA, CRA, RA, BCRA, BSA, BCA,
TCA, USA, AU, BBA, BSPA, FA, ROA
```

Plus existing fallback: any of the words `auto`, `autograph`, `signed`, `signature` in `variantRaw` or `description`. This is the same detection already used by `findCompsByQuery` so behavior stays consistent.

**Design rule:** `parallel_attributes` is the source of truth for *which* auto parallels exist; `AUTO_NUMBER_PREFIXES` is the bridge from CH's number text to the boolean.

### 5.3 `normalizeVariant` — alias lookup

Lookup table built from `parallel_attributes.variantAliases` (and `parallelName` itself as an implicit alias) for the given `set`. Case-insensitive, whitespace-collapsed. Returns the canonical `parallelName`.

If `variantRaw == ""` and `number` has no auto prefix → canonical = `"Base"`. (CH frequently omits `variant` for base cards.)

### 5.4 Edge cases (documented for Phase 2 to handle)

| Edge case | Behavior |
|---|---|
| Unknown variant text | `ch_card_index` row stored with `attributeKey = null`, `attributeResolution = "unmatched-variant"`. Admin tool surfaces these for curator triage. |
| Multiple `parallel_attributes` match same key | Cannot happen by construction (composite ID is unique). Defensive check: log error and refuse to overwrite. |
| Number prefix not in `AUTO_NUMBER_PREFIXES` but card is actually an auto | Manual override via `parallel_attributes.numberPrefixes` (add the prefix), then re-resolve. Resolver consults this set per-attribute as a secondary check. |
| `variant = "Base - Catching"` (subset/variation) | Curator decision: either model `"Base - Catching"` as its own `parallelName` with `parentVariant = "Base"`, OR alias it into `"Base"`. Recommend the first — variations have different markets. |
| CH renames a set (e.g., adds "Baseball" suffix to existing rows) | Resolver fails on existing `cardId` records pointing to old `set` string. Phase 2 must implement a `setRenames` migration table. |
| Same `cardId` returned in two different `set` values (shouldn't happen) | Trust the most recent ingestion run; flag for review. |
| `variant = ""` AND `number` has auto prefix | canonical = `"Base"`, `isAutograph = true`. Key = `"${set}|Base|auto"`. |
| CH match endpoint returns wrong-set card (Phase 1a Skenes Gold bug) | Out of scope for resolver — that's a `card-match` reliability issue. Catalog only ingests via `card-search` pagination, which doesn't have this bug. |

### 5.5 Why this lives in the catalog and not in CH

CH owns identity (`cardId` ↔ raw fields). The catalog owns the semantic interpretation of identity (this raw row is the Blue Refractor /150). The resolver is the only place these two worlds meet.

---

## 6. Hierarchy modeling

### 6.1 `parentVariant` representation

**String reference, not document ID.** Stores the `parallelName` of the parent (e.g., `"Refractor"`), scoped implicitly to the same `set` and `isAutograph` value.

| Pro | Con |
|---|---|
| Human-readable in raw docs | String-typed FK (not Cosmos-enforced) |
| Survives `parallel_attributes.id` format changes | Must be validated at write time |
| Same parallel name in a different year resolves correctly because `set` is implicit | Renaming a parallel requires updating all children |

**Rejected: full document `id` reference** — couples hierarchy to the `id` format. If we later change the delimiter or add a tenant prefix, every `parentVariant` breaks.

**Rejected: denormalize both** — pure overhead; the `id` is reconstructible from `(set, parentVariant, isAutograph)`.

### 6.2 Example chain — Skenes 2024 Bowman Chrome base #31 (illustrative; actual print runs TBD by Phase 2 curation)

| parallelName | parentVariant | tierWithinSet | printRun | isAutograph | color |
|---|---|---|---|---|---|
| Base | null | 1 | null | false | null |
| Refractor | Base | 2 | null | false | null |
| Aqua Raywave | Refractor | 3 | 199 | false | "Aqua" |
| Blue Refractor | Refractor | 4 | 150 | false | "Blue" |
| Purple Refractor | Refractor | 5 | 250 | false | "Purple" |
| Pink Refractor | Refractor | 6 | 50 | false | "Pink" |
| Gold Refractor | Refractor | 7 | 50 | false | "Gold" |
| Mini-Diamond | Refractor | 8 | 10 | false | null |
| Red Refractor | Refractor | 9 | 5 | false | "Red" |
| Superfractor | Refractor | 10 | 1 | false | null |

Notes on the example:
- All non-base parallels here descend from `"Refractor"` — that's typical for Bowman Chrome. Other sets may chain differently (e.g., Topps Chrome has Refractor → X-Fractor → Atomic).
- `tierWithinSet` is **strictly increasing along the rarity axis**, but **siblings under the same parent may share a tier** when the curator wants to express "these are peers." Print runs do not need to be monotonic with tier; tier expresses rarity *category*, not exact rank.
- Auto chain is a parallel tree — `"Base|auto"`, `"Refractor|auto"`, `"Blue Refractor|auto"`, etc. — with its own tiers.

### 6.3 How `tierWithinSet` is assigned

**Owner-curated, not auto-derived from `printRun`.** Reasons:
1. Print run is `null` for unnumbered parallels (base Refractor) — auto-derivation fails
2. Some parallels are rarer than their print run suggests (case-hit ratios, on-card autographs, etc.)
3. Hobby consensus on rarity ordering doesn't always match the print number (1/1 Superfractor outranks a /5 Red Refractor by tradition even though both are extremely scarce)
4. Auto-derivation would require a deterministic tiebreaker that the curator might disagree with

**Recommendation:** Phase 2 provides a curator helper that *suggests* a tier from print run, but the curator commits the final value.

---

## 7. Versioning and source tracking

### 7.1 `sourceCitation` shape

Polymorphic object discriminated by `type`:

```ts
type SourceCitation =
  | { type: "owner-knowledge"; date: string; note?: string }
  | { type: "ch-derived"; cardIdsSampled: string[]; date: string }
  | { type: "web-research"; url: string; siteName: string; date: string; note?: string }
  | { type: "manufacturer-spec"; document: string; date: string; note?: string }
  | { type: "manual-override"; note: string; date: string };
```

Required on every `parallel_attributes` document. The discriminator drives downstream audit queries ("which parallels still rely on owner-knowledge and need a citation?").

### 7.2 Review fields

- `lastReviewedAt` — bumped on every owner edit
- `reviewedBy` — identifier string; `"owner"` for human edits, `"web-research-batch-<id>"` for automated/researched batches

### 7.3 Schema versioning

- `schemaVersion: 1` on every document at launch
- Migrations bump the version and run as separate Phase 2+ jobs
- Document any field rename / type change in this file under a "Schema changelog" section appended at the bottom (none yet)

### 7.4 Catalog versioning over time

Two layers:
1. **Document-level:** each `parallel_attributes` row carries `lastReviewedAt` + `sourceCitation`. Edits replace the row; no history stored in-band.
2. **Repo-level:** the seed YAML files (Phase 2 decision — see §8) live in Git. Git history is the audit log for "when did we change the print run on Blue Refractor /150?"

History in Cosmos itself is **out of scope** for v1. If demanded later, add a `parallel_attributes_history` collection mirroring writes.

---

## 8. Open questions for Phase 2

These are explicitly deferred to the Phase 2 prompt. **Phase 1b takes no position on them.**

### 8.1 Initial catalog scope

**Recommendation (not commitment):** seed five major products at launch:
1. 2024 Bowman Chrome Baseball
2. 2024 Bowman Chrome Prospects Baseball (Skenes BCP-125 etc.)
3. 2024 Topps Chrome Baseball
4. 2024 Topps Update Baseball
5. 2024 Bowman Draft Chrome Baseball

These cover the cards most likely to drive prediction calls in the next 6 months. Other products are added on demand.

### 8.2 Data source priority

**Recommendation:**
1. CH `card-search` pagination → populates `ch_card_index` entirely (`set`, `setType`, `number`, `variantRaw`, `player`, `rookie`)
2. Owner knowledge → bootstraps `parallel_attributes` for the five seed products
3. Beckett / Cardboard Connection / sportscardradar / manufacturer print-run sheets → fills gaps where owner knowledge is uncertain
4. Cross-parallel `prices` snapshots from CH → backstop for "what does this parallel typically sell for vs base" if a baseline multiplier field is added later (not in v1 schema)

### 8.3 Curation workflow

Two candidates — Phase 2 picks one:

**Candidate 1: YAML-in-Git → Cosmos sync job**
- `backend/data/parallels/seed/<set-slug>.yaml` files
- PR review for every change
- Sync job applies on merge to main
- Pro: full Git history, code review, no admin UI to build
- Con: requires a sync job and a CI step

**Candidate 2: Admin Cosmos write tool**
- CLI or minimal web UI writes directly to `parallel_attributes`
- Pro: no sync infrastructure
- Con: no review workflow, no audit beyond `sourceCitation`

Recommend Candidate 1 unless Phase 2 surfaces a real-time editing requirement.

### 8.4 Resolution backfill cadence

When `parallel_attributes` changes, how soon does `ch_card_index` reflect denormalized updates?
- Sync on attribute write (write-through)
- Nightly batch
- On-demand admin button

Phase 2 decision.

### 8.5 Cross-parallel baseline multipliers

Phase 1a noted CH `prices[]` can be used to compute cross-parallel ratios (Blue Refractor /150 typically sells at 2.4× base Refractor). Should the schema carry a `baselineMultiplier` field, or is that a derived signal that lives outside the reference catalog?

**Recommendation:** keep it OUT of the v1 schema. The catalog stores *identity facts*; multipliers are *derived pricing signals* and belong in the existing pricing layer.

### 8.6 Should Phase 1a need revisiting?

**No.** All four owner corrections are accommodated. The only Phase 1a uncertainty that propagates here is "CH `card-match` reliability for parallels" — and §5.4 explicitly routes around it by ingesting via `card-search` pagination only. No reinvestigation needed before Phase 2.

---

## Schema changelog

| Version | Date | Change |
|---|---|---|
| 1 | 2026-05-16 | Initial schema design (Phase 1b). |
