# Phase 0 / Finding 6 — `fn-nightly-comp-prefetch` write-path verification

**Captured:** 2026-05-21 PM (Workstream B follow-up to W6 close-out Finding 6)
**Scope:** Read-only investigation. No code changes, no env changes, no function disables.
**Time budget:** 30 min.

**Headline:** Two independent failures explain the missing per-card subfolders, either of which is sufficient to produce the observed zero-write state on its own. **Failure A (auth):** `fn-compiq`'s `COSMOS_KEY` app-setting does not match any of the four current Cosmos `hobbyiq-comps` master/read-only keys — the function's `_inventory_container()` 401s at Cosmos client init, catches the exception, returns `None`, and `run_prefetch()` exits early with `{"processed": 0, "errors": 0}`. **Failure B (empty source):** the `compiq.inventory` Cosmos container exists but is **empty** (`SELECT VALUE COUNT(1) FROM c` returns 0), so even with valid auth there would be nothing to iterate. The function code, write-path target, and per-card subfolder schema are correctly implemented — neither precondition for executing them is met today.

**Root-cause classification (per W6.4 brief options):** Option 4 — *Exists in code but is failing at runtime*. Two compounding causes (auth + empty source).

## 1. Source-code analysis

Source lives on `origin/wip/snapshot-2026-05-20` and `origin/restore/preprod-deployed-state`. The three Python source files (`__init__.py`, `function.json`, `function.py`) have **identical blob SHAs** on both branches; the only difference is a committed `__pycache__/function.cpython-314.pyc` byte-blob on `restore` that isn't on `wip-snapshot`. Source content is equivalent — using `wip-snapshot` as the canonical read.

| File | Behavior |
|---|---|
| `function.json` | Timer trigger, cron `0 30 2 * * *` (nightly 02:30 UTC). |
| `__init__.py` | Entry point. Calls `run_prefetch()` from `.function`, then `logging.info("nightly comp prefetch summary: %s", result)`. |
| `function.py:run_prefetch()` | Gets `_inventory_container()`. **If None, logs `"Inventory container unavailable — nothing to prefetch"` and returns `{"processed": 0, "errors": 0}`** without writing any blob. Otherwise iterates `container.read_all_items()`, calls `prefetch_card(card, ebay_token)` per item. |
| `function.py:_inventory_container()` | Reads `COSMOS_ENDPOINT` + `COSMOS_KEY` env. If either missing → return None. Otherwise instantiates `CosmosClient(endpoint, key)` and calls `create_database_if_not_exists` + `create_container_if_not_exists`. **Catches all exceptions, logs `"Inventory container init failed: %s"`, returns None.** |
| `function.py:prefetch_card()` | Calls `_resolve_card_hedge_id(card)` → `search_cards`/`get_card_sales` via `shared.cardhedge` (live CH HTTP). Writes blob at `compiq-signals/{player_slug}/{card.id_or_built_id}/comps.json` via `shared.save_blob_json`. Then writes `compiq-signals/{player_slug}/{card.id_or_built_id}/psa_pop.json` via `psa_pop_signal()`. Then refreshes Cosmos 90-day floor via `update_floor_from_ebay` (eBay-backed, not blob). |

**Expected blob write paths** (confirmed from source, NOT the docs):
- `compiq-signals/{player_slug}/{card_id}/comps.json`
- `compiq-signals/{player_slug}/{card_id}/psa_pop.json`

Both match the per-card subfolder pattern that `copilot-instructions.md` documents (modulo `psa_pop.json` which the docs do not mention).

## 2. Telemetry verification

