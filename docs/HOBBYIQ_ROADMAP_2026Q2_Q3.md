# HobbyIQ Roadmap — 2026 Q2 → Q3

**Drafted:** 2026-05-21
**Target horizons:** End of July 2026 (CompIQ formalization + ERP) → Mid-September 2026 (ML moat realized)
**Status:** Active plan
**Owner:** Drew

## Strategic context

HobbyIQ is two products fused: a forward-looking card pricing engine (CompIQ) and an ERP-grade portfolio system. Each has independent value; together they're the moat. This roadmap commits to the full path: removing the legacy Card Hedge dependency, completing the half-built MCP cache architecture, wiring social/news/stats signals into live pricing, building the ML training pipeline on HobbyIQ's own prediction-vs-outcome data, deploying the trained model into production traffic, and integrating pricing intelligence into the portfolio surface.

The ML moat is the strategic endpoint: every other card pricing tool can buy access to the same eBay sold data, but only HobbyIQ has its own prediction history paired with actual outcomes. Once the trained model is serving production traffic and the outcome feedback loop is closed, the moat is realized.

This document is canonical. Updates committed here as diffs, not absorbed into session handoffs.

## The problems being solved

**1. Silent prediction regression.** `getCardSalesRouted()` in exclusive mode returns `[]` for cardhedge-namespace IDs at two production call sites (sibling pools L629, pinned-ID path L710 in compiqEstimate.service.ts). Live since CARDSIGHT_MODE flipped to exclusive. Severity unknown until Phase 0 measurement.

**2. Card Hedge dependency.** CH is paid external API documented as primary data source. Cardsight is strategic replacement. Migration partial today: `/api/compiq/price` free-text uses Cardsight; `/api/compiq/search-list` and `/api/compiq/price-by-id` bypass router and call CH live; nightly ingestion still writes CH data with no production consumer.

**3. Documented architecture doesn't match deployed reality.** `copilot-instructions.md` describes MCP-mediated pipeline reading cached comps from blob, rule "never call live at prediction time." Actual code calls Cardsight and Card Hedge live at every prediction. 14 Azure Functions writing nightly to blob have no production backend consumer. Signal pipeline is dead-output relative to live pricing.

**4. CompIQ not formalized for ML.** comp_logs accumulating. Backtest harness exists. Alpha-weight ramp infrastructure exists. Training pipeline, model itself, and production serving infrastructure unbuilt. Strategic moat depends on closing this gap.

**5. ERP-grade portfolio incomplete.** PR D.6 shipped eBay ITEM_SOLD ledger integration with NULL fee fields awaiting Finances API enrichment. Reconciliation UX, tax export, P&L by category, pricing-driven recommendations — all pending.

**6. Pricing × Portfolio intersection unbuilt.** Pricing predictions don't surface into portfolio views. Sales data doesn't feed back into pricing model. Each side reinforces the other only after this integration ships.

## Phasing

### Phase 0 — Measure (Week 1: May 22-28)

**Read-only. Foundation for every later decision.**

- App Insights query: count of `primary_mode_cardhedge_namespace_only` warn logs over 30 days (regression severity)
- App Insights query: count of cardhedger.com calls over 30 days (cost + traffic baseline)
- App Insights query: p50/p95 latency on `/api/compiq/price` and `/api/compiq/search-list`
- App Insights query: success rate on prediction endpoints
- Blob inventory: confirm fn-* signal functions writing expected data
- MCP repo discovery: search GitHub, local disk, history for any MCP-mediated pricing code outside deployed backend
- Cardsight coverage spot-check: top 100 most-predicted cards from comp_logs, verify Cardsight has acceptable-quality data for each
- Card Hedge subscription: check renewal date, plan cancellation timing
- Deploy-script ErrorActionPreference fix (ships during Phase 0)

**Phase 0 success criteria:**
- Silent regression severity quantified (warn-log rate per day)
- Card Hedge call volume + cost quantified
- Cardsight coverage gap on top 100 cards identified
- MCP repo found OR confirmed to need building
- Deploy-script bug resolved

**Phase 0 exit gate:** if Cardsight coverage gap on top 100 cards is >10%, plan re-evaluates before Phase 1. Do not proceed to CH removal with known coverage gap.

