# Phase 4b diagnostic findings — signal integration already built, 4/7 degraded

**Captured:** 2026-05-27 (Phase 4b kickoff sub-workstream 1; sub-workstream 2 reframed)
**Scope:** Read-only diagnostic. Documents what was found, not what to do next.
**Related:** [docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md](../HOBBYIQ_ROADMAP_2026Q2_Q3.md) Phase 4b section (now partially superseded by this finding).
**Status:** Diagnostic complete. Design work deferred to a follow-up measurement-first workstream (CF-PHASE4B-BACKTEST).

## 1. Framing inversion

The roadmap framed Phase 4b as **"signals being collected start influencing predictions"** — implying signals are dormant outputs that need to be wired into the prediction path.

Diagnostic on 2026-05-27 reveals the opposite: **signals are already influencing predictions**, end-to-end, in production. The pipeline was built without an explicit Phase 4b workstream — somewhere across earlier sessions the wiring landed. What's missing isn't the integration; it's measurement, signal-source health, and validation.

Phase 4b as scoped in the roadmap does not match the codebase as it stands today. This document captures the actual state so subsequent design work proceeds from reality rather than from the roadmap's outdated assumption.

## 2. Current signal integration architecture (as discovered)

The end-to-end pipeline that exists today:

```
fn-{reddit,trends,news,youtube,stats,odds,ebay}-signals  (timer, varied cadence 2hr-6hr)
        |
        v   per-signal blob writes
compiq-signals/{player-slug}/{signal}.json  (Azure Blob Storage)
        |
        v   read every 2hr
fn-signal-aggregator  (timer :50 every 2hr)
        |
        v   weighted-blender combines per-signal blobs into final_multiplier + signal_flags + components
compiq-signals/{player-slug}/aggregated.json
        |
        v   HTTP GET per prediction
fn-serve-signals  (HTTP trigger)
        |
        v   5s timeout, fallback NEUTRAL_SIGNAL on error
mcp-server/pricing.ts:fetchSignals(playerName)  (line 222)
        |
        v   SignalPayload injected into buildPricingPrompt() context (line 656, 673)
OpenAI prediction prompt with signal_flags + components as part of the reasoning context
```

**Key code locations:**

- `mcp-server/pricing.ts:19` — `const SIGNAL_URL = process.env.AZURE_SIGNAL_FUNCTION_URL`
- `mcp-server/pricing.ts:222-250` — `fetchSignals()`: HTTP fetch with 5s timeout, clamps `final_multiplier` to [0.7, 1.5], merges with `NEUTRAL_SIGNAL` fallback
- `mcp-server/pricing.ts:656` — `await Promise.all([fetchSignals(card.playerName), fetchPriceFloor(cardId)])` — every prediction call
- `mcp-server/pricing.ts:673` — `buildPricingPrompt(card, signals, preFlags, comp, floorValue, analytics)` — signals are first-class prompt input
- `mcp-server/server.ts:127` — `has_signal_url: Boolean(process.env.AZURE_SIGNAL_FUNCTION_URL)` exposed in `/health`
- `backend/src/routes/ops.routes.ts:106, 288` — backend also reads `AZURE_SIGNAL_FUNCTION_URL` (ops endpoint, separate from prediction flow)
- `compiq-functions/fn-signal-aggregator/` — Python function implementing the weighted blender
- `compiq-functions/fn-serve-signals/` — Python HTTP function serving the aggregated payload

**Production state:**
- `AZURE_SIGNAL_FUNCTION_URL` set on compiq-mcp (verified)
- `/health` reports `has_signal_url: true`
- mike-trout `aggregated.json` mtime: `2026-05-24T14:50:00Z` (fresh; every 2hr cadence)

The wiring is live. Predictions running on compiq-mcp today are receiving signal context.

## 3. Per-signal health classification

Sampled `mike-trout/{signal}.json` blobs on 2026-05-27. All 7 written today (fresh mtimes). Content reveals per-signal health:

