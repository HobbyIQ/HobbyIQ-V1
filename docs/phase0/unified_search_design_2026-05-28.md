# CF-UNIFIED-SEARCH-AND-CERT — Design (v1 architecture)

**Date:** 2026-05-28
**Phase:** 3 (design doc committed). Phase 1 (discovery) committed `0fbc5e2` as [`unified_search_current_state_2026-05-28.md`](./unified_search_current_state_2026-05-28.md). Phase 2 (architecture proposal) reviewed by Drew, approved with two additions (§3 attribution field; §14 legacy-holding scope discipline) and three operational notes (§15).
**Predecessor CF:** Renamed from `CF-PSA-CERT-RESOLUTION-PIPELINE` and expanded in scope per the 2026-05-28 W1 architecture session.
**Status:** Design committed. HALT before any implementation. v1 implementation is a separate W2-W3+ workstream.

---

## Preamble — locked decisions

Three decisions were made before Phase 2 architecture work began. The design below is built on these locks; future readers don't need to reconstruct them from session history.

- **D1 — Free-form search backend: Cardsight only.** CardHedge is not on the table for v1. CF-PICKER-MIGRATE-TO-CARDSIGHT (previously scoped for refresh roadmap W5-W6) is absorbed into v1's foundation work. v1 ships on the future-proof path; CHR PROS class coverage gaps in Cardsight are explicit v1 honesty rather than hidden by building on legacy.
- **D2 — OneDrive scan WIP handling: cherry-pick `CardScanResultView.swift` for verify-page UI adaptation only.** The rest of the OneDrive scan WIP (`CardScannerService.swift`, `CardScannerView.swift`, `AddCardView.swift`, parallel `CardItem.swift`) stays parked — its backing scan-image pipeline is architecturally incomplete per Phase 1 §6, and v2 will redesign scan separately.
- **D3 — v2 scan integration: DEFERRED to its own future design phase.** v1 + v1.5 ship cert + free-text input only. The verify page in v1 notes the v2 extension point ("future scan-extracted candidate input mode") so v2 doesn't require rebuilding, but v1 doesn't build for it. OCR mechanism — server-side multimodal vs client-side iOS Vision vs cert-only-scan vs hybrid — is v2's load-bearing first call, not pre-committed here.

---

## 1. Cert-grader abstraction (load-bearing — start here)

The forward-compat decision that determines whether v1.5 graders are 1-day plug-ins or 1-week rewrites. **Registry pattern with interface + recognizer + adapter.**

### Interface

```ts
// backend/src/services/certGraders/certGrader.ts (NEW)
export interface CertGrader {
  readonly id: "psa" | "bgs" | "sgc" | "cgc" | string;
  readonly displayName: string;          // "PSA", "BGS", etc — surfaced in UI

  // Cheap predicate — runs before any HTTP. Used by the search dispatcher
  // to decide cert vs free-text mode. MUST NOT throw.
  recognizes(input: string): boolean;

  // Performs the cert lookup. Returns CertLookupResult or throws a
  // CertGraderError (extends the PsaApiError pattern already in
  // psaCert.service.ts).
  lookup(certNumber: string): Promise<CertLookupResult>;

  // Maps grader-specific shape → canonical CardIdentity. Pure function.
  toCardIdentity(result: CertLookupResult): CardIdentity;
}

export interface CertLookupResult {
  rawCertNumber: string;
  certificationType: string;       // grader-specific: "PSA" | "DNA" | "BGS-BCCG" | etc.
  cardRaw: unknown;                 // vendor body — adapter normalizes via toCardIdentity
  totalPopulation: number | null;
  populationHigher: number | null;
}

export class CertGraderError extends Error {
  constructor(
    message: string,
    public readonly graderId: string,
    public readonly code: "TOKEN_MISSING" | "AUTH_FAILED" | "QUOTA_EXCEEDED"
                          | "NOT_FOUND" | "TIMEOUT" | "REQUEST_FAILED" | "UNKNOWN",
    public readonly status: number = 502,
  ) { super(message); this.name = "CertGraderError"; }
}
```

### Registry

```ts
// backend/src/services/certGraders/registry.ts (NEW)
const _registry = new Map<string, CertGrader>();
export function registerCertGrader(g: CertGrader): void {
  if (_registry.has(g.id)) throw new Error(`Cert grader id collision: ${g.id}`);
  _registry.set(g.id, g);
}
export function listCertGraders(): CertGrader[] { return [..._registry.values()]; }
export function findRecognizingGraders(input: string): CertGrader[] {
  return [..._registry.values()].filter(g => g.recognizes(input));
}
export function getCertGrader(id: string): CertGrader | undefined { return _registry.get(id); }
```

