# Triage: reconcile origin/main with deployed-but-unpushed source (Phase 1 prereq)

## 1. Summary

Production at `hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net` runs `dist/server.js` compiled from `backend/src/**/*.ts`. The deployed binary contains feature code (neighbor synthesis, cross-parallel anchor, full pricing engine) that was never pushed to `origin/main`. The TypeScript source that built the live binary exists only in the local working tree and on the `restore/preprod-deployed-state` snapshot branch. `origin/main` is therefore **behind production** by ~2,700 LOC of backend changes plus 49+ unpushed live source files.

This issue scopes **PR #2.5**, the reconciliation. PR #2.5 commits the 60-file delta (live TS sources + tests + tsconfig.json + a `.gitignore` edit) verbatim from the snapshot branch onto `main`. After PR #2.5 merges, `main` will match the deployed binary exactly, enabling `GIT_SHA` to point at a real commit hash and unblocking PR #2b (Cosmos `compiq_corpus` container) + PR #3 (Tier 1 corpus). The dead JS tree at `backend/server.js` / `backend/routes/*.js` / `backend/services/*.js` (28 files) and the dead-twin route files (`compiq.ts`, `dailyiq.ts`, `playeriq.ts`, `* - Copy.ts`, `compiqService.ts`) are **excluded** from PR #2.5 and deferred to a post-Phase-1 cleanup PR.

## 2. Architecture Finding — dead JS tree proof

- Live App Service `appCommandLine` is `node dist/server.js`, not `node server.js`.
- `dist/` is built from `backend/src/**/*.ts` via `tsc`; it is `.gitignore`d and only exists on the deploy slot.
- `backend/server.js`, `backend/routes/*.js`, and `backend/services/*.js` (28 files total) are **absent** from `/home/site/wwwroot` on the running container — they are dead code that has never been part of the production runtime.
- Both static imports (`import x from "./..."`) and dynamic imports (`await import("./...")`) in the TS source resolve to TS files only; no live TS file imports any of the legacy JS files.
- The 60-file PR #2.5 manifest is derived from the static + dynamic import closure of `src/app.ts` and `src/server.ts` intersected with the snapshot diff, then filtered against dead-twin patterns.

## 3. SSH Verification Evidence

**(a) App Service startup command:**
```
$ az webapp config show -g rg-hobbyiq-dev -n hobbyiq3 --query "appCommandLine" -o tsv
node dist/server.js
```

**(b) `/home/site/wwwroot` listing — no `server.js`, no `routes/`, no `services/` at root:**
```
$ ls -la /home/site/wwwroot
drwxrwxrwx ... dist
lrwxrwxrwx ... node_modules -> /node_modules
-rwxrwxrwx ... node_modules.tar.gz
-rwxrwxrwx ... oryx-manifest.toml
-rwxrwxrwx ... package-lock.json
-rwxrwxrwx ... package.json
```
(Kudu `ps aux` returns empty for the app container because the SCM sidecar runs in a separate namespace; `appCommandLine` above is the authoritative startup spec.)

**(c) `dist/` contents — the actual runtime tree:**
```
$ ls /home/site/wwwroot/dist
app.js   config   jobs   middleware   modules   repositories   routes
server.js   services   src   tests   types   utils

$ ls /home/site/wwwroot/dist/routes
alerts.routes.js   auth.routes.js   compiq.js   compiq.routes.js   compiq.zod.js
dailyiq.js         dailyiq.routes.js          devices.routes.js   ebay.routes.js
health.routes.js   ocr.routes.js              ops.routes.js
playeriq.js        playeriq.routes.js         portfolioiq.routes.js
psa.routes.js      uploads.routes.js          watchlist.routes.js
```

**(d) Existence checks — legacy JS tree confirmed absent at wwwroot root:**
```
$ test -e /home/site/wwwroot/server.js     && echo PRESENT || echo ABSENT
ABSENT_server.js
$ test -d /home/site/wwwroot/routes        && echo PRESENT || echo ABSENT
ABSENT_routes_dir
$ test -d /home/site/wwwroot/services      && echo PRESENT || echo ABSENT
ABSENT_services_dir
```

**(e) `neighborSynthesisDebug` field origin — confirms compiled TS is the producer:**
```
$ grep -l neighborSynthesisDebug /home/site/wwwroot/dist/services/compiq/*.js /home/site/wwwroot/dist/routes/*.js
/home/site/wwwroot/dist/services/compiq/compiqEstimate.service.js
/home/site/wwwroot/dist/routes/compiq.routes.js
```

## 4. Duplicate Route Pairs

For each pair, the `*.routes.ts` variant is the live mount and the bare `*.ts` variant is a dead twin. Evidence is the import line in `backend/src/app.ts`.

