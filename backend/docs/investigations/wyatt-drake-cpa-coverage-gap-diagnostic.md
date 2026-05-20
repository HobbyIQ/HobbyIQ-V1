## CPA Blue Refractor /150 Auto coverage gap diagnostic

Date: 2026-05-17T15:28:13.4679792-04:00
Affected queries:
- Wyatt Langford 2022 Bowman Chrome Blue Refractor /150 Auto CPA -> uncurated-subject-parallel
- Drake Baldwin 2022 Bowman Chrome Blue Refractor /150 Auto CPA -> uncurated-subject-parallel

### Lookup call path
- Lookup signature used by Mechanism 1:
  - lookupBowmanFamilyEntry({ product, subset, parallelName }) via resolveSubjectEntry() in multiplierAnchoredPredictedPrice
- Engine-passed argument values (sample shape from computeEstimate variant-mismatch/insufficient branches):
  - product: Bowman Chrome
  - subset: Chrome Prospect Autographs
  - parallelName: normalizedParallel ?? body.parallel ?? ""
  - year: present on subject object but NOT used by lookupBowmanFamilyEntry
  - isAutograph: present on subject object but NOT used by lookupBowmanFamilyEntry
- Where each arg originates:
  - product: compiqEstimate.service sets product to Bowman Draft if body.product includes Draft, else Bowman Chrome
  - subset: compiqEstimate.service hard-codes Chrome Prospect Autographs for Mechanism 1 subject
  - parallelName:
    - body.parallel has auto tokens removed first (Blue Refractor /150 Auto -> Blue Refractor /150)
    - normalizeParallel then converts to lowercase token form and strips punctuation, yielding blue refractor 150
    - this normalized string is passed to Mechanism 1

Observed targeted probe (local dist build):
- raw: Blue Refractor /150 Auto
- parallelForNorm: Blue Refractor /150
- normalizedParallel: blue refractor 150

### Table entry shape
- Entry present for 2022 Bowman Draft CPA Blue Refractor /150:
  - brand/product: Bowman Draft
  - parallelName: Blue Refractor
  - subset: Chrome Prospect Autographs
  - year: 2022
  - isAutograph: true
  - tierQualifier: null
  - multiplier: [3.0, 4.4]
- Entry does NOT exist for 2022 Bowman Chrome CPA Blue Refractor /150 (only HTA Choice Refractor and Blue RayWave Refractor exist at /150 in that subset).

### Lookup test
- Canonical args lookup result:
  - lookupBowmanFamilyEntry({ product: Bowman Draft, subset: Chrome Prospect Autographs, parallelName: Blue Refractor })
  - MATCH -> range low=3.0 high=4.4
- Engine-actual args lookup result:
  - lookupBowmanFamilyEntry({ product: Bowman Chrome, subset: Chrome Prospect Autographs, parallelName: blue refractor 150 })
  - MISS -> null
- Additional confirmation:
  - computeMultiplierAnchoredPredictedPrice with subject.parallelName blue refractor 150 returns failureReason uncurated-subject-parallel

### Hypothesis resolution
- A (lookup contract mismatch): partial confirmed
  - Evidence: the engine passes a normalized key with serial token (blue refractor 150), while table matching expects canonical parallel names (Blue Refractor family aliasing). This mismatch prevents the Blue Refractor -> HTA fallback from firing.
- B (upstream parallel resolution): confirmed (primary)
  - Evidence: normalizeParallel produces blue refractor 150 from Blue Refractor /150 Auto, and resolveSubjectEntry fallback only triggers on exact Blue Refractor.
- C (year-aware gap): refuted for this failure
  - Evidence: this Mechanism 1 path does not query multiplierTableRegistry.lookup or year-aware registry context; it uses lookupBowmanFamilyEntry directly. Year is not the deciding mismatch in the reproduced failure.

### Primary cause
The subject parallel string passed into Mechanism 1 is normalized to blue refractor 150, which does not match curated Bowman family keys and bypasses the Blue Refractor fallback path; combined with no Bowman Chrome CPA Blue Refractor row, this yields uncurated-subject-parallel.

### Recommended fix
- Specific code change:
  - In backend/src/agents/multiplierAnchoredPredictedPrice.ts, normalizeSubjectParallel should canonicalize serial-suffixed variants before matching/fallback (e.g., map blue refractor 150 and Blue Refractor /150 to Blue Refractor, then existing fallback to HTA Choice Refractor can apply for Bowman Chrome CPA).
  - Optionally, use lookupBowmanFamilyEntry alias-compatible canonicalization directly (or introduce a helper in chromeDraftMultipliers for subject-side canonicalization) rather than regex-only exact matching.
- Estimated complexity: low
- Risk: low to medium (touches canonicalization in one prediction path; should be regression-tested for non-/150 parallels)
- Scope guidance:
  - This looks like a simple, localized hotfix and can be folded into Group 2 if timing allows; otherwise separate PR with focused tests is clean.
