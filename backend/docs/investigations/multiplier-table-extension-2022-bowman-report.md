# 2022 Bowman Family Multiplier Extension Report

Date: 2026-05-17

## Scope executed

- Added additive 2022 owner-curated multiplier entries (Bowman, Bowman Chrome, Bowman Draft) in:
  - backend/src/services/compiq/chromeDraftMultipliers.ts
- Extended registry lookup with optional context (`year`, `subset`, `tierQualifier`) in:
  - backend/src/curation/multiplierTableRegistry.ts
- Updated year-aware consumers in:
  - backend/src/curation/eligibilityAnalyzer.ts
  - backend/src/curation/worksheetGenerator.ts
- Added/updated tests in:
  - backend/tests/compiq/chromeDraftMultipliers.test.ts
  - backend/tests/multiplierTableRegistry.test.ts

## Pre-flight structure report

See:
- backend/docs/investigations/multiplier-table-current-shape.md

Summary:
- Existing table was flat and single-value; it could not represent subset disambiguation, range multipliers, tier qualifiers, or direct-comp-only flags.
- Implementation used an additive extension path to preserve legacy callers.

## Additive-only guarantee

- The legacy 54-entry table (`CHROME_DRAFT_MULTIPLIERS`) was preserved.
- No existing entry was deleted or replaced.
- New 2022 family data is stored in additive structures and served via year/context-aware lookups.

## Overlap/conflict disclosure (required)

Because the new 2022 curated values include names that also exist in the legacy 54-entry ladder, overlap conflicts were detected and reported.

Conflict artifact:
- backend/docs/investigations/multiplier-table-2022-bowman-conflicts.json

Current overlap conflict count:
- 82 entry-level overlaps where baseline values differ from legacy values.

Important note:
- These conflicts are not silent overwrites. Legacy behavior remains for legacy lookup paths; 2022 year/context lookup paths return the new values.

## Requested sanity probes

Probe artifact:
- backend/docs/investigations/multiplier-table-2022-bowman-sanity-check.json

Key outcomes:
- Refractor (Bowman Chrome base): MATCH
- Blue Refractor (Bowman Chrome base): MATCH
- Sky Blue (Bowman paper subset): MATCH (maps to Sky Blue Border)
- Sky Blue Refractor (Bowman paper subset): NO MATCH
- Green Mini-Diamond Refractors (Bowman Chrome broad): MATCH (alias to B&W Mini Diamond Refractor)
- X-Fractor (Bowman Chrome broad): NO MATCH
- Aqua Refractor (CPA context via Bowman Draft): MATCH with autograph baseline range
- Aqua Refractor (Bowman Chrome base): NO MATCH

## 2022 Bowman Chrome eligibility re-check

Eligibility report (refreshed):
- backend/data/phase-c-2022-bowman-chrome/eligibility/2022-Bowman-Chrome.json

Current result:
- coveredCount: 33
- uncoveredCount: 6
- totalParallels: 39
- eligible: false (`partial-coverage`)

Remaining uncovered labels:
- Shimmer Refractors
- Purple Shimmer Refractors
- Fuchsia Shimmer Refractors
- Aqua Refractors
- Green Shimmer Refractors
- Black Shimmer Refractors

Interpretation:
- Coverage improved from prior 1/39 baseline to 33/39.
- Remaining six appear to be checklist-shape naming gaps not yet represented in the owner-supplied 2022 source set for this pass. They require explicit owner mapping decisions (canonical additions or parser-specific alias policy).

## Build and tests

Build:
- `npm run build` passed.

Targeted tests passed:
- `tests/compiq/chromeDraftMultipliers.test.ts`
- `tests/multiplierTableRegistry.test.ts`
- `tests/eligibilityAnalyzer.test.ts`

