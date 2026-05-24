# Per-grade signal interaction diagnostic

**Captured:** 2026-05-24 (post WS2 N=15×5 multi-run results at eb0c7ff)
**Scope:** Read-only diagnostic. Catalogs evidence, characterizes architecture, picks diagnosis. No code changes.
**Predecessor:** [phase4b_diagnostic_findings.md](phase4b_diagnostic_findings.md) + addendum at e26db5d; [phase4b_backtest_design.md](phase4b_backtest_design.md) at b90aa4a; WS2 multi-run results at [backtest_runs/20260524-224322-n15-r5/](backtest_runs/20260524-224322-n15-r5/).
**Trigger:** WS2's per-card pattern (0 stable helpers, 6 stable hurters, 8 flippers across 5 runs) was more decisive than the aggregate. Hypothesis surfaced: per-player signal multiplier doesn't capture per-grade demand-driver differences.

---

## 1. Context

WS2 ran the synthetic backtest 5 times against the same N=15 cohort. Aggregate verdict was `unstable_high_variance` (sign stability 0.4 on MAPE delta 7d). Per-card consistency told a sharper story:

- **0** stable signal-helpers (no card with signal-on win-rate ≥ 70%)
- **6** stable signal-hurters (Judge PSA 10, Ohtani raw + PSA 10, Acuna PSA 10, Skenes raw + PSA 10)
- **8** flipping cards (signal-on wins 31-69% of runs)

The 6 hurters were predominantly PSA 10 grade (4 of 6). The hypothesis: signals computed at per-player granularity don't reflect per-grade buyer behavior (PSA 10 = long-term collectors with different sensitivity than raw = short-term flippers).

This doc verifies that hypothesis against the architecture + the per-card data.

---

## 2. Architecture verification

### 2.1 Aggregator is per-player; no grade awareness anywhere in the signal pipeline

[`compiq-functions/fn-signal-aggregator/function.py`](../../compiq-functions/fn-signal-aggregator/function.py):

```python
def aggregate_signals(player_name: str) -> dict:
    signals = {k: load_signal(player_name, k) for k in WEIGHTS}
    ...
    save_signal(player_name, "aggregated", result)
```

Per-player input → per-player output. No grade parameter accepted; no grade parameter in the blob path.

[`compiq-functions/fn-serve-signals/__init__.py`](../../compiq-functions/fn-serve-signals/__init__.py):

```python
slug = player_name.lower().strip().replace(" ", "-")
blob = client.get_blob_client(container="compiq-signals", blob=f"{slug}/aggregated.json")
```

Serve API accepts only `?player=<name>`. No grade parameter accepted. Same blob returned regardless of which grade is being priced.

[`mcp-server/pricing.ts:fetchSignals`](../../mcp-server/pricing.ts) sends only `?player=<playerName>` (line 229). Receives one `SignalPayload`. Caller has no way to request grade-specific signals because the upstream doesn't produce them.

**Verdict: per-player-multiplier architecture confirmed. PSA 10 and raw predictions for the same player receive identical signal payloads.**

### 2.2 Tracked-players list is only 5 players

[`compiq-functions/shared/__init__.py`](../../compiq-functions/shared/__init__.py):

```python
_DEFAULT_PLAYERS = [
    "Mike Trout",
    "Shohei Ohtani",
    "Aaron Judge",
    "Ronald Acuna Jr",
    "Juan Soto",
]
```

Production has no `COMPIQ_TRACKED_PLAYERS` env var set on fn-compiq (verified via `az functionapp config appsettings list`). So only those 5 players get aggregator runs and have `aggregated.json` blobs.

**Implication:** the synthetic backtest cohort (10 distinct players) includes 5 players the aggregator doesn't track. For those players, `fetchSignals` returns `NEUTRAL_SIGNAL` (the URL exists, but the 404 fallback fires when serve-signals can't find the blob). Both signal-on and signal-off arms call `getPredictedPrice` with NEUTRAL_SIGNAL — there's no real signal differentiation.

### 2.3 Prompt presents grade AND per-player signal as separate inputs; GPT-4o decides

[`mcp-server/pricing.ts:buildPricingPrompt`](../../mcp-server/pricing.ts) — lines 460-462 present the grade explicitly:

```
Player: ${card.playerName}
Year: ${card.year} | Set: ${card.set} | Card #: ${card.cardNumber}
Grade: ${card.grade ?? "raw"} | Variant: ${card.variant ?? "base"}
```

Lines 493-505 present signal multiplier + per-signal breakdown:

```
## Live Market Signals (refreshed every 2-6 hours)
Final Signal Multiplier: ${signals.final_multiplier}x
Predicted Direction: ${signals.predicted_direction ?? "unknown"}
Active Flags: ${signals.signal_flags?.join(", ") || "none"}

Signal Breakdown:
- eBay demand:     ${signals.components?.ebay ?? 1.0}x
- Reddit buzz:     ...
```

GPT-4o sees both. No prompt-level instruction about how grade should modulate signal interpretation. The model is free to apply (or ignore) the player-level signal at any grade.

---

## 3. Per-card analysis

### 3.1 The 6 "stable hurters" decompose into 4 real + 2 noise artifacts

WS2 classified a card as a "stable hurter" if signal-on won ≤30% of 5 runs. Two of the six fall into the no-signal subset (`signal_unavailable` from §2.2):

| Stable hurter | Has real signal? | Why classified hurter |
|---|---|---|
| Aaron Judge PSA 10 | ✓ yes (Judge in tracked) | Real signal effect |
| Shohei Ohtani raw | ✓ yes | Real signal effect |
| Shohei Ohtani PSA 10 | ✓ yes | Real signal effect |
| Ronald Acuna Jr PSA 10 | ✓ yes | Real signal effect |
| **Paul Skenes raw** | **✗ NO (not in tracked_players)** | OpenAI noise — 1 of 5 odds, ~19% by chance |
| **Paul Skenes PSA 10** | **✗ NO** | OpenAI noise |

For Skenes (both grades), both arms call `getPredictedPrice` with identical NEUTRAL_SIGNAL input. Any observed "winning arm" difference is pure OpenAI nondeterminism. Getting ≤30% in 5 trials by random chance has probability ~19% (binomial) — so two of these in a 15-card cohort is well within expectation.

**The real stable hurter count is 4, not 6.**

### 3.2 The 8 "flipping" cards likewise decompose

| Flipping | Signal? | Comment |
|---|---|---|
| Mike Trout raw | ✓ | Real flipper; signals present |
| Mike Trout PSA 10 | ✓ | Real flipper |
| Aaron Judge raw | ✓ | Real flipper |
| Cody Bellinger | ✗ | No signal — pure noise |
| Ronald Acuna Jr raw | ✓ | Real flipper |
| Juan Soto raw | ✓ | Real flipper |
| Bobby Witt Jr | ✗ | No signal — pure noise |
| Caleb Bonemer | ✗ | No signal — pure noise |

**5 of 8 "flippers" are real; 3 are pure noise.**

### 3.3 Restated dataset — signal-bearing cards only (n=9)

After removing the 6 no-signal cards (Bellinger, Torres, Witt, Skenes×2, Bonemer; Torres had `actualMedian: null` so was always skipped anyway):

| Player + grade | win-rate (on) | classification | comment |
|---|---:|---|---|
| Trout raw | 0.6 | flipping | mixed |
| Trout PSA 10 | 0.4 | flipping | mixed |
| Judge raw | 0.6 | flipping | mixed |
| Judge PSA 10 | 0.2 | hurts | signal predictive of wrong direction |
| Ohtani raw | 0.2 | hurts | signal predictive of wrong direction |
| Ohtani PSA 10 | 0.25 | hurts | signal predictive of wrong direction |
| Acuna raw | 0.6 | flipping | mixed |
| Acuna PSA 10 | 0.2 | hurts | signal predictive of wrong direction |
| Soto raw | 0.6 | flipping | mixed |

**0 stable helpers, 4 stable hurters, 5 flippers** out of the 9 signal-bearing cards. No card with consistent signal-helpfulness.

### 3.4 Per-grade decomposition of the signal-bearing subset

Pair-by-pair analysis:

| Player | raw outcome | PSA 10 outcome | Per-grade split? |
|---|---|---|---|
| Trout | flipping (0.6) | flipping (0.4) | NO — both grades behave similarly |
| Judge | flipping (0.6) | hurts (0.2) | YES — raw better than PSA 10 |
| Ohtani | hurts (0.2) | hurts (0.25) | NO — both grades hurt |
| Acuna | flipping (0.6) | hurts (0.2) | YES — raw better than PSA 10 |
| Soto | flipping (0.6) | (not in cohort) | n/a |

