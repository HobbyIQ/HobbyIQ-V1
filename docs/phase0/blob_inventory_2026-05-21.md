# Phase 0 / W6.3 — Blob Inventory of fn-* Signal Functions

**Captured:** 2026-05-21 (PM)
**Scope:** Read-only inventory. No writes, no fixes, no disables.
**Function App:** `fn-compiq` (rg `rg-hobbyiq-dev`, sub `ce160cf3-ee69-4832-ade2-f0cf57ba2f57`)
**Blob storage (authoritative):** `stcompiqfnotgm2` (NOT `stcompiqfnotgm` — see Storage account reconciliation below)
**Container:** `compiq-signals`
**App Insights for fn-compiq:** `fn-compiq` component (appId `671c5274-7236-4f4f-abda-5a2ce5e7f357`, ApplicationId `671c5274...`)

## Brief reconciliation

Inventory brief listed 15 functions but described count as 14. **Actual deployed count is 14** functions in `fn-compiq`. Discrepancies:

- **`fn-player-score-refresh`**: in brief, NOT deployed. Status unknown (renamed? deleted? never existed?). Out of scope for W6.3.
- **`fn-price-alert-checker`**: in brief, NOT deployed. Same status.
- **`fn-nightly-comp-prefetch`**: deployed and active (timer `0 30 2 * * *`), NOT in W6.3 brief but referenced in `copilot-instructions.md`. Added to W6.3 scope.

Follow-up: investigate whether the two missing functions ever existed (git history on `compiq-functions/` tree). Defer; not blocking Phase 0.

## Storage account reconciliation

Brief said the function-app storage account is `stcompiqfnotgm` (per W1 storage key rotation finding). **Actual storage account used by `fn-compiq` is `stcompiqfnotgm2`** — verified by inspecting `AzureWebJobsStorage` and `AZURE_BLOB_CONNECTION_STRING` app settings on `fn-compiq`. Both point at `stcompiqfnotgm2`.

The original `stcompiqfnotgm` account still exists in `rg-hobbyiq-dev` but has **zero containers** — it appears to be a stale/legacy/orphan account, not in use. The key1 rotation captured in session memory either pre-dated a migration or was performed on the wrong account.

Follow-up: confirm whether `stcompiqfnotgm` is safe to delete (separate from Phase 0).

## Per-function inventory (14 deployed)

Methodology note: App Insights telemetry from `fn-compiq` is largely **unwired** (only `fn-ebay-signals` and `fn-reddit-signals` emit visible request/trace rows in last 30d; 99 trace rows total across the entire function app). **Blob mtime is the authoritative invocation evidence** for blob-writing functions. For HTTP-trigger functions and timer functions without visible blob output, invocation cannot be reliably confirmed from existing telemetry.