| Pair | Live file | Dead twin | `app.ts` evidence |
|---|---|---|---|
| compiq | `backend/src/routes/compiq.routes.ts` | `backend/src/routes/compiq.ts` (in PR #2.5 diff scope → excluded) | L8: `import compiqRoutes from "./routes/compiq.routes.js";` &nbsp;·&nbsp; L46: `app.use("/api/compiq", compiqRoutes);` |
| dailyiq | `backend/src/routes/dailyiq.routes.ts` | `backend/src/routes/dailyiq.ts` (193 bytes; **already on `main` unchanged → not in PR #2.5 scope**) | L10: `import dailyiqRoutes from "./routes/dailyiq.routes.js";` &nbsp;·&nbsp; L49–51: mounted at `/api/dailyiq`, `/api/dailyIQ`, `/api/daily` |
| playeriq | `backend/src/routes/playeriq.routes.ts` | `backend/src/routes/playeriq.ts` (193 bytes; **already on `main` unchanged → not in PR #2.5 scope**) | L11: `import playeriqRoutes from "./routes/playeriq.routes.js";` &nbsp;·&nbsp; L52: `app.use("/api/playeriq", playeriqRoutes);` |

Grep confirmation that nothing imports the dead twins: `Get-ChildItem backend/src -Recurse -Include "*.ts" | Select-String "from ['\"].*routes/(compiq|dailyiq|playeriq)['\"]"` returns **zero hits** for the non-`.routes` variants.

Only `compiq.ts` appears in the snapshot diff (modified by working tree); it gets `exclude (dead-twin)` in PR #2.5. `dailyiq.ts` and `playeriq.ts` are dead-on-`main` and not in scope here — they're logged in the followup queue for the cleanup PR.

## 5. Per-File Triage Table (all 69 rows)

### Section A — Engine core & dependencies (compiq pricing path) — 9 rows

| File | Category | Reachability evidence | Triage decision | Notes |
|---|---|---|---|---|
| `backend/src/services/compiq/compiqEstimate.service.ts` | engine-core | produces live response fields `fairMarketValueLive`, `neighborSynthesis`, `neighborSynthesisDebug`, `crossParallelAnchor`; imported by `compiq.routes.ts` | include verbatim | 23 console.* — repo convention; +2,111 line working-tree delta is the unpushed production source |
| `backend/src/services/compiq/compiqSearch.service.ts` | engine-core | imported by `compiq.routes.ts`; produces `searchQuery` field upstream | include verbatim | |
| `backend/src/services/compiq/cardQueryParser.ts` | engine-core | imported statically and dynamically by `compiqEstimate.service.ts` (L1039, 1238, 1536, 1972); produces `parsedQuery` | include verbatim | |
| `backend/src/services/compiq/cardhedge.client.ts` | engine-core | imported statically + dynamically by `compiqEstimate.service.ts` (L1226, 1524, 1960) | include verbatim | |
| `backend/src/services/compiq/neighborSynthesis.ts` | engine-core | dynamic-imported by `compiqEstimate.service.ts` (L1109, 1237, 1415, 1535, 1971) | include verbatim | Missed by static closure; reachability confirmed via `await import` |
| `backend/src/services/compiq/neighborMultipliers.ts` | helper | imported statically by `neighborSynthesis.ts` L29 | include verbatim | Live transitively via dynamic-import path |
| `backend/src/services/compiq/ebayFallback.ts` | engine-core | dynamic-imported by `compiqEstimate.service.ts` (L1113, 1417) | include verbatim | Missed by static closure |
| `backend/src/services/compiq/normalizationDictionary.service.ts` | helper | imported by live compiq engine | include verbatim | |
| `backend/src/modules/compiq/services/pricing/core/PricingPipeline.ts` | helper | imported by `DynamicPricingOrchestrator.ts` (live closure) | include verbatim | 1 pre-existing TODO; not a regression |

### Section B — Routes & entry points — 16 rows

| File | Category | Reachability evidence | Triage decision | Notes |
|---|---|---|---|---|
| `backend/src/app.ts` | engine-core | mounts all 18 live routes (L44–60) | include verbatim | |
| `backend/src/server.ts` | engine-core | startup entry — compiled to `dist/server.js`, the verified live `appCommandLine` | include verbatim | |
| `backend/src/routes/compiq.routes.ts` | route-handler | imported by `app.ts` L8; produces `neighborSynthesis`/`neighborSynthesisDebug` at L253–254, 338–339 | include verbatim | +704 line working-tree delta |
| `backend/src/routes/dailyiq.routes.ts` | route-handler | imported by `app.ts` L10; mounted L49–51 | include verbatim | |
| `backend/src/routes/playeriq.routes.ts` | route-handler | imported by `app.ts` L11; mounted L52 | include verbatim | |
| `backend/src/routes/portfolioiq.routes.ts` | route-handler | imported by `app.ts`; mounted L47–48 | include verbatim | |
| `backend/src/routes/alerts.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/auth.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/devices.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/ebay.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/health.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/ocr.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/ops.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/psa.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/uploads.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |
| `backend/src/routes/watchlist.routes.ts` | route-handler | imported by `app.ts` | include verbatim | |

### Section C — Services (non-compiq) — 21 rows

| File | Category | Reachability evidence | Triage decision |
|---|---|---|---|
| `backend/src/services/appleAuth.ts` | helper | imported by `auth.routes.ts` / `authService.ts` | include verbatim |
| `backend/src/services/authService.ts` | helper | imported by live routes | include verbatim |
| `backend/src/services/notification.service.ts` | helper | imported by `alerts.routes.ts` + jobs | include verbatim |
| `backend/src/services/dailyiq/briefStore.service.ts` | helper | imported by `dailyiq.routes.ts` + `dailyiq.job.ts` | include verbatim |
| `backend/src/services/dailyiq/fantasyScoring.service.ts` | helper | imported by live dailyiq path | include verbatim |
| `backend/src/services/dailyiq/milbBoxScoreService.ts` | helper | imported by live dailyiq path | include verbatim |
| `backend/src/services/dailyiq/mlbBoxScoreService.ts` | helper | imported by live dailyiq path | include verbatim |
| `backend/src/services/dailyiq/probablePitchersService.ts` | helper | imported by live dailyiq path | include verbatim |
| `backend/src/services/dailyiq/recentFormService.ts` | helper | imported by live dailyiq path | include verbatim |
| `backend/src/services/dailyiq/watchlistStore.service.ts` | helper | imported by `dailyiq.routes.ts` / `watchlist.routes.ts` | include verbatim |
| `backend/src/services/ebay/ebayAuth.service.ts` | helper | imported by `ebay.routes.ts` | include verbatim |
| `backend/src/services/ebay/ebayListing.service.ts` | helper | imported by `ebay.routes.ts` | include verbatim |
| `backend/src/services/ebay/ebayTokenStore.service.ts` | helper | imported by `ebayAuth.service.ts` | include verbatim |
| `backend/src/services/ocr/cardOcr.service.ts` | helper | imported by `ocr.routes.ts` | include verbatim |
| `backend/src/services/playerScore/mlbStats.service.ts` | helper | imported by live playerScore service | include verbatim |
| `backend/src/services/playerScore/playerScore.service.ts` | helper | imported by `playeriq.routes.ts` + `dailyiq.routes.ts` | include verbatim |
| `backend/src/services/playerScore/trendHistory.service.ts` | helper | imported by live playerScore path | include verbatim |
| `backend/src/services/portfolioiq/portfolioStore.service.ts` | helper | imported by `portfolioiq.routes.ts` + `portfolioReprice.job.ts` | include verbatim |
| `backend/src/services/psa/psaCert.service.ts` | helper | imported by `psa.routes.ts` | include verbatim |
| `backend/src/services/shared/cache.service.ts` | helper | imported broadly across live services | include verbatim |
| `backend/src/services/watchlist/watchlist.service.ts` | helper | imported by `watchlist.routes.ts` | include verbatim |

### Section D — Jobs, repositories, types, config — 12 rows

| File | Category | Reachability evidence | Triage decision |
|---|---|---|---|
| `backend/src/config/env.ts` | config | imported by `server.ts` + `app.ts` | include verbatim |
| `backend/src/jobs/dailyiq.job.ts` | helper | imported by `server.ts` | include verbatim |
| `backend/src/jobs/portfolioReprice.job.ts` | helper | imported by `server.ts` | include verbatim |
| `backend/src/jobs/priceAlertEvaluator.job.ts` | helper | imported by `server.ts` | include verbatim |
| `backend/src/repositories/alertPreferences.repository.ts` | helper | imported by `alerts.routes.ts` + job | include verbatim |
| `backend/src/repositories/dailyiq.repository.ts` | helper | imported by `dailyiq.routes.ts` | include verbatim |
| `backend/src/repositories/deviceToken.repository.ts` | helper | imported by `devices.routes.ts` + notifications | include verbatim |
| `backend/src/repositories/priceAlerts.repository.ts` | helper | imported by `alerts.routes.ts` + evaluator job | include verbatim |
| `backend/src/types/compiq.types.ts` | helper | imported by compiq service tree | include verbatim |
| `backend/src/types/playerScore.ts` | helper | imported by playerScore tree | include verbatim |
| `backend/src/types/portfolioiq.types.ts` | helper | imported by portfolioiq tree | include verbatim |
| `backend/tsconfig.json` | config | drives compilation → `dist/` (the deployed binary) | include verbatim |

### Section E — Tests — 2 rows

| File | Category | Reachability evidence | Triage decision | Notes |
|---|---|---|---|---|
| `backend/tests/compiqEstimate.test.ts` | test | tests live `compiqEstimate.service.ts` | include with note | 2 pre-existing failures known on `main`; carry-over expected, do not gate PR #2.5 |
| `backend/tests/compiqPricingAccuracy.test.ts` | test | tests live engine | include with note | New file; verify it runs green or quarantine before merge |

### Section F — Exclude (dead code in scope) — 9 rows

| File | Category | Reachability evidence | Triage decision |
|---|---|---|---|
| `backend/src/routes/compiq.ts` | dead-twin | zero importers of `./routes/compiq` (non-`.routes`) in any `.ts` file; live mount is `compiq.routes.ts` per `app.ts` L8 | exclude (dead-twin) |
| `backend/src/server - Copy.ts` | dead-twin | "- Copy" filename pattern; not imported | exclude (dead-twin) |
| `backend/src/middleware/errorHandler - Copy.ts` | dead-twin | "- Copy" pattern; live middleware is `errorHandler.ts` | exclude (dead-twin) |
| `backend/src/modules/compiq/models/comp.types - Copy.ts` | dead-twin | "- Copy" pattern; not imported | exclude (dead-twin) |
| `backend/src/modules/compiq/models/identity.types - Copy.ts` | dead-twin | "- Copy" pattern; live sibling in closure | exclude (dead-twin) |
| `backend/src/modules/compiq/models/intelligence.types - Copy.ts` | dead-twin | "- Copy" pattern; not imported | exclude (dead-twin) |
| `backend/src/modules/compiq/models/observability.types - Copy.ts` | dead-twin | "- Copy" pattern; live sibling in closure | exclude (dead-twin) |
| `backend/src/modules/compiq/models/pricing.types - Copy.ts` | dead-twin | "- Copy" pattern; live sibling in closure | exclude (dead-twin) |
| `backend/src/services/compiqService.ts` | dead-twin | zero references anywhere; orphan from earlier refactor | exclude (dead-twin) |

## 6. PR #2.5 Scope Summary

**Arithmetic:** Section A (9) + Section B (16) + Section C (21) + Section D (12) + Section E (2) = **60 files**.

Cross-check: 69 diff files − 9 dead-twin excludes = 60. ✓

**PR #2.5 will commit 60 files to `main`: 57 live source files + 2 test files + 1 `tsconfig.json` + 1 `.gitignore` modification.**

(57 src/.ts breakdown: 9 from A + 16 from B + 21 from C + 11 from D = 57. Section D's 12 = 11 src/.ts + 1 tsconfig.json.)

## 7. Followup Queue

1. **Dead-JS-tree cleanup** — delete 28 files at `backend/server.js`, `backend/routes/*.js`, `backend/services/*.js` (proven absent on deployed wwwroot).
2. **Dead-twin route cleanup** — delete 9 files: `backend/src/routes/compiq.ts`, `backend/src/routes/dailyiq.ts`, `backend/src/routes/playeriq.ts`, the five `* - Copy.ts` files, and `backend/src/services/compiqService.ts`.
3. **Deploy pipeline lockdown** — restrict deploys to `origin/main` HEAD + tagged commits; prevent another unpushed-but-deployed drift.
4. **Env-var doc hygiene** — `.gitignore` decision in PR #2.5: ignoring the literal filename `backend/azure-app-env-vars.txt` (precise, low blast radius) rather than a wildcard `*env-vars*.txt` (could catch legitimate future docs). Documented in the PR description.

## 8. Smell-Clean Confirmation (for `include verbatim` files)

- **`debugger;` / `.only(` / `.skip(`** anywhere in scope: **zero**.
- **`FLAG/ENABLE/DISABLE` comments** were individually inspected (12 hits across 9 files); all are legitimate documentation explaining real env flags or behavior. No commented-out feature toggles.
- **`console.*` density** matches existing `main` convention (no logger framework). Highest densities: `compiqEstimate.service.ts` 23, jobs ~12 each, `cardhedge.client.ts` 9, `playerScore.service.ts` 9 — all production telemetry, not debug leakage.
- **`TODO/FIXME/HACK`** in scope: 1 hit in `PricingPipeline.ts`. (3 additional hits in `modules/compiq/...` files are pre-existing on `main` and not in the PR #2.5 delta.)
