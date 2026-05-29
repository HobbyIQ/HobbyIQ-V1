# HobbyIQ Roadmap — 2026-05-28 Refresh

**Drafted:** 2026-05-28
**Supersedes:** [`HOBBYIQ_ROADMAP_2026Q2_Q3.md`](HOBBYIQ_ROADMAP_2026Q2_Q3.md) (drafted 2026-05-21, addendum 2026-05-27)
**Historical bridge:** [`ROADMAP_RECONCILIATION_2026-05-28.md`](ROADMAP_RECONCILIATION_2026-05-28.md) (state-vs-plan accounting + Phase 3 debt verification that informed this refresh)
**Status:** Active plan
**Owner:** Drew

---

## Strategic frame (locked 2026-05-29)

Answer B confirmed: The shipped product — cascade-detected prediction + grade-aware pricing + portfolio integration — IS the moat. ML training (Phase 4c-4e) is sequenced as a v2.0 capability, gated on post-launch data volume.

Reasoning: Answer A (trained model serving 75%+ traffic) is structurally data-blocked pre-launch. Single-operator usage cannot generate ML-training-scale labeled outcome data; that volume can only materialize post-launch when real user traffic produces predictions and matched sale outcomes. The shipped integrated product is therefore what the business launches on; the ML moat is the optimization layer that becomes possible after launch traffic produces the labeled data foundation.

This is not "give up on the ML moat" — it is "recognize the ML moat is the post-launch optimization, not the launch-time differentiator. The launch-time moat is the integrated product itself, which competitors cannot replicate by buying comps."

---

## What's actually live in production as of 2026-05-28

| Surface | State | Reference |
|---|---|---|
| Phase 5 portfolio movement integration | iOS shipped | `7f758cd` |
| TrendIQ-driven algorithmic `predictedPrice` | Backend live, persisted, returned by /search /price /price-by-id /bulk /estimate | `8bd2487` + `f48f778` + `c48e51e` + `12de7c1` |
| Grade-aware pricing (response-side bridge) | Backend live, validated on 12 graded holdings | `8e61f51` |
| Cardsight title-match with specificity guard | Backend live (the response architecture this bridge plugs into) | `96cbc30` |
| `/api/ops/cardsight-probe` admin endpoint | Permanent diagnostic infra | `b2cd7ea` |
| Grade canonical migration (PSA descriptor parser) | Shipped; iOS Double? branch pending Mac compile validation | `8b4465c` + `57ab110` (branch) |
| PR E reconciliation UX (iOS + backend P&L) | End-to-end shipped, device-test pending | `01d2cd4` + `0fe88ef` |
| PSA Public API integration (cert lookup) | **Service exists, route exists, NOT wired into scan flow** | `backend/src/services/psa/psaCert.service.ts` |
| Diagnostic scripts | Permanent ops tooling | `d26c261` |

---

## Verified debt state (from Phase 3 of refresh session)

The reconciliation doc's Section 5 listed accumulated debt. Empirical verification 2026-05-28 changed the priority of several items:

| Debt item | Verified state | Implication |
|---|---|---|
| Cosmos `hobbyiq-comps-centralus` 32% dependency-row 400 rate | **Final classification 2026-05-28: A, benign SDK chatter, zero data loss.** Investigated three times across two days. Final empirical evidence: container is **single partition** (refutes fan-out / broken-partition structurally), **completeness check across 8 known players × 2 passes shows all data reachable deterministically** (refutes silent data loss). The 32% is per-dependency-row, application sees 0% failures, SDK absorbs internally. Honest flip-flop noted: morning's "ACTIVE / DailyIQ degraded" framing was based on dependency-aggregate inference; today's direct probe + completeness check was definitive. | **No fix needed.** PR #113 (`81f5c7b`) stays as defensive coverage of an unrelated edge case. **The morning's symptom framing (silent nulls on DailyIQ) was right — but the mechanism is name-format mismatch, not Cosmos 400s.** That is the actual W1 target as **CF-PLAYERNAME-CANONICALIZATION**. |
| Card Hedge client still in code | Prod `CARDSIGHT_MODE=exclusive`. `off`/`shadow`/`primary` fallback branches are dead code in production. Picker path (`/api/compiq/cardsearch`, `/search-list`) IS still calling CH's `searchCards`. | Picker migration is the real unlock; rest is dead-code cleanup |
| Original Phase 1 silent regression (router L490-494) | Short-circuit code still present, BUT meaningful-query fall-through at `compiqEstimate.service.ts:858-878` is the documented workaround. Empty-return is the intentional fallback when there's no query text to drive Cardsight catalog lookup. | The 2026-05-27 addendum's "Phase 1 COMPLETE" claim is substantively correct in practice. Not a critical path item. |
| Cardsight parallel-coverage gaps | Vendor doesn't catalog retail-border parallels (Wal-Mart Border, Target Red, CHR PROS family). Confirmed via Trout WMB ×2, Bonemer, Tommy White, Gage Wood. | Vendor dependency — not fixable our side. Surface honestly via CF-CATALOG-GAP-PRICING-HONESTY. |
| Data-contamination class (iOS field contract) | Recurring — playerName contamination, wrong product field, phantom setName field. Server-side workarounds in place (normalizePlayerName, field-name shim, tokenizeParallel wrapper-strip). | Real fix is **CF-UNIFIED-SEARCH-AND-CERT** (renamed and expanded from the original CF-PSA-CERT-RESOLUTION-PIPELINE per design `23038d7`) — clean identity entry path via cert lookup OR Cardsight catalog → canonical CardIdentity → committed to portfolio. v1 ships the input contract; existing contaminated holdings stay on legacy paths per design §14 scope discipline. |
| Inert prior work (Tiffany dictionary, etc.) | Removed in `a0609e1` (Phase 2 Commit A). | Closed. |

