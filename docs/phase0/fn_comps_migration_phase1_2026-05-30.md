# fn-cardhedge-comps Migration — Phase 1 grep + Phase 2 plan

**Date:** 2026-05-30
**CF:** CF-FN-COMPS-MIGRATION
**Phase:** 1 of N (read-only enumeration; Phase 2 implementation gated on Drew approval)
**Authority anchor:** Second sub-CF of CF-CARDHEDGE-DECOMMISSION-FULL Phase 2 per D5 split locked 2026-05-30
**Locked decisions consumed:**
- **D2** — Option A: migrate `fn-cardhedge-comps` to Cardsight pricing with **±10% signal-equivalence gate** on a representative 7-day sample
- **D3** — Archive `compsMomentum.json` blobs to `archive/` prefix at cutover; mark read-only; delete after 30 days if no regression. General `fn-cardhedge-comps` output: 90-day archive then delete
- **D5** — Phase 2 of CF-CARDHEDGE-DECOMMISSION-FULL split into 3 sub-CFs; this is sub-CF #2

**Prior anchors:**
- [5640084](https://github.com/HobbyIQ/HobbyIQ-V1/commit/5640084) — CF-PRICE-BY-ID-MIGRATION (sub-CF #1, shipped 2026-05-30 PM)
- [d011c15](docs/phase0/cardhedge_decommission_phase1_2026-05-30.md) — CF-CARDHEDGE-DECOMMISSION-FULL Phase 1 doc + D1-D7 locks
- [bf836c0](https://github.com/HobbyIQ/HobbyIQ-V1/commit/bf836c0) — R1 `cardsightCardId` on PortfolioHolding (paired identity story; same stale-dist deploy pattern)
- Memory anchor: **compsMomentum stays at 0.20 tier** — harm-diagnosis fixes go to methodology/flag/segment paths, never retire or reweight downward (real transactions > sentiment proxies)

## Framing

Migration target: replace the three Python CardHedge consumers in `compiq-functions/` with Cardsight-backed equivalents while preserving the `compsMomentum.json` blob path + payload shape so the [signal aggregator](compiq-functions/fn-signal-aggregator/function.py) (which weights compsMomentum at 0.20) doesn't need to change.

**Scope discipline:** Phase 1 is READ-ONLY. No code changes. Phase 2 is the next CF kickoff after Drew approves this doc and the surfaced D8/D9/D10 decisions.

**24-hour verification clock** structural to this CF: first Cardsight-sourced nightly run lands at 02:00 UTC the morning after deploy. Phase 3 closes same-day on deploy + test-trigger PASS; full verification closes next morning on the first scheduled nightly blob being clean.

---

# Section 1 — Three consumers' current state

## 1.1 `fn-cardhedge-comps` — per-player compsMomentum signal

**Files:** [compiq-functions/fn-cardhedge-comps/__init__.py](compiq-functions/fn-cardhedge-comps/__init__.py), [function.py](compiq-functions/fn-cardhedge-comps/function.py)

**Schedule:** Timer trigger nightly **02:00 UTC** ([__init__.py](compiq-functions/fn-cardhedge-comps/__init__.py)) via `wrap_signal_writer("compsMomentum", get_cardhedge_signal, ...)`.

**Pipeline per tracked player:**
```
search_cards(f"{player_name} baseball", limit=5)
   → top hit's `id` becomes the canonical card_id
   → get_card_sales(card_id, limit=25)   # most recent 25 sold comps
   → build_comps_payload(player_name, sales)
   → write compiq-signals/{playerSlug}/compsMomentum.json
```

**Output payload shape** (read by signal aggregator):

| Field | Type | Used by aggregator |
|-------|------|---------------------|
| `player` | string | — |
| `multiplier` | float, 0.85-1.20 | **YES** (clamped at L142 of aggregator) |
| `signal` | "rising" / "stable" / "falling" / "no_data" / "no_match" / "no_id" | **YES** (drives flags at L77-83) |
| `comp_count` | int | — |
| `median_price` | float | — |
| `recent_avg` | float | — |
| `prior_avg` | float | — |
| `card_hedge_id` | string | — (informational) |
| `card_hedge_title` | string | — (informational) |
| `raw_sales[]` | array | — |
| `updated_at` | ISO timestamp | — |

**Aggregator contract** (load-bearing per memory):
- Reads via `load_signal(player_name, "compsMomentum")`
- Consumes: `multiplier`, `signal`
- Weight: **0.20** (4th-highest weight, equal to ebay)
- Generates flags: `compsMomentum_rising` / `compsMomentum_falling` / `compsMomentum_no_data`

**Existing test coverage:** None at the function level. Phase 2 adds tests.

## 1.2 `fn-nightly-comp-prefetch` — per-card inventory comp prefetch

**File:** [compiq-functions/fn-nightly-comp-prefetch/function.py](compiq-functions/fn-nightly-comp-prefetch/function.py)

**Schedule:** Timer trigger, frequency not explicit in this file (the function is `run_prefetch`; check `__init__.py` separately). Drew's CF-CARDHEDGE-DECOMMISSION-FULL Phase 1 doc described it as "nightly."

**Pipeline per inventory item** (`prefetch_card`):
```
_resolve_card_hedge_id(card):
   - check cached `cardHedgeId` on inventory doc
   - else: search_cards(f"{year} {set} {player} {cardNumber} {variant}", limit=15)
   - score each hit via _score_hit(...) with weights:
       - exact cardNumber match: +100 (mismatch → reject hit)
       - exact variant match: +30
       - "base" variant when none requested: +25
       - "base" when other requested: +5
       - year present in set name: +5
       - token overlap on set name: +N
   - if multiple top-score leaders: tie-break by get_card_sales volume (capped to top 3)

get_card_sales(ch_id, grade, limit=25)
   → write compiq-signals/{slug}/{cardId}/comps.json
psa_pop_signal(spec_id, ...) → write compiq-signals/{slug}/{cardId}/psa_pop.json
update_floor_from_ebay(...) → updates Cosmos price_floors container
```

**Inventory container:** `inventory` (Cosmos, partition `/playerName`)

**Blob output:** `compiq-signals/{playerSlug}/{cardId}/comps.json` shape:
```json
{
  "card_id": "<player>|<year>|<set>|<cardNumber>|<grade>|<variant>",
  "card_hedge_id": "<ch_id>",
  "player_name": "...",
  "grade": "...",
  "variant": "...",
  "comps": [...],
  "comp_count": <int>,
  "updated_at": "..."
}
```

**Existing test coverage:** None at the function level.

**Critical sub-complexity surfaced:** The `_resolve_card_hedge_id` scoring algorithm at [lines 70-190](compiq-functions/fn-nightly-comp-prefetch/function.py#L70-L190) is **non-trivial CardHedge-specific logic**. It depends on:
- CardHedge search hit field names: `id`, `number`, `variant`, `set`, `year`
- "base" being a literal variant value in CH responses
- Tie-break via additional `get_card_sales` calls (extra fanout)

Cardsight catalog hits use different field names (`releaseName`, `setName`) and handle variants via `parallels[]` array. The scoring algorithm **needs adaptation, not just a function-call swap**. This was underweighted in Drew's Phase 1 doc time estimate.

## 1.3 `shared/cosmos_floor.py` — H6 price floor detection

**File:** [compiq-functions/shared/cosmos_floor.py](compiq-functions/shared/cosmos_floor.py)

**Schedule:** Not its own function; **exports `update_floor_from_ebay` consumed by `fn-nightly-comp-prefetch`** (and `apply_price_floor` consumed broadly).

**Pipeline** (`update_floor_from_ebay`):
```
# Primary: CardHedge
search_cards(f"{player_name} {variant} baseball card", limit=3)
   → top hit's id
   → get_card_sales(ch_id, grade, limit=200)
   → filter to 90-day window
   → trim bottom 5% → min as floor

# Fallback: eBay Buy/Browse API
GET ebay item_summary/search with soldDateRange filter → sold prices

# Persist to Cosmos `price_floors` container
upsert {id: card_id, floor, comp_count_90d, source, updated_at}
```

**eBay fallback path:** Out of CF scope (no migration needed — eBay is preserved).

**CardHedge primary path:** Migration target. Migration to Cardsight follows a simpler pattern than fn-nightly-comp-prefetch (top-hit selection, no scoring).

**Existing test coverage:** None at the function level.

---

# Section 2 — `shared/cardhedge.py` inventory

**File:** [compiq-functions/shared/cardhedge.py](compiq-functions/shared/cardhedge.py)

**Exports:**

| Symbol | Used by | Notes |
|--------|---------|-------|
| `CardHedgeError` | (internal exception) | Raised when CH returns non-OK or invalid payload |
| `search_cards(query, limit=10)` | fn-cardhedge-comps, fn-nightly-comp-prefetch, cosmos_floor | POST `/cards/card-search`; returns `[{id, card_id, player, set, number, variant, prices, ...}]` |
| `get_card_sales(card_id, grade=None, limit=10)` | fn-cardhedge-comps, fn-nightly-comp-prefetch, cosmos_floor | POST `/cards/comps`; required: `grade` (defaults to "Raw"); returns `[{price, date, grade, source, sale_type, title, url}]` |
| `identify_card(query, category="Baseball")` | **NONE of the three consumers** | POST `/cards/card-match`; AI-powered text matching. Confirmed NOT used by the three consumers via grep. May be used elsewhere — not in this CF's scope. |
| `build_comps_payload(player_name, sales)` | fn-cardhedge-comps | **Pure function** — not CH-specific. Reduces sales list → compsMomentum signal payload. Reusable as-is. |

**Auth:** `CARD_HEDGE_API_KEY` env var, `X-API-Key` header
**Timeout:** 20s
**Retry/backoff:** **NONE** — single attempt, returns `[]` on any failure (404, 500, network) so callers fall back gracefully. No 429-specific handling.
**Rate-limit handling:** Implicit — by-design caller-side `[]`-on-failure pattern; no rate-limit exception type.

**Logging:** stdlib `logging.warning` for failures. No structured event log.

**`build_comps_payload`** (lines 171-221): preserves verbatim in the migration. Pure transformation: takes sales list → multiplier + signal + comp_count + median + recent/prior avg. This function is the canonical compsMomentum signal computation. **The migration only replaces the SALES SOURCE, not the signal computation.** Drew's "preserve blob path + payload shape stable" framing locks this.

---

# Section 3 — Field mapping table per consumer

## 3.1 fn-cardhedge-comps mapping

| Current (CardHedge) | Cardsight equivalent | Field mapping notes |
|---------------------|----------------------|----------------------|
| `search_cards("{player} baseball", limit=5)` | `catalog.search(query="{player}", segment="baseball", limit=5)` | Cardsight returns `[{id, name, number, releaseName, setName, year}]`. We take top hit's `id` as the canonical cardId — same pattern. |
| `get_card_sales(card_id, limit=25)` | `pricing.get(card_id)` OR `pricing.bulk([card_id])` | Cardsight returns `{card, raw: {records: [{title, price, date, source, url}]}, graded: [...], meta}`. For player-level "Raw" comps, use `pricing.raw.records[:25]`. Single-card → `pricing.get` is sufficient; `pricing.bulk` is for the batch pre-fetch case (consumed in fn-nightly-comp-prefetch). |
| `build_comps_payload(player, sales)` | **Unchanged** (pure function) | The sales list shape we feed it differs slightly (`{price, date, source, title, url}` per Cardsight vs `{price, date, grade, source, sale_type, title, url}` per CH); `build_comps_payload` only consumes `price`, so this works without modification. |

**Structural concern (load-bearing for D2 ±10% gate):** "Top hit for '{player} baseball' on Cardsight" may not match "top hit for '{player} baseball' on CardHedge." Two different vendors with different search-ranking algorithms can resolve the same player query to different canonical cards (e.g. CH might pick 2011 Topps Update RC for Trout, Cardsight might pick 2009 Bowman Chrome Draft Auto RC). Signal computed off different cards = signal value drift unrelated to actual market movement. This is precisely what the ±10% gate is meant to catch.

## 3.2 fn-nightly-comp-prefetch mapping

| Current | Cardsight equivalent | Adaptation effort |
|---------|----------------------|----------------------|
| `_resolve_card_hedge_id` scoring algorithm at lines 70-190 | Adapted scoring on Cardsight catalog hits | **HIGH** — field-name remapping + variant-via-parallels-array handling + tie-break revision |
| `search_cards(query, limit=15)` | `catalog.search(query, limit=15)` | Field-name remap: `set` → `setName` (or concatenation of `releaseName + setName`); `variant` → `parallels[0].name` (Cardsight surfaces parallels in a sub-array) |
| Hit scoring fields: `number, variant, set, year` | Cardsight hit fields: `number, releaseName, setName, year, parallels[]` | "base" variant detection needs to map to "no parallel" or "Base Set" parallel name |
| Tie-break: `get_card_sales(cid, limit=10)` length | `pricing.get(cid).meta.total_records` OR `pricing.bulk(top_3_ids).meta.*` | Cardsight pricing meta exposes total record count directly — could skip 3 extra calls. Cleaner pattern. |
| `get_card_sales(ch_id, grade, limit=25)` | Per Section 3.1 | Same migration as fn-cardhedge-comps |

## 3.3 cosmos_floor.update_floor_from_ebay mapping

| Current | Cardsight equivalent | Effort |
|---------|----------------------|--------|
| `search_cards(f"{player} {variant} baseball card", limit=3)` | `catalog.search(query, limit=3)` | Simple top-hit selection (no scoring); easier than fn-nightly-comp-prefetch |
| Top hit's `id` | Top hit's `id` | Same pattern |
| `get_card_sales(ch_id, grade, limit=200)` | `pricing.get(ch_id)` then filter to 90-day window from `raw.records` | Direct map; Cardsight `pricing.get` returns full record set in `raw.records`, no `limit` param — caller-side slice if needed |
| Trim bottom 5% → min as floor | Unchanged | Pure computation, vendor-agnostic |

---

# Section 4 — Python Cardsight client scope

**Status check:** `compiq-functions/shared/cardsight.py` does **NOT** currently exist. Confirmed via filesystem listing of [compiq-functions/shared/](compiq-functions/shared/): `__init__.py, card_modifiers.py, cardhedge.py, career_arc.py, cosmos_floor.py, ebay_auth.py, pack_calendar.py, playoff_calendar.py, psa_pop.py, show_calendar.py` — no `cardsight.py`.

**This CF builds it from scratch.**

## 4.1 Required functions

| Function | Used by | Cardsight endpoint |
|----------|---------|--------------------|
| `search_catalog(query, segment="baseball", limit=10)` | All 3 consumers | POST/GET `/catalog/search` (or via published SDK pattern) |
| `get_pricing(card_id, parallel_id=None)` | All 3 consumers | GET `/pricing/{card_id}` — returns `raw + graded + meta` per TypeScript [cardsight.client.ts:358-460](backend/src/services/compiq/cardsight.client.ts#L358-L460) |
| `get_pricing_bulk(card_ids[])` | fn-nightly-comp-prefetch (optional optimization) | POST `/pricing/bulk` (1-100 cards per call per CF-CARDSIGHT-PRICING-BULK backlog framing) |
| `get_card_detail(card_id)` | Possibly fn-nightly-comp-prefetch (for variant/parallel resolution) | GET `/catalog/cards/{card_id}` |

**`identify_card`** (CH analog: POST `/cards/card-match`) — NOT needed by the three consumers per Section 2 confirmation; defer.

## 4.2 Auth + transport spec

- **Env var:** `CARDSIGHT_API_KEY`
- **Header:** `X-API-Key: <key>` (matches TS client pattern at [cardsight.client.ts:146-150](backend/src/services/compiq/cardsight.client.ts#L146-L150))
- **Base URL:** `https://api.cardsight.ai/v1`
- **Timeout:** 20s (matches `shared/cardhedge.py` DEFAULT_TIMEOUT)
- **Retry/backoff:** Add exponential backoff (1s, 2s, 4s) on 429 + 5xx. This is **stricter than `shared/cardhedge.py` which has none** — justified because Cardsight is the sole comp source post-migration; defensive retry matters more.
- **404 handling:** Return `notFound` sentinel pattern matching the TS client (don't raise; return `{notFound: True, raw: {records: []}, graded: [], meta: {total_records: 0, last_sale_date: None}}`).
- **Logging:** Structured JSON (`json.dumps({"event": "...", "source": "shared.cardsight", ...})`) matching the TS client's `log.warn` pattern.

## 4.3 Reference implementation

[backend/src/services/compiq/cardsight.client.ts](backend/src/services/compiq/cardsight.client.ts) is the canonical reference (already shipped, well-tested, used by CF-PRICE-BY-ID-MIGRATION). Phase 2 implementation port the response shapes verbatim:

- `CardsightCatalogResult` Python dataclass
- `CardsightPricingResponse` Python dataclass with `raw`, `graded`, `meta`, `notFound`
- `CardsightSaleRecord` per sale

The `cs:pricing` cache (Redis-backed in TS) is intentionally **NOT ported** to Python — Functions run on isolated schedules with no shared Redis client; the blob output IS the cache.

## 4.4 Tests

Mock-the-`requests` pattern (matches TS vitest mock pattern). Cases:
- Happy path: 200 with valid pricing shape → parsed correctly
- 404 → notFound sentinel
- 429 → retry with backoff, eventually succeed
- 429 exhaustion → raise CardsightApiError
- 500 → retry
- Timeout → graceful failure
- Auth missing → CardsightApiError with clear message

---

# Section 5 — Empirical verification design (D2 ±10% gate)

## 5.1 Methodology

**Goal:** Confirm Cardsight-sourced compsMomentum signal values are within ±10% of CardHedge-sourced values across a representative tracked-player sample over a 7-day window.

**Comparison metric:**

For each sampled player `p`:
```
sig_ch    = build_comps_payload(p, get_card_sales_ch(ch_top_hit_for(p)))
sig_cs    = build_comps_payload(p, get_pricing_cs(cs_top_hit_for(p)).raw.records[:25])

deviation(p) = |sig_cs.multiplier - sig_ch.multiplier| / sig_ch.multiplier
```

**Pass criterion:** `median(deviation(p) for p in sample) <= 0.10`

**Choice of median vs mean:** Median is more robust to outliers caused by per-player canonical-card divergence (Section 3.1 structural concern). If 2 of 25 players resolve to completely different cards on the two vendors, mean would inflate; median tolerates.

**Sub-metrics also reported (not gating):**
- 90th percentile deviation
- Count of players with deviation > 10%
- Count of players where one vendor returned `signal: "no_data"` and the other returned valid data (vendor coverage gap)

## 5.2 Sample selection

**Sample size:** 25 tracked players.

**Sampling strategy:**
- Stratified: 5 superstars (Trout, Judge, Acuna, Skenes, Ohtani) + 10 mid-tier active MLB + 10 random from the tracked corpus
- Excludes: pure-prospect players (likely missing from Cardsight) — verification can't certify what isn't covered

**Player list source:** Whatever `run_for_all_players` in [compiq-functions/shared/__init__.py](compiq-functions/shared/__init__.py) iterates over. Phase 2 confirms and excerpts the list into a fixture.

## 5.3 Implementation

**File:** `compiq-functions/scripts/verify_compsmomentum_parity.py` (NEW, one-off; NOT part of the production pipeline)

**Behavior:**
1. Load tracked player sample (25 players)
2. For each player:
   - Run CH path: `search_cards + get_card_sales + build_comps_payload`
   - Run Cardsight path: `search_catalog + get_pricing + build_comps_payload` (using `pricing.raw.records[:25]`)
   - Log both signal payloads + deviation
3. Compute median + 90p + outlier counts
4. Print summary table + PASS/FAIL verdict
5. Write full results to `verify_compsmomentum_parity_results.json` for forensics
6. Exit 0 on PASS; exit 1 on FAIL

**Runs on:** Local dev box with both `CARD_HEDGE_API_KEY` and `CARDSIGHT_API_KEY` configured. Does NOT touch production blobs.

**Run window:** Production cutover happens only after this script reports PASS.

## 5.4 Fallback if gate fails

If median deviation > 10%, HALT and surface findings. Drew options:
- **(a)** Investigate top divergent players, identify cause (canonical card mismatch, Cardsight catalog gap, etc.) — adjust Cardsight query strategy and re-test
- **(b)** Re-test with looser threshold (e.g. ±15%) — Drew decides if business-acceptable
- **(c)** D2 fallback to Option B (retire function entirely) — requires post-Phase-4a backend cache layer
- **(d)** D2 fallback to Option C (defer this CF) — pushes calendar

**Do NOT proceed to production cutover without Drew's explicit re-approval.**

---

# Section 6 — Blob retention sequencing (D3)

## 6.1 compsMomentum.json specifically

Per D3 lock for compsMomentum:

**At Phase 2 cutover:**
1. Enumerate `compiq-signals/*/compsMomentum.json` blobs (via `az storage blob list --prefix compiq-signals/ --pattern "*/compsMomentum.json"`)
2. Copy each blob from canonical path to `compiq-signals/archive/compsMomentum/{playerSlug}/compsMomentum.json`
3. Apply container-level immutability policy (or blob-level access tier "Cool" with read-only access policy) to `archive/` prefix
4. Configure Azure Storage lifecycle rule: `archive/compsMomentum/*.json` → delete after 30 days

**At +30 days (if no regression):**
- Lifecycle policy fires automatically; nothing to do
- If regression surfaces within 30 days: lifecycle policy can be modified to extend, OR archive blobs can be manually restored to canonical path as fallback

## 6.2 General fn-cardhedge-comps output

Per Section 1.1 inventory: `fn-cardhedge-comps` **only writes `compsMomentum.json`**. There is no other output. The 90-day archive rule from D3 general has no other targets in this CF's scope.

If future enumeration finds additional CH-written blobs (e.g. via `fn-nightly-comp-prefetch` writing `compiq-signals/{slug}/{cardId}/comps.json`), those follow the general 90-day archive rule.

## 6.3 fn-nightly-comp-prefetch + cosmos_floor blob retention

**fn-nightly-comp-prefetch** writes `compiq-signals/{slug}/{cardId}/comps.json` per inventory card. Post-Cardsight migration these blobs will be Cardsight-sourced. Decision: **D3 general rule applies** (90-day archive then delete for the OLD CH-sourced versions). Drew confirms in D8 (Section 9).

**cosmos_floor** writes to Cosmos `price_floors` container (not blob). Pre-CF values are CH/eBay-sourced; post-CF values are Cardsight/eBay-sourced. Cosmos doesn't have a "blob archive" pattern; entries continue to be upserted with new `source` tag (`"cardsight"` vs `"ebay"`). Historical entries persist with `"source": "card_hedge"` tag — historical record. Lifecycle: none; entries stay until manually purged.

## 6.4 Azure Storage capability confirmation

Azure Storage **does support** the operations D3 requires:
- Container-level **lifecycle management policies** (rule-based delete by age, blob name prefix, last-modified time)
- Container-level **immutability** policies (time-based retention) — sets read-only with optional legal hold
- Per-blob **access tier** (Hot/Cool/Archive)

Phase 2 confirms specific policy syntax via az CLI; not blocking.

---

# Section 7 — Schedule disable timing + sequencing plan

## 7.1 Internal sequencing for this CF

```
1. [BUILD] Python Cardsight client (shared/cardsight.py)
   - Auth + retry + 4 functions (search_catalog, get_pricing, get_pricing_bulk,
     get_card_detail) + tests
   - tsc-equivalent: pytest green

2. [BUILD] Verification script (scripts/verify_compsmomentum_parity.py)
   - 25-player sample, dual-path runner, ±10% gate

3. [MIGRATE-1] fn-cardhedge-comps.get_cardhedge_signal
   - Replace search_cards + get_card_sales with cardsight client calls
   - Keep blob path + payload shape stable
   - Function tests (mock both clients, verify payload output)

4. [GATE] Run verification script — PASS/FAIL gate per D2
   - If PASS → proceed to step 5
   - If FAIL → HALT, escalate per Section 5.4

5. [MIGRATE-2] fn-nightly-comp-prefetch._resolve_card_hedge_id
   - Rewrite scoring for Cardsight catalog hit shape
   - Field-name remap, parallels[] handling for variant, tie-break
     via pricing.meta.total_records
   - Function tests (mock cardsight client + verify resolution
     correctness on fixture inventory cards)

6. [MIGRATE-3] shared/cosmos_floor.update_floor_from_ebay CH-side
   - Top-hit selection via search_catalog, pricing.get for 90-day window
   - Function tests

7. [SCHEDULE] Disable old fn-cardhedge-comps timer (Azure portal)
   - Same physical function deploys; the migrated code is what fires
     on the next schedule. Actually the schedule itself doesn't change —
     just the underlying code. NO explicit disable needed if Phase 2
     deploys the migrated code atomically; the next 02:00 UTC run
     uses the new code.

8. [DEPLOY] Functions deployment via Azure Functions Core Tools or
   the existing CI/CD pipeline (check what's in place)
   - Confirm CARDSIGHT_API_KEY env var set in Function App settings
   - Deploy bundle including shared/cardsight.py + migrated functions

9. [SAME-DAY VERIFY] (Phase 3c)
   - Azure portal: function status healthy
   - Manual test-trigger fn-cardhedge-comps with small player sample
   - Verify blob output landed at canonical path with Cardsight-sourced
     data shape (multiplier, signal, comp_count, etc. all populated;
     card_hedge_id field can be absent or null — that's the canonical
     payload-shape-stable trade-off)

10. [ARCHIVE BLOBS]
    - One-time script: copy compiq-signals/*/compsMomentum.json →
      compiq-signals/archive/compsMomentum/{slug}/compsMomentum.json
    - Apply read-only policy on archive/ prefix
    - Configure lifecycle rule: 30-day TTL on archive/compsMomentum/

11. [NEXT-DAY VERIFY] (Phase 3d, +24h)
    - Drew morning check: 02:00 UTC scheduled run completed
    - compsMomentum.json blob shows Cardsight-sourced data
    - Signal aggregator read blob cleanly (no schema mismatch)
    - Zero new Function App exceptions in 24h window
    - Zero Cardsight rate-limit issues at production load (~N players × 1
      catalog search + 1 pricing.get per player)
    - If clean: brief follow-up commit OR SESSION_HANDOFF note closing
      the CF
    - If issues: HALT, debug, possibly roll back schedule code +
      restore archived blobs

12. [CLEANUP] Delete shared/cardhedge.py
    - After all 3 consumers verified stable for ≥48h
    - Final commit closes CF; CF-CARDHEDGE-NAMING-CLEANUP can then
      delete TypeScript cardhedge.client.ts and remove CARD_HEDGE_API_KEY
```

## 7.2 Schedule disable nuance

Drew's kickoff said "Disable schedule BEFORE deleting any consumed code" per Section 2B sequencing constraint. **Phase 1 finding:** because the migration REPLACES the underlying code while preserving the schedule trigger and blob path, there is **no explicit schedule disable needed**. The next 02:00 UTC run after deploy executes the NEW code automatically.

The Section 2B constraint applies to a different pattern (delete the function then forget to disable the schedule), which isn't this CF's pattern. Documenting for clarity.

## 7.3 Honest sequencing concerns

- **fn-nightly-comp-prefetch scoring rewrite is the highest-risk step.** It depends on Cardsight catalog quality matching CH's curation. If Cardsight has materially different parallels coverage or different canonical-card resolution, the rewrite may need iteration.
- **The ±10% gate is on fn-cardhedge-comps' player-level aggregate signal.** It does NOT cover fn-nightly-comp-prefetch's per-card resolution accuracy. See D8 (Section 9).
- **shared/cardhedge.py deletion is the LAST step**, after all consumers stable. Premature deletion risks rollback impossibility.

---

# Section 8 — Phase 2 implementation time estimate

| Step | Estimate | Notes |
|------|----------|-------|
| 1. Python Cardsight client | 2-3h | New file: auth + retry + 4 functions + ~10 unit tests |
| 2. Verification script | 1.5-2h | 25-player sample selector + dual-path runner + stats + JSON output |
| 3. fn-cardhedge-comps migration | 1-2h | Drop-in client swap; preserve build_comps_payload + blob shape |
| 4. Empirical gate execution + analysis | 1h elapsed | Run script, eyeball outliers, judge PASS/FAIL |
| 5. fn-nightly-comp-prefetch migration | **3-5h** | Scoring algorithm rewrite for Cardsight catalog hits + parallels handling — **highest single estimate** |
| 6. cosmos_floor migration | 1-2h | Top-hit + 90-day filter port |
| 7. Tests across all 3 consumers + the new client | 2-3h | Mock pattern + per-function fixtures |
| 8. Schedule + deploy | 1h | Azure portal + verify status |
| 9. Same-day verify (Phase 3c) | 1h | Test-trigger + portal check |
| 10. Blob archive + lifecycle config | 1h | One-time script + az CLI policy commands |
| 11. Next-day verify (Phase 3d) | 24h elapsed (0.5h active) | Drew morning check |
| 12. shared/cardhedge.py deletion | 0.5h | Final commit |
| **Total active engineering** | **~14-20h** | + 24h elapsed for next-day verify |

**Significant revision from Drew's original Phase 1 estimate (5-7h for these consumers).** The 2× growth comes from:
- Python Cardsight client built from scratch (vs assumed "enhance existing")
- fn-nightly-comp-prefetch scoring rewrite (underweighted in original estimate)
- Verification script + gate execution (separately counted)

---

# Section 9 — Drew decisions surfaced beyond the locked seven

## D8 — Verification gate scope for fn-nightly-comp-prefetch + cosmos_floor

D2 lock specified ±10% gate for **`fn-cardhedge-comps`** (the player-level compsMomentum signal). It did NOT explicitly address verification for the other two consumers, which have different output characteristics (per-card comps blobs and per-card floor prices, not aggregated player signals).

| Option | Description | Cost |
|--------|-------------|------|
| **(a) Same ±10% gate per consumer (3 gates total)** | Build comparable verification scripts for fn-nightly-comp-prefetch (sample 25 inventory cards, compare resolved card identity + comp counts) and cosmos_floor (sample 25 cards, compare floor values within 90-day window) | +2-3h Phase 2 work, highest rigor |
| **(b) Looser gate for the per-card consumers (e.g. ±20%)** | The per-card signal is finer-grained and naturally noisier than per-player aggregate; ±10% may be too tight | Same effort as (a) but easier to PASS |
| **(c) No explicit gate; deploy and observe** | Trust the fn-cardhedge-comps gate as proxy; observe Cosmos `price_floors` for anomalies in the 24h window | Lowest effort, lower rigor; trusts the player-level gate proxies the per-card behavior |

**Phase 1 recommendation:** Option (a) with **separate threshold per consumer** — ±10% for fn-cardhedge-comps (Drew locked), ±15% for fn-nightly-comp-prefetch (per-card noise), ±10% for cosmos_floor (price floors are revenue-load-bearing). Drew's call.

## D9 — fn-nightly-comp-prefetch scoring algorithm rewrite

The `_resolve_card_hedge_id` scoring at [lines 70-190](compiq-functions/fn-nightly-comp-prefetch/function.py#L70-L190) needs adaptation for Cardsight catalog hit shape. Two architectural choices:

| Option | Description | Trade-off |
|--------|-------------|-----------|
| **(a) Port the EXACT algorithm verbatim** | Map field names, keep weights/thresholds identical (cardNumber +100, variant +30, etc.). Parity-focused. | Smallest change, predictable behavior; doesn't leverage Cardsight's richer catalog data |
| **(b) Redesign for Cardsight characteristics** | Use Cardsight's `parallels[]` array for proper variant matching, `relevance` score directly when available, `pricing.meta.total_records` for tie-break | Larger change, potentially better resolution accuracy, but adds engineering risk |
| **(c) Simpler heuristic** | Cardsight search quality is generally higher than CH; could use a simpler "top relevance hit" pattern + cardNumber filter, skipping the elaborate scoring | Lowest engineering effort; risks regressions on edge cases the scoring algorithm was tuned for |

**Phase 1 recommendation:** Option (a) verbatim port for Phase 2 ship. Option (b)/(c) refinements as future follow-up CFs after empirical observation of resolution accuracy in production. Lock D9 → (a).

## D10 — Phase 2 sub-split

Given the 14-20h estimate, consider further splitting:

| Option | Sub-split | Calendar effort |
|--------|-----------|-----------------|
| **(a) Single CF (as kickoff framed)** | Phase 2A client + verification → 2B fn-cardhedge-comps gate → 2C other two consumers → 2D cleanup | ~3 working days, one ship |
| **(b) Two sub-CFs** | Sub-CF #2a: client + fn-cardhedge-comps migration + gate (Phase 3 closes on tomorrow's nightly). Sub-CF #2b: fn-nightly-comp-prefetch + cosmos_floor + cleanup. | ~2 + ~1.5 working days; lower per-CF risk |
| **(c) Three sub-CFs** | One per consumer (each ships independently with own gate) | ~1.5 + ~2 + ~1 working days; smallest per-CF risk, most calendar |

**Phase 1 recommendation:** Option (b). The Cardsight client + fn-cardhedge-comps + gate are tightly coupled (the gate VALIDATES the client + migration). Splitting them is artificial. The other two consumers are independent migrations that can ship after the gate clears.

But Drew's call — if the ±10% gate is high-confidence (e.g. local empirical pre-check before this CF kicks off indicates parity), option (a) ships in one CF cleanly. If the gate is more speculative, option (b) lets you HALT cleanly after the gate without holding up the rest of the work.

---

# Section 10 — Honest accounting

## 10.1 — Python Cardsight client doesn't exist (Drew's W5-Windows note partially refuted)

Drew's CF-CARDHEDGE-DECOMMISSION-FULL Phase 1 doc Section 2B said:
> Requires writing a Python Cardsight client (mirror of `compiq-functions/shared/cardsight.py` if it exists, or new)

**Phase 1 finding:** `compiq-functions/shared/cardsight.py` does NOT exist. The "if it exists" hedge resolves to "or new." This adds 2-3h to Phase 2 vs the optimistic interpretation. Net effect captured in Section 8.

## 10.2 — fn-nightly-comp-prefetch is more complex than "function call swap"

Drew's CF-CARDHEDGE-DECOMMISSION-FULL Phase 1 doc Section 1.1.7 enumerated `fn-nightly-comp-prefetch` as a CH consumer requiring migration. Phase 1 finding: the `_resolve_card_hedge_id` scoring algorithm is non-trivial Cardsight-shape-dependent code, NOT a drop-in function call swap. 3-5h on this consumer alone (Section 8 step 5).

## 10.3 — No existing test coverage on any of the three consumers

Phase 1 confirmed: zero unit/integration tests for `fn-cardhedge-comps`, `fn-nightly-comp-prefetch`, `cosmos_floor.update_floor_from_ebay`. Phase 2 adds tests as part of the migration (Section 8 step 7). Estimated 2-3h.

## 10.4 — Schedule disable concern doesn't apply

Drew's kickoff Section 7 reminded "Disable fn-cardhedge-comps schedule BEFORE deleting any consumed code." Phase 1 finding: the migration replaces the underlying code while preserving schedule + blob path; no explicit schedule disable needed. Net simplification (Section 7.2).

## 10.5 — Cardsight catalog canonical-card-divergence risk for D2 gate

The structural risk from Section 3.1 (CH and Cardsight may resolve the same "{player} baseball" query to different canonical cards) is real and is what the ±10% gate is meant to catch. If the gate fails because of canonical-card divergence (not actual market drift), the fallback options in Section 5.4 surface for Drew. Not pre-decided here.

---

# Phase 1 → Phase 2 transition

This document is the complete Phase 1 deliverable. Phase 2 (a SEPARATE next CF) implements per Section 7's sequencing plan, gated on:

1. **Drew approval** of D8 / D9 / D10 surfaced in Section 9
2. **Empirical verification PASS** at the ±10% gate (Section 5)
3. **24-hour clock acknowledgment** — Phase 3 closes same-day on deploy + test-trigger; full verification closes on next morning's nightly check

**Hard rule reminder:** Phase 1 is READ-ONLY. Zero code changes, zero env-var changes, zero schedule actions, zero blob touches. This document is the only artifact.

**Standing by for Drew review before Phase 4 commit.**
