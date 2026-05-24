# Silent-failure audit — fetch() telemetry blind spots + error-swallowing patterns

**Captured:** 2026-05-24 (CF-SIGNAL-SILENT-FAILURE-AUDIT)
**Scope:** Read-only audit. Catalogs findings; does NOT fix them.
**Predecessor:** [phase4b_diagnostic_findings.md](phase4b_diagnostic_findings.md) addendum at e26db5d (today's fourth framing inversion — signal URL misconfiguration masked by env-var-presence health check + `fetchSignals` error swallowing).
**Tactical fix already shipped:** CF-HEALTH-SIGNAL-URL-CHECK at c30685e (PR #123) — `/health` now performs real URL probes that would have surfaced today's specific case. This audit looks for OTHER instances of the same patterns.

---

## 1. Context

Today's diagnostic established two compounding patterns that allowed a production misconfiguration to go undetected:

**Pattern 1 — `fetch()` is an App Insights auto-instrumentation blind spot.** The Node 18+ global `fetch()` does NOT auto-instrument into App Insights' `dependencies` table. Only the legacy `http`/`https` modules (which the OpenAI SDK and `@azure/cosmos` use internally) auto-track. Direct `fetch()` calls produce no dependency telemetry — misconfigured URLs, transient failures, and slow responses are invisible to observability.

**Pattern 2 — Error-swallowing without surfacing.** Code that catches exceptions and returns degraded/default values (NEUTRAL_SIGNAL, null, []) without logging or alerting. Callers continue with bad data thinking everything succeeded. The classic exemplar:

```ts
// mcp-server/pricing.ts:fetchSignals (pre-fix path, structure intact)
try {
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
  if (!resp.ok) return { ...NEUTRAL_SIGNAL };  // ← 404 silent fallback
  // ...
} catch {
  return { ...NEUTRAL_SIGNAL };  // ← any exception silent fallback
}
```

Stacked together: a `fetch()` produces no telemetry → fails to a default → caller never knows. Today's URL misconfig case demonstrates the full chain — `AZURE_SIGNAL_FUNCTION_URL` pointed at a 404 path, every prediction silently took the NEUTRAL_SIGNAL path, and no observable signal indicated the failure.

This audit catalogs OTHER instances of these patterns so future work can be sequenced.

### Inventory totals

- **`fetch()` call sites:** 5 in mcp-server production code (1 audit script excluded), ~22 in backend
- **Catch blocks examined:** ~30 across mcp-server + backend (sample)
- **Azure Functions examined:** 1 (fn-price-floor — depth-checked); others surveyed
- **App Insights coverage gap:** ALL `fetch()` calls bypass dependency auto-instrumentation. Only structured logs (via `console.warn` + JSON) reach App Insights, and only `traces` table, not `dependencies`.

---

## 2. Pattern 1 findings — `fetch()` telemetry blind spots

### Prediction-path call sites (mcp-server)

| # | File:Line | Function | Dependency | Error path | Telemetry | Severity |
|---|---|---|---|---|---|---|
| 1.1 | [pricing.ts:232](../../mcp-server/pricing.ts#L232) | `fetchSignals` | fn-serve-signals (Azure Function) | `!resp.ok` → NEUTRAL_SIGNAL; catch → NEUTRAL_SIGNAL | **None** (no log, no metric) | **HIGH** — today's exemplar |
| 1.2 | [pricing.ts:270](../../mcp-server/pricing.ts#L270) | `fetchPriceFloor` | fn-price-floor (Azure Function) | `!resp.ok` → null; catch → null | **None** | **HIGH** — identical pattern; would mask floor-fetch outages |
| 1.3 | [compsLoader.ts:165](../../mcp-server/compsLoader.ts#L165) | `fetchPlayerComps` | hobbyiq3 backend `/api/compiq/comps-by-player` | `!res.ok` → structured `log.warn` + return []; catch → `log.warn` + return []; timeout → `log.warn` + return [] | **Partial** (structured `log.warn` → App Insights traces, NOT dependencies) | **MEDIUM** — logged but no automatic failure signal; surfaces in traces if operator searches |
| 1.4 | [cardhedge.ts:29](../../mcp-server/cardhedge.ts#L29) | `postJson` (CardHedge AI) | CardHedge API (legacy, decommissioning) | `!resp.ok` → throws (caller handles) | **None** (no log, throws to caller) | **LOW** — throws is the correct pattern; CardHedge being phased out anyway |
| 1.5 | [healthChecks.ts:66](../../mcp-server/healthChecks.ts#L66) | `checkUrlReachable` | various probed URLs | catch → `UrlHealth { status: URL_UNREACHABLE }` | **Intentional** (exposed via `/health` response) | **N/A — by design** (post-fix, surfaces explicitly) |

### Backend hot-path call sites

| # | File:Line | Function | Dependency | Error path | Telemetry | Severity |
|---|---|---|---|---|---|---|
| 1.6 | [cardsight.client.ts:154](../../backend/src/services/compiq/cardsight.client.ts#L154) | `fetchWithRetry` | Cardsight API | timeout → throws `CardsightTimeoutError`; non-2xx (non-404) → throws `CardsightApiError`; structured `log.warn` on retry/timeout | **Partial** (structured logs to traces) | **LOW** — explicit error types, retry logic, structured logging; not silent |
| 1.7-1.9 | [cardhedge.client.ts:77, 124, 183](../../backend/src/services/compiq/cardhedge.client.ts#L77) | `_searchCards`, `_identifyCard`, `_getCardSales` | CardHedge legacy | catch → return []/null with `console.warn` | **Partial** (`console.warn` reaches App Insights traces via auto-capture) | **MEDIUM** — logged but bypasses dependencies table; CardHedge phasing out so prioritize after CF-CARDHEDGE-CLIENT-DELETE lands |
| 1.10 | [ebayAuth.service.ts:136](../../backend/src/services/ebay/ebayAuth.service.ts#L136) | exchangeAuthCode → Identity API sub-call | eBay Identity API | catch → `console.log` + `ebayUserId = "unknown"` (continues with fallback) | **Partial** (`console.log` only) | **MEDIUM** — user sign-in flow continues with degraded user-id; downstream listing flows may fail; needs structured logging at minimum |
| 1.11 | [ebayListing.service.ts:349](../../backend/src/services/ebay/ebayListing.service.ts#L349) | listing API call | eBay Listing API | Not investigated in this pass — sample only | **Unknown** | **DEFER** — investigate as part of CF-EBAY-FETCH-AUDIT |
| 1.12 | [psaCert.service.ts:84](../../backend/src/services/psa/psaCert.service.ts#L84) | `lookupPsaCert` | PSA API | throws `PsaApiError` with structured codes (PSA_AUTH_FAILED, PSA_QUOTA_EXCEEDED, PSA_REQUEST_FAILED); 401/403/429 mapped explicitly | **Partial** (structured errors, no dep telemetry) | **LOW** — explicit error types, surfaces to caller; not silent |
| 1.13 | [appleAuth.ts:44](../../backend/src/services/appleAuth.ts#L44) | `fetchAppleJwks` | Apple JWKS endpoint | `!res.ok` → throws | **None** (no log, throws) | **LOW** — throws + JWKS-fetch failures will fail Apple sign-in loudly upstream; not silent |
| 1.14-1.18 | DailyIQ services (`mlbBoxScoreService.ts:180`, `milbBoxScoreService.ts:218`, `probablePitchersService.ts:65`, `recentFormService.ts:164`, `dynamicIngestion.service.ts:233`) | MLB Stats API | `!response.ok` → throws `Error(\`MLB Stats API ${status}\`)` | **None** (no log, throws) | **LOW** — throws is correct; DailyIQ batch jobs surface upstream as job failures |
| 1.19-1.20 | [playerScore/mlbStats.service.ts:58](../../backend/src/services/playerScore/mlbStats.service.ts#L58), [mlb/playerResolver.service.ts:90](../../backend/src/services/mlb/playerResolver.service.ts#L90) | MLB Stats | Similar — throws | **None** | **LOW** |
| 1.21 | [sportsCardsPro/client.ts:71](../../backend/src/services/sportsCardsPro/client.ts#L71) | SCP API | Not investigated in this pass | **Unknown** | **DEFER** |
| 1.22 | [routes/dailyiq.routes.ts:1272](../../backend/src/routes/dailyiq.routes.ts#L1272) | DailyIQ route | Not investigated | **Unknown** | **DEFER** |
| 1.23 | [routes/ops.routes.ts:116](../../backend/src/routes/ops.routes.ts#L116) | Ops probe | Likely a probe (similar to healthCheck shape) | **Unknown** | **DEFER** |
| 1.24-1.26 | Beckett + CardboardConnection agents | External scraping targets | Best-effort agents; failures expected | **Various** | **LOW** — agent jobs designed to tolerate scraping failures |

### Aggregate Pattern-1 picture

- **26 `fetch()` call sites total** across both repos (5 mcp + ~21 backend) → ZERO show up in App Insights `dependencies` table
- **2 HIGH-severity** (mcp `fetchSignals`, `fetchPriceFloor` — the prediction-path swallowers)
- **3 MEDIUM-severity** (mcp `fetchPlayerComps`, cardhedge.client.ts trio, ebay Identity sub-call)
- **Most remainder LOW** — throws to caller, not silent at the call site

The HIGH cases are the load-bearing ones: prediction quality depends on signal + floor data flowing, and both swallow errors.

---

## 3. Pattern 2 findings — error-swallowing without surfacing

This pattern overlaps heavily with Pattern 1 (most silent fetch calls are also catch-block swallowers). Distinct cases worth highlighting separately:

### Distinct Pattern-2 cases (not covered by Pattern 1)

| # | File:Line | Pattern | What's swallowed | Returns | Severity |
|---|---|---|---|---|---|
| 2.1 | [pricing.ts:282](../../mcp-server/pricing.ts#L282) | `try/{} catch { return null }` | any throw from `fetchPriceFloor` body | null | **HIGH** (same as 1.2 — listed for completeness) |
| 2.2 | [pricing.ts:247](../../mcp-server/pricing.ts#L247) | `try/{} catch { return ... }` | any throw from `fetchSignals` body | NEUTRAL_SIGNAL | **HIGH** (same as 1.1) |
| 2.3 | [backtest.ts:269](../../mcp-server/backtest.ts#L269) | `try/{} catch(err) { summary.errors.push(...); continue }` | per-group fetch failure | error surfaced in summary.errors; group skipped | **LOW** (errors are surfaced in result; correct pattern) |
| 2.4 | [cardhedge.ts:117](../../mcp-server/cardhedge.ts#L117) | `JSON.parse` wrapped in `try/catch` returning null | parse failure | null | **LOW** (defensive, returning falsy lets caller decide) |
| 2.5 | [predictionLog.ts:113](../../mcp-server/predictionLog.ts#L113) | fire-and-forget; catch → `console.warn` | Cosmos write failures | (no return; fire-and-forget) | **MEDIUM** — predictions silently fail to log if Cosmos has a transient issue; backfill is impossible because predictions are not retried. Mitigation: structured log surfaces it in traces. |
| 2.6 | [healthChecks.ts:75-79](../../mcp-server/healthChecks.ts#L75) | catch → URL_UNREACHABLE with structured error message | network errors | UrlHealth | **N/A — by design** |

### Backend distinct Pattern-2 cases

| # | File:Line | Pattern | Severity |
|---|---|---|---|
| 2.7 | Service-layer `catch { return null }` blocks throughout `backend/src/services/compiq/` (multiple sites) | Defensive degradation; caller continues with empty/null result | **MEDIUM** — most are partial-result-tolerant by design; needs structured logging at minimum |
| 2.8 | Cardhedge client `.catch(() => "")` on `resp.text()` (cardhedge.ts:39) | Drops error message detail on response-body read failure | **LOW** (loses some debug context; non-critical) |
| 2.9 | Cardsight translator's "company not found" path returns `[]` + structured warn ([cardsight.translator.ts:51-58](../../backend/src/services/compiq/cardsight.translator.ts#L51)) | Logs the grade-company-not-found case as a warn, returns empty | **LOW — example of correct pattern** (structured warn names what's degraded) |

### Aggregate Pattern-2 picture

The high-severity Pattern-2 cases are the same two prediction-path `fetchSignals`/`fetchPriceFloor` already covered under Pattern 1. The medium-severity cases (predictionLog.ts fire-and-forget; backend service-layer defensive blocks) are real but lower-priority — they're at least surfaced in `console.warn` / structured logs that reach App Insights `traces` table.

---

## 4. Severity classification rationale

| Severity | Criterion | Count | Action policy |
|---|---|---|---|
| **HIGH** | User-facing impact: silently degrades prediction quality; no operator-visible signal | 2 (fetchSignals, fetchPriceFloor) | Address before next prediction-pipeline workstream; tactical fix possible in a single bounded PR |
| **MEDIUM** | Operational debt: surfaces in logs but not in dep telemetry; observability hole that delays detection | 5-6 | Cluster into one structural workstream (CF-FETCH-TELEMETRY-WRAPPER) |
| **LOW** | Defensive-by-design OR throws-to-caller (not actually silent) | majority | Document; do not act unless surfaced in a future incident |
| **N/A — by design** | Intentionally exposes status to caller (e.g., `/health`) | 2 | No action |
| **DEFER** | Not investigated in this audit pass | 4 | Capture as audit-scope follow-up if needed |

---

## 5. Recommended carry-forward workstreams

### CF-FETCH-SIGNAL-FLOOR-TELEMETRY (~30-45 min, HIGH priority)

**Scope:** Add structured logging + manual `appInsights.defaultClient.trackDependency()` calls inside `mcp-server/pricing.ts:fetchSignals` and `fetchPriceFloor`. Targets the two HIGH-severity findings (1.1, 1.2 / 2.1, 2.2).

**Why bundled:** Both functions are in `pricing.ts`, both have identical error-handling shapes, both feed the prediction path. Single PR can fix both with parallel changes.

**Specific changes:**
- On `!resp.ok` and on `catch`: emit `appInsights.defaultClient.trackEvent({ name: "signal_fetch_degraded", properties: { status_code, latency_ms, fallback: "neutral_signal" } })` (App Insights `customEvents` table)
- Plus `trackDependency` for completeness (App Insights `dependencies` table)
- Plus structured `console.warn` JSON for traces table fallback

**Acceptance:** trigger a real fault (point AZURE_SIGNAL_FUNCTION_URL at a bogus path) and verify the failure appears in App Insights within 2 minutes via either dependencies or customEvents table.

**Why now:** CF-HEALTH-SIGNAL-URL-CHECK shipped today catches the URL-misconfig case proactively. CF-FETCH-SIGNAL-FLOOR-TELEMETRY catches REACTIVE degradation (e.g., fn-compiq is down, network blip, transient 5xx). The two are complementary; both are needed for full coverage.

### CF-FETCH-TELEMETRY-WRAPPER (~2-4 hours, MEDIUM priority, optional)

**Scope:** Create a shared `trackedFetch()` wrapper in `mcp-server/` and `backend/src/shared/` that wraps `fetch()` with `trackDependency` + structured logging by default. Refactor existing call sites to use it.

**Why optional:** The HIGH-severity cases are addressed cheaper by CF-FETCH-SIGNAL-FLOOR-TELEMETRY. The wrapper provides systemic coverage but at a much larger refactor cost (26 call sites + tests). Consider only if a second silent-failure incident shows the cluster pattern is recurring.

**Trade-off:** A wrapper introduces a layer of indirection that reduces the obviousness of network calls in code review. CardHedge client's `console.warn`-then-return pattern is already operator-friendly; converting it to wrapper calls may add observability without changing reviewer ergonomics meaningfully.

### CF-PREDICTIONLOG-WRITE-DETECT (~15-20 min, MEDIUM priority)

**Scope:** [predictionLog.ts:113](../../mcp-server/predictionLog.ts#L113) currently fire-and-forgets Cosmos writes. If Cosmos has a transient outage, predictions never get logged and there's no backfill mechanism. Add either (a) a small retry loop with backoff or (b) an in-memory queue that retries on next prediction.

**Why MEDIUM:** Today's predictionLog has ~7 rows total (per earlier diagnostic). Volume is currently too low for missing predictions to matter — but as volume grows, silent write failures will hurt backtest data integrity.

**Defer until:** prediction volume reaches a threshold where data loss matters (call it 100+ predictions/day, or whenever the next backtest iteration is sequenced).

### CF-EBAY-IDENTITY-LOGGING (~10 min, MEDIUM priority)

**Scope:** [ebayAuth.service.ts:136-148](../../backend/src/services/ebay/ebayAuth.service.ts#L136) — when the eBay Identity API sub-call fails, the code logs via `console.log` (not even `console.warn`) and continues with `ebayUserId = "unknown"`. Downstream listing flows that depend on the ebayUserId may fail in non-obvious ways. Upgrade to structured `console.warn` JSON with the actual error class.

**Why MEDIUM:** sign-in flow continues to work (no user-facing break) but `ebayUserId = "unknown"` propagates into the token record and ledger associations. May confuse downstream operator queries.

### CF-EBAY-FETCH-AUDIT (~60-90 min, MEDIUM-LOW priority)

**Scope:** Investigate the deferred eBay fetch call sites (ebayListing.service.ts:349 and surrounding) for the same patterns. Sample-only checked in this audit; full per-line audit needed for the listing flow specifically.

**Defer until:** eBay listing flow has a documented production incident OR a major refactor warrants the investigation.

---

## 6. Anti-findings — cases that LOOK like silent failures but aren't

Documenting these so the audit is honest about scope:

### 6.1 `cardhedge.ts:postJson` throws on error (mcp-server/cardhedge.ts:38-41)
Catches no exceptions — re-throws all errors with context. The caller decides what to do. Correct pattern; not silent.

### 6.2 `cardsight.client.ts:fetchWithRetry` distinguishes error classes (backend/src/services/compiq/cardsight.client.ts:147-198)
Timeout → `CardsightTimeoutError`. Non-2xx → `CardsightApiError` with status code. Structured `log.warn` on retry attempts. Correct pattern; not silent at this layer.

### 6.3 `psaCert.service.ts` returns explicit `PsaApiError` codes (backend/src/services/psa/psaCert.service.ts:95-101)
Different HTTP status codes map to different error codes (PSA_AUTH_FAILED, PSA_QUOTA_EXCEEDED, PSA_REQUEST_FAILED). Caller can dispatch on the code. Correct pattern; not silent.

### 6.4 DailyIQ services throw with status detail (multiple)
`throw new Error(\`MLB Stats API ${status}\`)` — fail loudly with status info. Batch jobs surface upstream. Correct pattern; not silent.

### 6.5 `/health` real probes return UrlHealth structs (mcp-server/healthChecks.ts)
Catch returns `URL_UNREACHABLE` with error message — but this is the WHOLE POINT of `/health`. The catch is correct because the status is part of the response contract. Not silent; intentionally exposed.

### 6.6 `backtest.ts:summary.errors.push(...)` (mcp-server/backtest.ts:269)
Per-group fetch failure pushed to `summary.errors` array that's surfaced in the JSON response. The caller (admin endpoint) sees all errors after the run. Correct pattern; not silent.

### 6.7 `cardsight.translator.ts` "company not found" warn (backend/src/services/compiq/cardsight.translator.ts:51-58)
Structured `log.warn` with the requested company + the list of available companies. Returns `[]` — but the warn surfaces the case clearly. Operator can search traces for `grade_company_not_found`. Correct pattern; the audit will use this as a TEMPLATE for what good logging looks like in remediation work.

---

## 7. What this audit does NOT do

- **Doesn't fix any findings.** Each finding becomes a candidate carry-forward.
- **Doesn't add structured logging to existing call sites.** That's the work of CF-FETCH-SIGNAL-FLOOR-TELEMETRY etc.
- **Doesn't refactor existing `fetch()` calls to use a wrapper.** That's CF-FETCH-TELEMETRY-WRAPPER (optional, deferred).
- **Doesn't change App Insights SDK configuration.** Auto-instrumentation of `fetch()` is an SDK-level concern; remediation here is at the call site level instead.
- **Doesn't deep-audit Azure Functions Python code.** fn-price-floor was depth-checked (clean — explicit status codes, `logging.exception`); other functions in `compiq-functions/` were not. Captured as `CF-AZURE-FUNCTIONS-SILENT-FAIL-AUDIT` if needed later.
- **Doesn't audit MCP server's express middleware error handlers.** That's a parallel concern (Express error middleware); not in this audit's scope.

---

## 8. Severity-prioritized action sequence (for next-session selection)

Recommended order if the user wants to address findings in subsequent sessions:

1. **CF-FETCH-SIGNAL-FLOOR-TELEMETRY** (HIGH, ~30-45 min) — closes the two HIGH-severity findings. Bounded, scoped, high learning value.
2. **CF-EBAY-IDENTITY-LOGGING** (MEDIUM, ~10 min) — trivial structured-logging upgrade.
3. **CF-PREDICTIONLOG-WRITE-DETECT** (MEDIUM, ~15-20 min) — defer until volume warrants.
4. **CF-EBAY-FETCH-AUDIT** (MEDIUM-LOW, deferred) — only if a listing incident occurs.
5. **CF-FETCH-TELEMETRY-WRAPPER** (LOW, large, optional) — only if cluster pattern recurs.
6. **CF-AZURE-FUNCTIONS-SILENT-FAIL-AUDIT** (LOW, deferred) — only if a function-level silent failure surfaces.

---

## Anti-drift note

This audit was bounded by a 60-90 min budget. It samples rather than exhaustively reads every call site. Findings 1.11, 1.21, 1.22, 1.23 are DEFERRED — they need per-line reading. The audit's high-severity findings (1.1, 1.2) are confidently characterized because they sit in `pricing.ts` (read in full).

**Watch for these audit-side failure modes in follow-up work:**
- **Sampling bias** — the audit's sample skews toward prediction-path code because that's where the predecessor framing-inversion lived. Other code paths (ebay, dailyiq, agents) may have higher-severity issues not surfaced here. Honest answer: this audit isn't exhaustive; treat DEFERRED items as "unknown unknowns" until they get the same treatment.
- **Severity drift** — HIGH/MEDIUM/LOW classification can rationalize away findings. Re-check severity assignments after a follow-up incident; the audit's calls may need recalibration once real outages stress-test the classification.

The audit's load-bearing recommendation is CF-FETCH-SIGNAL-FLOOR-TELEMETRY — small, bounded, addresses the highest-leverage findings. If the user picks one follow-up from this audit, that's the one.
