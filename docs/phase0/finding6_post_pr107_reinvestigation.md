# Phase 0 — Finding 6 re-investigation against newer `fn-nightly-comp-prefetch` on main

**Captured:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope:** Read-only investigation against the post-PR-107 version of `compiq-functions/fn-nightly-comp-prefetch/function.py` now on `main`.
**Time budget:** 35 min.

**Headline:** **End-state (a) — both Workstream B failures persist.** PR #107's scoring rewrite is orthogonal to both Failure A (Cosmos auth) and Failure B (empty inventory). Failure A persists at the source-code level (line 38 still reads `COSMOS_KEY` with no AAD fallback). Failure B is **worse than Workstream B framed it**: `compiq.inventory` is not just transiently empty — **no writer exists in the current backend code**. The portfolio data the function appears designed around goes to a different container (`portfolio`, per-user-doc shape) under a different schema. Phase 4a's prerequisites are therefore: (1) `COSMOS_KEY` fix or AAD migration, (2) some new data-population pipeline targeting `compiq.inventory`, OR an architectural redesign that consumes `portfolio` directly.

## 1. Source-code summary of newer version

The newer `fn-nightly-comp-prefetch/function.py` on `main` (304 lines; same byte-content as the version `compiq-functions/fn-nightly-comp-prefetch/function.py` was restored to in commit `46390e7` / PR #107) differs from the deployed version that Workstream B (`docs/phase0/finding6_nightly_prefetch_writepath.md`, commit `e328177`) characterized **only** in the `_resolve_card_hedge_id` algorithm. Everything else is byte-identical.

### What the 4 new helpers do (lines 57–108)

- `_norm_card_number(value)` — strip leading `#`, uppercase, no spaces. For card-number comparison normalization.
- `_norm_variant(value)` — trim + lowercase. For variant string comparison.
- `_hit_id(hit)` — extract `id` or `card_id` from a Card Hedge search hit dict.
- `_score_hit(hit, want_number, want_variant, want_year, want_set)` — scoring function: returns 0 (reject) if a card_number was specified but doesn't match; otherwise accumulates score (+100 number-match, +30 variant exact, +5 variant=base fallback, +5 year-in-set-name, plus token-overlap on set name).

### What the rewritten `_resolve_card_hedge_id` does (lines 111–190)

- Pulls **15 hits** from `search_cards` (wider net vs. the deployed version, which I don't have here but Workstream B's read implied a smaller net).
- Scores every hit with `_score_hit`.
- Filters out 0-scored hits.
- **Critical refusal logic:** if no hits scored > 0 AND a card_number was specified, the function logs a warning and returns `None` (refusal). The comment explains the case: "Bowman Chrome cards in particular collide on Auto — BAA-LD case-hit auto and CPA-LD 1st prospect auto both surface, and the first hit is often the low-volume one."
- Tie-breaking: if multiple hits tie at the top score, breaks the tie by calling `get_card_sales(cid, limit=10)` on up to 3 tied candidates and picking the highest sale-volume.
- Otherwise: returns the top-scored hit's id.

### What did NOT change vs. the deployed version

- **Cosmos auth pattern (line 36–54):** identical to deployed. Reads `COSMOS_ENDPOINT` + `COSMOS_KEY` from env. Instantiates `CosmosClient(endpoint, key)` directly. **No AAD fallback.** Broad `except Exception` catches and returns None.
- **Inventory data source (line 33, 48–51):** identical. Reads from the Cosmos container named by `os.environ.get("COSMOS_INVENTORY_CONTAINER", "inventory")` in the database named by `os.environ.get("COSMOS_DB", "compiq")`. With the default env values (no `COSMOS_INVENTORY_CONTAINER` set on `fn-compiq` per W6.3 / W2), this is `compiq.inventory`.
- **Empty-inventory handling (line 273–303 `run_prefetch()`):** identical. If `_inventory_container()` returns `None`, logs `"Inventory container unavailable — nothing to prefetch"` and returns `{"processed": 0, "errors": 0}`. If container exists but is empty, `container.read_all_items()` returns an empty iterator and the for-loop body never executes; same return.
- **Output write paths (line 224, 243):** identical. `compiq-signals/{player_slug}/{card.id_or_built_id}/comps.json` and `psa_pop.json`.

### Functional summary of the difference

**The rewrite is purely about CARD IDENTITY RESOLUTION QUALITY.** It improves which CH card_id is selected when a card has multiple search-result candidates. It does NOT touch the auth pattern, the data source, or empty-inventory behavior. The improvement is orthogonal to both Workstream B failure modes.

## 2. COSMOS_KEY cross-check (Step 2)

**Result: Failure A persists in main's version. The rewrite did not address it.**

- Line 38: `key = os.environ.get("COSMOS_KEY")` — identical env var read.
- Line 44: `client = CosmosClient(endpoint, key)` — identical direct-key auth.
- No AAD fallback added.

Workstream 2 (commit `000b777`) independently confirmed this: fn-compiq's `COSMOS_KEY` app-setting hashes to a value that doesn't match any of the four current Cosmos master/RO keys. Direct test in W2 returned 401 on a real query attempt with the function's key value. **The defect surfaces at the first wire call** (`db = client.create_database_if_not_exists(...)` line 45–47); the broad `except Exception` catches it; `_inventory_container()` returns `None`; `run_prefetch()` exits early.

No code change required to confirm — this is the Workstream B Failure A finding unchanged.

## 3. Empty inventory characterization (Step 3)

**Result: Failure B persists, and is worse than Workstream B's framing.**

Workstream B characterized this as "container exists but is empty." That observation is correct but understated. The deeper finding from this re-investigation:

### No writer to `compiq.inventory` exists in the current backend code

`grep -rn "container.*inventory|'inventory'|\"inventory\"" backend/src` (excluding test files, eBay's Sell-API "inventory item" concept, and portfolio store) returns **zero hits**. There is no backend code path that writes per-card documents matching `{"id", "playerName", "year", "set", "cardNumber", "grade", "variant", "cardHedgeId"}` to a Cosmos container named `inventory` in the `compiq` database.

### What actually exists: the `portfolio` container

`backend/src/services/portfolioiq/portfolioStore.service.ts` writes user-portfolio data to a Cosmos container named **`portfolio`** (line 49: `id: "portfolio"`, partition key `/userId`), with three-tier AAD-fallback auth (line 41–46). The shape stored is **per-user document with embedded `holdings: Record<string, PortfolioHolding>` dict** (line 79). This is a fundamentally different schema from what `fn-nightly-comp-prefetch` expects to iterate.

The function's docstring (lines 15–18) describes the expected shape:

```
{"id", "playerName", "year", "set", "cardNumber", "grade", "variant",
 "cardHedgeId" (optional)}
```

That's a **flat per-card document**. The `portfolio` container stores **per-user-with-nested-holdings**. No transform layer adapts one to the other.

### Implication

`compiq.inventory` is an **architectural island**: the container exists in Cosmos, the function was written against an assumed data shape it would contain, but no production data-flow has ever populated it. This was likely an architectural intent that was either superseded by the `portfolio` design or never fully wired. Either way, **fixing Failure B requires more than re-populating a container — it requires deciding which data source the prefetch should consume, and either building the bridge to `portfolio` or building a new pipeline to populate `compiq.inventory`.**

### Empty-handling in the newer version

Identical to the deployed version: silent exit with `{"processed": 0, "errors": 0}`. No fallback to a different data source. No retry. The newer version does not handle empty-inventory differently.

## 4. Phase 4a prerequisite end-state classification

**End-state: (a) — Both Workstream B failures persist in main's version.**

Reasoning:

| Failure | Status in main's version | Why |
|---|---|---|
| **Failure A — Cosmos auth (stale `COSMOS_KEY`)** | **PERSISTS** | Line 38 reads the same env var. No AAD fallback added. The scoring rewrite (`_score_hit`, `_resolve_card_hedge_id`) is in a separate code path that doesn't execute until after the inventory iteration starts, which depends on `_inventory_container()` succeeding, which depends on the auth working. |
| **Failure B — Empty inventory** | **PERSISTS AND DEEPER** | The Cosmos `compiq.inventory` container has no writer in `backend/src`. The function was designed against an assumed data shape never populated by the current architecture. Even with auth fixed, the function would iterate zero documents. |

**Phase 4a prerequisites therefore include:**

1. **Cosmos auth fix** — rotate fn-compiq's `COSMOS_KEY` to a current Cosmos master/RO key (minutes), OR migrate to AAD-only auth pattern (hours; matches the Node-backend pattern). Phase 4a planning should decide which is the long-term direction; tactical fix is the key rotation.

2. **Inventory data-flow decision** — choose one of: (a) build a bridge from `backend/src/services/portfolioiq/portfolioStore.service.ts`'s `portfolio` container into `compiq.inventory`-shaped per-card docs, (b) rewrite `fn-nightly-comp-prefetch` to consume `portfolio`-shaped per-user docs directly with a nested iteration, OR (c) populate `compiq.inventory` from some other source (sample card set, watchlist data, etc.). This is an architectural decision, not a "small fix."

3. **Verify deploy** — confirm the post-PR-107 newer code is actually deployed before relying on the scoring improvements. Per W6.3 + W1 / Workstream C: the deployed version on `fn-compiq` matches byte-for-byte the snapshot branch's version restored by PR #107 (modulo CRLF). So no separate deploy is needed for the scoring rewrite to be in production. But the function is currently producing zero output due to A+B persisting; deploying again wouldn't change that.

**End-state (b) — "Failure A fixed by rewrite, Failure B persists" — is REFUTED.** The rewrite did not touch auth.

**End-state (c) — "Both addressed in main's version" — is REFUTED.** Neither was addressed.

## 5. Updated implications for Phase 3 cleanup

`fn-nightly-comp-prefetch` is **effectively dead code in current production.** It fires nightly per the timer, fails silently on Cosmos auth, and writes zero output. Phase 3 cleanup has three reasonable framings:

- **Status quo:** keep the function deployed but unrun. Zero production impact. Phase 4a inherits the prerequisite work.
- **Disable the function** (`isDisabled=True` in metadata, or remove from deploy): zero production impact since it's already producing zero output. Cleaner; reduces noise in the function-app inventory. But removes the "this function is on our radar" surface — future Phase 4a planners would need to re-discover it.
- **Address the prerequisites now as part of Phase 3:** rotate the key, decide on the inventory data source, get the function actually running. This expands Phase 3's scope beyond its original "CH cleanup" framing — probably premature; better to wait for Phase 4a's design decisions.

Recommended framing **(not a recommendation to execute):** keep status quo through Phase 3, treat both prerequisites as Phase 4a kickoff items.

## Anti-drift note

This document characterizes failure-mode persistence and Phase 4a prerequisite end-state. It does not propose key rotation, AAD migration, inventory pipeline design, or `fn-nightly-comp-prefetch` disable. Each is its own focused decision for Phase 3 or Phase 4a kickoff.