| Signal | Latest content (truncated) | Schedule | Status | Weight per roadmap |
| --- | --- | --- | --- | ---: |
| **trends** | `{multiplier: 1.167, trend: "rising", spike_ratio: 1.67, buy_intent_detected: false}` | every 6hr | **(A) operational + useful** | 0.15 |
| **news** | `{multiplier: 1.15, headline_count: 20, sentiment: "neutral", keyword_flags: {injury: true, award: true, ...}, top_headline: "Texas Rangers at Los Angeles Angels..."}` | every 3hr :45 | **(A) operational + useful** | 0.05 |
| **stats** | `{multiplier: 0.953, momentum_ratio: 0.953, stat_group: "hitting", direction: "neutral", milestone: null}` | every 2hr :15 | **(A) operational + useful** | 0.10 |
| **ebay** | `{multiplier: 1.0, signal: "auth_failed"}` | every 4hr | **(E) degraded** | 0.20 |
| **reddit** | `{multiplier: 1.0, signal: "auth_failed"}` | every 2hr | **(E) degraded** | 0.15 |
| **odds** | `{multiplier: 1.0, signal: "no_api_key"}` | every 4hr :30 | **(E) degraded** | 0.15 |
| **youtube** | `{multiplier: 1.0, signal: "no_api_key"}` | every 6hr :15 | **(E) degraded** | 0.15 |

**Coverage math:** 3-of-7 signals carry meaningful information; 4-of-7 always emit `multiplier: 1.0`. By the roadmap's weight allocation, **information-carrying weight = 0.30** (trends 0.15 + news 0.05 + stats 0.10), **no-op weight = 0.65** (ebay 0.20 + reddit 0.15 + odds 0.15 + youtube 0.15). Cardsight comps separately at 0.20.

### Per-signal credential characterization (the (E) cases)

