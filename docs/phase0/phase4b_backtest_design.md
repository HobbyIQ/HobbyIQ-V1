# Phase 4b backtest harness design — signal-value measurement (CF-PHASE4B-BACKTEST.0)

**Captured:** 2026-05-24 (Phase 4b kickoff sub-workstream follow-up; design only)
**Scope:** Design doc. No code in this commit.
**Predecessor:** [phase4b_diagnostic_findings.md](phase4b_diagnostic_findings.md) (commit 9543ed4)
**Successor (CF-PHASE4B-BACKTEST.1):** implementation session — builds the script + first measurement run.
**Status:** Design complete; load-bearing decision §3 chosen (Option C with planned migration to D); implementer checklist §8 ready for next session to open with "build this."

---

## 0. Critical context — existing backtest harness already exists

This design must be read with the framing-inversion lesson from the predecessor doc in mind. The predecessor found that signal integration was already wired end-to-end despite the roadmap framing Phase 4b as "build it." This doc surfaces a parallel finding:

**A prediction-accuracy backtest harness already exists.** Phase C shipped it.

- `mcp-server/backtest.ts:184` — `runBacktest()` reads predictions ≥7d old from `compiq_predictions`, looks up actual median sale price in 72h and 7d windows from Cardsight comps via `fetchPlayerComps`, computes per-prediction MAE / MAPE / direction-correct, buckets by confidence band, writes results to `compiq_backtest` Cosmos container.
- `mcp-server/server.ts:413` — admin POST `/api/compiq/admin/backtest/run` triggers a scoring pass.
- `mcp-server/server.ts:437` — read-only GET `/api/compiq/backtest/summary` exposes aggregated results.
- `BacktestAdminView.swift` (untracked, iOS) — admin UI for triggering and viewing results.

**What this existing backtest does:** measures whether predictions are accurate, bucketed by confidence band.

**What this existing backtest does NOT do — and is the gap this design addresses:** it does not measure whether signals contribute to that accuracy. Every prediction in `compiq_predictions` was made with signals turned ON (signal integration has been live for the entire prediction-log history). There is no counterfactual signal-OFF group, so no way to attribute accuracy to signals vs to the rest of the prediction stack (anchor price, recent comps, card-level modifiers, GPT-4o reasoning).

**The harness this design proposes is an A/B extension** to the existing scoring infrastructure, not a from-scratch build. Reuse of `fetchPlayerComps`, the Cosmos schemas, and the bucketing logic is the path of least resistance. The framing for CF-PHASE4B-BACKTEST.1 should be "extend the existing backtest with a signal-off comparison arm," not "build a new backtest."

This framing change is load-bearing. If the implementer opens the next session thinking "I need to build a backtest harness," they will rebuild what exists. If they open with "I need to extend backtest.ts with a counterfactual arm," they will land in the right place.

---

## 1. Measurement target — what does "improves accuracy" mean concretely?

The spec offered four candidate measurement frameworks. Selected ones (and rationale):

### 1.1 Selected primary measurement: paired MAPE delta (magnitude-aware)

For each card in the backtest, run prediction twice (signals-on, signals-off) at the **same wall-clock moment** against the **same recent comps**. Compare each prediction's predicted_price_72h and predicted_price_7d against the median actual sale price observed in Cardsight's recent comp history.

```
MAPE_on  = mean(|predicted_with_signals  - actual| / actual) * 100
MAPE_off = mean(|predicted_without_signals - actual| / actual) * 100
delta    = MAPE_off - MAPE_on    # positive means signals HELP
```

**Why MAPE not MAE:** card prices span $5 to $5,000 in the backtest cohort. MAE would let the few expensive cards dominate. MAPE normalizes per-card.

**Why paired:** signal-on and signal-off predictions are made for the *same card at the same time*, so we're measuring a within-pair difference, not a between-cohort difference. Statistical power per sample is much higher (paired t-test / Wilcoxon signed-rank) than a between-groups comparison would be.

### 1.2 Selected secondary measurement: direction accuracy delta

For each prediction, compare `predicted_direction` (rising/falling/stable) to the actual direction inferred from comp evolution. The existing backtest already computes this for the signal-on case (`actualDirection7d` in `backtest.ts:312`). The new arm computes it for signal-off predictions on the same cards.

