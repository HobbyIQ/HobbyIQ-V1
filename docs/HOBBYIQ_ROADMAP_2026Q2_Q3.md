# HobbyIQ Roadmap — 2026 Q2 → Q3

> **⚠ SUPERSEDED 2026-05-28** — Active plan moved to [`HOBBYIQ_ROADMAP_2026-05-28.md`](HOBBYIQ_ROADMAP_2026-05-28.md). Historical bridge in [`ROADMAP_RECONCILIATION_2026-05-28.md`](ROADMAP_RECONCILIATION_2026-05-28.md). Strategic frame shifted to "PROVISIONAL Answer B" (shipped product as moat, ML sequenced Q4-2026 → Q1-2027 as optimization layer, NOT critical path). Mid-September ML-moat target is no longer applicable. This document remains as historical context and is the input to the reconciliation; do NOT plan against it.

**Drafted:** 2026-05-21 (reframed 2026-05-21 PM post Phase 0)
**Target horizons:** End of July 2026 (CompIQ formalization + ERP) → Mid-September 2026 (ML moat realized — stretch, contingent on Phase 4c data sufficiency)
**Status:** SUPERSEDED 2026-05-28 — see refresh
**Owner:** Drew

## Strategic context

HobbyIQ is two products fused: a forward-looking card pricing engine (CompIQ) and an ERP-grade portfolio system. Each has independent value; together they're the moat. This roadmap commits to the full path: removing the legacy Card Hedge dependency, completing the half-built MCP cache architecture, wiring social/news/stats signals into live pricing, building the ML training pipeline on HobbyIQ's own prediction-vs-outcome data, deploying the trained model into production traffic, and integrating pricing intelligence into the portfolio surface.

The ML moat is the strategic endpoint: every other card pricing tool can buy access to the same eBay sold data, but only HobbyIQ has its own prediction history paired with actual outcomes. Once the trained model is serving production traffic and the outcome feedback loop is closed, the moat is realized.

This document is canonical. Updates committed here as diffs, not absorbed into session handoffs.

**Update 2026-05-21:** Card Hedge subscription cancelled 2026-05-19. Production state characterization (Phase 0) determined CH is effectively disconnected at the router layer (`CARDSIGHT_MODE=exclusive` + Site B short-circuit returns `[]` without calling CH). Remaining CH work is cleanup, not deliberate decommissioning. Separately, the production observability layer was found to be largely unwired (comp_logs writer never shipped, compiq_corpus sampling at zero, warn-line traces at ~9% capture). PR-A1 (and PR-A1.1) restored observability before any migration code change. Cardsight is the sole comp data source going forward; coverage gap at cutover cannot be sized from existing telemetry and is accepted as post-deploy discovery.

## North star: the standard for sports-card pricing

**The goal.** HobbyIQ becomes the source the hobby trusts to answer "what is this card worth" — every card, every grade, every parallel. Not one pricing app among many: the reference, the way Kelley Blue Book is the reference for cars.

**What "the standard" requires.** Authority in pricing is trust, and trust is two things: the numbers are accurate, and the source is honest about its own confidence. The standard-setters earn it by tracking real transactions and showing a band instead of false-precision points. Pretenders lose it the first time a guess presented as a fact gets caught. Coverage — a number for everything — confers nothing on its own. Coverage *with honesty about which numbers are observed and which are estimated* is what confers authority.

**The precondition: the observation/estimate firewall.** Every number HobbyIQ shows is one of three kinds, and they never blur:
- **Observed** — real market sales (Cardsight comps, user eBay sales). Authoritative, trainable, shown as fact.
- **Estimated** — model predictions where observations are thin: forward next-sale projection (time axis), graded-price projection (grade axis). Shown only as clearly-labeled estimates with a basis and a range; FMV-null; never written to the training corpus.
- **Personal** — a user's own cost basis. Shown as cost basis only; never a market price, never a comp.

This firewall is the precondition for the ambition, not a constraint on it. The day HobbyIQ is the standard, every number must survive an audit. Letting an estimate or a purchase price masquerade as an observed comp — or training the model on its own guesses — is the fastest disqualifier. One caught bluff taints the real data with it.

**Honest gaps are a feature.** "No graded sales yet — estimated from base-card premiums, low confidence" earns more credibility than a confident fake. Showing the gap clearly is differentiation no competitor offers.

**Two pillars of the path:**

1. **Estimate coverage, honestly.** Fill the gaps observations leave with labeled estimates.
   - *Time axis* — forward next-sale projection (shipped): anchor + dampened trend, FMV-null, basis-labeled.
   - *Grade axis* — graded-price estimator (to spec): predict PSA/BGS/SGC values from the raw anchor via a hierarchical multiplier (card-specific raw→graded ratio if available; else player/set level; else market grade-premium table). Labeled estimate, range, FMV-null, display-not-train. Doubles as a "should I grade this?" signal and a portfolio recommendation hook.
   - Honest "insufficient data" states wherever neither an observation nor a defensible estimate exists.

2. **The outcome loop — the actual crown.** Estimate, let the market resolve, score the estimate against the real outcome, recalibrate. Only HobbyIQ holds its own prediction history paired with actual sales. This is the moat realized — the thing no competitor can copy, and what turns "a pricing tool" into "the pricing standard." Mechanically: Phases 4c–4e (ML pipeline + outcome tracking) and the Phase 5 sales feedback loop.

**This reframes, it does not rescope.** The moat phases already in this roadmap (4c, 4d, 4e, 5) ARE this path. This section names the destination they lead to and the trust principle governing every number along the way.

**Anti-goals (what forfeits the standard):**
- Presenting an estimate or a cost basis as an observed comp.
- Writing predicted or paid values into the training corpus.
- A confident number on a card with no data and no confidence signal.

