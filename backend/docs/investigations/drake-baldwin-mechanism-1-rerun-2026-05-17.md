## Drake Baldwin Mechanism 1 live re-run

Date: 2026-05-17T13:40:26.651Z
Trigger: CH reliability re-probe showed Drake Baldwin now returning comps (successful 200 responses)

Execution constraints honored:
- One live engine invocation only
- No retries
- Read-only (no engine/code changes)

### Engine output (live)
- marketValue: null
- predictedPrice: null
- predictedPriceRange: null
- predictedPriceAttribution:
```json
{
  "mechanism": "multiplier-anchored",
  "failureReason": "insufficient-curated-peer-parallels"
}
```
- failureReason: insufficient-curated-peer-parallels

Additional live output context:
- source: variant-mismatch
- cardIdentity: 2022 Bowman Draft Chrome Draft Pick Autograph Baseball (`CDA-DBN`, variant `Base`)
- compsAvailable: 27
- variantWarning: ["blue", "refractor"]

### If null: deeper diagnosis
- failureReason: `insufficient-curated-peer-parallels` (same as earlier)
- 27 comps grouped by parallel name (as CH titles returned in this run):
  - Base/unspecified: 27
- Curated peers (from covered multiplier-table peers) with comps in this set: 0

Interpretation from this run:
- Drake now has broad sold comps for his base auto card identity, but those sales do not carry curated peer-parallel signals needed for Mechanism 1 anchorability.
- This is not the same as "no comps at all"; it is "no curated parallel bucket with enough eligible comps for the anchor path" for the requested `Blue Refractor` target.

### Comparison to fixture
- Fixture: $555 / $450-660 / anchor $150 (cross-product Bowman Draft)
- Live re-run: null / null / no anchor selected
- Drift: fixture assumptions about anchorable curated-peer structure are not met in this live snapshot.

### Target range check ($500-600)
- Not applicable (predictedPrice is null).

### Ship recommendation
Ship with documented limitation.

Reason:
- Mechanism 1 continues to return null for Drake Baldwin even with live comps present because curated peer-parallel coverage for anchor selection is still insufficient in the returned live set.
- This behavior is consistent with the designed guardrail (`insufficient-curated-peer-parallels`) rather than a math-reconciliation bug.
- Document this as a coverage/labeling limitation for this card path, not a broken Mechanism 1 computation path.