| Signal | Root cause | What fn-compiq has | What's missing |
| --- | --- | --- | --- |
| ebay | OAuth failure (signal: "auth_failed") | `EBAY_APP_ID=10 chars`, `EBAY_CERT_ID=36 chars` | The credentials are present but the function reports `auth_failed`. Either the keys are stale, the OAuth scope is wrong, or eBay revoked access. Requires debugging — not a simple "missing key" fix. |
| reddit | Missing credentials (signal: "auth_failed") | nothing | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` not present on fn-compiq App Settings. Need to (a) acquire credentials at reddit.com/prefs/apps and (b) add to App Settings. |
| odds | Missing API key (signal: "no_api_key") | nothing | `ODDS_API_KEY` not present. Need to acquire from the-odds-api.com (free tier 500 req/mo per copilot-instructions) and add. |
| youtube | Missing API key (signal: "no_api_key") | nothing | `YOUTUBE_API_KEY` not present. Need to acquire from console.cloud.google.com (YouTube Data API v3, free 10k units/day) and add. |

The (A) signals work without credentials by design:
- **trends** uses pytrends (Google Trends scraping; unauthenticated)
- **news** uses RSS scraping (RSS feeds are unauthenticated; `NEWS_API_KEY` listed in copilot-instructions doc but the function gracefully falls back to RSS — verified by present 20-headline output despite no NEWS_API_KEY on fn-compiq)
- **stats** uses MLB Stats API (free, no credential required)

### Aggregator output sample

mike-trout `aggregated.json` (1031 bytes, mtime 2026-05-24T14:50:00Z):

```json
{
  "player": "Mike Trout",
  "final_multiplier": 1.057,
  "predicted_direction": "stable",
  "signal_flags": [
    "injury_risk",
    "cardhedge_comps_rising",
    "pre_show: Chicagoland Sports Card Expo in 13 days"
  ],
  "components": {
    "cardhedge": 1.133,
    "ebay": 1.0,
    "reddit": 1.0,
    "trends": 1.167,
    "odds": 1.0,
    "stats": 0.953,
    "news": 1.15,
    "youtube": 1.0
  },
  "component_signals": {
    "cardhedge": "rising",
    "ebay": "auth_failed",
    "reddit": "auth_failed",
    "trends": "rising",
    "odds": "no_api_key",
    "stats": "unknown",
    "news": "neutral",
    "youtube": "no_api_key"
  }
}
```

The aggregator is doing real work: weighted combination of multipliers, signal_flag extraction (from news keyword_flags + a pre-show catalyst calendar), and exposing both per-component multipliers and per-component health strings. **The blender semantics live in `fn-signal-aggregator` (Python)**, not in TS code on backend or mcp-server.

Note the aggregator's components row also includes `cardhedge: 1.133` and `cardhedge_comps_rising` — the aggregator is still reading the (zombie) CH blob and folding it into the multiplier. Tracked as part of CF-CARDHEDGE-CLIENT-DELETE's broader CH-removal scope, NOT a Phase 4b concern.

## 4. What the original roadmap got wrong

The 2026-05-21 roadmap text under Phase 4b (Week 7: Jul 3-9):

> "Build signal reader for each: Reddit, Google Trends, News, YouTube, MLB Stats, Odds, eBay-signals"
> "Implement weighted blender. CH weight already gone post Phase 3 cleanup; redistribute its former 0.20 across remaining signals..."
> "Per-signal fallback to 1.0 multiplier on read failure (partial > none)"
> "Combined multiplier capped 0.70-1.50 per existing rule"
> "Backtest: last 30 days historical predictions with signals on vs off; measure prediction-vs-actual delta"
> "A/B in production: 50% traffic gets signals, 50% doesn't; compare 7-day prediction accuracy"

Verified against codebase 2026-05-27:

| Roadmap claim | Reality |
| --- | --- |
| Build signal reader for each | Already exists: `mcp-server/pricing.ts:fetchSignals()` calls `fn-serve-signals` which serves the pre-aggregated payload |
| Implement weighted blender | Already exists in `fn-signal-aggregator` (Python). Weights are encoded inside that function, not in TS prediction code. |
| Per-signal fallback to 1.0 multiplier | Already exists: `NEUTRAL_SIGNAL` constant in `pricing.ts`; aggregator emits `multiplier: 1.0` for degraded signals |
| Combined multiplier capped 0.70-1.50 | Already exists: `clamp(Number(data.final_multiplier ?? 1.0), 0.7, 1.5)` in `pricing.ts:239` |
| Backtest harness | NOT BUILT |
| A/B production splitting | NOT BUILT |

**Implication:** the roadmap was written without verifying current state of the integration. Subsequent Phase 4b planning should be diagnostic-driven, not roadmap-driven.

This isn't a defect of the roadmap as a planning artifact — it's the natural outcome of writing strategic plans against a half-remembered codebase. The corrective pattern, going forward: **read code first, plan second.** This is the same lesson the deploy infra audit captured (read the script first, harden second).

## 5. What's actually missing per current state

What Phase 4b WOULD ship if pursued today:

| Item | State | Notes |
| --- | --- | --- |
| Signal data being collected | DONE | 7 functions writing per-signal blobs |
| Aggregator combining signals | DONE | fn-signal-aggregator every 2hr |
| HTTP serving layer | DONE | fn-serve-signals |
| MCP prediction integration | DONE | pricing.ts:fetchSignals + buildPricingPrompt |
| 4 of 7 signals actually contributing info | **NOT DONE** | ebay/reddit/odds/youtube all emit 1.0; only trends/news/stats carry value |
| Backtest harness measuring signal-on vs signal-off | **NOT DONE** | No prediction-vs-actual delta measurement exists |
| Production A/B (signal-on vs signal-off traffic) | **NOT DONE** | All traffic gets signals; no comparison group |
| Validation that signals improve accuracy | **NOT DONE** | Unmeasured; cannot prove signals help, hurt, or are neutral |

The four "NOT DONE" items are the real Phase 4b work. The first one (degraded credentials) is small but blocked behind the lower three (measurement). Repairing signals before knowing whether they help is investment without evidence.

## 6. Recommended next workstream (measurement-first)

**Design a backtest harness that measures whether the EXISTING signal integration improves prediction accuracy.** Sequenced before any repair work because results gate the repair priority:

| Backtest outcome | Implication for repair |
| --- | --- |
| Signal-on > signal-off (accuracy gain ≥ measurable threshold) | Signals are pulling their weight; repair degraded 4 to amplify the win. Repair becomes Phase 4b.1. |
| Signal-on ≈ signal-off (no significant difference) | Existing signals don't move the needle for the OpenAI prompt. Repair may not help; deeper question is whether OpenAI is using the signal context at all. |
| Signal-on < signal-off (accuracy regression) | Current signal integration is HURTING. Need to investigate which signals contribute negatively before any expansion. |

Backtest design considerations (captured here for the follow-up workstream — NOT designed in this doc):

- Data source: `compiq_predictions` Cosmos container (predictionLog entries). Currently sparse (~7 rows as of 2026-05-27 per WS3 v2 addendum). Sample size is a real limitation.
- Ground truth: for each historical prediction, find the actual sale price in subsequent comps. Cardsight pricing data is the source.
- Counterfactual: re-run prediction with signals disabled (set `AZURE_SIGNAL_FUNCTION_URL=""` or short-circuit `fetchSignals`). Requires either offline replay or a feature flag.
- Statistical method: paired test on prediction error (e.g., MAPE delta per card, paired across signal-on vs signal-off).
- Reporting: prediction-vs-actual delta by signal-on/off, per signal subset (could enable signals incrementally to identify which contributes).

This is a focused workstream of its own (CF-PHASE4B-BACKTEST below). Out of scope here.

## 7. Carry-forwards captured

### CF-PHASE4B-BACKTEST (next major workstream)

**Goal:** Design and implement a backtest harness measuring whether the existing signal integration improves prediction accuracy.

**Inputs:** `compiq_predictions` Cosmos rows (currently sparse), Cardsight pricing history for ground truth, the current signal-on prediction path (live), and a counterfactual signal-off path (TBD: env-var flip, code branch, or offline replay).

**Outputs:** Prediction-vs-actual accuracy delta with statistical confidence; per-signal contribution attribution if data permits.

**Estimated:** 3-5 hour design session + multi-session implementation. Separate kickoff.

**Blocking issue:** predictionLog volume is small (~7 rows as of 2026-05-27). Backtest's statistical power is limited until volume grows. Possible mitigation: re-run predictions on historical cards (offline replay) to expand sample.

### CF-SIGNAL-CREDENTIAL-REPAIR (gated on backtest results)

**Goal:** Restore the 4 degraded signal sources to (A) operational + useful state.

**Specific blockers per signal:**
- ebay: debug OAuth failure with present EBAY_APP_ID + CERT_ID (may need to acquire new credentials, or fix scope issue)
- reddit: acquire REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET at reddit.com/prefs/apps, add to fn-compiq App Settings
- odds: acquire ODDS_API_KEY at the-odds-api.com (free tier 500 req/mo), add to App Settings
- youtube: acquire YOUTUBE_API_KEY at console.cloud.google.com (YouTube Data API v3, free 10k units/day), add to App Settings

**Bundled OR per-signal:** depends on backtest results. If signals categorically help, bundle all 4 into one workstream. If only some help, prioritize accordingly.

**Estimated:** ~1-2 hour workstream once acquisition tasks are sequenced.

### CF-PHASE4B-AGGREGATOR-OWNERSHIP (architectural note)

**Observation:** The weighted blender semantics live in `compiq-functions/fn-signal-aggregator/` (Python), not in backend or mcp-server TypeScript. Any change to per-signal weights, clamp bounds, or signal_flag extraction requires Python work AND a redeploy of fn-compiq.

**Implication for future workstreams:**
- "Implement weighted blender" framings are misleading — the blender exists, just lives in an awkward place
- Weight changes require fn-compiq redeploy (same Linux read-only constraints as CF-FN-CARDHEDGE-DISABLE — Azure rejects ad-hoc disable; modifications require source-redeploy)
- TypeScript-side changes to signal handling (e.g., re-clamping, re-weighting, or branching on component health) are possible without Python redeploy IF the change can be done after fetching from fn-serve-signals
- Documentation in `copilot-instructions.md` should call out this Python/TS split if it persists

**Not actionable today.** Captured so the next planner doesn't repeat the framing error.

## 8. What this doc does NOT do

- Doesn't design the backtest harness (CF-PHASE4B-BACKTEST)
- Doesn't repair degraded signal credentials (CF-SIGNAL-CREDENTIAL-REPAIR)
- Doesn't refactor the Python aggregator into TS (out of scope; CF-PHASE4B-AGGREGATOR-OWNERSHIP just notes it)
- Doesn't update the roadmap doc to reflect this finding — that's a separate small commit, NOT bundled here. Roadmap will be honest about Phase 4b state when the next workstream lands.
- Doesn't claim Phase 4b is complete OR incomplete — it claims the original Phase 4b plan does not match reality, and that the next workstream should be measurement-first.

## Anti-drift note

The diagnostic surfaced one big finding (signal integration already built) and one smaller finding (4 of 7 signals degraded). The next workstream's design pressure will be to want to repair signals first (because credential acquisition feels concrete and accomplishable). Resist that pressure until backtest validates that signals improve accuracy. Otherwise, the team buys 4 API keys to amplify an unmeasured effect.

## Addendum 2026-05-24 — major correction to §2

**Discovery during Phase 4b backtest implementation (CF-PHASE4B-BACKTEST.1):** the `AZURE_SIGNAL_FUNCTION_URL` value on compiq-mcp App Settings was set to `https://fn-compiq.azurewebsites.net/api/serve-signals` — a 404 path. The actual function route per `fn-serve-signals/function.json:10` is `signals`, resolving to `https://fn-compiq.azurewebsites.net/api/signals`. **Effect:** every prediction compiq-mcp made since this URL was first set has silently fallen back to `NEUTRAL_SIGNAL` via `fetchSignals`'s `!resp.ok` and `catch` branches ([pricing.ts:236, 247](../../mcp-server/pricing.ts#L236-L249)). No telemetry surfaced this because the function returns the neutral payload as if everything succeeded.

