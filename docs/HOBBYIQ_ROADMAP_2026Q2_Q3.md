# HobbyIQ Roadmap — 2026 Q2 → Q3

**Drafted:** 2026-05-21 (reframed 2026-05-21 PM post Phase 0)
**Target horizons:** End of July 2026 (CompIQ formalization + ERP) → Mid-September 2026 (ML moat realized — stretch, contingent on Phase 4c data sufficiency)
**Status:** Active plan
**Owner:** Drew

## Strategic context

HobbyIQ is two products fused: a forward-looking card pricing engine (CompIQ) and an ERP-grade portfolio system. Each has independent value; together they're the moat. This roadmap commits to the full path: removing the legacy Card Hedge dependency, completing the half-built MCP cache architecture, wiring social/news/stats signals into live pricing, building the ML training pipeline on HobbyIQ's own prediction-vs-outcome data, deploying the trained model into production traffic, and integrating pricing intelligence into the portfolio surface.

The ML moat is the strategic endpoint: every other card pricing tool can buy access to the same eBay sold data, but only HobbyIQ has its own prediction history paired with actual outcomes. Once the trained model is serving production traffic and the outcome feedback loop is closed, the moat is realized.

This document is canonical. Updates committed here as diffs, not absorbed into session handoffs.

**Update 2026-05-21:** Card Hedge subscription cancelled 2026-05-19. Production state characterization (Phase 0) determined CH is effectively disconnected at the router layer (`CARDSIGHT_MODE=exclusive` + Site B short-circuit returns `[]` without calling CH). Remaining CH work is cleanup, not deliberate decommissioning. Separately, the production observability layer was found to be largely unwired (comp_logs writer never shipped, compiq_corpus sampling at zero, warn-line traces at ~9% capture). PR-A1 (and PR-A1.1) restored observability before any migration code change. Cardsight is the sole comp data source going forward; coverage gap at cutover cannot be sized from existing telemetry and is accepted as post-deploy discovery.

## The problems being solved

**1. Silent prediction regression (reframed).** The router's `primary_mode_cardhedge_namespace_only` short-circuit in `CARDSIGHT_MODE=exclusive` returns `[]` for cardhedge-namespace IDs. Header comment at `cardsight.router.ts` L17-L20 explicitly states Cardsight pricing is never called for cardhedge IDs in this iteration. Severity cannot be quantified from existing telemetry (warn captured at ~9% in App Insights). Phase 1 Track B builds the migration that closes this gap.

**2. Card Hedge dependency (resolved at router; cleanup pending).** Card Hedge subscription cancelled 2026-05-19. CH is functionally disconnected at the router (`CARDSIGHT_MODE=exclusive` + Site B short-circuit returns `[]` without calling CH at prediction time). Remaining work is code/config cleanup: delete the client, remove env vars, disable the ingestion function, scrub docs.

**3. Documented architecture doesn't match deployed reality.** `copilot-instructions.md` describes MCP-mediated pipeline reading cached comps from blob, rule "never call live at prediction time." Actual code calls Cardsight live at every prediction. 14 Azure Functions writing nightly to blob have no production backend consumer. Signal pipeline is dead-output relative to live pricing. **Additionally (Phase 0 finding 2026-05-21):** `comp_logs` writer never shipped to production before PR-A1. The 5 pre-PR-A1 rows in `comp_logs` were from a one-off local seed script run 2026-05-03; no live traffic was ever recorded.

**4. CompIQ not formalized for ML.** comp_logs accumulating (as of PR-A1 / 2026-05-21T17:44:32Z writer flip). Backtest harness exists. Alpha-weight ramp infrastructure exists. Training pipeline, model itself, and production serving infrastructure unbuilt. Strategic moat depends on closing this gap.

**5. ERP-grade portfolio incomplete.** PR D.6 shipped eBay ITEM_SOLD ledger integration with NULL fee fields awaiting Finances API enrichment. Reconciliation UX, tax export, P&L by category, pricing-driven recommendations — all pending.

