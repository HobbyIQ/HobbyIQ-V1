# Cardsight Catalog Schema — Empirical Reference

**Investigation date:** 2026-05-27
**Method:** Direct probes against Cardsight `/catalog/search`, `/catalog/cards/{id}`, `/pricing/{cardId}` via `/api/ops/cardsight-probe` (admin diagnostic endpoint) and from operator machine using the active API key.
**Status:** Foundation document for CF-CARDSIGHT-RESOLVER-REDESIGN (planned next-session work).

Replaces the assumed schema model that drove today's earlier resolver work (CF-CARDSIGHT-RESOLVER-COMPREHENSIVE Phase 1 + Phase 3) into structural error. Those edits remain in production as inert infrastructure — harmless, ineffective.

## 1. Catalog response decomposition

Every catalog search result + detail object carries this canonical shape:

```jsonc
{
  "id":              "<uuid>",                    // Cardsight cardId
  "name":            "Greg Maddux",                // player name
  "year":            "1987",                       // card year (string in catalog)
  "number":          "70T",                        // card number (only in detail; UNDEFINED in search)
  "releaseName":     "Topps Traded",               // product line (short)
  "setName":         "Base Set",                   // subset within release
  "manufacturerName":"Topps",                      // parent brand
  "parallelName":    "Limited Edition (Tiffany)",  // parallel variant (catalog search only)
  "parallels":       [...]                         // sub-array (detail only)
}
```

### Critical facts

- **`releaseName` is short** — "Topps Traded", "Topps Chrome", "Bowman Chrome", "Fleer". NOT the long-form "1987 Topps Traded Tiffany Baseball" pattern this CF arc initially assumed.
- **`setName` is short** — "Base Set", "70 Years of Topps Baseball Series 1", "Prospect Autographs", "Chrome Prospect Autographs". NOT the long-form.
- **`parallelName` lives on the catalog SEARCH result** when the card is a parallel variant. The base card (same cardId) returns `parallelName: null`.
- **`parallels[]` lives on `/catalog/cards/{id}` detail** — sub-array of parallel variants for the base cardId.
- **`number` is missing from catalog search results** (always `undefined`) — only present on detail probes. Resolver's cardNumber filter therefore cannot work from search alone.

### Empirical evidence

10 representative probes:

| Query | releaseName | setName | parallelName |
|---|---|---|---|
| Greg Maddux 1987 Topps Traded Tiffany | Topps Traded | Base Set | "Limited Edition (Tiffany)" |
| Greg Maddux Topps Traded (no Tiffany) | Topps Traded | Base Set | `null` |
| Ken Griffey Jr 1989 Topps Traded Tiffany | Topps Traded | Base Set | "Limited Edition (Tiffany)" |
| Mike Trout Topps Chrome 2021 (R0) | Topps | "70 Years of Topps Baseball Series 1" | "70 Years of Topps Baseball Chrome Series 1" |
| Caleb Bonemer Bowman Chrome 2024 (R0) | Bowman Draft | Base Set | "Chrome" |
| John Gil Bowman Chrome 2025 (R0) | Bowman Chrome | Prospect Autographs | `null` |
| Tommy White Bowman Chrome 2025 (R0) | Bowman Draft | Chrome | "Bowman LogoFractor" |
| Mike Trout Topps Update 2011 | Topps Update | Base Set | `null` |
| Joe Carter 1986 Topps Tiffany | Topps | Base Set | "Collectors Edition (Tiffany)" |
| Chipper Jones 1996 Fleer Tiffany | Fleer | Base Set | "Tiffany" |

**Note the variation:**
- 1986 Topps Tiffany = `"Collectors Edition (Tiffany)"`
- 1987-1989 Topps Traded Tiffany = `"Limited Edition (Tiffany)"`
- 1996 Fleer Tiffany = `"Tiffany"` (no wrapper)

