# Phase 0 — COSMOS_KEY shared-auth diagnostic

**Captured:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope:** Read-only investigation. No code changes. No env-var changes. No function disables.
**Time budget:** 25 min.
**Source:** Workstream B follow-up. The original Finding 6 / Workstream B doc (`docs/phase0/finding6_nightly_prefetch_writepath.md`, commit `e328177`) flagged a secondary concern: if `update_floor_from_ebay` or `fn-price-floor` share the same stale `COSMOS_KEY` env var that `fn-nightly-comp-prefetch` does, they would 401 the same way. This document characterizes whether they do, and what the production implication is.

**Headline — CONFIRMED PARTIAL.** All Python paths in `fn-compiq` that read `COSMOS_KEY` are affected by the stale-key defect. **The Node backend (HobbyIQ3) is NOT affected** because it has a documented AAD fallback chain. The Cosmos 21% failure rate from the original Phase 0 finding is **unlikely to be explained by this defect alone** — that rate hit the Node-backend path which has AAD fallback. The defect's real production impact is concentrated in the Python function app's Cosmos-using paths (`fn-nightly-comp-prefetch`, `fn-price-floor` via `shared/cosmos_floor`, and the floor-refresh side-effect inside `prefetch_card`). PR #107's restored newer version of `fn-nightly-comp-prefetch` did NOT fix the auth pattern — `Failure A` from Workstream B persists in the version now on `main`.

## 1. Per-function/module env-var inventory