**Near-term captured items:**
- Graded-price estimator (grade-axis estimate engine) — feature build + honest-labeling plumbing; slots alongside the predictive-pricing work. To be specced.
- Add-to-inventory CTA from the priced-card view — small portfolio feature; the resulting user *sales* (not acquisition costs) feed the Phase 5 outcome loop.

## The problems being solved

**1. Silent prediction regression (reframed).** **RESOLVED 2026-06-01.** Warn `primary_mode_cardhedge_namespace_only` removed by CF-CARDHEDGE-HARD-CUTOVER (`10ad39d`, 2026-05-29) plus the antecedent CF-PRICE-BY-ID-MIGRATION (`5640084`). Step-0 verification on 2026-06-01: 0 warns over last 7d, 0 warns over last 30d; warn-emit string grep-zero in `backend/src/`; `getCardSalesRouted` is a 21-line Cardsight-only passthrough with no namespace discriminant and no `[]` short-circuit; the pinned-cardId path at `compiqEstimate.service.ts` now calls `getPricing()` directly. The bug's prerequisite (`cardhedge.client.ts`) was deleted by `10ad39d`. *(Historical for reference:* the router's `primary_mode_cardhedge_namespace_only` short-circuit in `CARDSIGHT_MODE=exclusive` returned `[]` for cardhedge-namespace IDs. Header comment at `cardsight.router.ts` L17-L20 explicitly stated Cardsight pricing was never called for cardhedge IDs in that iteration. Severity could not be quantified from existing telemetry (warn captured at ~9% in App Insights). Phase 1 Track B was scoped to close this gap; structurally eliminated ahead of schedule by the hard cutover.*)

**2. Card Hedge dependency (resolved at router; cleanup pending).** Card Hedge subscription cancelled 2026-05-19. CH is functionally disconnected at the router (`CARDSIGHT_MODE=exclusive` + Site B short-circuit returns `[]` without calling CH at prediction time). Remaining work is code/config cleanup: delete the client, remove env vars, disable the ingestion function, scrub docs.

**3. Documented architecture doesn't match deployed reality.** `copilot-instructions.md` describes MCP-mediated pipeline reading cached comps from blob, rule "never call live at prediction time." **PARTIAL CORRECTION 2026-06-02:** the original "calls Cardsight live at every prediction" claim was incorrect — a Redis-backed in-process cache (`cacheWrap` at `cardsight.client.ts:388` for `getPricing`, plus catalog and detail wrappers) was already deployed; the prediction path hits cache first with 6h TTL. The cache is cardId-scoped, not player-slug-scoped as the doc suggests. The 14 Azure Functions writing nightly to blob still have no production backend consumer; signal pipeline still dead-output relative to live pricing. PHASE-4A-2.2 (2026-06-02) added resilience (stale-serve on Cardsight outage) + observability (`cache_hit` on prediction corpus + per-prefix hit-rate telemetry) on top of the existing cache. **Additionally (Phase 0 finding 2026-05-21):** `comp_logs` writer never shipped to production before PR-A1. The 5 pre-PR-A1 rows in `comp_logs` were from a one-off local seed script run 2026-05-03; no live traffic was ever recorded.

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
- Track B: zero `primary_mode_cardhedge_namespace_only` warns post-deploy; no direct `cardhedge.client` imports from route files; endpoint success rates unchanged. **MET 2026-06-01.** Verified zero warns over both 7d and 30d windows on App Insights; `cardhedge.client.ts` deleted entirely by CF-CARDHEDGE-HARD-CUTOVER (`10ad39d`), so no direct imports possible.

### Phase 2 — REMOVED

Folded into Phase 1 Track B. The original Phase 2 ("replace router bypasses") and Phase 1 ("stop the bleeding via mapper") collapsed once CH was confirmed disconnected at the router — the work is one coherent PR-A2 surface, not two phases.

### Phase 3 — CH cleanup (PARTIAL; blocked on picker migration)

**Status update 2026-05-25:** Phase 3 was over-scoped relative to what
the Cardsight migration actually shipped. The PRICING path is fully
Cardsight-exclusive (`/price`, `/price-by-id`, `/bulk` via
`computeEstimate` → `cardsight.router` exclusive branch). The PICKER
path is NOT migrated: `/api/compiq/cardsearch` and `/api/compiq/search-list`
still call `cardhedge.client.searchCards` directly to serve iOS variant-
picker and card-picker UIs. CardHedge cannot be deleted from active code
until the picker path also migrates.

CardHedge subscription cancelled 2026-05-19; production pricing path
Cardsight-disconnected since the same migration. Picker path still live
against CardHedge API (assumes API key remains live through billing
cycle).

**Blocking prerequisite:**

- **CF-PICKER-MIGRATE-TO-CARDSIGHT** (NEW, MEDIUM-HIGH, ~4-6h dedicated
  session) — migrate `/cardsearch` and `/search-list` from CardHedge's
  `searchCards` to Cardsight's `searchCatalog` equivalent. Resolve
  variant-disambiguation / autograph-detection / image_url-normalization
  / iOS-contract-preservation design questions before implementation.
  Details captured in `SESSION_HANDOFF.md` under that CF heading.

**Phase 3 deferred scope (after CF-PICKER-MIGRATE-TO-CARDSIGHT ships):**

- Delete `services/compiq/cardhedge.client.ts`.
- Delete 6 CH-specific test files (`tests/cardhedge*.test.ts`).
- Remove `CARD_HEDGE_API_KEY` and other CH-* env vars from App Service settings.
- Disable `fn-cardhedge-comps` via `function.json` (runtime app-setting disable blocked on this Linux Consumption SKU per Phase 0 finding).
- Update `copilot-instructions.md` to remove CH references.
- Optional: strip `cardsight.router.ts` non-exclusive mode branches (off/shadow/primary) — small, can bundle with this workstream.
- Decide `cardHedgeCardId` schema column rename vs naming debt (data migration cost vs permanent column name).