| # | Function | Trigger | Schedule (UTC) | Last invocation evidence | Output blob path | Blob last-modified (UTC) | Schema sanity |
|---:|---|---|---|---|---|---|---|
|  1 | `fn-cardhedge-comps`         | timer | `0 0 2 * * *`     | 2026-05-21 02:00:05Z–02:00:23Z (blob writes for 5 players) | `compiq-signals/{player}/cardhedge.json` | 2026-05-21 02:00:13Z (aaron-judge) | OK — `player, multiplier, signal, comp_count, median_price, recent_avg, prior_avg, card_hedge_id, card_hedge_title, raw_sales, updated_at`. comp_count=27 across all 5 players. |
|  2 | `fn-ebay-signals`            | timer | `0 0 */4 * * *`   | 2026-05-21T20:00:00Z (AI request + blob) | `compiq-signals/{player}/ebay.json` | 2026-05-21 20:00:01Z (aaron-judge) | OK — `player, multiplier, signal, updated_at` |
|  3 | `fn-reddit-signals`          | timer | `0 0 */2 * * *`   | 2026-05-21T20:00:00Z (AI request + blob) | `compiq-signals/{player}/reddit.json` | 2026-05-21 20:00:00Z (mike-trout) | OK — `player, multiplier, signal, updated_at` |
|  4 | `fn-trends-signals`          | timer | `0 0 */6 * * *`   | 2026-05-21T18:00:00Z (blob writes) | `compiq-signals/{player}/trends.json` | 2026-05-21 18:00:00Z (mike-trout) | OK — `player, multiplier, trend, updated_at` |
|  5 | `fn-odds-signals`            | timer | `0 30 */4 * * *`  | 2026-05-21T16:30:00Z (blob writes) | `compiq-signals/{player}/odds.json` | 2026-05-21 16:30:00Z (all 5) | OK — `player, multiplier, signal, updated_at` |
|  6 | `fn-stats-signals`           | timer | `0 15 */2 * * *`  | 2026-05-21T18:15:00Z (blob writes) | `compiq-signals/{player}/stats.json` | 2026-05-21 18:15:00Z (all 5) | OK — `player, player_id, stat_group, momentum_ratio, multiplier, direction, milestone, updated_at` |
|  7 | `fn-news-signals`            | timer | `0 45 */3 * * *`  | 2026-05-21T18:45:01Z–18:45:06Z (blob writes) | `compiq-signals/{player}/news.json` | 2026-05-21 18:45:03Z (aaron-judge) | OK — `player, headline_count, avg_sentiment_score, multiplier, sentiment, keyword_flags, top_headline, updated_at` |
|  8 | `fn-youtube-signals`         | timer | `0 15 */6 * * *`  | 2026-05-21T18:15:00Z (blob writes) | `compiq-signals/{player}/youtube.json` | 2026-05-21 18:15:00Z (all 5) | OK — `player, multiplier, signal, updated_at` |
|  9 | `fn-signal-aggregator`       | timer | `0 50 */2 * * *`  | 2026-05-21T18:50:00Z (blob writes) | `compiq-signals/{player}/aggregated.json` | 2026-05-21 18:50:00Z (mike-trout) | OK — 24 keys incl. `player, final_multiplier, predicted_direction, signal_flags, components, bin_signal, bin_drop_pct, sell_through_rate, str_signal, show_phase/name/multiplier, release_phase/name/multiplier, playoff_signal/window/multiplier, career_arc_signal/multiplier, updated_at` |
| 10 | `fn-serve-signals`           | HTTP  | —                 | Unknown (HTTP trigger; no blob output expected; no AI telemetry visible) | (none — read-only HTTP serve from container) | — | n/a |
| 11 | `fn-price-floor`             | HTTP  | —                 | Unknown (HTTP trigger; writes to Cosmos `price_floors` per `copilot-instructions.md`, not blob; no AI telemetry visible) | (none — Cosmos sink) | — | n/a (not blob) |
| 12 | `fn-backtest-runner`         | timer | `0 30 3 * * *`    | **Not visible** in `compiq-signals`; output destination unknown from this scope | (none found in `compiq-signals`) | — | n/a — see findings |
| 13 | `fn-search-intent`           | HTTP  | —                 | Unknown (HTTP trigger; no AI telemetry; possible candidate for `image.json` writer based on schema overlap) | (possibly `compiq-signals/{player}/image.json` — only `mike-trout/image.json` exists, 2026-05-10) | 2026-05-10 15:43:22Z (single blob, stale 11d) | OK if responsible — `query, player, card_id, confidence, image_urls, title, updated_at` |
| 14 | `fn-nightly-comp-prefetch`   | timer | `0 30 2 * * *`    | **Not visible** in `compiq-signals` root; per copilot-instructions writes per-card `compiq-signals/{player}/{card_id}/comps.json` — no such subfolder visible in container listing | (none observed) | — | n/a — see findings |

## Findings

### A. fn-cardhedge-comps health (special note per brief)