### v1's only registered grader — PSA adapter

```ts
// backend/src/services/certGraders/psa.grader.ts (NEW; thin wrapper around existing psaCert.service.ts)
import { lookupPsaCertByNumber, PsaApiError } from "../psa/psaCert.service.js";
import { tokenizeParallel } from "../compiq/cardsight.mapper.js";

export const psaCertGrader: CertGrader = {
  id: "psa",
  displayName: "PSA",
  recognizes(input) {
    // PSA cert numbers are all-digit, 7-9 chars historically. Accept 6-12 for
    // safety (modern 8; older may be shorter; future-proof a bit).
    const trimmed = input.trim();
    return /^\d{6,12}$/.test(trimmed);
  },
  async lookup(certNumber) {
    try {
      const r = await lookupPsaCertByNumber(certNumber);
      return {
        rawCertNumber: r.certNumber,
        certificationType: r.certificationType,
        cardRaw: r.card,
        totalPopulation: r.card?.totalPopulation ?? null,
        populationHigher: r.card?.populationHigher ?? null,
      };
    } catch (err) {
      const e = err as PsaApiError;
      throw new CertGraderError(e.message, "psa",
        e.code === "PSA_TOKEN_MISSING" ? "TOKEN_MISSING" :
        e.code === "PSA_AUTH_FAILED" ? "AUTH_FAILED" :
        e.code === "PSA_QUOTA_EXCEEDED" ? "QUOTA_EXCEEDED" :
        e.code === "PSA_TIMEOUT" ? "TIMEOUT" : "REQUEST_FAILED",
        e.status);
    }
  },
  toCardIdentity(result) { /* see §5 */ },
};
```

### Registration

```ts
// backend/src/services/certGraders/index.ts (NEW)
import { registerCertGrader } from "./registry.js";
import { psaCertGrader } from "./psa.grader.js";
// v1 registers only PSA. v1.5 commits each add one line:
//   import { bgsCertGrader } from "./bgs.grader.js"; registerCertGrader(bgsCertGrader);
registerCertGrader(psaCertGrader);
```

**This is the load-bearing decision.** v1.5 each grader = service file + adapter + one-line registration. Zero touches to v1's dispatcher / endpoint / canonical types / iOS code. Get it right at v1 because retrofitting later means rewriting v1.

---

## 2. Free-form path — Cardsight (per D1)