```
DirAcc_on  = (correct_with_signals / total)    * 100
DirAcc_off = (correct_without_signals / total) * 100
delta      = DirAcc_on - DirAcc_off    # positive means signals HELP direction
```

**Why include this alongside MAPE:** the model output has two channels — a price number and a direction label. Signals could move the price correctly but the direction label wrong, or vice versa. Reporting both prevents a misleading "signals help" conclusion when they only help one channel.

### 1.3 Selected tertiary measurement: confidence calibration delta

For each confidence band (existing buckets: `conf_under_40`, `conf_40_59`, `conf_60_79`, `conf_80_plus`), compute MAPE per arm. A well-calibrated signal-on system should have lower MAPE in higher-confidence bands. A miscalibrated one rates predictions confident that aren't more accurate.

```
For each band b:
  calibration_gap_on  = MAPE(band=b, arm=on)  - MAPE(band=b, arm=off)
```

**Why include this:** signals influence `confidence_reason` and indirectly the confidence number. If signals merely boost confidence without improving accuracy, this measurement catches it.

### 1.4 Deferred (not in first iteration)

- Per-signal calibration: when trends says "rising" with multiplier 1.167, how often does the card actually rise? Requires partial-signal-on capability (§6).
- Time-bucketed MAPE: separate predictions made within 24h of catalyst-window entry vs steady state. Adds variance partitioning that the small sample size won't support.
- ROI-weighted measurement: "if a user sold based on this prediction, how much money was saved/lost?" Requires user behavior signal that doesn't exist today.

### 1.5 Statistical reporting requirement

The doc-only first iteration should report:
- N (sample size, total + per bucket)
- MAPE_on, MAPE_off, delta (mean), delta (median)
- Paired test (Wilcoxon signed-rank) p-value for MAPE delta
- DirAcc_on, DirAcc_off, delta percentage points
- Confidence band breakdown

A p-value is the honest scalar that prevents "signals helped by 1.2 MAPE points on n=23 cards" from being mistaken for a decisive answer.

---

## 2. Outcome data source — where does ground truth come from?

The spec offered three candidates. Selected: **Cardsight comps via `fetchPlayerComps`**, identical to what the existing backtest already uses.

### 2.1 Why not PortfolioLedgerEntry sales?

