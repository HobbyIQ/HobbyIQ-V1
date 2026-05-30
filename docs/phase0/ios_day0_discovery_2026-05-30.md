# iOS Day 0 Discovery Report — 2026-05-30

## 1. Repo Location + Git State

**Repo:** `/Users/drew/Desktop/HobbyIQ`
**Remote:** `origin` → `https://github.com/HobbyIQ/HobbyIQ-V1.git`
**Branch:** `main` (clean, up to date with origin/main)
**HEAD:** `ac473c8` — Merge branch 'ios-grade-canonical-WIP-windows'
**Untracked:** `docs/phase0/ios_grade_canonical_validation_2026-05-29.md` (validation artifact from yesterday), xcuserdata

**Recent iOS-relevant commits on main:**
- `ac473c8` Merge ios-grade-canonical-WIP-windows (2026-05-29)
- `7f758cd` Phase 5 portfolio movement integration (2026-05-27)
- `01d2cd4` PR E completion — dismiss UI + entry forms (2026-05-27)

**Remote branches:** 28 remote branches, mostly archived backend feature branches. No active iOS feature branches.

**Docs present:** `docs/SESSION_HANDOFF.md` (400KB, comprehensive), `docs/HOBBYIQ_ROADMAP_2026-05-28.md`, `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md`, `docs/phase0/` (50+ investigation docs).

---

## 2. Backend-iOS Alignment Gaps

### GAP A — price-by-id endpoint will 400 (BROKEN AT RUNTIME)

**Severity: P0 — active user-facing breakage**

The `/api/compiq/price-by-id` endpoint dropped `cardHedgeCardId` acceptance. Backend now requires `cardsightCardId` as the JSON key. iOS sends `"cardHedgeCardId"` on the wire.

**Full call chain:**
1. `CompIQPricedCardView.swift:1104` → calls `CompIQSearchService.shared.priceByCardId(hit.cardHedgeCardId, ...)`
2. `CompIQSearchService.swift:42` → calls `APIService.shared.priceByCardId(cardHedgeCardId: id, ...)`
3. `APIService.swift:106-113` → constructs `CompIQPriceByIdRequest(cardHedgeCardId: ..., ...)` → POSTs to `/api/compiq/price-by-id`
4. `CompIQSearchModels.swift:118-123` — `CompIQPriceByIdRequest` has no custom CodingKeys, so property `cardHedgeCardId` encodes as JSON key `"cardHedgeCardId"` on the wire
5. Backend rejects with 400 — expects `"cardsightCardId"`

**Category: ACTIVE RUNTIME** — this is the CompIQ pricing drill-down from variant picker. Every user who taps "View Pricing" on a card variant hits this.

**Fix scope:** Rename `cardHedgeCardId` → `cardsightCardId` across the request model, service layer, and call sites. The response model (`CompIQPriceByIdResponse`) also has a `cardHedgeCardId` field that should be renamed.

**Affected files (6):**
| File | Line(s) | Type |
|---|---|---|
| `CompIQSearchModels.swift:119` | Request struct property | ACTIVE RUNTIME |
| `CompIQSearchModels.swift:285,353,411` | Response struct property + CodingKey | ACTIVE RUNTIME |
| `APIService.swift:106,108` | Method signature + body construction | ACTIVE RUNTIME |
| `CompIQSearchService.swift:42-43` | Service wrapper parameter name | ACTIVE RUNTIME |
| `CompIQPricedCardView.swift:1105` | Call site accessing `hit.cardHedgeCardId` | ACTIVE RUNTIME |
| `CompIQPricedCardView.swift:1266` | Preview fixture | TEST FIXTURE |

### GAP B — CompIQVariantHit uses cardHedgeCardId naming

**Severity: P1 — functional but misnamed**

`CompIQVariantHit` struct in `CompIQSearchModels.swift:15` has property `cardHedgeCardId` with CodingKey `"card_id"`. The backend `/api/compiq/cardsearch` endpoint returns `card_id` — this is the Cardsight card ID now, not a CardHedge ID. The property name is semantically wrong but functionally correct (CodingKey maps correctly).

**Affected lines:**
- `CompIQSearchModels.swift:15,25,31,37,51,59,69,81` — struct definition, Identifiable conformance, init, CodingKey

**Category: ACTIVE RUNTIME (functional)** — works correctly due to CodingKey mapping, but the internal name is misleading.

### GAP C — cardsightCardId / cardsightGradeId not on iOS

**Severity: P2 — not yet wired**

Backend PortfolioHolding now supports `cardsightCardId` (R1) and `cardsightGradeId` (R2) as additive fields. Zero hits for either in iOS codebase. These are additive — no breakage, but iOS can't populate them yet (meaning backend autoPriceHolding can't use the fast-path direct card lookup for iOS-created holdings).

### GAP D — /api/portfolio/identify endpoint not consumed

**Severity: P3 — new capability, no iOS consumer**

The new `POST /api/portfolio/identify` (image-based card identification) exists on backend but iOS has no code to call it. Zero hits for `/identify` in iOS. This is purely additive — new feature, not a regression.

### GAP E — gradeValue Int? vs Double? inconsistency in CompIQ path

**Severity: P1 — decimal grades silently truncated**

