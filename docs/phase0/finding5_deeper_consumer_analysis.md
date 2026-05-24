# Phase 0 — Finding 5 deeper consumer analysis

**Captured:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope:** Read-only investigation. No code changes.
**Time budget:** 30–45 min.
**Source:** Workstream A established the consumer chain (commit `7d336ab`). This deepens that finding with: (a) consumer activity classification, (b) in-process cache behavior, (c) Phase 3 cleanup risk refinement, (d) Phase 3a monitor effectiveness evaluation against today's downstream findings.

**Headline.** All three consumer paths from Workstream A are characterized: `mcp-server/compsLoader.ts:fetchPlayerComps()` is **active and uncached** (reads blob fresh every call); `mcp-server/cardhedge.ts:primePlayerComps()` is **dormant** (no production trigger in the prediction path); `backend/src/services/compiq/cardhedge.client.ts` is **near-dormant** (its only live callers are the `/search-list` dead-path route and `cardsight.router.ts`'s non-`exclusive` modes which the production `CARDSIGHT_MODE=exclusive` setting bypasses). Prediction quality degrades within ~15 minutes of CH access going dark (no multi-hour buffer), but the Phase 3a monitor fires only once daily — **detection-vs-degradation lag of up to ~24 hours.** The monitor is correctly scoped to fn-cardhedge-comps's own failure modes but **does not cover Cosmos-using functions' Failure A** (Workstream 2 finding); that's a separate gap, not a defect of the just-shipped monitor.

## 1. Consumer activity classification

### Path 1 — `mcp-server/compsLoader.ts:fetchPlayerComps()` — ACTIVE

**Status: active on every cache-missed prediction request.**

Code-level evidence:
- `compsLoader.ts` is 90 lines, contains **no in-process cache** (grep for `cache|TTL|expir|Map\(` returns zero hits). Each call instantiates `getClient()` (memoized BlobServiceClient) but the actual blob fetch via `readBlobJson<T>` always hits the wire.
- Called from `mcp-server/pricing.ts` (the prediction path inside the MCP server) — every prediction reaches this code path unless something upstream short-circuits.

Production frequency proxy:
- `comp_logs` container shows **444 total rows** lifetime (post writer-flip 2026-05-21T17:44:32Z), spanning ~8 hours = **~55 prediction-route invocations per hour**.
- Backend's 15-min Redis cache on full prediction results (`cacheWrap` at compiq.routes.ts:295/507/678/789 with `CACHE_TTL_SECONDS = 15 * 60`) de-dupes repeated identical queries. True compiq-mcp call frequency is BELOW the comp_logs rate — order-of-magnitude estimate is **~10–30 fetchPlayerComps calls per hour** during active production traffic.
- `compiq-mcp` Web App **does NOT have App Insights wired** (no `APPLICATIONINSIGHTS_CONNECTION_STRING` env var; grep of compiq-mcp app settings shows only `AZURE_BLOB_CONNECTION_STRING` and `COSMOS_CONNECTION_STRING`). MCP-side telemetry is invisible — extends the observability bifurcation documented in W6 capture #7 to a third subsystem.

### Path 2 — `mcp-server/cardhedge.ts:primePlayerComps()` — DORMANT

**Status: dormant on the prediction path; no production caller identified.**

Code-level evidence:
- `primePlayerComps()` calls `identifyCard` + `getCardSales` directly against `api.cardhedger.com` then `writePlayerComps()` to refresh the same blob path `fn-cardhedge-comps` writes nightly.
- This is the **MCP-side on-demand prime path** flagged in Workstream A as a "redundant on-demand writer."
- Grep for `primePlayerComps` outside `mcp-server/cardhedge.ts` itself returns zero hits within the canonical mcp-server. Reachable only via a hypothetical MCP server endpoint or admin tool that I did not find on the live `compiq-mcp` deployment.

Implication: if production prediction traffic does not exercise this path (and I have no evidence it does), `primePlayerComps()` is **vestigial in the live system**. Its existence on the code side doesn't load on Phase 3 cleanup or on the Phase 3a monitor's effectiveness.

### Path 3 — `backend/src/services/compiq/cardhedge.client.ts` — NEAR-DORMANT

**Status: near-dormant on the live prediction path under `CARDSIGHT_MODE=exclusive`.**

Direct callers in backend (grep `cardhedge.client` excluding tests):
- `backend/src/routes/compiq.routes.ts:6` — top-level import of `searchCards`. Only used at line 676 in `/api/compiq/search-list`.
- `backend/src/routes/compiq.routes.ts:676` — `/api/compiq/search-list` route uses `searchCards` directly. **This is the dead-path endpoint per W6.2 finding (zero traffic in 7-day window).**
- `backend/src/services/compiq/cardsight.router.ts:28` — imports `cardhedge.client.ts` exports. Used in router branches that fire when `CARDSIGHT_MODE != "exclusive"`. Production has `CARDSIGHT_MODE=exclusive` (W6 capture #1.6a verified), so these branches are bypassed.

`cardhedge.client.ts` has its OWN cache layer via `cacheWrap` at lines 72, 106, 169 with TTLs:
- `SEARCH_TTL_SEC = 6 * 3600` (6 hours) for `searchCards`
- `MATCH_TTL_SEC = 6 * 3600` (6 hours) for identify
- `COMPS_TTL_SEC = 12 * 3600` (12 hours) for comps

These wrap live `api.cardhedger.com` calls — completely separate from `fn-cardhedge-comps`'s blob writes and `compsLoader`'s blob reads. If `cardhedge.client.ts` was on the live path, it would mask CH access death for 6–12 hours via Redis cache; but it's not on the live path under `exclusive` mode.

## 2. In-process cache layers — explicit map

Per user's addition #1: where does caching live between blob writes and user-facing predictions?

| Layer | Component | TTL | Caches what | Live in production? |
|---|---|---|---|---|
| Application — route | `backend cacheWrap` wrapping `/api/compiq/{search,price,price-by-id,search-list}` | **15 min** (`CACHE_TTL_SECONDS = 15 * 60`) | The FULL prediction-result JSON | YES — every prediction handler |
| Application — upstream API | `cardhedge.client.ts` `cacheWrap` calls | 6 h / 6 h / 12 h | CH live API responses (search / identify / comps) | Near-dormant under `exclusive` mode |
| Application — upstream API | `cardsight.client.ts` `cacheWrap` calls | (varies; lines 216/266/338) | Cardsight live API responses | YES — Site B path active under `exclusive` |
| Application — mcp-server blob reader | `compsLoader.ts:fetchPlayerComps()` | **NONE** | Would have cached blob reads | n/a — no cache layer |
| Storage SDK | Azure Blob SDK / Cosmos SDK | client-level, opaque | Connection pooling, not value caching | n/a |
| Storage source | `compiq-signals/{player}/cardhedge.json` blob | overwritten nightly by `fn-cardhedge-comps` | The actual data | YES — primary source |

**`backend cacheWrap` wraps prediction-result caches, NOT blob-read caches** — confirms user's distinction. The MCP server is the bridge between cached prediction results (backend Redis) and fresh blob data (`compsLoader`). There is **no multi-hour cache between blob and prediction.**

### Quantifying degradation timing

Scenario: CH access dies cleanly at time `T`.

| t = T + … | What happens |
|---|---|
| 0 → 2 hours | `fn-cardhedge-comps` next nightly fire (could be up to 24h away depending on T relative to 02:00 UTC). Until that fire, blobs are intact and prediction quality is unchanged. |
| Next nightly fire | Function runs, CH 401s, function writes blobs with `comp_count: 0, signal: "no_match"` payloads (per Workstream A code review). Blob mtime refreshes. |
| Immediately after | `compsLoader.fetchPlayerComps()` reads the empty blob fresh on every call (no cache mask). Returns `[]`. Pricing engine sees zero comps. |
| 0 → 15 min after first empty-blob prediction | Backend Redis cache may still hold the prior healthy prediction for the same query. Repeat-query users get stale-but-healthy answers. |
| 15 min after | Redis caches expire. Next request for the same query computes a fresh degraded prediction from empty comps. **Prediction quality fully degraded for all queries within 15 minutes of the first CH-failed nightly write.** |
| Up to 26 hours after the CH-failed nightly write | Phase 3a monitor's daily 02:30 UTC schedule fires. Detects `comp_count < 10` across all 5 players. Creates incident issue. |

**Detection-vs-degradation lag: up to ~24 hours** (worst case: CH dies just after the 02:30 UTC monitor fires for the day; outage runs the full 24h before next fire detects it). Within that window, predictions are silently degraded.

This is a **real gap** but a tolerable one for a tripwire (the monitor's purpose was always "catch the day CH dies", not "catch the minute"). Reducing lag would require either (a) more frequent monitor runs (e.g., hourly), (b) real-time blob-write observability, or (c) prediction-quality monitoring downstream that doesn't depend on `fn-cardhedge-comps`'s own output as the signal source.

## 3. Phase 3 cleanup risk refinement

The original Workstream A risk framing: "the function is producing real, high-quality data and the cancellation has not yet impacted access." Refined now:

**If Phase 3 disables `fn-cardhedge-comps`** (e.g., as part of a planned cleanup):
- `compsLoader.fetchPlayerComps()` sees stale-then-empty blob immediately (no cache buffer at the MCP layer)
- Backend's 15-min Redis cache buffers existing predictions for 15 minutes max
- After 15 minutes: prediction quality fully degrades to the Cardsight-only path (which runs in parallel via `cardsight.router.ts` Site A under `exclusive` mode)
- **There is no "stale data still flowing for days" risk.** `compsLoader` is uncached; stale-data flow ceases at the next read.

**Cardsight-only fallback under `exclusive` mode:** the router's Site A path uses `cardsight.client.ts` (its own 6h+ cache TTLs). When `compsLoader` returns empty comps, the pricing engine has whatever Cardsight returns to work with. Cardsight coverage gap behavior (per the W2 close-out DailyIQ coverage gap Finding 12) determines what happens next.

**Phase 3 cleanup is therefore lower-risk than the Workstream A framing implied**, with one important caveat: **the Phase 3 PR must not also disable `cardsight.router.ts`'s Site A or weaken Cardsight fallback** — that would compound the loss of CH data with loss of the fallback path.

## 4. Phase 3a monitor effectiveness against Workstream 2 findings

Per user's addition #2: explicit evaluation of the just-shipped Phase 3a monitor against COSMOS_KEY findings.

### Does the monitor catch fn-cardhedge-comps's own write failures?

- `fn-cardhedge-comps` does NOT use Cosmos. Source review (Workstream A + W2 confirmation): zero `cosmos|COSMOS_` references anywhere in `fn-cardhedge-comps/__init__.py` or `function.py`. The function only writes to Azure Blob.
- The Workstream 2 COSMOS_KEY stale-key defect therefore **does not affect** `fn-cardhedge-comps` directly.
- The Phase 3a monitor's blob-side signals (`comp_count < 10`, `lastModified > 25h`) are sufficient to detect `fn-cardhedge-comps`'s actual failure modes: function-not-running (mtime staleness) and CH-access-revoked (comp_count drop).
- **The "function ran but its own writes failed" case** the user asked about: this is a non-existent failure mode for `fn-cardhedge-comps` because it has no Cosmos writes that could fail. The blob writes are the only writes; the monitor catches their absence.

### Does the monitor catch OTHER functions' Cosmos auth failures?

- `fn-nightly-comp-prefetch` and `fn-price-floor` have real Cosmos auth dependencies and ARE affected by the stale-COSMOS_KEY defect (per W2). The Phase 3a monitor was scoped specifically to `fn-cardhedge-comps`'s output and does NOT monitor these other functions.
- This is **not a defect in the Phase 3a monitor** — it's a coverage gap. The monitor was scoped to one function for clean shippable scope. Other functions' health monitoring is its own future workstream.

### Refined statement of monitor coverage

The Phase 3a monitor catches:
- ✅ `fn-cardhedge-comps` not running (mtime > 25h)
- ✅ `fn-cardhedge-comps` running but writing empty/degraded blobs (`comp_count < 10`)

The Phase 3a monitor does NOT catch:
- ❌ Backend prediction-quality degradation within the 24h detection window (prediction degrades in ~15 min; monitor lag is up to 24h)
- ❌ `fn-nightly-comp-prefetch` or `fn-price-floor` Cosmos auth failures (W2 finding; outside monitor scope)
- ❌ `compiq-mcp` runtime health (no App Insights wiring on the Web App; observability bifurcation extends here)
- ❌ Cardsight-side degradation that would mask itself as healthy via `cardsight.client.ts`'s 6h+ TTL cache

These gaps are all real but were all outside the Phase 3a scope. The monitor is correctly scoped for its job. The gaps document themselves here for future monitoring workstreams.

## 5. Summary of new findings beyond Workstream A

1. **`compsLoader.ts` has zero in-process cache.** Prediction quality degrades within ~15 minutes of CH access dying (bounded by backend Redis TTL), not gradually over hours/days.
2. **`compiq-mcp` has no App Insights wiring.** MCP-side telemetry is invisible — observability bifurcation extends from W6 capture #7 to a third subsystem.
3. **`compiq-mcp` uses `COSMOS_CONNECTION_STRING` + three-tier auth** (verified via `predictionLog.ts:31-35`), so MCP is **not affected** by W2's stale-`COSMOS_KEY` defect.
4. **`mcp-server/cardhedge.ts:primePlayerComps` is dormant**; no production caller in the prediction path. Effectively vestigial.
5. **`backend/src/services/compiq/cardhedge.client.ts` is near-dormant** under `CARDSIGHT_MODE=exclusive`; its only live callers are `/api/compiq/search-list` (dead per W6.2 zero-traffic finding) and `cardsight.router.ts` non-exclusive branches (bypassed by current mode).
6. **Phase 3a monitor detection-vs-degradation lag: up to ~24 hours.** Prediction quality degrades faster than the daily-fire schedule can detect. Reducing lag is a future enhancement (hourly fire, real-time observability, or downstream prediction-quality monitoring).
7. **Phase 3 cleanup is lower-risk than originally framed:** no multi-hour stale-data flow because `compsLoader` is uncached. Caveat: Phase 3 must preserve `cardsight.router.ts` Site A fallback or compound failure modes.

## Anti-drift note

This document characterizes consumer activity and Phase 3 risk. It does not propose remediation. Specific things NOT proposed here: increasing Phase 3a monitor frequency, wiring App Insights on compiq-mcp, adding `primePlayerComps` exercise, adding compsLoader caching, or any code change to `cardhedge.client.ts`. All are decisions for their own focused workstreams.

---

## v2 addendum (2026-05-23) — re-verification + new operational findings

**Why this addendum:** Today's MCP rewire Phase 1 Step 1 diagnostic surfaced production evidence that materially extends two of the original findings (#2 obsolete; #3 narrowed) and adds a new monitor-coverage finding. Re-verification on 2026-05-23 also confirms findings #1, #4, #5, #6, #7 remain accurate as written.

### v2-1. Consumer activity unchanged

Re-grepped on 2026-05-23:

- `mcp-server/compsLoader.ts`: zero cache (90 LOC, no `cache|TTL|expir|Map\(` hits) — re-confirmed ACTIVE & UNCACHED.
- `mcp-server/cardhedge.ts:primePlayerComps`: still no production caller — re-confirmed DORMANT.
- `backend/src/services/compiq/cardhedge.client.ts` callers: `compiq.routes.ts:6` import + `compiq.routes.ts:676` (search-list dead path) + `cardsight.router.ts:28` (non-exclusive branches bypassed) — re-confirmed NEAR-DORMANT under `CARDSIGHT_MODE=exclusive`.

### v2-2. cacheWrap layer unchanged (verifies original §2 distinction)

`grep cacheWrap backend/src/routes/compiq.routes.ts` on 2026-05-23:

- Line 167: `const CACHE_TTL_SECONDS = 15 * 60;` (unchanged)
- Lines 299/511/682/793: four `cacheWrap(cacheKey, async () => {...}, CACHE_TTL_SECONDS)` blocks (slight line drift from original 295/507/678/789, otherwise identical)

Confirms: **`cacheWrap` wraps full prediction-result JSON at route handlers, NOT blob-read responses.** Original §2 table row "Application — route" still accurate. No multi-hour in-process cache between blob and prediction.

### v2-3. SUPERSEDES original finding #2 — `compiq-mcp` now HAS App Insights wiring

Original 2026-05-22 doc: "compiq-mcp Web App does NOT have App Insights wired."

**Re-verified 2026-05-23:**

```bash
az webapp config appsettings list -g rg-hobbyiq-dev -n compiq-mcp \
  --query "[?contains(name, 'APPLICATIONINSIGHTS')].name"
```

returns `["APPLICATIONINSIGHTS_CONNECTION_STRING"]`. Telemetry verified flowing: `requests | summarize by cloud_RoleName` over 7d shows `compiq-mcp = 3 req`, `HobbyIQ3 = 71 req` (low traffic, but pipeline is live).

Observability bifurcation no longer extends to compiq-mcp. Backend App Insights and compiq-mcp telemetry both land in `hobbyiq-insights` (InstrumentationKey `02dca1c0-…`). Original finding #2 is OBSOLETE.

### v2-4. NARROWS original finding #3 — MCP `COSMOS_CONNECTION_STRING` IS stale (silent predictionLog write failure)

Original 2026-05-22 doc: "`compiq-mcp` uses `COSMOS_CONNECTION_STRING` + three-tier auth, so MCP is not affected by W2's stale-`COSMOS_KEY` defect."

The auth-mechanism statement holds: MCP reads `COSMOS_CONNECTION_STRING` not `COSMOS_KEY`. **But the CS-form key on compiq-mcp + HobbyIQ3 has ALSO been rotated out of sync.** Verified 2026-05-23 by comparing the configured CS against all 4 live keys (primary, secondary, primary-RO, secondary-RO) from `az cosmosdb keys list -n hobbyiq-comps -g rg-hobbyiq-dev --type connection-strings`:

```bash
az webapp config appsettings list -g rg-hobbyiq-dev -n compiq-mcp \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]"
# matches NONE of the 4 live connection-strings → CS is stale
```

Production evidence:

- `compiq_predictions` container total all-time rows: **6**
- Earliest: 2026-05-10T15:04:41Z
- Latest: 2026-05-12T18:54:27Z (11 days ago)
- No new predictionLog writes since 2026-05-12 (Cosmos key rotation likely occurred around then)
- Failure mode: silent. `mcp-server/predictionLog.ts:108-119` uses fire-and-forget `void (async () => { try { … } catch { console.warn(…) } })()`, so writes failing at auth boundary never block prediction responses and never raise visible exceptions.

This narrows finding #3: MCP's *auth mechanism* is different (CS, not KEY) but is **affected by the same underlying rotation event**, just via a different env-var surface.

### v2-5. NEW finding — fn-compiq's COSMOS_KEY is also stale; multiple functions silently failing in production

`fn-compiq` function app's `COSMOS_KEY` env var matches neither live primary nor secondary master key (verified 2026-05-23 with `az functionapp config appsettings list … --query "[?name=='COSMOS_KEY'].value"` vs `az cosmosdb keys list -n hobbyiq-comps --query 'primaryMasterKey'` / `'secondaryMasterKey'`).

Production smoking-gun evidence from `fn-compiq` App Insights (component `fn-compiq`, key `f7eebd2c-…`) over 7d:

| Function | Executions (7d) | Outcome | Symptom |
| --- | --- | --- | --- |
| fn-price-floor | 3 | "Succeeded" (host-level) | Each run logs Sev-2 `Cosmos container init failed: (Unauthorized) The input authorization token can't serve the request` immediately before the host's "Succeeded" trace. Last failure 2026-05-24T00:17:55Z. |
| fn-youtube-signals | 1 | Succeeded | Not Cosmos-dependent (blob-only) |
| fn-stats-signals | 1 | Succeeded | Not Cosmos-dependent |
| fn-signal-aggregator | 1 | Succeeded | Not Cosmos-dependent |
| fn-odds-signals | 1 | Succeeded | Not Cosmos-dependent |
| fn-news-signals | 1 | Succeeded | Not Cosmos-dependent |

Why "Succeeded" despite 401: the Cosmos-init failure path is caught and logged as Sev-2 warning; the function body exits without doing its Cosmos work; the Functions host sees no thrown exception and records the invocation as Succeeded. **Function-level metrics show 100% success rate while the function does zero useful work.** This is the textbook "function ran but its own writes failed" pattern the user asked about.

### v2-6. NEW finding — Phase 3a monitor coverage gap, now actively triggered

Direct answer to the user's WS3 addition #2 question: "does the monitor catch 'function ran but its own writes failed'?"

**For `fn-cardhedge-comps` itself:** still irrelevant. Source confirmed 2026-05-23 (`grep cosmos compiq-functions/fn-cardhedge-comps` returns zero hits) — fn-cardhedge-comps has no Cosmos writes that could fail. The Phase 3a monitor's blob-side signals (mtime > 25h, comp_count < 10) remain sufficient for this specific function.

**For OTHER Cosmos-writing functions sharing the same function app (`fn-compiq`):** monitor does NOT cover them, and v2-5 demonstrates this gap is actively manifesting in production *right now*. Phase 3a monitor's `.github/workflows/ch-monitor.yml` (re-read 2026-05-23) is scoped specifically to `STORAGE_ACCOUNT=stcompiqfnotgm2` blob inspection for the 5 active players. Nothing about it would detect `fn-price-floor`'s Cosmos 401 loop.

This is **not a defect in the Phase 3a monitor** — it was correctly scoped to one function for clean shippable scope (original §4 statement holds). But the previously-documented "future workstream" for other-function Cosmos health monitoring is **now urgent**: production evidence shows the gap is live, not theoretical.

### v2-7. NEW finding — predictionLog data starvation impacts MCP rewire Phase 2

Phase 1 of the MCP rewire (currently in design) is unaffected: it adds `/api/compiq/comps-by-player` reading from Cardsight, not predictionLog. **Phase 2 (MCP `compsLoader` rewire) and any backtest-driven calibration are materially impacted**: 11+ days of zero new predictionLog rows means the backtest loop is operating against a stale 6-row dataset.

Order-of-operations implication: any backtest-driven decision (calibration, confidence-ceiling tuning, MAE/MAPE bucket analysis) made between 2026-05-12 and the rotation-fix landing should be flagged as "based on pre-rotation data only."

### v2-8. Carry-forward summary added by this addendum

| ID | Carry-forward | Severity | Earliest fix |
| --- | --- | --- | --- |
| CF-COSMOS-ROT | Cosmos master-key rotation broke `COSMOS_CONNECTION_STRING` (compiq-mcp, HobbyIQ3) and `COSMOS_KEY` (fn-compiq). Symptoms: silent predictionLog write failure (11+ days), `fn-price-floor` Cosmos 401 loop, likely `fn-player-score-refresh` + `fn-nightly-comp-prefetch` similarly affected (not directly verified). | High (operational; observability gap) | Bounded workstream — refresh 3 env vars across 1 webapp + 1 webapp + 1 functionapp, restart apps, verify with a single predict request landing a fresh predictionLog row. ~15 min. |
| CF-MONITOR-COVERAGE | Phase 3a monitor scope is correct for fn-cardhedge-comps but does not cover other Cosmos-writing functions whose silent-failure mode is now demonstrated in production. | Medium (a real gap with live impact) | Separate workstream — either extend monitor with App Insights query of `exceptions/traces where message contains 'Cosmos container init failed'`, or add a per-function "wrote a row in last N hours" tripwire. |
| CF-PREDICTIONLOG-VOLUME | Independent of rotation: even pre-2026-05-12, only 6 rows in 90d. Backtest dataset is structurally tiny. | Low-medium (deferrable) | Investigate why per-prediction logging is so sparse — sampling rate? `source: predict` filter excluding `prime`? Bot/synthetic-only? Separate finding. |

### Anti-drift note for v2

This addendum extends characterization. It does not propose remediation; CF-COSMOS-ROT, CF-MONITOR-COVERAGE, CF-PREDICTIONLOG-VOLUME are all explicitly scoped as separate future workstreams. No code or config changes are proposed here.