Same App Insights bifurcation as fn-cardhedge-comps (per W6 close-out capture #7): function-level application traces are not emitted. `traces | where cloud_RoleName == 'fn-compiq' | where message has 'nightly' or message has 'prefetch' or message has 'inventory' | where timestamp > ago(48h)` returns **8 host-level rows**, all infrastructure (function discovery × 2, schedule announcement × 2, listener stop × 2, listener start × 2). **No application-level traces** — the function's own `logging.info("fn-nightly-comp-prefetch done: processed=%d errors=%d", ...)` and `logging.warning("Inventory container unavailable — nothing to prefetch")` output is not surfacing.

**Caveat on "last 3 executions" (per W6.4 spec):** the observability bifurcation makes per-execution enumeration impossible from telemetry. The 48h window covers 2 scheduled fires (2026-05-20 02:30Z and 2026-05-21 02:30Z); a 96h+ lookback would be needed to span 3. What is observable is collective: no application trace exists for any execution attempt in the window queried.

Host trace at `2026-05-21T21:44:03.887Z` confirms the function is loaded and scheduled: *"The next 5 occurrences of the 'fn-nightly-comp-prefetch' schedule (Cron: '0 30 2 * * *') will be: 05/22 02:30Z, 05/23 02:30Z, 05/24 02:30Z, 05/25 02:30Z, 05/26 02:30Z."* So the function IS scheduled and will fire — execution outcome is what's unobservable.

## 3. Blob inventory — all containers in `stcompiqfnotgm2`

Connection string from `fn-compiq` app settings → `stcompiqfnotgm2`. Listing top-level containers:

| Container | Purpose | Relevant? |
|---|---|---|
| `azure-webjobs-hosts` | Functions runtime metadata | No |
| `azure-webjobs-secrets` | Functions secrets | No |
| `compiq-signals` | The signal store (primary) | Yes |
| `scm-releases` | Deployment release history | No |

**Only `compiq-signals` is a candidate write target.** No `prefetch-cache`, `per-card-comps`, `inventory-comps`, or similar alternative container exists. The function has no alternate path it could be using.

**Listing `compiq-signals` blobs (full enumeration, 5000-result cap):**
- All blob paths are 2-segment (`{player_slug}/{signal_type}.json`).
- **Zero blobs match the per-card 3-segment pattern.**
- `--query "[?contains(name, '/comps.json') || contains(name, '/psa_pop.json')]"` returns 0 hits.
- Players observed: `aaron-judge`, `caleb-bonemer`, `juan-soto`, `mike-trout`, `ronald-acuna-jr`, `shohei-ohtani`. No per-card subfolders under any.

The expected output simply does not exist anywhere in `stcompiqfnotgm2`.

## 4. Cross-check vs `fn-price-floor` Cosmos sink

Confirmed: `fn-nightly-comp-prefetch` does NOT use a Cosmos sink for the per-card comp data. The function uses Cosmos only as the *input* (reading the `inventory` container) and uses blob for *output* (per-card `comps.json` + `psa_pop.json`). The Cosmos `price_floors` writes are a separate side-effect via `update_floor_from_ebay`, unrelated to the per-card comp output. There is no architectural pivot to a Cosmos-based comp output to investigate.

## 5. Root-cause investigation — what fails at runtime

### 5a. Cosmos auth — primary failure

`fn-compiq` app-setting `COSMOS_KEY` does not match any of the four current keys on the `hobbyiq-comps` Cosmos account.

Comparison (sha256 first 12 chars, computed with trailing-newline stripped):

| Identity | SHA256 prefix |
|---|---|
| `fn-compiq` app-setting `COSMOS_KEY` | `2a308f0fc3e4` |
| Cosmos `primaryMasterKey` | `52408fca7094` |
| Cosmos `secondaryMasterKey` | `03ec0ddd0b27` |
| Cosmos `primaryReadonlyMasterKey` | `2f789de29f95` |
| Cosmos `secondaryReadonlyMasterKey` | `b3feaa81f047` |

**No match.** Direct test: instantiating `CosmosClient` with the fn-compiq `COSMOS_KEY` value and running `SELECT VALUE COUNT(1) FROM c` against `compiq.inventory` returns **401 — "The input authorization token can't serve the request. The wrong key is being used or the expected payload is not built as per the protocol."**

At runtime, `_inventory_container()` instantiates `CosmosClient(endpoint, key)` (which succeeds — the constructor is lazy), then calls `client.create_database_if_not_exists(...)` which actually hits the wire and gets 401. The broad `except Exception` catches it, the warning is logged (and lost — see Section 2), `_inventory_container()` returns `None`, `run_prefetch()` exits at the `not container` branch with `{"processed": 0, "errors": 0}`, and no blob writes occur.

### 5b. Empty inventory — latent failure

Even with a working key, the function would write zero blobs. Direct query of `compiq.inventory` using the fresh Cosmos `primaryMasterKey`:

```sql
SELECT VALUE COUNT(1) FROM c
```

against `compiq.inventory` returns `0`. The container exists (`az cosmosdb sql container list --database-name compiq` shows `inventory` and `price_floors`) but has zero items. `container.read_all_items()` would return an empty iterator. The for-loop body never executes. `processed=0, errors=0`. Same end state as 5a.

### 5c. Interaction with Workstream A findings

Per the W6.4-author side-note: Workstream A established that Card Hedge API is **live** for the current key despite the 2026-05-19 subscription cancellation, and fn-cardhedge-comps is therefore returning real recent eBay-sourced comps. **fn-nightly-comp-prefetch would call the same `shared.cardhedge` module** (via `_resolve_card_hedge_id` → `search_cards`, then `prefetch_card` → `get_card_sales`). The Workstream A characterization of live-CH access extends transitively to this function — but is unobservable in this scope, because preconditions 5a and 5b block any per-card call from being made. Whether the live-CH path actually behaves the same for fn-nightly-comp-prefetch's call pattern (different `card_id` shape, different query structure, different `count` value) is unverified until the function executes.

## 6. Phase 4a implications

The Phase 4a cache-layer plan (Weeks 5–6, Jun 19–Jul 2 per `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md`) assumes per-card prefetch output is available to consume. **It is not, and won't be without addressing both preconditions.**

| # | Precondition | Current gap |
|---:|---|---|
| 1 | Working Cosmos auth from `fn-compiq` to `hobbyiq-comps` | `COSMOS_KEY` app-setting does not match any current `hobbyiq-comps` master/RO key — see Section 5a |
| 2 | Populated `compiq.inventory` container | Container exists but is empty — see Section 5b |

fn-nightly-comp-prefetch's runtime status is **unrun**, not **running-but-silent** — neither precondition above is met, so no per-card call is ever made. The factual implication for any plan that depends on this function's output: that output does not currently exist.

**Secondary concern — not verified in this scope.** If any other code path in `fn-compiq` reads `COSMOS_KEY` and instantiates a `CosmosClient` against `hobbyiq-comps`, that path would 401 with the same key. Candidates worth a follow-up diagnostic:

- `update_floor_from_ebay` (called from `prefetch_card`; presumably writes to the `price_floors` container based on the `COSMOS_FLOOR_CONTAINER` env-var name and the function's import path, but `shared/cosmos_floor.py` was not opened in this scope).
- `fn-price-floor` (HTTP-triggered, separate function; auth pattern not inspected here).

Flagged as a probable adjacent finding; not investigated.

## Anti-drift note

This document characterizes the failure modes and the work needed to make Phase 4a's assumption true. It does not propose how to populate inventory or how to handle key rotation — those are Phase 3 / Phase 4a kickoff decisions. The Cosmos-key staleness is a real operational gap surfaced during this diagnostic and is captured here as a finding, not as a recommended action.