---

## Launch-readiness workstream — staged scaling tiers

Per Drew's framing (2026-05-29): build the system for 100 users, then incrementally raise the ceiling — 100 → 500 → 1000 → 5000 → 20000. Each tier verifies current capacity, identifies the binding constraint that would break at the next tier, fixes it, and proves the new ceiling holds.

- **CF-LAUNCH-READINESS-100**: shipped 2026-05-29 (see closeout doc at [`docs/phase0/launch_readiness_100_2026-05-29.md`](phase0/launch_readiness_100_2026-05-29.md)). Cosmos autoscale (`dailyiq_briefs`, `portfolio`) + 6 monitoring alerts + verified end-to-end alert delivery.
- **CF-LAUNCH-READINESS-500**: future. Candidate binding constraints from 100-tier surfacing: `player_trends` write throughput (currently flat 400 RU/s manual; estimate-driven writes can throttle under sustained load), rate-limiter capacity (200 req/min/IP needs evaluation at 500-tier load patterns).
- **CF-LAUNCH-READINESS-1000, -5000, -20000**: future, each gated on previous tier verification.

Influencer-driven launch context (free-access seeding to influencer partnerships, target 20K+ users) sets the upper tier as the practical launch target. Launch date is not yet committed to the plan; staged scaling work proceeds independent of date commitment, since each tier's work is non-regretful regardless of when launch lands.

---

## The Q3 plan — 14 weeks from 2026-05-28

**Capacity assumption:** Solo operator, ~1-2 focused sessions per major workstream, no contractor. Calendar pace per the 2026-05-27 addendum's "sustainable pace" framing. One serious production incident absorbs 1-2 days and shifts dependent milestones back by that amount.

**Sequencing principle:** Data-quality foundation first → product honesty → infrastructure resilience → signal validation → product hardening. ML is Q4+.

### Week 1 (2026-06-02 → 2026-06-08) — Polish sprint + CF-UNIFIED-SEARCH-AND-CERT design

**Status: COMPLETE 2026-05-28.** All three W1 items closed in a single same-day session ahead of the planned W1 calendar window. Shipped items production-verified; design item committed and HALTed for implementation.

**Same-day W1 follow-ons (2026-05-28 PM → 2026-05-29):**

- ✅ **CF-PLAYERTRENDS-DUPLICATE-RECORDS — SHIPPED + PRODUCTION-VERIFIED 2026-05-28** (`b864af5`). Slug→numeric merge on numeric upsert + one-shot cleanup script. 4 known dupes resolved: Mike Trout + Ken Griffey via organic production traffic merge within 10 min of deploy (load-bearing production-quality signal); Bobby Cox via targeted `/api/playeriq/refresh` (7-snapshot merge, all hard rules met); John Gil via cleanup script. Final state: 76 → 72 docs, 0 duplicate sets. CF-PLAYERTRENDS-SLUG-RE-RESOLUTION captured as LOW backlog for orphan slugs whose MLB id never resolves.
- ✅ **CF-UNIFIED-SEARCH-AND-CERT W2 — SHIPPED 2026-05-29** (`dd7ec17`). Cert-grader abstraction + registry + PSA grader adapter (5 source files + 1 test file + design doc §5 update). Title strategy locked (A) — verbatim variety string in `CardIdentity.title` for VerifyView slab-fidelity, canonical parallel token in `CardIdentity.parallel` for matching/pricing. 49 new tests; backend suite 1130 → 1179 green.
- ✅ **CF-LAUNCH-READINESS-100 — SHIPPED 2026-05-29.** First tier of staged scaling workstream (see new launch-readiness section below).

