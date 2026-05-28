# Roadmap Reconciliation — 2026-05-28

**Purpose:** Honest reconstruction of state vs. the committed roadmap as of end-of-day 2026-05-28. This is **not** a refreshed plan. It is the input artifact for a roadmap refresh that should be done in a separate, fresh session.

**Scope:** What shipped, what didn't, what got pulled in off-plan, what infrastructure debt accumulated, and the central strategic fork that the refresh will need to decide. No recommendations on direction.

---

## Section 1 — Original plan reference

The canonical roadmap is [`docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md`](HOBBYIQ_ROADMAP_2026Q2_Q3.md), drafted 2026-05-21 (commit `2301f36`), with a partial-rebaseline addendum appended 2026-05-27.

### Original phasing

| Phase | Scope | Original window |
|---|---|---|
| 0 — Measure | Production state characterization; observability restore | Week 1 (May 22-28) — shipped ahead of schedule on 2026-05-21 |
| 1 — Silent regression | Close the router's `primary_mode_cardhedge_namespace_only` short-circuit (cardsight.router.ts L629/L710) that returns `[]` for cardhedge-namespace IDs; observability restore via PR-A1/A1.1 | May 22 - Jun 4 (Track A complete via `ea0a724` + `e333ae1`; Track B pending) |
| 2 — Router bypasses | Replace direct CH client calls in compiq.routes.ts (`/search-list`, `/price-by-id`); folded into Phase 1 Track B in the original | Folded |
| 3 — CH decommission | Delete cardhedge.client, remove env vars, disable fn-cardhedge-comps, scrub docs | After Phase 1 (post Day-10 review) |
| 4a — MCP cache layer | Cache reader by player-slug, miss-on-stale fallback, cache-invalidation triggers, p95 latency >50% reduction vs Day-10 baseline | Weeks 5-6 (Jun 19 - Jul 2) |
| 4b — Signal integration | All 7 signal sources wired into live pricing path, A/B vs signal-off | Week 7 (Jul 3-9) |
| 4c — ML training pipeline | comp_logs → training dataset, feature engineering, first AutoML model, go/no-go gate | Weeks 8-9 (Jul 10-23) |
| 4d — ML serving production | Model serving infra, A/B at prediction layer, outcome tracking expansion, rollback safety nets, ≥25% traffic | Weeks 10-13 (Jul 24 - Aug 20) |
| 4e — ML moat realized | Trained model serves ≥75% of production traffic; outcome feedback loop closed; competitive analysis | Weeks 14-16 (Aug 21 - Sep 17) |
| 5 — Pricing × Portfolio | Movement signals on dashboard, aggregate valuation tracking, cross-card sell-recommendations, sales-data feedback loop | Weeks 7-12 (parallel with 4b-4d) |
| 6 — PR E reconciliation UX | iOS ledger granular fees, needsReconciliation surfaces, gradingCost/suppliesCost forms, tax export | Weeks 6-8 (Mac-side parallel) |

### Original moat definition (lines 199-209 of the roadmap)

> "Trained model serves 75%+ of production traffic. GPT-4o reasoning layer remains as fallback only. Outcome feedback loop demonstrably improves model quality over time (v3 measurably better than v1). Documented competitive analysis: how HobbyIQ's predictions compare to publicly available alternatives. Proprietary outcome dataset documented as strategic asset."

