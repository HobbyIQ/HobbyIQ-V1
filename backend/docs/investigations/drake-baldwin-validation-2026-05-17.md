# Drake Baldwin validation

Card: 2022 Bowman Chrome Blue Refractor /150 Auto
Validation date: 2026-05-17T12:34:46.944Z
Validation target: $450-600

## Comp-anchored FMV

- Result: $311.50
- Confidence: 44
- Comp count: 0 (recent: 27)
- In target range: no

## Multiplier-anchored structural range

- Result: $308.42 - $514.04
- Multiplier used: subject parallel = Blue, subject multiplier = 5.7
- Baseline math: peer parallels [Blue Wave ($400), Blue Wave ($275), Blue Wave ($300), Blue Wave ($230), Blue Wave ($190), Blue Wave ($253.04), Blue Wave ($315), Blue Wave ($350)], player baseline = $72.15
- In target range: yes

## Signal agreement

- Band: strong
- If disagreement: n/a
- Notes: Used `attempt-2` (product input `Bowman Chrome`), which produced both signals. Comp FMV is inside the structural range, but comp FMV is below the validation target band.

## Phase 3.1 calibration notes

- Structural guardrail computation is functioning and produces a non-null range with healthy peer depth (curated peers: 43).
- Agreement was strong for this run, so this case does not indicate structural-vs-comp divergence.
- Primary signal gate still fails for Phase C target (`$311.50` vs required `$450-600`), so shipping should be blocked under the amendment decision table until comp-anchored FMV reaches target.
