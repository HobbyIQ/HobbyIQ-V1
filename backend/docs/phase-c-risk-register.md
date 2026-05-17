# Phase C Risk Register

What could break in production, how to detect it, how to respond. Written pre-deploy.

## Risk 1: iOS app reads `fmv` field, returns errors or empty UI

**Description:** Engine response renames `fmv` → `marketValue`. Any iOS consumer reading `response.fmv` will get `undefined`. Depending on iOS-side handling, this surfaces as:
- App displays empty price (best case)
- App crashes on nil dereference (worst case)
- App shows "$0.00" or stale cached value (medium case)

**Likelihood:** High if iOS team isn't notified. Medium if notified but rollout timing isn't coordinated.

**Severity:** High. User-facing crashes or wrong-display affect all pricing-related screens.

**Detection:**
- iOS crash analytics within 1 hour of deploy if crashes occur
- User reports of "no price showing" or "$0.00" within 24 hours
- Pricing-endpoint response shape can be sampled in production logs

**Response:**
- If crashes detected: rollback per rollback plan
- If empty display detected without crashes: assess severity, may not warrant rollback if iOS update is in flight
- Coordinate with iOS team: ideally iOS update lands before or simultaneously with this deploy

**Mitigation pre-deploy:**
- iOS team notified about rename in advance
- iOS app handles `undefined` fields gracefully (verify with iOS team)
- Consider feature flag if iOS rollout lags backend deploy

---

## Risk 2: Mechanism 1 fires at unexpectedly low or high rate in production

**Description:** Mechanism 1's preconditions (3+ curated peers with comps, subject parallel curated, anchor available with ≥3 comps in 90 days) gate the predicted price output. If these gates fire too often in production, `predictedPrice` is null for most cards — Phase 3 ships but produces no new signal. If they fire too rarely (rare), Mechanism 1 is firing on insufficient data and producing low-quality predictions.

**Likelihood:** Medium. Drake Baldwin's live result already showed Mechanism 1 returning null due to CH labeling at curated peers. Other autograph parallels may have similar issues.

**Severity:** Medium. Not a correctness bug (null is honest output). But a coverage issue affecting product value.

**Detection:**
- Monitor `predictedPrice` non-null rate over 24-hour and 7-day windows
- Compare to expected rate (estimate: 30-50% of CPA-subset queries should produce non-null predictedPrice based on the 33-covered-parallels universe)
- Sample failureReason distribution: which gate is firing most?

**Response:**
- If fire rate is much lower than expected: investigate Hypothesis B (SKU canonical-name matching) and the 21-peer covered universe size — may need to expand peers or fix matching
- If fire rate is unexpectedly high but predictions look wrong: pause downstream consumer surfacing until calibration is reviewed

**Mitigation pre-deploy:**
- Fixture and live validation both completed
- Mechanism 1 is gated behind correct null behavior — under-firing is correct, just less useful

---

## Risk 3: `dataSufficiency` shape change breaks iOS rendering (vitest entry §8)

**Description:** The vitest baseline investigation flagged `dataSufficiency` shape drift on null FMV as the highest-stakes deferred concern. ADR-0003 Option 3 implementation restored `dataSufficiency` on the no-recent-comps branch. If the shape changed from what iOS expects, iOS may render insufficient-data UI incorrectly or crash.

**Likelihood:** Medium. The shape was restored in the implementation, but cross-checking against iOS consumer code didn't happen explicitly tonight.

**Severity:** High. Same blast radius as Risk 1 — affects all pricing screens.

**Detection:**
- iOS-side render errors for cards with sparse comp data
- Specifically watch cards that produce `marketValue: null, predictedPrice: null` (i.e. cards where `dataSufficiency` is the only meaningful signal)

**Response:**
- If iOS render errors detected and tied to `dataSufficiency` shape: this is the entry §8 risk materializing. Rollback per plan.
- Coordinate with iOS to confirm shape compatibility before final ship if not already done.

**Mitigation pre-deploy:**
- Phase C checklist §3 included this as a compensating verification. Confirm it was actually run with a positive result.
- If unsure: do a quick `grep` on iOS code for `dataSufficiency` consumers and verify shape compatibility before deploy.

---

## Risk 4: The 6 deferred 2022 Bowman Chrome parallels silently get included in production data

**Description:** The 6 uncovered Shimmer/Aqua parallel names were deferred per `2022-bowman-chrome-uncovered-parallels.md`. They were NOT supposed to land in `parallel_attributes` Cosmos. If the Phase B narrow-scope apply mechanism didn't exclude them correctly, they could be in production with no curator multipliers.

**Likelihood:** Low. The narrow-scope apply was scoped specifically; verification step confirmed exclusion.

**Severity:** Medium. If included, engine could attempt multiplier lookups against them, fail unpredictably, or produce wrong predictions.

**Detection:**
- Query `parallel_attributes` post-deploy: count of records matching the 6 deferred parallel names
- Expected: 0