`searchCatalog(query, opts)` in [`cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts) is the v1 free-form backend. Wraps it with a canonical adapter:

```ts
function cardsightCatalogToCardIdentity(c: CardsightCatalogResult, rankingScore: number): CardIdentity {
  return {
    candidateId: `cardsight:${c.id}`,
    source: "cardsight-catalog",
    attribution: "ranked",
    confidence: rankingScore,            // 0..1 relevance from autograph/color/rookie sort
    player: c.player ?? c.name ?? null,
    year: c.year ?? null,
    brand: c.releaseName ?? null,
    setName: c.setName ?? null,
    cardNumber: c.number ?? null,
    parallel: null,                       // catalog list doesn't carry parallel; lives on /catalog/cards/{id}
    variation: null,
    isAuto: detectAutoFromBlob(c),       // existing search-list autograph detection moves here
    serialNumber: null,
    grade: null, gradeCompany: null, gradeValue: null, certNumber: null,
    totalPopulation: null, populationHigher: null,
    title: buildCatalogTitle(c),
    imageUrl: null,
    raw: c,
  };
}
```

Existing `searchCardsRouted` + `searchCatalog` already work in `exclusive` mode (the current prod CARDSIGHT_MODE). v1's free-text dispatcher calls them and adapts the response.

---

## 3. Canonical type — `CardIdentity` (with explicit attribution per Addition 1)

Single canonical type populated by every cert grader + the Cardsight catalog adapter. Mirrored in iOS Codable.

```ts
// backend/src/types/cardIdentity.ts (NEW)
export interface CardIdentity {
  candidateId: string;                  // "psa:76556858" | "cardsight:b9d2b2b1..." | "bgs:..."
  source: "psa-cert" | "cardsight-catalog" | "bgs-cert" | "sgc-cert" | "cgc-cert";

  /**
   * Names what `confidence` MEANS for this candidate. Per Drew's Addition 1
   * (Phase 2 review): the confidence field is semantically overloaded
   * (cert hits are authoritative=1.0; catalog hits are relevance-ranked
   * 0..1). Rather than leave consumers to check `source` to interpret
   * the number, attribution makes the meaning explicit on the type
   * itself.
   *
   *   "authoritative": cert grader confirmed identity. confidence === 1.0.
   *                    Consumers can rely on the identity fields as ground truth.
   *   "ranked":        catalog/free-text hit. confidence is a relevance score
   *                    in [0, 1] from rank scoring. Identity fields are best-guess.
   */
  attribution: "authoritative" | "ranked";
  confidence: number;                   // 0..1; authoritative ⇒ 1.0

  // Identity (subset populated by source)
  player: string | null;
  year: number | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  variation: string | null;
  isAuto: boolean;
  serialNumber: string | null;

  // Grade context (cert only — null for catalog candidates)
  grade: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  certNumber: string | null;
  totalPopulation: number | null;
  populationHigher: number | null;

  // Display
  title: string;
  imageUrl: string | null;

  // Vendor body for debug / future use
  raw?: unknown;
}
```

iOS mirror in `CompIQSearchModels.swift` (Codable) — same shape, Swift conventions.

### Why explicit attribution + confidence (not a discriminated union)

Considered: `attribution: "authoritative" | { kind: "ranked", score: number }`. Rejected — discriminated unions are awkward in Codable on iOS and add consumer-side switch overhead. Two flat fields, attribution naming the semantic, confidence carrying the number, is the cleanest cross-language type.

---

## 4. Backend endpoint — unified single `/api/search/cards`

**Decision: single endpoint, server-side dispatch.** Rationale: v1.5 grader = backend-only addition. Client-side dispatch would force every grader CF to ship coordinated backend+iOS commits.

```
POST /api/search/cards
  Headers: x-session-id (session-gated, same as /api/psa/cert/:n)
  Body: { input: string, hint?: "cert" | "freetext" }
  Returns: UnifiedSearchResponse
```

### Response shape

```ts
interface UnifiedSearchResponse {
  input: {
    raw: string;
    detectedMode: "cert" | "freetext";
    recognizingGraders?: string[];      // grader ids that recognized the input (cert mode)
  };
  candidates: CardIdentity[];
  // cert: 1 on success, 0 on not-found
  // freetext: 0..N ranked
  warnings: string[];                   // per-grader failures, empty-input, etc.
}
```

### Dispatcher

```ts
async function dispatchSearch(input: string, hint?: "cert" | "freetext"): Promise<UnifiedSearchResponse> {
  const trimmed = input.trim();
  if (!trimmed) return { input: { raw: input, detectedMode: "freetext" }, candidates: [], warnings: ["empty_input"] };

  // Resolve mode: explicit hint wins; otherwise grader registry decides.
  const detectedRecognizers = findRecognizingGraders(trimmed);
  const mode: "cert" | "freetext" = hint ?? (detectedRecognizers.length > 0 ? "cert" : "freetext");

  if (mode === "cert") {
    // If hint=cert but no grader recognizes, try all registered graders
    // (rare — happens when user explicitly asks for cert mode on ambiguous input).
    const graders = hint === "cert" && detectedRecognizers.length === 0
      ? listCertGraders()
      : detectedRecognizers;

    const settled = await Promise.allSettled(graders.map(g => g.lookup(trimmed)));
    const candidates: CardIdentity[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") candidates.push(graders[i].toCardIdentity(s.value));
      else warnings.push(`${graders[i].id}_cert_lookup_failed:${(s.reason as CertGraderError)?.code ?? "UNKNOWN"}`);
    }
    return {
      input: { raw: input, detectedMode: "cert", recognizingGraders: graders.map(g => g.id) },
      candidates,
      warnings,
    };
  }

  // Freetext path — Cardsight
  const catalogHits = await searchCatalog(trimmed, { take: 30 });
  // Reuse existing autograph detection + color matching + sort scoring
  // from compiq.routes.ts:763-800, moved into a shared helper so both
  // the legacy /api/compiq/search-list (kept for back-compat) and the
  // new unified endpoint use the same scoring.
  const scored = rankCatalogHits(catalogHits, trimmed);
  return {
    input: { raw: input, detectedMode: "freetext" },
    candidates: scored.map(h => cardsightCatalogToCardIdentity(h, h.rankingScore)),
    warnings: [],
  };
}
```

### Auto-detection heuristic

**Delegate to grader registry's `recognizes()` predicates.** v1's PSA grader uses `/^\d{6,12}$/`. v1.5 SGC/CGC each register their own pattern (likely alphanumeric for SGC, distinct digit pattern for CGC). If multiple graders recognize an input, dispatcher fans out to all of them — first to resolve a valid card wins; the others surface as warnings.

Explicit `hint` field allows iOS to force a mode (user-toggled "this is a cert" or "this is free-text" UI).

---

## 5. PSA variety → canonical parallel (REUSE 4effbf4)

`cardsight.mapper.ts:tokenizeParallel` already handles the wrapper-strip pattern PSA's variety needs. Verified on session-discovered examples:

- `"Limited Edition (Tiffany)"` → `["tiffany"]` ✓
- `"Refractor Blue Wave"` → `["refractor", "blue", "wave"]` ✓
- `"Tiffany"` → `["tiffany"]` ✓

For the PSA adapter's `canonicalParallelFromVariety()`:

```ts
import { tokenizeParallel } from "../compiq/cardsight.mapper.js";

function canonicalParallelFromVariety(variety: string): string | null {
  if (!variety || typeof variety !== "string") return null;
  const tokens = tokenizeParallel(variety);
  if (tokens.length === 0) return null;
  // Drop "auto" tokens (those become isAuto, not parallel). Join remaining
  // with space, title-case for downstream display.
  const parallelTokens = tokens.filter(t => !/^(auto|autograph|signed|signature)$/.test(t));
  if (parallelTokens.length === 0) return null;
  return parallelTokens.map(t => t[0].toUpperCase() + t.slice(1)).join(" ");
}
```

`detectAutoFromVariety()` checks the same tokens for the auto signal. Zero new parallel-parsing logic; reuse the pattern committed in 4effbf4.

Grade-string parsing (e.g. `"GEM MT 10"` → 10) reuses the existing `gradeParser.ts` (shipped via `8b4465c` CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION).

### `buildPsaTitle()` — verbatim variety in title, canonical in parallel field

**PSA adapter emits the verbatim variety string in `CardIdentity.title`, not the canonical parallel.** A Maddux Tiffany cert renders as:

```
1987 Topps Traded #70T Greg Maddux Limited Edition (Tiffany) — PSA 10
```

NOT:

```
1987 Topps Traded #70T Greg Maddux Tiffany — PSA 10   ← rejected
```

Locked during W2 implementation (commit referenced below). Rationale:

- VerifyView's "is this my cert?" affordance is the moment misidentification gets caught. The title mirroring PSA's slab text strengthens the trust signal — users see in the app what they read on the holder.
- `CardIdentity.parallel` separately carries the canonical token (`"Tiffany"`) for matching, pricing, comp-fetch logic. "Verbatim for display, canonical for logic" is a clean split that downstream consumers depend on already.
- ResultsView verbosity is the tradeoff. VerifyView is the higher-stakes surface; the call goes its way.

A future v1.5/v2 question — whether to add a separate `verbatimVariety` field so consumers can pick — was considered and rejected as scope creep. Powder kept dry for when VerifyView UX feedback surfaces a real need.

---

## 6. `certNumber` persistence on `PortfolioHolding`

Add two optional fields to the backend type. Additive schema; zero migration needed.

```ts
// backend/src/types/portfolioiq.types.ts — additive
export interface PortfolioHolding {
  // ...existing fields...
  certNumber?: string;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
}
```

iOS `CardItem.swift` already has `certNumber` locally — sync through existing PATCH `/api/portfolio/holdings/:id` path. No new endpoint, no migration. Legacy holdings stay null; new holdings from cert flow populate.

---

## 7. iOS screens + flow

```
[CompIQView search input]
  ↓ submit (free-text OR cert digits — single field, auto-detected)
[ResultsView (refactored from CompIQVariantPickerView)]
  - Calls CompIQSearchService.search(input)
  - Renders UnifiedSearchResponse.candidates as a list
  - Cert mode (single candidate): "Confirm this card" panel
  - Free-text mode: candidate list with title + image + year/brand badges
  ↓ tap candidate (CardIdentity)
[VerifyView (NEW, adapted from CardScanResultView)]
  - Card image, identity fields, grade/cert info if present
  - Population badge (totalPopulation / populationHigher) when cert source
  - Action: "Use This Card" → comp page
  - v1 has NO commit-to-portfolio button (extension point for v2)
  ↓ tap "Use This Card"
[CompIQPricedCardView (existing)]
  - Existing comp card page, pinned to selected candidate's cardId
```

### Cherry-pick scope from OneDrive `CardScanResultView` (per D2)

- Image + identity layout (lines 13-56 of OneDrive `CardScanResultView.swift`)
- Grade display (lines 35-42)
- Cert + verify-link block (lines 43-52) — adapt to generic `"Verify on \(gradeCompany)"` link
- **DROP**: market value live-fetch (v1 verify is identity-only); "Add to Inventory" / "Add to Watchlist" actions (those are v2)

### CompIQSearchService

Add:
```swift
func search(input: String, hint: SearchMode? = nil) async throws -> UnifiedSearchResponse
```

Existing `searchVariants(query)` becomes a thin wrapper for back-compat (legacy `/api/compiq/cardsearch` → returns adapted shape) OR gets deprecated when no legacy callers remain. Implementation chooses.

### State model

- `@State input: String` in `CompIQView`
- `@State searchResponse: UnifiedSearchResponse?` in `ResultsView`
- `@State selectedCandidate: CardIdentity?` for navigation
- `VerifyView` is stateless — `CardIdentity` passed via init; consumes it, dispatches navigation

Navigation: SwiftUI `NavigationStack` + `navigationDestination(isPresented:)` — matches existing `CompIQView.swift` pattern (verified in Phase 1 §5).

---

## 8. Verify page v1 contract

| Aspect | v1 | v2 (deferred, extension point) |
|---|---|---|
| Consumes | `CardIdentity` (passed via init) | Same |
| Surfaces | Image, identity, grade, cert + verify-link, population badge | Same + scan-extracted attribution |
| Primary action | "Use This Card" → comp page | Same OR "Add to Portfolio" → commit + back |
| Secondary action | Back to results | Same |
| State | Stateless / loading | Same |
| Commits to portfolio | NO | YES (extension point built in) |

**Extension point noted in design (not built in v1):** v2 adds an "Add to Portfolio" action that commits canonical `CardIdentity` → `PortfolioHolding`. The mapping is straightforward given the shape match (CardIdentity covers all PortfolioHolding identity fields plus cert info). v1 wires the page to take a `CardIdentity` directly so v2 doesn't require re-plumbing — only adds an action button + commit handler.

---

## 9. CF-PICKER-MIGRATE-TO-CARDSIGHT absorbed into v1 (per D1)

Per D1, the picker migration is v1 foundation work, not a separate W5-W6 workstream.

### What changes

- [`compiq.routes.ts:6`](../../backend/src/routes/compiq.routes.ts#L6) — static import of `searchCards` from cardhedge → replaced with Cardsight catalog adapter
- [`compiq.routes.ts:753`](../../backend/src/routes/compiq.routes.ts#L753) — dynamic import → same replacement
- `/api/compiq/cardsearch` — **preserve route, replace internals.** Legacy iOS clients on older builds keep working during rollout. Internal call shifts to `searchCatalog`.
- `/api/compiq/search-list` — same treatment. The autograph detection + color matching + scoring logic at [`compiq.routes.ts:763-800`](../../backend/src/routes/compiq.routes.ts#L763-L800) MUST be preserved — it's product-meaningful behavior, not vendor-specific. Refactor into a shared helper used by both legacy routes and the new unified `/api/search/cards`.
- **Shape adapter**: existing `CompIQVariantHit` iOS contract has fields tuned to CardHedge response. Cardsight returns different field names. Adapter must produce identical-looking responses to legacy clients (per-field mapping with field-name shim).

### Coverage acceptance per D1

CHR PROS class will be unfound in Cardsight (vendor gap). v1 ships with that limitation surfaced honestly via the existing `warnings` array + verify-page UI ("limited catalog coverage" hint when free-text results are empty).

### Verification (during implementation phase)

- Every existing picker-related test re-run against Cardsight path; fix CH-specific assertions
- Empirical smoke: hit `/api/compiq/cardsearch` with same iOS contract (curl POST with iOS-shaped body), confirm response shape identical to legacy
- Sweep against the same 23-holding admin cohort; confirm picker returns reasonable candidates

---

## 10. v1.5 forward-compatibility — per-grader CFs

Each new grader = three artifacts + one registration line:

```
backend/src/services/certGraders/
  bgs.grader.ts          (NEW) — implements CertGrader, calls BGS API or scrapes
  sgc.grader.ts          (NEW) — same pattern
  cgc.grader.ts          (NEW) — same pattern
backend/src/services/certGraders/index.ts
  + registerCertGrader(bgsCertGrader);
```

Zero touches to v1's dispatcher / unified endpoint / response shape / iOS code / `CardIdentity` type / schema.

### Per-grader API access — honest status

| Grader | Public API? | Plan |
|---|---|---|
| **PSA** | ✅ Public API, integrated in v1 | n/a |
| **BGS (Beckett)** | UNKNOWN — Beckett has had developer programs historically; current public API access TBD | Phase 0 investigation before v1.5 BGS CF: confirm public API exists + tokens issuable. Fallback: scraping (1-3 wk) OR defer. |
| **SGC (CCG)** | UNKNOWN — CCG runs a Cert Verification site; documented public API for partner integrations TBD | Same Phase 0 investigation pattern |
| **CGC (CCG)** | UNKNOWN — same as SGC | Same |
| **Others (HGA, Edge, etc.)** | UNKNOWN — each TBD | Per-grader Phase 0 investigation |

### Per-grader CF estimate

- **Clean public API:** 4-8h per grader (service file + adapter + recognizer pattern + tests + registration)
- **Public API requires negotiation / signup / token issuance:** add 1-3 days calendar per grader
- **Scraping path:** 1-3 weeks per grader (anti-bot risk, fragile, ongoing maintenance liability — deliberate Drew call required)
- **No access path:** grader stays unsupported

**Bias to honesty:** flag each grader's API status as TBD until verified. Don't promise timelines on what isn't yet investigated.

---

## 11. v2 forward-compatibility — extension points (deferred)

Per D3, v2 is its own future design phase. v1 builds the extension points so v2 doesn't require rebuilding:

- **VerifyView consumes a `CardIdentity` regardless of source.** v2 adds a new source kind `"scan-extracted-candidate"` to the union; existing renderer works unchanged.
- **`UnifiedSearchResponse.input.detectedMode`** is an open string union. v2 adds a `"scan"` mode value; dispatcher and rendering handle it without architectural changes.
- **VerifyView's "Add to Portfolio" action slot.** v1 leaves the action slot empty / single-action; v2 adds the commit handler that maps `CardIdentity` → `PortfolioHolding` PATCH/POST.
- **OCR mechanism is v2's first design call** — server-side multimodal (Azure / OpenAI Vision), client-side iOS Vision framework, cert-only-scan path, or hybrid. v1 takes no position.

The OneDrive scan WIP (`CardScannerService` / `CardScannerView`) remains parked; v2 may resurrect, adapt, or supersede it.

---

## 12. Answers to the 12 Phase 1 open questions

| # | Question | Answer |
|---|---|---|
| 1 | Free-form search backend for v1 | Cardsight only (D1 locked) |
| 2 | Unified endpoint vs client dispatcher | **Unified endpoint** (server-side dispatch — supports v1.5 grader-only deploys) |
| 3 | Cert auto-detection heuristic | **Delegate to grader registry's `recognizes()`.** PSA uses `/^\d{6,12}$/`. v1.5 graders register own patterns. Explicit `hint` field allows iOS override. |
| 4 | Cert-grader abstraction | **Registry + interface + adapter** (§1) |
| 5 | Unified response shape | **`UnifiedSearchResponse { input, candidates, warnings }`** with canonical `CardIdentity` (§3) |
| 6 | Verify page v1 contract | Consumes `CardIdentity`; surfaces identity + grade + pop + verify-link; single action "Use This Card" → comp page. NO commit. v2 extension point. (§8) |
| 7 | `certNumber` persistence | Add `certNumber?` + `certGrader?` to `PortfolioHolding`. Additive, zero migration. (§6) |
| 8 | Canonical `CardIdentity` type | Yes — `backend/src/types/cardIdentity.ts`, mirrored iOS Codable (§3) |
| 9 | `/api/compiq/image` status | MCP server endpoint exists; image-identification capability never built. v1 doesn't depend on it. v2 OCR mechanism is its own design call. |
| 10 | Cert population data surface | Yes — `totalPopulation` / `populationHigher` as a badge on VerifyView when cert source. |
| 11 | Sport gating placement | **Stays at pricing layer** (current behavior). Search/identity layer is sport-agnostic; non-baseball cards surface in search but hit `source: "unsupported_sport"` on comp page — cleaner UX than silent search failures. |
| 12 | Mac access for design verification | **Not blocking design.** iOS source readable from Windows; behavior verifiable on Mac during v1 implementation phase. (See §15 operational note.) |

---

## 13. Honest scope estimates for v1 implementation

### Backend
| Workstream | Estimate |
|---|---|
| Cert-grader abstraction + registry + interface | 1-1.5 days |
| PSA grader adapter (wrap existing psaCert.service.ts) | 0.5 day |
| Unified `/api/search/cards` endpoint + dispatcher | 1-1.5 days |
| `CardIdentity` type + Cardsight catalog adapter + ranking helper refactor | 0.5-1 day |
| **CF-PICKER-MIGRATE-TO-CARDSIGHT** (cardsearch + search-list internal swap, autograph/color logic preservation, shape adapter for legacy clients) | 2-3 days |
| `PortfolioHolding` schema additions (`certNumber`, `certGrader`) | 0.5 day |
| Tests (unit + integration) | 1.5-2 days |

**Backend subtotal:** 7-10 focused days

### iOS
| Workstream | Estimate |
|---|---|
| Unified search input UI + auto-detect dispatch (hint field) | 1-1.5 days |
| ResultsView refactor of CompIQVariantPickerView | 1.5-2 days |
| VerifyView (cherry-pick CardScanResultView, adapt for CardIdentity) | 2-2.5 days |
| CompIQSearchService `search()` method + Codable models for CardIdentity/UnifiedSearchResponse | 1 day |
| State model wiring + navigation | 1 day |
| Tests where feasible (limited iOS test infrastructure observed in repo) | 0.5-1 day |

**iOS subtotal:** 7-9 focused days

### Verification + ship
| Workstream | Estimate |
|---|---|
| Cardsight catalog smoke sweep (23-holding cohort) | 0.5 day |
| Picker-migration regression sweep (legacy clients) | 1 day |
| Cert flow end-to-end smoke (known PSA certs incl. Witt 76556858) | 0.5 day |
| Pre-deploy + deploy + post-deploy verification | 0.5 day |

**Verification subtotal:** 2.5 days

### Total v1

**~17-22 focused days = 3-5 weeks calendar pace** per the roadmap's "1-2 focused sessions per workstream" framing.

**Honest revision vs original CF-PSA-CERT-RESOLUTION-PIPELINE estimate:** That CF estimated 1.5-2 weeks. **CF-UNIFIED-SEARCH-AND-CERT v1 is realistically 3-5 weeks** because of (a) cert-grader abstraction (was single-grader plug-in), (b) unified search dispatcher (was direct call), (c) CF-PICKER-MIGRATE-TO-CARDSIGHT absorbed into v1 per D1 (was separate W5-W6 workstream), (d) canonical `CardIdentity` type + iOS Codable mirror, (e) VerifyView as new screen.

### v1.5 per-grader

**4-8h conditional** on clean public API. Per-grader Phase 0 API investigation gates each.

### v2 scan integration

Not estimated — separate design phase.

---

## 14. Legacy-holding scope discipline (Addition 2)

**v1 provides a clean entry path going forward. It does NOT retroactively clean the existing contaminated holdings that motivated this CF.**

The 23-holding admin cohort surfaced concrete contamination this session (Phase 1 §8):
- `playerName: "TRADED TIFFANY GREG MADDUX TIFFANY"` (set/parallel tokens contaminating playerName)
- `playerName: "MIKE TROUT WAL-MART BORDER"` (parallel token in playerName)
- `playerName: "CHROME PROSPECT AUTOGRAPHS GAGE WOOD CHR PROSPECT - REF"` (set + parallel-code tokens)
- year stored as string `"1987"` rather than number; `product` vs `setName` phantom-field disambiguation

v1's deliverable is the input contract for FUTURE card identification (cert lookup → canonical → committed metadata, or free-text search → canonical → committed metadata). Existing holdings remain on legacy paths.

### What v1 does NOT do

- Does NOT retroactively rewrite existing `PortfolioHolding` documents
- Does NOT trigger an automatic re-canonicalization sweep
- Does NOT add a UI flow for users to re-run identity verification on existing holdings (could be a v2 feature)
- Does NOT remove server-side normalization workarounds (`cardsight.mapper.ts:normalizePlayerName`, the field-name shim from CF-AUTOPRICE-FIELD-NAME-SHIM, `canonicalizePlayerName` from today's `b51b763`) — those continue to mask contamination on legacy holdings until they're cleaned up

### Cleanup paths available post-v1 (not built here)

- **Manual user correction**: a user can re-search a contaminated holding via the new unified search, get the canonical identity, and (in v2) commit the corrected canonical metadata back to PortfolioHolding. v1 doesn't expose this UI but the architectural path exists.
- **Future CF-LEGACY-HOLDING-CANONICALIZATION**: a separate workstream that iterates existing holdings, runs each through the unified search dispatcher (cert if certNumber present, free-text fallback otherwise), and proposes / applies canonical corrections. Estimated when prioritized; not in v1, v1.5, or v2 scope.

### Why this scope discipline is intentional

The session's repeated framing-vs-reality lessons (CF-PLAYERTRENDS-QUERY-FAILURE classification flip-flops; CF-PLAYERNAME-CANONICALIZATION surfacing as the real bug under three layers of misframe) reinforce: **fix the input contract, observe the new state, then decide what cleanup actually matters.** Retroactive cleanup absent observed harm is over-engineering. v1 ships the input contract; v2 and beyond decide whether retroactive cleanup is worth it based on what's actually happening with new clean writes vs. legacy data.

---

## 15. Operational notes (not blocking design commit)

### Mac access for iOS implementation phase

§7 design is verified against iOS source readable from Windows. Behavior verification (SwiftUI navigation, state model, animation, build) requires Mac access. **Phase transition note**: this design phase = Windows (read + design); v1 implementation phase = Mac for iOS pieces + Windows for backend pieces. Flag any iOS-specific design ambiguities for Mac-side check during implementation; don't block on them here.

### Picker shape-adapter empirical verification (during implementation)

§9 picker migration relies on a per-field adapter producing CardHedge-shape responses from Cardsight data. **Empirical verification required during implementation:** hit `/api/compiq/cardsearch` post-migration with the exact body shapes iOS sends; assert response shape matches CardHedge-era response field-by-field. Older iOS builds parsing migrated responses must see identical-looking data. Failing this verification breaks all clients on the older build during rollout.

### Roadmap amendment follow-up (NOT in this Phase 3 commit)

§13's 3-5 week v1 scope (vs original CF-PSA-CERT 1.5-2 week estimate) means the refreshed roadmap ([`HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md), `746a023`) needs amending to reflect actual v1 scope. v1 implementation realistically spans roughly W2-W6, displacing CF-CATALOG-GAP-PRICING-HONESTY (currently W4) and shifting Phase 3 CH decommission (currently W5-W6) since picker migration is absorbed into v1's W2-W6.

