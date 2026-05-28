# HobbyIQ Roadmap — 2026-05-28 Refresh

**Drafted:** 2026-05-28
**Supersedes:** [`HOBBYIQ_ROADMAP_2026Q2_Q3.md`](HOBBYIQ_ROADMAP_2026Q2_Q3.md) (drafted 2026-05-21, addendum 2026-05-27)
**Historical bridge:** [`ROADMAP_RECONCILIATION_2026-05-28.md`](ROADMAP_RECONCILIATION_2026-05-28.md) (state-vs-plan accounting + Phase 3 debt verification that informed this refresh)
**Status:** Active plan
**Owner:** Drew

---

## Strategic frame: PROVISIONAL Answer B

> **Shipped product (algorithmic forward projection + grade-aware pricing + portfolio integration) IS the moat. ML training (Phase 4c-4e) is sequenced-later as Q4-2026 → Q1-2027 optimization layer, NOT critical path, NOT out-of-scope.**

**The "PROVISIONAL" qualifier is load-bearing.** The narrative reframe ("shipped product is the moat, not the trained ML model") is **pending Drew's clear-headed fresh-session confirmation** before external/strategic positioning shifts. The WORK in this document is correct under both Answer A and Answer B and is non-regretful regardless — it improves data quality, ships product, validates signals, and lands infrastructure debt. So the work begins now.

**Why provisional, not locked:**
- Answer A as defined ("trained model serving 75%+") is data-blocked at the present row-accumulation rate (~1660/month), pushing arrival to late-2026/2027 regardless of prioritization. So pretending to pursue A in Q3 would just be theater.
- Answer B's narrative is genuinely true to what's shipped — but reframing the moat externally is a strategic decision Drew should make once, deliberately, in a fresh session with the data spread out. Not as a side-effect of debugging Maddux Tiffany.

**What changes if Drew later confirms Answer A instead:**
- Workstreams 1-7 below all still ship — they are foundation work for any ML training path, not Answer-B-specific
- Workstream 8 (ML sequenced Q4-2026 → Q1-2027) gets pulled forward to "starts as soon as data sufficiency permits, regardless of product hardening status"
- The Q3 closeout milestone shifts from "product hardening + signal validation complete" to "ML training pipeline running on whatever data exists, GO/NO-GO gate at end of Q3"

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
| Data-contamination class (iOS field contract) | Recurring — playerName contamination, wrong product field, phantom setName field. Server-side workarounds in place (normalizePlayerName, field-name shim, tokenizeParallel wrapper-strip). | Real fix is CF-PSA-CERT-RESOLUTION-PIPELINE — cert-at-scan canonical metadata via existing psaCert.service.ts. |
| Inert prior work (Tiffany dictionary, etc.) | Removed in `a0609e1` (Phase 2 Commit A). | Closed. |

---

## The Q3 plan — 14 weeks from 2026-05-28

**Capacity assumption:** Solo operator, ~1-2 focused sessions per major workstream, no contractor. Calendar pace per the 2026-05-27 addendum's "sustainable pace" framing. One serious production incident absorbs 1-2 days and shifts dependent milestones back by that amount.

**Sequencing principle:** Data-quality foundation first → product honesty → infrastructure resilience → signal validation → product hardening. ML is Q4+.

### Week 1 (2026-06-02 → 2026-06-08) — Polish sprint + CF-PSA-CERT design

**Bundle the cheap fixes; start the big one.**