- ✅ **CF-PLAYERNAME-CANONICALIZATION** — **SHIPPED + PRODUCTION-VERIFIED 2026-05-28** (`b51b763`). Canonical playerName field on `PlayerScore` + indexed exact-match lookup + 76-record backfill + reusable diagnostic scripts. `getPlayerScoreByName("Bobby Witt Jr.")` (with period) now resolves correctly. Accents handled incidentally by general punctuation/NFKD strip per Drew's "free if general" framing. Surfaced as the actual DailyIQ-quality bug behind the morning's symptom framing during CF-PLAYERTRENDS-QUERY-FAILURE investigation (closed same day as classification A — benign SDK chatter, zero data loss; see `61e88c6` doc closure). 1116 tests pass (+10 net new). matchedVia telemetry confirms 0 legacy-lower hits = backfill complete.
- ~~**CF-PLAYERTRENDS-QUERY-FAILURE**~~ — **RETIRED 2026-05-28**: investigated → classified A (benign SDK chatter, zero data loss). Container is single-partition; completeness check across 8 known players × 2 passes shows all data reachable deterministically. Instrumentation (`aa61097`) stays in production through CF-PLAYERNAME-CANONICALIZATION's verification cycle; remove in a cleanup commit after a week of zero `legacy-lower` hits.
- ✅ **CF-VARIANT-MISMATCH-PRICESOURCE-PARITY** — **SHIPPED + PRODUCTION-VERIFIED 2026-05-28** (`ccd05dc`). 4-line propagation of the router's parallel-resolution attribution onto the variant-mismatch response. Verified end-to-end on Bonemer Gold PSA 9 (priceSource present with propagated "broad" / "unified-no-cardsight-match"). 1122 tests pass (+6 net new) including scope-lock negative regression tests for no-recent-comps and unsupported_sport paths. CF-PRICESOURCE-PARITY-FULL opened as MEDIUM future for the three other non-success paths.
- ✅ **CF-UNIFIED-SEARCH-AND-CERT — DESIGN COMMITTED 2026-05-28** (`23038d7`). Renamed and expanded from the original CF-PSA-CERT-RESOLUTION-PIPELINE per a same-day W1 architecture session. Three-phase delivery (v1 standalone unified search + verify + comp-card with dual-mode input and extensible cert-grader abstraction; v1.5 BGS/SGC/CGC per-grader CFs slot in via registry; v2 scan integration deferred to its own future design phase). Drew-locked decisions: D1 — Cardsight only, CF-PICKER-MIGRATE absorbed into v1's foundation work; D2 — cherry-pick OneDrive `CardScanResultView` for verify UI only; D3 — v2 scan deferred, v1 notes extension point. Phase 1 discovery at `0fbc5e2`; Phase 3 design at `23038d7`. HALT before implementation; v1 implementation scope honestly revised from 1.5-2 weeks to 3-5 weeks calendar (see Weeks 2-6 below).

**Milestone:** polish sprint shipped end-to-end; design committed for unified search + cert + verify v1.

### Weeks 2-6 (2026-06-09 → 2026-07-13) — CF-UNIFIED-SEARCH-AND-CERT v1 implementation

**Honestly revised scope** vs. the original W2-W3 estimate. v1 implementation per design `23038d7` §13 is **17-22 focused days = 3-5 weeks calendar pace**. Original CF-PSA-CERT-RESOLUTION-PIPELINE estimate (1.5-2 weeks) was for a thinner scope; CF-UNIFIED-SEARCH-AND-CERT expanded the scope explicitly during design to absorb:

