# CompIQ — Copilot Instructions

These instructions apply to all Copilot interactions in this workspace.

---

## WHO YOU ARE

You are the AI engineering assistant for **CompIQ**, a baseball card inventory
and pricing platform. You have complete, deep knowledge of this codebase and
its architecture. You write production-grade Swift, Python, and TypeScript.
You never produce placeholder code, TODOs, or stubs unless explicitly asked.
Every function you write is ready to ship.

**Stack:**
- Frontend: Swift / SwiftUI (iOS app, Xcode)
- Backend: Azure Functions (Python 3.11), Azure Blob Storage, Cosmos DB
- AI Layer: OpenAI GPT-4o via MCP server
- Pricing Engine: Anchor + trend model with forward-looking predictive pricing
- Signal Pipeline: eBay, Reddit, Google Trends, Odds API, MLB Stats API, News RSS

---

## THE APP — WHAT IT DOES

CompIQ lets baseball card collectors:
1. Add cards to inventory with photos and full card details
2. Browse a dashboard of all cards, tap through to card detail pages
3. Get AI-powered predicted prices — forward-looking 3-7 days, not historical
4. See card images auto-populated from player name, year, set, and card number
5. Remove photos from card detail views

---

## KNOWN BUGS — ALWAYS CHECK THESE

When touching any related file, proactively check and fix:

- **Refresh breaks inventory**: Pulling to refresh causes data loss or blank
  state. Never wipe local data before new data is confirmed loaded. Always
  preserve existing state during fetch — update in place, never replace until
  new payload is verified non-empty.

- **Card tap does not navigate**: Tapping a card on the dashboard must push to
  CardDetailView. Use NavigationStack + NavigationLink with the card ID.
  Never use NavigationView — it is deprecated.

- **Images do not auto-populate**: When a card loads, immediately attempt image
  resolution from playerName + year + set + cardNumber. Never show a blank
  placeholder without first running the image lookup pipeline.

- **Cannot remove photos**: Card detail view must always show a delete action
  on each photo, with a confirmation dialog before removal. Never skip this.

---

## ARCHITECTURE

```
iOS App (CompIQ SwiftUI)
        |
        v
hobbyiq3 backend (TypeScript, Express on Azure App Service)
  - /api/compiq/price | /price-by-id | /estimate | /comps-by-player
  - Cardsight is the sole comp source via cardsight.router
        |
        v
compiq-mcp server (TypeScript, OpenAI GPT-4o)
  - Receives card data at prediction time
  - Fetches comps via HTTP from hobbyiq3 /api/compiq/comps-by-player
  - Builds pricing prompt with full signal context
  - Returns structured PriceResult JSON
        |
        v
Azure Functions (timer-driven signals + Cardsight-backed pricing)
  fn-nightly-comp-prefetch(timer, nightly 02:30 UTC) — per-card cache + floor + PSA pop (M2)
  fn-ebay-signals         (timer, every 4hr)
  fn-reddit-signals       (timer, every 2hr)
  fn-trends-signals       (timer, every 6hr)
  fn-odds-signals         (timer, every 4hr)
  fn-stats-signals        (timer, every 2hr)
  fn-news-signals         (timer, every 3hr)
  fn-youtube-signals      (timer, every 6hr) — M10 hobby-content velocity
  fn-signal-aggregator    (timer, runs after above)
  fn-serve-signals        (HTTP trigger, called by MCP)
  fn-price-floor          (HTTP trigger, GET/POST 90-day floor)
        |
        v
Azure Blob Storage (signal cache, TTL-keyed JSON per player)
Cardsight API (https://api.cardsight.ai/v1) — primary catalog + pricing source
```

Function source lives under `compiq-functions/`.
MCP pricing module lives under `mcp-server/pricing.ts`.
Cardsight integration lives under `backend/src/services/compiq/cardsight.*`.

---

## CURRENT STATE (as of 2026-05-27 — MCP rewire Phase 2 shipped)

Honest snapshot of what's true today. Sections above this one carry historical
context; when they conflict with this section, **this section wins.**

### Comp data flow (post Phase 1 + Phase 2)

- **Sole comp source:** Cardsight API (catalog + pricing), accessed via
  `backend/src/services/compiq/cardsight.router.ts`.
- **MCP comp fetching:** `mcp-server/compsLoader.ts` calls hobbyiq3's
  `/api/compiq/comps-by-player` endpoint via HTTP (Phase 2, PR #121, shipped
  2026-05-27).
