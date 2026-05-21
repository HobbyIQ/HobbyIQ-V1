# Phase 0 / Finding 10 — Canonical branch for `compiq-functions` source-of-truth

**Captured:** 2026-05-21 PM (Workstream C follow-up to W6 close-out Finding 10)
**Scope:** Read-only investigation. **Design-decision artifact** — agent investigates and proposes; agent does NOT execute any merge, branch, or PR operation. User decides.
**Time budget:** 45 min.

**Headline:** `origin/wip/snapshot-2026-05-20` (HEAD `5fad0a2`, 2026-05-20) is the candidate canonical source for the function-app subsystem. It is 6 days newer than `origin/restore/preprod-deployed-state` (HEAD `1cb6f45`, 2026-05-14) and **byte-identical in Python source content** — the only delta between the two branches inside `compiq-functions/` is committed `__pycache__/*.pyc` debris on `restore` that `wip-snapshot` doesn't have. 14/14 deployed functions' bindings/schedules match the branch source at the ARM-trigger layer. No CI/CD workflow exists that deploys the function app, which both explains the source-on-branch anomaly (no automation reason to keep `main` in sync) and reduces the lift of restoration. **Recommendation: Path A** (PR the branch's `compiq-functions/` tree back to `main` as a single source-restoration commit), with two explicit caveats — byte-level code drift is unverified in this scope (Kudu access blocked by AAD scope mismatch), and the restoration PR must decide what to do about two not-deployed feature functions present on the branch (`fn-player-score-refresh`, `fn-price-alert-checker`).

## 1. Branch comparison

### HEADs, authors, framing

| Branch | HEAD | Authored | Message |
|---|---|---|---|
| `origin/wip/snapshot-2026-05-20` | `5fad0a2e2e5f3312c4f94bf794dc8c4342506483` | 2026-05-20 10:23:39 EDT | "wip: snapshot of V1 working tree (2026-05-20)" |
| `origin/restore/preprod-deployed-state` | `1cb6f45db8b8266c10345e3169be16c372cb5803` | 2026-05-14 10:15:32 EDT | "snapshot: preserve currently-deployed source before reconciliation triage" |

Both authored by `HobbyIQ <drew@justtheboysandcards.com>`. Neither is an ancestor of the other for the `compiq-functions/` scope — each carries exactly one commit relative to the other inside `compiq-functions/` (its own snapshot commit).

### Source-content divergence inside `compiq-functions/`

`git diff origin/restore/preprod-deployed-state origin/wip/snapshot-2026-05-20 -- compiq-functions/` is **non-empty but trivial**:

- `compiq-functions/fn-nightly-comp-prefetch/__pycache__/function.cpython-314.pyc` — present on `restore`, absent on `wip-snapshot` (binary)
- `compiq-functions/shared/__pycache__/__init__.cpython-314.pyc` — same pattern
- `compiq-functions/shared/__pycache__/cardhedge.cpython-314.pyc` — same pattern

**Zero Python source files differ** between the two branches. The choice is content-equivalent for source-of-truth purposes; the differentiator is freshness (wip-snapshot is 6 days newer) and cleanliness (wip-snapshot doesn't carry committed bytecode debris — `.pyc` files should be `.gitignore`d but were apparently committed inadvertently on `restore`).

### Candidate selection

**`origin/wip/snapshot-2026-05-20` selected as the candidate canonical source.** Reasons:
1. 6 days newer than `restore`.
2. No committed `.pyc` debris.
3. Self-describes as "snapshot of V1 working tree" — broader scope; the author's intent appears to be capturing the full working state, not a narrow preprod snapshot.

For Path A (recommended below), the source-content equivalence means picking `restore` would produce an identical PR diff. For Paths B and C, recency matters and `wip-snapshot` wins.

## 2. Branch vs deployed reality — what's verified and what isn't

### Verified — ARM-trigger-binding alignment

`az functionapp function list -n fn-compiq -g rg-hobbyiq-dev` returned **14 deployed functions**, each with its trigger type and schedule. Cross-checked against `function.json` in each `fn-*/` directory on `origin/wip/snapshot-2026-05-20`:

| Function | Deployed (ARM) | Branch `function.json` | Match |
|---|---|---|---|
| fn-backtest-runner | timer `0 30 3 * * *` | timer `0 30 3 * * *` | ✓ |
| fn-cardhedge-comps | timer `0 0 2 * * *` | timer `0 0 2 * * *` | ✓ |
| fn-ebay-signals | timer `0 0 */4 * * *` | timer `0 0 */4 * * *` | ✓ |
| fn-news-signals | timer `0 45 */3 * * *` | timer `0 45 */3 * * *` | ✓ |
| fn-nightly-comp-prefetch | timer `0 30 2 * * *` | timer `0 30 2 * * *` | ✓ |
| fn-odds-signals | timer `0 30 */4 * * *` | timer `0 30 */4 * * *` | ✓ |
| fn-price-floor | http | http | ✓ |
| fn-reddit-signals | timer `0 0 */2 * * *` | timer `0 0 */2 * * *` | ✓ |
| fn-search-intent | http | http | ✓ |
| fn-serve-signals | http | http | ✓ |
| fn-signal-aggregator | timer `0 50 */2 * * *` | timer `0 50 */2 * * *` | ✓ |
| fn-stats-signals | timer `0 15 */2 * * *` | timer `0 15 */2 * * *` | ✓ |
| fn-trends-signals | timer `0 0 */6 * * *` | timer `0 0 */6 * * *` | ✓ |
| fn-youtube-signals | timer `0 15 */6 * * *` | timer `0 15 */6 * * *` | ✓ |

**14/14 alignment** at the trigger-type-and-schedule layer.

### Verified — behavioral consistency for one function

Workstream A independently verified that `fn-cardhedge-comps` (on `wip-snapshot`) accurately describes the deployed function's behavior: live HTTP call to `api.cardhedger.com`, writes to `compiq-signals/{slug}/cardhedge.json` with the expected schema, observed blob mtime `2026-05-21T02:00:13Z` matches the documented cron `0 0 2 * * *`. This is point evidence that the branch source matches deployed code-level behavior for at least one function.

### NOT verified — byte-level source drift

The spec called for downloading deployed source via Kudu `/api/zip/site/wwwroot/` and diffing. **Kudu access attempts in this scope returned HTTP 404** via `curl -H "Authorization: Bearer $TOKEN"` (ARM-scoped AAD token) at multiple paths (`/api/vfs/site/wwwroot/`, `/api/vfs/site/`, `/api/diagnostics/runtime`, `/api/zip/site/wwwroot/`). Basic auth attempts returned 401 because `az functionapp deployment list-publishing-credentials` returns redacted credentials in current CLI versions. `az rest` could not derive the correct AAD audience for the SCM endpoint automatically.

**Net unverified surface:** if any function on the branch differs at the byte level from what's currently deployed (e.g., a hotfix pushed directly to Kudu without committing back), this scope did not catch it. The ARM-trigger-binding match (Section 2 above) and the behavioral evidence for fn-cardhedge-comps narrow the unverified surface to: Python source content within each function dir, modulo the trigger config which IS verified.

**Mitigation if Path A is taken:** when crafting the restoration PR, run a smoke test against at least 2 timer-trigger functions other than fn-cardhedge-comps (e.g., fn-signal-aggregator, fn-nightly-comp-prefetch once its preconditions per Finding 6 are met) — compare blob output shape and write cadence before vs after a hypothetical re-deploy from the restored main. If output shape is unchanged, drift was minimal-to-zero.

## 3. Function inventory reconciliation — 14 deployed, 16 on branch

Both candidate branches carry 16 `fn-*` directories; 14 of those match the deployed set. The two extras:

### `fn-player-score-refresh` (timer `0 0 4 * * *`, 04:00 UTC)

Real implementation, not a stub. Per `__init__.py` docstring: "Nightly batch job (04:00 UTC) that refreshes PlayerIQ scores for every tracked player by POSTing to the TS backend's internal refresh endpoint." Calls `POST {COMPIQ_BACKEND_URL}/api/playeriq/refresh` with `x-admin-key: {BACKEND_ADMIN_KEY}` header. Backend handles all Cosmos writes; the function only kicks off batched requests.

**Status:** scaffolded + implemented, depends on backend route `/api/playeriq/refresh` existing (not verified in this scope). Not deployed to production. Not deprecated — feature work that hasn't been wired through.

### `fn-price-alert-checker` (timer `0 0 */6 * * *`, every 6 hours)

Real implementation, not a stub. Per `__init__.py` docstring: scans active price alerts every 6 hours, calls MCP `/predict/{cardId}` per alert, posts to TS backend `/api/alerts/internal/trigger` when threshold met, which sends APNs push + marks the alert triggered.

**Status:** scaffolded + implemented, depends on backend routes `/api/alerts/internal/all` + `/api/alerts/internal/trigger` and MCP `/predict/{cardId}` (none verified in this scope). Not deployed to production. Same status class as fn-player-score-refresh — deferred feature work, not abandoned scaffolding.

### Implication for any restoration PR

The restoration PR must take an explicit position on these two functions. Three sub-options:
- **Include source, do not deploy.** Keeps the work-in-progress visible on main; surface area for review but no production change.
- **Include source AND deploy.** Extends the deployed feature surface; out of scope for a "fix the source-of-truth gap" PR.
- **Exclude.** Either delete from the candidate branch before PR (rewrite history — invasive) or strip in the merge commit (also invasive). The cleanest exclusion is to PR everything and then have a follow-up cleanup PR that explicitly removes/disables what shouldn't be there.

## 4. Deployment-pipeline observation — explains the gap

`find .github/workflows -type f` returns 8 workflow files (`azure-appservice-deploy.yml`, `azure-deploy.yml`, `daily-refresh.yml`, `deploy-backend.yml`, `deploy.yml`, `main_hobbyiq3.yml`, `regression.yml`, `test.yml`). `grep -lE "compiq-functions|fn-compiq" .github/workflows/*.yml` returns **zero matches**.

**There is no CI/CD workflow that deploys the function app from `main`.** The function app must be deployed manually — presumably via `az functionapp deployment source config-zip` or `func azure functionapp publish` from a working tree. This both:

1. **Explains the source-on-branch anomaly.** With no automated reason for `main` to carry `compiq-functions/fn-*` source, the source naturally lives wherever the human deploying it has their working tree pointed.
2. **Reduces the lift of Path A.** Restoring source to `main` doesn't require also wiring up CI/CD; it just makes `main` the human-canonical reference for "what's in production." The actual deploy workflow can remain manual until/unless someone wants to add it.

## 5. Three paths forward — characterization only, no execution

### Path A — Source-restoration PR (recommended; see §6)

**What:** Open a PR that adds `origin/wip/snapshot-2026-05-20`'s `compiq-functions/fn-*` tree to `main` as a single commit. Title something like `chore(compiq-functions): restore deployed source to main`. After merge, `main` carries the canonical source; future function changes are normal PRs against `main`.

**Risks:**
- Byte-level drift between branch and currently-deployed wwwroot is unverified (Section 2). If drift exists, the PR encodes a stale state and the next `main`-based deploy regresses production.
- Must decide on the two not-deployed functions in the same PR (Section 3 implication).
- The `__pycache__/` debris from `restore` is correctly absent on `wip-snapshot` — if PR'd from `restore` instead, that debris would also land in `main`. (Reason to source from `wip-snapshot`, not `restore`.)

**Lift:** Low. One PR, no automation work, no copilot-instructions changes.

### Path B — Branch-as-canonical, split source-of-truth

**What:** Declare `origin/wip/snapshot-2026-05-20` (or `restore/preprod-deployed-state`) the canonical reference for `compiq-functions/` going forward. Update `copilot-instructions.md` and `docs/SESSION_HANDOFF.md` to point future readers at the chosen branch. Keep `main` for `backend/`, `mcp-server/`, `docs/`, and `compiq-functions/{shared,host.json,...}` only.

**Risks:**
- Split source-of-truth carries an ongoing cognitive load — every engineer must remember which subsystem lives on which branch.
- Branches drift over time without an explicit owner; the chosen canonical branch will not stay in sync with production unless human discipline maintains it.
- Tools (grep, codeql, GitHub code search) that scan only the default branch will miss the function code.

**Lift:** Low immediate (just docs), high ongoing.

### Path C — CI-driven sync from deployed reality

**What:** Set up a scheduled GitHub Action (or Azure Pipeline) that periodically downloads the deployed `wwwroot` via Kudu `/api/zip` + AAD auth, diffs against `main`, and either auto-PRs the delta or alerts if drift exists.

**Risks:**
- Highest implementation cost — requires resolving the Kudu AAD scope question first (Section 2 verification gap suggests this is non-trivial in current auth context).
- Automation drift: the CI job can break silently and the team learns about source-of-truth gaps only when the next manual deploy goes sideways.
- Doesn't solve the present-day gap; only prevents future divergence after it's set up.

**Lift:** High initial, then automated.

## 6. Recommendation

**Path A**, sourced from `origin/wip/snapshot-2026-05-20` (not `restore/preprod-deployed-state` — wip-snapshot is newer and lacks `.pyc` debris).

Reasoning, in priority order:

1. **Bindings are verified to match production 14/14 at the ARM trigger-and-schedule layer.** Combined with Workstream A's behavioral verification of fn-cardhedge-comps, the residual unverified surface is narrow.
2. **The branch is at most 1 day stale** vs the working tree that authored it (HEAD 2026-05-20; today 2026-05-21). The chance of significant unobserved drift is low.
3. **No CI/CD workflow deploys the function app**, so restoration doesn't have to interact with any automation. It's a purely documentary improvement.
4. **Lowest lift, lowest ongoing cost.** Path B is cheap today but expensive forever; Path C is expensive today and only valuable if deploys become git-driven later.
5. **Cosmos-key gap from Finding 6 / Workstream B is orthogonal** and gets addressed on its own track — Path A neither helps nor hurts that fix.

**Caveats on Path A execution (not actioned here):**
- Verify at least 2 additional timer functions' output shape before vs after the implied re-deploy (e.g., fn-signal-aggregator's `aggregated.json` schema; fn-ebay-signals's `ebay.json` schema). If output unchanged, byte-level drift is acceptably small.
- Decide explicitly on `fn-player-score-refresh` and `fn-price-alert-checker` in the same PR — pick one of the three sub-options in Section 3.
- Consider adding a `.gitignore` entry for `compiq-functions/**/__pycache__/` in the same PR to prevent future `.pyc` debris (the `restore` branch's bytecode files are a real signal that the working .gitignore doesn't cover this path).

## Anti-drift note

This document characterizes the source-of-truth gap and three remediation paths. It recommends one path with reasoning, but does not execute any merge, branch operation, or PR creation. Adoption of Path A (or any other path) is a user decision; this doc is the input to that decision, not the decision itself.