**6. Pricing × Portfolio intersection unbuilt.** Pricing predictions don't surface into portfolio views. Sales data doesn't feed back into pricing model. Each side reinforces the other only after this integration ships.

**7. Production observability layer largely unwired.** `comp_logs` writer not shipped pre-PR-A1; `COMPIQ_CORPUS_SAMPLE_RATE` was 0 (PR-A1 sets `COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0` via separate variable); router warn line captured at ~9% in App Insights; Cosmos `hobbyiq-comps-centralus` regional endpoint at ~21% failure rate; `cardsight.findComps.start` / `.end` `log.info` events not reaching App Service Linux Node container stdout. Phase 4c training pipeline depends on observability being functional. Phase 4a cache layer planning depends on accurate telemetry.

## Phasing

### Phase 0 — Measure — **COMPLETE 2026-05-21 (executed ahead of schedule)**

Original scope was read-only measurement Week 1 (May 22-28). Compressed into a single working session on 2026-05-21 once CH cancellation forced the timeline. Phase 0 surfaced the observability gap which required immediate (not Week 2) remediation; that remediation became Phase 1 Track A.

**Actual deliverables:**
- **PR #101** (commit `14bab24`): deploy-script `ErrorActionPreference` fix — **OPENED, NOT MERGED** (follow-up; script still aborts at [2/5] on stderr `WARNING`).
- **PR #102**: canonical `copilot-instructions.md` ported + LESSONS section + `SECRET_ROTATIONS.md` + Phase 0 audit artifacts (MERGED).
- **PR #104** (squashed into `ea0a724`): observability restore — `comp_logs` writer + telemetry helper + structured cardsight logs + 95 tests (MERGED).
- **PR #105** (squashed into `e333ae1`): `playerName`/`cardYear` schema additions plumbed end-to-end (MERGED).
- **Issue #103**: `/estimate` telemetry deferral.
- **Issue #106**: B2 cohort definition (Day-10 review).
- Storage account `stcompiqfnotgm` key1 rotated 2026-05-21.
- `COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0` set 2026-05-21T17:44:32Z (writer flip; soak start clock).

**Findings captured:** see `docs/SESSION_HANDOFF.md` Phase 0 / WORKSTREAM 4 section (Findings 1-11) and `docs/phase0/SOAK_LOG.md`.

### Phase 1 — Observability restore + Cardsight migration (May 22-Jun 4)

Two tracks. Track A unblocks every later phase by making production state observable. Track B is the original "stop the bleeding" + "replace router bypasses" work, consolidated since CH router-level disconnect made the original Phase 1/Phase 2 split unnecessary.

**Track A — Observability restore. COMPLETE via PR-A1 (`ea0a724`) + PR-A1.1 (`e333ae1`).**
10-day soak running, started 2026-05-21T17:44:32Z, Day-10 review 2026-05-31T17:44:32Z.
Known gaps carried forward:
- `cardsight.findComps.start` / `.end` stdout emission gap (environmental, not code — does not reach App Service Linux container stdout).
- Cache-hit telemetry pollution (architectural smell — writer is inside `cacheWrap`; cache hits produce extra `comp_logs` rows with ~2-3ms latency). Deferred to Phase 4a measurement-design. Filter rule for soak: `latency_ms >= 50 GROUP BY endpoint`.
- Schema gaps #1 / #2 / #4 / #5 from SOAK_LOG (cardIdSource null, cardId null, parallel literal-only, 2× row fan-out) — decisions deferred to Day-10 review and PR-A2.

**Track B — Cardsight migration (PR-A2). Post-soak, after Day-10 review.**
- Caller-side ID change at `/price-by-id` to pass Cardsight IDs (not cardhedge IDs) into the router.
- Fix the L710 try/catch hazard in `compiqEstimate.service.ts` (pinned-ID path).
- Mapper-driven Cardsight resolution for any residual cardhedge-namespace IDs in the corpus.
- Remove direct CH client calls from `compiq.routes.ts` (`/search-list` L240, `/price-by-id` L675/L678).