**Estimated (post-prerequisite):** ~1-2 hours actual deletion work,
single PR. Originally framed as "half-day"; revised down because the
prerequisite picker migration is now where the real work lives.

**Phase 3 success criteria (unchanged):**

- Zero references to Card Hedge in active code paths.
- Documented architecture matches deployed reality.

### Phase 4a — Cache hardening (reframed 2026-06-02)

**RESILIENCE + OBSERVABILITY HARDENING of the existing cache.** The pre-2.1 framing ("build the cache layer") carried a stale premise: a Redis-backed in-process cache was already deployed (cardId-scoped, not player-slug-scoped per the 2.1 investigation). **MCP-as-separate-service was rejected** in the 2.1 decision — no usable MCP repo was discovered in Phase 0, and the existing in-process cache already addressed substrate. **v1 = A+B+C SHIPPED 2026-06-02.**

**Framing update 2026-06-02:** the original "MCP-mediated cache" wording was retired. Cache substrate, key scheme, and Redis-or-memory fallback all PRE-EXISTED this phase. What was missing: stale-serve on Cardsight outage (Risk #2 mitigation), per-prediction `cache_hit` observability, and per-prefix hit-rate telemetry. Those are now shipped via PHASE-4A-2.2.

**v1 scope (A+B+C) — SHIPPED:**
- **A — STALE-SERVE FALLBACK (Risk #2 mitigation).** `cacheWrap` extended with optional `staleServeTtlSeconds`. When a cache entry exists past its `freshTtlSeconds` but inside the stale window AND the underlying fn fails (Cardsight timeout / 5xx / rate-limit), the stale entry is returned with `freshness: "stale"` rather than propagating the error. **Mandatory invariant:** stale-served responses are ALWAYS flagged; fresh responses NEVER carry "stale". Applied to `getPricing` with 24h stale window; catalog/detail can opt in later.
- **B — `cache_hit` on prediction corpus.** Purely additive boolean field on `PredictionLogDocument`. Populated at write-time from an `AsyncLocalStorage` cache-stats scope opened around `computeEstimate`'s body; every `cacheWrap` call underneath tallies into per-prediction hits/misses. `true` = all underlying Cardsight calls served from fresh cache. `false` = at least one miss or stale-serve. `null` = ctx not active (legacy emit path). §4.2/§4.3 accuracy instrument tolerates the new field unchanged.
- **C — Per-prefix hit-rate telemetry.** Module-scoped counters bucketed by `cs:pricing` / `cs:catalog` / `cs:detail`. Hourly structured `compiq_cache_hit_rate` log line for App Insights; resets after emit. Stale-served outcomes counted separately from hits + misses so the Cardsight-outage rate is visible.

**Deferred (D + E):**
- **D — Signal-driven invalidation.** Phase 4b-gated. When `compsMomentum` or another signal indicates predicted-move > X%, invalidate the affected `cs:pricing:<cardId>:*` keys. Needs the signal aggregator to be wired first (Phase 4b scope).
- **E — Pre-warm / nightly refresh.** Gated on C's measured hit-rate. If telemetry shows cold-cache misses dominate user perception, build a top-K pre-warmer. If hits already dominate (likely at single-user volume given the 6h TTL), skip until post-launch.

**Phase 4a success criteria (reframed 2026-06-02; v1 CLOSED 2026-06-02-FIX):**
- ✅ **Hit-rate measurable per prefix** — `compiq_cache_hit_rate` structured log emits hourly with per-prefix counters (shipped via Workstream C).
- ✅ **Cardsight outage → predictions serve stale, not empty** — stale-serve unit test in `cacheStaleServe.test.ts` simulates a Cardsight 503 against a warm-but-stale entry, asserts the stale value returns with `freshness: "stale"` (Workstream A; the Risk-#2 proof).
- ✅ **Cache hits no longer pollute `comp_logs` latency aggregates** — the `cache_hit` field on `prediction_log` enables filter `cache_hit = false` to isolate live-fetch latency. Soak filter `latency_ms >= 50` is no longer required as a workaround (Workstream B). **2.2-FIX (same-day correction):** cache_hit semantic corrected to null-if-no-cache-calls (case B: ctx active + 0 hits + 0 misses now returns null instead of false). Companion field `served_stale: boolean | null` added to the corpus row via a new `staleServes` counter on the AsyncLocalStorage scope — records which predictions were affected by Cardsight outages.
- 🔄 **p95 reduction target retired / re-baselined at v1 traffic** — the original ">50% vs Day-10" goal was set before the existing cache was rediscovered. Current 7d App Insights baseline: `POST /api/compiq/price-by-id` p50=1ms p95=2ms (cache-warm dominated); `POST /api/compiq/search` p50=30ms p95=1415ms p99=21075ms. Re-baseline against post-launch traffic; pre-launch volume too low for stable inference.

**v1 closed 2026-06-02-FIX:** A+B+C + corpus served_stale. Server-side Risk-#2 mitigation works (stale value returned on Cardsight outage; `cache_stale_serve` warn emitted; `served_stale=true` recorded on the prediction corpus row for post-hoc analysis). **DEFERRED, iOS-gated, named carry-forward:** cache-staleness API-output marker (the iOS "approximate — Cardsight unavailable" badge). The `freshness` symbol on `computeEstimate`'s output is already taken (market-data recency schema `{status: "Live"|"Stale"|"Needs refresh", lastUpdated}`); a new field like `cacheFreshness?: "stale"` must be threaded through 5 getPricing call sites + router result types + ~5 computeEstimate return shapes (~10-30 lines). Gated on iOS surface readiness; otherwise the signal lands server-side with no consumer.

### Phase 4b — Signal integration (Week 7: Jul 3-9)

**VERDICT 2026-06-02 (PHASE-4B-SLICE-1-PROOF): SIGNALS FIRE.** The wired-in-code path is end-to-end live and producing non-neutral multipliers in production. 12 fresh predictions across active MLB stars produced:
- 9/12 non-null composites; ALL 9 differ from 1.0; range **0.741 → 1.370 in both directions**
- 5 of 12 fetched a real Layer-1 multiplier (ok_non_neutral, 200): Trout 1.068, Skenes 1.068, Witt 1.082, Ohtani 1.067, Judge 1.026
- 4 of 12 got Layer-1 404 → coverage degraded to `card_only` → composites still non-neutral via Layer 2 (Langford 1.047, Holliday 1.28, Strider 1.205, Skubal 0.741)
- 0 timeouts / 0 fetch_errors / 0 aggregator_unavailable — the aggregator is reachable + responsive
- Aggregator freshness confirmed: `lastUpdated=2026-06-02T02:50:00Z`, ~1h before the proof window

**Critical layer-decomposition finding (drives slice 3 design):** **composite movement is dominated by `cardTrajectory` (comp velocity, 0.40-1.00 weight), not by `playerMomentum` (signal-driven, 0.20-0.30 weight in `full`/`no_segment` coverage).** Sample math from PROOF:
- Skenes composite 1.188 with `coverage=no_segment` (weights 0.30 player / 0.70 card): playerMomentum 1.068 × 0.30 + cardTrajectory ~1.24 × 0.70 → ~1.19. The player nudge contributes ~+0.020 of the +0.188 swing. The other ~+0.168 is comp velocity.
- Skubal composite 0.741 with `coverage=card_only` (weight 1.00 card): driven 100% by `cardTrajectory`, ZERO signal contribution.
- Holliday 1.28 with `coverage=card_only`: same story — Layer 2 doing all the work.

**Implication for slice 3 (recalibration):** must decompose accuracy **BY LAYER, class-matched horizon — NOT composite-on/off**. Aggregating "signal-on vs signal-off" at the composite level would attribute Layer 2 wins to Layer 1 and vice versa. Per `Signal classes: attention vs price` memory — Layer 1 single-digit nudges (1.026-1.082) are price-class-flavored (<7d horizon); Layer 2 cardTrajectory swings are also <30d sales-velocity. Slice 3 must:
1. Separate accuracy attribution: `cardTrajectory_only_predictions` vs `playerMomentum_present_predictions` vs `full_coverage_predictions`
2. Class-matched outcome horizons per layer
3. Measure whether playerMomentum's 0.20-0.30 weight EARNS the prediction-accuracy delta its presence claims

**REFRAMED 2026-06-01 after PHASE-4B-RECON:** the framing "build the blender + wire signals into predictions" is wrong. The blender exists at `backend/src/services/compiq/trendIQ.compute.ts` (8-row weight matrix, 0.70-1.50 clamp) and is wired through `compiqEstimate.service.ts:2662` (`fetchPlayerSignals` HTTP call to `fn-serve-signals`) into `forwardProjectionFactor` and finally `predictedPrice`. So signals are NOT dead-output relative to live pricing — the code path is end-to-end live.

What was actually missing was OBSERVABILITY: whether the wired-in-code path actually fires under production volume, whether the multipliers reaching predictions are non-neutral, and whether the upstream `fn-*-signals` blob writers are producing fresh data. Phase 4b becomes "measure + harden + recalibrate + repair," not "build."

**The two findings from PHASE-4B-RECON (read-only) that drove the reframe:**
1. **App Insights workspace divergence (load-bearing).** `fn-compiq` emits telemetry to its own App Insights component named `fn-compiq` (eastus-8 region; key `f7eebd2c-...`). The backend `HobbyIQ3` emits to `hobbyiq-insights` (centralus-2 region; key `02dca1c0-...`). Our 7d query "any fn-* role under hobbyiq-insights" returned 0 rows because the data lives in a different sink, NOT because the functions aren't running. This eliminates the panic interpretation. Function-side liveness still needs to be confirmed via the `fn-compiq` AI workspace OR via blob-write timestamps directly.
2. **The backend `signal_service` dependency-table 0-rows.** Could be either (a) `trackHttpDependency` auto-instrumentation gap (per Risk #8 / CF-APPINSIGHTS-FETCH-INSTRUMENTATION), or (b) `fetchPlayerSignals` actually not being called at production volume. Slice 1's `compiq_signal_fetch_observed` log resolves this without depending on the OTel pathway.

**Slice 1 — Signal observability + safe corpus capture (THIS slice, 2026-06-01, no behavior change):**
- `compiq_signal_fetch_observed` structured log at every `fetchPlayerSignals` outcome (`not_configured` | `no_player` | `ok_neutral` | `ok_non_neutral` | `aggregator_unavailable` | `non_ok_status` | `timeout` | `fetch_error`). Resolves the dependency-0-rows mystery via a path that doesn't depend on auto-instrumentation. Query in hobbyiq-insights `traces` table.
- Additive corpus capture: `trendIQ_composite`, `playerMomentum_multiplier`, `trendIQ_weights` (nullable) hoisted to flat `PredictionLogDocument` fields. Mirrors the `cache_hit` / `served_stale` precedent. §4.2 / §4.3 accuracy instrument unchanged.
- **No behavior change** — same multipliers, same composites, same predicted prices. The slice produces the data necessary to answer "do non-neutral composites actually reach predictions?" without touching any prediction math.
- **Pulled from slice 1 (originally planned for it):** the `fetchPlayerSignals` cache wrap (Workstream D from Phase 4a). It's a behavior change (15-min freshness becomes deterministic vs per-request fetch) that would contaminate the firing-rate baseline measurement. Defer until after slice 1's measurement lands.

**ROSTER MEASUREMENT 2026-06-02 (PHASE-4B-PROOF-CLOSE, free — no RBAC needed):**
- **fn-compiq aggregator roster: 10 players.** Defined by `COMPIQ_TRACKED_PLAYERS` env var on `fn-compiq`, falling back to a 5-player default in `compiq-functions/shared/__init__.py:_DEFAULT_PLAYERS`. Current value: Trout, Ohtani, Judge, Acuña Jr, Soto, Bellinger, Gleyber Torres, Witt Jr, Skenes, Bonemer. These 5-of-10 exactly match the PROOF's `ok_non_neutral` set; the 404s map exactly to the players NOT in the env var.
- **Backend `player_trends` Cosmos container: 75 players.** Partition `/playerId` (MLBAM numeric IDs + a few name-slug fallbacks). One page, 4.5 RU, no cross-partition hang — `SELECT VALUE c.playerId` is the partition-key-safe projection.
- **Relevant universe:** active MLB 26-team rosters (~676) + 40-man (~1200) + top-200 prospects = **low thousands at the OUTER edge** but **tens-to-low-hundreds** for the cards HobbyIQ actually predicts on at current volume. Carded-retired population (Maddux, Griffey Jr. that showed in the 404s from background jobs) is an additional ~thousands but irrelevant to live-signal play.
- **Coverage gap verdict: TENS.** Roster broadening from 10 → ~100 active-relevance players is a single env-var edit + per-player signal-source warm-up (one fn-* timer cycle = ~2h). NOT thousands. Roster broadening is mechanically trivial; the question gating it is whether playerMomentum EARNS its 0.20-0.30 weight at any roster size (slice 3 answer).

**Slice 2 — Per-source `fn-*-signals` blob liveness (DEFERRED — gated on slice 3 outcome):**
- Original plan: Storage Blob Data Reader RBAC grant against `stcompiqfnotgm2` to enumerate per-source blob freshness.
- **New ordering:** slice 3 first. If slice 3 shows playerMomentum's contribution does NOT improve accuracy at horizon, then RBAC + per-source liveness is wasted work (we'd retire the source-signal pipeline regardless of whether individual `fn-*-signals` are alive). If slice 3 shows playerMomentum DOES earn its keep, slice 2 becomes the maintenance-mode workstream (keep the live ones alive; the dead ones explain why their players show neutral).

**Slice 3 — Layer-decomposed calibration (PRIORITY after slice-1 corpus matures ~2 weeks):**
- Decompose accuracy attribution **BY LAYER, NOT by composite-on/off**. The PROOF showed Layer 2 (cardTrajectory) does most of the composite work; aggregating composite-on/off would mis-attribute Layer 2 wins to Layer 1.
- Three accuracy buckets:
  - `cardTrajectory_only`: rows with `coverage=card_only` (Layer 1 absent; Layer 2 drives composite at weight 1.0)
  - `playerMomentum_present`: rows with `playerMomentum_multiplier != null` (Layer 1 firing at weight 0.20-1.00 depending on coverage)
  - `full_coverage`: rows with `coverage=full` (all three layers at canonical 0.20/0.40/0.40)
- Horizon discipline per `Signal classes: attention vs price` memory: Layer 1 single-digit nudges (1.026-1.082 observed) are price-class-flavored → <7d outcomes. Layer 2 cardTrajectory <30d sales-velocity → <30d outcomes. Wrong-horizon backtests trained AWAY from cascade-tier attention value before; do not repeat.
- **Decision** at slice 3: does `playerMomentum_present` accuracy beat `cardTrajectory_only` accuracy at matched horizon by enough to justify the Layer 1 weight + the operational cost of fn-* pipeline maintenance? If yes → slice 2 + 5 (broaden + maintain). If no → reweight Layer 1 to ~0.05 or retire entirely.

**Slice 4 — Per-signal cap + per-source fallback-to-1.0 hardening (ONLY if slice 3 surfaces a destructive signal):**
- Cap individual signals' contribution before they enter playerMomentum aggregation (e.g. cap any single source's deviation from 1.0 at ±30%).
- Per-source `NEUTRAL_SIGNAL` fallback already exists in `fetchPlayerSignals`; verify it activates correctly on the stale-source case.

**Slice 5 — Roster broaden + recover/retire individual `fn-*-signals` sources (GATED on slice 3 verdict + slice 2 inventory):**
- Roster broaden: env-var edit on `fn-compiq` to expand `COMPIQ_TRACKED_PLAYERS` from 10 → ~100 active-relevance players (active MLB 26-roster regulars + top-200 prospects). Each new player kicks off a signal-source warm-up cycle (~2h per timer tick × 7 sources = next-day coverage). Trivial mechanically; gated on slice 3 showing the cost-benefit ratio is positive.
- Per-source repair/retire: for any dead/stale source identified in slice 2 (when slice 2 fires): decide repair, repurpose, or retire.

**4b success criteria (REFRAMED 2026-06-02 post-PROOF):**
- ~~Slice 1: backend `traces` table answers "is fetchPlayerSignals actually called and how often does it get a non-neutral multiplier?"~~ **ANSWERED 2026-06-02: yes, 8 ok_non_neutral fetches; aggregator reachable + responsive; composites range 0.741-1.37.**
- Slice 3: layer-decomposed accuracy comparison run with horizon-matched outcomes; verdict on whether playerMomentum earns its 0.20-0.30 weight at matched horizon.
- Slice 5 (post-slice-3): roster broadened OR signal pipeline retired, based on slice 3 verdict.
- Slices 2 / 4: only if slice 3 verdict is "keep + maintain."

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

### Phase 6.5 — iOS end-to-end product finalization (added 2026-06-01)

**Item:** iOS end-to-end testing run → product finalization.

**Intent:** exercise the full vertical loop IN-APP, not in isolated component tests. A single user-on-device run that goes:

```
add holding (InventoryIQ)
  → list on eBay (D.3/D.4 EbayListingDraftView publish)
  → real sale (eBay-side buyer purchase; same event as loop-verification's prod sale)
  → sold/ledger state visible (Phase 5 portfolio dashboard reflects sold; ledger entry visible)
  → finances reconciliation display (PR E / Phase 6 UI surfaces granular fees + netPayout)
  → P&L (Phase 6 P&L view shows the real reconciled number, not the pre-Finances inflated one)
```

**Doubles as the real end-to-end backend verification.** The single real sale that drives this in-app run IS the same event the EBAY-LOOP-VERIFICATION runbook calls for. There are not two separate "prove the backend" and "verify iOS" tests — there is one user-driven sale that, instrumented properly, proves both surfaces in one transaction. Capturing the raw ITEM_SOLD envelope + the raw Sell Finances transaction response during this run is mandatory (data-shape ground truth).

**Dependencies — ordered:**

1. **EBAY-LOOP-VERIFICATION** (Drew-gated; runbook delivered): eBay developer-console subscription state confirmed (ITEM_SOLD topic added if not already), a real production small-dollar sale flows through the webhook handler, `markHoldingSoldFromEbay` writes a real ledger row with a real `ebayOrderId`.
2. **EBAY-FINANCES-SLICE-A** (entitlement + sell.finances scope append + re-consent + real Finances response captured + corrected mapping table produced).
3. **EBAY-FINANCES-SLICE-B** (server-only enrichment helper + on-demand reconcile route + tests + proven on real order).
4. **EBAY-FINANCES-SLICE-C** (scheduled sweep + observability + dry-run).
5. **Phase 6 PR E iOS surfaces** must render the post-enrichment fee detail + `needsReconciliation` state + tax-export grouping. Pre-Finances iOS would display "no fee data" placeholders; post-Finances iOS displays the actual numbers.

**Acceptance — single deliverable:** the full inventory → list → sell → finances reconciliation → P&L loop demonstrably works VISIBLY in the iOS app for one real prod sale on one device. Captured artifacts (mandatory, saved at apply time):

- A demo recording (screen capture) of the in-app flow end-to-end.
- The raw ITEM_SOLD envelope JSON from the prod webhook (saved verbatim from `webhook_events`).
- The raw Sell Finances transaction response JSON (saved verbatim from the API call).
- Before-and-after of the ledger row: pre-enrichment (`needsReconciliation=true`, fees null, inflated P&L) and post-enrichment (`needsReconciliation=false`, fees populated, real P&L).

This is the launch-readiness gate for the inventory→list→sell→reconcile→P&L vertical. Until this completes, the loop is theoretical.

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
- **DealFinderIQ** *(appended 2026-06-02).* Detect undervalued live listings vs fair/predicted value. Feasible on existing stack — CompIQ FMV + Cardsight identify + eBay Browse API for active listings already deployed. **Differentiator**: scores deals against PREDICTED price, not just current comps — the same "head-start window" cascade signals that drive Phase 5 actionable-seller-intelligence apply on the buy side. Post-launch; **Investor+ tier** per the entitlements matrix shipped 2026-06-02 (`d0f59e4`).
- **GradingIQ** *(appended 2026-06-02).* Should-I-grade EV estimate: `(grade-aware value × gem-rate probability) − grading cost`. Feasible — grade-aware CompIQ pricing already shipped (CF-BACKTEST-COSMOS-GRADE-FLOW, `b55f1ec`), Cardsight `autoGrade` returns on every identify response (confirmed in CF-CARDSIGHT-SCANNING-RECON), PSA pop data is queryable, fee tables are public. Output bounded by gem-rate estimate; present as EV with confidence band, not a point recommendation. Post-launch; **Investor / Pro Seller tier**.

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

## Addendum 2026-05-27 — Phase target rebaseline post-execution session

Original roadmap drafted 2026-05-21 against pre-execution assumptions. Today's session output + multiple framing inversions justify formal rebaseline.

### Phases shipped or near-complete

- **Phase 1 (Stop the bleeding):** COMPLETE today — compsByPlayer endpoint shipped + grade-flow fix (PR #122, 4d4bd8c).
- **Phase 2 (Replace router bypasses):** COMPLETE today — MCP rewire Phase 2 (the compsLoader now routes through `/api/compiq/comps-by-player` and forwards `gradeCompany`/`gradeValue` to the backend; production /predict path is grade-correct).
- **Phase 3 (Decommission CH):** PARTIAL → COMPLETE in 1-2 sessions. Remaining: CF-CARDHEDGE-CLIENT-DELETE (2-3h), CF-FN-CARDHEDGE-DISABLE (bundled).
- **Phase 4a (MCP cache):** PARTIAL → COMPLETE in 1 focused session. Remaining: dashboard, formal invalidation, stale-flag (vs current implicit cache via 6h Redis TTL in `compsByPlayer.service.ts`).
- **Phase 4b (Signal integration):** foundation built (framing-inversion discovery), URL fixed (today — `AZURE_SIGNAL_FUNCTION_URL` corrected from `/api/serve-signals` 404 → `/api/signals` 200), backtest methodology in progress (Workstreams 2-3 of the current Windows queue: `--repeats` multi-run aggregation + `temperature=0` determinism). Estimated complete: 1-2 sessions after methodology stabilizes + credentials repaired.

### Rebaselined target horizons

- **Original:** End of July 2026 — CompIQ formalization + ERP reconciliation
- **Rebaselined:** Mid-June 2026 — Phases 1-4b complete, signal value validated (**4-6 weeks earlier than original**)

- **Original:** Mid-September 2026 — ML moat realized (Phase 4e)
- **Rebaselined:** Late August → Early September 2026 — narrowed but uncertain (**1-3 weeks earlier than original**; Phase 4c/4d greenfield work still gates this)

### Week-by-week schedule (rebaselined as-of 2026-05-27)

| Week of | Workstreams | Phase milestone |
|---|---|---|
| 2026-05-26 (current) | Windows queue WS2-WS3: CF-BACKTEST-REPEATS + CF-BACKTEST-DETERMINISTIC; CF-CARDHEDGE-CLIENT-DELETE prep; iOS bugs/D.4 | Phase 4b methodology stabilizing; Phase 3 cleanup begins |
| 2026-06-02 | Phase 4b credential repair (if backtest validates) OR CF-PHASE4B-PROMPT-AUDIT (if backtest neutral); Phase 3 cleanup completion; Phase 4a dashboard | Phase 3 + Phase 4a COMPLETE |
| 2026-06-09 | Phase 4b validation final pass | Phase 4b COMPLETE |
| **2026-06-16** | **Mid-June milestone — Phases 1-4b complete (REBASELINED HIGH-CONFIDENCE TARGET)** | Phase 4b validation milestone; iOS catch-up |
| 2026-06-23 | Phase 4c kickoff — AutoML setup, training data pipeline | Phase 4c begins |
| 2026-06-30 | Phase 4c model training + evaluation; iOS PR E reconciliation UX | Phase 4c mid-flight |
| 2026-07-07 | Phase 4c complete, Phase 4d kickoff | Phase 4c COMPLETE → Phase 4d begins |
| 2026-07-14 | Phase 4d ML serving infrastructure; iOS expense tracking implementation | Phase 4d mid-flight |
| 2026-07-21 | Phase 4d A/B harness + outcome tracking expansion | Phase 4d advancing |
| **2026-07-28** | **End of July milestone — CompIQ formalization + ERP reconciliation (HIGH CONFIDENCE; 0-2 weeks early vs original)** | Phase 4d production-serving milestone |
| 2026-08-04 | Phase 4d production observation; iOS pricing × portfolio integration | Phase 4d settling |
| 2026-08-11 | Phase 4d COMPLETE; Phase 4e begins | Phase 4d → Phase 4e |
| 2026-08-18 | Phase 4e iteration + competitive analysis | Phase 4e mid-flight |
| 2026-08-25 → 2026-09-08 | Phase 4e production observation + iteration cycles | **ML moat realized milestone (MODERATE CONFIDENCE, late-Aug to early-Sep)** |

### Phase 4c-4e detail (greenfield, unchanged scope)

- **Phase 4c — ML training pipeline** (2 weeks focused, per original)
  - Cannot compress: AutoML setup, training data pipeline, model evaluation
  - Earliest start: after Phase 4b validation complete (mid-June)
  - Earliest complete: end of June 2026
- **Phase 4d — ML serving production traffic** (4 weeks per original)
  - Cannot compress significantly: serving infrastructure, A/B testing harness, outcome tracking expansion, rollback safety nets
  - Earliest start: early July 2026
  - Earliest complete: end of July 2026
- **Phase 4e — ML moat realized** (3 weeks per original)
  - Cannot compress: requires production observation, iteration cycles, competitive analysis documentation
  - Earliest start: late July 2026
  - Earliest complete: mid-August to early September 2026

### iOS workstream parallel track

- **Original:** Weeks 4-16 parallel, paced by solo capacity
- **Rebaselined:** today's session shipped **1 verified iOS commit: ecd25b9** (Bug 2 fix — card tap not opening detail sheet in InventoryIQ). Remaining: Bug 3 (device-test), Bug 4 fix, D.4 completion, ITEM_SOLD consumer pipeline (iOS-side), PR E reconciliation UX, expense tracking implementation.
- **Corrective note (2026-05-24):** An earlier version of this addendum claimed "today's session shipped 4 iOS commits (Bug 2 + Bug 4 + ITEM_SOLD consumer + expense tracking design)." Verification confirmed the additional 3 commits did not exist in repo history. See SESSION_HANDOFF for full discrepancy explanation. The remaining iOS workstreams (Bug 4 fix, Bug 3 device test, ITEM_SOLD consumer implementation, expense tracking standalone design doc if needed) remain genuinely open and unscheduled.
- **Realistic iOS pace:** 1-2 focused sessions per major workstream
  - Total iOS remaining: ~6-8 focused sessions
  - Calendar: 3-4 weeks at moderate pace, 1-2 weeks if dedicated focus
- **Distribution across schedule:** late May - June (bugs + ITEM_SOLD + D.4); July - August (PR E reconciliation + expense tracking); August - September (pricing × portfolio integration)

### What this rebaseline assumes

- **Sustainable pace going forward.** Today's session shipped 17 commits + 8 carry-forwards across multiple workstreams. That is NOT a sustainable daily cadence — it was a single-day burst with the operator on-call. Forward scheduling assumes 1-2 focused sessions per major workstream, not multi-workstream days.
- **Solo capacity bounded.** No contractor / pair-programmer brought in (per original roadmap's "Outside help" section). All workstreams sequenced through one operator.
- **Framing-inversion gains don't recur in 4c-4e greenfield.** Today's compressions came from discovering pre-existing infrastructure (Phase 4b signal integration was already wired; backtest harness already existed; compsLoader already had partial grade-flow). Phase 4c-4e are NET-NEW work — AutoML training pipelines, ML serving infrastructure, outcome tracking expansion. No "already-built" surprise expected to compress those phases.
- **Production incidents bounded.** Today's velocity assumes no major production incident pulls operator focus away. One serious incident (e.g., HobbyIQ3 outage requiring full investigation) could absorb 1-2 days and push every dependent milestone back by that amount.
- **Phase 4c-4e estimates remain conservative.** Original 2-4-3 week estimates kept as-is despite today's compression on earlier phases. ML work has its own pace; don't extrapolate.

### Risk factors that could push timeline back

1. **Phase 4b backtest methodology proves more complex** than current Workstreams 2-3 — e.g., per-card noise reduction doesn't stabilize even with `--repeats` + `temperature=0`, forcing N=100 cohort expansion before any per-signal attribution can land.
2. **Phase 4c AutoML experiments don't justify productionization on first iteration** — model accuracy < production heuristic, or training data sparsity hits learning bound. Iteration cycle adds 1-2 weeks per pivot.
3. **Phase 4d ML serving surfaces production incidents** — today's velocity assumes incidents bounded. ML serving introduces new failure modes (model drift, prediction skew, latency surges) that may not be caught in pre-prod and require operator triage.
4. **iOS workstream queue grows** — D.4 surfaces unexpected scope, PR E reconciliation UX proves larger than estimated, expense tracking implementation needs UX iteration.
5. **Solo capacity constraints** — today's pace not sustainable daily; sustained illness, travel, or competing priorities can absorb a week without progress.

### Risk factors that could pull timeline forward

1. **Phase 4c framing inversion** (some training pipeline infrastructure already exists somewhere — pattern recurring today). Today's session surfaced framing inversions in 6 separate places; not impossible that 4c has analogous "we already started this" surprises.
2. **Phase 4d uses existing Azure ML quickstart templates** rather than greenfield infrastructure. If the SDK + templates compose cleanly, several weeks of plumbing collapse to days of configuration.
3. **iOS workstream consolidation** — some items merge or overlap rather than sequence (e.g., PR E reconciliation UX and expense tracking share a UX layer that can be built once).

### Comparison to original

| Milestone | Original (2026-05-21 roadmap) | Rebaselined (2026-05-27) | Delta | Confidence |
|---|---|---|---|---|
| Phases 1-4b complete | end of June 2026 | mid-June 2026 | 2 weeks early | HIGH |
| CompIQ formalization + ERP | end of July 2026 | end of July 2026 (max 2 weeks early) | 0-2 weeks early | **HIGH** |
| ML moat realized (Phase 4e) | mid-September 2026 | late August → early September 2026 | 1-3 weeks early | **MODERATE** |

### What to commit explicitly

- **End of July target — CompIQ formalization + ERP: HIGH CONFIDENCE.** Today's gains banked. Greenfield ML work bounded by Phase 4d's 4-week estimate which starts on-time per rebaselined schedule.
- **Mid-September target — ML moat realized: MODERATE CONFIDENCE.** Greenfield ML work (Phase 4c-4e) is the gating factor — not compressed by today's gains. Earliest realistic landing is late August; mid-September retains buffer for the 5 risk factors above. If any 2 of those fire, target slips to original mid-September timeline.

### Anti-drift note (for next planner)

This rebaseline is OPTIMISTIC about phases 1-4b (today's framing-inversion gains banked) and CONSERVATIVE about phases 4c-4e (greenfield, no surprises expected). The HIGH-confidence end-of-July target rests on Phase 4c starting on time mid-June — if Phase 4b backtest methodology slips past mid-June, Phase 4c slips with it, and end-of-July becomes MODERATE rather than HIGH confidence.

Re-check this rebaseline at end of June 2026. If Phase 4b is complete + Phase 4c has begun: HIGH confidence holds. If Phase 4b is still in flight: re-baseline again with a 1-2 week shift.

End of addendum 2026-05-27.

## Addendum 2026-06-16 — CardSight-only pricing decision; prominence correction parked

**Decision: CardSight is the sole pricing data source.** External pricing feeds (CardLadder, PriceCharting, SportsCardsPro/SCP as a corpus source) are OUT OF SCOPE for the v1 engine and the path to launch. Cardsight provides catalog, comp pool, and pricing; the engine's observed-vs-estimated firewall is unchanged.

**Implication for high-prominence cards.** The composed-multiplier estimator centers on the corpus median across cards in the same (finish, serial) ladder cell or tier. On high-prominence star parallels, the engine under-shoots true auction-market clearing prices because the corpus median pools across cards whose markets behave differently. This bias is **intentionally accepted at v1, not corrected.** Honesty about the under-shoot is delivered via the band-honesty ranges (shipped 2026-06-16, `76d6e3f`): empirical P10/P90 spreads from the 521-point ladder-fit corpus, so the range contains true market truth at ~78–88% even when the point under-shoots. The label "estimated range" reads honestly; no overclaiming.

**Prominence correction — PARKED.** Probed this session (CF-PROMINENCE-CORRECTION, read-only): cannot be fit or validated from CardSight comps alone, because Cardsight's source coverage (eBay) is prominence-blind in the regime that matters — high-end star parallels clear at auction prices the eBay corpus undercounts, so the residuals we'd need to fit `g(base-raw → multiplier-correction)` are themselves biased. SCP cross-validation tried as a market-truth source produced n=5 usable cards (target ~15) at R²=0.21, with the bias direction inverted from the brief's framing — direct evidence that without a richer auction-feed source we can't tell signal from noise on the high end. **Do NOT expand the SCP corpus to chase this.** SCP is itself prominence-blind / undercounts top parallels and scraping at scale will not change the underlying coverage problem.

**What unparks prominence correction:** an external auction-clearing data source whose coverage extends to the high end. Not in v1 scope. Re-evaluate post-launch only if (a) a credible source materializes and (b) the band-honesty UX is insufficient — i.e. user feedback or observed listing behavior shows the under-shoot causing real harm.

**What does NOT unpark it:** "the engine is wrong on Mike Trout / Leo De Vries blue refractor." Known, accepted, surfaced via the range. Not a regression and not a CF.

End of addendum 2026-06-16.
