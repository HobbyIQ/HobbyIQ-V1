# CF-PREDICTION-CREDIBILITY-DESIGN — methodology + design (Rev 2)

**Date:** 2026-05-30 · **Rev 2** (incorporates platform-wide AI retention finding; drops backfill; adds Cosmos-based completeness counter; recalibrates direction band)
**Type:** Methodology / design — NO build, NO measurement, NO corpus creation
**Canonical clone:** `C:/dev/hobbyiq-main`
**Audit basis:** [`pillar_state_audit_2026-05-30.md`](pillar_state_audit_2026-05-30.md) (commit `a703fda`) §SURPRISES #9
**Contract context:** [`contract_freeze_v1_2026-05-30.md`](contract_freeze_v1_2026-05-30.md) §2 frozen CompIQ card-detail shape includes `prediction.predictedPrice` + `prediction.mechanism` + `prediction.confidence`

**The core product claim** is forward-looking pricing: "tap a card, see what it's worth AND where it's heading." Today predictions are emitted but unmeasured. Without measurement, we cannot defensibly substantiate the claim. This methodology pins how we WILL measure — before we measure. Building the corpus + running the backtest are separate CFs (sized in §6); this doc designs the methodology that those CFs implement.

**Discipline invariant:** the methodology is locked BEFORE measurement begins. Pinning the success criteria after seeing results is how a credible claim becomes selection-bias dressed up in numbers.

---

## 1. Current state — how predictions are emitted today + the retention reality

### 1.1 Emission site (cite file:line)

`backend/src/services/compiq/compiqEstimate.service.ts:2710-2746` emits a structured `[compiq.prediction_emitted]` event via `console.log(JSON.stringify(...))`. Captured by App Service log stream → Application Insights traces table.

**Per-event payload (verbatim from `:2716-2742`):**

```json
{
  "eventType": "prediction_emitted",
  "timestamp": "<ISO 8601>",
  "playerName": "<string | null>",
  "cardYear": "<number | null>",
  "product": "<string | null>",
  "parallel": "<string | null>",
  "gradeCompany": "<string | null>",
  "gradeValue": "<number | null>",
  "fairMarketValue": "<number | null>",
  "predictedPrice": "<number | null>",
  "predictedPriceRange": "{ low, high } | null",
  "predictedPriceMechanism": "trendiq-projection | unavailable",
  "forwardProjectionFactor": "<number>",
  "trendIQ": {
    "composite": "<number>",
    "direction": "<rising | falling | stable>",
    "coverage": "<full | card_only | no_segment | insufficient>",
    "components": {
      "playerMomentum": "<number | null>",
      "cardTrajectory": "<number | null>",
      "segmentTrajectory": "<number | null>"
    },
    "lastUpdated": "<ISO 8601>"
  },
  "compsUsed": "<number>"
}
```

### 1.2 Critical gap in emission shape

**The event does NOT include `cardsightCardId`.** The natural join key to portfolio holdings (per the freeze, R1 cardsightCardId is the canonical Cardsight FK) is absent. Today the only identity carried is the parsed text tuple `(playerName, cardYear, product, parallel, gradeCompany, gradeValue)` — same tuple that drove the 14-shape drift on PortfolioHolding. **Without `cardsightCardId`, outcome-joining requires fuzzy text matching against the same drifty field set — a known failure mode.** Fixing this is the very first sub-task of the corpus CF.

### 1.3 The retention reality — empirically verified, drives everything below

**Drew flagged it; live check confirmed.** Both `hobbyiq-insights` (HobbyIQ3 backend) AND `fn-compiq` AI instances exhibit ~30-minute trace retention at verification time (`2026-05-31T00:25Z`):

- **hobbyiq-insights** (HobbyIQ3 backend): oldest trace `2026-05-30T23:55:30Z`, newest `2026-05-31T00:25:31Z` → 30-min window, 204 total traces
- **`[compiq.prediction_emitted]` events:** **2 events** recoverable across visible history

This is NOT a fn-compiq-specific issue. It's a platform-wide App Insights config issue (likely sampling, possibly retention setting). **The investigation is reframed as `CF-PLATFORM-OBSERVABILITY-RETENTION` and elevated from "before launch-tier scale-up" to PUBLIC-LAUNCH GATE.**

**Why launch gate, not pre-scale-up.** 30-min retention across both AI instances means there is essentially no production observability beyond half an hour for ANY service — not just predictions. Shipping a product that handles people's portfolio and tax data while blind to anything older than 30 minutes means you cannot debug a real incident. A user reports a P&L error from yesterday; the traces explaining it are gone. A ledger write produces wrong netProceeds at 3am; by morning the trail is unrecoverable. This is the kind of operational blindness that makes incident response performative rather than effective. Closing the gap is a launch precondition, not a scaling concern.

**Three consequences load-bearing on this methodology:**

1. **Backfill from stdout traces is dead.** Only ~2 prediction events recoverable from history. There is no historical corpus to bootstrap. **`CF-PREDICTION-CORPUS-BACKFILL` is DELETED from scope; corpus starts cold at ship date.**

2. **Shipping the corpus NOW is urgent.** Every day without the corpus is permanently-lost-history. The CF should be Phase A IMMEDIATE-NEXT, not bundled with later step 4/7 work. **Sub-task sequencing inside the corpus parent: emission-fix (cardId addition, S) FIRST, then writer + container, then health counter.** Otherwise the corpus's first rows carry the same broken text-only join the current stdout event has.

3. **App Insights customEvents / customMetrics for write-completeness telemetry has the SAME retention problem.** Whatever we use to monitor corpus completeness must be Cosmos-native, not App-Insights-native. Drives §2.6 design below — but recognize that §2.6 is a POINT-PATCH around the platform retention hole. Fixing CF-PLATFORM-OBSERVABILITY-RETENTION properly cuts how many bespoke Cosmos counters we end up building across the system.