**Phase 1 success criteria:**
- Track A: writer flowing, soak completes without backslide, Day-10 schema-gap decisions made.
- Track B: zero `primary_mode_cardhedge_namespace_only` warns post-deploy; no direct `cardhedge.client` imports from route files; endpoint success rates unchanged.

### Phase 2 — REMOVED

Folded into Phase 1 Track B. The original Phase 2 ("replace router bypasses") and Phase 1 ("stop the bleeding via mapper") collapsed once CH was confirmed disconnected at the router — the work is one coherent PR-A2 surface, not two phases.

### Phase 3 — CH cleanup (half-day, single PR; timing after Phase 1 Track B)

Card Hedge already cancelled (2026-05-19) and router-disconnected (Phase 0 finding). Phase 3 is now pure code/config cleanup, not decommissioning.

**Scope:**
- Delete `services/compiq/cardhedge.client.ts`.
- Remove `CARD_HEDGE_API_KEY` and other CH-* env vars from App Service settings.
- Disable `fn-cardhedge-comps` via `function.json` (runtime app-setting disable blocked on this Linux Consumption SKU per Phase 0 finding).
- Update `copilot-instructions.md` to remove CH references.
- Remove vestigial `CARD_HEDGE_API_KEY` guard at `compiqEstimate.service.ts` L700-704.
- Decide `cardHedgeCardId` schema column rename vs naming debt (data migration cost vs permanent column name).

**Estimated:** half-day of work, single PR.

**Phase 3 success criteria:**
- Zero references to Card Hedge in active code paths.
- Documented architecture matches deployed reality.

### Phase 4a — MCP-mediated cache layer (Weeks 5-6: Jun 19-Jul 2)

**Complete the half-built infrastructure. Live prediction calls become cache reads.**

**Framing update 2026-05-21:** Cardsight is now the sole comp data source. The cache layer is resilience-critical, not just a latency optimization — a Cardsight outage with no cache is a full prediction outage. **Phase 4a urgency increased.**

- Decision in Week 5: MCP-as-separate-service vs in-process cache layer. Lean: in-process unless Phase 0 found existing MCP repo
- Implement cache reader: blob read by player-slug key, TTL respect, miss → live Cardsight call → write to cache
- Cache miss telemetry: log every miss, dashboard for hit rate
- Fallback semantics: if Cardsight down AND cache stale, return stale data with `freshness: "stale"` flag, never serve nothing
- Cache invalidation: signal pipeline triggers re-fetch on >5% predicted-price-move; otherwise nightly refresh
- Observability: cache hit rate dashboard in App Insights
- **Cache-hit telemetry pollution (carried over from Phase 1 Track A):** decide between adding a `cache_hit: boolean` field to `comp_logs` schema (preferred — preserves cache-effectiveness observability) vs moving the writer outside `cacheWrap` (loses cache-hit visibility). This decision belongs to Phase 4a measurement-design, not Phase 1.

**4a success criteria:**
- Cache hit rate >80% within 1 week of deploy
- p95 prediction latency drops by >50% vs Day-10 baseline (2026-05-31 post-PR-A1 + PR-A1.1, includes existing in-process cacheWrap). **Baseline note (2026-05-21 PM):** Phase 0 latency baseline is not recoverable — requests-table auto-instrumentation was unwired pre-PR-A1; only ~1 hour of usable post-PR-A1 data exists at the time of this edit. Realistic baseline is Day-10.
- Zero prediction calls direct to Cardsight when cache warm

### Phase 4b — Signal integration (Week 7: Jul 3-9)

**Signals being collected start influencing predictions. "Predictive pricing" actually becomes predictive.**

- Build signal reader for each: Reddit, Google Trends, News, YouTube, MLB Stats, Odds, eBay-signals
- Implement weighted blender. CH weight already gone post Phase 3 cleanup; redistribute its former 0.20 across remaining signals (lean: Cardsight comps absorb, since CH was the sold-data peer): Reddit 0.15, Trends 0.15, Odds 0.15, Stats 0.10, News 0.05, eBay 0.20, Cardsight comps 0.20
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

