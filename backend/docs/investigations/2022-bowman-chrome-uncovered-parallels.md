# 2022 Bowman Chrome Uncovered Parallels

Staged source inspected: `backend/data/beckett-sweep/2022/Bowman-Chrome.json`

Diagnostic note:
- In this staged schema, uncovered items are present as set-level entries in `parallels[]` with fields: `rawName`, `printRun`, `isOneOfOne`, `note`, `normalization`.
- The file does not preserve per-parallel card linkage, and does not store source sheet/section on each `parallels[]` row.
- Because of that, card-level sample rows under each uncovered parallel are not available from this staged artifact.

## Parallel: Shimmer Refractors
- Raw label: Shimmer Refractors
- Source sheet/section: absent
- Print run: absent
- isAutograph: false
- Card count: 0
- Category guess: ambiguous
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row with `normalization.strategy = unmatched`, `isOneOfOne = false`; no card linkage stored.

## Parallel: Purple Shimmer Refractors
- Raw label: Purple Shimmer Refractors
- Source sheet/section: absent
- Print run: 250
- isAutograph: false
- Card count: 0
- Category guess: genuine-sku
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row; parser normalized to `Purple Shimmer` via `stripped-refractor` with 0.93 confidence; likely a real parallel needing table coverage/mapping.

## Parallel: Fuchsia Shimmer Refractors
- Raw label: Fuchsia Shimmer Refractors
- Source sheet/section: absent
- Print run: 199
- isAutograph: false
- Card count: 0
- Category guess: genuine-sku
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row with numeric print run and `isOneOfOne = false`; looks like a real SKU but unmatched canonical mapping.

## Parallel: Aqua Refractors
- Raw label: Aqua Refractors
- Source sheet/section: absent
- Print run: 125
- isAutograph: false
- Card count: 0
- Category guess: genuine-sku
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row with numeric print run and `isOneOfOne = false`; likely real SKU (coverage/mapping gap rather than obvious parser artifact).

## Parallel: Green Shimmer Refractors
- Raw label: Green Shimmer Refractors
- Source sheet/section: absent
- Print run: 99
- isAutograph: false
- Card count: 0
- Category guess: genuine-sku
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row; parser normalized to `Green Shimmer` via `stripped-refractor` with 0.93 confidence; likely a real SKU needing table entry/mapping.

## Parallel: Black Shimmer Refractors
- Raw label: Black Shimmer Refractors
- Source sheet/section: absent
- Print run: absent
- isAutograph: false
- Card count: 0
- Category guess: ambiguous
- Sample records:
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
  - Card #? - unavailable in staged artifact
- Notes: Present as one uncovered `parallels[]` row with `isOneOfOne = true` and no numeric print run; likely real high-end variant, but missing sheet/section and card linkage in staged output keeps this ambiguous.