- (a) **Cert-grader abstraction** — registry + interface + adapter pattern so v1.5 BGS/SGC/CGC each ship as service-file + one-line registration (zero v1 touches). Load-bearing per design §1.
- (b) **Unified `/api/search/cards` endpoint with server-side dispatcher** — supports v1.5 backend-only deploys without coordinated iOS commits. Auto-detect via registry `recognizes()` predicates; explicit `hint` field for iOS override.
- (c) **CF-PICKER-MIGRATE-TO-CARDSIGHT absorbed into v1 per D1** — was a separate W5-W6 workstream; now part of v1's foundation work. v1 ships on the future-proof Cardsight path; CHR PROS class coverage gaps surfaced honestly via the existing `warnings` array rather than hidden by building on legacy CardHedge.
- (d) **Canonical `CardIdentity` type + iOS Codable mirror + explicit `attribution: "authoritative" | "ranked"` field** — single canonical shape populated by every cert grader and the Cardsight catalog adapter.
- (e) **VerifyView as new screen** — cherry-picked from OneDrive `CardScanResultView` per D2 and adapted for `CardIdentity`. Slots between picker results and existing `CompIQPricedCardView`. v1 has NO commit-to-portfolio action (extension point built in for v2).

**Week-by-week (target — adjust at implementation start if Drew picks alternate sequencing):**

- **Week 2 (Jun 09-15):** Backend foundation — cert-grader abstraction + registry + interface; PSA grader adapter (thin wrap of existing `psaCert.service.ts`); `CertGraderError` typed errors.
- **Week 3 (Jun 16-22):** Backend dispatcher — unified `/api/search/cards` endpoint; `CardIdentity` type + Cardsight catalog adapter; refactor existing autograph/color/scoring logic from `compiq.routes.ts:763-800` into shared helper.
- **Week 4 (Jun 23-29):** CF-PICKER-MIGRATE-TO-CARDSIGHT internal swap — `compiq.routes.ts:6` and `:753` replaced; shape-adapter preserves CardHedge response shape for legacy clients (empirical verification per §15 operational note). `PortfolioHolding` schema additions for `certNumber` / `certGrader`. Backend tests.
- **Week 5 (Jun 30 - Jul 06):** iOS — unified search input UI with auto-detect dispatch and `hint` field; `ResultsView` refactor of `CompIQVariantPickerView`; `CompIQSearchService.search()` method + Codable models for `CardIdentity` / `UnifiedSearchResponse`.
- **Week 6 (Jul 07-13):** iOS — `VerifyView` (cherry-pick `CardScanResultView` per D2, adapt for `CardIdentity`); state model wiring + navigation; smoke sweeps (Cardsight catalog 23-holding cohort + cert flow with known PSA certs incl. Witt 76556858); pre-deploy + deploy + production verification.

**Milestone:** v1 unified search + cert + verify + comp-card flow live in production. Phase 3 CH decommission is **partially shipped** via the absorbed picker migration; the remaining CH cleanup (dead-code removal, env var scrubbing, `fn-cardhedge-comps` disable, `cardHedgeCardId` schema rename decision) becomes a small cleanup commit attached to v1 ship (~half day).

**Reference:** [`docs/phase0/unified_search_design_2026-05-28.md`](phase0/unified_search_design_2026-05-28.md) (`23038d7`) — full architecture, locked decisions D1/D2/D3, scope estimates per workstream, v1.5 and v2 forward-compat notes.

### Week 7 (2026-07-14 → 2026-07-20) — CF-CATALOG-GAP-PRICING-HONESTY

**Be honest about un-priceable cards. Trout WMB / John Gil class.** Shifted from W4 due to W2-W6 absorption of unified-search v1.

- Backend response shape: surface a new field signaling pricing confidence tier (e.g., `pricingTier: "direct-graded" | "raw-multiplier" | "sibling-pool" | "variant-mismatch"`). Map from existing priceSource/source values.
- iOS surface: add "limited data — approximate" or "approximate" chip on holdings where the pricing tier isn't `direct-graded`. Render alongside FMV with muted styling.
- Audit pass: sweep all 12 graded holdings + 5 raw holdings via `graded-holdings-sweep.cjs`; verify the tier classification matches reality.

**Milestone:** product honesty about catalog-gap cards. Trout WMB shows "approximate" rather than a confident $382.50.

### ~~Weeks 5-6 — Phase 3 CH decommission~~ — **ABSORBED into Weeks 2-6 above**

Per D1, the CF-PICKER-MIGRATE-TO-CARDSIGHT picker migration is v1 foundation work, no longer a separate workstream. The remaining CH cleanup (dead-code removal, env vars, `fn-cardhedge-comps` disable, `cardHedgeCardId` rename) is a small follow-up commit attached to v1 ship — not a separate W5-W6 window.

