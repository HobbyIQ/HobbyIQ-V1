# Multiplier Table Current Shape (Pre-flight)

Date: 2026-05-17

Scope reviewed:
- backend/src/services/compiq/chromeDraftMultipliers.ts
- backend/src/curation/multiplierTableRegistry.ts
- backend/src/curation/eligibilityAnalyzer.ts

## Current table shape

The active table module is backend/src/services/compiq/chromeDraftMultipliers.ts (not backend/src/agents/chromeDraftMultipliers.ts).

- Entry type: `ChromeDraftEntry`
- Fields per entry:
  - `parallelName: string`
  - `printRun: string`
  - `colorTier: ChromeDraftColorTier`
  - `baseMultiplier: number`
  - `refractorMultiplier: number`
  - `productType: "chrome-draft"`
- Stored as a flat canonical-name keyed map (`CHROME_DRAFT_MULTIPLIERS`) with 54 entries.

## Answers to required pre-flight questions

1) TypeScript type of each entry
- `ChromeDraftEntry` as listed above.

2) Subset/product field present or flat?
- Product is flat (`productType: "chrome-draft"` only).
- No subset dimension (`CPA`, `BCRA`, `Chrome Prospects`, `Paper Prospects`, `Insert`, etc.) exists.

3) How multipliers are stored
- Two single numeric values per entry (`baseMultiplier`, `refractorMultiplier`).
- No `{ low, high }` range structure.

4) Baseline handling for autograph subsets (CPA 1.55x at /499)
- No dedicated subset baseline model.
- Existing table treats autograph and non-autograph with one shared flat ladder.

5) Print runs stored explicitly?
- Yes, as string text (`"/499"`, `"/150"`, `"1/1"`, `"unnumbered"`).

6) `isAutograph` field present or derived?
- No `isAutograph` field on table entries.
- Registry and worksheet currently default autograph handling outside this table.

7) `isHobby` / `isHTA` / `isLite` separation present?
- No tier qualifier dimension exists.
- HTA appears only as name text for some legacy entries (`HTA Choice ...`), not as a distinct qualifier field.

## Compatibility assessment

Current shape is not sufficient to encode the owner-supplied 2022 Bowman family data faithfully because it lacks:
- subset disambiguation
- tier qualifier dimension (Hobby/HTA/Lite)
- range multipliers (`low/high`)
- direct-comp-only flag
- caveat/new-for-year metadata fields

## Implementation direction used for extension

To preserve backward compatibility while enabling the 2022 extension:
- Keep the legacy 54-entry table and current APIs intact for existing runtime callers.
- Add a context-aware 2022 Bowman family table in the same module with:
  - product + subset + tier qualifier dimensions
  - baseline + range (`low`, `high`)
  - `directCompOnly`, `note`, `newFor2022`
- Extend registry lookup with optional context to support strict subset-aware lookups while preserving current two-argument behavior for existing call sites.

