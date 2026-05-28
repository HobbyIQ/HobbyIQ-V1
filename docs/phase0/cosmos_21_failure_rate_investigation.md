# Cosmos `hobbyiq-comps-centralus` 21% failure-rate investigation

**Date:** 2026-05-24
**Carry-forward from:** 2026-05-21 Phase 0 Finding 4 (`hobbyiq-comps-centralus` regional endpoint at 21% failure rate). W2 (`finding_cosmos_key_shared_auth.md`, commit `000b777`) ruled out the `COSMOS_KEY` stale-key defect as the explanation. This document characterizes the actual cause.
**Method:** Read-only App Insights queries against `hobbyiq-insights` (the AppI resource hobbyiq3's connection string points to). No code, no env changes.

## Conclusion (TL;DR)

**(A) Pattern matches one hypothesis cleanly.** Not regional routing, not throttling, not COSMOS_KEY. The 22.6% failure rate is a **payload-level defect on `player_trends` upserts**: 97% of all Cosmos failures are HTTP 400 (Bad Request) on `POST /dbs/hobbyiq/colls/player_trends/docs`. The defect is fire-and-forget at the application layer (caller is `upsertPlayerScore` in [playerScore.service.ts:297-322](../../backend/src/services/playerScore/playerScore.service.ts#L297-L322), which swallows errors via try/catch + console.warn) — so the failures don't surface to users, but they generate a steady stream of 400-Bad-Request dependency calls that look like a "21% endpoint failure rate" in App Insights.

**The original "regional-routing / geo-replication" hypothesis is INCORRECT.** Cosmos is healthy; the regional endpoint is healthy. The failure is on our side (malformed document being upserted).

## Reconfirmed failure rate

Over the last 30 days against `hobbyiq-insights` App Insights `dependencies` table:

| Target endpoint | Total calls | Failed | Failure rate |
|---|---:|---:|---:|
| `hobbyiq-comps-centralus.documents.azure.com` (regional) | 177,588 | 40,171 | **22.6%** |
| `hobbyiq-comps.documents.azure.com` (non-regional, same account) | 49,241 | 0 | **0%** |

**Original rate (May 21): 21%. Current rate: 22.6%.** Within noise — rate has been stable, slight uptick of ~1.6 percentage points. **No substantive change since May 21.**

**The non-regional endpoint has zero failures.** Same Cosmos account, different DNS path. This refutes both the "Cosmos account unhealthy" hypothesis and the "regional-routing" hypothesis — the regional endpoint is the one used for writes; the non-regional one is used for different operations (likely reads via DefaultAzureCredential resolution). Cosmos is fine; the regional endpoint isn't faulty either — it's just the one our writes go through.

## Pattern characterization

### Failure code distribution (30d, regional endpoint)

| HTTP code | Count | % of failures |
|---|---:|---:|
| **400 (Bad Request)** | **39,017** | **97.1%** |
| 429 (Too Many Requests / Throttled) | 759 | 1.9% |
| 404 (Not Found) | 387 | 1.0% |
| 409 (Conflict) | 5 | 0.0% |
| 0 (network/timeout) | 3 | 0.0% |

**Throttling hypothesis: REJECTED.** Only 1.9% of failures are 429. A throttled system would show 429-dominant patterns.

**Network/region hypothesis: REJECTED.** Only 3 of 40,171 failures are code 0 (network). Both regional and non-regional endpoints answer; the regional just gets sent malformed payloads.

### Failed operation distribution (30d, regional endpoint)

| Operation | Failed count | % of all failures |
|---|---:|---:|
| `POST /dbs/hobbyiq/colls/player_trends/docs` | **39,397** | **98.1%** |
| `POST /dbs/hobbyiq/colls/portfolio/docs` | 105 | 0.3% |
| `POST /dbs/hobbyiq/colls/dailyiq_briefs/docs` | 98 | 0.2% |
| `GET /dbs/hobbyiq/colls/dailyiq_briefs/docs/2026-05-11` | 80 | 0.2% |
| `POST /dbs/hobbyiq/colls/comp_logs/docs` | 65 | 0.2% |
| (other collections, small counts) | <100 each | <0.3% each |

**98.1% of failures are a single operation: `POST player_trends/docs`.** Other collections (including `comp_logs` which the original finding misattributed) have minimal failures.

### Temporal pattern — steady, not bursty

Hourly breakdown on the worst day (2026-05-12, 78,897 calls / 22% failure):

```
01:00 — 85 calls, 0% failed
02:00 — 6,312 calls, 24.4% failed
03:00 — 1,929 calls, 24.4% failed
07:00 — 1,074 calls, 25.1% failed
08:00 — 9,848 calls, 24.8% failed
12:00 — 5,579 calls, 25.2% failed
13:00 — 8,215 calls, 24.9% failed
14:00 — 11,544 calls, 24.8% failed
15:00 — 2,936 calls, 24.0% failed
16:00 — 2,902 calls, 24.0% failed
17:00 — 1,790 calls, 23.1% failed
18:00 — 1,995 calls, 23.4% failed
19:00 — 4,315 calls, 23.7% failed
20:00 — 6,510 calls, 23.8% failed
21:00 — 4,807 calls, 23.8% failed
22:00 — 515 calls, 22.9% failed
23:00 — 503 calls, 23.3% failed
```

Failure rate is **consistently ~24-25%** across the day, independent of volume. Not bursty, not periodic, not correlated with traffic peaks. This is a deterministic-per-payload defect: roughly 1 in 4 player_trends upserts produces an invalid document.

### Daily variation correlates with WHICH players are scored, not VOLUME

```
May 22: 5,882 calls, 11.2%
May 21: 4,179 calls, 8.1%
May 20: 15,004 calls, 16.5%
May 19: 7,947 calls, 15.0%
May 18: 2,838 calls, 0.0%   ← anomaly
May 17: 46,340 calls, 23.0%
May 16: 4,398 calls, 11.9%
May 15: 9,928 calls, 17.6%
May 14: 14,942 calls, 7.4%
May 13: 28,480 calls, 14.3%
May 12: 78,897 calls, 21.9%  ← high day
May 11: 2,770 calls, 1.4%
May 10: 1,580 calls, 0.0%
May 9:  1,039 calls, 0.0%
May 8:  1,341 calls, 5.0%
```

Failure rate is NOT proportional to volume. The May 18 and May 10-11 zero-failure days had low traffic; the May 12 high-traffic day was at 22%. This suggests the malformed-payload trigger depends on **which player IDs are being upserted**, not the volume. Days that score "problem players" (whatever the malformed-payload trigger is) fail at ~25%; days that happen to score only "clean players" don't.

## Hypothesis evaluation

| Hypothesis | Predicted pattern | Actual pattern | Match? |
|---|---|---|---|
| Regional routing | 5xx errors, network timeouts, periodic spikes | 400 Bad Request only, steady rate | ✗ |
| Throttling | 429 dominant, traffic-correlated | 97% are 400, not traffic-correlated | ✗ |
| Network transient | Result code 0, sporadic | 3 total code-0 errors | ✗ |
| COSMOS_KEY stale auth | 401 Unauthorized, all-or-nothing | No 401s observed | ✗ (already ruled out by W2) |
| Container config (indexing/partition) | All ops to that container fail | Only POST upserts fail; reads succeed | ✗ |
| **Payload-level defect (specific player data triggers Cosmos validation rejection)** | **400 Bad Request, deterministic per-payload, correlated with player ID set being scored** | **✓ matches all observed signals** | **✓ MATCH** |

## Source code identification

Writer: [backend/src/services/playerScore/playerScore.service.ts:297-322](../../backend/src/services/playerScore/playerScore.service.ts#L297-L322)

```typescript
export async function upsertPlayerScore(score: PlayerScore): Promise<void> {
  try {
    await initContainers();
    if (!trendsContainer) return;
    await trendsContainer.items.upsert(score);   // ← fails 400 ~25% of calls
  } catch (err) {
    console.warn("[playerScore] upsert failed:", (err as Error).message);
    return;
  }
  // ... fire-and-forget history write to player_trend_history ...
}
```

Called fire-and-forget on every estimate (per the module's header comment line 7). Error is logged-and-swallowed; the application continues regardless. This is why the 22.6% failure rate has been invisible to user-facing behavior — Cosmos rejects 25% of writes, the service shrugs and moves on.

**The malformed-payload defect is in whatever `PlayerScore` document is being upserted.** Candidates for the 400-triggering field:
- `NaN` numeric values (Cosmos rejects NaN in numeric fields)
- Missing required fields (`id`, partition-key `playerId`)
- Invalid characters in id (Cosmos requires id-safe characters)
- `null` values where a typed field expects a primitive
- Score documents exceeding Cosmos's 2 MB limit (unlikely for a score record)

Characterizing the exact field requires either (a) reading the [PlayerScore type and producer logic](../../backend/src/services/playerScore/playerScore.service.ts) end-to-end, or (b) capturing one of the 39k failure events with `customDimensions` for the error message body. Both are out of scope for this read-only diagnostic.

## Implications

### What this means for production

- **No user-facing impact.** The error is fire-and-forget at the app layer; failed player_trends writes mean the player score history is sparse, not that requests fail.
- **Real cost: PlayerIQ score chart has 25% gaps.** The "fire-and-forget history write to `player_trend_history`" at line 308-321 also writes to the regional endpoint and presumably fails for the same payloads. PlayerIQView's score chart will have data gaps that don't propagate as user errors but degrade chart quality.
- **App Insights noise.** 40k failed dependencies per 30d clutters the dashboard and makes legitimate Cosmos issues harder to spot.
- **Cosmos billing.** Each failed write still consumes RU/s (failed writes are not free). 39k failed writes per 30d represents ongoing wasted RU.

### What this means for the original "regional-routing" framing

**The framing was wrong.** The 21% finding from May 21 (Phase 0 Finding 4) was correctly observed at the dependency endpoint level (`hobbyiq-comps-centralus` shows 22.6% failure), but the inferred cause (regional routing / geo-replication) was speculative. Cosmos and its regional endpoint are both healthy. We were generating bad payloads.

The W2 diagnostic (`000b777`) was correct to rule out COSMOS_KEY as the cause. The "needs its own focused diagnostic" carry-forward from W2 is now resolved.

## Recommended priority for follow-up

**Medium priority.** Real defect, no user-facing impact, but worth fixing because:

1. PlayerIQ score chart quality is degraded by ~25% (the history-write failure mode mirrors the score-write failure mode for the same payloads).
2. Wasted Cosmos RU/s on failed writes.
3. Observability noise — 40k failed dependencies obscure real Cosmos health signals.

**Suggested next workstream:** Focused 30-min read-only investigation to identify the specific field in PlayerScore that fails validation. Inspect [playerScore.service.ts](../../backend/src/services/playerScore/playerScore.service.ts) computeScore / score-assembly logic for fields that could produce NaN, undefined, or empty-string values where Cosmos expects primitives. Most likely candidates:
- `confidence` fields (from `overallConfidence(...)`) — could produce NaN if both inputs are NaN
- `marketScore.value` / `marketScore.confidence` — populated by a `computeMarketScore` that may produce NaN with zero comps
- `playerId` — partition key; must be non-empty and id-safe
- `updatedAt` — ISO timestamp; should always be valid

If a specific bad-field hypothesis emerges, a tiny defensive guard (`if (Number.isNaN(score.someField)) return`) in `upsertPlayerScore` would eliminate the 25% failure rate.

**Not blocking Phase 2.** This defect is in a separate code path (PlayerScore writes are independent of the CompIQ pricing chain Phase 2 targets). Can be queued for a focused session after Phase 2 ships.

## Findings durable

1. **22.6% Cosmos endpoint failure rate is reconfirmed.** Stable since May 21.
2. **The original framing ("regional routing / geo-replication") is incorrect.** Cosmos is healthy.
3. **97% of failures are HTTP 400 Bad Request on player_trends upserts.** Single collection, single operation.
4. **Pattern is deterministic per payload, not bursty or temporal.** ~25% of player_trends documents being upserted fail Cosmos validation.
5. **Error is silently swallowed at the app layer** — no user-facing impact, but 40k wasted RU and PlayerIQ chart data gaps per 30d.
6. **Recommended fix scope: small.** One defensive guard in `upsertPlayerScore` after identifying the malformed field. Out of scope for this diagnostic.

---

## Re-investigation 2026-05-26 — hypothesis (C) inversion

**Status:** The "upsert failure" framing in the durable findings above (items 3, 4, and the fix recommendation in item 6) **was wrong**. PR #113 shipped a defensive guard for `upsertPlayerScore` based on it (OUTCOME C — guard correct, but didn't address the real rate). Today's read-only diagnostic re-investigated and inverted the hypothesis.

### What this re-investigation found

**1. Only ONE writer exists to the `player_trends` container.**

Inventoried every `items.upsert` and `items.create` call in `backend/src/`. The only writer to `player_trends` is [`upsertPlayerScore` at `playerScore.service.ts:361`](../../backend/src/services/playerScore/playerScore.service.ts#L361). PR #113's `isValidCosmosId` guard (lines 344-356) already gates it. No alternate writer found. The "alternate writer hypothesis" from PR #113 OUTCOME C handoff is **ruled out**.

**2. DailyIQ doesn't write to `player_trends` — it reads via cross-partition query.**

The 2026-05-24 PM diagnostic attributed 33% of `POST player_trends/docs` failures to DailyIQ endpoints (vs 0% from CompIQ). But DailyIQ has no `upsertPlayerScore` calls. What it does have is [`enrichWithPlayerIQ` at `dailyiq.routes.ts:46-67`](../../backend/src/routes/dailyiq.routes.ts#L46-L67), which calls [`getPlayerScoreByName`](../../backend/src/services/playerScore/playerScore.service.ts#L413-L428) for every player in a brief response. That function issues:

```typescript
await trendsContainer.items
  .query<PlayerScore>({
    query: 'SELECT TOP 1 * FROM c WHERE LOWER(c["playerName"]) = @name',
    parameters: [{ name: "@name", value: playerName.trim().toLowerCase() }],
  })
  .fetchAll();
```

This is a **cross-partition Cosmos query** (no partition key — the container is partitioned by `/playerId`, not `/playerName`). The Cosmos SDK issues queries as **HTTP `POST /dbs/hobbyiq/colls/player_trends/docs`** — the **same URL pattern as upserts**.

**3. App Insights' dependency `name` field doesn't distinguish queries from upserts.**

Both `items.upsert(doc)` and `items.query({...}).fetchAll()` produce dependency entries named `POST /dbs/hobbyiq/colls/player_trends/docs`. The prior diagnostic interpreted these as upserts; that interpretation was incorrect.

### The actual likely cause

**The "22-27% upsert failure rate" was almost certainly cross-partition query failures from `getPlayerScoreByName`.** Evidence:

- Only one writer exists (rules out alternate writer)
- DailyIQ doesn't write but DOES query cross-partition; DailyIQ attributed 33% of failures
- Zero `[playerScore] upsert failed:` traces in App Insights at any point in prior or current diagnostics — consistent with NO actual upsert failures (the catch block in `upsertPlayerScore` is never reached because upserts succeed)
- App Insights groups query POST and upsert POST under the same dependency name; failure rate quoted in earlier diagnostic was the SUM of both, not exclusively upserts

The query failure mode is consistent with Cosmos cross-partition query behavior on certain inputs:
- Cross-partition queries fan out to every partition; any partition's failure can return 400 to the client
- `LOWER(c["playerName"])` on documents where `playerName` is missing/null could produce 400 in some Cosmos engine versions
- Inputs that produce unusual SQL escaping behavior

### Why we can't verify this today (or fix it cleanly)

**Two data-availability blockers:**

- **Zero DailyIQ traffic in last 7 days.** App Insights `requests` table shows no `/api/dailyiq/*` requests across the entire retention window. Without traffic, the query-failure pattern can't be reproduced in real-time.
- **App Insights dependency retention is short (~1 hour observed).** Total dependencies in retention window: 104 entries spanning ~1h. The 30-day historical data from 2026-05-22's diagnostic that showed 177,588 calls / 40,171 failed is no longer queryable. We can't go back and re-classify the prior failures as queries vs upserts directly.

### Fix surface (when traffic resumes)

Three options in `getPlayerScoreByName`:

1. **Provide a partition key.** Derive `playerId` from `playerNameSlug(playerName)` and pass `{ partitionKey: playerId }` to the query options. Single-partition query; eliminates the cross-partition fan-out failure mode. ~5 LOC + slug-equivalence test.
2. **Switch to point-read.** If the document id is deterministic from playerName (e.g., `playerNameSlug(playerName)`), use `container.item(id, playerId).read()` instead of `items.query(...)`. Faster (sub-100ms vs ~1s for query), no cross-partition fanout, no 400 failure mode. ~10 LOC.
3. **Improve error logging first.** Add `console.warn("[playerScore] getByName failed:", err)` to the catch block (it already exists at line 425) and add a structured `playerScore_getByName_failed` event with the player name + Cosmos error body, so future failures produce queryable traces. ~5 LOC. Diagnostic-only.

Recommended sequence when DailyIQ traffic resumes:
- Land option (3) first (instrumentation), wait one DailyIQ-active cycle, confirm the rate is what we suspect
- Then land option (1) or (2) (the fix), confirm rate drops to near-zero post-deploy

### Why we're not shipping today

- **No traffic to verify against.** Even if option (1)/(2) is correct and zero-risk, we can't measure before/after impact without DailyIQ requests hitting the path
- **Short App Insights retention** limits any verification window to ~1h post-deploy
- **PR #113 stays in production as defensive coverage of a non-problem.** It doesn't hurt anything (defensive guards on edge-case input are rarely harmful), and removing it would be additional code churn. Document scope: it defends against empty/oversized/special-char `id` values that `playerNameSlug` could theoretically produce; this defense is correct but NOT the fix for the historical 22-27% rate

### What PR #113 actually addresses (vs what we thought)

| Aspect | What we thought 2026-05-22 | What re-investigation confirms |
|---|---|---|
| Failure mode | Upsert returning 400 due to bad `id` / `playerId` field | Cross-partition query returning 400 (likely) |
| PR #113's effect on 22-27% rate | Should drop rate toward 0% | No effect — guards a different code path |
| PR #113's correctness | Correct guard for stated problem | Correct guard for an edge case that may or may not occur; doesn't hurt; doesn't fix the historical rate |
| Real fix location | `upsertPlayerScore` document validation | `getPlayerScoreByName` partition-key / point-read |

PR #113 stays merged. It defends against a real edge case (empty/malformed Cosmos IDs in upserts) even if that edge case isn't what produced the 22-27% rate. Remove later only if the defensive guard becomes load-bearing for something else's removal — not worth churn otherwise.

### Re-characterized carry-forward

**Was:** "Cosmos 22-27% real cause — alternate writer hypothesis from PR #113."

**Now:** "`getPlayerScoreByName` cross-partition query optimization, deferred until DailyIQ traffic resumes." Trigger to revisit:

- iOS launch produces organic DailyIQ traffic, OR
- Scheduled DailyIQ refresh job activated, OR
- Synthetic DailyIQ traffic generated to reproduce the failure pattern

Recommended next-session work for this defect: option (3) instrumentation + option (1) or (2) fix in two PRs, with App Insights observation cycle between them. NOT before traffic exists to verify against.

### Findings durable (updated 2026-05-26)

7. **Only ONE writer to `player_trends`** — `upsertPlayerScore` at `playerScore.service.ts:361`. No alternate writer.
8. **DailyIQ reads `player_trends` via cross-partition query** (`getPlayerScoreByName`). The 2026-05-24 diagnostic's "33% DailyIQ-path failure" is almost certainly query failures, not upsert failures.
9. **App Insights dependency `POST player_trends/docs` is ambiguous** — both queries and upserts hit this URL. Future diagnostics need to disambiguate (e.g., by adding structured logs around each writer/reader).
10. **App Insights dependency retention is ~1 hour for this AppI instance.** Historical 30-day failure-rate analysis is not currently possible. Worth investigating retention/sampling config before relying on dependency-table analysis for future diagnostics.
11. **PR #113 stays in production as defensive guard for a non-problem.** It doesn't address the 22-27% rate; that rate is in `getPlayerScoreByName` query path.

---

## Re-investigation 2026-05-28 — empirical re-check, inversion CONFIRMED, deferral INCORRECT

**Date:** 2026-05-28
**Context:** Triggered during the roadmap-refresh W1 polish sprint, after the refreshed roadmap (`746a023`) propagated the original 2026-05-24 upsert-defect framing without picking up the 2026-05-26 inversion appended above. CF author paused before code, ran an empirical re-check against App Insights (per the "intermittent → it's data/load-dependent" reasoning the 2026-05-26 inversion already established), and inverted the deferral decision based on current state.

**Method:** Read-only App Insights queries via `az monitor app-insights query` against `hobbyiq-insights` (appId `468bd437-5d16-47b4-90fb-5ee5d41726ae`). No code, no env changes.

### Current empirical state — last 72h, all dependency calls to `hobbyiq-comps-centralus`

| Container/op | Total | 200 | 201 | 400 | Failure % |
|---|---:|---:|---:|---:|---:|
| `player_trends/docs` | 457 | 313 | 0 | 144 | **31.5%** |
| `player_trends/pkranges` | 144 | 144 | 0 | 0 | 0% |
| `comp_logs/docs` | 256 | 200 | 56 | 0 | 0% |
| `trend_history/docs` | 25 | 16 | 9 | 0 | 0% |
| 11 smaller endpoints | small N | — | — | 0 | 0% |

**Failure rate sustained.** The 22.6% from 2026-05-24 / 24.4% pattern from 2026-05-12 (worst day) is now 31.5% — slightly worse, in the same regime. Cardsight + other writes are clean. Failures are localized to `player_trends`.

### Smoking-gun pattern — `pkranges` count alignment

`pkranges` is the partition-range lookup the Cosmos SDK fires once before each cross-partition query (to know which partitions to fan out to). 144 successful pkranges calls aligns numerically with 144 HTTP 400 failures on `player_trends/docs`. This is the SDK signature of cross-partition queries firing and failing — strong empirical confirmation that the 144 failures ARE cross-partition queries, not upserts.

### Per-operation breakdown of `player_trends/docs` (last 72h)

| Request endpoint | Total | 400 | 200 | Failure % |
|---|---:|---:|---:|---:|
| `GET /api/dailyiq/brief` | 299 | 94 | 205 | 31.4% |
| `GET /api/dailyiq/players/top/milb` | 75 | 25 | 50 | 33.3% |
| `GET /api/dailyiq/players/top/mlb` | 75 | 25 | 50 | 33.3% |
| `(background — no operation)` | 4 | 0 | 4 | 0% |
| `POST /api/compiq/price-by-id` | 2 | 0 | 2 | 0% |
| `POST /api/compiq/search` | 2 | 0 | 2 | 0% |

**98.3% of `player_trends/docs` traffic originates from DailyIQ endpoints. 100% of the 400 failures come from DailyIQ paths.** The compiq paths (price-by-id, search) generate 4 upsert writes, all successful. The "" empty-operation rows are background traffic (also clean).

### Code-side confirmation

- `getPlayerScoreByName` ([playerScore.service.ts:413-428](../../backend/src/services/playerScore/playerScore.service.ts#L413-L428)) — cross-partition `SELECT TOP 1 * FROM c WHERE LOWER(c["playerName"]) = @name`. Partition key is `playerId`, so any query that doesn't filter on `playerId` is cross-partition. Called from `dailyiq.routes.ts:52` (inside `/api/dailyiq/brief` per-player loop) and `playeriq.routes.ts:61`/`:115`.
- `getTopPlayersByScore` ([playerScore.service.ts:431-450](../../backend/src/services/playerScore/playerScore.service.ts#L431-L450)) — cross-partition `SELECT TOP N * FROM c [WHERE direction] ORDER BY playerIQScore DESC`. Called from `/api/dailyiq/players/top/{milb,mlb}` (per the App Insights operation breakdown above).
- Both functions catch errors and return `null` / `[]` silently (`console.warn` only). The 32% failure rate IS user-facing as missing/sparse data on DailyIQ surfaces, not a server error.

### Inversion: confirmed. Deferral: incorrect.

**Confirmed:** The 2026-05-26 hypothesis inversion (from "upsert defect" to "cross-partition query issue") is empirically confirmed by:
- pkranges count alignment (144 pkranges = 144 query failures)
- Per-operation breakdown (100% of failures from cross-partition query callers)
- Upsert path empirical health (compiq endpoints, which write via `upsertPlayerScore`, show 0 failures in this window)
- "Zero `[playerScore] upsert failed:` traces ever observed" carry-forward from 2026-05-26 remains true today

**Incorrect:** The 2026-05-26 inversion's "deferred until DailyIQ traffic resumes" framing assumed traffic was zero at the time. Whether or not that was true then, **DailyIQ traffic is non-zero now**: 449 DailyIQ-path Cosmos query calls over a 24h window, organic from production usage. The deferral's precondition is no longer satisfied — there is present traffic, a present failure rate, and present user-facing impact.

### Re-characterized carry-forward (2026-05-28)

**Was (2026-05-26):** "`getPlayerScoreByName` cross-partition query optimization, deferred until DailyIQ traffic resumes."

**Now (2026-05-28):** **CF-PLAYERTRENDS-QUERY-FAILURE — ACTIVE in W1 polish sprint of the 2026-05-28 refreshed roadmap. ~4-8h investigation, read-only first, gated on capturing the actual Cosmos 400 response body before any fix.**

The 400 response body is the highest-value missing artifact. The SDK swallow at `playerScore.service.ts:425` discards it. Both `dailyiq.routes.ts:52` and the upsert path produce identical-looking `POST .../docs` dependency-table entries in App Insights — the body (response payload of the 400) names the specific Cosmos sub-code or error and would resolve "intermittent at 32%" to a concrete cause.

### Intermittent-at-32% is the central clue

A flat config error (missing cross-partition flag, missing partition key, malformed query syntax) would fail 100% deterministically. 32% says the failure is **input-dependent or load-dependent**:

- Some player names cause encoding/length/special-char issues in `LOWER(c["playerName"]) = @name`
- Some result sets exceed a continuation-token / page-size threshold
- Specific RU-bursty queries hit a per-query plan path that 400s
- Some queries fan out to partitions in a state that rejects the cross-partition request

The 400 body should name which one. Don't propose a fix without it.

### Findings durable (updated 2026-05-28)

12. **DailyIQ traffic is non-zero in production** as of 2026-05-28: 449 cross-partition queries / 24h from `/api/dailyiq/brief` + `/api/dailyiq/players/top/{milb,mlb}`. The 2026-05-26 inversion's deferral was correct under its zero-traffic precondition; that precondition no longer holds.
13. **The 22.6% → 31.5% trajectory** suggests the failure rate is at minimum stable, possibly drifting upward as more player names enter the dataset (consistent with input-dependent hypothesis). Worth tracking post-fix.
14. **The 400 response body is the load-bearing missing artifact.** Until captured, all hypotheses about "why intermittent at 32%" are speculation. Step 3 of CF-PLAYERTRENDS-QUERY-FAILURE is to surface it (either by instrumenting the catch at `playerScore.service.ts:425` to log the full error, or by enabling Cosmos SDK diagnostic logging).
15. **Lesson from the framing-propagation incident:** When a Phase 0 investigation document has appended re-investigation sections, read end-to-end before propagating its findings into plan documents. The 2026-05-28 reconciliation + refresh both inherited the original head section's "upsert defect" framing without picking up the inversion in the appended section, and propagated it into Section 5 of the reconciliation + the verified-debt-state table + the Week 1 plan + the Risk Register of the refresh. The empirical-before-fix HALT gate caught it before code was written for a non-problem.

---

## Re-investigation 2026-05-28 PM — direct Cosmos diagnostic probe, classification A LOCKED, name-format bug surfaced

**Date:** 2026-05-28 PM (same day as the morning's empirical re-check, which inverted the deferral on the 2026-05-26 hypothesis)
**Context:** Morning re-check (above) confirmed the inversion (query failures, not upserts) and showed 32% rate on DailyIQ paths is current and material. Roadmap + reconciliation got "ACTIVE not deferred" corrections (`463b031`). Instrumentation patch deployed (`aa61097`). When synthetic traffic surfaced 514 application-layer successes alongside 514 dependency-layer 400s — the same query-count match — the structural ambiguity between (A) benign SDK chatter and (B) silently-broken partition with merged-result data loss had to be resolved directly. App-layer 0% failures is the precise signal the dangerous case (B) also produces, so could not close as benign on app-layer evidence alone.
**Method:** Direct ad-hoc Cosmos SDK diagnostic probe (`backend/scripts/playertrends-query-diag-adhoc.cjs`) connecting to prod Cosmos with prod credentials. Two independent decisive tests: (1) `readPartitionKeyRanges()` to count partitions, and (2) completeness check across 8 known players × 2 passes.

### Decisive test 1 — partition count

```
readPartitionKeyRanges → count: 1
  range: { id: "0", min: "", max: "FF", status: "online" }
```

**One partition.** This refutes any "3-partition fan-out" hypothesis structurally — there is no fan-out possible. The 3:1 dependency-row-to-logical-query ratio is SDK-internal protocol chatter (likely query-plan probe + actual query + metadata round-trip pattern). With one partition, the "broken partition" case is mechanically impossible: there is no other partition for the SDK to silently rely on.

### Decisive test 2 — completeness check

| Player | rowCount | Stored id | Score | Note |
|---|---:|---|---:|---|
| Mike Trout | 1 | 545361 | 45 | matched both passes (deterministic) |
| Greg Maddux | 1 | 118120 | 54 | matched both passes |
| Ken Griffey Jr. | 1 | 115135 | 52 | matched both passes |
| Caleb Bonemer | 1 | 815352 | 42 | matched both passes |
| Bobby Cox | 1 | 112764 | 67 | matched both passes |
| Bobby Witt Jr. | 0 | (see below) | n/a | **name-format mismatch — secondary finding** |
| John Gilbert | 0 | (not stored) | n/a | genuinely absent |
| Tommy White | 0 | (not stored) | n/a | genuinely absent |

5/8 known players returned their data deterministically across two passes. **No flapping. No silent drops.** All "rowCount=0" results were verified by either (a) name-format mismatch (Witt — see below) or (b) genuine absence (cards not yet scored).

### Classification (locked)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **A. Benign SDK chatter** | ✅ **CONFIRMED + LOCKED** | Single partition, all completeness checks pass, deterministic, no app errors, RU costs flat at ~3.0-3.13 per query |
| **B. Partition genuinely broken** | ❌ REFUTED — structurally impossible | Only 1 partition; the dangerous "merged result silently dropping data from broken partition" requires ≥2 partitions to occur |
| **C. Query edge case on `WHERE LOWER`** | ❌ REFUTED | All known players (queried with correct stored form) match correctly; pathological inputs (empty, single-char, unicode, uuid) all return cleanly without app-layer errors |

The 32% dependency-row 400 rate is **normal Cosmos SDK protocol chatter on a single-partition cross-partition query**. The application never sees the 400; the SDK absorbs it (likely as a recoverable query-plan-probe negative response). Zero data loss verified directly.

### Secondary finding — CF-PLAYERNAME-CANONICALIZATION (separately surfaced)

The completeness check itself surfaced the **actual** bug behind the morning's "silent nulls on DailyIQ" symptom framing:

```
Caller query: "Bobby Witt Jr."  (with period)     → rowCount=0  ← false miss
Stored form:  "Bobby Witt Jr"   (no period)        → rowCount=1  match id=677951
Caller: "Bobby Witt"            (no Jr.)           → rowCount=0  ← false miss
Caller: "BOBBY WITT JR"         (uppercase)        → rowCount=1  match id=677951 (LOWER() handles case)
```

Confirmed by direct query `SELECT c.id, c.playerName WHERE CONTAINS(LOWER(c.playerName), "witt")` → one row, `playerName: "Bobby Witt Jr"` (no trailing period). DailyIQ callers passing `"Bobby Witt Jr."` (with period — common MLB Stats / public-API format) get null silently because the `WHERE LOWER(c["playerName"]) = @name` exact-equality comparison misses on punctuation.

**This is a real DailyIQ-quality bug**, completely separate mechanism from the Cosmos 400 chatter. The morning's symptom framing ("silent nulls on DailyIQ degrading data quality") was **right about the symptom and wrong about the mechanism**. Filed forward as **CF-PLAYERNAME-CANONICALIZATION** with explicit Phase 1 scoping requirement (don't fix just Witt's period — enumerate the full mismatch surface including accents on show-relevant players like Acuña, Peña, Yoán).

### Why the 400 body was not captured (and why it doesn't matter)

The investigation also attempted to capture the actual Cosmos 400 response body via a `globalThis.fetch` wrapper (`backend/scripts/playertrends-fetch-wrap-adhoc.cjs`). Result: `depCallCount: 0`. The `@azure/cosmos` SDK uses its own HTTP layer via `@azure/core-rest-pipeline` (not `globalThis.fetch`), so the wrapper intercepted nothing. Capturing the body would require hooking `node:http`/`node:https` directly or implementing a custom Pipeline transform — additional 30-60min work.

Decision: **not pursued.** The body would explain the SDK MECHANISM behind the 400 but cannot move the LOCKED classification. Single partition + completeness verified are the structural and empirical proofs that the dangerous case is impossible. The body is mechanism-informative but classification-orthogonal.

### Findings durable (updated 2026-05-28 PM)

16. **`player_trends` container is single-partition** as of 2026-05-28. Partition key path `/playerId` is configured but Cosmos has only provisioned one physical partition under the current RU/storage profile. Cross-partition queries on this container still incur the SDK's query-plan / cross-partition protocol overhead (3:1 dependency-row ratio observed) even though there's only one partition to scan.

17. **32% dependency-row 400 rate is normal SDK chatter** for the JS Cosmos SDK doing cross-partition queries on a single-partition container. Application sees 0% failures; data is fully reachable; completeness verified. Not a defect to fix.

18. **Name-format mismatch on `getPlayerScoreByName`** is the actual DailyIQ-quality bug. Stored canonical form lacks trailing periods on suffixes (e.g., "Bobby Witt Jr" not "Bobby Witt Jr."); LOWER()-eq comparison misses punctuation differences. Filed as **CF-PLAYERNAME-CANONICALIZATION** with Phase 1 scoping requirement to enumerate the full mismatch surface (periods, accents, apostrophes, hyphens, suffix presence/absence, etc.).

19. **PR #113 stays in production** as defensive coverage of the id-validation edge case it was written for. Don't remove. Adds zero overhead at the failure path it guards (skip + return null when id invalid).

20. **Instrumentation patch (`aa61097`) stays in production** through the CF-PLAYERNAME-CANONICALIZATION verification cycle. The success/failure events on `getPlayerScoreByName` will confirm the canonicalization fix lands. Remove in a cleanup commit after that CF closes.

### Lesson — "no app errors" ≠ "no user impact"

The morning's `463b031` correction (and the matching cosmos appendix `4bfb043`) claimed "32% of DailyIQ player-score lookups return null silently, degrading the daily brief + top-players surfaces." That phrasing was based on inferring user impact from the dependency-aggregate 32% rate. The PM investigation revealed:

- The 32% is per-dependency-row, not per-application-query (refuted by 514 app-layer success events against 514 c400s)
- The SDK absorbs the 400s; application sees success
- BUT: silent nulls DO happen on DailyIQ — via a different mechanism (name-format mismatch)

The "0 app errors" signal is necessary but not sufficient to close a user-impact question. The completeness check (querying known data and verifying it returns) is what separated structural impossibility (single partition refutes B) from the actually-present name-format bug (silently misses on punctuation). **Pressing past "close as benign" surfaced the real bug.** Both findings — the Cosmos classification A and the name-format bug — required different empirical tests; neither alone would have closed the question.
