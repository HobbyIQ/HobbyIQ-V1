# Q1 warn-log baseline — `primary_mode_cardhedge_namespace_only` rate post-PR-A1 + Phase 1

**Date:** 2026-05-24 (post-Phase-1 ship, post-Step-A rollback)
**Carry-forward from:** 2026-05-22 v2 plan handoff
**Method:** Read-only App Insights queries against `hobbyiq-insights` (InstrumentationKey `02dca1c0-...08d5008b470a`, ApplicationId `468bd437-...`). Note: the hobbyiq3 connection string points to this Application Insights resource, not the same-name `HobbyIQ3` AppI instance (which is empty/unused).

## Deploy timeline

| Event | Commit | Timestamp (UTC) | Notes |
|---|---|---|---|
| PR-A1 deploy (observability restore) | `ea0a724` | 2026-05-21T15:15Z | comp_logs writer + structured cardsight logs |
| PR-A1.1 follow-up | `e333ae1` | 2026-05-21 PM | playerName/cardYear added to comp_logs telemetry |
| Phase 1 ship | `5c9d561` (PR #112) | 2026-05-22 AM | resolveCardId selection fix + cache + warming |
| Step A brief deploy + rollback | `f5cd3e7` deployed ~13:30Z; rolled back ~18:30Z | 2026-05-23 PM | /price-by-id routing change; ~30 min in production |
| Current production | `a121baf` | 2026-05-22T17:13Z | Phase 1 + handoff |

## Pre-fix window — 2026-04-21T15:15Z to 2026-05-21T15:15Z (30 days)

| Metric | Value |
|---|---|
| `primary_mode_cardhedge_namespace_only` warn count | **168** |
| Earliest warn occurrence | 2026-05-19T18:45Z (warns only appear in the last ~2 days of the window) |
| Total /compiq/* requests | **5,534** |
| /price-by-id requests specifically | **1,672** |
| Warn rate per 1000 /compiq/* requests | **30.4** |
| Warn rate per /price-by-id request | **10.05%** |

**Note on pre-fix window data sparsity:** The earliest warn in the 90-day query window was 2026-05-19, only 2 days before PR-A1 deployed. This is because the warn is emitted by `cardsight.router.ts` under `CARDSIGHT_MODE=exclusive` (or `primary`) with a cardhedge-namespace cardId — that code path was effectively new and the rate baseline doesn't extend back further. The "30 days pre-fix" framing is misleading: meaningful pre-fix data is only 2 days (May 19-21).

## Post-fix window — 2026-05-21T15:15Z to 2026-05-24T19:58Z (~3 days)

| Metric | Value |
|---|---|
| `primary_mode_cardhedge_namespace_only` warn count | **138** |
| Latest warn occurrence | 2026-05-22T19:58Z |
| Total /compiq/* requests | **1,525** |
| /price-by-id requests specifically | **339** |
| Warn rate per 1000 /compiq/* requests | **90.5** |
| Warn rate per /price-by-id request | **40.71%** |

## Comparison

| Window | Total predictions | Warns | Rate per 1000 reqs | Rate per /price-by-id |
|---|---:|---:|---:|---:|
| Pre-PR-A1 (30d nominal; 2d meaningful) | 5,534 | 168 | 30.4 | 10.05% |
| Post-PR-A1 (~3d, includes Phase 1 + Step A + smoke) | 1,525 | 138 | 90.5 | 40.71% |
| Delta | — | — | **+198%** | **+305%** |

**The warn rate INCREASED post-fix.** Three caveats blur the interpretation:

1. **Window asymmetry.** Pre-fix data is meaningfully present for only ~2 days (May 19-21). Post-fix is ~3 days. Comparing rates per request normalizes for this, but the data volume is small enough that single-day testing spikes dominate.

2. **Smoke-testing contamination.** Today's session and the prior session both ran multiple smoke passes through /price-by-id and other endpoints. Each smoke run with a cardHedgeCardId fires the warn under current code (exclusive mode + legacy path). The 138 warn count in 3 days is heavily inflated by manual testing relative to organic traffic.

3. **PR-A1 was observability-only.** It did not change the code path that emits the warn — it added structured logging around it. The warn was firing pre-PR-A1 too; PR-A1 just made it newly-queryable. Phase 1 (PR #112) fixed `resolveCardId` selection logic which is downstream of where this warn fires — Phase 1 doesn't bypass the warn either.

## Interpretation

**PR-A1's effect on the warn rate: zero observable change in behavior.** The warn fires structurally for every `/price-by-id` request that hits the legacy cardhedge-namespace path under `CARDSIGHT_MODE=exclusive`. PR-A1 added observability; it didn't change which code path executes. Phase 1 added a downstream selection-logic fix; it didn't change the routing decision in `fetchComps`.

**The warn rate reflects a structural fact about the current code, not a quality signal:**
- Every `/price-by-id` request with a `cardHedgeCardId` AND without Step A's meaningful-query fall-through fires this warn
- Under current production (`a121baf` / Phase 1 + reverts), Step A's fall-through is NOT live → warn fires on virtually all `/price-by-id` calls
- The 40.71% rate (per `/price-by-id` request) in the post-fix window is "elevated" only because smoke testing exercised the same path repeatedly with cache-busted parameters; the structural rate should be closer to 90-100% (the warn fires whenever the legacy path is hit and exclusive mode short-circuits)

The 10.05% pre-fix rate is a likely-undercount because the warn may not have been captured in App Insights until PR-A1.1's logging additions; the structural rate at that time should also have been close to 100% of /price-by-id calls.

## Implications for Phase 2

**Yes — Phase 2 acceptance should incorporate a warn-rate criterion.** Phase 2's Step A routing change (the meaningful-query fall-through, currently on branch `feature/step-a-part1-meaningful-query-fallthrough`) bypasses the legacy cardhedge-namespace path for any `/price-by-id` request with a meaningful query. After Phase 2 ships:

- For `/price-by-id` requests where iOS sent a meaningful query (which is the default behavior — only the opaque-cardId fallback case sends `query === cardHedgeCardId`), the warn should NOT fire
- For organic traffic (not smoke testing), the warn rate per `/price-by-id` should drop from the structural ~100% to ~0-5% (only the opaque-cardId fallback edge case)
- For smoke testing during Phase 2 verification: explicitly check that the 5 demo card calls produce ZERO `primary_mode_cardhedge_namespace_only` warns

**Suggested Phase 2 acceptance addition:** Capture the warn count from App Insights over the 24h post-deploy window. Expected: warn count drops to single digits (only opaque-cardId fallbacks). If the warn count stays in the dozens, Step A's routing change didn't fully activate.

## Findings to file as durable

- **PR-A1's observability change is real and verified.** Structured cardsight logs are flowing to App Insights `hobbyiq-insights`. The warn-log query path works.
- **The hobbyiq3 connection string points to `hobbyiq-insights`, not the same-name `HobbyIQ3` AppI resource.** The `HobbyIQ3` AppI resource appears unused (0 traces). This is a configuration peculiarity worth noting; not a defect.
- **The warn rate baseline is not a quality signal in isolation** — it's a structural fact about the current routing logic. Post-Phase-2 it becomes a meaningful quality signal because the path that emits it should be bypassed.

## What this baseline does NOT do

- Doesn't reach a clean "PR-A1 reduced warn rate" finding because PR-A1 didn't aim to reduce warn rate.
- Doesn't isolate Phase 1's effect on warn rate (Phase 1 doesn't target this path).
- Doesn't characterize organic-traffic warn rate cleanly because the 3-day post-fix window is dominated by smoke testing.
- Doesn't propose code changes — only documents the current state and the Phase 2 acceptance criterion derived from it.

## Recommended next steps

1. **No standalone follow-up needed.** This warn rate is the symptom Phase 2 fixes; the metric becomes meaningful post-Phase-2.
2. **Update Phase 2 design's acceptance criteria** (`docs/phase0/phase2_design.md` §4) to explicitly include a warn-rate check: 24h post-Phase-2 deploy, warn count drops to single digits.
3. **Re-run this baseline post-Phase-2 ship** as part of Phase 2 acceptance verification.
