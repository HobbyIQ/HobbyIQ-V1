# Phase 0 / W6.4 — MCP Repo Discovery for Phase 4a Planning

**Captured:** 2026-05-21 (PM)
**Scope:** Read-only discovery. No code changes, no settings changes, no adoption proposals.
**Question being answered:** Does usable MCP-mediated pricing code already exist that Phase 4a could start from, or must Phase 4a be greenfield?
**Phase 0 success criterion this resolves:** "MCP repo found OR confirmed to need building."

**Headline:** An MCP server exists — `mcp-server/` is in-tree on `main`, committed 2026-05-19 (PR #78, commit `e0852a4`). It is the only live implementation discovered. All on-disk copies elsewhere are identical-or-older backup snapshots of the same authoring window. No deleted/abandoned MCP repo or external "cache_layer / comp_cache / pricing_cache" implementation was found. The "MCP repo found" criterion is satisfied. Adoption-vs-greenfield is a Phase 4a kickoff decision (Weeks 5–6) and is explicitly out of scope here.

**Method:** Four search targets executed per W6.4 brief — local disk (`C:/dev`, `C:/temp`), OneDrive read-only reference, GitHub `HobbyIQ` user, and `hobbyiq-main` git history. Patterns: `mcp` (case-insensitive), `model context protocol`, `cache_layer`, `comp_cache`, `pricing_cache`. Plus mcp-server directory discovery via `find -iname "*mcp*"`.

## Search target 1 — Local disk (C:/dev, C:/temp)

`C:/dev/` contains only one repo: `hobbyiq-main` (canonical work tree). `C:/temp/` contains 4 hobbyiq-* backup snapshot directories.

Pattern hits: `model context protocol` → **0 hits anywhere**. `cache_layer | comp_cache | pricing_cache` → **0 hits anywhere**. `find -iname "*mcp*"` → 5 `mcp-server` directories (the canonical + 4 snapshots, see below).

| # | Path | Description | Last modified | Completeness | Verdict |
|---:|---|---|---|---|---|
| 1.1 | `C:/dev/hobbyiq-main/mcp-server/` | **Canonical.** 14 TypeScript files: `server.ts` (16KB), `pricing.ts` (25KB), `cardhedge.ts` (15KB), `compsAnalytics.ts` (10KB), `compsLoader.ts`, `backtest.ts`, `cardModifiers.ts`, `catalystCalendar.ts`, `predictionLog.ts`, plus `scripts/` (incl. `query-predictions.cjs`), `package.json`, `tsconfig.json`. Total source ~182KB. Reads cached comps from Azure Blob via `compsLoader.ts`; no separate "cache layer" abstraction. | 2026-05-20 (file mtime); committed 2026-05-19 in PR #78 | working — sole live MCP implementation | use as-is (or greenfield — Phase 4a decision) |
| 1.2 | `C:/temp/hobbyiq-cardsight-clean/mcp-server/` | Snapshot. `diff -rq` against canonical: **identical** (0 differences). | 2026-05-20 (dir mtime) | snapshot duplicate | reference only |
| 1.3 | `C:/temp/hobbyiq-v1-clean/mcp-server/` | Snapshot. Source files identical to canonical; additionally carries `dist/`, `node_modules/`, `mcp-deploy.zip` (124MB total). | 2026-05-20 (dir mtime) | snapshot duplicate + built artifacts | reference only |
| 1.4 | `C:/temp/hobbyiq-wip-snapshot/mcp-server/` | Snapshot. Source identical to canonical **except missing `scripts/query-predictions.cjs`** — predates canonical by ≥ one script-folder edit. Also carries `mcp-deploy.zip`. | 2026-05-20 (dir mtime) | snapshot, slightly stale vs canonical | reference only |

## Search target 2 — OneDrive HobbyIQ-V1 reference (READ-ONLY)

Per brief, OneDrive is the read-only reference. Did NOT touch.

| # | Path | Description | Last modified | Completeness | Verdict |
|---:|---|---|---|---|---|
| 2.1 | `OneDrive/HobbyIQ-V1/mcp-server/` | Source files identical to canonical (`diff -rq` source-only: 0 differences). Carries `dist/`, `node_modules/`, `mcp-deploy.zip`, `deploy-log.txt`. ~125MB total. | 2026-05-20 (dir mtime) | snapshot duplicate + built artifacts + deploy log | reference only |

Pattern hits in OneDrive for `model context protocol`, `cache_layer`, `comp_cache`, `pricing_cache`: **0**.

## Search target 3 — GitHub HobbyIQ user

`HobbyIQ` is a GitHub **user account** (not an org). `gh api users/HobbyIQ/repos` returned 4 public repos. None contain `mcp` or `cache` in the name. None mention "model context protocol" in description.

| # | Repo | Description / Contents | Last push | Completeness | Verdict |
|---:|---|---|---|---|---|
| 3.1 | `HobbyIQ/HobbyIQ-V1` | The active work repo (25.7MB). Same one cloned to `C:/dev/hobbyiq-main`. Already in scope. | 2026-05-21 | working — canonical | (covered by target 1.1) |
| 3.2 | `HobbyIQ/HobbyIQ-app` | TypeScript monorepo scaffold (133KB). Workspaces declared (`packages/*`, `apps/*`); only `apps/api/` populated, containing `eslint.config.js`, `jest.config.js`, `package.json`, `src/`, `tsconfig.json`, `tsconfig.test.json`. No `mcp-server` path. No deploy-verify scratch. | 2026-04-06 | abandoned scaffold — predates current architecture by ~6 weeks | reference only |
| 3.3 | `HobbyIQ/hobbyiq-backend` | Size: 0 bytes. Default branch `main`, never populated. | 2026-04-07 | abandoned scaffold (empty) | reference only |
| 3.4 | `HobbyIQ/hobbyiq-conductor` | Python FastAPI scaffold (26KB). `app/main.py` (`/health`, `/api/v1/query` with APIM-key auth), `app/models.py` (Pydantic), `app/services/llm_service.py` (Azure OpenAI client), `requirements.txt`, `Dockerfile`. README pitches it as "AI-powered conductor for sports-card and collectibles hobby queries." **Not MCP-protocol** — it is a plain HTTP query endpoint. One open issue (#4) flags missing CI/CD; never deployed. No "mcp", "cache_layer", "comp_cache", or "pricing_cache" strings in repo. | 2026-04-07 | abandoned scaffold — language and protocol mismatch with current canonical TS mcp-server | reference only |

## Search target 4 — Git history of `hobbyiq-main`

`git log --all --diff-filter=D --summary | grep -iE "(mcp|cache)"` results, partitioned:

**4a. Pre-existing pricing/infra "cache" stubs — still in `main`, not deleted.**

Surfaced via PR #65 commit message (2026-05-19, `5a76e1e`) which mentioned the test `backend/tests/pricing/cache-logger.test.ts` referenced a "deleted `src/modules/compiq/services/pricing/infra/` tree." That deletion message refers to a root-level `src/...` path that never existed in `main`. The `backend/src/modules/compiq/services/pricing/infra/` tree **does still exist in `main` today**:

| Path | Lines | Description | First added | External callers |
|---|---:|---|---|---|
| `backend/src/modules/compiq/services/pricing/infra/PricingCache.ts` | 7 | In-memory `Map<string, any>` cache class with `get / set / clear`. No TTL, no Redis, no key namespacing. | `dccadb1` (2026-05-03) | **None** — grep `PricingCache` in `backend/src/` only matches the file itself. |
| `backend/src/modules/compiq/services/pricing/infra/PricingLogger.ts` | 10 | `console.log` wrapper with comment `// TODO: Integrate with real logging/telemetry`. | `dccadb1` (2026-05-03) | **None** — grep `PricingLogger` in `backend/src/` only matches the file itself. |

Verdict on these two: **scaffold only** — not wired into any pricing pipeline, no Redis/TTL/MCP integration, written before the current mcp-server existed. Likely a placeholder authored in the early monorepo scaffolding phase and never deleted because no test/lint touches them.

The real cache layer in the backend is `backend/src/services/shared/cache.service.ts` — Redis + in-memory fallback with TTL, lazy client, env-driven config. It is unrelated to MCP pricing and is not branded with "MCP".

**4b. Deleted `deploy-verify/` cache providers — unrelated to MCP.**

`git log` surfaces many deleted files under `deploy-verify/apps/api/src/providers/cache/` and `deploy-verify/apps/api/src/datalake/cache.{ts,js}` (Redis / InMemory / Mock cache providers, factories, cacheRepository.js, services/comps/cache.ts, etc.). These were inside a `deploy-verify/` scratch tree containing duplicated deploy artifacts; the entire `deploy-verify/` directory was excised in an earlier cleanup. None of these were on the live code path; they were verification copies. **Not MCP-related.**

**4c. `mcp-server/` path deletion history.**

`git log --all --diff-filter=D --summary | grep -i "mcp-server"` → **0 hits.** `mcp-server/` was added by `e0852a4` (PR #78, 2026-05-19) and has not been deleted on any branch. Only one commit has ever touched the directory.

**4d. Search terms with zero coverage anywhere in `hobbyiq-main` history.**

`cache_layer`, `comp_cache`, `pricing_cache`, `model context protocol` — **0 hits across all-branches history** (added and deleted, all paths). No earlier prototype with any of these naming conventions ever lived in this repo.

## Summary

| Target | MCP/cache artifacts found | Live? | Phase 0 implication |
|---|---|---|---|
| 1. Local disk | 1 canonical `mcp-server/` + 3 snapshot duplicates (1 slightly stale) | Canonical = live; snapshots = stale | One implementation exists; no parallel/alternative MCP repo present |
| 2. OneDrive | 1 `mcp-server/` snapshot identical to canonical (source-only) | No (backup) | No new code beyond canonical |
| 3. GitHub user `HobbyIQ` | 3 stale/empty repos (`HobbyIQ-app`, `hobbyiq-backend`, `hobbyiq-conductor`); none MCP-protocol or cache-themed | No | No external MCP repo to consider |
| 4. Git history | 2 unwired 7- and 10-line stubs in `pricing/infra/` (`PricingCache.ts`, `PricingLogger.ts`); `deploy-verify/` cache providers (unrelated); no MCP-server deletions; zero hits for `cache_layer / comp_cache / pricing_cache / "model context protocol"` | Stubs in tree but unreferenced | No prior MCP cache layer to recover from history |

**Phase 0 success criterion ("MCP repo found OR confirmed to need building"): SATISFIED — `mcp-server/` exists in-tree, single canonical implementation, last committed 2026-05-19 (PR #78).**

**Anti-drift note (per W6.4 brief):** This document characterizes what exists; it does not recommend whether Phase 4a should adopt the canonical `mcp-server/`, refactor it, or greenfield around it. That decision is a Phase 4a kickoff item (Weeks 5–6). Open characterization questions for Phase 4a (out of scope tonight): (a) whether the in-tree `pricing/infra/Pricing{Cache,Logger}.ts` stubs should be deleted or extended; (b) whether MCP-side caching should live in `mcp-server/compsLoader.ts` vs a new abstraction; (c) whether `backend/src/services/shared/cache.service.ts` (Redis + memory fallback) should back the MCP layer or stay backend-local.

## Adjacent finding — `compiq-functions/fn-*` source not on `main`

Surfaced during the same disk/repo walk (originally flagged in the session resume-brief; verified here against `main` and remotes). Scope-expanded into this doc on explicit user direction; primary owner remains the broader Phase 0 observability workstream.

**Claim:** Production `fn-compiq` runs 14 Azure Functions (per W6.3 inventory), but the `compiq-functions/fn-*` source directories are not present on `main`.

**Verified state on `main` (HEAD `672ffd8`, 2026-05-21):**

`compiq-functions/` on main contains only: `README.md`, `host.json`, `local.settings.json.example`, `requirements.txt`, and `shared/`. No `fn-*` subdirectories exist. `git log main --diff-filter=D --name-only -- "compiq-functions/fn-*"` returns **zero results** — the directories were never deleted from `main`; they were never committed to `main` in the first place. The only `compiq-functions/` commits on `main` are PR #76 `2d2ea21` ("add Azure Functions app scaffolding") and PR #77 `91e517d` ("add shared helper modules for Azure Functions").

**Where the `fn-*` source lives:**

| Branch | HEAD | Date | fn-* dir count | Notes |
|---|---|---:|---:|---|
| `origin/wip/snapshot-2026-05-20` | `5fad0a2` | 2026-05-20 | 16 | "wip: snapshot of V1 working tree (2026-05-20)". Branched from main at `8485add`. |
| `origin/restore/preprod-deployed-state` | `1cb6f45` | 2026-05-14 | 16 | "snapshot: preserve currently-deployed source before reconciliation triage". Branched from main at `e606c8d`. |

The 16-vs-14 count: the snapshot branches carry 2 source dirs that are not deployed in production — `fn-player-score-refresh` and `fn-price-alert-checker`. This matches W6.3's "in brief, NOT deployed" pair. Net deployed-count alignment: 16 source dirs − 2 not-deployed = 14 prod functions, consistent with W6.3.

**Implication (characterization only, no remediation proposed):** Canonical `main` does not reflect production for the function-app subsystem. Anyone editing function code from a `main` checkout starts from scaffolding, not from the deployed state. Reconciliation between `main` and one of the snapshot branches is its own workstream and is out of scope for W6.4 / Phase 0.

**Phase 4a relevance:** If Phase 4a touches the per-card prefetch path (`fn-nightly-comp-prefetch`) or the comp-serve path (`fn-serve-signals`), this drift must be resolved first — otherwise PRs against `main` will not have the underlying function code to integrate with.
