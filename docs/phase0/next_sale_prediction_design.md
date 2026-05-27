# CF-NEXT-SALE-PREDICTION-LAYER — Design

**Date:** 2026-05-27
**Status:** Design phase. Read-only investigation; no code changes.
**Strategic decision (locked):** ship BOTH `fairMarketValue` (existing) AND `predictedPrice` (new) as distinct fields. Additive, not replacement.
**Authorization gate:** implementation requires separate user approval after design lock.

**Scope reminder:** Phase 5 portfolio integration investigation surfaced that `currentValue` derives from `fairMarketValue` — a trend-adjusted historical FMV, not a strict forward-looking next-sale prediction. The "next-sale prediction is the moat" strategic framing requires an explicit predicted-price layer. This CF designs that layer.

---

## 1. Current state characterization (Phase 1)

### 1a. Mechanism 1 — `computeMultiplierAnchoredPredictedPrice`

[`backend/src/agents/multiplierAnchoredPredictedPrice.ts`](../../backend/src/agents/multiplierAnchoredPredictedPrice.ts) (~395 lines).

**Math:** anchor-based curated multiplier lookup.

```
predictedPrice = anchorPrice × subjectEntry.multiplierRange (low to high)
where:
  anchorPrice  = median of selected anchor comps' prices
  multiplierRange = curated [low, high] from Bowman Family table for (product, subset, parallelName)
```

**Anchor selection** (in priority order):
1. Same-product Refractor /499 with ≥3 comps within 90 days
2. Same-product lowest-print-run with ≥3 comps
3. Related-product (Bowman Chrome ↔ Bowman Draft) Refractor /499 with ≥3 comps

**Domain restrictions (critical):**

- Only fires for **Bowman family** products: `Bowman`, `Bowman Chrome`, `Bowman Draft` (per `inferProduct` lines 91-97)
- Only for **specific subsets**: `Chrome Prospect Autographs`, `Chrome Rookie Autographs`, `Chrome Prospects`, `Chrome Base` (per `inferSubsetFromTitle` lines 99-110)
- Requires curated multiplier table entry for the subject's (product, subset, parallelName) triple
- Requires ≥3 anchor comps within 90 days
- Requires ≥3 distinct curated peer parallels in the pool

**Where it fires today:**

- `compiqEstimate.service.ts:1580` (variant-mismatch fallback)
- `compiqEstimate.service.ts:1748` (no-recent-comps thin-data fallback)

**Confidence formula:** `countScore(≤45) + recencyScore(10-30) + varianceScore(5-25) - crossPenalty(0 or 8)`. Cap 100.

**Critical limitation for design:** Mechanism 1 cannot be extended to all holdings. The Maddux 1987 Topps Traded (Topps, not Bowman), Trout 2011 Topps Update (Topps, not Bowman), Mike Trout 2021 Topps Chrome (Chrome Base but flagship product line) are all OUT OF DOMAIN. Returns `null` with `failureReason: "uncurated-subject-parallel"`. So Mechanism 1 ≠ a general predictedPrice path.

### 1b. TrendIQ — forward-looking composite multiplier (already computed, not used in pricing)

[`backend/src/services/compiq/trendIQ.compute.ts`](../../backend/src/services/compiq/trendIQ.compute.ts) (~365 lines).