**Correction to §2:** the original §2 architecture diagram and the closing line *"Predictions running on compiq-mcp today are receiving signal context"* were wrong. Actual state at time of the original diagnostic: signal collectors (7 functions) + aggregator + serve-signals all working AND writing fresh blobs; consumer (compiq-mcp `/predict`) had been silently signal-off for the entire duration the wrong URL was set. The pipeline existed end-to-end except for the last hop, and the last hop's failure was masked by `fetchSignals`'s error swallowing.

**How the original diagnostic missed this:** the inference rested on three observations — (1) `/health` reports `has_signal_url: true`, (2) aggregator blobs are fresh, (3) wiring exists in code. (1) only checks the env var is non-empty, not that the URL resolves. (2) is independent of whether `serve-signals` is read by anyone. (3) doesn't imply (the consumer's URL is correct). The leap from (1)+(2)+(3) to "signals reach predictions" was not validated by an end-to-end probe.

**Production fix shipped 2026-05-24:** App Setting on compiq-mcp corrected via `az webapp config appsettings set -g rg-hobbyiq-dev -n compiq-mcp --settings "AZURE_SIGNAL_FUNCTION_URL=https://fn-compiq.azurewebsites.net/api/signals"`. App auto-restarted; `/health` still reports `has_signal_url: true`; live probe of `/api/signals?player=Mike%20Trout&code=…` returns HTTP 200 with a valid SignalPayload. Signals now reach predictions.