- Narrow: only cards users have sold through HobbyIQ
- Selection bias: users sell what they think will appreciate (or what they're forced to liquidate), not a representative sample
- Volume: portfolio is not yet populated at meaningful scale (per session-handoff context)

### 2.2 Why not eBay sold-price scraping?

- Its own workstream (Phase 4d scope per roadmap)
- Authentication blocker visible in the predecessor's per-signal credential characterization (ebay signal is auth_failed)
- Adds infrastructure complexity that doesn't pay back for first-iteration measurement

### 2.3 Why Cardsight comps?

- Already in production: `fetchPlayerComps(player, product, {cardYear})` returns a deduped, date-sorted `CardComp[]` array via `/api/compiq/comps-by-player`
- 6h Redis-backed cache means a 100-card backtest pays at most ~one cold-fetch per (player, product) cohort
- Existing backtest's `actualMedian72h` / `actualMedian7d` computation logic is reusable (`backtest.ts:286-296` — `within(postMs)` filter on comp dates)
- Coverage is broad enough for the 7 demo players × 3 products (20+) the cache-warm targets list already exercises

### 2.4 Ground-truth math

For each backtest card at prediction time `t`:
- `actuals_72h` = comp prices with sold-date in `[t, t + 3 days]`
- `actuals_7d`  = comp prices with sold-date in `[t, t + 7 days]`
- `actual_median_72h` = median(actuals_72h) (skip if empty)
- `baseline_30d` = median of comps in `[t - 30 days, t)` — for direction inference

**Critical for §3's chosen mechanic**: in Option C (synthetic backtest), the "prediction time `t`" is "now," and we look BACKWARDS into the comp history — so actuals are already observed by the time we run the backtest. This inverts the temporal direction of the existing backtest (which waits 7d after the prediction for actuals to materialize). See §3 for the consequence.

---

## 3. Backtest mechanic — the load-bearing decision

### 3.1 Selected: Option C primary (synthetic backtest), Option D as evolution path

The spec offered (A) retrospective re-run on existing predictionLog, (B) production A/B, (C) synthetic backtest, (D) hybrid.

**Selected: Option C for first iteration, Option D as the explicit evolution path** once methodology is validated and prediction volume grows.

### 3.2 Why not (A) retrospective re-run on existing predictionLog?

Tempting because predictionLog has data and signal-off counterfactuals can be regenerated by re-prompting OpenAI with `signals = NEUTRAL_SIGNAL`. But:

- **Predictions volume is ~7 rows** (per predecessor diagnostic; CF-COSMOS-ROT context). Statistical power is too thin.
- **Re-running OpenAI today reasons differently than the original moment**: not because GPT-4o changed but because the comps the prompt embeds may have aged. The original prediction's `recentComps` were captured at its `timestamp`; today's `fetchPlayerComps` returns post-prediction sales mixed in. Reconstructing the original input bundle is possible but adds engineering scope.
- **Original predictions already used current signals state**: re-running with signals-off vs original-with-signals-on conflates the signal arm with a 3-month-ago state of the rest of the system.

Option A becomes viable when predictionLog accumulates >100 rows AND when we have a clean way to freeze the prompt-input bundle. Today, neither holds.

### 3.3 Why not (B) production A/B?

Spec correctly identifies: no production traffic to A/B against. Confirmed by predecessor diagnostic + session-handoff context. Not viable for first iteration.

Becomes viable after a real user cohort exists (Phase 5+ scope).

### 3.4 Why C — synthetic backtest from a curated card cohort

**Mechanic in detail:**

1. **Pick a fixed cohort of N=100 (target) cards** spanning the player+product space the system serves. Use the existing `CACHE_WARM_TARGETS` (10 player-product pairs in `compsByPlayer.service.ts:338`) as the seed, expanded with:
   - Multiple cards per player (different parallels, grades, card numbers)
   - Distribution across price tiers ($25-$100 / $100-$500 / $500-$5,000)
   - Distribution across recency (cards with recent comps in last 7d vs in 7-30d)
2. **For each card in the cohort, run prediction twice:**
   - Arm A: signal-on (call `getPredictedPrice(card)` against production `AZURE_SIGNAL_FUNCTION_URL`)
   - Arm B: signal-off (call a variant that short-circuits `fetchSignals` to `NEUTRAL_SIGNAL`)
3. **Both arms use the same `recentComps` array** (passed into the card before either prediction). This is the critical paired-design property.
4. **Ground truth**: for each card, the median of the most-recent N comps (e.g., last 5 sales within the last 14d) is treated as "actual market price." Both arms' predictions are compared to this same value.
5. **Aggregate**: paired MAPE delta + DirAcc delta + confidence band calibration, per §1.

**Critical asymmetry vs the existing backtest:** the existing backtest treats the prediction as the fixed point in time and waits for actuals to materialize after. The synthetic backtest treats *current observed comps* as the fixed ground truth and runs both predictions at "now." This is a different question — "would the prediction system's output reasonably match recently-observed sales right now?" — but it's testable today without aging a new prediction cohort for 7 days.

### 3.5 Why D as evolution path

After Option C produces a first measurement (CF-PHASE4B-BACKTEST.1):
- If C shows signals help: lock in current signals state, then begin a retrospective Option A once predictionLog grows (CF-PHASE4B-BACKTEST.2)
- If C shows signals hurt or are neutral: investigate which signals contribute negatively *before* expanding via A
- Either way, A becomes the longer-horizon validation once the system has enough log volume that re-prompt fidelity becomes the limiting factor, not sample size

D is not "C and A simultaneously." D is "C first to establish methodology, A later to validate at scale."

### 3.6 Risk: Cardsight comp-evolution leakage

In synthetic backtest, "now" comp data includes whatever has happened up to today. If the signals payload references events (e.g., "Chicagoland Sports Card Expo in 13 days") that already affected those recent sales, the signal-on arm has an informational advantage that's *not predictive* but *retrospective*. Implementer should consider:

- Run the synthetic backtest twice: once with current signals (signals reflect today's catalyst calendar), once with signals frozen to a 14-day-old state — if such a snapshot can be reconstructed from `fn-signal-aggregator` blob history. If snapshots aren't preserved, this risk is unmeasurable in iteration 1 and gets a TODO for iteration 2.
- Treat the iteration-1 result as a "ceiling" of signal value (since retrospective leakage can only help the signal-on arm). If signal-on still doesn't beat signal-off under leakage, signals don't help. If it does beat, the win is upper-bounded by what leakage contributed.

This risk doesn't invalidate the methodology; it just bounds how strongly to interpret a positive result.

---

## 4. Where the backtest runs

### 4.1 Selected: standalone script in `mcp-server/scripts/`

Path: `mcp-server/scripts/backtest_signal_value.ts`

**Why standalone over alternatives:**

- **Not backend cron**: overkill for a one-time measurement. The existing `runBacktest()` over Cosmos is already wired into a cron-able admin endpoint, but signal-value measurement is not a continuous-monitoring activity.
- **Not a new mcp-server endpoint**: triggers OpenAI billing on a 100-card cohort (200 calls per run), which we want operator-gated, not HTTP-triggerable.
- **Standalone script**: operator runs it from a terminal, sees output immediately, commits the JSON results blob alongside the markdown report. Lowest friction, most observability.

The script can later be promoted to a backend admin endpoint if needed (CF-PHASE4B-BACKTEST.2), but iteration 1 should be local-only.

### 4.2 Execution shape

```bash
# From mcp-server/ directory:
npx tsx scripts/backtest_signal_value.ts \
  --cohort path/to/cohort.json \
  --output-json output/backtest_2026-05-24.json \
  --output-md   output/backtest_2026-05-24.md
```

- `--cohort` — path to a JSON file listing the 100 cards (or 20 / 50 in pilot runs)
- `--output-json` — machine-readable per-card + aggregate results
- `--output-md` — human-readable summary with tables

Environment variables required (script-time, not committed):
- `AZURE_SIGNAL_FUNCTION_URL` + `AZURE_SIGNAL_FUNCTION_KEY` (for signal-on arm)
- `AZURE_OPENAI_*` or `OPENAI_API_KEY` (for both arms)
- `HOBBYIQ_BACKEND_URL` (for `fetchPlayerComps`)

### 4.3 Why not run signal-on through production /predict?

It's tempting to call MCP's `/predict` endpoint twice (once with signals, once via a hypothetical `?signals=off` flag) and let the production path do the work. Rejected:
- Adds a query-flag concept to the production endpoint that has no other use
- Each call hits production billing in two places (signal + OpenAI)
- The script can call `getPredictedPrice(card)` directly by importing from `pricing.ts`, bypassing the HTTP layer

The signal-off variant: in the script, monkey-patch or branch on a feature flag inside the script — easiest is to call `getPredictedPrice` once normally, then call a thin local function that does everything `getPredictedPrice` does EXCEPT replace `signals` with `NEUTRAL_SIGNAL`. The two paths share the prompt builder and OpenAI client.

---

## 5. What the backtest produces

### 5.1 Per-card pair (signals-on, signals-off)

```jsonc
{
  "cardId": "Mike Trout|2011|Topps Update|US175|PSA 10|base",
  "playerName": "Mike Trout",
  "year": 2011,
  "set": "Topps Update",
  "cardNumber": "US175",
  "grade": "PSA 10",
  "anchorPrice": 3200.00,
  "compsCount": 18,
  "comps_window_used": { "from": "2026-04-10", "to": "2026-05-24", "n": 18 },
  "actualMedian": 3450.00,
  "actualMedian_source": "median of last 5 sales in 14d window",

  "signals_on": {
    "predicted_price_72h": 3380.00,
    "predicted_price_7d":  3520.00,
    "predicted_direction": "rising",
    "confidence": 78,
    "key_drivers": ["...", "..."],
    "risk_flags": ["..."],
    "signal_payload": {
      "final_multiplier": 1.057,
      "signal_flags": ["injury_risk", "pre_show: ..."],
      "components": { "trends": 1.167, "ebay": 1.0, "...": "..." }
    }
  },

  "signals_off": {
    "predicted_price_72h": 3250.00,
    "predicted_price_7d":  3290.00,
    "predicted_direction": "stable",
    "confidence": 72,
    "key_drivers": ["...", "..."],
    "risk_flags": ["..."]
  },

  "deltas": {
    "abs_error_on_72h":  70.00,
    "abs_error_off_72h": 200.00,
    "abs_error_on_7d":   70.00,
    "abs_error_off_7d":  160.00,
    "pct_error_on_72h":  2.0,
    "pct_error_off_72h": 5.8,
    "direction_correct_on":  true,
    "direction_correct_off": null
  },

  "signal_on_wins_72h": true,
  "signal_on_wins_7d":  true
}
```

### 5.2 Aggregate

```jsonc
{
  "run_id": "2026-05-24T18:30:00Z",
  "cohort_size": 100,
  "scored_pairs": 92,
  "skipped": {
    "no_actuals": 6,
    "prediction_failed": 2
  },
  "aggregate": {
    "mape_on_72h":  6.2,
    "mape_off_72h": 8.1,
    "mape_delta_72h": 1.9,
    "mape_on_7d":  7.1,
    "mape_off_7d": 9.8,
    "mape_delta_7d": 2.7,
    "wilcoxon_pvalue_72h": 0.018,
    "wilcoxon_pvalue_7d":  0.004,
    "direction_acc_on":  68.5,
    "direction_acc_off": 54.3,
    "direction_acc_delta": 14.2
  },
  "by_confidence_band": {
    "conf_80_plus":  { "n": 22, "mape_on": 3.4, "mape_off": 5.8, "delta": 2.4 },
    "conf_60_79":    { "n": 31, "mape_on": 6.1, "mape_off": 7.4, "delta": 1.3 },
    "conf_40_59":    { "n": 28, "mape_on": 8.9, "mape_off": 10.2, "delta": 1.3 },
    "conf_under_40": { "n": 11, "mape_on": 11.2, "mape_off": 11.5, "delta": 0.3 }
  },
  "interpretation": {
    "signals_help_72h": true,
    "signals_help_7d":  true,
    "verdict": "Signals improve MAPE by 1.9-2.7 points and direction accuracy by 14.2pp at p<0.02. Repair priority should follow §6 (per-signal attribution) before committing to all-4-credentials investment."
  }
}
```

Numbers above are illustrative. The verdict text is what the implementer composes after the run.

### 5.3 Markdown report

A human-readable digest mirroring the JSON aggregate, plus:
- Top-5 cards where signals helped most (largest positive delta)
- Top-5 cards where signals hurt most (largest negative delta)
- Per-player breakdown
- "What this measurement does not prove" disclaimer

The markdown report is the artifact most likely to be re-read in months. The JSON is for re-aggregation and tooling. Both committed to `docs/phase0/backtest_runs/{run_id}/`.

---

## 6. Per-signal attribution

### 6.1 Deferred to iteration 2

The spec asked whether per-signal attribution is in scope for the first iteration. **Deferred.**

Per-signal attribution would require partial signal-on arms: e.g., "trends-only," "news-only," "stats-only" predictions. This multiplies the OpenAI call cost by N+1 where N is the number of useful signals (currently 3) and changes the cohort design.

For iteration 1, the binary signal-on vs signal-off measurement answers the load-bearing question: do signals help, overall? If yes, iteration 2 attributes the gain. If no or unclear, iteration 2 either ends the line of inquiry or pivots to "which signal hurts."

### 6.2 What iteration 1 captures for iteration 2

The JSON per-card pair (see §5.1) includes the full `signal_payload` at signal-on prediction time, including `components` and `signal_flags`. Post-hoc analysis can correlate per-signal multiplier deviation (distance from 1.0) with per-pair delta — even without partial-arm runs, this gives a weak per-signal contribution estimate. Not as clean as partial arms, but free.

### 6.3 Design constraint on iteration 2

If iteration 2 implements partial arms, the cost is `cohort_size × (N+2)` OpenAI calls where N is the number of useful signals. At 100 cards × 5 arms (off, on, trends-only, news-only, stats-only) = 500 calls per run. At current gpt-4o pricing this is ~$5-10. Not prohibitive, but worth noting before committing.

---

## 7. Sample size

### 7.1 Target: N=100 cards (cohort), expecting ~85-95 scored pairs after skips

Reasoning:
- **10**: noise dominates. Cannot distinguish 2-point MAPE delta from 6-point delta with confidence.
- **30**: directional signal *might* be visible with luck. A 2-point MAPE delta needs paired-test n≥30 to reach p<0.05 with typical noise levels.
- **100**: comfortably enough for paired Wilcoxon to detect deltas as small as 1.5 MAPE points at p<0.05 assuming typical per-card pair-difference std-dev of ~3-5 points.
- **1000**: would be nice; cost-prohibitive at 2x OpenAI calls per card = $20-40 per run.

100 is the smallest cohort size where a "signals help by 2 MAPE points" finding survives statistical scrutiny.

### 7.2 Cohort sourcing

The 10 `CACHE_WARM_TARGETS` give 10 player+product pairs. To reach 100 cards:
- Multiple parallels/grades per player+product (3-5 cards per pair → 30-50)
- Add 5-10 additional players (Bryce Harper, Vladimir Guerrero Jr., Wander Franco, Bobby Witt Jr. expansions, etc.) → 20-30 more
- Add 3-5 catalog cards at different price tiers per existing player → fills to 100

The cohort selection is a one-time exercise during CF-PHASE4B-BACKTEST.1 implementation. The cohort JSON should be committed to repo and reused across runs — same cohort means subsequent runs measure changes, not cohort variance.

### 7.3 Cost estimate per run

- 100 cards × 2 arms = 200 OpenAI calls
- gpt-4o ~$0.01 per call (at typical prompt size) ≈ $2-4 per run
- Cardsight: deduplicated to ~30 unique player+product fetches, mostly served from the 6h cache → near-zero marginal cost
- Total: $2-5 per backtest run

Not a blocker. The constraint is operator attention to compose + interpret results, not cost.

### 7.4 Reproducibility

Each run commits:
- The cohort JSON used (or a hash if cohort is fixed)
- Both arm outputs (per-card)
- The aggregate JSON + markdown
- The git SHA of the prediction code at run time (so re-runs after pricing.ts changes can be compared)

---

## 8. Implementer checklist for CF-PHASE4B-BACKTEST.1

Next session opens with "build this," not "design this." Step-by-step:

### Step 1 — Establish the cohort

- Create `mcp-server/scripts/backtest_cohort_v1.json`
- Seed with the 10 `CACHE_WARM_TARGETS` entries from `compsByPlayer.service.ts:338`
- Expand to N=100 by: 3-5 cards per pair × parallels/grades; add 5-10 new players × 1-3 cards each
- Each cohort entry must specify: `playerName`, `year`, `set` (used as `product` for `fetchPlayerComps`), `cardNumber`, `variant`, `grade`, `isRookie`, `printRun`, `jerseyNumber` (optional), `anchorPrice` (operator-set, can be median of last 30d comps if unknown)
- The cohort is a manual one-time setup; it does not need to be auto-generated

### Step 2 — Write the script

Path: `mcp-server/scripts/backtest_signal_value.ts`

Skeleton (do not commit pseudo-code, this is for the implementer):
```ts
import { getPredictedPrice, type Card, type CardComp } from "../pricing.js";
import { fetchPlayerComps } from "../compsLoader.js";

// Inline NEUTRAL_SIGNAL since pricing.ts doesn't export it.
const NEUTRAL_SIGNAL = { final_multiplier: 1.0, ... };

async function predictSignalsOn(card: Card)  { return getPredictedPrice(card); }
async function predictSignalsOff(card: Card) {
  // Either: (a) temporarily clear AZURE_SIGNAL_FUNCTION_URL before the call
  // and restore after — simple but mutates global state; or
  // (b) refactor pricing.ts to accept an optional signals override:
  //      getPredictedPrice(card, { signalsOverride: NEUTRAL_SIGNAL })
  //   This (b) approach is cleaner and worth a 1-line pricing.ts change.
}

for (const cohortEntry of cohort) {
  const comps = await fetchPlayerComps(cohortEntry.playerName, cohortEntry.set, { cardYear: cohortEntry.year });
  // De-dupe to "actuals window" (last 14d) and "prediction-input window" (rest).
  // ⚠ This is the critical implementation point — see §8 substep on data-window split.
  ...
}
```

### Step 3 — Data-window split (critical implementation point)

To prevent ground-truth leakage into the prediction input, the script must split each card's comp history into two non-overlapping windows:

- **Prediction input** (`recentComps` array passed into `Card`): comps from `[now - 60 days, now - 14 days]`
- **Ground truth** (`actualMedian` target): median price of comps from `[now - 14 days, now]`

The 14-day cutoff is a choice (could be 7d or 21d). The point is that the prediction never sees the comps it's being scored against. Without this split, the prediction has a copy of the answer in its input.

Note: this differs from the existing `mcp-server/backtest.ts` model, which assumes the prediction is the fixed time point and actuals materialize after. The synthetic backtest is "now-based" and must enforce the split manually.

### Step 4 — Run the cohort + collect results

- Iterate cohort entries, for each: build the `Card` object with split comps, call both prediction arms, score against `actualMedian`
- Skip entries where the 14-day ground-truth window has zero comps (no actual to compare to)
- Skip entries where either prediction throws (log the error in the JSON output)
- Accumulate per-card pairs into the output JSON

### Step 5 — Aggregate + statistical test

- Compute MAPE per arm
- Compute paired Wilcoxon signed-rank p-value (small dependency: write the test manually — it's ~30 lines of TS — or import from a stats library)
- Compute direction accuracy per arm
- Bucket by confidence band

### Step 6 — Compose the markdown report

Format: see §5.3. Specifically, the "verdict" line at the bottom should be operator-written, not formulaic — it interprets the aggregate in context.

### Step 7 — Commit + write up findings

- Commit `mcp-server/scripts/backtest_signal_value.ts`
- Commit `mcp-server/scripts/backtest_cohort_v1.json`
- Commit `docs/phase0/backtest_runs/2026-MM-DD/` with both JSON + MD
- Update `docs/SESSION_HANDOFF.md` with the verdict
- DO NOT modify production `pricing.ts` based on the result. CF-SIGNAL-CREDENTIAL-REPAIR is downstream of this.

### Step 8 — Interpret

| Aggregate outcome | Interpretation | Next workstream |
| --- | --- | --- |
| MAPE delta > 2 points, p < 0.05 | Signals materially help | CF-SIGNAL-CREDENTIAL-REPAIR is justified; prioritize the highest-weighted degraded signals (ebay 0.20) |
| MAPE delta 0.5-2 points, p < 0.05 | Signals marginally help | Per-signal attribution (iteration 2) before broad repair |
| MAPE delta < 0.5 or p > 0.05 | Signals don't move the needle | Investigate WHY — is OpenAI ignoring the signal context? Is the prompt rendering buried? CF-PHASE4B-PROMPT-AUDIT becomes a new CF |
| MAPE delta < 0 (signal-off wins) | Signals HURT | Halt CF-SIGNAL-CREDENTIAL-REPAIR; signal-on path needs forensics. CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS becomes the immediate next workstream |

### Step 9 — Budget

- Cohort assembly: 60-90 min (mostly operator card-selection, not engineering)
- Script implementation: 90-120 min
- Run + diagnosis + write-up: 60-90 min
- Total: 4-5 hour implementation session

If exceeded by 150%, HALT with partial result (e.g., n=20 pilot run) committed as iteration-0.

---

## 9. What this design does NOT do

- **Doesn't implement the backtest.** That's CF-PHASE4B-BACKTEST.1.
- **Doesn't repair degraded signals.** That's CF-SIGNAL-CREDENTIAL-REPAIR, downstream of the iteration-1 verdict.
- **Doesn't change production signal integration.** The backtest is observational. Production `pricing.ts` is not modified except possibly a 1-line refactor to accept an optional `signalsOverride` (Step 2 substep b).
- **Doesn't address Phase 4c ML training pipeline.** ML training requires a labeled dataset that *this* backtest could contribute to, but designing the training pipeline is separate scope.
- **Doesn't extend the existing backtest harness in `mcp-server/backtest.ts`.** The synthetic backtest is a parallel artifact in `scripts/`, not an extension of the Cosmos-resident harness. A future merge (where the existing harness gains a counterfactual arm) is possible but deferred — keeping the synthetic backtest standalone is the lower-risk first step.
- **Doesn't claim the result will be positive.** The whole point is to measure honestly, including the case where signals don't help.
- **Doesn't propose a production A/B.** Option B becomes available when user traffic exists. Not in iteration 1's scope.

---

## 10. Risks and open questions

### 10.1 Cardsight retrospective leakage (carry-forward from §3.6)

Cardsight comps include catalysts (show timing, news events) that the signal-on payload also references. Synthetic backtest at "now" cannot fully decorrelate. Iteration 1 measures the *upper bound* of signal value; a more rigorous iteration 2 would freeze signal snapshots to 14-day-old state if `fn-signal-aggregator` blob history is preserved (open question: is it?).

### 10.2 OpenAI nondeterminism

Two calls to gpt-4o with the same prompt return different completions. `getPredictedPrice` does not set `temperature: 0` or `seed`. For paired-design backtest:
- The paired-design within-card delta partially controls for this (both arms see the same nondeterminism source)
- Still, single-run variance is meaningful. Recommendation: re-run the cohort 3x and aggregate — if `cohort_size × 2 × 3 = 600 calls` ≈ $6-12 per full assessment, this is affordable
- The implementer should make the script accept `--repeats N` and aggregate across repeats

### 10.3 Signal-off arm contamination

The signal-off arm replaces `signals` with `NEUTRAL_SIGNAL`, but the prompt still mentions signals in static text — the signal section is rendered as 1.0x for all components, but the prompt structure itself ("Live Market Signals...", "Signal Breakdown..." headers) signals to GPT-4o that signal context is normally present. The signal-off arm therefore measures "signals replaced with NEUTRAL_SIGNAL," not "no signal context whatsoever." Worth noting in the writeup.

### 10.4 Ground-truth window choice (7d vs 14d vs 21d)

The 14-day actuals window in §8 Step 3 is a guess. Real-world card prices can move 5-10% in a week. Wider window = more samples per ground-truth median = less per-card noise, but stale relative to the prediction. The implementer should A/B the window choice (run with 7d, 14d, 21d windows on the same cohort) and pick the one with lowest signal-off MAPE (since wider/narrower changes the baseline more than the signal arm).

### 10.5 Outcome-source selection bias

Cardsight comps are biased toward what people *sell* on tracked platforms (eBay, PWCC, Goldin). Bottom-of-market cards that don't transact often are underrepresented. Iteration 1 cohort skews mid-to-high-end intentionally (player+product cohort overlaps cache-warm targets).

### 10.6 Confidence calibration interpretation

If iteration 1 finds signal-on has BETTER calibration (higher-confidence bands more accurate) AND lower aggregate MAPE, the signal value story is clean.

If iteration 1 finds signal-on has BETTER calibration but signal-OFF has lower aggregate MAPE, the interpretation is messy: signals improve "knowing when to be confident" but hurt the price number itself. Operator must resist the urge to collapse this into "signals help" or "signals hurt" — it's two different findings.

### 10.7 Open question: should the existing `mcp-server/backtest.ts` get a signal-on/off field too?

Today, every Cosmos-resident prediction was signal-on. If `predictionLog.ts` started recording `signalsActive: true|false` per prediction, future Option-A retrospective backtests could partition. Adding this field is a 5-line change to `predictionLog.ts` + `pricing.ts`, but doesn't matter for iteration 1 (Option C). Captured here for iteration 2 / Option A migration.

### 10.8 Open question: is the existing backtest's confidence-band bucketing the right primary view?

The existing harness buckets by confidence. The new measurement might be more usefully bucketed by `signal_flags` presence (e.g., predictions where `injury_risk` flag fired vs not). Implementer should consider adding an alternative bucketing in §5.2 if confidence-band shows uniformity.

---

## Anti-drift note

The predecessor doc's anti-drift warning was: don't repair signals before measuring. This doc's anti-drift warning is: **don't expand the measurement before producing iteration 1's first verdict.**

It's tempting to design partial-signal arms, multi-cohort runs, time-bucketed splits, etc. before the first measurement exists. Resist. Iteration 1 with a clean N=100 cohort and a binary on/off comparison is the right unit. Everything in §6 and §10 is iteration 2+ scope and should not bleed forward.

The next session opens with the cohort JSON + the script + the run + the report — nothing more. If the verdict is "signals help, p<0.05," the next session AFTER that is per-signal attribution OR credential repair. If the verdict is "signals don't help" or "signals hurt," the next session is a forensics one.

One measurement at a time.
