# HobbyIQ Session Handoff — 2026-05-21

(updated end of multi-session day spanning 2026-05-20 → 2026-05-21)

## Production state

- HobbyIQ3 (Azure App Service, rg-hobbyiq-dev, Central US)
- URL: https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net
- Deployed SHA: cf7d48b1a1cc0c8969b851c11d09460a0c58c9ba
- CARDSIGHT_MODE: exclusive

## Origin/main HEAD

- Current: 8476e0d (PR #97 merge — PR C complete)
- Backend deployed is intentionally one step behind iOS — backend at cf7d48b ships PR #89/#90/#91 which are PR C preconditions. PR C itself is iOS-only.

## What shipped this session (2026-05-20 → 2026-05-21)

### Backend deploy
- Caught up HobbyIQ3 from 0f425af (PR #84) to cf7d48b
- This deployed PR #89 (photo SAS endpoint), PR #90 (photos/clientId Codable on PortfolioHolding), PR #91 (PortfolioSyncService skeleton) which were merged but not yet live

### Step 1 — CompIQ smoke test
- Decode test landed (commit ead4464)
- Confirmed effectiveFmv, holdZone, sellZone Phase 3 fields decode from deployed backend
- No render surface yet — Phase 3 UI is future work (PR F or later)

### PR C — Full sync layer for InventoryIQ
- PR #92 (C.1): Schema additions — pendingSyncFields, deletedAt, SyncIntent model
- PR #93 (C.2): Mapper implementations + pendingSyncFields guard + delete API
- PR #94 (C.3): Pending-write guard + soft-delete tombstone support
- PR #95 (C.4): SyncIntent queue processor with tombstone cleanup
- PR #96 (C.5): Auth integration — sync lifecycle + @Observable state
- PR #97 (C.6): Wire SwiftData ModelContainer + sync into app lifecycle

### Test infrastructure
- HobbyIQTests target added to Xcode project and scheme (this session)
- Stale scheme references cleaned up (removed phantom HobbyIQUITests, updated HobbyIQTests UUID)
- Removed stale test files that referenced deleted APIs: DailyIQServiceTests, APIServiceTests, PortfolioIQViewModelTests, PortfolioWorkspaceViewModelTests, HobbyIQTests (Xcode template)
- Added @MainActor to CompIQDecodeTests and PortfolioSyncMapperTests for Swift 6 concurrency compliance
- Existing tests: CompIQDecodeTests (6 tests), PortfolioSyncMapperTests (9 tests) — all 15 passing on main
- Missing tests (deferred to next session): SyncSchemaTests, PendingWriteGuardTests, SyncQueueTests, AuthSyncIntegrationTests

### Manual smoke test
- NOT EXECUTED — agent cannot drive simulator UI (auth gate blocks programmatic testing)
- App builds, installs, and launches on iPhone 17 Pro simulator without crash
- User must run the 5-step smoke test manually before PR D begins:
  1. Add a card via InventoryIQ, verify it syncs to backend
  2. Edit card notes, verify backend reflects change
  3. Delete card, verify backend removal + local hard-delete
  4. Airplane mode: add card offline, re-enable network, verify sync
  5. Airplane mode: delete server-extant card offline, re-enable, verify sync

## What this session's "pragmatic green" actually means

- Code is merged and builds clean: YES
- Test scheme can now run tests: YES
- Existing 2 test classes (15 tests) pass: YES
- Manual smoke test executed: NO (user gate)
- 4 expected test classes were never created: out of scope this session, queued for next

This is "pragmatic green," not "full green." The sync layer mapper logic is unit-tested, the app compiles and launches, but end-to-end sync verification via manual smoke test is pending user execution.

## Lessons captured (from this session)

### Operational
- `scripts/deploy-with-build-info.ps1` is the documented deploy path. Naive `az webapp deploy ... --restart true` triggered a restart-race that froze deployment on 2026-05-20. The script does async deploy + Kudu poll + single restart. Always use it.
- `az webapp deploy` may report "Site failed to start within 10 mins" and exit 1 while the deploy is actually fine. Trust Kudu's `complete=true, status=4` + /api/health gitSha match over az CLI exit code.
- Issue #85 (build.shaShort cosmetic mismatch) affects workflow-deploys only. Script-deploys set GIT_SHA_SHORT explicitly and are not affected.

### iOS / Swift
- SwiftData does NOT support `Set<String>` — use `[String]` for pendingSyncFields (or any collection property).
- `@Observable` (Observation framework) is preferred over `ObservableObject + @Published` — avoids Combine dependency.
- When adding a test target to an Xcode project using `PBXFileSystemSynchronizedRootGroup` (objectVersion 77), adding via Xcode GUI (File > New > Target > Unit Testing Bundle) is the correct approach — auto-discovers test files from disk.
- Test classes need `@MainActor` when calling into `@MainActor`-isolated code (like `PortfolioSyncService` static methods) in Swift 6 strict concurrency mode.
- `IPHONEOS_DEPLOYMENT_TARGET` for test target defaults to latest SDK (26.2) — may need alignment with app target (17.0) if testing on older simulators.

### Process
- Verify-first discipline caught real issues at Step 0 (working tree divergence, backend lag) and during PR C verification (test coverage gaps).
- "Test verified via ExecuteSnippet" is NOT equivalent to "test runs in xcodebuild test." Be explicit about which when reporting.
- Test class names should match verification spec to avoid audit confusion (e.g. PortfolioSyncMapperTests vs SyncMapperTests).
- gh CLI is not installed on the Mac machine — use git push + GitHub REST API via curl when PR operations are needed from Mac.
- Stale test files from earlier project iterations can block the entire test target from compiling. Always verify compilation after adding a test target.

## Deferred items (do not pursue without explicit instruction)

- Write 4 missing test classes: SyncSchemaTests, PendingWriteGuardTests, SyncQueueTests, AuthSyncIntegrationTests
- Manual 5-step smoke test execution (user gate)
- Issue #85 build.shaShort cosmetic mismatch (workflow-deploy scope only)
- GitHub Actions Node.js 20 deprecation (June 2, 2026 deadline) — ~2 weeks
- storage.bicep cleanup (drifted from deployed state)
- V1 working tree decision (frozen reference at 169 entries vs delete)
- fix/issue-25-ch-autograph-identity branch (1 unmerged commit, may be moot post-Cardsight)
- LOCAL_NOTES.md untracked in C:/dev/hobbyiq-main — stash/commit/gitignore decision pending
- C:/temp/hobbyiq-cardsight-clean has deploy.zip (~82 MB) — can be deleted
- C:/temp/hobbyiq-dailyiq-diffcheck worktree — consider git worktree remove if truly done

## PR D — eBay listing from inventory (NEXT)

### Pre-PR-D gates
- All 5 manual smoke test scenarios green: NO (not yet executed)
- 4 missing test classes ideally landed first, OR explicit decision to defer

### Open questions to resolve in next session's Step 0

- What eBay backend endpoints already exist? Audit:
  - Search backend for `/api/ebay/*` routes
  - Identify: OAuth callback, listing creation, listing status webhook, "card sold" webhook -> portfolio sync
- What's the iOS scaffolding state? Handoff notes EBayOAuthCoordinator, EbayConnectView, EbayListingDraftView exist. Confirm.
- Is there an eBay sandbox account configured for testing? If not, that's a setup task before any meaningful PR D work.

### Likely PR D sequencing (subject to Step 0 findings)

- PR D.1: Backend audit + any missing eBay endpoints
- PR D.2: OAuth flow end-to-end
- PR D.3: Listing draft creation from InventoryIQ card
- PR D.4: Listing submission + status tracking
- PR D.5: "Card sold" webhook -> portfolio sync (consumes the sync layer from PR C)

### PR D environment

- Likely starts on Windows for backend audit (Step 0)
- Bulk of PR D is Mac (iOS UI work)
- Cross-machine — plan to switch contexts mid-PR-D

## Snapshot branches on origin (safety nets, do not delete)

- wip/snapshot-2026-05-20 (Windows V1 working tree at 5fad0a2)
- wip/mac-snapshot-2026-05-20 (Mac working tree at 58e09a6)

## Worktree state (cross-machine)

### Windows
- C:/dev/hobbyiq-main at 8476e0d (post PR-#97). Clean except LOCAL_NOTES.md untracked.
- C:/temp/hobbyiq-cardsight-clean at cf7d48b or 8476e0d (depending on whether re-pulled). Has archiver installed for deploys.
- C:/temp/hobbyiq-dailyiq-diffcheck — likely stale
- V1 frozen reference at C:/Users/dvabu/OneDrive.../HobbyIQ-V1 — DO NOT TOUCH

### Mac
- /Users/drew/Desktop/HobbyIQ at 8476e0d (will advance with this commit)
- xcode-select: /Applications/Xcode.app/Contents/Developer (Xcode 26.3)
- gh CLI: NOT installed — use git + GitHub REST API via curl
- Simulators: iPhone 17 Pro (iOS 26.1, 26.3.1), no iPhone 15/16
- Clean BUILD SUCCEEDED + 15/15 tests passing on current main

## PR D Step 0 findings (2026-05-21)

Read-only audit of eBay backend, iOS scaffolding, and Azure config performed
on Windows from `C:/dev/hobbyiq-main` at commit 0511ed6. No code changed.

### Backend state — substantially built

`/api/ebay/*` is mounted in `backend/src/app.ts` (line 53) and the route
file `backend/src/routes/ebay.routes.ts` defines 10 endpoints:

| Method | Path | Handler | State |
|--------|------|---------|-------|
| GET | `/api/ebay/status` | getConnectionStatus | implemented |
| GET | `/api/ebay/connect/start` | buildAuthUrl | implemented |
| GET | `/api/ebay/connect/restart` | disconnect+buildAuthUrl | implemented |
| GET | `/api/ebay/connect/callback` | handleCallback → deep link | implemented |
| DELETE | `/api/ebay/disconnect` | disconnect | implemented |
| GET | `/api/ebay/policies` | getSellerPolicies | implemented |
| POST | `/api/ebay/listings/preview` | buildListingPreview | implemented |
| POST | `/api/ebay/listings/publish` | createListing | implemented |
| PUT | `/api/ebay/listings/:offerId/revise` | reviseListing | implemented |
| POST | `/api/ebay/listings/:offerId/end` | endListing | implemented |
| GET | `/api/ebay/listings/:offerId/status` | getOfferStatus | implemented |

Plus two convenience endpoints in `portfolioiq.routes.ts` that wrap the
same services:
- `POST /api/portfolioiq/holdings/:id/ebay/draft`
- `POST /api/portfolioiq/holdings/:id/ebay/listing`

All endpoints are guarded by `x-session-id` (existing HobbyIQ auth pattern).

### Services

- `backend/src/services/ebay/ebayAuth.service.ts` (9.2 KB) — OAuth 2.0
  authorization-code flow, HMAC-signed self-contained `state` parameter (no
  server-side store), token refresh, sandbox/prod switch, Identity API
  username fetch on `apiz.{sandbox.}ebay.com`.
- `backend/src/services/ebay/ebayListing.service.ts` (9.9 KB) — Inventory
  + Offer + Publish flow, plus revise/end/status/sellerPolicies and a
  no-network `buildListingPreview()` for drafts.
- `backend/src/services/ebay/ebayTokenStore.service.ts` (18 KB) — dual
  storage: Cosmos `ebay_connections` container (partition `/userId`) with
  flat-file fallback at `.data/ebay-tokens.json`. Survives restarts.

No SDK/client class — all calls go via native `fetch()`. No
`EbayClient`/`EbayApi` abstraction.

### Webhook state — NOT BUILT

No `/api/ebay/webhook` route. No marketplace-account-deletion handler
(eBay compliance requirement). No item-sold notification listener.
This is the only meaningful backend gap.

### iOS scaffolding — present in `HobbyIQ/`

- `EbayConnectView.swift` (3.3 KB) — connect/disconnect button UI
- `EBayOAuthCoordinator.swift` (12 KB) — ASWebAuthenticationSession driver
- `EbayListingDraftView.swift` (32 KB) — substantial draft form UI

These match what the prior handoff noted. None inspected for wiring
correctness in this session — that's iOS-side work for a Mac session.

### Azure App Settings on HobbyIQ3 (names only, no values)

Present:
- `EBAY_APP_ID`, `EBAY_CERT_ID`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`,
  `EBAY_REDIRECT_URI`, `EBAY_ENV`, `EBAY_MARKETPLACE_ID`,
  `EBAY_SPORTS_CARDS_CATEGORY_ID`
- `EBAY_AUTH_TOKEN`, `EBAY_BROWSE_TOKEN` (legacy comp-fetch tokens,
  separate from listing flow)

**Missing — required by `ebayListing.service.ts` to publish:**
- `EBAY_PAYMENT_POLICY_ID`
- `EBAY_RETURN_POLICY_ID`
- `EBAY_FULFILLMENT_POLICY_ID`

Without these, `policyIds()` returns empty strings and the publish call
will fail at eBay's Sell API. They are seller-account-specific IDs that
must be looked up from the eBay seller hub (or via
`GET /api/ebay/policies` once OAuth is connected — that endpoint is
implemented and reads them from the user's eBay account).

### Sandbox configuration

`EBAY_ENV` is set on HobbyIQ3 (value not inspected — could be sandbox or
production). Code defaults to sandbox if unset. Sandbox URLs are hardcoded
in `ebayAuth.service.ts` (`auth.sandbox.ebay.com`, `api.sandbox.ebay.com`,
`apiz.sandbox.ebay.com`).

### Revised PR D sequence

The original speculative D.1 ("backend audit + any missing eBay endpoints")
is largely complete. The bulk of the listing path is built and deployed.
Revised plan:

- **D.1 (env config, ~5 min):** OAuth-connect a sandbox eBay seller account
  to HobbyIQ via the existing `/api/ebay/connect/start` flow, call
  `/api/ebay/policies` to discover the 3 policy IDs, then set
  `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`,
  `EBAY_FULFILLMENT_POLICY_ID` via `az webapp config appsettings set`.
  No backend code change. Could also be skipped if the publish flow is
  reworked to call `/api/ebay/policies` at publish time and inject IDs
  inline (~30 min backend tweak).
- **D.2 (Mac):** Smoke-test OAuth end-to-end on simulator against sandbox.
  UI + backend exist; this is verification, not implementation.
- **D.3 (Mac):** Wire `EbayListingDraftView` to `/api/ebay/listings/preview`
  and confirm the draft renders correctly from a real PortfolioHolding.
- **D.4 (Mac):** Wire publish/revise/end/status into the listing draft UI.
  Backend complete; iOS UI + state management only.
- **D.5 (Windows backend + Mac iOS):** Add `POST /api/ebay/webhook`
  receiver. Two payload types: marketplace-account-deletion (compliance,
  must respond 200 within 24h of receipt) and item-sold notification
  (translates to `PortfolioSyncService` → `markSold`/`delete`). This is
  the only net-new backend code in PR D.

**First step recommended:** Mac. PR D.2 OAuth smoke test against the
already-deployed cf7d48b backend, using whatever sandbox seller account is
already configured. If the smoke test hits a missing-policy error during
publish (PR D.4), come back to Windows for D.1 env config.

### Smoke test reminder (still outstanding)

The 5-step manual InventoryIQ sync smoke test from PR C is **still not
executed**. It remains a precondition for declaring PR C fully green and
should run before PR D iOS work begins on Mac.

## Style and operating preferences

- Honest, direct communication
- Verify-first discipline (caught multiple real issues this session)
- Surgical staging with explicit file lists
- HALT gates between sub-steps when running multi-PR sequences
- Push back on scope creep with reasoning
- Capture lessons in this handoff before they fade
- xcodebuild gate for iOS, /api/health gate for backend
- Cardsight-clean worktree for backend deploys (has archiver)
- deploy-with-build-info.ps1 not naive az deploy

## Immediate goal for next session

Resolve PR D Step 0 questions (eBay backend state), then sequence PR D.

If next session is the same machine: pick up directly. If cross-machine: ensure both machines are at latest main before starting iOS work, and current deploy is cf7d48b before any iOS work that depends on backend changes (none in PR D.2-D.3 likely, but PR D.1 may add backend, which needs a deploy gate).