### 1.4 Emission frequency + volume profile

Every `POST /api/compiq/estimate`, `/price`, `/price-by-id`, and `/cardsearch`-then-pin call hits this code path (via `computePredictedPrice` at `forwardProjection.ts:46-77`). Single-user pre-launch volume ≈ tens of calls/day. Multi-user launch volume projects to thousands+/day per the [[CF-LAUNCH-READINESS-500]] candidate constraints.

---

## 2. Prediction corpus — proposed shape

### 2.1 Why move out of stdout

Three reasons that compound:
1. **App Insights retention is empirically ~30 min** at current configuration. Stdout-only emission ≈ data evaporates within an hour. Cosmos persistence is the only path to a measurable corpus.
2. **Trace queries do not join cleanly to Cosmos data.** Outcome data lives in Cosmos (`PortfolioLedgerEntry` array on `UserDoc`). A Cosmos-native corpus joins natively.
3. **Stdout drops compsUsed and signal components into a stringified JSON inside a trace `message` field** — not first-class queryable.

### 2.2 Container shape

**Cosmos container:** `prediction_log`
**Partition key:** `/cardsightCardId` (NOT `/userId` — see §2.3)
**Document id:** `${cardsightCardId}_${timestamp_epoch_ms}` for resolved rows (matches the `trend_history` pattern at `playerScore/trendHistory.service.ts:113`)

**Null-cardId handling (added during CF-PREDICTION-CORPUS STEP 2 build, Option A locked):**

When the prediction emits without a resolved `cardsightCardId` (free-text search where catalog resolution failed, or `predictedPriceMechanism === "unavailable"`), the row is still persisted for record-keeping per §3.5 but flagged unjoinable. Cosmos partition path can't accept null — sentinel substitution:

- **Stored `cardsightCardId` value:** the literal string `"__unresolved__"` (sentinel; never confused with a real 36-char Cardsight UUID)
- **Stored `id` value:** `__unresolved___${inputSigShort}_${epochMs}` where `inputSigShort` = first 8 hex chars of SHA-256 of the normalized request tuple (playerName, cardYear, product, parallel, gradeCompany, gradeValue) — collision-resistant within the sentinel partition at high write volume
- **New row-level flag:** `joinable: boolean` — true when the stored `cardsightCardId` is a real Cardsight UUID; false when it's the sentinel
- **Trade-off accepted for v1:** the `__unresolved__` sentinel partition is single-keyed → potential hot-partition at launch-tier write volume. v1 single-user volume makes this hypothetical. Forward-only upgrade path: at CF-LAUNCH-READINESS-500 if Cosmos throttle metrics show partition-level 429s on `__unresolved__`, evolve to hashed bucketing (`__unresolved_<2-hex-chars>__` = 256 buckets); new rows hash-bucketed, existing rows keep sentinel, enumeration widens the `WHERE` clause; no data rewrite needed.

**Document shape:**

```typescript
interface PredictionLogEntry {
  // ── Cosmos identity ─────────────────────────────────────────────────
  id: string;                                   // ${cardsightCardId}_${epochMs} for resolved rows;
                                                //   __unresolved___${inputSigShort}_${epochMs} for null-cardId rows
                                                //   (see null-cardId handling addendum above)
  cardsightCardId: string;                      // PARTITION KEY (the join axis to outcomes)
                                                //   Either a real 36-char Cardsight UUID OR the
                                                //   literal sentinel "__unresolved__" when the
                                                //   prediction was emitted with null cardId.
  joinable: boolean;                            // MIGRATION-STABLE FILTER. True when cardsightCardId
                                                //   is a real Cardsight UUID (row can be outcome-joined
                                                //   via §3); false when it's a sentinel (row exists for
                                                //   record-keeping per §3.5 LOW band; MUST be excluded
                                                //   from any accuracy claim).
                                                //
                                                //   LOAD-BEARING: every accuracy query MUST filter on
                                                //   `joinable === true` — NEVER on the partition value
                                                //   pattern (e.g. `WHERE cardsightCardId != '__unresolved__'`).
                                                //   The A→B upgrade at CF-LAUNCH-READINESS-500 (sentinel
                                                //   `__unresolved__` → hashed buckets `__unresolved_XX__`)
                                                //   changes the partition value set but does NOT change
                                                //   the joinable semantics. Queries filtering on
                                                //   `joinable` survive the upgrade unchanged; queries
                                                //   filtering on partition-value strings break silently.
                                                //   Hard rule: joinable is the only correct discriminator.

  // ── Identity context ────────────────────────────────────────────────
  playerName: string | null;
  cardYear: number | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;

  // ── Input features (what the model saw) ────────────────────────────
  fairMarketValue: number | null;               // anchor (the "rear-view comp")
  compsUsed: number;                            // sample size driving FMV + trend

  // ── Output (what the model said) ───────────────────────────────────
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceMechanism: "trendiq-projection" | "multiplier-anchored" | "unavailable";
  forwardProjectionFactor: number;
  predictionDirection: "rising" | "falling" | "stable";  // DERIVED from
    // predictedPrice vs fairMarketValue using DIRECTION_BAND_PCT
    // (the single named constant defined in §4.3 — recalibration is one line).
    // Strict `>` and `<` comparisons; ties fall into "stable".
    // §4.3 also pins the re-tune commitment against actual N-day move distribution
    // once corpus has volume.

  // ── Signal provenance ──────────────────────────────────────────────
  trendIQ: {
    composite: number;
    direction: "up" | "flat" | "down";        // internal TrendIQ direction
                                              // (distinct from predictionDirection above);
                                              // per backend/src/services/compiq/trendIQ.types.ts:11
    coverage: TrendIQCoverage;                // 7-value union: "full" | "no_segment" | "no_card" |
                                              //   "segment_only" | "card_only" | "player_only" | "insufficient";
                                              //   per backend/src/services/compiq/trendIQ.types.ts:13-20.
                                              //   Imported by predictionCorpus.service.ts as source of truth
                                              //   to prevent drift.
    components: {
      playerMomentum: number | null;
      cardTrajectory: number | null;
      segmentTrajectory: number | null;
    };
    lastUpdated: string | null;                 // nullable: aggregator may have
                                                //   no last-write timestamp (all
                                                //   signals unavailable → composite
                                                //   1.0 with no timestamp anchor)
  };

  // ── Request provenance ─────────────────────────────────────────────
  timestamp: string;                            // ISO 8601 — prediction emit time
  source: "estimate" | "price" | "price-by-id" | "cardsearch-pin"
        | "reprice-batch" | "reprice-job" | "from-card-create";
  callContext?: {
    userId?: string | null;
    routedFromHolding?: string | null;
  };
}
```