### Phase 1 — Stop the bleeding (Week 2: May 29-Jun 4)

**Fix silent regression. Do not start larger migration yet.**

- Build CH-namespace → Cardsight ID mapper. Input: cardhedge cardId. Output: cardsight cardId via catalog lookup.
- Wire mapper into `getCardSalesRouted()` cardhedge-namespace path: instead of returning `[]` in exclusive mode, resolve through mapper and call Cardsight with translated ID
- Update L629 (sibling pools) and L710 (pinned-ID path) in compiqEstimate.service.ts to use new flow
- Verification: warn-log rate for `primary_mode_cardhedge_namespace_only` drops to zero in production
- Verification: prediction success rate does not regress vs Phase 0 baseline

**Phase 1 success criteria:**
- Zero `primary_mode_cardhedge_namespace_only` warn logs in 24h post-deploy
- Prediction success rate equal or better than Phase 0 baseline
- Sibling pool and pinned-ID predictions returning non-empty comp data

### Phase 2 — Replace router bypasses (Week 3: Jun 5-11)

**Make router authoritative for all CH calls.**

- compiq.routes.ts L240 `/search-list`: replace direct `searchCards()` import with `searchCardsRouted()`
- compiq.routes.ts L675, L678 `/price-by-id`: replace direct `searchCards()` calls with `searchCardsRouted()`
- Each replacement is its own small PR with verification gate
- Update tests to expect routed path

**Phase 2 success criteria:**
- No direct imports of cardhedge.client functions from route files
- All searches route through cardsight.router
- Endpoint success rates unchanged from Phase 1 baseline

### Phase 3 — Decommission Card Hedge (Week 4: Jun 12-18)

**Card Hedge removed from production.**

- Disable `fn-cardhedge-comps` schedule (Azure Portal)
- Verify no consumers of fn-cardhedge-comps blob output for 7 days
- Delete `services/compiq/cardhedge.client.ts`
- Delete dead exports: `findCompsByQuery`, `getCardSales`, `fetchSiblingParallelComps` references
- Remove `CARD_HEDGE_API_KEY` and legacy CH env vars from App Settings
- Cancel Card Hedge subscription (business action)
- Update copilot-instructions.md to remove Card Hedge references
- Naming-debt decision: rename `cardHedgeCardId` to `cardId` in corpus schema (data migration) OR accept as permanent column name

**Phase 3 success criteria:**
- Zero references to Card Hedge in active code paths
- Card Hedge API key revoked
- Card Hedge subscription canceled
- Documented architecture matches deployed reality

### Phase 4a — MCP-mediated cache layer (Weeks 5-6: Jun 19-Jul 2)

**Complete the half-built infrastructure. Live prediction calls become cache reads.**

- Decision in Week 5: MCP-as-separate-service vs in-process cache layer. Lean: in-process unless Phase 0 found existing MCP repo
- Implement cache reader: blob read by player-slug key, TTL respect, miss → live Cardsight call → write to cache
- Cache miss telemetry: log every miss, dashboard for hit rate
- Fallback semantics: if Cardsight down AND cache stale, return stale data with `freshness: "stale"` flag, never serve nothing
- Cache invalidation: signal pipeline triggers re-fetch on >5% predicted-price-move; otherwise nightly refresh
- Observability: cache hit rate dashboard in App Insights

**4a success criteria:**
- Cache hit rate >80% within 1 week of deploy
- p95 prediction latency drops by >50% vs Phase 0 baseline
- Zero prediction calls direct to Cardsight when cache warm

### Phase 4b — Signal integration (Week 7: Jul 3-9)

**Signals being collected start influencing predictions. "Predictive pricing" actually becomes predictive.**

- Build signal reader for each: Reddit, Google Trends, News, YouTube, MLB Stats, Odds, eBay-signals
- Implement weighted blender. Per documented weights with redistribution (CH 0.20 weight reassigned to Cardsight comps or distributed across signals): Reddit 0.15, Trends 0.15, Odds 0.15, Stats 0.10, News 0.05, eBay 0.20, Cardsight comps 0.20
- Per-signal fallback to 1.0 multiplier on read failure (partial > none)
- Combined multiplier capped 0.70-1.50 per existing rule
- Backtest: last 30 days historical predictions with signals on vs off; measure prediction-vs-actual delta
- A/B in production: 50% traffic gets signals, 50% doesn't; compare 7-day prediction accuracy