**2 of 4 pairs (Judge, Acuna) show a per-grade split** (PSA 10 worse than raw). 2 of 4 pairs (Trout, Ohtani) do NOT. **The per-grade hypothesis is half-supported in the per-pair data** — not strongly enough to anchor a diagnosis on its own.

---

## 4. Per-signal attribution

The 3 working signals (trends, news, stats) plus cardhedge (legacy zombie blob) drive the multiplier; the 4 degraded signals (ebay/reddit/odds/youtube) all emit 1.0. Looking at the multiplier values across the 5 tracked players from a representative run (run_1):

| Player | final_mult | non-neutral components | signal_flags |
|---|---:|---|---|
| Trout | 1.04 | cardhedge=1.133, trends=1.155, stats=0.953, news=0.85 | injury_risk, cardhedge_comps_rising, pre_show |
| Judge | 0.993 | cardhedge=0.943, trends=0.909, stats=0.961, news=1.15 | injury_risk, pre_show |
| Ohtani | 1.057 | cardhedge=1.2, trends=0.941, stats=1.05, news=1.15 | injury_risk, cardhedge_comps_rising, pre_show |
| Acuna | 1.04 | cardhedge=1.2, trends=0.9, stats=1.076, news=0.85 | injury_risk, cardhedge_comps_rising, pre_show |
| Soto | 1.008 | cardhedge=0.973, trends=0.938, stats=1.017, news=1.15 | injury_risk, pre_show |

All 5 have very similar flag sets (`injury_risk` + `pre_show`). The differentiation is in the per-component multipliers — and those are mostly close to 1.0. The `final_mult` clamps in a tight 0.99-1.06 range for these players.

For Judge (stable hurter at PSA 10): final_mult=0.993 (essentially neutral, very slight bearish). Actual Judge PSA 10 in the ground-truth window: $292 (rising vs ~$235 input median, +24%). Signal said "slightly bearish"; market said "strongly bullish." Signal wrong-direction.

For Trout (flipping at both grades): final_mult=1.04 (slightly bullish). Actual Trout PSA 10: $1225 (rising vs ~$1000 input median, +22%). Signal said "slightly bullish"; market said "strongly bullish." Signal right-direction but understated.

For Ohtani (stable hurter at both grades): final_mult=1.057 (slightly bullish). Actual Ohtani raw: $150 (~stable vs $145 input median), Ohtani PSA 10: $471 (stable). Signal said "rising"; market said "stable." Signal wrong-direction.

**Pattern**: the same signal payload (cardhedge_comps_rising + injury_risk + pre_show flags, mild multipliers) doesn't predict accurately for all players. Trout's market moved up matching the signal; Judge's moved up against the signal; Ohtani's stayed flat against the signal. **Signal predictiveness is per-player, not per-grade.**

The per-grade pattern observed in §3.4 is more parsimoniously explained as: **PSA 10's higher price magnitude makes errors more visible.** A ±5% multiplier on a $1000 PSA 10 = $50 swing; same multiplier on a $30 raw = $1.50 swing. Even when signal direction is right, the PSA 10 prediction's absolute error exceeds the raw prediction's noise floor more often, so PSA 10 looks more "stably hurt."

This is the simpler hypothesis. Per-grade signal differentiation might still be valuable, but the per-card data doesn't isolate it as the load-bearing problem.

---

## 5. Diagnosis

Reading the per-card evidence against the 4 candidate options from the spec:

### 5.1 Option A — Per-player aggregation is the problem
**Verdict: WEAKLY SUPPORTED.** Per-grade split appears in 2 of 4 player-pairs (Judge, Acuna) but NOT in the other 2 (Trout, Ohtani). The fact that Trout pair behaves identically across grades, and Ohtani pair both hurt similarly, argues AGAINST per-grade aggregation being the dominant fix. If per-grade response were the load-bearing issue, all 4 pairs would show splits. Per-grade aggregation would be valuable polish, but not the root cause.

