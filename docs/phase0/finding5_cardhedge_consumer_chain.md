# Phase 0 / Finding 5 — `fn-cardhedge-comps` consumer chain + 27-comp uniformity diagnostic

**Captured:** 2026-05-21 PM (Workstream A follow-up to W6 close-out Finding 5)
**Scope:** Read-only investigation. No code changes, no env changes, no function disables.
**Time budget:** 60 min.

**Headline:** None of the three pre-investigation hypotheses (Cosmos cache replay / hardcoded fixture / CH cached reads) holds in its original form. The function is making live HTTP calls to `api.cardhedger.com` and the API is returning **real, recent eBay-sourced comps** despite the documented 2026-05-19 subscription cancellation. The "27-comp uniformity" is the Card Hedge API's default `/cards/comps` page size — every player's `card_hedge_id` lookup returns exactly 27 raw_prices regardless of the function's `count: 25` request body. **Phase 3 cleanup must not assume disabling the function is safe** — the MCP server's pricing layer consumes this blob as its primary comp source.

## 1. Source-code analysis

Source lives on `origin/wip/snapshot-2026-05-20` and `origin/restore/preprod-deployed-state` (per W6.3 / Finding 10 source-on-branch anomaly). Tree SHA `059e4bb...` is byte-identical between the two branches for `compiq-functions/fn-cardhedge-comps`.

| File | Lines | Behavior |
|---|---:|---|
| `compiq-functions/fn-cardhedge-comps/function.json` | 9 | Timer trigger, cron `0 0 2 * * *` (nightly 02:00 UTC). |
| `compiq-functions/fn-cardhedge-comps/__init__.py` | ~10 | Entry point. Calls `shared.run_for_all_players("cardhedge", get_cardhedge_signal, extra_log="nightly 02:00 UTC")`. |
| `compiq-functions/fn-cardhedge-comps/function.py` | ~50 | Per-player worker. For each player: `search_cards("{name} baseball", limit=5)` → take `hits[0].id` as `card_id` → `get_card_sales(card_id, limit=25)` → `build_comps_payload(name, sales)` → enrich with `card_hedge_id / card_hedge_title / raw_sales / updated_at`. |
| `compiq-functions/shared/cardhedge.py` | ~180 | HTTP client. **No Cosmos imports.** **No hardcoded fixtures.** All HTTP failures (network exception OR non-OK status) log a `logging.warning` and return `[]`. `_headers()` raises `CardHedgeError` only if `CARD_HEDGE_API_KEY` env is missing entirely (would crash the per-player iteration). |
| `compiq-functions/shared/__init__.py` | ~135 | `run_for_all_players` iterates `tracked_players()` (default 5 from `_DEFAULT_PLAYERS`), calls `fetch_fn(name)`, `save_signal(name, signal_type, payload)`. Per-player `except Exception` logs `logging.exception` and continues — single-player failure does not block others. Blob writes go to `compiq-signals/{slug}/{signal_type}.json` via `AZURE_BLOB_CONNECTION_STRING`. |

**Hypothesis 1 (Cosmos cache replay): REFUTED by source.** Zero `cosmos`, `azure.cosmos`, or local-cache reads anywhere in `fn-cardhedge-comps` or `shared.cardhedge`. Every fetch goes through `requests.post` to `api.cardhedger.com`.

**Hypothesis 2 (hardcoded fixture on auth failure): REFUTED by source.** The three error returns from `shared.cardhedge`:
- `search_cards` failure → `[]` (caller then writes `{signal: "no_match", comp_count: 0}`)
- `get_card_sales` failure → `[]` (caller then writes `{signal: "no_data", comp_count: 0}`)
- `_headers()` no-key → raises `CardHedgeError` (caller catches in `run_for_all_players`, logs `[cardhedge] {name} failed: ...`, no blob written)

**None of these paths produces `comp_count: 27`.** A genuine fallback can be ruled out as the source of the observed uniformity.

## 2. Telemetry verification

