# HobbyIQ-V1 Branches Reference

Last updated: 2026-05-19

## Active branches

### main
Production source of truth. PRs merge here.

### feat/cardsight-migration-clean
PR #60 — Cardsight migration (router-only, default off).
Lives in worktree: C:/temp/hobbyiq-cardsight-clean
Status: Open PR awaiting review/merge

### fix/issue-25-ch-autograph-identity
Single commit (8d5d71c) fixing CardHedge autograph prospect identity 
resolution. Affects every Bowman/Topps Chrome Prospect Autograph card 
in production. Not yet PR'd because Cardsight migration may supersede 
it. Re-evaluate after Cardsight rollout timeline is decided.

### pr/sourcecitation-schema
Single commit (b26fa1c) from May 17 adding worksheet-backed 
SourceCitation variants to parallels-reference. In-flight feature work; 
status unclear. May need to be PR'd or abandoned depending on 
parallels-reference roadmap.

### restore/preprod-deployed-state
DO NOT DELETE. Snapshot commit (1cb6f45) from May 14 preserving the 
fully-deployed source state before Phase 3 reconciliation triage. 
Contains 370 files including iOS Swift app, .vscode configs, 
.github workflows, .data, .gitignore. Acts as a canonical historical 
artifact and a recovery point.

## Active worktrees

- HobbyIQ-V1 (this directory) — detached HEAD, used for general work
- C:/temp/hobbyiq-cardsight-clean — PR #60's working directory

## Working tree status

V1's working tree carries ~176 uncommitted entries. ~148 of these are 
already committed on restore/preprod-deployed-state and represent 
the iOS app + supporting config. Remaining ~30 entries are either 
post-snapshot iOS work, misc backend, or genuinely uncommitted work 
that needs separate disposition.

## Cleanup history (2026-05-19 session)

Deleted 13 local branches matching already-merged PRs:
- chore/issue-33-gitignore-env-files (PR #47)
- chore/port-pricing-primitives-modules (PR #59)
- chore/regenerate-tier1-baselines-post-pr16 (PR #56)
- chore/gate-case-19a-pinnedIdHard-on-18 (merged earlier)
- chore/regime-classifier-fallback-source-override (merged earlier)
- chore/restore-issue-6-blockedby (merged earlier)
- docs/issue-33-parallels-reference-schema (merged earlier)
- docs/issue-33-schema-insert-sets (merged earlier)
- feat/cardsight-data-layer (PR #57 closed)
- feat/cardsight-engine-integration (PR #58 closed)
- feat/cardsight-pinned-routing (superseded by PR #60)
- feat/issue-25-phase-1-regime-classifier (merged earlier)
- feat/issue-25-phase-2-predicted-range (merged earlier)
- feat/issue-33-phase-2b-i-skenes-sample (merged earlier)
- feat/issue-33-phase-2b-iii-a-paginate-harness (merged earlier)
- feat/issue-33-phase-2b-iv-a-curation-harness (merged earlier)
- feat/tier1-corpus-seeding (merged earlier)
- ops/issue-33-cosmos-container-setup (merged earlier)
- pr/issue-24-display-original-comp-prices (merged earlier)
- pr/issue-6-grade-token-stripping (merged earlier)
- pr/issue-identify-shape-fix (merged earlier)
- pr/reconcile-deployed-source (merged earlier)
- pr/cat-c-slice-b-backend-preservation (PR #48 / #52)
- pr/schema-doc-phase-3-content (PR #46)
- pr/gitignore-log-artifacts (PR #47)
- pr/mechanism-1-normalization-fix (PR #45)
- pr/phase-3-contract-cleanup (PR #44)
- pr/phase3-engine (PR #43)
- pr-53-local (PR #53)
- revert/pr-45-canonicalization-overnormalization (PR #49)

Deleted 7 origin branches (same PRs).

Removed 6 worktrees (5 merged-PR worktrees + deploy-main).

Orphaned on disk (OneDrive lock prevented removal; cosmetic only): 
- C:/Users/.../HobbyIQ-deploy-main 
- .git/worktrees/HobbyIQ-deploy-main
