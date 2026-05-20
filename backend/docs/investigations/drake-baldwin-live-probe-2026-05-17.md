## Drake Baldwin live-data probe

Date: 2026-05-17T13:14:26.620Z
Engine state: post-Mechanism-1 build

### Engine output (live CH)
- marketValue: null
- predictedPrice: null
- predictedPriceRange: null
- predictedPriceAttribution:
  - mechanism: multiplier-anchored
  - anchorParallel: null
  - anchorProduct: null
  - anchorComps: null
  - anchorPrice: null
  - multiplierRange: null
  - crossProductAnchor: null
  - confidence: null
  - failureReason: insufficient-curated-peer-parallels

Raw capture file:
- backend/docs/investigations/drake-baldwin-live-probe-raw-2026-05-17.json

### Anchor selection trace
Observed live engine branch:
- source: variant-mismatch
- variantWarning: [blue, refractor]
- cardIdentity resolved by CH: 2022 Bowman Draft CDA-DBN Base
- compsAvailable: 27
- compsUsed: 0 (for direct-variant pricing)

Mechanism 1 trace from attribution + returned comp pool:
- Preference 1 attempted (same-product same-subset Refractor /499): no qualifying comps found within 90 days.
- Preference 2 attempted (same-product same-subset lowest-print-run with >=3 comps): no qualifying print-run parallel bucket with >=3 curated comps within 90 days.
- Preference 3 attempted (related-product same-subset Refractor /499): no qualifying Refractor /499 bucket with >=3 comps within 90 days.
- Winning preference: none (engine returned null with failureReason=insufficient-curated-peer-parallels before an anchor could be selected).

### Anchor data sanity
No anchor was selected, so anchor-specific sanity metrics are not available.

Closest observable live pool facts (from returned recentComps):
- Total fetched comps surfaced by engine: 27
- Recent-window comps that reached variant filter stage: 3 (all rejected as parallel_mismatch)
- Returned recent sales are overwhelmingly Bowman Draft CDA-DBN base autos with no explicit /499 Refractor labeling.

### Math verification
Not applicable because predictedPrice is null and no anchor was selected.

- anchorPrice × multiplier.low = N/A
- anchorPrice × multiplier.high = N/A
- predictedPrice midpoint check = N/A

### Cross-product flag
- crossProductAnchor: null (not set)
- Attribution clarity: clear that no anchor was selected because failureReason is explicit (`insufficient-curated-peer-parallels`), but there is no selected anchor product/parallel to surface.

### Comparison to fixture result
- Fixture predictedPrice: $555 (range $450-$660, anchor $150)
- Live predictedPrice: null (range null, anchor null)
- Drift: meaningful divergence. Fixture assumed a viable >=3-comp anchor bucket; live CH snapshot did not satisfy Mechanism 1 anchorability constraints for this subject.

### Ship recommendation
Hold.

Reason:
- Live run produced predictedPrice=null with failureReason=insufficient-curated-peer-parallels.
- This fails the pre-ship expectation that Drake Baldwin should return a non-null Mechanism 1 prediction from live data.
- Before Phase C ship, investigate whether:
  1. live CH labeling/data changed (especially explicit Refractor /499 signals),
  2. anchor-preference logic needs an additional allowed fallback for base-auto anchors when Refractor /499 is absent, or
  3. owner wants to accept honest null for this card in current market conditions.