### 5.2 Option B — Signal interpretation by GPT-4o is the problem
**Verdict: PLAUSIBLE but not isolable from this data.** The prompt shows GPT-4o both grade context and per-player scalar. The model has discretion. At N=5 runs we can't distinguish "GPT-4o is applying signals wrong per grade" from "signals are wrong per player." Would need partial-arm experiments (signal-on with no grade context vs signal-on with grade context) to isolate.

### 5.3 Option C — Signal selection (which 3 work, which 4 degraded) is the problem
**Verdict: STRONGEST SUPPORT.** Three observations:

1. **Coverage gap is enormous.** Only 5 of 10 cohort players are tracked. 6 of 15 cards have NO real signal input — those contribute pure OpenAI noise to aggregate metrics. **CF-SIGNAL-CREDENTIAL-REPAIR alone won't help here — `COMPIQ_TRACKED_PLAYERS` env var also needs expanding to cover more players.**
2. **Working signals are weak.** Only trends, news, stats produce meaningful multipliers. All 4 of the cohort's tracked players have very similar component patterns (mostly 0.9-1.2 range). Signal differentiation between players is weak.
3. **Per-player accuracy is heterogeneous.** Same signal flags + similar multipliers → wildly different per-player outcomes. Trout's signals predict correctly; Judge/Ohtani/Acuna PSA 10's predict wrong-direction.

### 5.4 Option D — Multiplier shape (scalar 0.7-1.5) is the problem
**Verdict: NOT TESTABLE from this data.** Would require a redesigned prompt that gives GPT-4o richer signal context (per-signal explanations, not just multipliers). Out of scope to evaluate from N=5 runs.

### 5.5 Diagnosis summary

**Primary: Option C — signal selection and coverage are the gating problems.** Two sub-findings:
- **Tracked-players coverage is too narrow** (5 of 10 cohort players → 40% of cohort gets no signal differentiation)
- **Working-signal predictiveness is heterogeneous per player** (signals help Trout, hurt Judge/Ohtani/Acuna)

**Secondary: Option A — per-grade aggregation could improve 2 of 4 player-pairs (Judge, Acuna)** but is not the dominant problem. Defer until Option C is addressed.

**Tertiary: Option B + D require partial-arm experiments to evaluate.** Out of scope for this diagnostic.

---

## 6. Recommended next workstream

### 6.1 Sequence

The audit's load-bearing finding is that **the signal-coverage gap (5 of 10 players untracked) contaminates the backtest**. Until that's closed, multi-run aggregate metrics include 40% no-signal noise.

**Recommended next: CF-EXPAND-TRACKED-PLAYERS-AND-RE-BACKTEST** (~30-60 min total)

1. Set `COMPIQ_TRACKED_PLAYERS` env var on `fn-compiq` to include all 10 cohort players (~5 min via `az functionapp config appsettings set`). Wait one aggregator cycle (2hr) for new players to get their first aggregated.json.
2. Re-run backtest with `--repeats=5` against the same N=15 cohort (~$0.75).
3. Compare to today's N=15×5 results:
   - If signal-bearing cards (now 15 of 15) still show 4 stable hurters + 0 helpers → signal selection (Option C) confirmed as primary
   - If new picture emerges (e.g., more helpers, fewer hurters) → original cohort's no-signal contamination was driving the verdict
4. Apply pre-committed outcome branches to the new aggregate.

This is the cheapest, most-informative next step. It addresses Option C directly. The result determines whether subsequent workstreams should be:
- CF-PHASE4B-PROMPT-AUDIT (if signals still hurt despite full coverage → GPT-4o interpretation issue)
- CF-AGGREGATOR-PER-GRADE (if Option A becomes more clearly supported with full coverage)
- CF-SIGNAL-CREDENTIAL-REPAIR (if working signals look directionally correct + full coverage helps → expand to all 7 signals via repairing the 4 degraded ones)
- CF-BACKTEST-DETERMINISTIC (still valid; can be run in parallel to reduce noise floor)

### 6.2 Why this before WS3 (CF-BACKTEST-DETERMINISTIC)?

WS3 reduces OpenAI noise by locking temperature=0 + seed. That's valuable but it doesn't address the 40% no-signal contamination — deterministic predictions on cards with no signals still produce no real signal-vs-no-signal differentiation. Coverage expansion is cheaper, addresses the more load-bearing issue, and stacks well with WS3 (do both, in either order).

