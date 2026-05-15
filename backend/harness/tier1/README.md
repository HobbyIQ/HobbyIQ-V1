# Tier 1 Production Harness

## Purpose

Tier 1 is the **curated, hand-picked corpus** of real card lookups that exercises the live pricing pipeline against production every PR run. Its job is to catch production behavior changes — accidental or intentional — before they ship.

It is distinct from:

- **Mechanics tests** (`backend/harness/runner.ts` + sibling test files) — these validate the harness machinery itself (engine invoker contract, snapshot diff plumbing). They do not exercise real pricing behavior.
- **Tier 2 / Tier 3** — not yet seeded. Tier 2 is intended as a broader scripted corpus ("thousand cards across categories"); Tier 3 is intended as a sampled corpus pulled from production Cosmos logs daily. Tier 1 is currently the only real-card coverage we have.

## Why a separate tier

The CompIQ pricing engine has two distinct surface areas:

1. **Mechanics** — interfaces, response shape, snapshot machinery. These are deterministic and can be unit-tested in memory.
2. **Real-card behavior** — what happens when query `"2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond PSA 10"` flows through the parser → Card Hedge → comp filter → tier builder → response. This depends on live Card Hedge data and only fails on actual cards.

The bugs filed as #6 through #10 are all in category 2. None of them would have been caught by a mechanics-only test suite. Tier 1 closes that gap.

## Test structure (hybrid)

Each case runs two layers:

- **Layer A — targeted assertions.** Per-case knowledge baked into the test: e.g. "popular baseline cards MUST return `source: live`", "vintage grade tier MUST propagate from search to priceById", "PSA 10 marketTier >= Raw marketTier when both have comps". These assertions encode product-level expectations.
- **Layer B — snapshot diff.** Strip volatile fields (`computedAt`, `engineVersion`) from the live response and diff against the captured baseline. Surfaces unexpected drift in fields that no Layer A assertion currently covers.

Snapshot diff verdicts:

| Verdict | Trigger |
|---|---|
| FATAL | `marketTier.value` drift > 50% on live cases; `compsUsed` collapsing to 0 from non-zero; popular-baseline `source` changing away from `live`; `recentComps` emptied; fields removed; `success: true → false`; new `error` field appearing |
| WARNING | `marketTier` drift 10-50%; `recentComps` order change; `neighborSynthesisDebug` change; new fields added |
| OK | Anything else (shape stable, values within tolerance) |

## The 25 cases

The authoritative list is the `CASES` array in [`_helpers.ts`](./_helpers.ts). Below is a directory by category:

### Real lookups (cases 01-11) — sparse-data prospect autos, parallel hierarchy
| ID | Card |
|---|---|
| case-01 | Jacob Wilson 2023 Bowman Draft Green Refractor Auto PSA 10 |
| case-02 | Leo De Vries 2024 Bowman Chrome Blue Raywave Auto PSA 10 |
| case-03 | Gage Wood 2025 Bowman Draft Chrome Gold Auto PSA 9 |
| case-04a / case-04b | Nick Kurtz 2024 Bowman Draft Chrome Refractor Auto (Raw / PSA 10) |
| case-05 | Shohei Ohtani 2025 Topps Transcendent /25 Auto Raw |
| case-06a / case-06b | Caden Bodine 2024 Bowman Draft Chrome X-Fractor Auto (Raw / PSA 10) |
| case-07 | Josiah Hartshorn 2025 Bowman Draft Chrome Red Lava Auto PSA 9 |
| case-08a / case-08b | Josh Hammond 2025 Bowman Draft Chrome Blue Auto (Raw / PSA 10) |
| case-09 | Caleb Bonemer 2024 Bowman Draft Chrome Blue Auto Raw |
| case-10 | Caleb Bonemer 2024 Bowman Draft Chrome Gold Wave Auto PSA 9 |
| case-11 | Aaron Judge 2017 Topps Chrome Catching RC PSA 10 |

### Popular baseline (cases 12-14) — strictest tier
| ID | Card |
|---|---|
| case-12 | Paul Skenes 2024 Topps Chrome RC Raw |
| case-13 | Elly De La Cruz 2023 Topps Update RC Raw |
| case-14 | Wander Franco 2018 Bowman Chrome 1st Auto Raw |

These are high-volume cards where `source: "live"` and FMV > 0 are non-negotiable.

### Vintage (cases 15-16)
| ID | Card |
|---|---|
| case-15 | Michael Jordan 1986 Fleer PSA 8 |
| case-16 | Ken Griffey Jr. 1989 Upper Deck RC PSA 9 |

### Non-baseball (cases 17-18) — soft today
| ID | Card |
|---|---|
| case-17 | Luka Doncic 2018 Panini Prizm Silver PSA 10 |
| case-18 | Justin Herbert 2020 Panini Prizm PSA 10 |

These do not currently assert `compsUsed > 0` because Card Hedge applies a baseball-only filter at the data layer. When multi-sport CH support lands, lift the assertion in [`nonBaseball.test.ts`](./nonBaseball.test.ts) to hard.

### Pinned-id-hard (cases 19-20) — would have caught the PR #4 bug
| ID | Card |
|---|---|
| case-19a / case-19b | Eli Willits 2025 Bowman Draft Chrome Green Refractor Auto (Raw / PSA 10) |
| case-20a / case-20b | Josh Hammond 2025 Bowman Draft Chrome Gold Wave Auto (Raw / PSA 10) |

