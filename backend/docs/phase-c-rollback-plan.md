# Phase C Rollback Plan

What to do if Phase C deploys and production behavior is unacceptable. Written pre-deploy.

## Rollback decision criteria

**Roll back immediately if:**
1. iOS app crash rate increases by >5% within 1 hour of deploy AND the crashes touch pricing-related code paths
2. Engine returns HTTP 5xx error rate >2% sustained for >15 minutes (engine internal failure, not CH-upstream issue)
3. `dataSufficiency` shape change confirmed breaking iOS render with no quick consumer-side fix available
4. Calculation bug surfaces producing obviously-wrong predictions (e.g. negative prices, prices >10x reasonable range) for non-edge-case cards

**Do NOT roll back for:**
1. `predictedPrice: null` rates being higher than hoped (that's correct ADR-0003 behavior)
2. CH intermittent reliability surfacing as engine nulls (CH-side issue, not in our codebase)
3. `marketValue: null` for cards that previously had non-null `fmv` from neighbor synthesis (that's the intentional change — neighbor synthesis was producing mislabeled output)
4. Drake Baldwin or similar thinly-traded autograph parallels returning null (documented limitation)

The distinction matters: ADR-0003's whole point is that null is honest output. Rollback should be triggered by actual breakage, not by reduced coverage that's by design.

## Rollback paths

### Path A: Full revert (preferred)

If the Phase 3 PR is causing the issue:

1. Revert the Phase 3 engine PR via the normal revert flow
2. Deploy the revert
3. Verify engine returns to pre-Phase-3 behavior (`fmv` field present, neighbor synthesis active, no `predictedPrice` field)
4. iOS app continues working against the old contract until investigation completes
5. Schema PR (SourceCitation variant) can stay — it's additive and not the source of any regression

Estimated wall time: 15-30 minutes depending on your deploy pipeline.

**Note:** The Phase 3 PR contains the `marketValue` rename, which is a contract change. Reverting restores `fmv` but if any client started writing/reading `marketValue` in the brief deploy window, those writes/reads will silently fail post-revert. Should be minimal exposure given the time scale.

### Path B: Partial revert (engine code only, keep schema variant)

If only the engine behavior is broken but the schema variant is fine:

1. Revert just the Phase 3 engine PR
2. Keep the SourceCitation schema PR merged (additive, harmless)
3. Same deploy + verify flow

### Path C: Hotfix forward (situational)

If the issue is small and obvious (e.g. one specific edge case in multiplier lookup):

1. Don't revert. Hotfix the issue.
2. Land hotfix PR, deploy, verify
3. Only viable if root cause is clear within ~30 minutes of detection

For anything else: roll back per Path A, fix in a follow-up PR, redeploy when ready.

## Pre-rollback verification

Before pulling the trigger on rollback, confirm:

1. **The issue is actually Phase 3's fault.** Sometimes a coincident issue (CH outage, infrastructure flake) gets attributed to a deploy that happened around the same time. Check CH status, infrastructure metrics, and unrelated PRs that landed nearby.

2. **A rollback will actually help.** If the issue is in a downstream consumer (iOS app) that has already updated for the new contract, rolling back the engine to the old contract may make things worse for that consumer. Check iOS deploy status before rolling back the engine.

3. **The rollback path is clean.** Git history doesn't have intervening commits that complicate the revert. If complications exist, hotfix-forward (Path C) may be the better option.

## Post-rollback steps

1. Document in `backend/docs/incidents/phase-c-rollback-{timestamp}.md`:
   - What was observed
   - Time-to-detection
   - Time-to-rollback
   - Root cause hypothesis
   - Confirmed root cause (after investigation)
   - Lessons learned

2. Coordinate with iOS team — let them know the contract is back to the old shape, and when to expect Phase 3 to re-ship.

3. Fix the root cause in a new PR. Add specific tests against the failure mode. Re-deploy when ready and validated.

4. Update Risk Register if the failure mode wasn't anticipated.

## What rollback does NOT undo

1. **Schema PR (SourceCitation variant)** stays merged. It's additive; reverting it would be a separate change. Not needed for rollback.

2. **Data writes to `parallel_attributes` Cosmos.** Phase B narrow-scope apply for Drake Baldwin (if executed pre-Phase-3-deploy) is data that lives in Cosmos. Rollback doesn't delete those records — they're harmless even if the engine reverts.

3. **Multiplier table extension data.** It's source code; revert removes it. New entries would need to be re-added in a follow-up PR.

4. **Continuation doc and ADRs.** These are docs; they document the journey. They stay regardless of code rollback.

## Communication plan

If rollback is executed:

1. **Engineering Slack / equivalent:** "Phase 3 rolled back due to [issue]. Engine back to pre-Phase-3 contract. Investigation in progress."

2. **iOS team specifically:** Direct message about which contract is now live so they can stop or pause any in-flight client updates.

3. **Stakeholders / product:** Brief note that Phase 3 is delayed pending fix. No need to over-explain unless asked.

## Pre-deploy gate

Before deploying Phase 3 engine PR, verify:

- [ ] This rollback plan has been read
- [ ] Whoever is on-call for the deploy has the revert command/process ready
- [ ] iOS team has a contact person reachable during the deploy window
- [ ] Deploy is happening during business hours (not Friday afternoon, not late at night) — if rollback is needed, people should be available

## Rollback simulation (optional but recommended)

Before the real deploy, consider a 5-minute "rollback drill":
- Identify the revert command for Phase 3 engine PR
- Identify the deploy command/process
- Estimate time-to-rollback start-to-finish
- Identify the verify step that confirms rollback succeeded

This isn't always practical but it converts rollback from a theoretical plan to a known-and-rehearsed procedure.