### 2.3 Why cardId-keyed partition (not userId)

Three reasons (unchanged from Rev 1):
1. **The outcome join is per-card, not per-user.** Partitioning by user fragments the join across partitions.
2. **Matches the `trend_history` precedent** at `playerScore/trendHistory.service.ts:23` — same temporal-comp aggregation per card.
3. **Public/free-text predictions have no userId.** UserId partition would force a sentinel single hot partition.

Per-user accuracy analytics doable as cross-partition query filtered by `callContext.userId` — pay the cost at cold analytics time, not at hot write time.

### 2.4 Write path — fire-and-forget, mirroring `trend_history`

Same pattern as `trendHistory.service.ts:92-142`:
- Synchronous return from estimate path (no await on Cosmos)
- Try/catch swallowed; throttled error log (1/min)
- Rate-limited at TIME-OF-WRITE: ONE write per (cardId, signature) per N minutes — signature = hash of input features
- Initial N = 60 minutes (matches `trend_history`); tunable post-launch
- **Stop emitting stdout once corpus writes are confirmed live.** Dual emission for the burn-in week, then drop console.log.

### 2.5 Cold-start urgency (NOT backfill)

**Prior rev proposed CF-PREDICTION-CORPUS-BACKFILL — DROPPED.** Per §1.3, ~30-min App Insights retention means historical recovery yields ~2 events. Backfill would produce a near-empty corpus.

**Cold-start framing:**
- Corpus starts at the moment `CF-PREDICTION-CORPUS` ships
- Every prediction emitted BEFORE that moment is permanently unrecoverable
- Therefore: every day between now and corpus-ship is a day of lost measurement substrate
- **`CF-PREDICTION-CORPUS` should be Phase A IMMEDIATE-NEXT — not bundled with step 4 or 7.** Promote to top of Phase A queue.

The size estimate stays M (2-8h) — it's a fire-and-forget Cosmos writer mirroring an existing pattern. The urgency is around when, not how big.

### 2.6 Write-completeness counter — Cosmos-based (replaces App Insights customEvents)

**Drew's concern (correct):** silent write failures bias the corpus toward a non-random subset; given the telemetry gap you won't see the losses.

**Why not App Insights customEvents:** customEvents inherits the same ~30-min retention (§1.3). A loss-rate query 30 min after the fact returns nothing. Cosmos-native is the only viable path.

**Container:** `prediction_corpus_health`
**Partition key:** `/date` (YYYY-MM-DD)
**Document id:** `${date}_${replicaId}` (one doc per day per App Service replica)

**Document shape:**

```typescript
interface PredictionCorpusHealthEntry {
  id: string;                                   // ${date}_${replicaId}
  date: string;                                 // YYYY-MM-DD (partition key)
  replicaId: string;                            // hostname or instance id
  attempts: number;                             // total prediction emissions attempted
  successes: number;                            // confirmed Cosmos writes
  failures: {
    count: number;
    lastError: string | null;                   // truncated to 500 chars
    lastErrorAt: string | null;                 // ISO 8601
  };
  firstAttemptAt: string;                       // ISO 8601 (first attempt of the day on this replica)
  lastUpdatedAt: string;                        // ISO 8601 (last flush)
}
```

**Write path:**
- In-process counters in the prediction emission code (`compiqEstimate.service.ts` near `:2710-2746`): atomic increments on attempt + on success/failure resolution. ZERO extra Cosmos roundtrip on the prediction critical path.
- Periodic flush via 30s `setInterval` in the same process: atomic Cosmos patch to the `${today}_${replicaId}` doc with `attempts += delta_attempts`, `successes += delta_successes`, `failures.count += delta_failures`. ONE batched roundtrip per replica per 30s.
- Lossy on crash/deploy (last <30s of counter increments). Acceptable — Drew's discipline accepts cached-with-known-staleness for non-critical-path observability.

**Daily query to measure completeness:**

```kql
// Cosmos query, NOT KQL (App Insights):
prediction_corpus_health WHERE date == "YYYY-MM-DD"
   ↓
totalAttempts = sum(attempts), totalSuccesses = sum(successes), totalFailures = sum(failures.count)
   ↓
prediction_log WHERE timestamp BETWEEN startOf(YYYY-MM-DD) AND endOf(YYYY-MM-DD)
   ↓
actual_persisted = count()
   ↓
lossRate = (totalAttempts - actual_persisted) / totalAttempts
divergence = (totalSuccesses - actual_persisted)
```

**Two health signals (drift alarm, NOT audit):**