These exercise the `/price-by-id` endpoint with an explicit `cardHedgeCardId` and verify cross-endpoint agreement with `/search`.

## `blockedBy` and soft assertions

Some cases reference open production issues that are not yet fixed. Rather than skip them entirely (which loses snapshot coverage) or fail them every run (which trains the team to ignore CI red), the harness uses **soft assertions** gated on a `blockedBy` array per case.

When a case is `blockedBy: [N]`:

- Snapshot diff still runs at full strength.
- Well-formed assertions still run.
- The specific assertion that the linked issue would break is downgraded from `it()` to `it.skip()`, with a `(SOFT: blocked by issue #N)` annotation on the test name.

**When the issue closes**, remove the `blockedBy` entry in `CASES`. On the next CI run, the previously-skipped assertion executes at full strength. If the fix was real, the test passes. If it regressed, the test fails loudly — which is exactly what we want.

### Currently tracked issues

| Issue | Description | Cases |
|---|---|---|
| [#6](https://github.com/HobbyIQ/HobbyIQ-V1/issues/6) | PSA-grade tokens trigger variant-mismatch | 01, 04b, 19b |
| [#7](https://github.com/HobbyIQ/HobbyIQ-V1/issues/7) | Vintage grade tier not propagating (e.g. Jordan PSA 8 priced as raw) | 15 |
| [#8](https://github.com/HobbyIQ/HobbyIQ-V1/issues/8) | Skenes / Elly under-anchored vs market FMV | 12, 13 |
| [#9](https://github.com/HobbyIQ/HobbyIQ-V1/issues/9) | `/search` synthesizes marketTier but `/price-by-id` returns null when pinned card has zero comps | 19b, 20a, 20b |
| [#10](https://github.com/HobbyIQ/HobbyIQ-V1/issues/10) | Cosmetic `source` label inconsistency | informational only — no case soft-asserted |

## Adding a new case

1. **Capture baseline.** Hit `/api/compiq/search` (and `/api/compiq/price-by-id` if applicable) against production and save the JSON to `backend/harness/tier1/baselines/<case-id>.json`. The baseline shape must include the top-level fields `caseId`, `category`, `query`, `grade`, `capturedAt`, `search`, `searchError`, and (when a `cardHedgeCardId` is available) `cardHedgeCardId` + `priceById` + `priceByIdError`.
2. **Add a `CASES` entry** in [`_helpers.ts`](./_helpers.ts). Include `id`, `query`, `grade`, `sport`, `category`, `baselineFile`. Add `gradePair` if it has a Raw/PSA10 sibling.
3. **Add the test** to the category's test file (`realLookups.test.ts`, `popularBaseline.test.ts`, `vintage.test.ts`, `nonBaseball.test.ts`, or `pinnedIdHard.test.ts`). The shared describe pattern in each file iterates `casesIn(category)`, so usually no test edits are needed — just add to `CASES`.
4. **Run** `npm run test:harness:tier1` to verify the case passes.

## Updating a baseline (intentional engine changes)

When an engine change is expected to change pricing behavior — e.g. a tuning change to the anchor, a new comp filter — baselines will drift. The discipline:

1. Run the case against production with the new engine.
2. Compare the diff. If the change is **expected and acceptable**, overwrite the baseline file.
3. **Commit the baseline change in the same PR as the engine change**, with an explanation in the commit message of why the baseline moved.

Never update baselines silently. Never update baselines in a separate "harness maintenance" commit divorced from the engine change that caused them to move. The git blame on the baseline file is part of the audit trail.

## Disciplined response to a red Tier 1 test

When Tier 1 fails on a PR, the next action is **investigate, not bypass**. The three categories:

- **State change** — Card Hedge data shifted (a comp aged out, a new sale landed, a card was re-graded). Reproduce in isolation; if confirmed, update the baseline deliberately and explain in the commit message.
- **Real regression** — engine behavior changed in a way the PR introduces. File an issue if not already filed, fix in a separate PR, do not update the baseline.
- **Baseline staleness** — the baseline reflects a behavior that has been intentionally changed since capture, but the corresponding baseline update was missed. Update the baseline and reference the engine PR that changed the behavior.

The diagnostic playbook (5 consecutive calls per endpoint, compare to baseline, check for intermittency) is captured in the team's session notes from the case-20 investigation on 2026-05-15.

**Never silently update a baseline to make a red test green.** That is exactly the failure mode this harness exists to prevent.

## Known limitations

- **Tier 1 hits production.** A Card Hedge outage, an App Service restart during the test window, or a transient network hiccup can red Tier 1 for reasons unrelated to the PR. Re-run before assuming regression.
- **Non-baseball cases are soft.** Card Hedge applies a baseball-only filter at the data layer, so cases 17 and 18 always return `compsUsed: 0`. The harness asserts only that the response is well-formed and does not error. When multi-sport Card Hedge support lands, the assertion tightens.
- **Tier 2 and Tier 3 are empty.** Tier 1 is the only real-card coverage today. The CASES array is the entire production-card surface area exercised in CI.

## Running locally

```powershell
cd backend
npm run test:harness:tier1
```

Default `npm test` and `npm run test:harness` exclude Tier 1 so local mechanics iteration stays fast and offline-friendly.