| Path | Env var(s) read | Auth fallback? | Status |
|---|---|:-:|---|
| `compiq-functions/shared/cosmos_floor.py:_container()` | `COSMOS_KEY`, `COSMOS_ENDPOINT`, `COSMOS_DB`, `COSMOS_FLOOR_CONTAINER` | **None** — `CosmosClient(endpoint, key)`; returns `None` if either missing | Affected |
| `compiq-functions/fn-price-floor/__init__.py` | (transitive via `shared.cosmos_floor.read_floor` + `update_floor_from_ebay`) | None (inherits shared module's pattern) | Affected |
| `compiq-functions/fn-nightly-comp-prefetch/function.py:_inventory_container()` | `COSMOS_KEY`, `COSMOS_ENDPOINT`, `COSMOS_DB`, `COSMOS_INVENTORY_CONTAINER` | **None** — direct `CosmosClient(endpoint, key)`; broad `except Exception` returns `None` | Affected (Workstream B Failure A) |
| `compiq-functions/fn-nightly-comp-prefetch/function.py:prefetch_card()` | (transitive via `shared.cosmos_floor.update_floor_from_ebay`) | None | Affected — but moot because `_inventory_container()` short-circuits first |
| `compiq-functions/fn-cardhedge-comps/*` | **(no Cosmos use)** | n/a | **Not affected** — uses blob only |
| `backend/src/jobs/portfolioReprice.job.ts` (Node) | `COSMOS_CONNECTION_STRING` || `COSMOS_KEY`+`COSMOS_ENDPOINT` || `DefaultAzureCredential` | **YES — three-tier AAD fallback** | NOT affected |
| `backend/src/repositories/alertPreferences.repository.ts` (Node) | Same three-tier fallback | YES | NOT affected |
| `backend/src/repositories/dailyiq.repository.ts` (Node) | Same three-tier fallback | YES | NOT affected |

The Node-side pattern (verified via grep at `backend/src/repositories/*.repository.ts` and `backend/src/jobs/portfolioReprice.job.ts`):

```ts
let client: CosmosClient;
if (connStr) client = new CosmosClient(connStr);
else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
```

The Python-side pattern (verified via grep at `compiq-functions/shared/cosmos_floor.py:32-50` and `compiq-functions/fn-nightly-comp-prefetch/function.py:37-55`):

```python
def _container():
    endpoint = os.environ.get("COSMOS_ENDPOINT")
    key = os.environ.get("COSMOS_KEY")
    if not endpoint or not key:
        return None
    # CosmosClient(endpoint, key) — only the key path; no AAD fallback
```

## 2. Deployed-settings cross-reference

`az functionapp config appsettings list -n fn-compiq -g rg-hobbyiq-dev --query "[?contains(name, 'COSMOS')].name"`:

- `COSMOS_DB` ✓
- `COSMOS_ENDPOINT` ✓
- `COSMOS_FLOOR_CONTAINER` ✓
- `COSMOS_KEY` ✓ (present, but **value doesn't match any current Cosmos master/RO key** per Workstream B's earlier sha-256 comparison: fn-compiq's `COSMOS_KEY` hashes to `2a308f0fc3e4`; the four current Cosmos keys hash to `52408fca7094` / `03ec0ddd0b27` / `2f789de29f95` / `b3feaa81f047`)

NOT in fn-compiq settings: `COSMOS_CONNECTION_STRING`, `COSMOS_INVENTORY_CONTAINER`. The latter is fine (function has a default `"inventory"`). The former is fine because the Python pattern doesn't read it (only the Node pattern does).

## 3. Conclusion — CONFIRMED PARTIAL

**Confirmed:** all Python paths in `fn-compiq` that read `COSMOS_KEY` share the same stale-key defect. Specifically:
- `shared/cosmos_floor.py:_container()` reads `COSMOS_KEY` directly with no AAD fallback. The function silently returns `None` on auth failure.
- `fn-price-floor` is transitively affected via `read_floor` and `update_floor_from_ebay`. Its HTTP handler (`__init__.py:result = update_floor_from_ebay(...)`) would log a warning and return a no-op result on auth failure.
- `fn-nightly-comp-prefetch` is affected in two places: `_inventory_container()` directly (Workstream B Failure A), and `prefetch_card()` transitively via `update_floor_from_ebay`. The direct path short-circuits before the transitive one can execute.

**Refuted (partial):**
- The Node backend (HobbyIQ3, `/api/compiq/price`, `/api/dailyiq/*`, etc.) is **not affected by this defect**. It has a three-tier auth chain: connection string → key → AAD. If `COSMOS_KEY` is stale, the Node code falls through to `DefaultAzureCredential`. Whether that AAD path succeeds depends on the App Service's managed identity having the right Cosmos role.
- `fn-cardhedge-comps` has zero Cosmos usage. Not affected by anything Cosmos-related.

**Refined characterization of the original Cosmos 21% failure rate (Finding 4 in earlier 2026-05-21 PM entry):**
The 21% was specifically about `hobbyiq-comps-centralus` regional endpoint. That endpoint is hit by the Node backend, which has AAD fallback. The Python-side defect is unlikely to be the explanation. The 21% is more plausibly a regional-routing / geo-replication issue. **This diagnostic does NOT confirm the COSMOS_KEY hypothesis as the explanation for the 21% rate.** The defect is real, but it's a separate phenomenon from the 21%.

## 4. Implication for Cosmos 21% hypothesis

Not the same defect. The 21% finding stands as its own thing (regional endpoint behavior), and is **not yet explained** by this investigation. A future diagnostic could:
- Pull regional-endpoint failure events from App Insights filtered by Cosmos client
- Check whether the Node backend's `DefaultAzureCredential` path is succeeding or failing for the 21% slice
- Determine whether `hobbyiq-comps-centralus` is in geo-replicated state or whether the 21% is a write-region-vs-read-region phenomenon

Out of scope for tonight's diagnostic.

## 5. Implication for Phase 3 cleanup and Phase 4a planning

**For Phase 3 cleanup:**
- `fn-price-floor` is HTTP-triggered. Its production invocation frequency is **unknown** (W6.3 noted no AI telemetry visible for fn-compiq's HTTP triggers). If it's called by the iOS app or Node backend's pricing path, it returns silent no-op results due to this auth defect. Phase 3 should NOT assume fn-price-floor is functional just because it's deployed. Investigate the call path before deciding to disable.
- The actual `applyPriceFloor()` logic in the Node backend's `/api/compiq/price` handler likely bypasses fn-price-floor entirely and talks to Cosmos directly via the Node CosmosClient (which has AAD fallback). If so, fn-price-floor is vestigial and the auth defect has near-zero production impact.

**For Phase 4a (MCP cache layer) planning:**
- If Phase 4a depends on `fn-nightly-comp-prefetch` per-card cache output, that prerequisite remains unmet per Finding 6 — both Failure A (auth) and Failure B (empty inventory) need resolution.
- Phase 4a should NOT replicate the Python-side `CosmosClient(endpoint, key)` pattern. The Node-side three-tier fallback or pure-AAD pattern is more resilient. Whatever new code Phase 4a ships should follow that pattern.

## 6. Annotation for PR #107 / restored fn-nightly-comp-prefetch source

PR #107 (`46390e7`) restored the newer version of `fn-nightly-comp-prefetch/function.py` from `origin/wip/snapshot-2026-05-20`. That version adds the scoring-based `_resolve_card_hedge_id` rewrite but **does NOT change the Cosmos auth pattern.** Lines 37-38 of the restored file still read `COSMOS_KEY` directly with no fallback. **Failure A from Workstream B persists in the version now on `main`.** The Finding 6 annotation added by commit `ac2bf37` correctly flagged that future investigation must account for whether the issues persist; this diagnostic answers that question: **Failure A persists; Failure B (empty inventory) is independent and also persists.**

## Anti-drift note

This document characterizes findings. It does not propose key rotation, code refactoring, AAD migration, or any other remediation. Those are Phase 3 / Phase 4a kickoff decisions and require their own focused sessions with explicit fix scope.