**4b success criteria:**
- All 7 signal sources read by live prediction path
- Backtest shows signal-on predictions ≥ signal-off predictions on accuracy
- A/B test runs cleanly for 7 days with no production issues

### Phase 4c — ML training pipeline (Weeks 8-9: Jul 10-23)

**Clean Cardsight-only training data flowing. First trained model exists.**

- Build comp_logs → training-dataset pipeline: each row = (input features, predicted price, actual sale price if known)
- Backfill actual outcomes: join comp_logs predictions with PortfolioLedgerEntry sales data
- Feature engineering: signal values at prediction time, card identity (player/year/set/grade/parallel), market context (overall card market trend index)
- Azure ML AutoML first experiment: train regression model to predict 7-day price. Compare to GPT-4o reasoning baseline.
- Evaluation: out-of-sample accuracy, calibration plots, residual analysis
- Decision point end of Week 9: model results justify productionization? If yes, Phase 4d. If no, iterate feature engineering through Week 10.

**4c success criteria:**
- Training pipeline runs end-to-end on real data
- At least one trained model with documented accuracy
- Go/no-go decision made on productionization

### Phase 4d — ML serving production traffic (Weeks 10-13: Jul 24-Aug 20)

**Trained model serves real predictions. Production ML reality, not scaffolding.**

- Model serving infrastructure: Azure ML endpoint or container deployment. Auth, scaling, monitoring, cost controls.
- A/B testing harness at prediction layer: traffic-splitting, side-by-side logging of model vs GPT-4o predictions, statistical significance testing on prediction-vs-outcome deltas
- Outcome tracking pipeline expansion: actual eBay sold prices for predicted cards (not just HobbyIQ-user-sold cards). Addresses selection bias risk.
- Calibration and safety nets: out-of-distribution detection, confidence calibration verification, guardrails (no $0 or $1M predictions), bounded range enforcement
- Rollback and monitoring: alerts on prediction distribution shifts, automatic fallback to GPT-4o on model latency spike or error spike, version pinning
- Iteration cycle: train v2 with lessons from v1 A/B results. Repeat as needed.

**4d success criteria:**
- Trained model serves at least 25% of production traffic
- A/B comparison shows model-served predictions ≥ GPT-4o predictions on accuracy (statistically significant)
- Rollback path verified by tabletop exercise
- Outcome tracking pipeline running with <72h latency from sale to outcome record

### Phase 4e — ML moat realized (Weeks 14-16: Aug 21-Sep 17)

**Model serves majority of traffic. Feedback loop closed. Competitive position defensible.**

- Trained model serves 75%+ of production traffic
- GPT-4o reasoning layer remains as fallback only
- Outcome feedback loop demonstrably improves model quality over time (v3 measurably better than v1)
- Documented competitive analysis: how HobbyIQ's predictions compare to publicly available alternatives on accuracy and forward-looking value
- Proprietary outcome dataset documented as strategic asset

**4e success criteria:**
- Model serving ≥75% of production traffic
- Quarter-over-quarter prediction accuracy improvement demonstrated
- Outcome dataset size and quality documented; strategic value articulated
- Moat realized: trained model with proprietary outcome data outperforms competitive alternatives

### Phase 5 — Pricing × Portfolio integration (parallel with 4b-4d, Weeks 7-12)

**Pricing intelligence feeds the portfolio surface.**

Initial integration: **per-card movement signals on dashboard** (PR F in existing ADR sequence).

- Each PortfolioHolding gets `movementSignal` field updated nightly from CompIQ predictions
- Dashboard surfaces: top movers (up), top movers (down), sell signals (predicted_direction=falling with confidence >70), hold signals
- Drill-down: tap card → CompIQ prediction with reasoning surface
- Notification opt-in: alert when held card crosses movement threshold

Subsequent integrations (Weeks 10-12):
- Aggregate portfolio valuation tracking over time (line chart of total predicted value)
- "Best card to sell now" recommendations across user's holdings
- Tax-strategy recommendations (sell losers in December, hold winners)
- Sales data feedback loop: PortfolioLedgerEntry sales become training signals for pricing model (closes the Pricing × Portfolio circle)