### Weeks 8-10 (2026-07-21 → 2026-08-10) — Phase 4a MCP cache layer

**Production resilience. The 'first deploy silently failed to rsync dist' incident this session is a small-radius version of the bigger risk: Cardsight outage = full prediction outage today.**

Original roadmap budgeted Weeks 5-6 (2 weeks). Honest estimate based on existing in-process cache + the actual operational requirements: **3 weeks**. Shifted from W7-9 to W8-10 due to W2-W6 absorbing unified-search v1.

- **Week 8: Design + implementation Pt 1** — decision: in-process cache layer extension vs separate MCP service. Lean: in-process extension (existing `cacheWrap` is already there; the work is adding player-slug-keyed reads + cache-miss telemetry + stale-flag fallback). Blob storage decision: reuse existing 14-function blob pipeline or build new namespace.
- **Week 9: Implementation Pt 2 + invalidation** — cache reader by player-slug, TTL respect, miss → live Cardsight call → write to cache. Signal pipeline triggers re-fetch on >5% predicted-price move; otherwise nightly refresh. Stale-flag in response when Cardsight down + cache stale (never serve nothing).
- **Week 10: Observability + deploy + bake-in** — cache hit rate dashboard in App Insights. Decision on cache-hit telemetry pollution (add `cache_hit: boolean` to comp_logs vs move writer outside cacheWrap). Production deploy. Monitor cache hit rate trajectory (target: >80% within 1 week).

**Milestone:** Cardsight outage no longer = full outage. p95 prediction latency drops materially.

### Weeks 11-12 (2026-08-11 → 2026-08-24) — Phase 4b signal validation

**Finish the unfinished foundation. The signal pipeline collects; whether it influences predictions correctly is the open question.** Shifted from W10-11.

- **Week 11: Backtest re-run + A/B harness** — Phase 4b backtest methodology was in flight per addendum (CF-BACKTEST-REPEATS, CF-BACKTEST-DETERMINISTIC). Re-run with current code state. Capture per-signal MAPE contribution. Determine if signal-on predictions outperform signal-off on accuracy.
- **Week 12: A/B run + interpretation** — 7-day production A/B (50% traffic gets full signal blend, 50% gets compsMomentum-only). Statistical significance gate. Decision on per-signal weight adjustments. Capture findings.

**Milestone:** signals demonstrably influence predictions, weights calibrated against measured contribution, or honest "signals don't move predictions enough to justify the cost" finding with retirement decisions per project memory `compsmomentum_weight_lock`.

### Weeks 13-14 (2026-08-25 → 2026-09-07) — Product hardening sprint

**The work that's been deferred while shipping features. Audit, calibrate, surface.** Shifted from W12-13.

- **Week 13: comp_logs audit + data-quality scorecards** — what's the real schema completeness (cardId null, parallel literal-only, schema gaps from SOAK_LOG)? Build a dashboard showing the row-count growth trajectory + per-field completeness. This is the data substrate for any future ML — if it's polluted now, ML can't help.
- **Week 14: Prediction confidence calibration + grade-wiring audit re-run** — compare `predictedPrice` to actual ledger sales prices (where available). Are bounded multipliers actually predictive? Run `graded-holdings-sweep.cjs` again post-debt-cleanup. Surface mismatches as CFs.

**Milestone:** the product is calibrated, the data substrate is measured, the audit harness is institutionalized as a periodic check.

### Week 15 — Q3 closeout + Q4 ML prep — **shifts ~1 week past Q3 boundary** (2026-09-08 → 2026-09-14)

**Honest milestone landing.** The W2-W6 unified-search-v1 absorption pushed the original Week 14 closeout to Week 15. Q3 milestone now lands **mid-September** rather than 2026-09-07. Closeout content unchanged:

- Q3 deliverable: **product hardened, data-quality root-fix landed, signal validation complete, infrastructure debt down to manageable backlog.**
- Q4 ML prep: assess `comp_logs` row count + outcome-tracking gap. Decide whether Phase 4c training pipeline can kick off Oct 1 with extant data + outcome-via-ledger, or whether it needs eBay-scraping outcome expansion (multi-week project) as a prerequisite.

**Milestone:** Q3 closeout retrospective + Q4 ML kickoff plan committed to roadmap. **Q3 calendar boundary slip acknowledged**: with unified-search v1 honestly scoped at 3-5 weeks (W2-W6), the previously-tight Q3 milestone (Sep 07) shifts to mid-September; the original Q3 calendar buffer (Week 14 closeout) is consumed. Drew can either (a) accept Q3 milestone at mid-September; (b) compress one of the shifted items (4a/4b/hardening) by ~1 week; (c) trim scope on one of them. Decision deferrable until v1 ships and actual W2-W6 calendar lands.