The wrapper-strip fix in [cardsight.mapper.ts:279-301](../backend/src/services/compiq/cardsight.mapper.ts#L279-L301) handles all three patterns.

## 2. Tiffany / set-level parallels are NOT distinct cardIds

The base Maddux 1987 Topps Traded and the Tiffany Maddux 1987 Topps Traded share **the same cardId** (`b9d2b2b1-...`). What changes is the `parallelName` field on search results and the `parallels[]` sub-array on detail.

Implication: my Phase 3 dictionary (which returned long-form `"1987 Topps Traded Tiffany Baseball"` expecting separate cardIds with distinct setNames) was structurally wrong. There is no "1987 Topps Traded Tiffany Baseball" setName in Cardsight catalog. There's only `releaseName="Topps Traded"`, `setName="Base Set"`, `parallelName="Limited Edition (Tiffany)"`.

## 3. Parallels[] sub-array (detail probe)

Each base cardId has a `parallels[]` array on `/catalog/cards/{id}` listing the available parallel variants:

**Maddux 1987 Topps Traded — 1 parallel:**
```
id=516f7c55-... name="Limited Edition (Tiffany)" numberedTo=null
```

**Trout 2021 Topps Chrome — 23 parallels:**
```
Aqua Refractor /199
Aqua Wave Refractor /199
Black & White Mini Diamond Refractor (no print run)
Blue Refractor /150
Blue Wave Refractor /75
Gold Refractor /50
Gold Wave Refractor /50
Green Refractor /99
Green Wave Refractor /99
Magenta Refractor /399
Magenta Speckle Refractor /350
Negative Black & White Refractor
Orange Refractor /25
Orange Wave Refractor /25
Pink Refractor
Printing Plates /4
Prism Refractor
Purple Refractor /299
Red Refractor /5
Red Wave Refractor /5
Refractor
Sepia Refractor
SuperFractor /1
```

**Naming conventions observed:**
- Color + "Refractor" — most common ("Blue Refractor", "Gold Refractor")
- Color + "Wave Refractor" — wave variants ("Blue Wave Refractor")
- Print-run + descriptor — sometimes literally just the parallel name
- Wrapped pattern — "(Tiffany)", "(Limited Edition)", "(Collectors Edition)" — covers Tiffany family
- Plain name — "Tiffany" (Fleer 1996), "Refractor" (Topps Chrome 2021 base refractor)

## 4. Grade taxonomy

`/pricing/{cardId}` returns:

```jsonc
{
  "card": { "card_id": "...", "name": "...", "number": "70T", "set": {...} },
  "raw": { "period_days": null, "count": 156, "records": [...] },
  "graded": [
    {
      "company_name": "PSA",
      "grades": [
        { "grade_value": "10", "records": [...] },
        { "grade_value": "9",  "records": [...] }
      ]
    },
    { "company_name": "BGS",  "grades": [...] },
    { "company_name": "SGC",  "grades": [...] },
    { "company_name": "CGC",  "grades": [...] },
    { "company_name": "BCCG", "grades": [...] }
  ],
  "meta": { "total_records": 156, "last_sale_date": "..." }
}
```

**Observed PSA bucket for Maddux 1987 Topps Traded (cardId b9d2b2b1):**

| Grade | Count |
|---|---:|
| 10 | 59 |
| 9 | 40 |
| 8 | 28 |
| 7 | 5 |
| 6 | 6 |
| 5 | 1 |

**Observed BGS grades for same card:** 7.5, 8, 8.5, 9, 9.5 — decimal grades are real and supported.

**Other companies observed in /pricing responses:** BCCG, CGC, SGC, BGS, PSA.

**iOS canonical contract therefore needs `gradeValue: Double?`** — confirmed today's iOS feature branch fix (Int? → Double? on the `ios-grade-canonical-WIP-windows` branch) is necessary.

### Raw bucket semantics

Cardsight collapses all non-graded sales into a single `raw.records[]` array. There is NO subcategorization between:
- itemSpecifics.Grade = "Ungraded"
- itemSpecifics.Grade = "Raw"
- itemSpecifics.Grade = null
- itemSpecifics.Grade = ""
- itemSpecifics.Grade = missing field entirely

All eBay listings without a recognized graded company appear in `response.raw.records` with no further attribution.

**The raw bucket is mixed across all parallel variants on the same cardId** — base Maddux + Tiffany Maddux are combined.

## 5. parallelId filter behavior — INCONSISTENT

Empirical finding: `/pricing/{cardId}?parallel_id=X` does NOT uniformly filter records.

**Trout 2021 Topps Chrome, Blue Refractor parallel_id (`75f6e56b-...`):**
- Without filter: raw=134, gradedCompanies=2
- With filter: raw=2, gradedCompanies=0
- The 2 returned raw records have titles like "2021 Topps Chrome Blue Refractor 32/150 Mike Trout #27" — actual Blue Refractor sales ✓

**Maddux 1987 Topps Traded, Limited Edition (Tiffany) parallel_id (`516f7c55-...`):**
- Without filter: raw=156, gradedCompanies=5
- With filter: raw=0, gradedCompanies=0
- Returns COMPLETELY EMPTY despite Tiffany Maddux sales clearly existing in the unified bucket (titles containing "Tiffany" surface at $1599 PSA 10 etc.)

**Hypothesis:** Cardsight's sales ingestion title-parser recognizes "Blue Refractor" → matching parallelId tag, but does NOT recognize "Tiffany" → "Limited Edition (Tiffany)" parallelId tag. The parallels[] catalog metadata exists, but the tag isn't applied to historical eBay listings.

**Implication for resolver:** never rely on parallel_id filter alone for set-level Tiffany cases. Either:
- Use the fallback shipped in `3b55b8f` (retry without parallel_id when empty)
- Title-filter post-fetch (would require pattern recognition)
- Treat the unified bucket as the comp pool (current behavior)

## 6. Search ranking semantics

Empirical observations:

- `/catalog/search` returns at most ~10-25 results; relevance-ranked.
- **R0 is NOT always the intended card.** Example: `q="Mike Trout Topps Chrome"` + `year=2021` returns "70 Years of Topps Baseball Series 1" at R0 — a different product entirely.
- **Including the parallel keyword in the query DOES affect ranking** — `q="Mike Trout Topps Chrome Refractor"` ranks Refractor variants higher (validated in prior CF-CARDSIGHT-QUERY-KEYWORD-REFACTOR investigation; not re-probed today).
- **Year as a URL parameter** narrows year-bracketed but doesn't guarantee R0 correctness.

**Implication:** the resolver's current "pricing-probe greedy max-records" approach can land the wrong cardId at low confidence. Either:
- Add ranking-aware selection (consume Cardsight's relevance score)
- Filter by cardNumber when known (requires detail probe per candidate — expensive)
- Trust pricing-probe greedy as today's best-effort

## 7. Confirmed catalog gaps

From today's session + prior investigations:

- **Wal-Mart Border / Target Red / retail-only borders:** NOT in Cardsight catalog. Tier ladder T1 fallback (CF-VARIANT-FILTER-LOOSENING) is the correct handling. CF-CARDSIGHT-PARALLEL-COVERAGE is the vendor-escalation tracker.
- **Tiffany sales attribution:** parallels[] metadata exists but eBay sale records aren't tagged. See section 5.

## 8. Design implications for resolver redesign

Recommendations for CF-CARDSIGHT-RESOLVER-REDESIGN (next session):

### Drop today's inert work
- Phase 1 release-filter `releaseName OR setName` extension ([fbbab52](https://github.com/HobbyIQ/HobbyIQ-V1/commit/fbbab52)): never narrows because no candidate matches the long-form expectedRelease. The extension is harmless but adds noise — can be reverted to the original `releaseName ===` form when the Tiffany dictionary also goes away.
- Phase 3 Tiffany dictionary (14 entries): returns long-form strings that match nothing in Cardsight. Dead code. Should be removed.

### Keep
- **Wrapper-strip in `tokenizeParallel`** ([4effbf4](https://github.com/HobbyIQ/HobbyIQ-V1/commit/4effbf4)): correctly handles "Limited Edition (Tiffany)" / "Collectors Edition (Tiffany)" → "Tiffany". Generalizes to future wrapper patterns.
- **getPricing parallel_id fallback** ([3b55b8f](https://github.com/HobbyIQ/HobbyIQ-V1/commit/3b55b8f)): handles Cardsight's inconsistent parallel_id behavior. Retry-without-filter when empty.
- **Grade canonical migration** ([8b4465c](https://github.com/HobbyIQ/HobbyIQ-V1/commit/8b4465c)): structurally correct. Drove $96 → $384 on Maddux + similar uplift across cohort.
- **iOS Double? type fix** (feature branch `57ab110`): correct for decimal BGS/CSG grades.

### Investigate
- **Search ranking:** can we consume Cardsight's relevance score to pick R0 vs greedy max-records? Verify across cohort whether greedy lands the right card more often than R0.
- **Title-pattern parallel filtering:** for set-level parallels Cardsight doesn't tag (Tiffany family), can we filter `response.raw.records` and `response.graded[].grades[].records` by `title.includes(parallel keyword)`? Risk: sellers omit "Tiffany" from titles when card is in description.
- **cardNumber-aware resolution:** when iOS provides cardNumber, detail-probe candidates to filter by number. Bounded fanout already in code.

### Architectural reframing
Today's resolver assumed Cardsight = "parallel = separate cardId with distinct setName". Actual Cardsight = "parallel = sub-record on shared cardId, sometimes tagged in sales pool". Resolver needs to model the LATER architecture.

## 9. Diagnostic infrastructure (kept in place)

`/api/ops/cardsight-probe` ([b2cd7ea](https://github.com/HobbyIQ/HobbyIQ-V1/commit/b2cd7ea)) is permanent infrastructure for future Cardsight schema debugging. Admin-gated via `x-admin-token` (OPS_REPORT_TOKEN). Returns raw catalog + pricing responses. Use it instead of code-tracing for empirical schema questions.

Sample usage:
```
GET /api/ops/cardsight-probe?query=Greg+Maddux+1987+Topps+Traded+Tiffany&year=1987
  Headers: x-admin-token: $OPS_REPORT_TOKEN
```

## 10. Cross-references

- [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) — running session log
- [cardsight.mapper.ts](../../backend/src/services/compiq/cardsight.mapper.ts) — resolver implementation
- [cardsight.translator.ts](../../backend/src/services/compiq/cardsight.translator.ts) — response → comps mapping
- [cardsight.client.ts](../../backend/src/services/compiq/cardsight.client.ts) — HTTP layer + cacheWrap + parallel_id fallback
- CF-CARDSIGHT-PARALLEL-COVERAGE (vendor escalation tracker)
- CF-CARDSIGHT-QUERY-KEYWORD-REFACTOR (prior investigation, gated on resolver redesign)
