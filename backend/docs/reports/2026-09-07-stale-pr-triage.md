# Stale open-PR triage — 2026-09-07

**Scope:** every OPEN PR older than 24 h, per go-live audit item **P2-1**
(`backend/docs/reports/2026-09-07-go-live-audit.md`). The audit counted 8 stale
PRs excluding #1909; this triage covers **9** — the audit's own list names nine
numbers (#1707, #1698, #1240, #1176, #1174, #1111, #1108, #835, #509), so "8"
was an off-by-one in the prose, not a missing PR. #1909 is included as a tenth
row because it is also >24 h old and is a live launch handoff.

**Method.** Mergeability is `git merge-tree --write-tree` against
`origin/main@8ec2c9ff` in a throwaway clone — not the GitHub `mergeable` field,
which reported `UNKNOWN` for six of these. Supersession is decided by reading
main's history for the same files and intent, then confirming the *shipped code
on main already contains the change*. Nothing was pushed to, closed, or
commented on. Read-only throughout.

**Bottom line: 4 CLOSE, 2 REBASE, 4 DREW, 0 MERGE.** No stale PR merges cleanly
*and* is still wanted without an owner call — every clean-merging one needs a
decision, and every still-wanted change conflicts. None of this blocks launch;
P2-1 is correctly a post-launch item.

---

## Summary

| PR | Age | Author | Area | Merges clean? | CI | Rec |
|---|---|---|---|---|---|---|
| [#1909](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1909) | 1d | HobbyIQ | ios + test | **yes** | green | **DREW** |
| [#1707](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1707) | 3d | HobbyIQ | src/scripts/docs | no — 6 files | fail (09-04) | **CLOSE** |
| [#1698](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1698) | 3d | HobbyIQ | src + test | no — 1 file | fail | **CLOSE** |
| [#1240](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1240) | 13d | HobbyIQ | src/scripts/ci | no — 7 files | none | **CLOSE** |
| [#1176](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1176) | 16d | HobbyIQ | src/scripts/ci | no — 2 files | fail (08-22) | **REBASE** |
| [#1174](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1174) | 16d | HobbyIQ | web | **yes** | fail (08-22) | **DREW** |
| [#1111](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1111) | 21d | HobbyIQ | ios | **yes** | none | **DREW** |
| [#1108](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1108) | 21d | HobbyIQ | docs + comment | **yes** | fail (08-17) | **REBASE** |
| [#835](https://github.com/HobbyIQ/HobbyIQ-V1/pull/835) | 42d | HobbyIQ | web | no — 3 files | green | **CLOSE** |
| [#509](https://github.com/HobbyIQ/HobbyIQ-V1/pull/509) | 52d | HobbyIQ | docs | **yes** | green | **DREW** |

Every PR is authored by the `HobbyIQ` bot account, so authorship does not
discriminate between them — age and supersession do.

---

## CLOSE — superseded, with the superseding commit named

### #1698 — "a seller store name is not a signature" (3d)

*Files:* `backend/src/services/catalog/attestationGuard.ts`, `backend/tests/attestationGuard.test.ts`.
*Conflict:* `attestationGuard.ts` (content).

**Superseded by `86c35c35` — "fix(autos): a shop name is not a signature —
102,621 base cards priced as autographs (#1767)".** Same defect, same corpus,
landed better. This PR widened the auto-in-title regex to bound `autograph` on
both sides (allowing only the real `s`/`ed` inflections) so `AutographDen` stops
reading as a signature. #1767 shipped exactly that boundary fix on the
**pool-side** parser and went further: it derived an explicit shop list from the
corpus for the residual shape the boundary cannot catch — a store name *ending*
in a real inflection — and it explicitly preserved `autographics`, Skybox's real
autograph insert set, which looks like a shop name and is not one. The
both-ends-boundary rule this PR argues for is the rule now in force.

Nothing is lost by closing. One thing worth a glance first: this PR edited
`attestationGuard.ts` (the *creation*-side guard) while #1767 edited the
pool-side regex. Confirm the guard's own pattern carries the boundary before
closing — if it does not, that is a fresh one-line PR against today's main, not
a rebase of a 3-day-old branch whose test file has since diverged.

### #1707 — "#1699 verified — the doctrine holds, the recovery number does not" (3d)

*Files:* 14 — src, scripts, data, checklists, tests.
*Conflicts:* `setkey-reconciliation.json`, `2026-09-03-setkey-reconciliation.md`,
`copy-static-data-to-dist.cjs`, `setKeyReconciliation.ts`, `hobbyIqCardId.service.ts`,
`setKeyReconciliation.test.ts`.

**Superseded by `1c637741` (#1699) and its follow-ons `d3cfff6c` (#1716),
`a135d378` (#1792), `2aa1f97d` (#1863), `041dbb31` (#1901).** Four of the six
conflicts are **add/add** — the tell that main already carries its own copy of
every file this PR introduces. Verified directly: `setKeyReconciliation.ts`,
`setkey-reconciliation.json`, the three `setkey-reconciliation/` scripts, the
gap-report JSON and the `2026-09-03` checklist are **all present on main**. The
PR's version of `setKeyReconciliation.ts` is 817 lines *behind* main's.

**One file is genuinely novel:**
`backend/docs/checklists/2026-09-04-verify-1699-setkey-reconciliation.md` — the
adversarial verification write-up whose finding is in the PR title: the doctrine
held but the claimed recovery number did not. That finding has value and is
nowhere else in the repo.

*Recommendation:* close the PR, but **first cherry-pick that single doc** onto a
fresh branch — it applies cleanly, being an add against a path main does not
use. Do not attempt to rebase the other 13 files; they are 250 commits stale and
would re-litigate five merged PRs.

### #1240 — "a grade is not a card number, and base is not a default" (13d)

*Files:* 12 — src, scripts, tests, `backfill-runner.yml`.
*Conflicts:* `backfill-runner.yml`, `ingestBaseballCardPedia.cjs` (modify/delete),
`retire-flattened-attestations.cjs`, `attestationGuard.ts`,
`parseTitleIdentity.service.ts`, `attestationGuard.test.ts`,
`parseTitleIdentity.test.ts`.

**Superseded by `5f3ecceb` — "fix(catalog): a grade is not a card number, and
base is not a default (#1241)", which carries this PR's exact title.** #1240 and
#1241 were the same change; #1241 merged and #1240 was left open.
`canonicalCardName.ts`, `retire-flattened-attestations.cjs` and
`standalonePrefixedCardNumber.test.ts` are all on main already.

The clincher is the modify/delete conflict:
`backend/scripts/ingestBaseballCardPedia.cjs` was **deleted from main** by
`9fd1de46` ("delete the dead card_catalog writers — sales never mint, vendor
feeds never mint", D5 PR 5, #1436). This PR modifies a script the architecture
has since retired, consistent with the card_catalog-domain retirement. Its other
two scripts (`attest-unnumbered-by-player.cjs`,
`resolve-sales-without-identity.cjs`) are also absent from main — same
retirement. Close; there is nothing here to salvage against today's tree.

### #835 — "wire HobbyIQ logo + icon PNGs into brand mark" (42d)

*Files:* 6 — `apps/web` PNGs + `AppShell.tsx`, `Brand.tsx`, `MarketingHeader.tsx`.
*Conflicts:* all three components (`Brand.tsx` is add/add).

**Superseded by `c35fcc05` ("Sprint 3: web eBay integration + brand PNGs
(#836)") and `073c4553` ("feat(web): full HobbyIQ design system + strip
Cardsight/CardHedge from UI (#863)").** The assets this PR wires —
`apps/web/public/hobbyiq-icon.png` and `hobbyiq-logo.png` — are already on main,
and main's `Brand.tsx` already loads them from `/public` with an `onError`
fallback to the hero-stroke wordmark. Its header comment documents the exact
asset paths this PR was written to introduce. The intent shipped 42 days ago in
the very next PR number. CI is green only because the branch is old, not because
it is current.

---

## REBASE — still wanted, conflicting

### #1176 — "CH fan-out walked 8 years nightly; backfill deadlocked on one date" (16d)

*Conflicts (2):* `backend/src/services/portfolioiq/priceFromOurPool.service.ts`,
`backend/tests/observedNeedsComps.test.ts`.

**Half of this PR is superseded; the other half is not — which is exactly why it
conflicts.**

*Superseded half.* The pricing fix — a three-comp floor so a broad rung with one
stray comp publishes as an *estimate* rather than an observed FMV — **is already
on main**, at `priceFromOurPool.service.ts:105`, landed by `ec29a24b`
("fix(portfolio): one comp from another set was publishing as observed FMV
(#1175)") and refined by `1714a064` (#1473). #1175 was this PR's sibling and
merged. Both conflicting files are the superseded half, and
`observedNeedsComps.test.ts` is an add/add against main's own copy.

*Live half.* The CH-backfill deadlock fix is **not** on main:
`backend/tests/chBackfillPoisonPill.test.ts` does not exist there, and the
+98/+37 lines in `chHistoricalBackfill.service.ts` /
`chHistoricalBackfillStore.service.ts` — a poison-pill escape so one bad date
cannot pin the cursor forever — have no equivalent. Main's cursor logic still
reads "an incomplete day must NOT advance the cursor", which is precisely the
deadlock. The `ch-fanout-to-sold-comps.yml` narrowing (stop walking 8 years
nightly) is also unshipped.

*Recommendation:* **REBASE, dropping the pricing half.** Take only
`chHistoricalBackfill.service.ts`, `chHistoricalBackfillStore.service.ts`,
`chBackfillPoisonPill.test.ts`, `ch-fanout-to-sold-comps.yml` and
`bulk-import-ch-daily-to-sold-comps.cjs` onto a fresh branch; abandon
`priceFromOurPool.service.ts` and `observedNeedsComps.test.ts` to main. That
drops both conflicts to zero. This touches `backend/src`, so it needs a "Daily
5AM ET Refresh & Deploy" dispatch after merge. Worth doing: CH is the volume
source, and the audit shows a live catch-up backfill running ~6x baseline.

### #1108 — "verify-queue is telemetry with a retention policy, not a work queue" (21d)

*Files:* `backend/docs/decisions/ADR-verify-queue-is-telemetry-2026-08-17.md` (new),
`backend/src/services/portfolioiq/verifyQueue.service.ts` (comment only).
*Merges clean.* CI red since 2026-08-17.

Listed as REBASE rather than MERGE **only because of its CI**, and the red is
almost certainly stale rather than caused: the code change is a 24-line **block
comment**, with no executable statement touched. A 21-day-old red on a
comment-only diff is a main-drift artifact of the kind the chronic-red reference
documents, not a defect in this PR.

The content is still true and still useful. It records that verify_queue held
2,426,514 pending rows against 2,748 ever actioned (0.11%) at ~229,000/day
inflow — so the 60-day TTL is the only thing bounding it, and no feature should
assume humans drain it. Main has **no** ADR on this (only the two 2026-05-18
ADRs), and `verifyQueue.service.ts` has not been touched since `892216d3`
(#1105), so the comment still lands where it was written to land. verifyQueue is
a place people look when chasing admin-gate problems; the ADR is worth having
beside it.

*Recommendation:* push an empty rebase onto current main to re-trigger CI. If it
goes green — expected — this becomes a **MERGE**. Docs + comment only, so no
deploy dispatch is required.

---

## DREW — needs the owner

### #1909 — "the engine names the card — three views stop composing their own title" (1d)

*Files:* five `HobbyIQ/*.swift` + `backend/tests/cardPanelRoute.test.ts`. Merges
clean; both checks green.

**Not a defect — a handoff**, already tracked by the audit as P1-4. iOS changes
need an Xcode build that cannot run here. This is the launch-relevant one: it
makes three views read the engine's display name instead of composing their own
title, which is the client half of `6f3a35bc` ("a card is named once — the year
stops appearing twice", #1904) already on main. Leaving it unmerged is correct
until Drew builds it.

### #1111 — "Portfolio Breakdown — a thin client of the server analysis" (21d)

*Files:* five `HobbyIQ/*.swift`. Merges clean; no CI (iOS paths trigger no workflow).

**Not superseded and not blocked.** All three new views are absent from main, so
nothing has replaced it. The dependency checks out: the client calls
`/api/portfolioiq/breakdown`, and that route **exists on main** at
`backend/src/routes/portfolioiq.routes.ts:235`
(`router.get("/breakdown", portfolio.getPortfolioBreakdown)`), mounted at
`/api/portfolioiq` in `app.ts`. So the server half shipped and only the client is
waiting — the PR's "thin client" framing is accurate.

Needs Drew for two reasons: an Xcode build, and a product call on whether
Portfolio Breakdown belongs in the launch build or the release after. 21 days
stale but clean-merging, so the cost of deferring is low.

### #1174 — "teach people how to use the app, not just how to set it up" (16d)

*Files:* `apps/web/src/app/app/guide/page.tsx` (new, 288 lines),
`welcome/page.tsx`, `lib/navigation.ts`. Merges clean. `Build + Deploy` failed
2026-08-22.

Not superseded: main has `app/welcome/` but **no `app/guide/`**, and
`navigation.ts` has no guide entry. The 288-line guide page is unbuilt content
that still has a hole to fill.

Needs Drew because it is a **content and product decision, not a code one** —
whether a user-facing guide ships at launch, and whether its copy is right, is
his call rather than something to infer. Practically: re-run the build first,
since a 16-day-old `Build + Deploy` red on a Next.js page may be stale (main's
web deploys are green per audit item 9), then let Drew review the copy.

### #509 — "Phase 2 design — reference library + attribution confidence scoring" (52d)

*Files:* one design doc. Merges clean; CI green; `mergeStateStatus: BLOCKED`
(awaiting review, not a failure).

The oldest PR, and **not obsolete** — which is the surprise here. Its stated
prerequisite is live: Phase 1's phash infrastructure is on main
(`backend/src/services/attribution/phashCluster.service.ts`,
`phashOrchestrator.service.ts`, `phashStore.service.ts`, plus
`imageSimilarityLookup.service.ts`), and the Phase 1 design doc sits in
`backend/docs/design/`. No Phase 2 work has landed since. So this is a coherent
unbuilt roadmap, not a stale one.

The doc's own status line asks for the decision: *"design draft (2026-07-17).
Awaits Drew review before code lands."* That is a product-roadmap call — does
per-sale attribution confidence get built, given the catalog-first direction the
last two months actually took? Merging the doc as a draft costs nothing and
records the thinking; closing it discards a worked design. **Drew decides
which.** If it merges, mark it explicitly as a parked design so it is not read as
committed roadmap.

---

## Notes for whoever executes this

- **Nothing here blocks launch.** P2-1 is post-launch hygiene; the
  launch-relevant PR is #1909, and it is a handoff, not a blocker.
- **Order matters for the two salvages.** Cherry-pick #1707's verify doc and
  split #1176's CH half *before* closing anything, so no work is lost between
  the close and the re-open.
- **#1176 is the only recommendation that touches `backend/src`** and therefore
  the only one needing a "Daily 5AM ET Refresh & Deploy" dispatch after merge.
- **Two reds are worth re-running before believing them** (#1108, #1174). Both
  are 16+ days old against a main that has moved 750+ commits; neither diff
  plausibly breaks a backend unit test.
- Six of these ten reported `mergeable: UNKNOWN` on the GitHub API. GitHub
  computes that lazily and had not refreshed it for branches this stale — the
  local `merge-tree` results above are the authoritative answer.