**Reality check 2026-05-21:** at `COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0` and current traffic (~1660 `/price-by-id` calls/month), `comp_logs` accumulates ~1660 rows/month. ML training requires substantially more data than this produces in a single month. Phase 4c may need to defer model training until either (a) traffic grows, (b) historical backfill is sourced, or (c) timeline accepts the data accumulation rate. **Decision gate at end of Phase 4c:** based on accumulated row count, decide whether Phase 4d ships with current data or extends Phase 4c.

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

**Timeline caveat 2026-05-21:** Phase 4d start is contingent on the Phase 4c data-sufficiency decision gate. If accumulated row count at end of Phase 4c is insufficient, Phase 4d slips until data sufficiency is met.

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

**Stretch target 2026-05-21:** mid-September moat realization is now a **stretch target contingent on Phase 4c data sufficiency.** If Phase 4c slips due to data accumulation rate, Phase 4e slips proportionally.

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

7. **Production ML incident.** Trained model serves bad predictions, users see them. Mitigation: Phase 4d rollback and monitoring infrastructure. Tabletop the failure modes before shipping.

8. **Observability layer partially restored, emission gap remains.** Production observability layer was largely unwired through Phase 0; partial restoration via PR-A1 + PR-A1.1 with a known emission gap on `cardsight.findComps.start` / `.end`. Future sessions must verify telemetry is flowing before assuming any production state from logs/metrics.

9. **Phase 4c training data accumulation rate is bounded by current traffic volume.** At `COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0` and ~1660 calls/month, ML moat realization timeline depends on traffic growth, backfill, or timeline extension. Mitigation: explicit decision gate at end of Phase 4c.

10. **Cosmos `hobbyiq-comps-centralus` endpoint at ~21% failure rate** (Phase 0 finding 2026-05-21). Root cause uninvestigated; affects all containers including `comp_logs` and `webhook_events`. Mitigation: investigate before Phase 4a cache layer ships.

11. **Compaction summary fabrication pattern observed 2026-05-21.** Captured in `copilot-instructions.md` LESSONS FROM PRIOR SESSIONS section. Mitigation: grep transcript before propagating summary claims that drive plan decisions.

12. **Deploy pipeline has at least three known failure modes that verification gates do not catch.** (1) PR #101 EAP fix unmerged so script aborts at [2/5] on stderr `WARNING`; (2) stale `deploy.zip` can ship if not rebuilt before each deploy (`GIT_SHA` env var set independently of zip contents, `/api/health` SHA verification insufficient); (3) function-level disable via runtime app-setting blocked on Linux Consumption SKU. Mitigation: deploy pipeline reliability audit pending; for now, use second-axis verification (schema field presence) when deploying code changes.

**Medium-impact risks:**

- Deploy-script fix introduces new bug — mitigated by Phase 0 calm-attention timing
- PR D.6 happy-path verification reveals sync layer bug — fix takes precedence
- Azure Functions cost spikes from increased ingestion — Phase 0 baselines, alert thresholds
- Signal source rate limits hit (Reddit, Trends) — backoff and partial-data tolerance in Phase 4b

## Acceptance criteria for "done by mid-September"

End-of-July deliverables (Phases 0-4c + initial Phase 5 + Phase 6), observability-first ordering:
- ✅ Production observability layer wired and verified (Phase 1 Track A — DONE 2026-05-21 modulo known emission gap)
- ✅ comp_logs writer flowing at sample rate 1.0; soak completed; Day-10 schema-gap decisions made
- ✅ Documentation matches deployed reality
- ✅ Card Hedge code/config cleaned up (Phase 3); subscription already canceled 2026-05-19
- ✅ Cardsight serves 100% of comp data (router migration via Phase 1 Track B / PR-A2)
- ✅ Cache layer reduces prediction latency >50% vs Day-10 baseline AND provides Cardsight-outage resilience
- ✅ All 7 signal sources wired into live pricing
- ✅ comp_logs → training pipeline runs end-to-end
- ✅ At least one trained pricing model evaluated, go/no-go decision made
- ✅ Per-card movement signals shipped to iOS dashboard
- ✅ PR E reconciliation UX shipped

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