Yesterday's grade canonical merge fixed the portfolio/InventoryCard path to use `Double?` for `gradeValue`. But the CompIQ pricing path still uses `Int?` in 5 locations:
- `CompIQSearchModels.swift:122` — `CompIQPriceByIdRequest.gradeValue: Int?`
- `APIService.swift:106` — `priceByCardId(...gradeValue: Int?)`
- `CompIQSearchService.swift:39` — `priceByCardId(...gradeValue: Int?)`
- `CompIQPricedCardView.swift:46` — `gradeValue: Int?` computed property

BGS 9.5 / CSG 8.5 grades sent through this path get truncated to 9 / 8, which hits the wrong comp bucket on backend.

### GAP F — SearchIQOrchestrator does NOT exist

Prior session memory referenced "SearchIQOrchestrator.swift lines 193, 576 with CardHedge calls." **This file does not exist in the iOS codebase.** Zero grep hits. The prior reference was a stale assumption — likely from the backend side or from an earlier architecture that was refactored away.

---

## 3. Known / Surfaced Bugs

**Source:** copilot-instructions.md "KNOWN BUGS" section + SESSION_HANDOFF.md line 3473 + 4186-4209.

| # | Bug | Status | Evidence |
|---|---|---|---|
| 1 | Refresh wipes inventory | Likely fixed | SESSION_HANDOFF says `preserveExistingSummaryOnError` guard in place |
| 2 | Card tap does not navigate | **FIXED** | Commit `ecd25b9` moved conflicting `.sheet` modifier. SESSION_HANDOFF 4206 confirms |
| 3 | Images do not auto-populate | Cannot reproduce | SESSION_HANDOFF 4192: "no auto-image logic exists on iOS." The copilot-instructions describe desired behavior that was never implemented |
| 4 | Photo removal broken | Open | SESSION_HANDOFF 4193: "delete logic exists but likely UX/timing issue." Never fixed per 4258 corrective note |

**Additional bugs surfaced from this discovery:**
- **Bug 5 (NEW):** GAP A above — price-by-id calls will 400 due to CardHedge→Cardsight field rename on backend. This is a live regression from the backend decommissioning arc.

---

## 4. Other Queued iOS Work

**From SESSION_HANDOFF Day 2 queue (updated through 2026-05-27):**

| CF | Priority | Status | Estimate |
|---|---|---|---|
| CF-IOS-FIELD-CONTRACT-FIX | MEDIUM | Open | ~30-60 min |
| CF-INVENTORY-REFRESH-WIRING | MEDIUM | Open | ~1-2h |
| CF-PR-E-CSV-PENDING-MARKER | MEDIUM | Open | ~1h |
| CF-PR-E-P&L-COMPLETE-GROUPINGS | MEDIUM | Open | ~1h |
| CF-INVENTORYCARD-RECONSTRUCTION-REFACTOR | MEDIUM | Open | ~2-3h |
| CF-PR-E-TEST-COVERAGE | MEDIUM | Partial | Blocked by CF-TEST-SIGNING-CONFIG |
| CF-TEST-SIGNING-CONFIG | LOW | Open | Unknown |
| CF-IOS-ANALYTICS-FRAMEWORK | LOW | Open | Unknown |

**SubscriptionService TODOs:**
- Line 61: "Replace with StoreKit 2 product loading + purchase handling"
- Line 67: "Replace with AppStore.sync + transaction verification"

**No in-flight iOS branches** — all feature branches are either merged or archived backend branches.

---

## 5. Proposed iOS Day Scope

### Recommended: CF-CARDHEDGE-DECOM-IOS — CardHedge naming cleanup (P0 + P1)

**What:** Rename all `cardHedgeCardId` references to `cardsightCardId` across the CompIQ pricing chain. Fix `gradeValue: Int?` → `Double?` in the CompIQ path to match yesterday's portfolio path fix.

**Why first:**
- GAP A is a **live runtime breakage** — every CompIQ "View Pricing" tap returns 400 since the backend decom shipped
- GAP E is a **silent data corruption** — BGS 9.5 grades get truncated to 9 in the pricing path
- Both are bounded, testable, and directly caused by the backend changes Drew shipped yesterday

**Scope:**
- ~6 files, mostly mechanical renames
- CompIQSearchModels.swift (request + response structs)
- APIService.swift (method signature)
- CompIQSearchService.swift (service wrapper)
- CompIQPricedCardView.swift (call site + preview)
- Plus Int? → Double? alignment in the same files

**Estimate:** ~1-2 hours including build verification and tests.

**What it does NOT include (deliberately):**
- GAP C (cardsightCardId on InventoryCard write paths) — additive, not broken
- GAP D (/identify endpoint) — new feature, not a regression
- Bug 3/4 — pre-existing, not caused by backend changes
- Other CF queue items — independent workstreams

### Alternative: broader cleanup session

If Drew wants to go wider, the natural bundle would be:
1. CF-CARDHEDGE-DECOM-IOS (P0, ~1-2h) — fixes the live breakage
2. CF-IOS-FIELD-CONTRACT-FIX (MEDIUM, ~30-60min) — closes shim debt
3. CF-INVENTORY-REFRESH-WIRING (MEDIUM, ~1-2h) — backend endpoint exists, needs iOS consumer

But I recommend starting with #1 alone, verifying it works, then deciding on #2/#3 scope.