**Honest framing:** both the counter and the fire-and-forget writer have independent loss modes — the counter can miss attempts (process crash before flush; flush failure), the writer can miss successes (Cosmos throttle; transient network). So `lossRate` is APPROXIMATE. This is a "is it grossly lossy" detector, not an exact reconciliation. Useful for catching write-system collapse; not useful for the kind of forensic audit a regulator would expect.

1. **`lossRate > 1% sustained AND attempts > N` per day** → write-failure investigation triggers. The volume gate (`attempts > N`, default N=200) prevents noise-triggered alarms at cold-start when single-digit attempts make a one-event miss look like 25% loss. At launch volume the gate is meaningless; pre-launch it's the difference between "real signal" and "low-N noise."

2. **`divergence != 0` AND `attempts > N`** → counter and actual-rows disagree more than the in-process counter/writer race would explain. Either a counter-vs-write race exceeding the 30s flush window, or Cosmos writes returning success without persisting (rare; flag-worthy).

**Trade-off honestly carried:** adds one extra Cosmos container + small periodic write per replica (~1 write per replica per 30s). Cost negligible. The alternative (per-write Cosmos counter) adds a roundtrip to the fire-and-forget path, defeating the latency-off-prediction-path intent.

**Bigger picture: this is a point-patch.** §2.6 exists because §1.3 found that App Insights customEvents would suffer the same 30-min retention as traces. If `CF-PLATFORM-OBSERVABILITY-RETENTION` (now a public-launch gate per §1.3) lands properly, App Insights becomes the natural home for this kind of write-attempt telemetry — at which point §2.6 collapses to "emit customEvents on attempt + success/failure; KQL the rate." Bespoke Cosmos counters across the system are debt accrued against the retention hole; fixing the hole is the systemic remedy. §2.6 is justified specifically for the corpus regardless — the credibility methodology depends on completeness measurement, and the corpus can't wait for a platform fix — but resist the temptation to template this pattern across every observability gap in the system.

**Why this defends the credibility methodology:** without completeness measurement, every accuracy claim in §4 is conditional on "we don't know what we missed." With Cosmos-based completeness (approximate but real), every accuracy claim can be qualified with "measured against a corpus with ~N% known capture rate over the measurement window." That's the difference between defensible and faith-based — even approximate completeness is a step beyond opaque.

---

## 3. Outcome join — design + bias accounting

### 3.1 What counts as an "outcome"

A **realized sale price** for the predicted card identity, observed in a known time window after the prediction. Two viable outcome sources:

**Source A — `PortfolioLedgerEntry` (user sales):**
- Producer (manual): `portfolioStore.service.ts:1550-1651` (`sellHolding`)
- Producer (eBay webhook): `portfolioStore.service.ts:1699-1862` (`markHoldingSoldFromEbay`)
- Identity link: `holdingId → PortfolioHolding.cardsightCardId` (per contract-freeze §1, R1 FK)
- Sale price: `PortfolioLedgerEntry.unitSalePrice`
- Sale time: `PortfolioLedgerEntry.soldAt`

**Source B — Cardsight market comps:**
- Source: `CardsightSaleRecord` returned by `cardsight.client.getPricing(cardId)` (same endpoint as prediction INPUT)
- Identity link: same `cardsightCardId`
- Sale price: `CardsightSaleRecord.price`
- Sale date: `CardsightSaleRecord.date`

### 3.2 The join shape

**Per prediction row at time T:**

```
prediction_row (T, cardsightCardId, predictedPrice, fairMarketValue, mechanism, ...)
   ↓ join
Source A outcomes:
  WHERE PortfolioLedgerEntry.holdingId.cardsightCardId == prediction_row.cardsightCardId
    AND soldAt BETWEEN T AND T + windowDays

Source B outcomes:
  WHERE CardsightSaleRecord.cardId == prediction_row.cardsightCardId
    AND saleDate STRICTLY > prediction.timestamp     // NEVER inclusive of T
    AND saleDate ≤ T + windowDays
```

**Critical: Source B comps must be STRICTLY AFTER prediction time T.** Cardsight pricing endpoint returns RECENT comps including comps from BEFORE T (which drove the prediction). Joining a comp dated T-3 to a prediction emitted at T isn't measuring forecast accuracy; it's measuring fit-to-known-data — circular. The corpus pipeline MUST filter `saleDate > prediction.timestamp` strictly.

### 3.3 Window selection — gate to §4 methodology

Right window depends on signal class:
- **Price-class signals** (compsMomentum at 0.20 weight, ebay at 0.20) — <7d lag per [[signal_classes_attention_vs_price]]. Window: **7 days** post-prediction.
- **Attention-class signals** (trends 0.15, reddit 0.15, youtube blended) — 3-10 weeks lag per the same anchor. Window: **30 days** post-prediction.
- **Mixed signals** (most predictions) — evaluate at BOTH 7d and 30d; report separately.

Default windows: `7d` (price-class horizon) + `30d` (attention-class horizon).

### 3.4 Selection-bias accounting

**Source A bias** is real and significant — user-sold cards are NOT random sample:

| Bias dimension | Direction | Why it matters |
|---|---|---|
| Selling decision endogenous to prediction | OVERSTATES accuracy | User may sell because app recommended sell → circular if right or wrong in lockstep |
| Cash-needs selling | Random noise | Some sales unrelated to prediction |
| Loss-aversion bias | UNDERSTATES accuracy | Users hold predicted-falling cards, only selling those that recovered → outcomes overweight successful holds |
| Hot-card sampling | OVERSTATES sample density | Cards in portfolios get more prediction calls AND sales → sample on cards with best signal data |
| Pre-launch single-user bias | Severe distortion | At single-user state, Source A signal is one user's preferences. Not generalizable. |

**Source B bias** is different — market-wide so no per-user selection, but:
- Survivorship bias on Cardsight catalog coverage (mainstream sport-cards only)
- Thin-comp variance: predictions with `compsUsed < 5` are fragile; outcome variance high. Stratify by `compsUsed` bins.