---

## Q4-2026 → Q1-2027 — ML training pipeline (Phase 4c-4e, sequenced-later)

This is **NOT critical path** under Answer-B-provisional. It is **NOT out-of-scope** either. It is explicitly sequenced as Q4+ optimization work, gated on data sufficiency.

### Q4 2026 (Oct-Dec) — Phase 4c kickoff

**Reality check at start of Q4:** `comp_logs` will have accumulated ~6-7 months at 1.0 sample rate. At current ~1660 rows/month + Phase 5 reprice traffic + iOS adoption growth, that's somewhere in 12-20k rows. That is still on the **lower end** for AutoML regression on a multi-dimensional problem. The Phase 4c data-sufficiency gate from the original roadmap remains the gate.

- **Phase 4c — ML training pipeline** (8-10 weeks)
  - `comp_logs` → training-dataset pipeline (one-time + nightly delta)
  - Feature engineering: signal values at prediction time, card identity, market context
  - Outcome backfill: join `comp_logs` predictions with `PortfolioLedgerEntry` sales — narrow N, biased toward "cards users decided to sell"
  - **Decision gate at end of Phase 4c:** Is current outcome data sufficient (probably no), OR do we need eBay-scraping outcome expansion (multi-week project per original Phase 4d scope) before model training?
  - If insufficient: Phase 4c extends through Q1 2027 while eBay-scraping ships in parallel
  - If sufficient (unlikely but possible if `comp_logs` adoption grows): first AutoML experiment, go/no-go on Phase 4d

### Q1 2027 (Jan-Mar) — Phase 4d ML serving (conditional)

- Conditional on Phase 4c data-sufficiency gate passing
- Model serving infrastructure, A/B harness at prediction layer, outcome tracking expansion, rollback safety nets, ≥25% traffic milestone
- Trained model competes against the algorithmic forward projection on A/B accuracy

### Q1-Q2 2027 — Phase 4e moat realization (conditional)

- Conditional on Phase 4d showing model > algorithmic-baseline on accuracy
- 75% traffic milestone, outcome feedback loop closed, competitive analysis documented
- **This is when "trained model serving 75% of production traffic" arrives, IF the answer-A moat definition still applies at that point.** By Q1-Q2 2027, the algorithmic + product moat will have had 9-12 more months to compound; the answer-A vs answer-B question will be more empirically answerable then.

---

## Parallel Mac/iOS workstream

iOS development continues parallel to backend phases.