W6.3 already established `fn-cardhedge-comps` does not emit function-level invocation traces to App Insights component `hobbyiq-insights` (component appId `671c5274-7236-4f4f-abda-5a2ce5e7f357`). Re-confirmed: `union traces, requests, exceptions, dependencies | where cloud_RoleName == 'fn-compiq' | where operation_Name contains 'fn-cardhedge-comps' | where timestamp > ago(48h)` → **0 rows**.

A broader query (`traces | where message has 'cardhedge' | where timestamp > ago(48h)`) returns **6 host-level traces**, all infrastructure:

| Time (UTC) | Severity | Type |
|---|---:|---|
| 2026-05-21T21:44:03Z | Information | Function discovery (lists all 14 deployed functions) |
| 2026-05-21T21:44:03Z | Information | Schedule announcement (next 5 firings 05/22–05/26 02:00Z) |
| 2026-05-21T22:01:01Z | Information | `Stopping the listener … for function 'fn-cardhedge-comps'` |
| 2026-05-21T22:01:01Z | Information | `Stopped the listener` |
| 2026-05-21T22:13:32Z | Information | Function discovery (post-restart) |
| 2026-05-21T22:13:32Z | Information | Schedule announcement (post-restart) |

No application-level traces, no exceptions, no outbound-HTTP dependency rows for `api.cardhedger.com` over the last 48 hours. **Function-app App Insights auto-instrumentation for outbound `requests` / Python `urllib3` is not wired** (parallel to the broader observability bifurcation documented in `docs/SESSION_HANDOFF.md` W6 close-out capture #7).

**Blob mtime remains the only reliable execution-success signal.** Per W6.3 and re-confirmed here: aaron-judge `cardhedge.json` `lastModified = 2026-05-21T02:00:13Z` (13 s after timer fire); all five players have similar 02:00:XXZ timestamps. The function ran cleanly on this calendar day.

## 3. Blob output sample

Connection string fetched via `az functionapp config appsettings list -n fn-compiq -g rg-hobbyiq-dev --query "[?name=='AZURE_BLOB_CONNECTION_STRING'].value | [0]"` → points at `stcompiqfnotgm2`. Container `compiq-signals`.

**Top-level scalars per player** (extracted from each `{slug}/cardhedge.json` 2026-05-21 02:00Z blob):

| Player | `comp_count` | `multiplier` | `signal` | `median_price` | `card_hedge_id` |
|---|---:|---:|---|---:|---|
| aaron-judge | **27** | 1.076 | stable | 32.00 | `1651756640402x592778918938804200` |
| mike-trout | **27** | 1.163 | rising | 310.00 | `1586812246197x228181943611293700` |
| shohei-ohtani | **27** | 0.866 | falling | 9.09 | `1778813542973x793975669323871100` |
| juan-soto | **27** | 0.973 | stable | 32.00 | `1620875879392x435744287040995300` |
| ronald-acuna-jr | **27** | 1.200 | rising | 15.53 | `1594767166119x610977966873116700` |

All five players: `comp_count = 27` uniformly. Card-Hedge IDs are distinct, well-formed (Bubble.io-style `{epoch-ms}x{16-digit}` records), and stable across runs.

**`raw_sales` characterization** (27 entries per player):

| Player | All sales `source` | Date span (earliest → latest) | Velocity reading |
|---|---|---|---|
| aaron-judge | 100% `ebay` | 2026-05-12 → 2026-05-20 | 27 sales in ~8 days — high volume |
| mike-trout | 100% `ebay` | 2026-04-27 → 2026-05-19 | 27 sales in ~22 days — mid |
| shohei-ohtani | 100% `ebay` | 2026-05-20 → 2026-05-21 | 27 sales in ~2 days — highest volume |
| juan-soto | 100% `ebay` | 2026-03-10 → 2026-05-21 | 27 sales in ~72 days — lowest velocity |
| ronald-acuna-jr | 100% `ebay` | 2026-04-09 → 2026-05-20 | 27 sales in ~41 days — low-mid |

**Sanitized excerpt** (aaron-judge `raw_sales[0]`):

```json
{
  "price": 29.99,
  "date": "2026-05-20T17:20:00.000Z",
  "grade": "Raw",
  "source": "ebay",
  "sale_type": "Best Offer",
  "title": "2017 Bowman - Aaron Judge #32 (RC) - Raw",
  "url": "https://www.ebay.com/itm/147302974345?nordt=true&rt=nc"
}
```

**Sale types seen:** `Best Offer` and `Auction` (eBay-native sale-type taxonomy). URLs are real `ebay.com/itm/{id}` listing URLs.

**Date-span variation refutes synthetic/cached uniformity.** If the 27 entries were stubbed or replayed from a stale cache, all players would show identical date spans. They do not. Each player gets a comp page sized to whatever `/cards/comps` returns for that `card_id`. The uniformity is **at the count axis only** — the underlying data is per-card real.

**Why 27 not 25.** The function asks for `{"card_id": id, "count": 25, "grade": "Raw", "include_raw_prices": true}`. The API returns 27 entries in `raw_prices` regardless. Most consistent explanation: CH's `/cards/comps` honors `count` only as a soft cap or uses a default page size of 27. Unverifiable from this side without CH OpenAPI docs.

## 4. Downstream consumers

`grep -rn "cardhedge.json\|compiq-signals" backend/src mcp-server`:

| Path | Read or write? | What it does |
|---|---|---|
| `mcp-server/compsLoader.ts:fetchPlayerComps()` | **Read** | Pulls `compiq-signals/{slug}/cardhedge.json`, filters `raw_sales` to entries with finite price > 0, maps into `CardComp[]`, sorts newest-first. Returns `[]` on missing blob. Result is consumed by `mcp-server/pricing.ts` for prediction generation. **This is the primary live-prediction consumer.** |
| `mcp-server/cardhedge.ts:writePlayerComps()` | **Write** | Direct write to the SAME blob path. Used by `primePlayerComps()` below. |
| `mcp-server/cardhedge.ts:primePlayerComps()` | Write | MCP-side on-demand prime path: calls `identifyCard()` + `getCardSales()` against Card Hedge live, then `writePlayerComps()` to refresh the blob. **Second writer on the same blob path** — could race or overwrite the nightly fn output. |
| `backend/src/services/compiq/cardhedge.client.ts` | — | Backend Node mirror of `shared/cardhedge.py`. Calls `api.cardhedger.com` directly. **Does NOT read the blob.** Used by `compiq.routes.ts` for the search-by-text path and by `cardsight.router.ts` Site A. |

**Consumer-chain summary.** Two writers (fn-cardhedge-comps nightly + mcp-server `primePlayerComps` on-demand) and one reader (mcp-server `fetchPlayerComps`) share the `compiq-signals/{slug}/cardhedge.json` blob path. The backend's `cardhedge.client.ts` is a separate live-CH path that bypasses the blob entirely.

**Data does NOT currently flow into `comp_logs` or `compiq_corpus` directly from this blob.** The MCP server's `pricing.ts` consumes the projected `CardComp[]`; downstream of that, the backend's `compiqService.ts` writes prediction outcomes to `comp_logs` and (when sample rate > 0, which it currently is not) `compiq_corpus`. So the cardhedge.json blob influences predictions, and predictions influence comp_logs, but the blob itself is not directly logged.

## 5. Root-cause hypothesis with evidence weights

Restating the three pre-investigation hypotheses:

| # | Hypothesis | Verdict |
|---:|---|---|
| 1 | Cosmos cache replay — function reads from a local Cosmos cache instead of CH live | **REFUTED** — source has zero Cosmos reads (Section 1) |
| 2 | Hardcoded fixture — function returns synthetic data on auth failure | **REFUTED** — no fallback produces `comp_count: 27`; all error paths return 0 or no_data (Section 1) |
| 3 | CH cached reads — CH API serves cached responses despite subscription cancellation | **PARTIALLY HOLDS, reframed** — see below |

**Active hypothesis (refined):** The Card Hedge API is still returning **live data** to the function's API key despite the documented 2026-05-19 subscription cancellation. Evidence:
- All 27 entries per player are 100% `source: "ebay"`, with real eBay listing URLs and dates clustered within the last 2–72 days (Section 3). Stale cache would show identical date spans across players; it does not.
- Each player has a distinct `card_hedge_id` returned from `search_cards` — `search_cards` is itself an API call. If the key were dead, `search_cards` would return `[]` and the function would write `{signal: "no_match", comp_count: 0}`. It does not.
- `updated_at: "2026-05-21T02:00:13.526441"` is wall-clock of the function's last run, not a server-cached field — confirms the function reached `build_comps_payload` and wrote the blob.
- Blob `lastModified` matches the nightly timer (02:00:13Z, 13 s after fire) on the day under investigation.

**Most likely explanation for the 27 uniformity:** `/cards/comps` has a default page-size of 27 that overrides small `count` values, OR the endpoint returns up to 27 raw_prices regardless of the requested count. This is **API-side behavior, not function-side**.

**Most likely explanation for continued access despite cancellation:** Card Hedge either grants a grace period on cancelled subscriptions, OR the cancellation is billing-side only with API access still active, OR the API key was issued under a separate scope from the cancelled subscription. None of these are verifiable from the consumer side.

**Confidence:** High that hypotheses 1 and 2 are wrong. Moderate-high that the active hypothesis is correct as stated. The unverifiable piece is the *why* of CH's continued access — that requires either contacting CH or waiting to observe when (if) access goes dark.

## 6. Phase 3 cleanup implications

The original W6.3 note ("Phase 3 cleanup must investigate consumer chain before disabling") is **correct and now actionable**. Specific implications:

- **Do not disable `fn-cardhedge-comps` without simultaneously addressing the MCP consumer chain.** `mcp-server/compsLoader.ts:fetchPlayerComps()` is the primary live-prediction reader. With the blob stale/unwritten, `fetchPlayerComps` returns `[]`, and `mcp-server/pricing.ts` will run with whatever comp set the downstream layer falls back to. The fallback path is not characterized in this doc (it lives in `pricing.ts` and is out of scope here).

- **MCP-side `primePlayerComps()` is a redundant writer.** If CH access remains live, the MCP-side on-demand prime can refresh the same blob mid-day. If the function is disabled but MCP-side prime is still wired, the blob would still be refreshed on prediction-time misses (slower path but functional). This needs to be a deliberate consideration in Phase 3, not an accidental survivor.

- **The cancellation has not yet impacted the data path.** Comp quality and freshness today is unchanged from pre-cancellation. There is no urgent operational reason to disable the function now; the urgency is governance/cost-control (don't keep paying CH if cancelled — but per Finding 5, the cancellation is in flight, so no incremental cost).

- **Add a monitor for the day CH access goes dark.** When (if) CH revokes, blobs will start carrying `{comp_count: 0, signal: "no_data" | "no_match"}` instead of 27-comp payloads. A simple alert on `comp_count < 5` across the 5 tracked players would catch the moment of transition. The current observability gap (Section 2) means this cutover would NOT be visible from App Insights — only from blob inspection or downstream pricing-quality degradation.

- **Phase 3's net change is smaller than originally framed.** Originally framed as "disable the function" (implying lost data, harm). Actual state: the function is producing real data via live API access that has outlasted the subscription. Phase 3's choices are: (a) keep the function running until CH access dies naturally, then accept the degradation; (b) pre-emptively migrate the MCP consumer to an alternative comp source (e.g., direct eBay sold-listings); (c) disable the function and accept any quality loss in predictions. Pick under-Phase-3 with consumer-chain context now visible.

## Anti-drift note

This document characterizes what exists and what the data shows. It does not propose which Phase 3 path (a/b/c above) to take — that is a downstream decision. No remediation is implied or recommended in this doc beyond the monitoring hook (which is itself a Phase 3 question, not an action here).