**Honest analytic recipe:**
- Always report Source A and Source B separately. Don't blend.
- Within Source A, slice by `callContext.routedFromHolding != null` (hot-card-sampled) vs `== null` (free search, closer to random)
- Within Source B, stratify by `compsUsed` bins: `<5`, `5-15`, `>15`
- Per-segment confidence intervals (sample size matters more than point estimate at low N)

### 3.5 Identity join precision

Today's join axis is `cardsightCardId` (clean from §1.2 fix). For early predictions emitted before corpus shipped (the ~2 backfilled rows): fuzzy tuple-match against Cardsight catalog with confidence scoring:
- **EXACT** = cardId direct (live emission post-corpus-build) — confidence 1.0
- **HIGH** = (playerName, cardYear, product, parallel) matched against Cardsight catalog — confidence 0.8
- **MEDIUM** = (playerName, cardYear, product) matched, parallel ambiguous/null — confidence 0.5
- **LOW** = (playerName, cardYear) matched, product divergent — confidence 0.2

Drop LOW from accuracy claims. Cite confidence-band distribution alongside any aggregate metric.

---

## 4. Accuracy methodology — pinned BEFORE measuring

### 4.1 Why pin before measuring

Pinning success criteria after observing results is the canonical way bad metrics get reported. Pin now; measure after corpus + outcomes accumulate. If pinned criteria look wrong post-measurement, document the change explicitly with rationale, never quietly.

### 4.2 The primary claim under test

**Claim:** "HobbyIQ's predicted price is a better forward forecast than the fair market value (a rear-view comp aggregate) at evaluation horizons matching the dominant signal class."

This is a **comparative** claim, not an absolute. We are NOT claiming "predictedPrice is accurate to ±X%." We ARE claiming "predictedPrice beats the obvious baseline by Y% on metric Z."

### 4.3 Metrics — direction hit-rate primary; MAPE secondary

Per [[product_actionable_seller_intelligence]], the value prop is **timed action** (sell/hold/list), not exact-price. Direction matters more than magnitude.

**Primary metric: Direction Hit-Rate.**

**Direction band — single named constant `DIRECTION_BAND_PCT`:**

```
DIRECTION_BAND_PCT = 5           // ±5% — initial value, defensible starting point only
                                  // (NOT a finding; see "Re-tune commitment" below)
```

This constant is the SOLE source of truth for direction classification across the corpus (§2.2 `predictionDirection` derivation), the accuracy metric (this section), and the baseline (§4.4). Recalibration is one line: change `DIRECTION_BAND_PCT` in the shared constants module; every consumer picks up the new threshold automatically. No duplicated numbers across the codebase.

For each (prediction, outcome) pair:

- `predicted_direction` from corpus row's `predictionDirection` field (`rising` / `falling` / `stable`)
- `actual_direction` derived from outcome:
  - `outcome_price > fairMarketValue × (1 + DIRECTION_BAND_PCT/100)` → `rising`
  - `outcome_price < fairMarketValue × (1 - DIRECTION_BAND_PCT/100)` → `falling`
  - otherwise (equal-or-between, including tie) → `stable`
- Hit = `predicted_direction === actual_direction`

Strict `>` and `<` comparisons; ties at the threshold fall into `stable`. Same band applied symmetrically to BOTH prediction direction (corpus derivation) and outcome direction (this metric).

**Why ±5% as the starting value (rationale, not finding):**

Pre-data, any threshold is a guess — `DIRECTION_BAND_PCT = 5` is a defensible starting position with three properties:

1. **Symmetric on both sides of the comparison** — applied identically to prediction and outcome direction so neither side is structurally advantaged.
2. **Larger than trading-noise bid/ask spread** (~1-2%) — so a noise-level price move doesn't fire a directional flag.
3. **Smaller than what would collapse the metric into the stable class** — at ±8-10% bands, most outcomes register as "stable" and direction hit-rate becomes a "stable-bin only" measurement that loses discriminative power.

**Why NOT align to fn-comps-momentum's ±8% bucket:** the prior rev considered this. Wrong frame. fn-comps-momentum's ±8% is ONE INPUT SIGNAL's internal direction bucket — not the blended prediction's direction threshold. Prediction direction comes from `predictedPrice` vs `fairMarketValue` AFTER all seven signals blend through the aggregator and `forwardProjection`. The right band is whatever represents a "material move" on THAT post-blend axis, set symmetrically. ±8% conflates two different axes.

**Re-tune commitment (load-bearing):** ±5% is provisional. Once the corpus has volume (per §5.4 timelines — earliest ~1-4 weeks post-launch for N>1000), the band MUST be re-tuned against the actual measured N-day move distribution on the cards in the corpus. Specifically:

- Compute the empirical distribution of `(outcome_price - fairMarketValue) / fairMarketValue` for actual outcomes in the corpus at each evaluation window (7d, 30d).
- Set `DIRECTION_BAND_PCT` to a value that produces a balanced stable/rising/falling distribution (target: stable class ≤ 50% of outcomes; rising + falling ≥ 50% combined).
- Document the re-tune as an explicit methodology version bump (e.g. `methodology_version: 2`) with rationale.
- Re-tunes apply forward-only (do NOT retroactively re-classify existing corpus rows; baseline + HobbyIQ both re-evaluated at the new threshold for any post-tune accuracy claim).

**Stable-class share — mandatory reporting alongside hit-rate (NEW for v1):**

A too-wide direction band silently inflates hit-rate by pushing more outcomes into the `stable` bucket, where any prediction that defaulted to `stable` (the easy class) registers as a hit. To defend against this invisible inflation, every reported hit-rate MUST be reported alongside the stable-class share:

```
Direction hit-rate: 58% (n=1247, 95% CI 55-61%)
  Stable-class share: 41% (of outcomes)
  Baseline hit-rate on same window: 41% (= stable share by construction)
  HobbyIQ advantage: +17pp
```

This format makes it impossible to claim a "good" hit-rate that's actually just driven by a band so wide that everything looks stable. If `stable-class share > 60%`, the band is too wide and recalibration is triggered before the claim is made.

**Edge case resolution (explicit, locked):**

| Case | Resolution |
|---|---|
| `predictedPrice == fairMarketValue × (1 + DIRECTION_BAND_PCT/100)` exactly (tie at upper threshold) | Strict `>` and `<` operators; tie falls into `stable` |
| `predictedPrice == fairMarketValue × (1 - DIRECTION_BAND_PCT/100)` exactly (tie at lower threshold) | Same: strict; tie falls into `stable` |
| No outcome in window (Source A: user didn't sell; Source B: zero comps in window) | Pair DROPPED from sample. NOT counted as wrong/right. Reported separately as "outcome-coverage rate" alongside accuracy (e.g. "92% outcome coverage; of those, 58% direction hit-rate"). |
| `fairMarketValue == null` at prediction time | Prediction never enters corpus in the first place — `predictedPriceMechanism: "unavailable"` and `predictedPrice` is null. These rows captured in corpus for record-keeping but excluded from accuracy denominators (with explicit `n_excluded_for_null_fmv` count reported). |
| `outcome_price == 0` (suspicious sale record) | Filter out at outcome-join stage; not a valid outcome |

Report hit-rate separately for `{rising, falling, stable}` buckets. A model that says `stable` every time gets a misleading aggregate hit-rate driven by the stable class.

**Secondary metric: MAPE.**

`MAPE = mean(abs(predictedPrice - outcome_price) / outcome_price)` over matched pairs.

Report alongside hit-rate. MAPE penalizes magnitude errors that direction hit-rate misses; together they prevent gaming via either dimension alone.

**Stratifications (always reported, not toggleable):**
- By `predictedPriceMechanism` — `trendiq-projection` vs `multiplier-anchored` vs `unavailable`. The "unavailable" subset predicts `predictedPrice = fairMarketValue` (zero-confidence forecast); accuracy on this subset is the IMPLICIT baseline.
- By signal-class window (7d for price-class, 30d for attention-class)
- By `trendIQ.coverage` (`full` / `card_only` / `no_segment` / `insufficient`)
- By `compsUsed` bin (`<5`, `5-15`, `>15`)
- By outcome source (Source A vs Source B)
- By **corpus completeness band** (via §2.6 health counter — accuracy on days with `lossRate < 1%` is high-confidence; days with `lossRate > 5%` flagged as conditional)

### 4.4 Baseline-to-beat — "the rear-view comp"

The honest baseline is `fairMarketValue` ALONE (model that says "next sale price = last few comps' median, no forward projection"). What users get if HobbyIQ never projects forward.

For each (prediction, outcome) pair:
- `baseline_prediction` = `fairMarketValue`
- `baseline_direction` = `stable` (no forward signal)

Compute SAME metrics for baseline:

| HobbyIQ metric | Beats baseline if... |
|---|---|
| Direction hit-rate | HobbyIQ direction hit-rate > baseline direction hit-rate (~33% by construction in 3-class case; baseline always predicts stable → hits only when actual is stable). |
| MAPE | HobbyIQ MAPE < baseline MAPE (smaller is better). |

**If HobbyIQ does NOT beat baseline on both metrics, the prediction layer does not earn its credibility claim** — honest framing carried in any user-facing statement. The layer might still earn its keep on UX (the `predictedPriceRange` may be useful even if point estimate isn't), but the "better than rear-view comp" claim is falsified.

### 4.5 What counts as "credible enough to claim"

Statistical-significance pin (binomial test on direction hit-rate vs baseline):
- **Per-segment minimum N:** 100 matched pairs per stratification bin
- **Portfolio-wide minimum N:** 1000 matched pairs
- **Effect-size minimum:** HobbyIQ hit-rate must exceed baseline by ≥5 percentage points to be claimed publicly (below 5pp is in measurement noise even at N=1000)
- **Confidence interval reporting:** every claim reports the 95% CI on hit-rate, not just the point estimate. "Hit-rate 58% (95% CI 54%-62%) at 7d horizon" is honest; "58% accuracy" is misleading.
- **Corpus completeness floor:** measurements report `corpus_completeness = persisted_rows / attempts` from §2.6 health counter; claims qualified with "measured on a corpus with X% capture over the measurement window."

### 4.6 What we do NOT claim — explicit scope discipline

- We do NOT claim hit-rate translates to dollar PnL — requires modeling user behavior on the recommendation
- We do NOT claim per-card accuracy — corpus density per card too thin; we claim portfolio + per-segment
- We do NOT claim accuracy on out-of-distribution cards (non-baseball, ungraded, low-comp) — explicitly scope by `compsUsed` bin
- We do NOT claim absolute price accuracy beyond `predictedPriceRange.low ≤ outcome ≤ predictedPriceRange.high` band coverage. Range claim is auditable; "+/-X%" point claim is not without much more data than we'll have at launch.

---

## 5. Data volume — honest read on what we can claim NOW vs WHEN

### 5.1 Current data volume against pinned thresholds

| Data axis | Current state | Source-A path | Source-B path |
|---|---|---|---|
| Predictions emitted | Live since 8bd2487 (2026-05-27, ~3 days at draft); ~30-min App Insights retention → recoverable historical events ≈ 2 | Same | Same |
| Outcomes available | n/a | <20 realized sales across single-user 23-holding cohort | Hundreds-to-thousands per week for 10-player roster |
| Predictions joined to outcomes | 0 (corpus not yet built; backfill ≈ empty per §1.3) | Likely ≤10 even with backfill attempt — well below per-segment N=100 | Bootstrappable to N>1000 within days of corpus build IF Cardsight comp retrieval is automated |
| Defensible claim NOW? | **NO** | **NO** — sample too small AND selection bias too severe | **Internal-diagnostic-only** post-corpus; public claim requires post-launch user data |

### 5.2 The cold-start tax — quantified

**Days between today and corpus-ship = days of lost measurement substrate.** Backfill yields ≈ zero history (§1.3); the corpus starts empty at ship time.

| Days delay | Approximate predictions lost (single-user pre-launch) | Approximate predictions lost (post-launch ~1000 users) |
|---|---|---|
| 1 day | ~10-50 | ~10,000 |
| 1 week | ~70-350 | ~70,000 |
| 1 month | ~300-1500 | ~300,000 |

At pre-launch volume, the cold-start tax is small in absolute terms — but EVERY future accuracy claim is bounded by what's in the corpus, and the corpus only knows what it captured. **Ship the corpus to make today's measurements possible at all.** This is the operative urgency: not just data volume for stat-significance later, but the very first matched-pair becoming possible at all.

### 5.3 What we CAN claim now (after corpus + cold start)

**INTERNAL DIAGNOSTIC ONLY:**
- "Source B retrospective backtest on N=K predictions / outcomes from corpus-ship-date onwards shows portfolio-wide direction hit-rate Z% at 7d horizon vs baseline B%, MAPE X% vs baseline M%, corpus completeness C%."
- "Per-mechanism breakdown shows `trendiq-projection` outperforms `multiplier-anchored` by P pp." Internal signal-quality diagnostic.
- "Predictions with `coverage = full` have C% better hit-rate than `card_only`." Drives backlog priority.

**WHAT TO SHIP AS V1 USER-FACING:**
- Show `predictedPrice` + `predictedPriceRange` + `direction` per contract-freeze §2
- DO NOT show an "accuracy %" badge or "right X% of the time" claim
- Frame: "Forward projection based on TrendIQ signals — refreshed every 2h" (provenance, not accuracy)
- Frame: "Range reflects signal coverage" (uncertainty-honest, not point-claim)

### 5.4 What we CAN claim post-launch

| Public-claim threshold | Time to reach (estimate) | Why |
|---|---|---|
| Source-B portfolio-wide hit-rate (N=1000) | **~1-4 weeks post-launch** + corpus accumulation time | Cardsight comp retrieval is rate-limiting; if pre-fetched per tracked card daily, comp accumulation is fast |
| Per-mechanism stratified claim (N=100 per bin × 4 mechanisms) | **~2-3 months post-launch** | Smaller bin sizes need more total volume |
| Source-A user-sale hit-rate, selection-bias-acknowledged (N=100) | **~3-6 months post-launch** | User-sale velocity is binding |
| Source-A user-sale hit-rate, multi-cohort cross-validated (N=1000 per cohort × 3 cohorts) | **~6-12 months post-launch** | True bias mitigation requires comparing user behavior cohorts |

### 5.5 The honest pre-launch position

**The product can ship the predictedPrice feature without accuracy claims and remain credible.** User-facing copy frames forward projection as a signal-driven heuristic with explicit uncertainty (`predictedPriceRange`), not as a measured forecast. Consistent with:
- The actual feature shipped today (no accuracy badge in iOS surface)
- [[product_actionable_seller_intelligence]] (value in TIMED ACTION, not forecast accuracy claim)
- Honest scope: we don't have data yet; any claim now is built on too-thin evidence

**The accuracy CLAIM must wait** for post-launch data. The CORPUS must ship in v1 backend AS SOON AS POSSIBLE so accumulation begins. The METHODOLOGY (this doc) locks how we'll measure when data arrives.

### 5.6 The risk of NOT pinning this now

If methodology is improvised AFTER seeing results, credibility risk runs in both directions:
- **OVERCLAIM:** picking window / metric / baseline / band threshold that flatters HobbyIQ post-hoc
- **UNDERCLAIM:** dismissing prediction layer as "not measurable" and losing forward-projection narrative entirely

Pinning now — corpus shape, completeness counter, join, window, metric, baseline, ±5% band, N thresholds, effect-size requirement, stratifications — defends against both failure modes simultaneously.

---

## 6. Implementation CFs derived from this methodology

| CF | Phase | Estimate | Notes |
|---|---|---|---|
| **`CF-PREDICTION-CORPUS-CARDID-EMISSION`** | **Phase A IMMEDIATE-NEXT — STEP 1 of 3 in the corpus parent** | **S (<2h)** | Thread `cardsightCardId` into the existing `[compiq.prediction_emitted]` event shape. **MUST land before the corpus writer ships, OR the corpus's first rows carry the same broken text-only join the stdout event has today.** |
| `CF-PREDICTION-CORPUS` | **Phase A IMMEDIATE-NEXT — STEP 2 of 3** | **M (2-8h)** | New Cosmos container `prediction_log`, fire-and-forget writer mirroring `trendHistory.service.ts`, dual-emit during burn-in week, then stdout drop. Cold-start corpus — every day delay = lost history. **Depends on STEP 1** (cardId in emission) — otherwise first rows are text-tuple-joined only. |
| `CF-PREDICTION-CORPUS-HEALTH-COUNTER` | **Phase A IMMEDIATE-NEXT — STEP 3 of 3** | **S (<2h)** | Cosmos `prediction_corpus_health` container; in-process counters + 30s periodic flush per replica with volume-gated >1% lossRate alarm (default `attempts > 200` threshold). Drift alarm not exact audit per §2.6. Point-patch around the platform retention hole; eligible for collapse-to-customEvent once CF-PLATFORM-OBSERVABILITY-RETENTION lands. |
| ~~CF-PREDICTION-CORPUS-BACKFILL~~ | DELETED | n/a | Per §1.3 retention finding (~2 events recoverable); cold-start replaces backfill |
| **`CF-PLATFORM-OBSERVABILITY-RETENTION`** (renamed + elevated from CF-FN-COMPIQ-AI-RETENTION-INVESTIGATION) | **PUBLIC-LAUNCH GATE** (elevated from "before scale-up") | M (2-4h investigation + remediation TBD) | Per §1.3 — platform-wide ~30-min retention on both `hobbyiq-insights` AND `fn-compiq` AI means no production observability beyond half an hour for ANY service. Cannot debug a real incident on a launched product handling portfolio + tax data. Diagnose sampling / cost-control / instance config / retention setting; remediate. **Closes before public launch, not before scale-up.** Knock-on effect: bespoke Cosmos counters (§2.6 pattern) become unnecessary across the system once this lands; the corpus health counter is justified for its specific need but resist templating the pattern. |
| `CF-PREDICTION-OUTCOME-JOIN-JOB` | post-launch | M-L | Scheduled Function: per cardId in `prediction_log` with prediction-age > windowDays, pull Cardsight comps in `(prediction.timestamp, prediction.timestamp + windowDays]` and write `prediction_outcomes` join rows |
| `CF-PREDICTION-ACCURACY-DASHBOARD` | post-launch | L | Internal-only dashboard reading `prediction_outcomes` + `prediction_corpus_health` + applying §4 metrics + stratifications (including stable-class-share alongside hit-rate per §4.3); explicitly NOT user-facing in v1 |
| `CF-PREDICTION-CREDIBILITY-PUBLIC-CLAIM` | gated, post-launch | L + product/legal/marketing coord | Once §5.4 thresholds met AND §4.5 effect-size minimum met AND `DIRECTION_BAND_PCT` re-tune commitment per §4.3 has been honored, decide whether/how to surface accuracy claim publicly |

**Sequencing rule:** STEP 1 (emission cardId) MUST complete before STEP 2 (corpus writer). STEP 3 (health counter) can ship parallel with STEP 2 or immediately after. All three together = the corpus parent CF kickoff; one author can ship all three in sequence in a single ~4-6h session.

**Parallelism with contract-freeze implementation:** the corpus stream (STEPs 1-3) touches `compiq` code paths; contract-freeze implementation (CF-PORTFOLIOHOLDING-FIELD-PRUNE, CF-CREATE-HOLDING-FROM-CARD, CF-COMPIQ-CARD-DETAIL-RESHAPE) touches `portfolioiq` + `routes` code paths. Different areas, no functional dependency — corpus stream can run ahead of or parallel to contract-freeze work without merge conflict risk.

**Platform-observability runs separately:** CF-PLATFORM-OBSERVABILITY-RETENTION is an infra/config investigation, not a code area; runs in parallel to both streams above; must close before public launch per the launch-gate framing.

---

## 7. Files read (for methodology basis)

- `backend/src/services/compiq/compiqEstimate.service.ts:2700-2746` — current stdout prediction emission
- `backend/src/services/compiq/forwardProjection.ts:1-77` — `computePredictedPrice` mechanism + `PredictedPriceResult` shape
- `backend/src/services/portfolioiq/portfolioStore.service.ts:1550-1651` — `sellHolding` (manual sale → `PortfolioLedgerEntry`)
- `backend/src/services/portfolioiq/portfolioStore.service.ts:199-256` — `PortfolioLedgerEntry` shape (outcome shape Source A)
- `backend/src/services/playerScore/trendHistory.service.ts:92-142` — `trend_history` writer pattern (Cosmos corpus precedent for §2.2 + §2.6 design)
- `backend/src/services/compiq/cardsight.client.ts:75-82` — `CardsightSaleRecord` shape (outcome shape Source B)
- Live App Insights retention check `2026-05-31T00:25Z` — empirical confirmation of platform-wide ~30-min retention

Audit reference: [`pillar_state_audit_2026-05-30.md`](pillar_state_audit_2026-05-30.md) §SURPRISES #9.
Contract reference: [`contract_freeze_v1_2026-05-30.md`](contract_freeze_v1_2026-05-30.md) §2 — frozen CompIQ card-detail shape includes `prediction` object that this corpus instruments. §3.3 — sync-pricing rationale ties to corpus-write requirement.
Memory anchors invoked: [[product_actionable_seller_intelligence]], [[information_cascade_signal_model]], [[signal_classes_attention_vs_price]], [[compsmomentum_weight_lock]].

---

## 8. Scope discipline upheld

- ✅ Methodology + design only — NO build, NO corpus creation, NO backtest execution
- ✅ Every existing-shape claim cites file:line against actual code
- ✅ Empirical retention finding incorporated honestly (~30-min platform-wide, not just fn-compiq)
- ✅ Backfill dropped explicitly; cold-start urgency replaces it
- ✅ Selection-bias risk surfaced prominently in multiple directions (overclaim AND underclaim)
- ✅ Pinned ALL methodology elements (corpus shape, completeness counter, join, window, metric, baseline, ±5% direction band with edge-case resolution, N thresholds, effect-size minimum, stratifications) BEFORE measurement
- ✅ Completeness counter design defends measurements against silent write loss; Cosmos-based not App-Insights-based
- ✅ Honest framing on data volume: NO defensible public accuracy claim possible at pre-launch state
- ✅ Implementation CFs sized + sequenced — corpus IS Phase A IMMEDIATE-NEXT
- ✅ HALT for review — no commit without sign-off