### 6.3 Why this before CF-AGGREGATOR-PER-GRADE?

Per-grade aggregation is a substantial Python+API refactor (per-grade blobs, per-grade-cached endpoints, MCP consumer changes). The per-grade signal is half-supported (2 of 4 pairs) — not strong enough evidence to justify that scope. Coverage expansion first; if post-coverage data shows per-grade splits across more pairs, then justify the refactor.

---

## 7. Anti-findings

What the data RULES OUT (just as informative as what it supports):

### 7.1 NOT: "per-grade aggregation is obviously the fix"
The Trout pair (both grades flipping the same way) and Ohtani pair (both grades hurting the same way) actively contradict the "PSA 10 needs different signal" hypothesis. The hypothesis would predict all 4 pairs split; only 2 do.

### 7.2 NOT: "signals are uniformly broken"
Trout pair shows signals working at least as well as no-signal (flipping 0.4-0.6 is "neutral" — not "broken"). At least one player has signals that aren't categorically wrong.

### 7.3 NOT: "signals are uniformly noise"
Judge / Ohtani PSA 10 show **stable** hurting across 5 runs — that's a real, repeating signal effect, not noise. The signal is producing a consistent wrong-direction prediction. If it were noise, the win-rate would converge to 0.5.

### 7.4 NOT: "the 6 stable hurters all share a root cause"
2 of 6 (Skenes pair) are pure OpenAI noise artifacts (no signal input). They got grouped with the real 4 hurters by the simple ≤30% threshold. The threshold is too permissive at n=5; future runs should require either more repeats OR isolate no-signal cards from the analysis.

### 7.5 NOT: "the cohort is well-designed for signal evaluation"
40% of the cohort lacks signal differentiation. The cohort was designed for grade-aware backtest (today's grade-flow work) — not for signal-effectiveness evaluation. A signal-evaluation cohort should restrict to tracked players (and/or expand tracking).

---

## 8. Open questions

These need additional data or experiments beyond what today's diagnostic can resolve:

1. **Does per-grade aggregation help Judge + Acuna pairs specifically?** Would require building per-grade signal aggregation as an experiment OR partial-arm testing where grade is excluded from the prompt.
2. **Why is Trout's signal predictive but Judge's not?** Same flag set, similar multiplier patterns, different outcomes. Possibly: Trout's `cardhedge_comps_rising` reflects collectors who treat his card as a long-term hold; Judge's market is more day-trader-driven and his cardhedge data lags reality. Speculation; needs market analysis beyond this audit.
3. **Would Wilcoxon p-values stabilize at N=100 + full coverage + deterministic mode?** Currently can't say. N=15 + 40% no-signal + temp=1 noise stacks compound.
4. **Does the `injury_risk` flag specifically hurt PSA 10 predictions?** All 5 tracked players had injury_risk in run 1. Need partial-arm experiments (with/without the flag) to isolate.

---

## 9. What this does NOT do

- Doesn't implement any fix (CF-EXPAND-TRACKED-PLAYERS is the recommended follow-up, not in scope here)
- Doesn't repair degraded signals (gated on coverage-expansion results)
- Doesn't change production behavior — fn-compiq's aggregator + serve-signals are unchanged
- Doesn't add per-grade aggregation (Option A deferred until evidence stronger)
- Doesn't audit prompt template (Option B requires separate prompt-audit workstream)
- Doesn't claim the per-grade hypothesis is wrong — only that it's half-supported and not the load-bearing issue per current data

---

## Anti-drift note

The WS2 verdict "0 stable helpers, 6 stable hurters" looked like a strong signal-quality finding. After de-noising the 6 hurters (subtract the 2 no-signal Skenes artifacts), the real picture is **4 stable hurters out of 9 signal-bearing cards** — still meaningful, but less decisive. The headline number was inflated by cohort design (signal-blind players included).

Watch for this pattern: aggregate metrics on heterogeneous-coverage cohorts mix real signal effects with no-signal noise. The cohort design must match the question being asked. For signal-effectiveness evaluation, restrict the cohort to players with active signal coverage — OR expand coverage to match the cohort.

CF-EXPAND-TRACKED-PLAYERS-AND-RE-BACKTEST is the cheap-and-load-bearing next move. Defer per-grade aggregation, prompt audit, and signal repair until after that re-baseline.

End of diagnostic.
