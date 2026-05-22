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