| Window | iOS scope |
|---|---|
| Weeks 1-3 (Jun) | Bug 3 device test, Bug 4 fix, D.4 publish/revise/end/status UI, ITEM_SOLD consumer pipeline iOS-side |
| Weeks 4-6 (Jun-Jul) | **CF-UNIFIED-SEARCH-AND-CERT v1 iOS pieces** — picker migration validation (Cardsight response shape), new unified search input UI with auto-detect dispatch, `ResultsView` refactor of `CompIQVariantPickerView`, new `VerifyView` (cherry-pick from OneDrive `CardScanResultView` per D2), `CompIQSearchService.search()` + Codable models for `CardIdentity` / `UnifiedSearchResponse`. Mac access required for build/runtime verification. |
| Week 7 (Jul) | CF-CATALOG-GAP-PRICING-HONESTY iOS surface — pricing tier chips on holdings, muted styling for non-direct-graded |
| Weeks 8-11 (Jul-Aug) | iOS Double? branch (`ios-grade-canonical-WIP-windows / 57ab110`) Mac compile + ship, CF-IOS-FIELD-CONTRACT-FIX (now substantially closed by unified-search v1's clean entry path) |
| Weeks 12-15 (Aug-Sep) | CF-DAILYIQ-MOVEMENT-INTEGRATION, CF-DUAL-CACHE-UNIFY, CF-PORTFOLIO-MOVEMENT-HISTORY |

iOS Phase 5 device verification (pending per `7f758cd` handoff) is operator-task-list, not roadmap-tracked.

---

## Q3 acceptance criteria (replaces original "End of July CompIQ formalization + Mid-September ML moat realized")

### End of Q3 2026 (2026-09-30)

- ✅ Data-quality root fix shipped (CF-UNIFIED-SEARCH-AND-CERT v1 live: cert lookup + Cardsight search + canonical CardIdentity + VerifyView)
- ✅ Catalog-gap pricing honesty surfaced (iOS chips, confidence tiers in response)
- ✅ Phase 3 CH decommission complete (picker migration absorbed into v1 W2-W6; remaining CH cleanup small follow-up commit)
- ✅ Phase 4a MCP cache layer live (>80% hit rate, Cardsight outage resilience verified)
- ✅ Phase 4b signal validation complete (signal contribution measured, weights calibrated or retired)
- ✅ Product hardening sprint complete (comp_logs audited, prediction calibration measured)
- ✅ Q4 ML kickoff plan committed to roadmap with explicit data-sufficiency gate
- ✅ iOS Phase 5 device-verified and shipped
- ✅ iOS Double? grade branch shipped

### Q4 2026 → Q1 2027 — conditional ML phase

- Conditional on data sufficiency. Honest accounting at end of Q3, replanning in light of actual row count + outcome data.
- The original "mid-September ML moat realized" target is REPLACED with "Q3 product hardening + data-quality, ML optimization Q4+." The mid-September date no longer means anything in this plan.

---

## What's explicitly out of scope (and why)

- **Multi-marketplace listing, web companion, public API, multi-user accounts, international expansion, other sports, TCG expansion, auction house integration, live event integration, vault/consignment, insurance integration.** Same as original roadmap — captured as future-scope questions.
- **Phase 4b leading-indicator-validation** (CF-PHASE4B-LEADING-INDICATOR-VALIDATION) and **CF-PHASE4B-CHANNEL3-ATTRIBUTION** — folded into Phase 4b signal validation weeks 10-11, not separate workstreams.
- **CF-VARIANT-FILTER-WRONG-CARD-DETECTION, CF-PARALLEL-CANONICALIZATION** — LOW priority, parked. Address opportunistically when adjacent code is touched.
- **CF-EBAY-LISTING-SIGNAL-REWORK** — design complete 2026-05-25; implementation deferred until eBay-scraping outcome expansion is on the table (Phase 4c data sufficiency gate decision).
- **CF-CARDIDENTITY-RESOLUTION-WEIGHTING** (Griffey "TRADED" prefix case) — LOW priority unless CF-PSA-CERT pipeline doesn't fully address it.
- ~~**CF-PLAYERTRENDS-DUPLICATE-RECORDS**~~ — **SHIPPED 2026-05-28** (`b864af5`). Slug→numeric merge on numeric upsert + one-shot cleanup script. All 4 known dupes resolved (76 → 72 docs, 0 duplicate sets). Mike Trout + Ken Griffey merged organically by production traffic within 10 min of deploy (load-bearing production-quality signal). CF-PLAYERTRENDS-SLUG-RE-RESOLUTION captured as LOW backlog follow-up for orphan slugs whose MLB id never resolves at write time.

---

## Risk register (refreshed)

**Carry-forward from original roadmap (still active):**

1. **Cardsight coverage gap** (Risk 1 original) — still active. Mitigated by CF-CATALOG-GAP-PRICING-HONESTY in **Week 7** (shifted from W4; honest "approximate" labels rather than coverage improvement).
2. **MCP layer bigger than estimated** (Risk 2 original) — re-estimated 2 → 3 weeks honestly. Still a risk if invalidation logic surfaces design questions.
3. **Sparse outcome data limits ML quality** (Risk 3 original) — now a Q4 risk, not Q3. Data-sufficiency gate at end of Phase 4c explicitly addresses this.
4. **Production ML incident** (Risk 7 original) — Q4+ concern. Phase 4d rollback infrastructure remains in scope.
5. **Observability layer partial restoration emission gap** (Risk 8 original) — still active. Address opportunistically in product hardening sprint (**Week 13** comp_logs audit; shifted from W12).
6. **Compaction summary fabrication pattern** (Risk 11 original) — discipline pattern from `copilot-instructions.md`. Carried forward.

**New risks surfaced 2026-05-28:**

7. ~~**Strategic frame reframe ("PROVISIONAL Answer B") gets locked in by accumulation rather than deliberate decision.**~~ — **RETIRED 2026-05-29**: Answer B confirmed and locked deliberately (see Strategic frame section above). ML moves to v2.0 backlog per CF-ML-MOAT-V2; launch-readiness becomes the active workstream gating the launch.
8. **CF-UNIFIED-SEARCH-AND-CERT v1 implementation surfaces unforeseen scope during W2-W6.** v1 design `23038d7` honest-scoped to 3-5 weeks (W2-W6) absorbing cert-grader abstraction + unified dispatcher + picker migration per D1 + canonical CardIdentity + VerifyView. Mitigation: design HALT preserved; implementation phase HALTs at end-of-week for each of W2-W6 for Drew status check + re-scope opportunity. If v1 overruns W6, Q3 closeout shifts proportionally per item 11 below.
9. **Picker migration (absorbed into W4 per D1) reveals Cardsight searchCatalog can't match CH searchCards on variant-disambiguation, autograph detection, or image_url normalization.** Mitigation: shape-adapter verified empirically against iOS contract before deployment per design `23038d7` §15 operational note; existing autograph/color/scoring logic preserved (refactored to shared helper, not rewritten); shipped on the Cardsight-only path per D1 with CHR PROS class gap surfaced honestly via `warnings` array rather than hidden.
10. **Phase 4a MCP cache implementation surfaces blob-storage namespace + cache-invalidation design depth.** Mitigation: 3-week budget (vs original 2), **Week 8** is design + Pt 1 to surface depth early (shifted from W7).
11. **Q3 calendar slip from unified-search v1 absorption.** v1's W2-W6 honest 3-5 week scope (vs original 1.5-2 weeks at refresh) pushed downstream items by ~3 weeks net. Q3 closeout (was W14) is now Week 15 (mid-September), past the original 2026-09-07 Q3 boundary. **Q3 buffer is consumed before implementation begins.** Mitigation: Drew accepts mid-September Q3 milestone OR compresses one shifted item (4a/4b/hardening) by ~1 week OR trims scope on one. Decision deferrable until v1 ships and actual W2-W6 calendar lands. If v1 also overruns W6, Q3 milestone shifts to end-of-September / early-October.

12. **DailyIQ data quality degraded by name-format mismatch on `getPlayerScoreByName` cross-partition lookup** (REPLACES the earlier mid-day "Risk 12: Cosmos 400s" framing that was retired same-day after empirical disconfirmation). Stored canonical playerName form differs from caller-supplied form on punctuation and accents (e.g., stored "Bobby Witt Jr" vs caller "Bobby Witt Jr." with period; accented names like Acuña / Peña presumed at risk pending Phase 1 scope). The `WHERE LOWER(c["playerName"]) = @name` comparison misses on those, callers see deterministic silent nulls. Mitigation: CF-PLAYERNAME-CANONICALIZATION in W1 with Phase 1 read-only scoping HALT before fix to enumerate the full mismatch surface, not just the one found.

**Removed risks (verified non-issues):**

- ~~Phase 1 silent regression critical path~~ — meaningful-query fall-through is the workaround; severity dropped.
- ~~Cosmos `hobbyiq-comps-centralus` 22-32% failure rate~~ — investigated three times across two days; final classification 2026-05-28 is **A, benign SDK chatter, zero data loss**. Single-partition container refutes fan-out / broken-partition hypotheses structurally; completeness check across 8 known players × 2 passes confirms no missing data. The morning-of-2026-05-28 demotion-and-restoration of this entry was an honest flip-flop on incomplete evidence; today's direct probe was definitive. The user-facing symptom that motivated the restoration (silent nulls on DailyIQ) is real but mechanistically the **separate** name-format mismatch above (Risk 12), not the Cosmos 400s.

---

## Cadence

- **Daily**: at least one HALT gate, one commit, one verification (carried from original)
- **Weekly**: status check against this plan. If a week slips, log it; if scope shifts, capture here.
- **End of each workstream**: explicit retro in session handoff.
- **End of Q3 (2026-09-30)**: full milestone retro + Q4 ML kickoff plan committed.
- **Provisional moat-narrative confirmation**: scheduled explicitly by Drew, before external/strategic positioning shifts.

---

## Plan evolution

This document is canonical as of 2026-05-28. Updates committed as diffs here, not absorbed into session handoffs. `SESSION_HANDOFF.md` remains "what did this session do." This document is "where are we going under Answer-B-provisional."

When a workstream completes: update with `**COMPLETE** (date, commit SHA)`. When a workstream slips: update week range with brief explanation. When the moat-narrative reframe is either confirmed or revised: replace the "Strategic frame: PROVISIONAL Answer B" section with the locked decision and propagate consequences through the plan.

This is the plan. Execute, measure, adjust, ship. ML happens later — not skipped.

End of refresh.
