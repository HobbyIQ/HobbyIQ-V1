## Drake Baldwin re-validation (post-ADR-0003)

Date: 2026-05-17T12:59:19.972Z
Engine state: post-ADR-0003 Option 3 (minimum-viable)

Raw artifact: backend/docs/investigations/drake-baldwin-revalidation-raw-adr-0003.json

### Engine output
- marketValue: null (all 3 attempts)
- predictedPrice: null (all 3 attempts)
- predictedPriceAttribution: null (all 3 attempts)
- fmv field present: no (`fmv` key absent)
- fairMarketValue field present: yes (nullable, currently null in all 3 attempts)
- neighbor-synthesis source label present anywhere: no
- source values observed: `variant-mismatch` (all 3 attempts)

Notes:
- Previous baseline run (`drake-baldwin-validation-raw-2026-05-17.json`) showed `fairMarketValue: 311.5` with `source: "neighbor-synthesis"`.
- Current run no longer emits neighbor-synthesis source or synthesized FMV in this case; output is now contract-honest for Option 3 scope.

### Required field contract
- dealScore: `0` (number) in all 3 attempts
- dataSufficiency: present in all 3 attempts with object shape:
  - `sufficient: false`
  - `level: "none"`
  - `message: string`
- confidence: present as object in all 3 attempts:
  - `pricingConfidence: 0`
  - `liquidityConfidence: 0`
  - `timingConfidence: 0`
- Other consumer-required fields observed and populated consistently:
  - `cardTitle`, `verdict`, `action`, `explanation[]`, `source`, `compsUsed`, `compsAvailable`, `recentComps[]`, `cardIdentity`

### dataSufficiency shape change analysis
- Shape before ADR-0003 edits (recoverable from prior Drake raw artifact):
  - Present, with `sufficient`, `level`, `message`
  - In prior Drake run, `level` was `"low"` on neighbor-synthesis path.
- Shape after ADR-0003 edits (current Drake re-validation):
  - Present, with same key set `sufficient`, `level`, `message`
  - `level` now `"none"` for variant-mismatch/null-market path
- Consumers identified:
  - Backend contract tests:
    - `backend/tests/compiqEstimate.test.ts` asserts presence and `dataSufficiency.sufficient === false` when `fairMarketValue` is null.
  - iOS/workspace consumer scan:
    - No direct `dataSufficiency` field reads found in `*.swift` files.
    - `CompIQEstimateResponse` in `APIService.swift` does not model `dataSufficiency`; unknown JSON keys are ignored by Codable.
- Impact assessment:
  - No iOS break risk identified from this field specifically (no direct readers found).
  - Backend contract expectation is currently satisfied by live output.

### Pre-existing test failures audit
Current `npm test` failing items (2026-05-17 run):
- Suite-load failures:
  - `tests/pricing/api-compatibility.test.ts` (`before is not defined`)
  - `tests/pricing/api-response-shape.test.ts` (`before is not defined`)
  - `tests/pricing/cache-logger.test.ts` (`No test suite found`)
  - `tests/pricing/compiq-estimate.test.ts` (`No test suite found`)
- Named-test failures:
  - `tests/beckettUrlDiscovery.test.ts > enumerateCandidateUrls > emits months × suffixes × variants × sport-flag candidates`
  - `tests/beckettUrlDiscovery.test.ts > enumerateCandidateUrls > falls back to the brand name as-is when not in BRAND_VARIANTS`

Cross-reference against `backend/docs/investigations/vitest-baseline-failures.md` deferred list:
- In baseline deferred list:
  - `tests/pricing/api-compatibility.test.ts`
  - `tests/pricing/api-response-shape.test.ts`
  - `tests/pricing/cache-logger.test.ts`
  - `tests/pricing/compiq-estimate.test.ts`
- Not in baseline deferred list (new vs that report):
  - Both failing cases in `tests/beckettUrlDiscovery.test.ts`
- Previously in baseline deferred list but currently passing:
  - `tests/cardhedgeFindCompsByQuery.test.ts` failures (2)
  - `tests/compiqEstimate.test.ts` failures (2)

Assessment of ADR-0003 regression risk from failing tests:
- The two current new failures are in Beckett URL discovery tests, outside files touched by ADR-0003 estimate/route/neighbor-synthesis changes.
- They are still new relative to the baseline investigation report and should be tracked as findings for ship decision bookkeeping.

### Ship recommendation
- Ship criteria status:
  - Engine output honest (no mislabeled neighbor-synthesis FMV): pass
  - No new test regressions relative to baseline list: fail (2 Beckett failures are new vs baseline report)
  - dataSufficiency shape consumer-compatible (Phase C section 3): pass
  - Blockers identified: yes (new-vs-baseline failing tests, even if likely unrelated to ADR scope)
- Recommendation: Hold
  - Reason: baseline-comparison rule in this re-validation prompt flags new failures.
  - If owner chooses ADR-scoped gating instead of full-baseline parity, ADR-0003 output contract itself appears ready to ship.