**Framing inversion pattern:** this is the fourth in the current arc, alongside (a) MCP-mediated cache already partial, (b) App Insights wiring already partial, (c) signal integration assumed built when actually broken at the consumer. The pattern: **project actual state has been ahead of, or different from, documented state in significant ways.** Read code first, plan second is the same lesson surfacing again — extended now to "verify the wire end-to-end, not just the wire's existence."

### Implication for the backtest

The backtest harness shipped at commit a061fb9 (CF-PHASE4B-BACKTEST.1) operates with whatever `AZURE_SIGNAL_FUNCTION_URL` is set in its environment. Two consequences:

- **Signal-on arm** with the corrected URL tests the configuration production is NOW running (post-fix). This is the first time signal context will reach the prediction prompt for these cards.
- **Signal-off arm** (NEUTRAL_SIGNAL via `signalsOverride`) tests the configuration production WAS running until the fix landed. Effectively backfilling the counterfactual that compiq-mcp has been running unintentionally.

The comparison is meaningful in both directions: it measures the lift signals provide *and* the silent loss the misconfiguration was causing.

### New carry-forwards captured

- **CF-HEALTH-SIGNAL-URL-CHECK** (~30 min) — `mcp-server/server.ts:127`'s `has_signal_url` health check verifies env var presence only. Should additionally probe the URL on startup (or on `/health` request) and report `signal_url_resolves: true|false`. Would have surfaced this misconfiguration on the first deploy after the URL was set.
- **CF-SIGNAL-SILENT-FAILURE-AUDIT** (~60-90 min) — audit codebase for silent-failure patterns matching `fetchSignals` + `fetchPriceFloor`: errors swallowed, callers continue with degraded behavior, no telemetry, no operator-visible signal that the dependency is dead. Targets to start with: every `.catch { return null }` / `.catch { return DEFAULT }` in MCP + backend. Likely candidates beyond signal fetch: floor fetch, cardhedge readers (now removed), any provider client with `||` default-on-error.

Both carry-forwards are downstream of the present backtest work and not implemented in this session.