- **CF-PLAYERNAME-CANONICALIZATION** (~2-4h after Phase 1 scoping) — surfaced 2026-05-28 during the CF-PLAYERTRENDS-QUERY-FAILURE investigation as the **actual** bug behind the morning's "silent nulls on DailyIQ" symptom framing. `getPlayerScoreByName("Bobby Witt Jr.")` returns null because the stored canonical form is `"Bobby Witt Jr"` (no trailing period); the `WHERE LOWER(c["playerName"]) = @name` comparison misses on punctuation differences between callers and storage. Phase 1 read-only investigation (~1h) characterizes the full mismatch surface (period suffixes, accented characters like Acuña / Peña — show-relevant, apostrophes, hyphens, "III" / "Sr." / initials) and decides reuse-vs-new normalization. Existing `normalizePlayerName` helper referenced in prior sessions; check why it isn't applied at the query boundary. Phase 2 fix (~1-2h) normalizes both sides of the comparison consistently. Phase 3 verification: known mismatches (Witt Jr.-with-period, accented names) now resolve + regression on correctly-formed names. HALT after Phase 1 (scope) and Phase 2/3 (diff) before deploy.
- ~~**CF-PLAYERTRENDS-QUERY-FAILURE**~~ — **RETIRED 2026-05-28**: investigated → classified A (benign SDK chatter, zero data loss). Container is single-partition; completeness check across 8 known players × 2 passes shows all data reachable deterministically. The 32% dependency-row 400 rate is normal Cosmos SDK protocol chatter, not a user-impacting defect. Instrumentation (`aa61097`) stays in production through CF-PLAYERNAME-CANONICALIZATION's verification (the success/fail event logging confirms the canonicalization fix); remove in a cleanup commit after that. The real symptom-of-concern (silent nulls on DailyIQ) is taken up by CF-PLAYERNAME-CANONICALIZATION above.
- **CF-VARIANT-MISMATCH-PRICESOURCE-PARITY** (~1h) — variant-mismatch return path at `compiqEstimate.service.ts:1860-1892` needs to surface priceSource/priceSourceInternal/filteredCount/unifiedCount so iOS + sweeps can distinguish failure modes from successful pricing.
- **CF-PSA-CERT-RESOLUTION-PIPELINE — design phase** — surface design questions before any code: (a) when does iOS read the cert? (manual entry in AddCardView, OCR from PSA slab label, both?) (b) what's the canonical metadata write contract? (overwrite playerName / product / variety / year / cardNumber on PSA success?) (c) backfill semantics for existing 23-holding cohort (run cert lookup for every PSA-graded holding with a non-null cert and propose updates in a HALT-for-review report) (d) failure modes (PSA quota exceeded, cert not found, ambiguous between PSA cert and DNA cert).

**Milestone:** polish sprint shipped + CF-PSA-CERT design HALT for Drew review.

### Weeks 2-3 (2026-06-09 → 2026-06-22) — CF-PSA-CERT-RESOLUTION-PIPELINE implementation

**Data-quality foundation. This is the root fix for the data-contamination class that has been resurfacing every session.**