**Action:** A separate follow-up commit amends the roadmap. NOT in this Phase 3 design-doc commit (Phase 3 is design-doc-only per hard rules).

---

## 16. Decisions deferred to implementation

Not architecture-load-bearing; let implementation choose:

- Specific SwiftUI styling on VerifyView (theme colors, spacing, animation)
- Exact PSA-grade-string → numeric parsing for edge cases (`"GEM MT 10"`, `"NM-MT 8"`, BGS subgrades). Share with existing `gradeParser.ts` if reuse fits.
- Empty-results UI copy on ResultsView for free-text misses ("Limited Cardsight catalog coverage — try alternative spelling or grader cert")
- Whether to cache cert lookups via existing `cacheWrap` (probably yes, 24h TTL) — small design call at implementation time
- Telemetry event names (use existing `console.log(JSON.stringify({event, source, ...}))` convention)
- Whether `/api/compiq/cardsearch` and `/api/compiq/search-list` get hard-deprecated post-migration or stay indefinitely as legacy aliases

---

## 17. References

- [`unified_search_current_state_2026-05-28.md`](./unified_search_current_state_2026-05-28.md) — Phase 1 discovery (`0fbc5e2`)
- [`HOBBYIQ_ROADMAP_2026-05-28.md`](../HOBBYIQ_ROADMAP_2026-05-28.md) — refreshed Q3 roadmap (`746a023`); to be amended per §15
- [`ROADMAP_RECONCILIATION_2026-05-28.md`](../ROADMAP_RECONCILIATION_2026-05-28.md) — state-vs-plan accounting (`ee4e8b3`)
- `cardsight.mapper.ts:tokenizeParallel` (4effbf4) — wrapper-strip pattern reused for PSA variety parsing (§5)
- `psaCert.service.ts` — existing PSA Public API client wrapped by v1's PSA grader adapter (§1)
- `8b4465c` CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION — `gradeParser.ts` to be reused for PSA grade-string parsing
- `b51b763` CF-PLAYERNAME-CANONICALIZATION — same identity-mismatch class on the playerScore lookup; informs §14 legacy-cleanup discipline framing
- `ccd05dc` CF-VARIANT-MISMATCH-PRICESOURCE-PARITY — propagation pattern that the verify-page "we couldn't price this" copy should mirror

---

## End of Phase 3 design doc

**HALT.** No implementation. v1 implementation is a separate W2-W3+ workstream gated on this design being approved and the roadmap amendment landing per §15 operational note.

Drew reviews → if approved, v1 implementation begins on its own ticket. If amended, this doc gets updated and re-committed before implementation.