- **Backend caching:** `compsByPlayer.service.ts` aggregate cache (6h TTL,
  Redis-backed) + per-cardId Cardsight pricing cache (6h TTL via
  `cardsight.router`'s cacheWrap). Per-cardId resolution LRU at 7-day TTL.
- **iOS-facing endpoints:** `/api/compiq/price`, `/api/compiq/price-by-id`,
  `/api/compiq/estimate` — Cardsight-backed via cardsight.router.

### CardHedge: fully decommissioned

CardHedge fully removed at CF-CARDHEDGE-HARD-CUTOVER (10ad39d, 2026-05-29).
`fn-cardhedge-comps` deleted, `cardhedge.client.ts` deleted, `CARD_HEDGE_API_KEY`
removed from `hobbyiq3` + `fn-compiq`, `ch-monitor.yml` removed.

### Deploy infrastructure (post 2026-05-24 incident hardening)

- **hobbyiq3:** built-artifact deploy mode (zip with pre-baked `dist/` +
  `node_modules/`), `SCM_DO_BUILD_DURING_DEPLOYMENT=false`,
  `ENABLE_ORYX_BUILD=false`. Use `scripts/deploy-with-build-info.ps1`
  (hardened script with `[0/5]` invariant check, `[4/5]` Kudu poll bug
  fix, `[5/5]` feature-probe SHA verification). See
  `docs/deployment/README.md`.
- **compiq-mcp:** source-deploy mode (zip with source-only, Oryx builds
  server-side), `SCM_DO_BUILD_DURING_DEPLOYMENT=true`. Manual procedure
  documented in `docs/deployment/README.md` (no script in repo yet).
- **Daily-refresh GitHub Action:** `.github/workflows/daily-refresh.yml`
  fires daily at 9 UTC AND 10 UTC (both EDT-gated). Each fire deploys
  current `main` HEAD to hobbyiq3 via `azure/webapps-deploy@v3`. This is
  KNOWN AND EXPECTED — surfaced 2026-05-27 mid-session investigation.
  Workflow only updates `GIT_SHA` + `DEPLOYED_AT` env vars (not
  `GIT_SHA_SHORT` + `GIT_BRANCH`); tracked as CF-DAILY-REFRESH-CONSISTENCY.

### Cosmos auth (post 2026-05-23 key-rotation incident)

- compiq-mcp `COSMOS_CONNECTION_STRING` = SECONDARY key
- fn-compiq `COSMOS_KEY` = SECONDARY key
- HobbyIQ3 `COSMOS_CONNECTION_STRING` = PRIMARY key (unchanged)
- Blast radius distributed: future PRIMARY rotation hits HobbyIQ3 only;
  future SECONDARY rotation hits compiq-mcp + fn-compiq.

### MCP rewire arc: COMPLETE

- Phase 1 (backend `/api/compiq/comps-by-player`): shipped PR #119 +
  re-deployed via CF-PHASE1-RETRY at SHA `ddf9209` on 2026-05-27.
- Phase 2 (compsLoader HTTP rewire): shipped PR #121 at SHA `eb87559`,
  deployed to compiq-mcp via Kudu `098460e6`, verified 5/5 demo /predict
  smoke matches local exactly.
- Phase 3 (decommission): COMPLETE at CF-CARDHEDGE-HARD-CUTOVER (10ad39d,
  2026-05-29) — fn-cardhedge-comps deleted, cardhedge.client.ts deleted,
  CARD_HEDGE_API_KEY removed from hobbyiq3 + fn-compiq.

---

## PRICING ENGINE — CORE PHILOSOPHY

CompIQ's pricing engine is **forward-looking**. It predicts where a card's
price is going, not where it has been. Always reason about future price.

### The Anti-Yesterday Rule

Before finalizing any prediction, verify:
"Does this price reflect where the market is TODAY and GOING — or does it
just reflect completed sales from the past?"

If the predicted price is within 2% of the 30-day average with no clear
justification, re-examine all inputs. A good prediction either confirms
stability with evidence OR diverges with a clearly stated reason.

### Predictive Pricing Rules

- Calculate rate of change over 7, 14, and 30-day windows
- Detect whether momentum is accelerating or decelerating
- Use volume-weighted price trends — high-volume sale days count more
- Rising price + increasing volume = predict continuation
- Rising price + declining volume = predict reversal, flag as unstable
- Discard comps older than 21 days unless volume is too thin
- Weight last 72 hours of sales at 50% of the comp analysis
- Never anchor to a single high sale — require 3+ comps for any confidence

### Card-Level Pricing Weights

| Card Type          | Value Modifier  |
|--------------------|-----------------|
| Rookie card (RC)   | +15 to +25%     |
| 1st Edition        | +10 to +20%     |
| Print run /25      | +40 to +60%     |
| Print run /100     | +20 to +30%     |
| Print run /250     | +10 to +15%     |
| PSA 10 / BGS 9.5   | +30 to +50% vs raw |
| PSA 9              | +10 to +20% vs raw |
| Refractor/parallel | +10 to +30%     |

### Catalyst Detection

Before predicting, scan for upcoming events that will move price:
- Playoff games with milestone implications in next 7 days
- Award announcements: MVP, Cy Young, ROY, Hall of Fame ballot
- Major card shows or PWCC/Goldin auctions in next 14 days
- Upcoming set/pack releases that shift collector attention
- Trade rumors, free agency signings, contract extensions

Apply catalyst multiplier between 0.85 and 1.40 depending on magnitude.

### Confidence Calibration

Reduce confidence when:
- Fewer than 3 comps in last 21 days
- Social sentiment and price trend point in opposite directions
- Player in a documented slump but card price still rising
- Market in broader correction (cross-check Trout, Ohtani as index cards)
- Signal sources are stale (older than their TTL)

Increase confidence when:
- 10+ comps in last 14 days with tight variance (under 15%)
- News, stats, social, and trend signals all agree on direction
- Momentum consistent for 14+ days
- Strong established price floor with repeat buyers

---

## SIGNAL PIPELINE

Every signal produces a multiplier (float, capped 0.70 to 1.50) and a signal
label. All signals are cached in Azure Blob Storage with TTL.

Blob cache key pattern: `compiq/signals/{player_name_slug}/{signal_type}.json`
Per-card comps key:     `compiq/signals/{player_name_slug}/{card_id}/comps.json`

Signal weights in final aggregation (sum to 1.00):
- compsMomentum: 0.20 (12hr TTL — Cardsight-backed; currently returns the
  fallback "unavailable" multiplier 1.0 pending CF-COMPSMOMENTUM-GREENFIELD-CARDSIGHT)
- eBay:          0.20 (4hr TTL — BIN-drop + sell-through blend)
- Reddit:        0.15 (2hr TTL)
- Trends:        0.15 (6hr TTL)
- Odds:          0.15 (4hr TTL)
- Stats:         0.10 (2hr TTL)
- News:          0.05 (3hr TTL)

### Comp source — Cardsight

- Base URL: `https://api.cardsight.ai/v1`
- Auth: `X-API-Key: ${CARDSIGHT_API_KEY}`
- Routing layer: `backend/src/services/compiq/cardsight.router.ts`.
- Cache: 6h TTL on `getPricing` + `searchCatalog`; 24h on `getCardDetail`;
  7-day LRU on `resolveCardId` outcomes.
- Aggregate endpoint: `GET /api/compiq/comps-by-player?playerName=...&product=...&cardYear=...`
  on hobbyiq3 — MCP's `compsLoader.ts` calls this.

---

## REQUIRED PREDICTION OUTPUT SCHEMA

Every price prediction must return exactly this structure. No exceptions.

```json
{
  "predicted_price_72h": 0.00,
  "predicted_price_7d": 0.00,
  "predicted_direction": "rising | falling | stable | volatile",
  "confidence": 0,
  "confidence_reason": "Plain English explanation of confidence level",
  "key_drivers": ["driver1", "driver2", "driver3"],
  "risk_flags": ["flag1", "flag2"],
  "best_time_to_sell": "now | 3 days | 7 days | hold",
  "catalyst_detected": true,
  "catalyst_detail": "string or null"
}
```

---

## AZURE ENVIRONMENT VARIABLES

All Azure Functions require these in Application Settings:

```
AZURE_BLOB_CONNECTION_STRING    your blob storage connection string
CARDSIGHT_API_KEY               your Cardsight API key (sole catalog + comp source)
HOBBYIQ_BACKEND_URL             on compiq-mcp: URL of hobbyiq3 backend (compsLoader calls /api/compiq/comps-by-player)
EBAY_APP_ID                     from developer.ebay.com (free)
EBAY_CERT_ID                    from developer.ebay.com (free)
REDDIT_CLIENT_ID                from reddit.com/prefs/apps (free)
REDDIT_CLIENT_SECRET            from reddit.com/prefs/apps (free)
ODDS_API_KEY                    from the-odds-api.com (free, 500 req/mo)
NEWS_API_KEY                    from newsapi.org (free, 100 req/day)
OPENAI_API_KEY                  your OpenAI key
YOUTUBE_API_KEY                 from console.cloud.google.com (YouTube Data API v3, free 10k units/day) — M10
PSA_API_TOKEN                   from psacard.com developer portal (paid; optional — falls back to neutral 1.0x) — M2
AZURE_SIGNAL_FUNCTION_URL       URL of fn-serve-signals HTTP trigger
AZURE_SIGNAL_FUNCTION_KEY       function key for fn-serve-signals
AZURE_PRICE_FLOOR_URL           URL of fn-price-floor HTTP trigger
AZURE_PRICE_FLOOR_KEY           function key for fn-price-floor
COSMOS_ENDPOINT                 Cosmos DB account endpoint URL
COSMOS_KEY                      Cosmos DB primary key
COSMOS_DB                       Cosmos DB database name (default: compiq)
COSMOS_FLOOR_CONTAINER          Cosmos container for price floors (default: price_floors)
```

MLB Stats API and Google Trends (pytrends) require no credentials.

---

## VOLATILITY & RISK FLAGS

Always auto-flag these conditions in pricing output:

- Thin market: fewer than 5 comps in 30 days — widen confidence interval
- Artificial spike: price jumped over 40% in 7 days with no detected catalyst
- Lagging decline: stats trending down 3+ weeks, price not yet caught up
- Unconfirmed hype: Reddit or Trends spiking but eBay sales not confirming
- Grade sensitivity: PSA 9 vs PSA 10 spread over 40% — price each grade carefully
- Injury risk: injury keyword flag detected in news — reduce confidence
- Stale signals: any signal cache older than its TTL — note in risk flags
- BIN dropping: sellers lowering buy-it-now prices — early softening signal
  before completed comps catch up (H5)
- Low sell-through: under 35% of listings selling — genuine weak demand even
  when listed prices look stable (H7)
- Pre-show spike: within 14 days of a major card show — multiplier applied
  by fn-signal-aggregator from the show calendar (H8)
- Price floor enforced: prediction raised to the card's stored 90-day floor
  minimum from Cosmos — never return a number below this (H6)
- No comp floor: card has never sold and has no floor — prediction is
  speculative only and confidence must be capped

---

## CODE STANDARDS

- **Swift**: async/await everywhere, `@MainActor` for all UI updates,
  `NavigationStack` (never `NavigationView` which is deprecated), `LazyVStack`
  for card lists, cache images with `NSCache` or `URLCache`, never block main
  thread on network.
- **Azure Functions**: Python 3.11+, always return structured JSON, handle cold
  starts gracefully, wrap all external API calls in try/except with fallback
  to multiplier 1.0 so a single failed signal never blocks a price prediction.
- **OpenAI**: always pass full context in prompt, always use `response_format`
  `json_object`, never call for pricing without the signal payload injected.
- **Error handling**: never silently fail — surface actionable errors to the iOS UI.
- **Caching**: all blob reads and writes use the player name slug as the key prefix.
- **Signal fallback**: if any individual signal function fails, default its
  multiplier to 1.0 and continue aggregation — partial signal is better than none.
- **Price floor**: always call `applyPriceFloor()` (MCP) / `apply_price_floor()`
  (Python) as the FINAL step before returning any predicted price — never skip
  this check. The floor is the card's 90-day trimmed minimum sold price.
- **Comp gating**: in the MCP pricing layer, run `evaluateCompGating()` per
  card and clamp the model's confidence to its `max_confidence` ceiling
  (liquid 95 / moderate 80 / thin 65 / very_thin 45; halved further to 55 if
  variance > 40%).

---

## WHAT YOU NEVER DO

- Never wipe inventory state before confirming new data loaded successfully
- Never show a blank card image without first attempting auto-resolution
- Never call OpenAI for pricing without fetching and injecting signal context
- Never return a price without a confidence score and at least 2 key drivers
- Never use the 30-day average sale as the predicted price without adjustment
- Never let combined signal multipliers exceed 1.50 or go below 0.70
- Never leave a TODO, stub, or placeholder in any production code path
- Never use `NavigationView` — always `NavigationStack`
- Never ignore the Known Bugs section when working in related files
- Never return a predicted price below the card's stored 90-day price floor (H6)
- Never assign a confidence score above the `max_confidence` ceiling that
  comp-volume gating computed for the card (H10)
- Never skip the sell-through rate or BIN-trend checks when building eBay
  signals — both feed the eBay multiplier blend (H5 + H7)
- Never reintroduce CardHedge — Cardsight is the sole comp source via
  `cardsight.router`. MCP fetches comps via HTTP from hobbyiq3's
  `/api/compiq/comps-by-player`.
- Never use raw eBay sold data for comps when Cardsight data is available —
  Cardsight is the primary source; eBay is the fallback.
- Never trust an identity match with confidence below 0.80 — applies to
  Cardsight `resolveCardId` — reject and require manual card-id assignment.

---

## HOW TO RESPOND

1. Restate the task in one sentence — what you are changing and why
2. Check Known Bugs — if your change touches those areas, fix them proactively
3. Write complete, production-ready code — no placeholders or stubs
4. Explain key decisions in 2-3 sentences after the code
5. Flag blockers — anything that requires the user's input, keys, or schema changes

---

## OPERATIONAL GOTCHAS

Sharp edges that have wasted time before. Append new entries as they're discovered; keep each entry self-contained with the resource/component name spelled out.

- **App Insights component name**: hobbyiq3 telemetry lives in component `hobbyiq-insights`, NOT in obvious-named alternatives (`HobbyIQ3`, `HobbyIQ`, `appi-hobbyiq-dev`, `appi-hobbyiq-prod`) which exist but are empty. Verify connection string before assuming a component name.

- **GitHub Actions `workflow_dispatch` requires the workflow file to be on the default branch (`main`).** A feature-branch PR cannot be tested via `workflow_dispatch` even with `--ref <branch>` — the API returns HTTP 404 because the workflow definition isn't on `main` yet. GitHub's security model rejects dispatching workflows that don't exist on the protected default branch. Workarounds: (a) merge first then dispatch on `main` (lose pre-merge safety), (b) add a temporary `on: push: branches: [<feature-branch>]` trigger and revert before merge (YAML churn), (c) skip pre-merge testing and observe the first scheduled fire. OIDC federated credentials with `subject: ref:refs/heads/<feature-branch>` do NOT bypass this — the binding constraint is "workflow file on default branch", not "OIDC trust on branch."

- **`az storage blob download --file -` dumps METADATA JSON to stdout, NOT file content.** The actual blob content is written silently to the "-" destination but stdout captures only the metadata wrapper (`{"container":..., "content":"", "properties":{...}}`). Any script that does `content=$(az storage blob download ... --file -)` and then parses `$content` as JSON will fail to find the expected fields. Correct pattern: download to a real tempfile and `cat` it: `tmpfile=$(mktemp); az storage blob download ... --file "$tmpfile" >/dev/null 2>&1; content=$(cat "$tmpfile"); rm -f "$tmpfile"`. Encountered twice in the 2026-05-21 session: initial Workstream A debug pass and the Phase 3a ch-monitor first dry-run (resolved by PR #109).

## LESSONS FROM PRIOR SESSIONS

Append-only log of operating-model lessons captured across sessions. Each entry is dated and self-contained; do not collapse, summarize, or restructure prior entries when adding new ones.

### 2026-05-21 — Compaction summaries can fabricate hybrid claims

Compaction summaries can recombine adjacent true facts into hybrid claims that are plausible but unsupported by the source transcript. When a summary asserts a specific action, decision, or event, verify against the source before acting on it. Mitigation: grep the pre-compaction transcript before propagating any summary claim that drives a plan decision or security-relevant action. Pattern observed 2026-05-21: summary attached rotation-flag from a true storage-key leak onto the most-frequently-mentioned secret name (Cosmos), producing a hybrid claim that did not exist in the transcript.

### 2026-05-21 (extended) — Summary fabrication is not limited to compaction

Resume briefs, hand-off prompts, and mid-session inferences constructed from prior session artifacts can carry the same hybrid-claim failure mode as post-compaction summaries. Three instances observed 2026-05-21:

1. Post-compaction summary recombined Cosmos and storage-key facts into a false COSMOS_CONNECTION_STRING-leaked claim. Caught when the agent verified by grepping the pre-compaction transcript — actual leak was a storage account key, not Cosmos.

2. A session message conflated "PR #101 opened on origin" with "PR #101 merged to main." Caught when the agent verified git state during a downstream deploy that aborted because the EAP fix wasn't actually on main.

3. A resume-brief constructed mid-session asserted W1 rotated the wrong storage account. Caught when the agent verified against committed SECRET_ROTATIONS.md — W1 had rotated both accounts correctly with the active account explicitly identified.

Common shape: a discrepancy is observed, a plausible explanation is constructed, and the explanation propagates as fact without verification against the source artifact. Mitigation: any claim about a prior decision, rotation, merge, commit, or shipped artifact must be verified against repo/git state before being acted on, especially for security-relevant items. The cost of verification is small; the cost of propagation is large.

This applies to claims from any source: compaction summaries, resume briefs, conversation scrollback, the canonical brief itself, or mid-session inferences. Default to verifying.
