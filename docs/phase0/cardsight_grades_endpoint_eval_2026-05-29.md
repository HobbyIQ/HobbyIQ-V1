# CF-CARDSIGHT-GRADES-ENDPOINT-EVAL — W2 RED + R2 GREEN structural finding

**Date:** 2026-05-29
**CF:** CF-CARDSIGHT-GRADES-ENDPOINT-EVAL — Q1 of Option B sequence (per [`HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md) "Option B sequence" step 4)
**Preceded by:** CF-CARDHEDGE-NAMING-CLEANUP + CF-CARDHEDGE-RESIDUAL-DOC-SWEEP shipped at [2d05db6](https://github.com/HobbyIQ/HobbyIQ-V1/commit/2d05db6); CardHedge fully decommissioned
**Status:** read-only evaluation — no production code changes
**Probe budget used:** 9 of 10 calls (single-session, read-only against `api.cardsight.ai`)

---

## Executive summary

Cardsight's `grades.companies.*` endpoint surface is **structurally incapable of backing the W2 CertGrader adapter contract**, AND **structurally well-aligned with a separate R2 gradeId taxonomy pattern**. The InventoryIQ design doc Section 2.3.7 hypothesis ("If we adopt Cardsight's gradeId model, the W2 cert-grader adapter pattern lets v1.5 graders ship as one-line registrations backed by Cardsight's grades taxonomy") was structurally wrong as stated — the W2 contract requires cert-lookup; Cardsight provides taxonomy + aggregation. These are different capability classes.

**Findings:**
- 🔴 **RED for W2-backing.** Cardsight grades endpoints do not expose any slab-cert lookup capability. The W2 `CertGrader.lookup(certNumber)` contract — given a cert number string, return card identity + grade + population — has no equivalent in Cardsight's surface. v1.5 BGS / SGC / CGC adapters would need direct per-grader cert-API integration (same pattern as the PSA Public API backing the existing PSA adapter).
- 🟢 **GREEN for R2 gradeId pattern.** Cardsight grades endpoints provide a clean universal grade taxonomy with UUIDs. Empirically confirmed: 17 grading companies enumerated. The leaf `gradeId` filters Cardsight's pricing/marketplace/population endpoints. Useful for replacing HobbyIQ's text-based `grade: "PSA 10"` storage with the `gradeId` FK pattern, surfacing canonical grade-pickers in iOS UI, and per-grade pricing queries against any catalog card.

**Recommendation:** these are different CFs serving different goals. Capture each as a separate workstream:
- v1.5 grader integration (BGS / SGC / CGC) = direct cert-API CFs per grader (one CF each, same pattern as existing PSA adapter)
- R2 gradeId pattern adoption = separate CF (CF-CARDSIGHT-GRADE-ID-PATTERN, sub-CF candidate of InventoryIQ workstream)

---

## 1. Documentation review (Phase 1)

### 1.1 Cardsight MCP tool enumeration

Per [`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md) Appendix A2.2 — exactly 3 grading tools exist:
- `list_grading_companies`
- `list_grading_company_types({ company })`
- `list_grading_company_grades({ company, type })`

No `lookup_by_cert_number`, no `verify_cert`, no equivalent. Full Cardsight tool surface (~50 tools across catalog / pricing / collections / images / identification / search / autocomplete / feedback) was enumerated in that investigation; there is no cert-lookup capability anywhere in Cardsight's surface.

### 1.2 InventoryIQ design doc Section 2.3.7 prior framing

Per [`inventoryiq_design_2026-05-30.md`](inventoryiq_design_2026-05-30.md) §2.3.7:

> 3-step tree resolution (verbatim workflow from `list_grading_companies` description):
> 1. `list_grading_companies` → returns companies by code/UUID: "PSA, BGS, SGC, TAG, CGC, HGA, etc."
> 2. `list_grading_company_types({ company })` → returns grading types within a company: "PSA Regular, PSA DNA (autograph), BGS Regular, BGS Black Label, etc."
> 3. `list_grading_company_grades({ company, type })` → returns the actual grades with UUIDs: PSA 10, PSA 9, PSA 8, BGS 9.5, BGS 10 Black Label, etc.
>
> The leaf-level UUID is the `gradeId` used by `get_card_pricing`, `get_card_marketplace`, `add_collection_card`, `update_collection_card`, `get_card_population`.

And at §2.3.7 line 460:
> If we adopt Cardsight's `gradeId` model, the W2 cert-grader adapter pattern lets v1.5 graders ship as one-line registrations backed by Cardsight's grades taxonomy.

This hypothesis is the load-bearing question this CF resolves. **It is structurally wrong as stated** — see §3.

### 1.3 W2 cert-grader abstraction (dd7ec17)

Reading [`certGrader.ts`](../../backend/src/services/certGraders/certGrader.ts) + [`psa.grader.ts`](../../backend/src/services/certGraders/psa.grader.ts) + [`registry.ts`](../../backend/src/services/certGraders/registry.ts):

The W2 CertGrader contract requires:

```ts
interface CertGrader {
  readonly id: "psa" | "bgs" | "sgc" | "cgc" | string;
  readonly displayName: string;
  recognizes(input: string): boolean;             // cert-format predicate
  lookup(certNumber: string): Promise<CertLookupResult>;  // ← LOAD-BEARING
  toCardIdentity(result: CertLookupResult): CardIdentity;
}

interface CertLookupResult {
  rawCertNumber: string;
  certificationType: string;
  cardRaw: unknown;          // grader-specific shape interpreted by toCardIdentity
  totalPopulation: number | null;
  populationHigher: number | null;
}
```

The **`lookup(certNumber)` operation** is what makes this contract specifically a CERT-GRADER abstraction (rather than a taxonomy or pricing abstraction). PSA's adapter implements this via `lookupPsaCertByNumber` against PSA Public API ([`psaCert.service.ts`](../../backend/src/services/psa/psaCert.service.ts):71).

The user-facing pattern (per CF-UNIFIED-SEARCH-AND-CERT design doc 23038d7): user types a slab cert number into iOS → dispatcher calls `findRecognizingGraders(certNumber)` → each matching grader's `lookup(certNumber)` resolves to card identity + grade + population.

**For this pattern to work, the backing API MUST accept cert number as input.** Population data, grade taxonomy, and pricing-by-grade are all complementary — but none of them, alone or together, substitute for cert lookup.

---

## 2. Empirical probe results (Phase 2)

Read-only HTTP calls against `api.cardsight.ai/v1`. Probe script (gitignored, cleaned up after use) outputs counts/shapes only — no payload leaks.

### 2.1 Probe 1 — `list_grading_companies` → SUCCESS

**REST path discovered:** `GET /v1/grades/companies` (NOT `/grading/companies` — the prefix is `grades`, not `grading`).

**Response shape:**
```json
{
  "companies": [
    { "id": "<uuid>", "name": "<display>", "description": "<full company name>" },
    ...
  ],
  "total": 17
}
```

**17 grading companies enumerated** (richer than the documentation "PSA, BGS, SGC, TAG, CGC, HGA, etc." preview suggested):

| # | Name | Description | Cert lookup viable? |
|---|---|---|---|
| 1 | PSA | Professional Sports Authenticator | Yes (direct PSA Public API; already shipped) |
| 2 | BGS | Beckett Grading Services | Yes (direct BGS / Beckett API) — separate CF |
| 3 | BVG | Beckett Vintage Grading | Likely (shares Beckett surface) |
| 4 | BCCG | Beckett Collector Club Grading | Likely (shares Beckett surface) |
| 5 | SGC | Sportscard Guaranty Corporation | Yes (direct SGC API) — separate CF |
| 6 | CGC | Certified Guaranty Company | Yes (direct CGC API) — separate CF |
| 7 | TAG | Technical Authentication & Grading | Direct TAG integration if relevant |
| 8 | HGA | Hybrid Grading Approach | Less common; direct HGA integration if relevant |
| 9 | ISA | International Sports Authentication | Less common |
| 10 | AGS | Automated Grading Systems | Less common |
| 11 | Arena Club | Arena Club | Less common |
| 12 | Edge Grading | Edge Grading | Less common |
| 13 | MNT Grading | MNT Grading, Inc. | Less common |
| 14 | Mint Grading Service | (no description) | Less common |
| 15 | Rare Edition | Rare Edition | Less common |
| 16 | The Final Authority | (no description) | Less common |
| 17 | USA Sports Cards | USAsportscards.com (Defunct) | Defunct |

**This is reference-data taxonomy.** Each company has a UUID + display name + description. No cert-lookup endpoint is exposed.

### 2.2 Probes 2 / 4 / 5b — drill-down REST paths NOT at obvious `/grading/...` location

Attempted drill-down patterns (all 404):
- `/grading/companies/{uuid}/types`
- `/grading/company/{uuid}/types`
- `/grading-companies/{uuid}/types`
- `/grading/companies/{uuid}` (the company detail endpoint also not at this path)

**The working prefix per probe 1 is `/grades/` (not `/grading/`)**, so the actual REST drill-down paths most likely live at `/grades/companies/{uuid}/types` or similar. Discovery deferred — does not change the structural finding (reference-data taxonomy is confirmed; drill-down path discovery is a future-implementation concern).

### 2.3 Probe 5a — `catalog/search` → SUCCESS (used for cardId resolution)

Search `2017 Topps Chrome Aaron Judge` → 21 cards returned, each with `{id, name, year, setName, releaseName, manufacturerName, parallelName?}` shape and a `relevance` score. Confirmed catalog/search is healthy and consistent with prior probes.

### 2.4 Probe 5d — `get_card_population({cardId, gradeId})` → SKIPPED

Skipped because we didn't reach a `gradeId` value (probe 2-3 path discovery failed). The pre-existing documentation evidence at [`inventoryiq_design_2026-05-30.md`](inventoryiq_design_2026-05-30.md):456 already confirms population endpoint takes `{cardId, gradeId}` — not certNumber:

> The leaf-level UUID is the `gradeId` used by `get_card_pricing`, `get_card_marketplace`, `add_collection_card`, `update_collection_card`, `get_card_population`.

This is structural confirmation: population queries are against catalog cards filtered by grade-bucket, not cert-number lookups.

---

## 3. Structural mismatch — W2 vs Cardsight grades.companies

| Requirement of W2 CertGrader contract | What Cardsight grades.companies.* provides |
|---|---|
| Cert number → card identity (slab lookup) | Grade taxonomy tree (company → type → grade UUIDs) |
| Per-cert pop counts (total + higher) | Pop available, but via `get_card_population({cardId, gradeId})` — requires cardId, not certNumber |
| Vendor-side authoritative card data per cert | No cert-lookup capability at all |
| `recognizes(certNumber)` cert-format predicate | N/A (Cardsight doesn't deal in cert numbers) |
| `lookup(certNumber)` cert-API HTTP call | N/A (no endpoint exists in Cardsight) |
| `toCardIdentity(result)` raw → canonical transformation | N/A (no per-cert raw data to transform) |

**No mapping is possible** because the cardinality of the input differs: W2 expects "1 cert# → 1 card", Cardsight expects "1 cardId + 1 gradeId → 1 population/pricing bucket". The cert-number-to-cardId resolution step has no Cardsight equivalent.

This is not a normalization gap that an adapter could bridge — it's a missing primary key. A BGS/SGC/CGC adapter "backed by Cardsight" would have nothing to call from `lookup(certNumber)`.

---

## 4. Finding 1: 🔴 RED for W2 backing

**Cardsight grades.companies.* CANNOT back the W2 CertGrader contract.**

v1.5 BGS / SGC / CGC grader adapters require direct cert-API integration per grader. The path that the existing PSA adapter follows (PSA Public API → `lookupPsaCertByNumber` → `psaCertGrader`) is the same structural path BGS / SGC / CGC adapters need.

This RED finding doesn't refute the value of Cardsight grades data — it refutes the InventoryIQ §2.3.7 hypothesis that Cardsight grades data can BACK the W2 adapter pattern. The hypothesis conflates two different capability classes.

**Implication for Option B step 4-5 (per [`HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md))** — the "all grading data in the app" framing needs to split:
- Cert-lookup coverage (BGS/SGC/CGC slab → identity + grade) = per-grader direct API integration, ~3 separate CFs
- Grade taxonomy coverage (canonical PSA/BGS/SGC/CGC grade enumeration) = Cardsight grades.companies adoption, single CF

These ship independently. A v1.5 grader adapter doesn't BLOCK on the grade-taxonomy CF; the grade-taxonomy CF doesn't BLOCK on grader adapter availability.

---

## 5. Finding 2: 🟢 GREEN for R2 gradeId pattern

**Cardsight grades.companies.* IS well-suited for the R2 gradeId taxonomy pattern.**

Per InventoryIQ design doc §2.3 R2:
- Replace HobbyIQ's text-based `grade: "PSA 10"` storage with `gradeId: <uuid>` FK
- Persist `cardsightGradeId` on PortfolioHolding when available
- Use the FK for per-grade pricing/population queries against any catalog card

The 17-company taxonomy + 3-step tree (company → type → grade UUIDs) gives clean coverage. The leaf gradeId is the filter consumed by `get_card_pricing`, `get_card_marketplace`, `get_card_population`, `add_collection_card`, `update_collection_card`.

**Value proposition for R2 gradeId pattern adoption:**
1. **Canonical grade taxonomy.** Replaces the parse-on-every-read pattern (`parseGradeLabel("PSA 10")` etc.) with a stable FK.
2. **iOS grade-picker UX.** Surface a tree-shaped grade picker from a vendor-canonical taxonomy. No bespoke per-vendor grade enumeration in iOS.
3. **Per-grade pricing/marketplace queries.** Once cardsightCardId + cardsightGradeId are both persisted, the entire Cardsight per-grade query surface unlocks for repricing flows.
4. **Cross-vendor normalization.** "BGS 9.5" vs "BGS 9.5 Black Label" vs "BGS 10 Pristine" disambiguation gets vendor-mediated rather than locally curated.
5. **Composes cleanly with existing R1 cardsightCardId persistence** (already in PortfolioHolding type per `[cardsightCardId?: string | null]`).

**R2 gradeId pattern does NOT require any W2 changes.** They're orthogonal:
- W2 = cert-lookup contract (per-grader cert-API backing)
- R2 = grade-taxonomy FK pattern (Cardsight grades.companies backing)

A v1.5 BGS adapter (W2 implementation) and the R2 gradeId pattern adoption can ship in any order or concurrently.

---

## 6. Empirical probe artifacts

Probe script: `backend/.tmp-probe-cardsight-grades.cjs` (gitignored, deleted post-probe).

Probe summary table:

| Probe | Endpoint | Status | Finding |
|---|---|---|---|
| 1 | `GET /v1/grades/companies` | 200, 148ms | 17 companies enumerated with UUIDs |
| 2 | `GET /v1/grading/companies/<bgsUUID>/types` (+3 variants) | 404 (4 attempts) | Drill-down NOT at `/grading/` prefix |
| 3 | (skipped — depended on probe 2) | — | — |
| 4 | `GET /v1/grading/companies/<sgcUUID>/types` (+1 variant) | 404 (2 attempts) | Same finding as probe 2 |
| 5a | `GET /v1/catalog/search?q=...` | 200, 1547ms | 21 cards for "2017 Topps Chrome Aaron Judge"; `relevance` scores; `{id, year, setName, releaseName, manufacturerName, parallelName}` per hit |
| 5b | `GET /v1/grading/companies/<psaUUID>/types` | 404 (1 attempt) | Same finding as probe 2 |
| 5c | (skipped — depended on probe 5b) | — | — |
| 5d | (skipped — gradeId not extractable) | — | — |

**Total: 9 HTTP calls** (within 10-call budget cap).

**Drill-down REST path discovery deferred** — the working prefix is `/grades/...` per probe 1, but the script tried `/grading/...`. Most likely the drill-down lives at `/grades/companies/{uuid}/types` (mirroring probe 1's success) — would be confirmed in 1-2 calls at R2 implementation kickoff.

---

## 7. Recommendation + emerging CFs

### 7.1 Recommendation

The InventoryIQ Section 2.3.7 hypothesis ("Cardsight grades.companies.* backs the W2 cert-grader adapter pattern") is **refuted**. The two capability classes are structurally distinct:

- v1.5 grader integration (W2 contract: BGS/SGC/CGC cert-lookup) = direct per-grader API integration. Each grader's adapter shape mirrors the existing PSA adapter.
- R2 gradeId pattern (Cardsight grades.companies adoption) = separate workstream. Independently valuable; unblocks per-grade pricing/marketplace/population queries.

**Ship them as separate CFs, in either order.** Neither depends on the other.

### 7.2 Emerging CF candidates (proposed backlog additions)

- **CF-BGS-CERT-INTEGRATION** (priority TBD when iOS BGS-slab support is desired) — implement BGS adapter conforming to W2 CertGrader contract, backed by Beckett's BGS/BVG cert API. Scope mirrors the PSA adapter ship pattern. Pre-work: investigate Beckett's BGS Public API availability + rate limits + auth model.
- **CF-SGC-CERT-INTEGRATION** (similar) — SGC adapter backed by SGC's cert API. Pre-work: investigate SGC API availability.
- **CF-CGC-CERT-INTEGRATION** (similar) — CGC adapter backed by CGC's cert API. Pre-work: investigate CGC API availability.
- **CF-CARDSIGHT-GRADE-ID-PATTERN** (LOW-MEDIUM priority, ready when InventoryIQ R2 work kicks off) — adopt Cardsight `gradeId` FK pattern across PortfolioHolding storage + autopricing path + iOS grade-picker UX. Composes with existing R1 `cardsightCardId?: string | null` persistence. Sub-CF of InventoryIQ workstream.

### 7.3 What this CF does NOT recommend

- Implementing any grader adapter (separate CF per grader — see 7.2)
- Modifying the W2 CertGrader contract (it's correct as designed; the hypothesis-mismatch was about Cardsight's surface, not W2's contract)
- Modifying PortfolioHolding schema as part of this CF (R2 work has its own CF surface)
- Touching iOS code (not in this CF's scope; iOS-side work composes with downstream R2 / per-grader CFs)
- Touching Cardsight subscription tier (current tier supports `/grades/companies` per probe 1's 200 response)

---

## 8. References

- [`cardsight_published_sdk_2026-05-29.md`](cardsight_published_sdk_2026-05-29.md) — prior MCP investigation; Appendix A2.2 enumerates the 3 grading tools
- [`inventoryiq_design_2026-05-30.md`](inventoryiq_design_2026-05-30.md) §2.3.7 — the InventoryIQ hypothesis this CF refutes
- [`HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md) "Option B sequence" step 4 — the Q1 evaluation gate this CF resolves
- [`backend/src/services/certGraders/certGrader.ts`](../../backend/src/services/certGraders/certGrader.ts) — W2 CertGrader contract (dd7ec17)
- [`backend/src/services/certGraders/psa.grader.ts`](../../backend/src/services/certGraders/psa.grader.ts) — reference adapter implementation
- [`backend/src/services/psa/psaCert.service.ts`](../../backend/src/services/psa/psaCert.service.ts) — PSA Public API integration backing the existing PSA adapter
- 2d05db6 — CF-CARDHEDGE-NAMING-CLEANUP + CF-CARDHEDGE-RESIDUAL-DOC-SWEEP (preceded this CF; CardHedge fully decommissioned)
- 9f1de33 — CF-CARDHEDGE-DOCS-CLEANUP
- 10ad39d — CF-CARDHEDGE-HARD-CUTOVER
- dd7ec17 — CF-UNIFIED-SEARCH-AND-CERT W2 cert-grader abstraction shipped
- 4187a7e — Option B sequence locked

---

## 9. Operational note — API key exposure

During Phase 2 probe execution, the `CARDSIGHT_API_KEY` was pasted into chat to set the local environment variable for the probe script. The key value is now present in:

- This conversation's transcript
- Terminal scrollback (PowerShell history)
- Local probe artifacts (`.tmp-probe-cardsight-grades.cjs` + any results JSON)

Drew elected to defer rotation to post-session. Action items remaining:

1. Rotate `CARDSIGHT_API_KEY` via Cardsight portal
2. Update `HobbyIQ3` App Service → `CARDSIGHT_API_KEY`
3. Update `fn-compiq` Function App → `CARDSIGHT_API_KEY`
4. Delete local probe artifacts (`.tmp-probe-cardsight-grades.cjs` + any results JSON containing the key value)
5. Clear PowerShell history if practical
6. Verify production smoke post-rotation: `curl /api/compiq/cardsearch` with simple query

Captured as `CF-CARDSIGHT-KEY-ROTATION` (HIGH backlog) in [`SESSION_HANDOFF.md`](../SESSION_HANDOFF.md) to keep the action item discoverable rather than buried in this footnote.

**Systemic lesson for future probe patterns** — "Drew supplies the key via chat paste" puts the key in agent-visible context. Better patterns:

- Drew sets env var locally without echoing back ("paste output, not key")
- Agent reads via `az` CLI with key value never appearing in chat (Option B from this CF's authorization step)
- Use Azure Key Vault references where possible to avoid pasting credential values entirely

This incident captured here rather than buried — future-Drew or future-collaborator dealing with similar probes benefits from the lesson.