- **fn-cardhedge-comps successfully ran nightly 2026-05-21 02:00Z**, writing all 5 active player blobs with 27 comps each. Per-player multipliers: aaron-judge 1.076 stable, juan-soto 0.973 stable, mike-trout 1.163 rising, ronald-acuna-jr 1.2 rising, shohei-ohtani 0.866 falling.
- **Notably this run occurred 2 days after the documented 2026-05-19 CH subscription cancellation.** Either (a) CH access has a multi-day grace period, (b) the API key was revoked but the function fell through to cached/synthetic data, or (c) the cancellation hasn't propagated yet. The 27-comps-across-all-players uniformity is suspicious — could indicate hardcoded fallback rather than live API response.
- **No error pattern recoverable from existing telemetry.** App Insights for fn-compiq is not capturing fn-cardhedge-comps trace/exception rows (only fn-ebay-signals and fn-reddit-signals show telemetry). To get the actual error/success pattern for fn-cardhedge-comps, Phase 3 cleanup will need to either (a) wire fn-compiq App Insights properly first, or (b) inspect Kudu function-execution log files directly.
- One stale player blob exists: `caleb-bonemer/cardhedge.json` last-modified 2026-05-10 15:04Z. Other signal types for that player are absent. Indicates caleb-bonemer was dropped from the active-player list ~11 days ago. Not an error, just inventory drift.

### B. Functions with no visible output

- **`fn-backtest-runner`** (timer `0 30 3 * * *`): no blob output found in `compiq-signals`. May write to a different container, a different storage account, Cosmos, or be no-op. Out of scope to investigate further tonight; flag for Phase 3 or Phase 4c follow-up.
- **`fn-nightly-comp-prefetch`** (timer `0 30 2 * * *`): per `copilot-instructions.md` writes per-card cache to `compiq-signals/{player}/{card_id}/comps.json`. **No per-card subfolders exist** in the container — only flat per-player `{signal}.json` files. Possibilities: function silently failing, function disabled at runtime (despite `isDisabled=False` in metadata), function writing elsewhere, or function never actually shipped its blob-writer code. Worth tracing in Phase 3 or before Phase 4a cache work.
- **`fn-search-intent`** (HTTP): only candidate writer for the `image.json` schema (`query, player, card_id, confidence, image_urls, title`). Only one such blob exists (`mike-trout/image.json`, stale 2026-05-10). If `fn-search-intent` writes these, output volume is extremely low — only one card resolved successfully in 11 days. If a different function writes them, that function is unknown to this scope.

### C. fn-compiq App Insights instrumentation is largely broken

- 99 trace rows + 2 request rows in 30 days across the entire function app.
- Only `fn-ebay-signals` and `fn-reddit-signals` emit visible request/trace telemetry.
- Blob mtime is the only reliable invocation signal for the other 7 timer-trigger functions. For the 3 HTTP-trigger functions and 2 timer functions with no blob output, invocation cannot be verified from existing telemetry at all.
- Parallels the broader Phase 0 observability-gap finding on HobbyIQ3 (Q3 baseline doc). The function-app side has the same problem and warrants the same fix scope — out of scope tonight.

### D. Inventory drift / unaccounted-for blobs

- `mike-trout/image.json` (stale 2026-05-10) — origin function unconfirmed. Likely `fn-search-intent` based on schema; could not verify in scope.

### E. Stale legacy storage account

- `stcompiqfnotgm` exists in `rg-hobbyiq-dev` but has zero containers and is not referenced by `fn-compiq` settings. Likely safe to delete. The key1 rotation captured in session memory was performed on this account; the actual function-app storage is `stcompiqfnotgm2`. Future sessions should verify which account is in use before assuming.

## Summary

| Health bucket | Count | Functions |
|---|---:|---|
| Running, output verified, schema clean | 9 | fn-cardhedge-comps, fn-ebay-signals, fn-reddit-signals, fn-trends-signals, fn-odds-signals, fn-stats-signals, fn-news-signals, fn-youtube-signals, fn-signal-aggregator |
| Running (HTTP/Cosmos sink), no blob verification possible | 2 | fn-serve-signals, fn-price-floor |
| Output destination unknown / no blob found | 3 | fn-backtest-runner, fn-search-intent (likely image.json, 11d stale), fn-nightly-comp-prefetch (per-card subfolders absent) |
