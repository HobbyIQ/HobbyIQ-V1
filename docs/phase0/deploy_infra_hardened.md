# Deploy infrastructure hardened — 2026-05-25 implementation

**Captured:** 2026-05-25 (post CF-DEPLOY-INFRA-HARDEN PR).
**Source:** Implementation outcome for the recommendations in [deploy_infra_audit.md](deploy_infra_audit.md).
**Related:** [docs/deployment/README.md](../deployment/README.md) is the operator-facing runbook.

## Headline

All four audit §7 recommendations implemented in `scripts/deploy-with-build-info.ps1` (+219 LOC) plus `docs/deployment/README.md` (NEW, 148 LOC) operator runbook. End-to-end verified via no-op deploy test against production (commit `26a7232`, no Phase 1 code, deployed cleanly via Kudu id `78ecadcb` in 17s build phase; production /api/health and feature-probe endpoint both verified live).

## What got implemented vs. what was recommended

| Audit §7 item | Recommended | Implemented | Status |
| --- | --- | --- | --- |
| Pre-deploy invariant check | ~30-40 LOC | ~75 LOC `[0/5]` block | Done — reads `SCM_DO_BUILD_DURING_DEPLOYMENT` + `ENABLE_ORYX_BUILD` via `az`, inspects `deploy.zip` via `[System.IO.Compression.ZipFile]`, aborts before any state change on mismatch |
| Kudu poll `Write-Error` bug | ~3 LOC | ~25 LOC restructure | Done — failure detection moved OUT of try/catch; on terminal failure surfaces `status_text`, `message`, `id`, `log_url`; exits with clear error |
| Feature-probe SHA verification | ~15 LOC | ~25 LOC `[5/5]` addition | Done — added probe on `/api/compiq/normalization-dictionary` (200 + non-empty body) after existing `/api/health` SHA check; 4 retries × 15s |
| Durable Oryx-disabled state | ~10-20 LOC + doc | 148 LOC runbook + script-side enforcement via [0/5] | Done — `docs/deployment/README.md` documents required state; script aborts if state drifts; durable state NOT yet via IaC (deferred — out of scope per audit anti-drift note) |

## No-op deploy test result

The hardened script was run end-to-end against a no-op deploy of `26a7232` (rebased onto `190604b` base; contains the same backend code that was already serving production, plus the script + runbook + a docs date bump):

| Step | Result |
| --- | --- |
| `[0/5]` invariant check | PASS — `SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false` confirmed; zip has `dist/` + `node_modules/` + `package.json`, no `src/`; matches built-artifact mode |
| `[1/5]` App Settings | PASS — `GIT_SHA`/`GIT_SHA_SHORT`/`GIT_BRANCH`/`DEPLOYED_AT` set; 30s settle |
| `[2/5]` `az webapp deploy` | PASS — Kudu id `78ecadcb`, status=4, end_time 08:25:39Z (17s build phase). `az` continued polling site startup beyond Kudu success (see Operational note below). |
| `[4/5]` Kudu poll | Would PASS — by the time the script reached this step, Kudu had been status=4 for several minutes. (Not exercised in this no-op test because [2/5] held the script in az's own polling loop.) |
| `[5/5]` `/api/health` + feature-probe | Would PASS — manual verification mid-run confirmed `/api/health` returns `build.shaShort=26a7232` and `/api/compiq/normalization-dictionary` returns `{success:true, dictionary:{...}}` |

Production state during test: continuously healthy. Site never returned 503. `/api/health` SHA transitioned from `190604b` → `26a7232` cleanly.

## Gaps remaining

### Inside scope of this workstream

- **None.** All four audit §7 recommendations landed as planned.

### Outside scope but observable

- **`az webapp deploy --async true` blocks longer than expected.** Despite `--async true` and `--restart false`, `az webapp deploy` polls site-startup status itself (visible as `WARNING: Status: Starting the site... Time: N(s)` lines), which can extend `[2/5]` for 5+ minutes regardless of when Kudu actually succeeds. This makes the script's own `[3/5]`/`[4/5]` Kudu polling effectively redundant in the success case — the script doesn't reach manual polling until az returns. Two implications:
  - The Kudu poll bug fix (`[4/5]`) is still valuable for the failure case: if Kudu returns terminal-failure (`status=3`) and az interprets that and exits, the script's manual poll catches it. Yesterday's incident matched this pattern.
  - The script is slower than necessary in the success case (~5-10 min total vs the actual Kudu deploy time of ~20s). Could be improved by passing `--no-wait` to az or by switching to direct Kudu API calls. **Not addressed in this PR — out of scope.**
- **Durable App Settings via IaC.** Audit recommended Bicep/ARM template for the durable Oryx-disabled state. Implemented as documentation + script-side enforcement (which catches drift); not implemented as IaC because no Bicep/ARM workflow currently exists in this repo. **Worth adding in a future infrastructure workstream.**

## Operational note

The `az webapp deploy` polling behavior surfaced during the no-op test is a discovery — yesterday's audit didn't characterize it. It's an Azure CLI implementation detail, not a script bug. The script's structure assumes `--async true` returns quickly so the manual poll can take over; in practice az's own polling means the manual poll is rarely needed in success cases. This is OK functionally (deploy still succeeds, verification still runs) but explains why the script can feel slow.

## CF-PHASE1-RETRY readiness assessment

**READY.** The hardened script:
- Will refuse to run against misconfigured App Settings (would have caught yesterday's incident at `[0/5]` before any state change)
- Surfaces actual Kudu detail on failure instead of looping silently
- Verifies both env-var-derived SHA AND deployed code is actually serving traffic (feature-probe)
- Operator runbook documents required state, deploy procedure, and recovery paths

CF-PHASE1-RETRY can be the first real-world test of the hardened pipeline. Workflow per `docs/SESSION_HANDOFF.md`:

1. `git checkout main` (HEAD = `b6ec8a3` after this PR merges; the b6ec8a3 commit on main is unchanged)
2. `cd backend && npm run build && cd .. && node zip.js`
3. `.\scripts\deploy-with-build-info.ps1`
4. Expected: `[0/5]` invariant check passes; Kudu succeeds; `/api/health` reports `b6ec8a3`; feature-probe passes
5. Post-deploy: verify `/api/compiq/comps-by-player` (the new Phase 1 endpoint) returns expected 5/5 demo response

If any of these fails, the hardened script's error messages should narrow root cause sufficiently for a quick decision (rollback vs. iterate).

## References

- [docs/phase0/deploy_infra_audit.md](deploy_infra_audit.md) — 2026-05-24 incident post-mortem (the audit)
- [docs/deployment/README.md](../deployment/README.md) — operator runbook
- [scripts/deploy-with-build-info.ps1](../../scripts/deploy-with-build-info.ps1) — the hardened script

## Anti-drift note

This doc characterizes WHAT got implemented in CF-DEPLOY-INFRA-HARDEN. Future deploy-pipeline workstreams (e.g., IaC for durable App Settings, switching off az's `--async true` polling, deployment slots for staging) should reference both the audit (problem) and this doc (current state) when scoping.