**Output shape** ([trendIQ.types.ts:93-105](../../backend/src/services/compiq/trendIQ.types.ts#L93-L105)):

```ts
interface TrendIQResult {
  composite: number;          // "Forward-looking composite multiplier, clamp(0.70, 1.50)"
  direction: "up" | "flat" | "down";   // ±3% deadband
  impliedPct: number;         // round((composite - 1) * 100, 1)
  components: { playerMomentum, cardTrajectory, segmentTrajectory };
  weights: TrendIQWeights;
  coverage: TrendIQCoverage;   // "full" | "no_segment" | "no_card" | "player_only" | "card_only" | "segment_only" | "insufficient"
  lastUpdated: string | null;
}
```

**Three layers:**

- **L1 playerMomentum** — from `fetchPlayerSignals` aggregator (8 sub-components: compsMomentum, reddit, trends, youtube, news, stats, odds, ebay). Outputs a final multiplier per player based on cascade-tier signals
- **L2 cardTrajectory** — card-level comp window comparison: median of [0,14d] sales vs median of (14,45d] sales. Clamped pctChange ±50%, converted to multiplier clamp [0.70, 1.50]. Requires ≥2 comps in each window
- **L3 segmentTrajectory** — sibling-pool trajectory (last-sale-anchored). Similar window logic over the broader sibling pool

**Weighted composite** via 8-row availability matrix:

| Coverage key (p,c,s bits) | playerMomentum | cardTrajectory | segmentTrajectory |
|---|---:|---:|---:|
| `111` (full) | 0.20 | 0.40 | 0.40 |
| `110` (no_segment) | 0.30 | 0.70 | 0.00 |
| `101` (no_card) | 0.30 | 0.00 | 0.70 |
| `100` (player_only) | 1.00 | 0.00 | 0.00 |
| `011` (full no L1) | 0.00 | 0.50 | 0.50 |
| `010` (card_only) | 0.00 | 1.00 | 0.00 |
| `001` (segment_only) | 0.00 | 0.00 | 1.00 |
| `000` (insufficient) | — | — | — (composite = 1.0, direction = flat) |

**Composite computation:**

```
rawComposite = sum(weight_i × component_multiplier_i)
composite = clamp(rawComposite, 0.70, 1.50)
direction = "down" if < 0.97; "up" if > 1.03; else "flat"
```

**Status today:** TrendIQ is computed on every `/api/compiq/estimate` call and surfaced on the response (`trendIQ` field at [compiqEstimate.service.ts:2606](../../backend/src/services/compiq/compiqEstimate.service.ts#L2606)). It **does NOT multiply** `fairMarketValue`. It is a read-only diagnostic field — exactly the missing "forward-looking signal-derived projection layer" this CF wants to operationalize.

### 1c. `blendedTrendMultiplier` — already embedded in fairMarketValue

[`PricingPipeline.ts:207-300`](../../backend/src/modules/compiq/services/pricing/core/PricingPipeline.ts#L207-L300).

```
blendedTrendMultiplier = clamp(0.5, 2.5, 0.75 × longTermMultiplier + 0.25 × shortTermMultiplier)

longTermMultiplier  = recency-weighted ratio of all-comp prices to anchor median
shortTermMultiplier = lateMedian (last-30% bucket) / earlyMedian (first-30% bucket)
+ same-card-momentum boost when ≥3 same-card sales in last 14 days (blend weight 0.35-0.65)
+ ascending-detection override when last 5 sales strictly rising
```

**Inputs:** ONLY comp history. No external signals (no Reddit, Trends, news, etc.). Pure backwards-looking from comp data.

**Implication:** `fairMarketValue` already has internal-comp trend baked in but NO external-signal forward projection. The latter is what TrendIQ provides separately.

### 1d. Signal infrastructure — cascade-tier forward signals

[`backend/src/services/signals/signals.types.ts`](../../backend/src/services/signals/signals.types.ts) defines `SignalPayload`:

| Component | Class (per cascade model) | Lag profile |
|---|---|---|
| compsMomentum | price-class | <7d (real transactions) |
| ebay | price-class | <7d |
| news | price-class | <7d |
| reddit | attention-class | 3-10 weeks (cascade: insider → beat writers → engaged fans → buyers) |
| trends | attention-class | 3-10 weeks |
| youtube | attention-class | 3-10 weeks |
| stats | hybrid | varies |
| odds | hybrid | varies |
| Show/release/playoff/career-arc | context modifiers | event-driven |

Plus aggregator-level `final_multiplier` and `predicted_direction` ("rising"/"falling"/"stable").

**Already wired into TrendIQ L1 (playerMomentum).** External signal infrastructure is the existing forward-looking primary input.

### 1e. Summary of what already exists

| Asset | Status | Forward-looking? |
|---|---|---|
| `fairMarketValue` (success path) | computed, stored on holding | partly — internal-comp trend, no external signals |
| `predictedPrice` (Mechanism 1) | computed in 2 fallback paths only; domain-restricted to Bowman family prospects | yes — curated multiplier table |
| `trendIQ.composite` | computed on every estimate, on response shape, NOT used in pricing | YES — combines signals + comp trajectory |
| `signal aggregator` | wired to TrendIQ L1 via `fetchPlayerSignals` | YES — 8 component signals + context modifiers |
| `broaderTrend.impliedTrendPct` | computed for trendIQ L3 | YES (sibling-pool) |

**The forward-looking infrastructure already exists.** It's just not multiplying `fairMarketValue`. The CF is about wiring it through.

---

## 2. Design options for `forwardProjectionFactor` (Phase 2)

### Option A — Mechanism 1 extended to success path

Use `computeMultiplierAnchoredPredictedPrice` for all holdings, not just fallback paths.

**Implementation:** call Mechanism 1 in the success path; populate `predictedPrice` from its result; fall back to fairMarketValue when Mechanism 1 returns null (out of domain).

**Pros:**
- Existing code, no new mechanism
- Curated multiplier table is the most principled forward projection (anchor × peer-derived multiplier range)

**Cons:**
- **Domain restriction is fatal.** Mechanism 1 only handles Bowman family + Chrome Prospect/Rookie subsets. Production holdings show 9-10 live cards: most are Topps, Topps Update, Topps Chrome, Bowman Chrome non-prospect — all OUT OF DOMAIN
- For ~all production holdings, Mechanism 1 returns `null` → `predictedPrice` falls back to `fairMarketValue` → predictedPrice ≡ fairMarketValue. **Defeats the purpose of having two fields**
- Extending Mechanism 1's curator table to cover all products is a multi-month catalog effort, not in scope

**Implementation scope:** ~30 min wiring + a curator-table-coverage problem that's effectively unbounded
**Risk:** zero new code risk; structural usefulness near-zero for current cohort
**Testability:** existing Mechanism 1 tests cover the function; integration test for success-path wiring needed
**ML training data:** Mechanism 1's `predictedPriceAttribution` already includes anchor/multiplier metadata — good signal-rich training tuple where it fires; sparse otherwise

### Option B — TrendIQ-driven projection layer on top of FMV (RECOMMENDED)

Multiply existing fairMarketValue by a bounded TrendIQ-derived factor.

**Formula:**

```
forwardProjectionFactor = clamp(0.80, 1.30, trendIQ.composite)
predictedPrice = round2(fairMarketValue × forwardProjectionFactor)
```

Optional refinement: scale TrendIQ's [0.70, 1.50] range down to [0.80, 1.30] (squash extremes) before multiplying:

```
forwardProjectionFactor = 1 + (trendIQ.composite - 1) × 0.6   // 60% of TrendIQ's implied move
```

This conservative scaling acknowledges that even a high-confidence TrendIQ signal shouldn't move predicted prices ±50% — the system shouldn't claim a price will jump 50% in the next week.

**Pros:**
- **Uses existing TrendIQ infrastructure** — already computed every call, already wires in the signal aggregator, already exposed on response
- **Generalizes to all products/grades/parallels** (TrendIQ doesn't care about Bowman-family restriction)
- **Bounded by design** — clamp prevents runaway predictions
- **Graceful degradation** — when TrendIQ coverage is "insufficient" (no playerMomentum / cardTrajectory / segmentTrajectory available), composite = 1.0 → predictedPrice = fairMarketValue (defaults to FMV, never worse than FMV)
- **Distinguishable from FMV** — when TrendIQ has real signal, composite varies in [0.70, 1.50] which translates to meaningful predicted-price differences (±30% bounded)
- **Tracks cascade-tier signals** — L1 playerMomentum picks up Reddit/Trends/YouTube attention 3-10 weeks ahead per the cascade model
- **Movement signal already inherent** — TrendIQ.direction maps directly to dashboard "▲/▼/—" indicator without additional computation

**Cons:**
- For variant cohort with thin comp data (low TrendIQ coverage), forwardProjectionFactor stays ≈1.0 → predictedPrice ≈ fairMarketValue. The "two fields" benefit is muted for cards where we have the least confidence anyway
- Doesn't replace Mechanism 1's curated multiplier-table approach for Bowman prospect autos (so the fallback paths still use Mechanism 1, success path uses TrendIQ-derived)
- The 0.6 scaling factor is a hyperparameter — needs calibration

**Implementation scope:** ~20 lines in computeEstimate (compute factor, multiply, populate predictedPrice/range/attribution). Tests ~50 lines.
**Risk:** bounded by clamp; coverage="insufficient" → 1.0 → no divergence from FMV
**Testability:** straightforward — given TrendIQ.composite value, predictedPrice = fairMarketValue × factor is deterministic
**ML training data:** rich. Each prediction logs `{fairMarketValue, predictedPrice, trendIQ.composite, trendIQ.components, trendIQ.coverage}` → eventually `{actual next sale, days-to-sale}` once observed. Perfect tuple for ML training

### Option C — Separate prediction mechanism (from scratch)

Build a new `computePrediction` that takes raw inputs and produces a forward number, decoupled from FMV computation.

**Sketch:**

```ts
function computePrediction(input: {
  comps: Comp[],
  signals: SignalPayload,
  context: { holdingAge, lifecycle, ... }
}): { predictedPrice, range, attribution, confidence }
```

**Pros:**
- Explicit prediction logic, separate concern from FMV
- Room for ML-trained model if/when training data accrues
- Forward-looking is the design goal, not a layer on top of backwards-looking

**Cons:**
- Largest scope — new mechanism, new types, new tests
- Risks duplicating FMV math (anchor selection, comp filtering, weighting) without strong justification
- For a v1 ship, premature — we don't have the training data yet to validate a from-scratch mechanism is better than Option B
- Doesn't leverage TrendIQ work that's already done

**Implementation scope:** ~3-5h
**Risk:** unbounded; new code path; calibration unknown
**Testability:** new test surface; harder to test against existing baselines
**ML training data:** could be designed for ML-friendliness from the start, but no ML training pipeline exists yet anyway

### Option D — Honest placeholder

`predictedPrice = fairMarketValue` everywhere (identical values; both fields just for API shape).

**Pros:**
- Smallest scope: 1 line, no real computation
- Architectural shape (two fields) exists; implementation deferred
- iOS can wire to predictedPrice now; later mechanism changes are invisible

**Cons:**
- **Not a real prediction.** Two fields with identical values is documentation lies
- Defeats the strategic framing ("next-sale prediction is the moat")
- Dashboard claiming "predicted next sale" while showing FMV is the same problem we're trying to solve

**Implementation scope:** 5 min
**Risk:** product-positioning risk (claim vs reality)
**Testability:** trivially testable
**ML training data:** useless (predictedPrice carries no signal beyond fairMarketValue)

---

## 3. Recommendation (Phase 3)

**Recommend Option B — TrendIQ-driven projection layer on top of FMV.**

Reasoning:

1. **Uses already-built infrastructure.** TrendIQ is computed every estimate call, already wires in the signal aggregator + comp trajectory + sibling-pool trajectory. The work needed is wiring, not new computation.

2. **Generalizes to all products.** Unlike Mechanism 1's Bowman-family restriction, TrendIQ runs for any holding with enough comp/signal data.

3. **Bounded by design.** The `clamp(0.80, 1.30)` outer bound + the `× 0.6` conservative scaling factor prevent runaway predictions. Empirically the worst case is ±18% movement (`(1.50-1.0) × 0.6 = 0.30 → 30% from TrendIQ's edge; 0.6 × 0.30 = 0.18 → 18% bound`). For comparison, fairMarketValue's blendedTrendMultiplier already has internal comp-trend that can swing 50-150%.

4. **Graceful degradation.** TrendIQ coverage="insufficient" → composite=1.0 → predictedPrice = fairMarketValue. The system never claims a prediction beyond what its inputs support. Holdings with thin data get FMV as their best-available forward signal — honest framing.

5. **Distinguishable from FMV where it matters.** For holdings with strong TrendIQ signal (player on a hot streak per Reddit + recent comp uptrend + sibling-pool momentum), predictedPrice can diverge from fairMarketValue by ±18%. That's the moat: capturing forward signal that pure backward FMV misses.

6. **Keep Mechanism 1 in fallback paths.** When fairMarketValue is null (variant-mismatch, no-recent-comps), Mechanism 1's curated multiplier-anchored predictedPrice continues to fire. Attribution makes which mechanism shipped the prediction explicit.

7. **ML training-friendly.** Each prediction emits a rich tuple `{fairMarketValue, predictedPrice, trendIQ.composite, trendIQ.components, trendIQ.coverage}` that becomes a training row once the actual next sale lands. Builds the training corpus from day 1.

### Will predictedPrice meaningfully differ from fairMarketValue?

**For variant cohort (thin data):** No, predictedPrice will hover near fairMarketValue. The 5 variant-mismatch + 9 no-recent-comps holdings will see predictedPrice = fairMarketValue (or null = null) for the most part. **This is correct behavior** — we don't have signal to project from.

**For data-rich holdings (Mike Trout, Aaron Judge, Bobby Witt Jr level):** Yes, predictedPrice can diverge ±10-18%. Example: if Reddit attention is surging on a player (L1 playerMomentum = 1.30) but comp-history trend is flat (L2 = 1.0) and segment is flat (L3 = 1.0):
- coverage=`111`, weights {0.20, 0.40, 0.40}
- rawComposite = 0.20×1.30 + 0.40×1.0 + 0.40×1.0 = 0.26 + 0.40 + 0.40 = 1.06
- composite = 1.06 (clamp passes)
- factor (scaled): 1 + (1.06 - 1) × 0.6 = 1.036
- predictedPrice = fairMarketValue × 1.036 → 3.6% upward

For a $100 holding, predictedPrice = $104, FMV = $100. Small but real — and exactly what the cascade hypothesis suggests (early Reddit signal precedes 3-10 week price move).

### Thin-data handling

Preserved: variant-mismatch and no-recent-comps short-circuits keep using Mechanism 1 for `predictedPrice`. Success path uses fairMarketValue × TrendIQ factor. Either way, `predictedPrice` is populated where data supports it; `null` where it doesn't.

### Prediction accuracy expectation

**Better than naive "no change" baseline?** Likely yes, but unmeasured today. The cascade-tier hypothesis says attention signals lead price moves by 3-10 weeks; if true, integrating L1 playerMomentum into predictedPrice captures upside the FMV doesn't see.

**Better than current fairMarketValue?** Unknown empirically. Could be worse if signals are noisy. **This is what CF-VARIANT-FILTER-BACKTEST already validated for the variant filter case (Q7 deferred to dedicated harness) — we'd need a similar paired backtest harness for next-sale prediction accuracy.**

Honest framing: ship as v1, log rich tuples for ML, validate via backtest harness once enough actual-next-sale data accumulates.

### Implementation sketch

```ts
// In computeEstimate's success-path return path, after trendIQ is computed:
const TRENDIQ_SCALING = 0.6;  // conservative: 60% of TrendIQ's implied move
const FORWARD_PROJECTION_MIN = 0.80;
const FORWARD_PROJECTION_MAX = 1.30;

const forwardProjectionFactor = (() => {
  if (trendIQ.coverage === "insufficient") return 1.0;
  const scaled = 1 + (trendIQ.composite - 1) * TRENDIQ_SCALING;
  return clamp(FORWARD_PROJECTION_MIN, FORWARD_PROJECTION_MAX, scaled);
})();

const predictedPrice = typeof fairMarketValue === "number"
  ? round2(fairMarketValue * forwardProjectionFactor)
  : null;

const predictedPriceRange = predictedPrice != null
  ? { low: round2(predictedPrice * 0.92), high: round2(predictedPrice * 1.08) }
  : null;

const predictedPriceAttribution = predictedPrice != null
  ? {
      mechanism: "trendiq-projection",
      forwardProjectionFactor,
      trendIQComposite: trendIQ.composite,
      trendIQDirection: trendIQ.direction,
      trendIQCoverage: trendIQ.coverage,
    }
  : { mechanism: "unavailable" };
```

Persistence on holding (in autoPriceHolding): write `predictedPrice` + `predictedPriceRange` + `predictedPriceAttribution` alongside the existing fairMarketValue/quickSaleValue/premiumValue fields.

---

## 4. Open design questions (Phase 4)

Surface for lock before implementation:

1. **Persistence model.** Store `predictedPrice` on the holding (mirror fairMarketValue), or compute fresh on each /api/portfolio read? Recommendation: **store on holding via autoPriceHolding** — consistent with FMV storage pattern, avoids re-firing /estimate on every dashboard fetch. Same staleness profile as currentValue (refreshed by scheduled reprice + pull-to-refresh).

2. **Response shape & iOS surfacing.** The success-path return currently sets `predictedPrice: null, predictedPriceRange: null, predictedPriceAttribution: null` ([compiqEstimate.service.ts:2602-2604](../../backend/src/services/compiq/compiqEstimate.service.ts#L2602-L2604)). Implementation populates these. iOS Phase 5 dashboard needs to know: where to show predictedPrice vs fairMarketValue? Options: (a) two stats side-by-side ("Current: $96 / Predicted: $99"), (b) primary number = predictedPrice + secondary "(FMV: $96)", (c) toggle. Lock with Drew before iOS work.

3. **Movement signal definition.** Phase 5 dashboard shows movement (up/flat/down) per holding. Two natural sources:
   - `trendIQ.direction` (forward-looking, derived from the same composite that produces predictedPrice — internally consistent with the new prediction)
   - delta `(predictedPrice - fairMarketValue) / fairMarketValue` thresholded ±3%
   These will mostly agree. Recommendation: use **`trendIQ.direction` as the canonical movement signal**, since it's the underlying signal regardless of what the prediction layer does with it.

4. **Backtest semantics.** CF-VARIANT-FILTER-BACKTEST measures rescue rate + tier MAPE vs reference comp median. The next-sale prediction needs a DIFFERENT backtest: predictedPrice (at time T) vs actual next sale (at time T+N days). The existing signal-value backtest harness ([mcp-server/scripts/backtest_signal_value.ts](../../mcp-server/scripts/backtest_signal_value.ts)) already does this for OpenAI predictions — could be adapted to measure predictedPrice accuracy specifically. Probably a follow-up CF: **CF-NEXT-SALE-PREDICTION-BACKTEST**.

5. **ML training pipeline schema.** Future ML model needs `{predictedPrice, actual_next_sale, days_to_sale, fairMarketValue, trendIQComposite, components, coverage, holding_context, asOf}` tuples. Existing `compiq_predictions` Cosmos container is the natural home but its current schema may not fit. Recommendation: design the training-corpus extension as **CF-PREDICTION-CORPUS** follow-up; for now log emit a structured event on every prediction so the data starts accumulating from day 1, even without the formal corpus storage.

6. **Threshold + UI affordance for "stale" prediction.** TrendIQ.lastUpdated reflects when signals were last refreshed. If lastUpdated is >7 days old, the predictedPrice is partly stale. Should the response include a freshness indicator and should the dashboard surface "Predicted: $X (signals from 9 days ago)"? Lock before iOS work.

7. **Naming.** `predictedPrice` vs `predictedNextSalePrice` vs `forwardEstimate` vs `nextSalePrediction`. The current field name `predictedPrice` is already in the response shape (just null on success). Recommendation: **stick with `predictedPrice`** to avoid response-shape churn; document semantics in the API doc.

---

## 5. Cross-references

- [polluted_metadata_holdings_investigation.md](polluted_metadata_holdings_investigation.md) — earlier investigation that surfaced the FMV vs prediction ambiguity at the field-name layer
- [variant_filter_loosening_design.md](variant_filter_loosening_design.md) — sibling CF that landed Q7 deferral via CF-VARIANT-FILTER-BACKTEST; same harness-vs-question structural lesson applies here
- [trendiq_design.md](trendiq_design.md) (if exists) — original TrendIQ design phase reference
- [compiqEstimate.service.ts](../../backend/src/services/compiq/compiqEstimate.service.ts) — success-path return at line 2594-2606 is the implementation site
- [multiplierAnchoredPredictedPrice.ts](../../backend/src/agents/multiplierAnchoredPredictedPrice.ts) — Mechanism 1 (preserved for fallback paths)
- [trendIQ.compute.ts](../../backend/src/services/compiq/trendIQ.compute.ts) — TrendIQ computation
- [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) — Phase 5 portfolio integration investigation that surfaced this CF