**Phase 5 success criteria:**
- Movement signals shipped to dashboard, used by real users
- Aggregate valuation tracking shipped
- At least one cross-card recommendation surface shipped
- Sales data demonstrably feeds back into model training pipeline

### Phase 6 — PR E reconciliation UX (Weeks 6-8, Mac-side parallel)

**ERP-grade ledger entries become usable for tax and business reporting.**

Consumes carry-forwards #1-#4 from PR D.6 handoff:
- Granular fee fields displayed in iOS ledger view (when source="ebay" and fields populated)
- needsReconciliation=true entries surface as "needs your attention" UI
- gradingCost and suppliesCost entry forms (user-entered, persisted as immutable snapshot at recording time)
- Tax export: CSV/PDF of completed ledger entries, excluding unreconciled OR flagging them prominently
- Filter views: P&L by month, by player, by set, by grade, by source (eBay vs manual)

**Phase 6 success criteria:**
- iOS reconciliation flow ships
- Users can complete a sale entry from eBay webhook through reconciliation to tax export
- Tax export validated against a CPA-ready format (consult or use a real one)

## Parallel Mac/iOS workstream

Backend phases above are Windows-side. iOS queue runs parallel:

- **Week 1**: PR C 5-step smoke test
- **Week 2**: D.6 ITEM_SOLD happy-path verification (carry-forward #10)
- **Week 3**: D.2 OAuth smoke against sandbox
- **Weeks 4-5**: D.3 EbayListingDraftView wiring
- **Weeks 5-6**: D.4 publish/revise/end/status UI
- **Week 6**: End-to-end D.6 verification with real sandbox sale
- **Weeks 6-8**: PR E reconciliation UX (Phase 6)
- **Weeks 9-12**: Pricing→portfolio iOS surfaces (Phase 5 iOS side)
- **Weeks 13-16**: ML-prediction surfacing in iOS (when model accuracy justifies; tap-to-see-prediction-reasoning, model confidence display)
- **Throughout**: 4 known iOS bugs from Part 11, polish, performance

If solo: context-switch by day-of-week (backend Mon-Wed, iOS Thu-Fri). If outside help: backend Drew, iOS contractor/pair, parallel branches.

## Risk register

**High-impact risks:**

1. **Cardsight coverage gap (Phase 0 finding).** Mitigation: Phase 0 exit gate. If gap >10%, plan re-evaluates. Either invest in coverage improvement, accept narrow CH fallback for uncovered categories, or extend timeline.

2. **MCP layer bigger than 2 weeks.** Cache layers with proper invalidation, fallback, observability, rollback typically 4-6 weeks. Mitigation: scope cuts. If 4a slips, 4b/4c push later. Better robust cache than rushed ML.

3. **Sparse outcome data limits ML quality.** PortfolioLedgerEntry sales are a fraction of predictions made. Model trained on sales-only outcomes may be biased toward cards users decided to sell. Mitigation: Phase 4d expands outcome tracking to all predicted cards via eBay sold-price scraping; this is real engineering, not free.

4. **Model fails to beat GPT-4o.** Possible outcome. Mitigation: Phase 4c decision gate. If v1 doesn't justify productionization, iterate feature engineering or extend timeline. Don't ship a worse model just because the plan said to.

5. **Outcome tracking pipeline complexity.** Real eBay sold-price scraping for cards predicted but not user-sold is its own multi-week project. Mitigation: explicit Phase 4d scope item, not absorbed silently.

6. **iOS workstream stalls.** If solo, iOS schedule slips when backend grinding intensifies. Mitigation: confirm outside help by Week 4, or accept Phase 5/6 iOS surfaces slip into Q3.

7. **Card Hedge subscription auto-renews mid-Phase 2 or 3.** Operational. Mitigation: check renewal date in Phase 0, plan accordingly.

8. **Production ML incident.** Trained model serves bad predictions, users see them. Mitigation: Phase 4d rollback and monitoring infrastructure. Tabletop the failure modes before shipping.

**Medium-impact risks:**

- Deploy-script fix introduces new bug — mitigated by Phase 0 calm-attention timing
- PR D.6 happy-path verification reveals sync layer bug — fix takes precedence
- Azure Functions cost spikes from increased ingestion — Phase 0 baselines, alert thresholds
- Signal source rate limits hit (Reddit, Trends) — backoff and partial-data tolerance in Phase 4b

## Acceptance criteria for "done by mid-September"

End-of-July deliverables (Phases 0-4c + initial Phase 5 + Phase 6):
- ✅ Card Hedge removed from all production paths, subscription canceled
- ✅ Cardsight serves 100% of comp data
- ✅ Cache layer reduces prediction latency >50%
- ✅ All 7 signal sources wired into live pricing
- ✅ comp_logs → training pipeline runs end-to-end
- ✅ At least one trained pricing model evaluated, go/no-go decision made
- ✅ Per-card movement signals shipped to iOS dashboard
- ✅ PR E reconciliation UX shipped
- ✅ Documentation matches deployed reality

Mid-September deliverables (Phases 4d-4e + complete Phase 5):
- ✅ Trained model serves ≥75% of production traffic
- ✅ A/B testing demonstrates model > GPT-4o on accuracy
- ✅ Outcome tracking pipeline covers predictions, not just user sales
- ✅ Rollback and monitoring infrastructure verified
- ✅ Aggregate portfolio valuation tracking shipped
- ✅ Cross-card sell-recommendations shipped
- ✅ Sales data feeds back into model training (Pricing × Portfolio circle closed)
- ✅ Moat realized: documented competitive advantage based on proprietary outcome data

## Future scope — categories for post-September decision

These are NOT in the current roadmap. Captured here as questions for future-Drew to answer when this plan completes.

- **Multi-marketplace listing.** PR D was eBay-only. COMC, MySlabs, eBay alternative platforms — do we extend the listing/sync layer? What's the user demand?
- **Web companion to iOS app.** Some workflows (bulk import, reports, tax export) are better on desktop. Build a web UI?
- **Public API for third-party integrations.** Some users want HobbyIQ data in their own tools. Worth the support burden?
- **Team / multi-user accounts.** Card businesses with multiple owners or employees. Real product change, not just a feature.
- **International expansion.** Currency conversion, marketplace localization, tax framework differences. Real scope.
- **Other sports.** CARDSIGHT_MODE=exclusive is baseball today. Football, basketball, hockey, soccer expansion?
- **TCG expansion.** Pokemon, Magic, Yu-Gi-Oh have larger markets than sports cards. Different signal sources, different comp data.
- **Auction house integration.** PWCC, Goldin, Heritage. Bid tracking, win/loss outcomes feed pricing.
- **Live event integration.** The National, card shows. Geo-fenced features?
- **Vault / consignment services.** Users send cards to HobbyIQ-affiliated grading/storage?
- **Insurance integration.** Portfolio valuation feeds collectibles insurance providers.

These are questions, not commitments. Drew decides which (if any) enter a future roadmap.

## Cadence

- **Daily**: at least one HALT gate, one commit, one verification
- **Weekly**: sync this roadmap with reality. If phase slips, update timeline. If scope changes, capture here.
- **End of each phase**: explicit retro in session handoff
- **End of each month**: review risk register, adjust if reality differs from prediction

## Outside help

If Drew brings in contractor/pair-programmer:
- **Best fit**: iOS workstream weeks 4-8 (D.3, D.4, PR E reconciliation UX). Well-scoped, low context-switch.
- **Alternative**: ML scaffolding in Phase 4c-4d if Drew prefers backend ownership.
- **Less obvious fit**: outcome tracking pipeline in Phase 4d (eBay scraping, data engineering) — discrete project, clean handoff.
- **Coordination**: weekly sync, shared SESSION_HANDOFF.md and ROADMAP.md, separate branches per workstream.

## Plan evolution

This document is canonical as of 2026-05-21. Updates committed as diffs to `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md`, not absorbed into individual session handoffs. SESSION_HANDOFF.md remains "what did this session do." ROADMAP is "where are we going."

When a phase completes: update phase header with `**COMPLETE** (date, commit SHA)`. When a phase slips: update week range, brief explanation. When scope changes: update acceptance criteria.

This is the plan. Execute, measure, adjust, ship.

End of roadmap.
