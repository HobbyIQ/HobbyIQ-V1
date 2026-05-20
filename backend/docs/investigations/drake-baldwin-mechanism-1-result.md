## Drake Baldwin Mechanism 1 Result

Date: 2026-05-17

### Scope
This report captures the Mechanism 1 (multiplier-anchored predicted price) output for:
- Player: Drake Baldwin
- Year: 2022
- Product: Bowman Chrome
- Subset: Chrome Prospect Autographs
- Subject parallel: Blue Refractor /150 Auto

Per ADR-0003 Phase 3.2 partial scope, `marketValue` semantics remain unchanged and can stay `null` when direct subject comps are unavailable.

### Mechanism 1 output (captured)
Using the integration fixture comp pool, the engine returned:

- `predictedPrice`: `555`
- `predictedPriceRange.low`: `450`
- `predictedPriceRange.high`: `660`
- `predictedPriceAttribution.mechanism`: `"multiplier-anchored"`
- `predictedPriceAttribution.anchorParallel`: `"Refractor"`
- `predictedPriceAttribution.anchorProduct`: `"Bowman Draft"`
- `predictedPriceAttribution.anchorComps`: `3`
- `predictedPriceAttribution.anchorPrice`: `150`
- `predictedPriceAttribution.multiplierRange`: `{ low: 3.0, high: 4.4 }`
- `predictedPriceAttribution.confidence`: `83`
- `predictedPriceAttribution.crossProductAnchor`: `true`

### Contract assertions
From `tests/drakeBaldwinIntegration.test.ts`:
- `marketValue === null`
- `predictedPrice` is numeric and in `[300, 700]`
- `predictedPriceAttribution.mechanism === "multiplier-anchored"`
- `predictedPriceAttribution.anchorParallel` is populated

### Comparison to expected target
- Target expectation: `$500-600`
- Observed midpoint: `$555`
- Observed range: `$450-$660`

Interpretation:
- Midpoint lands inside the `$500-600` target band.
- Full range extends outside target, which is expected given multiplier band width and cross-product anchor uncertainty.