- **Week 2: Backend implementation** — extend AddCardView flow to call `/api/psa/cert/:certNumber` when user enters a PSA cert, populate canonical metadata fields from response, store cert number on the holding as a new schema field. Map PSA response variety → canonical parallel name (dictionary lookup with fallback to raw text).
- **Week 3: iOS scan-flow wiring + backfill** — iOS hook into card-scan or manual-entry, surface confirmation dialog with PSA-returned metadata before commit, allow user override. One-shot backfill script (similar to `486775b`'s Maddux data correction): iterate PSA-graded holdings, call cert lookup, propose updates, HALT-for-review before any write.

**Milestone:** every PSA-graded holding has authoritative metadata; data-contamination class is closed at source.

### Week 4 (2026-06-23 → 2026-06-29) — CF-CATALOG-GAP-PRICING-HONESTY

**Be honest about un-priceable cards. Trout WMB / John Gil class.**

- Backend response shape: surface a new field signaling pricing confidence tier (e.g., `pricingTier: "direct-graded" | "raw-multiplier" | "sibling-pool" | "variant-mismatch"`). Map from existing priceSource/source values.
- iOS surface: add "limited data — approximate" or "approximate" chip on holdings where the pricing tier isn't `direct-graded`. Render alongside FMV with muted styling.
- Audit pass: sweep all 12 graded holdings + 5 raw holdings via `graded-holdings-sweep.cjs`; verify the tier classification matches reality.

**Milestone:** product honesty about catalog-gap cards. Trout WMB shows "approximate" rather than a confident $382.50.

### Weeks 5-6 (2026-06-30 → 2026-07-13) — Phase 3 CH decommission

**The narrow, real work: picker migration. Everything else is dead-code cleanup.**

- **Week 5: CF-PICKER-MIGRATE-TO-CARDSIGHT** — design + implementation. Resolve variant-disambiguation, autograph-detection, image_url normalization, and iOS-contract preservation per the existing CF design notes in `SESSION_HANDOFF.md`. Backend: replace `searchCards` calls in `compiq.routes.ts:6` and `:753` with `searchCatalog` equivalents. iOS: validate the picker UI flow against new response shape.
- **Week 6: CH dead-code removal** — delete `cardhedge.client.ts`, remove `off`/`shadow`/`primary` mode branches from `cardsight.router.ts` (kept exclusive-only), remove `CARD_HEDGE_API_KEY` and related env vars from App Service, scrub `copilot-instructions.md` references, disable `fn-cardhedge-comps` per the Linux Consumption SKU workaround documented in Phase 0. Decide `cardHedgeCardId` schema column rename vs naming-debt accept.

**Milestone:** Phase 3 fully closed. CH out of active code paths. Documented architecture matches deployed reality.

### Weeks 7-9 (2026-07-14 → 2026-08-03) — Phase 4a MCP cache layer

**Production resilience. The 'first deploy silently failed to rsync dist' incident this session is a small-radius version of the bigger risk: Cardsight outage = full prediction outage today.**

Original roadmap budgeted Weeks 5-6 (2 weeks). Honest estimate based on existing in-process cache + the actual operational requirements: **3 weeks**.

- **Week 7: Design + implementation Pt 1** — decision: in-process cache layer extension vs separate MCP service. Lean: in-process extension (existing `cacheWrap` is already there; the work is adding player-slug-keyed reads + cache-miss telemetry + stale-flag fallback). Blob storage decision: reuse existing 14-function blob pipeline or build new namespace.
- **Week 8: Implementation Pt 2 + invalidation** — cache reader by player-slug, TTL respect, miss → live Cardsight call → write to cache. Signal pipeline triggers re-fetch on >5% predicted-price move; otherwise nightly refresh. Stale-flag in response when Cardsight down + cache stale (never serve nothing).
- **Week 9: Observability + deploy + bake-in** — cache hit rate dashboard in App Insights. Decision on cache-hit telemetry pollution (add `cache_hit: boolean` to comp_logs vs move writer outside cacheWrap). Production deploy. Monitor cache hit rate trajectory (target: >80% within 1 week).

**Milestone:** Cardsight outage no longer = full outage. p95 prediction latency drops materially.

### Weeks 10-11 (2026-08-04 → 2026-08-17) — Phase 4b signal validation

**Finish the unfinished foundation. The signal pipeline collects; whether it influences predictions correctly is the open question.**

- **Week 10: Backtest re-run + A/B harness** — Phase 4b backtest methodology was in flight per addendum (CF-BACKTEST-REPEATS, CF-BACKTEST-DETERMINISTIC). Re-run with current code state. Capture per-signal MAPE contribution. Determine if signal-on predictions outperform signal-off on accuracy.
- **Week 11: A/B run + interpretation** — 7-day production A/B (50% traffic gets full signal blend, 50% gets compsMomentum-only). Statistical significance gate. Decision on per-signal weight adjustments. Capture findings.

**Milestone:** signals demonstrably influence predictions, weights calibrated against measured contribution, or honest "signals don't move predictions enough to justify the cost" finding with retirement decisions per project memory `compsmomentum_weight_lock`.

### Weeks 12-13 (2026-08-18 → 2026-08-31) — Product hardening sprint

**The work that's been deferred while shipping features. Audit, calibrate, surface.**

- **Week 12: comp_logs audit + data-quality scorecards** — what's the real schema completeness (cardId null, parallel literal-only, schema gaps from SOAK_LOG)? Build a dashboard showing the row-count growth trajectory + per-field completeness. This is the data substrate for any future ML — if it's polluted now, ML can't help.
- **Week 13: Prediction confidence calibration + grade-wiring audit re-run** — compare `predictedPrice` to actual ledger sales prices (where available). Are bounded multipliers actually predictive? Run `graded-holdings-sweep.cjs` again post-debt-cleanup. Surface mismatches as CFs.

**Milestone:** the product is calibrated, the data substrate is measured, the audit harness is institutionalized as a periodic check.

### Week 14 (2026-09-01 → 2026-09-07) — Q3 closeout + Q4 ML prep

**Honest milestone landing. Not "ML moat realized" (the original mid-Sep target). Replaced with:**

- Q3 deliverable: **product hardened, data-quality root-fix landed, signal validation complete, infrastructure debt down to manageable backlog.**
- Q4 ML prep: assess `comp_logs` row count + outcome-tracking gap. Decide whether Phase 4c training pipeline can kick off Oct 1 with extant data + outcome-via-ledger, or whether it needs eBay-scraping outcome expansion (multi-week project) as a prerequisite.

**Milestone:** Q3 closeout retrospective + Q4 ML kickoff plan committed to roadmap.

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
| Weeks 4-6 (Jul) | CF-PSA-CERT iOS scan flow (Week 3 backend prerequisite), CF-CATALOG-GAP-PRICING-HONESTY iOS surface, picker migration iOS validation |
| Weeks 7-10 (Jul-Aug) | iOS Double? branch (`ios-grade-canonical-WIP-windows / 57ab110`) Mac compile + ship, CF-IOS-FIELD-CONTRACT-FIX (now substantially closed by PSA cert pipeline) |
| Weeks 11-14 (Aug-Sep) | CF-DAILYIQ-MOVEMENT-INTEGRATION, CF-DUAL-CACHE-UNIFY, CF-PORTFOLIO-MOVEMENT-HISTORY |

iOS Phase 5 device verification (pending per `7f758cd` handoff) is operator-task-list, not roadmap-tracked.

---

## Q3 acceptance criteria (replaces original "End of July CompIQ formalization + Mid-September ML moat realized")

### End of Q3 2026 (2026-09-30)

- ✅ Data-quality root fix shipped (PSA cert pipeline live, backfill complete)
- ✅ Catalog-gap pricing honesty surfaced (iOS chips, confidence tiers in response)
- ✅ Phase 3 CH decommission complete (picker migrated, dead code removed)
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

---

## Risk register (refreshed)

**Carry-forward from original roadmap (still active):**

1. **Cardsight coverage gap** (Risk 1 original) — still active. Mitigated by CF-CATALOG-GAP-PRICING-HONESTY in Week 4 (honest "approximate" labels rather than coverage improvement).
2. **MCP layer bigger than estimated** (Risk 2 original) — re-estimated 2 → 3 weeks honestly. Still a risk if invalidation logic surfaces design questions.
3. **Sparse outcome data limits ML quality** (Risk 3 original) — now a Q4 risk, not Q3. Data-sufficiency gate at end of Phase 4c explicitly addresses this.
4. **Production ML incident** (Risk 7 original) — Q4+ concern. Phase 4d rollback infrastructure remains in scope.
5. **Observability layer partial restoration emission gap** (Risk 8 original) — still active. Address opportunistically in product hardening sprint (Week 12 comp_logs audit).
6. **Compaction summary fabrication pattern** (Risk 11 original) — discipline pattern from `copilot-instructions.md`. Carried forward.

**New risks surfaced 2026-05-28:**

7. **Strategic frame reframe ("PROVISIONAL Answer B") gets locked in by accumulation rather than deliberate decision.** Mitigation: Drew schedules a fresh-session moat-narrative confirmation explicitly. Don't let "we're shipping Answer B's work" become "Answer B is locked" without a deliberate check.
8. **iOS scan-flow PSA cert integration surfaces unforeseen UX issues.** Mitigation: Week 1 design phase HALT for Drew review before Weeks 2-3 implementation. Capture failure modes (cert not found, ambiguous, quota exceeded) before code.
9. **Picker migration (Week 5) reveals Cardsight searchCatalog can't match CH searchCards on variant-disambiguation.** Mitigation: Week 5 is design + implementation, so design HALT before deletion in Week 6.
10. **Phase 4a MCP cache implementation surfaces blob-storage namespace + cache-invalidation design depth.** Mitigation: 3-week budget (vs original 2), Week 7 is design + Pt 1 to surface depth early.
11. **Q3 calendar slip if any 2 weeks slip.** Mitigation: Week 14 is closeout buffer. If Weeks 1-13 land on time, Week 14 closes Q3; if any 2 weeks slipped, Week 14 absorbs the slip and Q3 milestone shifts to end-of-October.

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
