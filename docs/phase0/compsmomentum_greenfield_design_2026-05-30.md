# CF-COMPSMOMENTUM-GREENFIELD-CARDSIGHT — design

**Date:** 2026-05-30
**Replaces:** Former Sub-2a context paused at [`1fa9124`](https://github.com/HobbyIQ/HobbyIQ-V1/commit/1fa9124) (canonical-card-divergence finding rendered the cross-vendor gate methodology moot once CardHedge was hard-cutover-decommissioned at [`10ad39d`](https://github.com/HobbyIQ/HobbyIQ-V1/commit/10ad39d))
**Strategic context:** Per CF-CARDHEDGE-HARD-CUTOVER aftermath + today's Path A confirmation — CardHedge is gone; "everything is Cardsight" strategic question is closed; this CF restores the 0.20-weight `compsMomentum` signal via a greenfield Cardsight Function

---

## 1. Strategic context

The signal aggregator at [`compiq-functions/fn-signal-aggregator/function.py`](../../compiq-functions/fn-signal-aggregator/function.py) reads `compsMomentum` as a 0.20-weight component. Pre-cutover, that signal was produced by `fn-cardhedge-comps` writing `compiq-signals/{slug}/compsMomentum.json` blobs. That Function was deleted at 10ad39d; aggregator now reads stale blobs (or falls back to `{multiplier: 1.0, signal: "unavailable"}`).

The 1fa9124 strategic pause was about cross-vendor canonical-card-divergence gates failing. **That pause is moot** — Path A confirmed CardHedge gone, no cross-vendor comparison possible or needed. The greenfield Function is essentially the 1fa9124 α′-final implementation with vendor-neutral naming + the inheritance plumbing fixed.

Per [[compsmomentum-weight-lock]] memory: weight stays 0.20; harm-diagnosis fixes go to methodology/flag/segment paths, not weight retirement.

---

## 2. Inherited artifacts inventory

### Already on `main` (HEAD `6c1288d`)

- **[`compiq-functions/shared/cardsight.py`](../../compiq-functions/shared/cardsight.py)** — Python Cardsight client. Functions used by this CF:
  - `search_catalog(query, year=None, take=20)` → `list[dict]` of catalog results
  - `get_pricing(card_id, parallel_id=None)` → pricing dict with `raw.records[]` + `graded[]` + 404 sentinel
  - `get_pricing_bulk(card_ids)` → **REFUTED EMPIRICALLY (404)** per CF-CARDSIGHT-PRICING-BULK; dead code; NOT used
  - `get_card_detail(card_id)` → for parallel/variant resolution (NOT used by this CF)

- **[`compiq-functions/shared/__init__.py`](../../compiq-functions/shared/__init__.py)** — helpers used:
  - `tracked_players()` → list of player names (env-driven `COMPIQ_TRACKED_PLAYERS`, fallback to 5 defaults)
  - `save_signal(player_name, signal_type, data)` → writes `compiq-signals/{slug}/compsMomentum.json`
  - `run_for_all_players(signal_type, fetch_fn, extra_log=None)` → iterates tracked players + per-player try/except wrapper + structured log emission

- **[`compiq-functions/fn-signal-aggregator/function.py:18-26`](../../compiq-functions/fn-signal-aggregator/function.py#L18-L26)** — aggregator reads `compsMomentum` via `WEIGHTS["compsMomentum"]: 0.20`; uses `.get("multiplier", 1.0)` + `.get("signal")` for the rising/falling/no_data flag handling at lines 78-84. Signal values handled: `rising`, `falling`, `stable`, `no_data`, `no_match`, `no_id`, `unavailable`.

### In `10ad39d` commit body (preserved verbatim)

- **`build_comps_payload(player_name, sales)`** — ~50 LOC pure helper that maps a `list[dict]` of sales to the `{player, multiplier, signal, comp_count, median_price, recent_avg, prior_avg}` payload shape. recent_7 vs prior_7 velocity heuristic, capped 0.85-1.20 multiplier, rising/falling/stable signal threshold at 1.08/0.93.

### In 1fa9124 (paused; needs porting)

- **`fn-cardhedge-comps/function.json`** — timer trigger `"0 0 2 * * *"` (02:00 UTC nightly)
- **`fn-cardhedge-comps/__init__.py`** — standard entry point: `run_for_all_players("compsMomentum", get_comps_signal, extra_log="nightly 02:00 UTC")`
- **`fn-cardhedge-comps/function.py`** — α′-final implementation: `get_comps_signal(player_name)` + `_best_by_pricing_volume(candidates)` + `_records_count(pricing)`
- **`tests/test_fn_cardhedge_comps.py`** — 7 function-level tests (best-of-top-5 selection, year-fallback path, no_match/no_data taxonomy, selection_path metadata)

---

## 3. Function design

### 3.1 Name

**Proposal: `fn-comps-momentum`** (vendor-neutral; matches the existing `compsMomentum` signal-name convention from CF-CARDHEDGE-SIGNAL-RENAME at 80e9971). Drew's call.

Alternatives:
- `fn-compsmomentum` (camelCase concatenation; less canonical Python project style)
- `fn-comps` (terser but loses the "momentum" descriptor that distinguishes from any future per-card comp prefetch Function)
- `fn-cardsight-comps` (vendor-named — Drew explicitly said NOT this per D-disposition (a))

### 3.2 Schedule

`"0 0 2 * * *"` (02:00 UTC nightly) — preserves the timing expectation the aggregator was built around when the prior `fn-cardhedge-comps` ran at the same cadence. Aggregator runs at 02:15 UTC (per cron implied by the deployed schedule chain); 15-min buffer is sufficient for the per-player loop.

### 3.3 Scaffold

```
compiq-functions/fn-comps-momentum/
├── __init__.py    # Entry point: run_for_all_players("compsMomentum", get_comps_signal, ...)
├── function.json  # Timer trigger 02:00 UTC nightly
└── function.py    # get_comps_signal + _best_by_pricing_volume + _records_count + inlined build_comps_payload
```

### 3.4 Tracked-player source

Use existing `shared.tracked_players()`. Defaults to 5 (Trout/Ohtani/Judge/Acuña/Soto); env-driven `COMPIQ_TRACKED_PLAYERS` for production scale (currently set to 25 in App Settings per prior probe context).

---

## 4. Query strategy (α′-final, preserved verbatim from 1fa9124)

```
1. Primary search: catalog.search("{player} baseball", take=5)
2. For each candidate cardId: pricing.get(cardId) → records count
3. Pick best-of-top-5 by pricing volume (raw.count descending)
4. Year-fallback: if all top-5 from primary have zero records,
   secondary search "{player} {current_year}" → repeat best-of-top-5
5. Reduce winning candidate's raw.records → compsMomentum signal
   via build_comps_payload(player_name, sales[:25])
6. Persist via save_signal(player_name, "compsMomentum", payload)
```

**Cost per player**: 1 catalog.search + up to 5 pricing.get + optional 1 catalog.search + up to 5 pricing.get for year-fallback. Worst case: 12 calls; typical: 6 calls. At 25 players nightly = 150-300 Cardsight calls per night. Well within rate limits.

---

## 5. `build_comps_payload` placement (D-build_comps_payload option (i) — inline)

Per 10ad39d D-disposition lock option (i): inline the ~50 LOC helper into the Function's `function.py` rather than reviving `shared/cardhedge.py` or creating a new `shared/comps_payload.py`. Co-located with `get_comps_signal` where it's used. Single source of truth; no cross-Function helper file required since no other Function will consume `build_comps_payload`.

---

## 6. Verification gate design (Cardsight on own terms — D8 lesson)

The 1fa9124 cross-vendor deviation gate failed because CardHedge and Cardsight resolve different canonical cards. Path A means CardHedge is gone; cross-vendor comparison is impossible AND unnecessary. Gates redesigned to validate Cardsight signal quality on its own merits.

**Sample**: tracked-player list (25 in production), each player run through `get_comps_signal` against the new Function's logic. Compute gates on the resulting 25 payloads.

### Gate 1 — Coverage (meaningful signals)

Count of players whose payload has `signal NOT IN {"no_match", "no_data", "no_id"}`.

**Pass threshold: ≥ 18 / 25 (72%)** — accepts ~4 known Cardsight catalog gaps (Skenes / Painter / Rutschman / Wood pattern from prior probes) plus 3-player buffer for new edge cases. Stricter threshold (e.g. 90%) would force scope discovery before deploy. Looser (e.g. 60%) would deploy a structurally-degraded signal.

### Gate 2 — Canonical brand or sufficient volume

For each meaningful-signal payload, the winning candidate's `releaseName` should be either:
- A canonical brand (case-insensitive substring match: `topps`, `bowman`, `panini`, `upper deck`, `donruss`, `fleer`, `leaf`)
- OR a niche brand with `comp_count >= 10` (volume justifies trust despite non-canonical naming)

**Pass threshold: ≥ 80% of meaningful signals pass canonical-or-volume check.** Catches the 1fa9124-observed pattern of niche-product cards (Leaf Press Pass, Panini Stars & Stripes) surfacing ahead of canonical cards with relevance ranking but having zero pricing records — best-of-top-5 already mitigates this; gate is belt-and-suspenders.

### Gate 3 — Directional consistency (sanity check)

For each meaningful-signal payload with `comp_count >= 5`, check that `recent_avg` vs `prior_avg` ratio is structurally consistent with the `signal` value:
- `signal == "rising"` → ratio > 1.08
- `signal == "falling"` → ratio < 0.93
- `signal == "stable"` → 0.93 ≤ ratio ≤ 1.08

**Pass threshold: 100% (zero violations).** This is a self-consistency check on `build_comps_payload` output, not a Cardsight-quality measure; should be 100% by construction unless there's a logic bug.

### Gate execution

Run gates via a one-off script (`compiq-functions/scripts/verify_compsmomentum_gates.py`, NEW) that invokes `get_comps_signal` for each tracked player + computes the three metrics. Output: pass/fail + per-player breakdown.

**Phase 2.5 invokes this script before deploy.** If any gate fails, HALT + diagnose. Gate script is gitignored if Drew prefers (uses live Cardsight calls + AUTH_SESSION_SECRET; small artifact) OR committed for future re-verification.

---

## 7. Test coverage plan

Port 1fa9124's `test_fn_cardhedge_comps.py` to a new file `compiq-functions/tests/test_fn_comps_momentum.py` with these adaptations:

1. `sys.path.insert` for `fn-comps-momentum` (NOT `fn-cardhedge-comps`)
2. `from function import get_comps_signal` — already module-import; only path changes
3. `from shared.cardhedge import build_comps_payload` references in tests → updated to test the inlined version (tests may not import it directly; they exercise via `get_comps_signal`)
4. Cross-vendor comparison tests (if any) — DROP. No CardHedge baseline to compare to.

Expected: ~7-9 tests (the 7 ported + maybe 1-2 additional edge cases for the inlined `build_comps_payload`).

If test fallout exceeds ~15, HALT and evaluate per Drew's hard rule.

---

## 8. Phase 3 plan (split-day 24-hour clock)

### Phase 3a — Same-day verification

1. Deploy via `func azure functionapp publish fn-compiq --python`
2. Verify new `fn-comps-momentum` Function appears in deployed function list
3. Verify other 14 Functions still present (no regression — fn-backtest-runner / fn-ebay-signals / etc.)
4. Manual test-trigger via Azure portal with 3-5 player sample
5. Verify:
   - Function execution succeeds (no crash, no Cardsight rate-limit hits)
   - `compsMomentum.json` blob lands at `compiq-signals/{slug}/compsMomentum.json` with expected shape
   - Signal aggregator reads the new blob without schema mismatch
6. App Insights telemetry watch (~15-20 min):
   - Function execution success rate
   - Cardsight upstream calls (visible NOW for the backend via CF-APPINSIGHTS-FETCH-INSTRUMENTATION at 6c1288d; Function App Python is separate concern — NOT in scope)
   - No new exception patterns

### Phase 3b — Next-day verification (Drew checks tomorrow morning)

- Verify 02:00 UTC schedule fired successfully
- All 25 tracked-player `compsMomentum.json` blobs are fresh (`updated_at` near 02:00 UTC)
- Signal aggregator's next run at 02:15 UTC reads fresh blobs and produces aggregated signals correctly
- No Function App exceptions in 24-hour window
- No Cardsight rate-limit at production scheduled load

If clean: short follow-up update to SESSION_HANDOFF.md (one-line "next-day verification PASS"). CF closes.

If issues: HALT, debug, possibly disable Function schedule until fix.

---

## 9. Open questions for Drew (HALT)

1. **Function name** — confirm `fn-comps-momentum` (suggested) or pick a different name?
2. **Gate thresholds** — Gate 1: ≥18/25 (72%); Gate 2: ≥80% canonical-or-volume; Gate 3: 100% directional. Confirm or adjust?
3. **Verification gate script** — gitignored scratch (consistent with `.tmp-probe-*` pattern) OR committed at `compiq-functions/scripts/verify_compsmomentum_gates.py` for future re-verification?
4. **Test count target** — porting 7 from 1fa9124 + ~1-2 inlined-helper edge cases ≈ 8-9 tests. Confirm OR adjust target?
5. **Production scale** — `COMPIQ_TRACKED_PLAYERS` env var on `fn-compiq` currently has 25 players. Gates evaluated against these 25; production deploys this same Function. Confirm OR sample a different subset for verification?

---

## 10. NOT in scope (explicit honesty)

- `cosmos_floor.py` revival (separate future CF — CF-COSMOS-FLOOR-GREENFIELD-CARDSIGHT)
- `fn-nightly-comp-prefetch` revival (separate future CF)
- Function App `fn-compiq` Python instrumentation (separate concern; appinsights for Python is different SDK from the Node v3 we shipped today at 6c1288d)
- Custom signal-weighting changes (compsMomentum stays at 0.20 weight per [[compsmomentum-weight-lock]] memory)
- Schema changes to `compsMomentum.json` blob shape (preserve aggregator compatibility verbatim)
- Manual canonical-card mapping table (Path C explicitly rejected today)
- Backend / iOS code changes (this CF is Function-App-side only)

---

## 11. References

- 1fa9124 — Sub-2a strategic pause + α′-final implementation source (paused, never deployed)
- 10ad39d — CF-CARDHEDGE-HARD-CUTOVER commit body preserved `build_comps_payload` source
- 5640084 — CF-PRICE-BY-ID-MIGRATION (first sub-CF of original CF-CARDHEDGE-DECOMMISSION-FULL; preserves shared/cardsight.py)
- 80e9971 — CF-CARDHEDGE-SIGNAL-RENAME (compsMomentum signal-name design)
- 3a3ee0b — R2 cardsightGradeId precedent (additive design pattern; not directly used here)
- 6c1288d — CF-APPINSIGHTS-FETCH-INSTRUMENTATION (backend telemetry recovery; orthogonal but related)
- [[compsmomentum-weight-lock]] memory — 0.20 weight permanent; harm-diagnosis goes to methodology/flag/segment paths