**Response:**
- If any records exist: investigate origin. Likely a narrow-scope apply bug. Remove the records manually; consider whether broader Phase B records need re-verification.

**Mitigation pre-deploy:**
- Confirm `verify-parallel-attributes-coverage.ts` was actually run with positive result for the exclusion check

---

## Risk 5: CH intermittent reliability causes widespread null results in production

**Description:** CH reliability investigation showed intermittent 422/502 episodes. If CH degrades during a peak traffic window, the engine returns honest nulls — but users may perceive "the pricing feature broke" when really it's the upstream data source.

**Likelihood:** High. CH reliability is outside this codebase's control.

**Severity:** Medium. Not a code issue; degraded UX during CH degradation periods.

**Detection:**
- Monitor CH error rate (4xx/5xx) over rolling windows
- Correlate with engine null-response rate

**Response:**
- Cannot rollback (this is a known CH issue, not a Phase C regression)
- Communicate to users via in-app messaging if degradation is severe and prolonged
- Long-term: discuss with CH directly about reliability SLA

**Mitigation pre-deploy:**
- Engine returns honest output regardless of CH state
- Consumer-side messaging strategy for "data temporarily unavailable" if not already in place

---

## Risk 6: Consumer pattern-matching against neighbor-synthesis source enum values

**Description:** The cleanup pass flagged consumer-bearing references to `neighbor-synthesis` as flagged-not-removed. Some consumers (route helpers, harness tests, possibly iOS code) pattern-match against the `"neighbor-synthesis"` source string. Since neighbor synthesis no longer produces output, consumers expecting that source value may have unexpected behavior.

**Likelihood:** Medium. Specifically flagged in the cleanup report.

**Severity:** Low to medium. Depends on what each consumer does when it doesn't see the expected source value.

**Detection:**
- Code review pre-deploy: re-read `neighbor-synthesis-cleanup-pass.md` flagged items
- Post-deploy: check any consumer-side error logs for unexpected enum/string handling

**Response:**
- For each flagged consumer-bearing reference: assess whether it's still safe to leave (the value just never appears now) or if it needs explicit removal
- Most likely outcome: leave the references but document that the value is dead/unreachable

**Mitigation pre-deploy:**
- Cleanup report at `backend/docs/investigations/neighbor-synthesis-cleanup-pass.md` lists each flagged location
- Review before deploy

---

## Risk 7: Multiplier table extension introduces calculation bugs for edge cases

**Description:** 2022 Bowman family multiplier extension added subset disambiguation, tier qualifiers, range-based values. Edge cases in lookup logic (e.g. Sky Blue requested in CPA subset where it doesn't exist) could fall through and return wrong results.

**Likelihood:** Low. Unit tests covered subset disambiguation, doesn't-exist-in-subset returns null, direct-comp-only flagging, range exposure. Fixture integration test passed.

**Severity:** Medium. Wrong multiplier produces wrong predictedPrice for affected cards.

**Detection:**
- Monitor `predictedPrice` distributions vs expected ranges for known reference cards (e.g. top prospect autographs with active markets)
- Sample attribution outputs for sanity (correct multiplier value, correct anchor)

**Response:**
- If wrong predictions detected: roll back, investigate specific lookup case, fix-and-redeploy
- May not be a full Phase 3 rollback — may be a multiplier table edit only

**Mitigation pre-deploy:**
- Targeted tests pass
- Pre-flight structural report confirmed table accommodates curator data faithfully

---

## Summary

| # | Risk | Likelihood | Severity | Pre-deploy mitigation status |
|---|---|---|---|---|
| 1 | iOS reads `fmv` | High* | High | Notify iOS team, confirm before deploy |
| 2 | Mechanism 1 fire rate off | Medium | Medium | Monitor post-deploy |
| 3 | `dataSufficiency` shape break | Medium | High | Verify Phase C §3 ran positive |
| 4 | 6 deferred parallels included | Low | Medium | Verify post-apply exclusion check ran |
| 5 | CH intermittent reliability | High | Medium | Out of scope; consumer-side messaging |
| 6 | Pattern-matching on dead enum | Medium | Low-Med | Re-review cleanup report |
| 7 | Multiplier calculation edge case | Low | Medium | Tests passed; monitor post-deploy |

\* High UNLESS iOS team is notified and updates land coordinated with this deploy

## Pre-deploy gate

Before merging Phase 3 engine PR, verify:

- [ ] iOS team notified about `fmv` → `marketValue` rename
- [ ] Phase C checklist §3 (`dataSufficiency` shape) verified positive
- [ ] `verify-parallel-attributes-coverage.ts` confirmed 6 deferred parallels excluded
- [ ] Neighbor-synthesis cleanup report flagged-not-removed items reviewed
- [ ] Rollback plan reviewed (see `phase-c-rollback-plan.md`)
- [ ] SourceCitation schema PR landed and deployed first