The moat as committed = **a trained ML model serving 75%+ of production traffic, with the proprietary outcome dataset (HobbyIQ's predictions paired with real sales) as the defensible asset.**

### Mid-flight rebaseline (2026-05-27 addendum, lines 370-475)

The 2026-05-27 addendum compressed targets based on framing-inversion gains (Phase 1: COMPLETE; Phase 2: COMPLETE; Phase 3: PARTIAL → 1-2 sessions; Phase 4a: PARTIAL → 1 session; Phase 4b: foundation built; targets pulled in 1-3 weeks). The reconstruction in Section 3 below contradicts several of those "COMPLETE" claims when measured against the **original** Phase 1 scope (router-level silent regression at L629/L710), not the alternate Phase 1 reframing used in the addendum (compsLoader grade-flow).

---

## Section 2 — What actually shipped (May 27-28)

28 commits landed on `origin/main` across the two-day window. Classified by relationship to the committed plan:

### Phase 6 — PR E reconciliation UX (ON-PLAN, ahead of original Weeks 6-8 window)

| SHA | Scope |
|---|---|
| `150d14b` | CF-PR-E-BACKEND-ENDPOINTS — PATCH /api/portfolio/ledger/:id + dismissedAt/dismissedReason schema fields |
| `108a41f` | Handoff entry — Mac-side unblocked |
| `01d2cd4` | PR E iOS completion — Phase 2 dismiss UI + Phase 3 gradingCost/suppliesCost entry forms |
| `34dda5f` | Handoff — PR E complete |
| `0fe88ef` | CF-PR-E-P&L-COST-RECOMPUTE — surfaced bug that gradingCost/suppliesCost were stored but never deducted from netProceeds; shared computeLedgerFinancials helper deducts both at all three persistence sites |
| `881c6c6` | Handoff — PR E truly end-to-end |
| `6897a16` | End-of-session handoff |

**Status vs. plan:** Phase 6 shipped within its original Weeks 6-8 window. PR E went end-to-end (iOS UI + backend persistence + P&L correctness). One genuinely new bug surfaced and was fixed (P&L cost recompute).

### Phase 5 — Pricing × Portfolio integration (AHEAD of original Weeks 7-12 window)

| SHA | Scope |
|---|---|
| `d531939` | CF-NEXT-SALE-PREDICTION-LAYER — design phase |
| `8bd2487` | CF-NEXT-SALE-PREDICTION-LAYER — operationalize TrendIQ as forward-looking predictedPrice via algorithmic forward projection (`forwardProjectionFactor = clamp(0.80, 1.30, 1 + (trendIQ.composite - 1) × 0.6)`) |
| `48d0b62` | Handoff with sweep evidence (23-holding cohort, 0 out-of-bounds, distribution captured) |
| `f48f778` | CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — response shape parity across /search, /price, /price-by-id, /bulk + backfill script |
| `c48e51e` | Same CF — repriceHoldingsForUser inlined-persistence site also persists prediction fields (surfaced the duplicate-persistence-site hazard) |
| `36759ce` | Handoff — Phase 5 unblocked |
| `12de7c1` | CF-AUTOPRICE-PERSIST-TRENDIQ — persist 5 TrendIQ movement fields (movementDirection, movementComposite, movementImpliedPct, movementCoverage, movementUpdatedAt) at both persistence sites atomically |
| `a723a10` | Handoff — Phase 5 foundation complete |
| `7f758cd` | iOS Phase 5 portfolio movement integration — 12 files, 951 insertions: 11 new InventoryCard fields, movement pulse card, TrendIQ-driven top movers, per-card movement chips (▲ green / ▼ red, desaturated >48h, hidden >7d), PortfolioMovementDetailView, PortfolioCompIQBridgeView, notification routing |
| `530c753` | Handoff — Phase 5 shipped |

**Status vs. plan:** Phase 5 shipped 1-5 weeks ahead of the original Weeks 7-12 window. The substantive product surface (movement signals, top movers, drill-down to CompIQ, push routing, settings toggle) is live. **But the mechanism that drives Phase 5 is NOT what the roadmap assumed.** The roadmap's Phase 5 expected pricing predictions from a Phase 4 trained model (or, transitionally, signal-blended GPT-4o predictions). What actually ships is **algorithmic forward projection from TrendIQ composite** — a deterministic formula, not a learned model. This is a meaningful divergence captured in Section 4.

### Off-plan: Cardsight resolver / schema / grade arc

This arc was not in the committed roadmap. It surfaced because production graded-card holdings were mispriced (Maddux Tiffany at $96 PSA 10 mixed, then $384 PSA 10 mixed-via-raw, then $1640 PSA 10 Tiffany-direct after grade-wiring bridge). The work classified as **emergency response to data-quality issues that were blocking honest pricing on the user's actual portfolio**, not roadmap-tracked.

| SHA | Scope |
|---|---|
| `486775b` | CF-CARDSIGHT-RESOLVER-TIFFANY — first dictionary attempt (later reverted) |
| `f67f9d2` | Revert of `486775b` after deeper structural issues surfaced |
| `07c39a2` | Surfaced as CF-CARDSIGHT-RESOLVER-COMPREHENSIVE for broader rework |
| `b2cd7ea` | `/api/ops/cardsight-probe` — admin-only Cardsight upstream health probe (permanent diagnostic infra) |
| `8b4465c` | CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION — grade-label parser + Cosmos backfill (PSA descriptor vernacular: GEM MT 10 / NM-MT 8 / MINT 9 → canonical gradeCompany + gradeValue) |
| `4effbf4` | tokenizeParallel strips parenthesized wrappers — Tiffany resolution ("Limited Edition (Tiffany)" → `["tiffany"]`) |
| `3b55b8f` | getPricing fallback when parallel_id filter returns empty (Cardsight inconsistency: works for Blue Refractor, returns 0 for Tiffany) |
| `fbbab52` | CF-CARDSIGHT-RESOLVER-COMPREHENSIVE Phase 1+3 (shipped INERT, removed later — based on wrong empirical model) |
| `6ef37b5` | Empirical schema reference at `docs/phase0/cardsight_schema_truth.md` |
| `a5a92dc` | Arc closeout handoff |
| `a9a65c2` | CF-CARDSIGHT-RESOLVER-REDESIGN — Phase 1 design (Rev 2) |
| `a0609e1` | Phase 2 Commit A — inert work removal |
| `96cbc30` | Phase 2 Commit B — title-match with specificity guard (`parallelTitleMatch.ts` — sibling-aware exclusion, word-boundary regex, 7-value internal priceSource enum collapsed to 3 user-facing categories) |
| `8e61f51` | CF-CARDSIGHT-TRANSLATER-GRADE-WIRING — bridge grade fields from queryContext into translator (closes the response-side gap of grade-aware pricing) |
| `d26c261` | Diagnostic scripts retained (`flush-cs-pricing.cjs`, `graded-holdings-sweep.cjs`) |
| `078d01a` | Handoff for Phase 2 + grade-wiring |
| `ddf7caa` | Working-tree state note |

**Production impact (12 graded holdings, post-`8e61f51` sweep):**
- Maddux Tiffany ×2 PSA 10: $384 → **$1640** (+327%; matches direct probe of cardId b9d2b2b1 graded[PSA][10] bucket, median $1445)
- Griffey 1989 UD ×2 PSA 9: $183.60 → **$498.10** (+171%; 39 direct PSA 9 RC sales, median $475 — bug was systematically under-pricing by ~$315/holding)
- Trout WMB ×2 PSA 9: $697 → $382.50 (catalog-gap perturbation; neither value is "correct")
- John Gil PSA 9: $27.20 → $88 (sibling-pool 2-comp approximation, "variant unverified")
- Trout 2021 Topps Chrome PSA 10: $44 → $48 (graded path narrowed multiplier-anchored to 3 direct PSA 10 comps)
- 5 holdings unchanged (catalog-gap or no-recent-comps)

**PSA Public API surface discovered:** [`backend/src/services/psa/psaCert.service.ts`](../backend/src/services/psa/psaCert.service.ts) + route `GET /api/psa/cert/:certNumber` exist (Bearer auth via `PSA_API_BEARER_TOKEN`). Returns card identity (year/brand/category/cardNumber/subject/variety/grade) + population (totalPopulation, populationHigher) for any PSA cert. Off-plan asset — capability is built but not wired into the holding-resolution pipeline.

### Off-plan: Diagnostic infrastructure retained

| SHA | Scope |
|---|---|
| `b2cd7ea` | `/api/ops/cardsight-probe` admin endpoint — permanent infra after the Cardsight-quota incident |
| `d26c261` | `backend/scripts/flush-cs-pricing.cjs` (Redis SCAN+DEL pattern flusher) + `backend/scripts/graded-holdings-sweep.cjs` (audit harness — before/after FMV, sample-quality + parallel-token title spot-check) |

---

## Section 3 — What was planned but NOT touched

Measured against the **original 2026-05-21 roadmap framing** (not the addendum's reframed Phase 1):

### Phase 1 — Original silent regression (router L629/L710)

The router's `primary_mode_cardhedge_namespace_only` short-circuit in `cardsight.router.ts` (referenced in the original roadmap problem statement at line 20) **is still live in production**. The 2026-05-27 addendum claimed Phase 1 COMPLETE via `4d4bd8c` (compsByPlayer endpoint + grade-flow fix), but that work addressed a different surface (MCP rewire / compsLoader grade-flow), not the original Phase 1 scope. The router-level silent regression remains.

Severity is still bounded only by ~9% warn-line capture — exact production impact unmeasured.

### Phase 2 — Router bypasses (PR-A2)

Direct CH client imports from route files (`compiq.routes.ts`) — never addressed. Folded into Phase 1 Track B in the original; both still live.

### Phase 3 — CH decommission

- `cardhedge.client.ts` still in `backend/src/services/compiq/` and still imported by router fallback paths (CARDSIGHT_MODE=off and =primary paths use it)
- CH-* env vars still in App Service settings
- `fn-cardhedge-comps` Azure Function status not verified in this reconciliation
- `copilot-instructions.md` may still reference CH

The PICKER path (`/api/compiq/cardsearch`, `/api/compiq/search-list`) was explicitly noted in Section 3 of the roadmap as a CH-blocking dependency via CF-PICKER-MIGRATE-TO-CARDSIGHT — that CF is still open.

### Phase 4a — MCP cache layer

Not built. Every prediction still hits Cardsight live (subject to in-process `cacheWrap` + 6h Redis TTL on `cs:pricing:*` keys — partial latency mitigation, not the planned MCP-mediated cache architecture). p50/p95 latency reduction target (50%) — not measured against Day-10 baseline.

### Phase 4b — Signal integration

Foundation exists (signal pipeline collects data, blended-weight infrastructure exists, harm-diagnosis backtest from 2026-05-25). The roadmap's Phase 4b acceptance criteria (signals demonstrably improve prediction accuracy via A/B test) — **not validated**. Signal weights remained locked to `compsMomentum: 0.20` (per project memory `compsmomentum_weight_lock`) but the actual influence on production traffic was not measured.

### Phase 4c — ML training pipeline

Not built. No training-dataset pipeline, no feature engineering on `comp_logs`, no AutoML experiments, no trained model. The Phase 4c data-sufficiency decision gate (at end of Phase 4c) — not reached because Phase 4c never started.

### Phase 4d — ML serving production traffic

Not built. No model serving infrastructure, no A/B harness at the prediction layer, no outcome tracking expansion to non-user-sold cards (i.e., eBay sold-price scraping for predicted cards), no rollback safety nets.

### Phase 4e — ML moat realized

Not built. **The moat as defined in the roadmap (trained ML model serving 75%+ of production traffic) does not exist.**

What does exist on the prediction surface is a deterministic algorithmic forward projection (`forwardProjection.ts` — TrendIQ composite × scaling factor, clamped 0.80–1.30) operationalized through `predictedPrice` fields persisted on each PortfolioHolding. This is product-facing pricing intelligence, but it is **not a learned model** and **not trained on HobbyIQ's own outcome dataset**.

---

## Section 4 — The central strategic fork (stated, not decided)

The roadmap's moat = **"trained ML model serving 75%+ of production traffic, with proprietary outcome dataset as defensible competitive asset."**

What was actually shipped between 2026-05-21 and 2026-05-28 = **algorithmic forward projection (TrendIQ-driven predictedPrice) + grade-aware pricing (bridge fix) + portfolio integration (movement signals, top movers, dashboard) — all live and working in production**, but **not a trained ML model and not the moat as originally defined.**

### Open question for the roadmap refresh

> **Is the moat still "a trained ML model serving 75%+ of production traffic," or has the shipped algorithmic prediction + grade-aware pricing + portfolio integration product become the actual deliverable, with ML training as longer-horizon optimization rather than the strategic endpoint?**

Two answers, stated neutrally:

#### Answer A — Moat is still the trained ML model

What this implies for the plan:
- The work of 2026-05-27 → 2026-05-28 (Phase 5 ahead of schedule, grade-aware pricing, Cardsight resolver) is **scaffolding** that improves the product but does not advance the moat
- Phase 4c-4e remain the gating workstreams: build the training pipeline, train a model, A/B against current prediction path, scale to 75% traffic, document the competitive advantage
- The accumulated infrastructure debt (CH still in production, no MCP cache, parallel-coverage gaps, data-contamination class) is on the critical path because Phase 4c's training data (`comp_logs`) sits downstream of the resolver — wrong-card resolutions produce polluted training data
- The algorithmic forward projection becomes the GPT-4o-equivalent fallback that the trained model must beat
- Mid-September target for Phase 4e is the original deadline; honest-accounting check: Phase 4c hasn't started, so this target is now MODERATE-to-LOW confidence rather than HIGH

#### Answer B — The shipped product is the moat (or substantial part of it); ML is longer-horizon

What this implies for the plan:
- The "moat" reframes from "trained model serving traffic" to **"actionable seller intelligence using cascade-detected head-start windows + grade-aware pricing + portfolio integration that competitors don't have"** (consistent with project memory `product_actionable_seller_intelligence`)
- Phase 4c-4e shift from critical path to longer-horizon optimization; they still happen, but they're not the milestone — they're version 2 of the prediction layer
- The accumulated infrastructure debt (Section 5) takes on greater weight because the SHIPPED product depends on Cardsight, and Cardsight gaps directly affect product quality (Trout WMB / John Gil etc.)
- CF-PSA-CERT-RESOLUTION-PIPELINE rises significantly: cert-at-scan canonical metadata becomes the data-quality backbone for the shipped product
- Mid-September target reframes — possibly already met (Phase 5 + grade-aware + portfolio integration are live as of 2026-05-28), with September deliverables being product hardening, CF-PSA-CERT, CF-CATALOG-GAP-PRICING-HONESTY, signal validation
- The proprietary outcome dataset is still strategically valuable but as a **future** competitive asset rather than the current moat

### Neither answer is decided here

The refresh session will need:
- A clear-eyed view of the user's actual portfolio (it's small, it's the operator's holdings, growth assumptions matter)
- An honest read on whether `comp_logs` is accumulating fast enough to support Phase 4c training in any plausible timeline
- A read on whether competitive pressure (other pricing tools shipping similar product surfaces) makes the moat reframing more or less urgent
- A read on whether the iOS workstream (parallel track) is keeping up — Phase 5 iOS shipped, but Phase 5 dashboard surfaces are device-pending verification at the time of this reconciliation

---

## Section 5 — Accumulated infrastructure debt

| Item | Status | Implication |
|---|---|---|
| Card Hedge client (`cardhedge.client.ts`) still imported by router fallback paths | Active in `CARDSIGHT_MODE=off` and `=primary` modes | Phase 3 cannot be marked complete until removed AND picker migration ships (CF-PICKER-MIGRATE-TO-CARDSIGHT) |
| No MCP cache | In-process `cacheWrap` + 6h Redis TTL on cs:pricing:* is partial mitigation; full cache architecture (player-slug keys, stale-flag fallback, cache-effectiveness telemetry, miss-rate dashboard) — not built | Cardsight outage = full prediction outage (no cache-only mode); p95 latency reduction target unmet; cache-hit telemetry pollution (decision deferred from Phase 1 Track A) still open |
| Cardsight parallel-coverage gaps | Wal-Mart Border, Target Red, CHR PROS family, retail-border parallels NOT cataloged at Cardsight; Tiffany sales not parallel_id-tagged (handled via title-match fallback this session) | Vendor dependency — affects Trout WMB ×2, Bonemer Blue/Gold, Tommy White, Gage Wood. CF-CARDSIGHT-PARALLEL-COVERAGE is a vendor-escalation surface, not a code fix |
| Data-contamination class | iOS scan path writes contaminated playerName ("MIKE TROUT WAL-MART BORDER"), wrong product field (Topps vs Topps Traded), phantom field names (setName instead of product) | Recurring every session. Mitigations: server-side normalizePlayerName (4effbf4-era), CF-AUTOPRICE-FIELD-NAME-SHIM (252233b), wrapper-strip tokenizeParallel. **Real fix:** CF-PSA-CERT-RESOLUTION-PIPELINE — feed cert at scan → canonical metadata from PSA Pop API |
| Original Phase 1 silent regression (router L629/L710) | Still live in production | The committed roadmap's Phase 1 acceptance criteria ("zero primary_mode_cardhedge_namespace_only warns post-deploy") cannot be met until this is addressed; the 2026-05-27 addendum's "Phase 1 COMPLETE" claim does not survive measurement against the original scope |
| `cardsight.findComps.start/.end` stdout emission gap | Carry-forward from Phase 0; logs don't reach App Service Linux Node container stdout | Affects Phase 4c training data quality and operational debuggability |
| Cosmos `hobbyiq-comps-centralus` 32% per-dependency-row 400 rate | **Investigated three times — final classification: A, benign SDK chatter, zero data loss.** First characterization 2026-05-24 (`44e3884`) as upsert payload defect was wrong; PR #113 (`81f5c7b`) shipped a defensive id-validation guard against the wrong cause. Inverted 2026-05-26 (`3852e62`) to "cross-partition query failure, deferred pending traffic." Re-investigated 2026-05-28 with empirical instrumentation (`aa61097`) + ad-hoc Cosmos diagnostic probe: container is **single-partition** (refutes any fan-out / broken-partition hypothesis structurally), **completeness check across 8 known players × 2 passes shows all data reachable deterministically** (refutes silent data loss). The 32% rate is normal SDK protocol chatter at the dependency layer (query-plan probe pattern) — **the application sees 0% failures**. PR #113 stays as defensive coverage of an unrelated edge case (don't remove). | **NO user-facing impact from the 400s.** The morning's "ACTIVE / DailyIQ data quality degraded" framing in this row's previous version was over-claiming — corrected to "benign SDK chatter, zero data loss." Honest flip-flop note: each correction used best evidence available at the time (24h aggregates, then inversion appendix, then today's empirical completeness check); today's was definitive. **A different real bug surfaced during investigation: name-format mismatch between `getPlayerScoreByName` callers and stored canonical playerName** (e.g., "Bobby Witt Jr." with period misses stored "Bobby Witt Jr"). That IS DailyIQ-quality affecting and is the actual W1 fix target as **CF-PLAYERNAME-CANONICALIZATION** — same symptom (silent nulls on DailyIQ surfaces) the morning framing was groping at, completely different mechanism. |
| Inert work from prior CFs | `fbbab52` Phase 1+3 release-filter setName parity + Tiffany dictionary shipped INERT (removed in `a0609e1`); `cardHedgeCardId` schema column rename pending decision | Cleanup hygiene; not blocking |

---

## Section 6 — Surfaced CF backlog (from `docs/SESSION_HANDOFF.md`)

Two-day arc surfaced or carried forward the following CFs. Priorities reflect the handoff entries verbatim where stated; otherwise from this session's surfacing context.

### From the 2026-05-27 → 2026-05-28 arc (this two-day window)

**HIGH:**
- **CF-PSA-CERT-RESOLUTION-PIPELINE** — surfaced 2026-05-28. Cert-at-scan → canonical holding metadata via existing `psaCert.service.ts`. The real upstream fix for the data-contamination class. Substantial scope (iOS scan path + sync layer + Cosmos schema considerations).
- **CF-PICKER-MIGRATE-TO-CARDSIGHT** — carried (MEDIUM-HIGH, ~6-9h). Blocks Phase 3 CH decommission.
- **CF-IOS-FIELD-CONTRACT-FIX** — carried (~30-60 min Mac). Closes shim debt; paired with CF-PORTFOLIO-METADATA-BACKFILL.

**MEDIUM:**
- **CF-CATALOG-GAP-PRICING-HONESTY** — surfaced 2026-05-28. Trout WMB / John Gil class. Surface "limited data — approximate" / low confidence rather than a confident number for catalog-gap holdings.
- **CF-CARDSIGHT-GRADE-WIRING-AUDIT** — surfaced 2026-05-28. Broader sweep as more graded holdings accumulate; audit harness retained as `backend/scripts/graded-holdings-sweep.cjs`.
- **CF-PRICESOURCE-GRADE-OBSERVABILITY** — surfaced 2026-05-28. Raw-path vs graded-path distinguisher in response shape (defensive).
- **CF-VARIANT-MISMATCH-PRICESOURCE-PARITY** — surfaced 2026-05-28. variant-mismatch return path at [compiqEstimate.service.ts:1860-1892](../backend/src/services/compiq/compiqEstimate.service.ts#L1860-L1892) doesn't surface priceSource fields — observability gap.
- **CF-PORTFOLIO-METADATA-BACKFILL** — carried (~1-2h Windows). Gated on CF-IOS-FIELD-CONTRACT-FIX first; one-time Cosmos rename of phantom field names to canonical.
- **CF-INVENTORY-REFRESH-WIRING** — carried (~1-2h Mac). Backend endpoint exists, iOS APIService method needed.
- **CF-PR-E-TEST-COVERAGE** + **CF-TEST-SIGNING-CONFIG** — partial (test target signing config blocks execution).
- **CF-PR-E-CSV-PENDING-MARKER + CF-PR-E-P&L-COMPLETE-GROUPINGS** — open ~2h total.
- **CF-INVENTORYCARD-RECONSTRUCTION-REFACTOR** — carried (~2-3h Mac). Structural fix for the photo-erasure bug class.
- **CF-DAILYIQ-MOVEMENT-INTEGRATION + CF-DUAL-CACHE-UNIFY + CF-PORTFOLIO-MOVEMENT-HISTORY** — surfaced by Phase 5 iOS shipment (`7f758cd`).

**LOW:**
- **CF-VARIANT-FILTER-WRONG-CARD-DETECTION** — future scope. Cardsight catalog coverage; adjacent to CF-PICKER-MIGRATE-TO-CARDSIGHT.
- **CF-PARALLEL-CANONICALIZATION** — Tommy White M3 case; low impact (1 holding).
- **CF-PHASE4B-CHANNEL3-ATTRIBUTION**, **CF-PHASE4B-LEADING-INDICATOR-VALIDATION** — diagnostic investigations.
- **CF-IOS-ANALYTICS-FRAMEWORK** — future.
- **CF-EBAY-LISTING-SIGNAL-REWORK** — design complete 2026-05-25; implementation deferred.
- **CF-CARDHEDGE-SIGNAL-RENAME** — implementation deferred.
- **CF-CARDIDENTITY-RESOLUTION-WEIGHTING** — Griffey "TRADED" prefix stripping case (1989 UD #1 vs Topps Traded).
- **CF-PHASE4B-PROMPT-AUDIT** — gated on backtest validation outcome.
- **CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS** — autonomous re-run was scheduled.
- **CF-PORTFOLIO-PL-BACKFILL** — LOW priority follow-up for untouched ledger entries (post `0fe88ef`).
- **CF-PORTFOLIO-PERSISTENCE-CONSOLIDATE** — optional refactor; merge the two persistence sites (autoPriceHolding + repriceHoldingsForUser inlined loop) onto a shared helper.
- **CF-PREDICTION-CORPUS + CF-NEXT-SALE-PREDICTION-BACKTEST** — surfaced by Phase 5 prediction-layer shipping.

### Pre-existing roadmap-tracked items

- **CF-CARDSIGHT-PARALLEL-COVERAGE** (LOW future) — vendor escalation for retail-border parallels.
- **CF-CARDSIGHT-RESOLVER-VARIANT-PRIORITY** (LOW future) — generalized resolver smarts (defer pending additional set-level parallel cases).
- **CF-CARDHEDGE-FULL-REMOVAL** — re-scoped pending CF-PICKER-MIGRATE-TO-CARDSIGHT.

---

## Out of scope for this reconciliation

- **Refreshed plan / new phasing.** This document captures state-vs-plan honestly; the refresh is a separate session.
- **Priority decisions on the CF backlog.** Priorities above reflect what was captured in handoff, not a new assessment.
- **Recommendations on the strategic fork.** Section 4 states both branches neutrally; the refresh decides.

---

## How to use this document

The next session that opens roadmap work should:
1. Read this document end-to-end before reading `HOBBYIQ_ROADMAP_2026Q2_Q3.md`
2. Validate the Section 3 claims by independent spot-check (does router L629/L710 short-circuit still exist? does CH still appear in fallback paths? is `comp_logs` accumulating, and at what rate?)
3. Decide the Section 4 fork explicitly before any new phasing is drafted
4. Use the Section 6 backlog as input — but reassess priorities in light of the Section 4 decision (Answer A and Answer B produce different CF priorities)
5. Treat the 2026-05-27 addendum's optimistic timeline claims with caution; they were drafted mid-arc when the Cardsight resolver / grade-wiring / data-contamination work was not yet fully visible

End of reconciliation.
