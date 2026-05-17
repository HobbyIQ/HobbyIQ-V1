## Neighbor-synthesis cleanup pass

Date: 2026-05-17

### Search inventory (with context)
Scope used for cleanup decisions:
- backend source: `backend/src/**/*.ts`
- backend tests: `backend/tests/**/*.ts`
- tier1 harness consumers: `backend/harness/**/*.ts`
- iOS consumer check: `**/*.swift` (workspace-wide)
- route/schema check: `backend/src/routes/**/*.{ts,json,yaml,yml}`

Notes on inventory scope:
- I excluded generated/runtime artifacts (`backend/dist/**`, logs, captured raw JSON snapshots, temp files) from cleanup edits.
- I also excluded historical investigation docs from edits to avoid rewriting evidence files.

#### Hits in live source (`backend/src`) and categorization

1. `backend/src/services/compiq/cardhedge.client.ts:592` — dead comment (safe)
```ts
// When CH has thin/stale comps for the user's target card, pull comps from
// OTHER parallels of the same player+year+set so the neighbor-synthesis
// engine can derive the target price via parallel multipliers
```

2. `backend/src/services/compiq/cardhedge.client.ts:675` — dead comment (safe)
```ts
// Synthesize a title that includes the sibling's variant so
// `parallelTierKey()` in neighborSynthesis can classify it.
```

3. `backend/src/services/compiq/neighborMultipliers.ts:69` — dead comment (safe)
```ts
// multipliers as the human labels so the neighbor-synthesis target
// doesn't end up "unclassifiable" purely because of the rename.
```

4. `backend/src/services/compiq/predictedRange.ts:13` — dead comment text (safe)
```ts
//   • Non-live source paths (neighbor-synthesis, no-recent-comps,
//     unsupported_sport, variant-mismatch) → predictedRange = null.
```

5. `backend/src/services/compiq/predictedRange.ts:72` — dead JSDoc example text (safe)
```ts
/** Estimate source string (e.g. "live", "neighbor-synthesis"). */
```

6. `backend/src/services/compiq/predictedRange.ts:111` — source enum value (unsafe: has consumers)
```ts
const NON_LIVE_SOURCES: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
```

7. `backend/src/routes/compiq.routes.ts:31` — comment text (safe)
```ts
// Phase 1 deploy follow-up: when `est.source` is a non-live fallback
// (neighbor-synthesis, no-recent-comps, unsupported_sport, variant-mismatch)
```

8. `backend/src/routes/compiq.routes.ts:36` — source enum value (unsafe: has consumers)
```ts
const NON_LIVE_SOURCES_FOR_REGIME: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
```

9. `backend/src/routes/compiq.routes.ts:84` — source enum value (unsafe: has consumers)
```ts
const NON_LIVE_SOURCES_FOR_PREDICTED_RANGE: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
```

10. `backend/src/routes/compiq.routes.ts:342,343,456,457,547,548,620,621` — response fields (unsafe: consumer-facing shape)
```ts
neighborSynthesis: null,
neighborSynthesisDebug: null,
...
neighborSynthesis: (est as any).neighborSynthesis ?? null,
neighborSynthesisDebug: null,
```

11. `backend/src/services/compiq/compiqEstimate.service.ts:1293` — response field (unsafe: consumer-facing shape)
```ts
neighborSynthesisDebug: null,
```

#### Hits in tests/harness and categorization

12. `backend/tests/routeHelperRegime.test.ts:9,46` — test consumer of legacy source value (unsafe)
```ts
// non-live source paths (neighbor-synthesis, ...)
const nonLiveSources = ["neighbor-synthesis", ...]
```

13. `backend/tests/predictedRange.test.ts:110,116` — test consumer of legacy source value (unsafe)
```ts
it("returns null for non-live source (neighbor-synthesis)", ...)
source: "neighbor-synthesis",
```

14. `backend/harness/tier1/_helpers.ts:423,473` — harness consumer of source enum (unsafe)
```ts
const ALLOWED_SOURCES = new Set([..., "neighbor-synthesis", ...]);
const allowed = new Set(["live", "no-recent-comps", "neighbor-synthesis"]);
```

15. `backend/harness/tier1/_helpers.ts:605,607,608,610` — harness consumer of response field (unsafe)
```ts
// neighborSynthesisDebug churn is always a warning.
JSON.stringify((baselineResp as any).neighborSynthesisDebug ?? null) !==
JSON.stringify((liveResp as any).neighborSynthesisDebug ?? null)
out.warnings.push("neighborSynthesisDebug changed");
```

#### iOS and schema/openapi checks

16. iOS codebase (`**/*.swift`) — no hits for `neighbor-synthesis|neighborSynthesis|NeighborSynthesis`.

17. Route/schema scan (`backend/src/routes/**/*.{ts,json,yaml,yml}`):
- Hits are in `backend/src/routes/compiq.routes.ts` only.
- No separate OpenAPI/swagger enum declaration for `neighbor-synthesis` was found.

18. Dangling import check in source (`backend/src/**/*.ts`):
- No remaining `import/require ... neighborSynthesis` hits.

### Removed
- `backend/src/services/compiq/cardhedge.client.ts:592` — dead comment
  - Removed deleted-mechanism wording and replaced with generic fallback-pricing wording.
- `backend/src/services/compiq/cardhedge.client.ts:675` — dead comment
  - Removed direct mention of `neighborSynthesis` implementation detail.
- `backend/src/services/compiq/neighborMultipliers.ts:69` — dead comment
  - Reworded to "pricing target" (no mechanism reference).
- `backend/src/services/compiq/predictedRange.ts:13` — dead comment text
  - Reworded non-live path comment to avoid deleted-mechanism naming.
- `backend/src/services/compiq/predictedRange.ts:72` — dead JSDoc example text
  - Removed `neighbor-synthesis` from example string.
- `backend/src/routes/compiq.routes.ts:31` — dead comment text
  - Reworded to reference "legacy values" without asserting active neighbor synthesis path.

### Flagged for owner (not removed)
- `backend/src/services/compiq/predictedRange.ts:111` — source enum value has consumers
  - Consumer locations:
    - `backend/tests/predictedRange.test.ts:110,116`
- `backend/src/routes/compiq.routes.ts:36` and `backend/src/routes/compiq.routes.ts:84` — source enum values have consumers
  - Consumer locations:
    - `backend/tests/routeHelperRegime.test.ts:46`
    - `backend/harness/tier1/_helpers.ts:423,473`
- `backend/src/routes/compiq.routes.ts:342,343,456,457,547,548,620,621` — response fields are consumer-facing and read by harness
  - Consumer locations:
    - `backend/harness/tier1/_helpers.ts:605,607,608,610`
    - `backend/harness/tier1` baselines (JSON fixtures include these fields)
- `backend/src/services/compiq/compiqEstimate.service.ts:1293` — response field retained for compatibility
  - Consumer locations:
    - `backend/harness/tier1/_helpers.ts:605,607,608,610`

### Build status
- npm run build: pass

### Targeted tests
- Required suites:
  - `tests/compiqEstimate.test.ts`: pass
  - `tests/compiqBulkShape.test.ts`: pass
- Additional neighbor-reference suites run:
  - `tests/predictedRange.test.ts`: pass
  - `tests/routeHelperRegime.test.ts`: pass

### Notes
- No logic was changed.
- No response field semantics were changed.
- `dataSufficiency` shape was untouched.
- Remaining neighbor-related literals in live source are legacy compatibility/consumer-bearing references and were intentionally not removed in this pass.
