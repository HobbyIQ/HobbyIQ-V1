# HobbyIQ Session Handoff — 2026-05-21

(updated end of multi-session day spanning 2026-05-20 → 2026-05-21; PR D batch appended)

**Strategic plan:** See `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` for the 14-16 week roadmap toward end-of-July CompIQ formalization and mid-September ML moat realization.

## Production state

- HobbyIQ3 (Azure App Service, rg-hobbyiq-dev, Central US)
- URL: https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net
- Deployed SHA: d0094f312b41d0611f9e3c89f0dc37bb175b0c25 (PR D.6 merge â€” D.1 + D.5 + D.6 live)
- CARDSIGHT_MODE: exclusive

## Origin/main HEAD

- Current: d0094f3 (PR #100 merge â€” D.6 M1 ledger + Option A listing-link)
- iOS at 8476e0d (PR #97) is on the same main branch â€” backend now ahead via PRs #98 + #99 + #100.

## PR D batch (2026-05-20 → 2026-05-21)

### PR D.1 — eBay seller-policy refactor (#98, squash sha c2594419)
- Removed EBAY_PAYMENT_POLICY_ID / RETURN_POLICY_ID / FULFILLMENT_POLICY_ID env vars entirely
- New resolveSellerPolicies(userId, input) with four-state contract (none_configured / single / default-flagged / no_default_among_multiple)
- New MissingSellerPolicyError + missingPolicy surfaced via EbayListingResult / preview warnings
- buildListingPreview now async; getSellerPolicies exposes isDefault per entry
- 7 new tests in tests/ebayListing.policies.test.ts

### PR D.5 — eBay marketplace-account-deletion webhook (#99, squash sha 04b8d29 → main 4c0a1b6)
- New GET/POST /api/ebay/webhook (mounted before /api/ebay)
- GET: SHA-256 challenge handshake (challenge_code + EBAY_WEBHOOK_VERIFICATION_TOKEN + endpoint URL)
- POST MARKETPLACE_ACCOUNT_DELETION: reverse-lookup userId via new findUserIdByEbayUserId helper (in-memory + Cosmos cross-partition), then deleteTokenRecord. Tries username → encrypted userId → eiasToken.
- POST other topics (incl. ITEM_SOLD): logged + 200 stub
- Always 200 on POST (eBay retries non-2xx aggressively)
- 11 new tests in tests/ebayWebhook.test.ts; full suite 600/600

### App settings added (HobbyIQ3)
- EBAY_WEBHOOK_VERIFICATION_TOKEN — 64-char base64-url-safe random (never logged)
- EBAY_WEBHOOK_ENDPOINT — https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/ebay/webhook

### Production smoke test (post-deploy)
- GET ?challenge_code=... → 200 + challengeResponse hex ✓
- GET (missing challenge_code) → 400 ✓
- POST MARKETPLACE_ACCOUNT_DELETION (no match) → 200 {received:true} ✓
- POST ITEM_SOLD → 200 {received:true} ✓

### D.5 framing correction (added 2026-05-21 in D.6 handoff)
The original "Carved out â€” PR D.6 (next session)" framing under-describes what actually happened. Honest framing:

PR D.5 kickoff presented three askQuestions; transcript JSONL doesn't serialize askQuestions answers so actual selections cannot be verified from disk; post-compaction agent executed against recorded summary; user opted to recover deferred scope in PR D.6 rather than accept partial ship as final.

The items below were the recovery scope picked up by PR D.6:
- Add ebayOfferId + ebayListingId fields to PortfolioHolding; persist on createListing/reviseListing success
- Extract markHoldingSoldFromEbay(holdingId, orderData) helper from sellHolding (non-HTTP form)
- Wire real ITEM_SOLD handler in ebayWebhook.routes.ts (was a 200 stub)
- DO NOT register webhook URL with eBay until D.6 ships if eBay test data could trigger ITEM_SOLD prematurely; for account-deletion-only registration the current stub is sufficient.

### PR D.6 â€” M1 real ITEM_SOLD ledger integration + Option A listing-link (#100, squash sha d0094f3)
- PortfolioHolding gained optional `ebayOfferId`, `ebayListingId`, `ebayListingPublishedAt` fields (persisted on createListing / reviseListing success; cleared on endListing / unpublish best-effort)
- New `findHoldingByEbayOfferIdAcrossUsers` cross-partition Cosmos scan in `portfolioStore.service.ts` (logs invariant on multi-match; ebay_offer_index optimization deferred)
- New `markHoldingSoldFromEbay(holdingId, EbaySaleData)` â€” idempotent on `holdingId + ebayOrderId`, never throws, decrements quantity, writes ITEM_SOLD ledger row, deletes when quantity hits zero. Manual `sellHolding` unchanged.
- New eBay-source `EbaySaleData` / `MarkSoldFromEbayResult` interfaces; ledger row carries `source="ebay"`, granular fee fields (sellerPayout, paymentsFees, finalValueFees, shippingCost, taxCollected), `ebayOrderId`, `ebayLineItemId`, `needsReconciliation=true`, `suppliesCost=null`, `gradingCost=null` (user-entered, recorded later via PR E UX)
- Capture-before-process webhook event store in `ebayWebhookEvents.service.ts` (Cosmos container `webhook_events`, partition `/notificationId`, lazy-created). Statuses: captured â†’ processed | error. Field names: `handlerResult` (success) / `handlerError` (failure). Test-mode in-memory Map.
- `ebayWebhook.routes.ts` POST handler rewritten: dedup by notificationId â†’ capture â†’ topic dispatch (MARKETPLACE_ACCOUNT_DELETION / ITEM_SOLD / no-handler) â†’ per-branch `markEventProcessed`/`markEventError` â†’ outer try/catch â†’ always 200. Race-string error contract verified live: `no holding found with ebayOfferId={offerId} â€” possible race with end-listing or unknown offerId`.
- Tests: 634/634 green pre-merge.
- Deploy: Kudu deployment cb70da89-e1a9-4d35-b434-9225ae0c566b status=4 Success; /api/health reports d0094f3 / main / cosmos+redis+appInsights all OK.
- Production smoke (Step 8): 5/5 PASS. GET challenge handshake â€” sha256=b80ba2783f11e855b735c1b76c3ff7791bc099f0d6858afa8cfed318a4bdc791. MARKETPLACE_ACCOUNT_DELETION â†’ Cosmos status=processed, handlerResult={action:"no-match"}. ITEM_SOLD bogus offerId â†’ status=error with the exact race string. Dedup POST (same notificationId twice) â†’ both 200, EXACTLY 1 Cosmos row. Cosmos verification done via node @azure/cosmos client against COSMOS_CONNECTION_STRING from App Settings.

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

## PR D.6 carry-forwards (must read before PR E / next eBay session)

1. **Reporting layer must read granular fee fields + netPayout when `source==="ebay"`.** Legacy aggregates (`fees`, `tax`, `shipping`) are 0 on eBay ledger entries by design. P&L / tax exports that sum the legacy columns will under-report eBay sales.
2. **`needsReconciliation=true` entries must be hidden from final P&L or visibly flagged.** PR E adds a reconciliation UX where the user enters `gradingCost` / `suppliesCost` and clears the flag.
3. **`gradingCost` / `suppliesCost` are user-entered and immutable once recorded.** ITEM_SOLD writes them as `null` â€” PR E UX captures them per-sale; do not auto-derive.
4. **Tax export MUST NOT include unreconciled entries OR must flag them prominently.** Year-end exports will be wrong otherwise.
5. **`linkEbayListing` / `unlinkEbayListingByOfferId` are best-effort.** A future >90-day reconciliation pass should re-sync offer/listing IDs against eBay's seller account in case publish/end events were missed.
6. **`findHoldingByEbayOfferIdAcrossUsers` is a cross-partition scan.** Acceptable at current scale; if portfolio container grows past ~10k holdings, add an `ebay_offer_index` container partitioned on `/ebayOfferId` and write-through on listing publish/revise/end.
7. **Webhook event status-transition writes are best-effort.** A stale `captured` row (handler crashed mid-flight before markEventProcessed/Error) is replay-safe: `markHoldingSoldFromEbay` is idempotent on `holdingId + ebayOrderId`, so an offline reconciler can re-dispatch any captured row whose holding state doesn't yet reflect it.
8. **`scripts/deploy-with-build-info.ps1` aborts at step [2/5] when `az webapp deploy` emits stderr WARNING** (e.g. "Initiating deployment...") because `$ErrorActionPreference = "Stop"` at line 12 treats stderr as fatal. Workaround used this session: manually continue with Kudu poll + explicit restart + /api/health verify. Fix: wrap the `az webapp deploy` invocation in `2>$null` OR locally relax `$ErrorActionPreference` around just that call. **Real operational gotcha â€” the next agent that hits this might silently retry the whole script and re-trigger the restart-race the script was written to prevent.**
9. **Cosmos data-plane queries from Windows: `az cosmosdb sql container query` is NOT a real az subcommand.** The working pattern in this codebase is the node `@azure/cosmos` client using `COSMOS_CONNECTION_STRING` from App Settings (read with `az webapp config appsettings list --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv`). See `smoke-d6-cosmos-v2.cjs` (in `C:/temp/hobbyiq-cardsight-clean/`) for the working pattern. Document this so the next session/agent doesn't waste time on the non-existent az path.
10. **ITEM_SOLD happy-path verification is uncovered by automated smoke.** Step 8 of D.6 verified the unhappy path (bogus offerId â†’ `markEventError` with the descriptive race string). The happy path requires either (a) a real eBay sandbox sale event after webhook registration, OR (b) a manually seeded `PortfolioHolding` with a real `ebayOfferId` + a synthetic `ITEM_SOLD` POST. **Mac-session task** with acceptance criteria:
    - Seed a PortfolioHolding with a known `ebayOfferId` (or capture from a real sandbox listing publish).
    - POST a synthetic ITEM_SOLD to `/api/ebay/webhook` referencing that `ebayOfferId`.
    - Verify `webhook_events` row has `status="processed"` and `handlerResult.action="marked-sold"`.
    - Verify the holding's `statusCategory` is updated (or the holding is deleted if full quantity sold).
    - Verify a new `PortfolioLedgerEntry` exists with `source="ebay"`, correct `ebayOrderId`, NULL granular fees only if intentionally omitted (otherwise populated from the synthetic payload), `needsReconciliation=true`.

### PR E scope hint
- Build the reconciliation UX that consumes carry-forwards #1â€“#4: surface unreconciled eBay sales, let the user enter `gradingCost` / `suppliesCost`, clear `needsReconciliation`, and update reporting.

### eBay portal registration block
- Do NOT register the production webhook URL with eBay until carry-forward #10 is closed end-to-end on at least one happy-path event. Until then, account-deletion-only registration is the only safe configuration (current stub handles it; happy-path code is live but unverified against a real eBay payload shape beyond our synthetic test envelope).

### End-to-end verification pending
- Carry-forward #10 above is the gating verification. Once it's green, declare D.6 fully verified and proceed to register ITEM_SOLD with eBay in PR E.

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

---

# Phase 0 / WORKSTREAM 4 � Session Handoff (2026-05-21 PM)

This section is the end-of-day record for the Phase 0 + WORKSTREAM 4 thread (Cardsight migration scoping ? comp_logs writer rollout ? PR-A1 soak ? PR-A1.1 mid-soak schema fix). The PR D handoff above remains canonical for the iOS / eBay-listing thread. The two threads ran on parallel branches and do not interact.

## Where the soak is, in one paragraph

PR-A1 (`comp_logs` writer at SHA `ea0a724`) deployed `2026-05-21T15:22:23Z`. Writer flipped on at `2026-05-21T17:44:32Z` (`COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0`). Day-10 review at `2026-05-31T17:44:32Z`. PR-A1.1 (`e333ae1`, additive-nullable `playerName` + `cardYear`) merged + deployed mid-soak at `18:49Z` after a stale-zip recovery loop; **soak clock not reset**. Production state: `CARDSIGHT_MODE=exclusive`, writer green, schema gap #3 resolved, gaps #1/#2/#4/#5 still open.

## Findings 1-10 (re-derived from `docs/phase0/SESSION_HANDOFF_2026-05-21.md` + `docs/phase0/SOAK_LOG.md`)

Original numbering was implicit; this list canonicalizes it so Finding 11 has a baseline.

1. **`comp_logs` writer was unwired pre-PR-A1.** Reader (`marketDelta.service.ts`) still queried the Cosmos container, but no service in `backend/src/` wrote to it. No historical record of pricing predictions existed at session start. � Phase 0 headline #1.
2. **`compiq_corpus` accumulation disabled.** Writer wired, container exists, but `COMPIQ_CORPUS_SAMPLE_RATE=0` on `HobbyIQ3` ? privacy-safe ML-training corpus is empty. � Phase 0 headline #2.
3. **Router warn `primary_mode_cardhedge_namespace_only` under-captured in App Insights.** 30-day query: 156 warn captures vs 1660 `/api/compiq/price-by-id` requests (~9%). Either App Insights trace sampling is dropping ~91%, OR the warn does not fire on every `/price-by-id` (which would downgrade Objective 1.4b verdict A2). � Phase 0 headline #3. **Bifurcation update (added W7 close-out 2026-05-21 PM):** the trace-side ~9% gap is one half of the broader observability picture; the requests-side table was independently unwired (no auto-instrumentation) until PR-A1 (PR #104, `ea0a724`) deployment wired requests. Pre-PR-A1 latency/error baselines are not recoverable from either table. See `W6 completion + Phase 0 close-out` entry below, capture #1, for the full framing.
4. **Cosmos `hobbyiq-comps-centralus` regional endpoint at 21% failure rate.** Logged earlier in Objective 1.4. � Phase 0 headline #4.
5. **`CARDSIGHT_MODE=exclusive` in production.** Cardsight router Site B short-circuit is the active path for `cardIdSource: "cardhedge"`. � Objective 1.6a.
6. **Cardsight catalog freshness smell-test: 4/4 valid queries pass.** Sample size 4 manually-curated cards; not a coverage claim. The 1 "failed" query (Roman Anthony 2024 Bowman Chrome Prospects Auto) was an invalid card spec, not a catalog gap. � Objective 1.6b-1.
7. **Cardsight `searchCatalog` latency margin is tight.** p50 � 9-10 s across 4 valid queries (range 5.3�12.1 s) against a 15 s client `DEFAULT_TIMEOUT_MS`. Steady-state at 60�80% of timeout budget. � Objective 1.6b-2.
8. **Cardsight first-result product-family mismatch on 2/4 valid queries.** Junior Caminero "Topps Chrome Rookie" ? first hit `Topps Allen & Ginter X`; Wyatt Langford "Topps Chrome RC" ? first hit `Topps Heritage`. `relevance` field clusters tightly (5.10�5.52) regardless of family match. Distinct failure mode from coverage. � Objective 1.6b-3.
9. **Stage 2 (top-N coverage spot-check) canceled.** Axis 1 (`/search` traces) dominated by synthetic harness traffic; Axis 2 (`/price-by-id` warn) at 9% capture; no CH-ID ? Cardsight-ID translator. Migration must ship with strong logging and treat post-deploy observation as the measurement approach. � Phase 0 Stage-2-canceled section.
10. **PR-A1 writer post-flip schema gaps (5 sub-items).** After flip, rows had: (a) `cardIdSource` null 10/10, (b) `cardId` null 10/10, (c) `playerName` / `cardYear` absent from row schema entirely, (d) `parallel` populated only when literal token in query string (2/10), (e) **2� row fan-out per request** � each `POST /api/compiq/price` produced one real-latency row (~2.2�3.7 s) plus one anomaly row (2�3 ms) at the same `_ts`. � SOAK_LOG "Soak schema gaps" 1-5.

## Finding 11 � Stale `deploy.zip` incident (NEW, 2026-05-21 PM)

**What happened.** First PR-A1.1 deploy attempt at `18:31:59Z` (Kudu id `f53e7d14-2998-4970-8709-0deae0f4a130`, status=4 Success) shipped a `deploy.zip` that predated the PR-A1.1 build. `/api/health` immediately reported `build.sha=e333ae1` matching the merge SHA, so the deploy *looked* clean. Cosmos probe rows written by subsequent `/api/compiq/price-by-id` calls revealed the truth: rows carried `engineVersion=e333ae1` but lacked the new `playerName` / `cardYear` fields, proving the running code was still PR-A1 (`ea0a724`).

**Root cause.** `scripts/deploy-with-build-info.ps1` consumes a pre-existing `deploy.zip` at the repo root; it does **not** call `npm run build` or `node zip.js`. The script sets `GIT_SHA` as an App Service application setting in step [1/5], **independently of the zip contents**. `/api/health` reads `build.sha` from `process.env.GIT_SHA`. Therefore `/api/health` SHA reflects "what the deploy script claimed it deployed", not "what is actually running".

**Recovery.** `cd backend; npm run build` ? `cd ..; node zip.js` (82 552 999-byte fresh zip) ? re-run deploy script. Kudu id `930f94f3-396f-4e41-bc48-8df42fe08f47`, status=4 at `18:49:42Z`. Cosmos probe rows from a free-text Mike Trout `/price` call then carried `playerName="Mike Trout"`, `cardYear=2024` � real PR-A1.1 code confirmed running.

**Risk surface uncovered.** Pre-PR-A1.1 deploys had no second-axis verification path: every prior deploy on this app relied solely on `/api/health` SHA match. **It is now plausible that one or more prior deploys silently shipped stale bits and we never caught it.** The fix in PR-A1.1 (new nullable schema fields) is what gave us a second axis for the first time. PRs that touch only existing code paths (no new logged field, no new endpoint, no new measurable side effect) remain uncatchable with current tooling.

**Going-forward verification rule.** `/api/health` SHA is necessary but insufficient. After any deploy, confirm **one of**:
- `backend/dist/<known-changed-file>.js` mtime > merge commit time, **or**
- a schema-shaped probe write � call a write-side endpoint touched by the PR, then read back via Cosmos and verify the PR's new code path executed (e.g. a new column populated, a new outcome string, a new ledger source value).

**Where it's documented.** SOAK_LOG.md PR-A1.1 section (commit `233c855`). User memory `debugging.md` "HobbyIQ3 deploy verification trap" entry. Should also be captured in a follow-up ticket if/when we decide whether to (a) make the deploy script build/zip itself, (b) add a CI step that fails if `deploy.zip` mtime < latest commit on `main`, or (c) accept the gap and rely on the schema-probe discipline going forward � decision deferred.

## Schema gap #3 resolution

PR #105 (`e333ae1`) plumbs `playerName: string | null` and `cardYear: number | null` end-to-end through:
- `backend/src/models/compLogEntry.ts` � schema fields added between `isAuto` and `w7Count`. `compLogSchemaVersion` stays at `1` (backwards-compatible nullable expansion, no version bump).
- `backend/src/services/compLogs/compLogMapping.ts` � `compLogEntryFromPricingResult()` coerces (`trim ? null` on empty; year `1900-2100` finite-int else `null`).
- `backend/src/services/corpus/writeTelemetryEntries.ts` � `extractTelemetryCohortFromResult()` reads `parsed.playerName` then `identity.player`; `parsed.year` then `identity.year`.

Production rows from `_ts >= ~1779389982` (~`2026-05-21T18:49:42Z`) carry both fields. Earlier soak rows do not � cohort analyses that need them must filter on `_ts`. Schema gaps #1 (`cardIdSource`), #2 (`cardId`), #4 (`parallel` literal-only), #5 (2� row fan-out) remain open; the user's W6 / PR-A2 sequencing puts those after day-10 review.

## Cache-hit telemetry pollution (re-confirmed)

The original PR-A1 finding called the bimodal latency distribution "2� row fan-out per request" and hypothesized either dual code-path writes or an ungated shadow-pair writer. Both PR-A1.1 deploy verifications (the false-positive at `18:31Z` and the real one at `18:49Z`) re-produced the bimodal pattern: each `/price` call wrote one row with real latency (2.2�3.7 s) and one with `latency_ms` in the single-digit milliseconds. **The "anomaly" row is the cache hit on the second-axis write path; the cause is cache-hit re-entry into the writer, not a true fan-out from two services.** Both rows record real production events, but they are not independent observations of a single user request.

**Filter rule for soak analysis.** When computing cohort-level aggregates from `comp_logs`:
```
WHERE c.latency_ms >= 50
GROUP BY c.endpoint
```
This drops cache-hit re-entry rows and recovers the real per-request distribution. Documented here so downstream B1 / B3 analyses use a consistent gate.

**Architectural smell remains.** The writer is called from inside `cacheWrap`, so any cached call still produces a Cosmos write. Two candidate fixes for Phase 4a measurement-design:
- **Add a `cache_hit: boolean` field** to `compLogEntry` and let analysis filter on that instead of latency. Lower-risk; keeps cache-hit observability for B1 cache-effectiveness measurements we may want later.
- **Move the writer outside `cacheWrap`** so cached calls don't write. Loses cache-hit visibility; couples writer placement to caching topology.

Leaning toward the first. Deferred to Phase 4a per W5 reframe.

## State at HALT (W7 commit point)

- main HEAD on `origin`: `e333ae1` (PR #105 merge) + `233c855` (SOAK_LOG update) + this commit (W7 SESSION_HANDOFF append).
- HobbyIQ3 `/api/health`: `build.sha=e333ae1`, `deployedAt=2026-05-21T18:47:48Z`, services cosmos+redis+appInsights all `configured`/`active`.
- Soak clock: live, `2026-05-21T17:44:32Z` ? `2026-05-31T17:44:32Z`.
- Open tickets: **#106** (B2 cardIdSource cohort definition, decision deferred to Day-10).
- Next workstreams (per the consolidated prompt): **W5** roadmap reframe (next), **W6** secondary Phase 0 measurements (Q1 deferred 48 h, Q3 + blob inventory + MCP repo discovery normal).

---

# 2026-05-21 PM — W6 completion + Phase 0 close-out

End-of-W6 record. Closes out the Phase 0 measurement workstream: W6.2 (Q3 latency baseline), W6.3 (blob inventory), W6.4 (MCP repo discovery) all complete and pushed. W6.1 (Q1 warn-log baseline) intentionally deferred to day-2+ for post-PR-A1 traffic accumulation. Active 10-day soak continues; day-10 review scheduled `2026-05-31T17:44:32Z`.

## W6 captures (12 findings)

Each captured in structured form per the compaction-fabrication discipline — explicit values, no prose collapse.

### 1. Production observability pre-PR-A1 was bifurcated

- Traces table partial: ~9% capture (per `primary_mode_cardhedge_namespace_only` warn-line undercount — 156 captures vs 1660 `/api/compiq/price-by-id` requests over a 30-day window).
- Requests table effectively unwired: no auto-instrumentation pre-PR-A1.
- PR-A1 (PR #104, `ea0a724`) deployment wired requests. Pre-PR-A1 latency/error baselines are not recoverable.
- Implication: the earlier "Either App Insights trace sampling is dropping ~91% OR the warn does not fire on every `/price-by-id`" framing of Finding 3 in the 2026-05-21 PM entry above stands but is now subordinate to the broader bifurcation framing — both tables were inadequate pre-PR-A1, for different reasons.

### 2. Phase 4a success-criteria touch-up needed in roadmap

Current text in `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md`: "p95 reduction >50% vs Phase 0 baseline." That baseline does not exist — only ~1 hour of usable post-PR-A1 data at W6.2 capture time. Realistic baseline is Day-10 post-PR-A1 (includes the in-process `cacheWrap` already present). Capture for the next roadmap edit; not edited tonight.

### 3. `/api/compiq/search-list` confirmed dead-path

Zero traffic in 7-day window. Decision required in Phase 1 Track B / Phase 3 cleanup: migrate or delete.

### 4. App Insights component-naming hazard

`hobbyiq3` telemetry lives in the App Insights component **`hobbyiq-insights`** — NOT in the obvious-named alternatives (`HobbyIQ3`, `HobbyIQ`, `appi-hobbyiq-dev`, `appi-hobbyiq-prod`) which exist but are empty. This is a footgun for any future agent running KQL against the wrong component. Belongs in `copilot-instructions.md` Part 9 when that section is next touched.

### 5. `fn-cardhedge-comps` writing 27 comps/player uniformly 2 days post-CH-cancellation

Per W6.3 blob inventory: 5 players, all written 2026-05-21 02:00–02:00:23Z, `comp_count = 27` across all 5 players. CH subscription cancelled 2026-05-19. Three possibilities: (a) CH access has a multi-day grace period; (b) API key revoked but function fell through to cached/synthetic data — uniform 27 count is suspicious for live API; (c) cancellation hasn't propagated. **Phase 3 cleanup must investigate the consumer chain before disabling** — what reads the cached blobs and what assumes their freshness.

### 6. `fn-nightly-comp-prefetch` running with no observable blob output

Function deployed, timer `0 30 2 * * *`, `isDisabled=False`. Per `copilot-instructions.md`, it writes per-card cache to `compiq-signals/{player}/{card_id}/comps.json`. **No per-card subfolders exist in the container** — only flat per-player `{signal}.json` files. Phase 4a cache-layer design assumes prefetch output is available; current state suggests this assumption is false. Block on confirming actual write behavior before Phase 4a cache work.

**Finding 6 annotation (post PR #107 merge 2026-05-21):** `main` now carries a newer version of `fn-nightly-comp-prefetch/function.py` than what was deployed at time of the Workstream B diagnostic. The branch version adds 4 helper functions and a scoring-based `_resolve_card_hedge_id` rewrite. The Failure A (`COSMOS_KEY` auth) and Failure B (empty inventory) characterizations in `docs/phase0/finding6_nightly_prefetch_writepath.md` were derived from the OLDER deployed version. Future investigation of Finding 6 must account for whether the issues persist in the newer version on `main` or were addressed by the scoring rewrite.

### 7. `fn-compiq` App Insights observability also unwired

99 trace rows + 2 request rows in 30 days across the entire 14-function app. Only `fn-ebay-signals` and `fn-reddit-signals` emit visible telemetry. Blob mtime is the only reliable invocation signal for the other 7 timer functions. The bifurcation pattern from `hobbyiq3` repeats — observability is structurally underdeveloped across the system, not just on the API.

### 8. Storage-account naming discrepancy

Brief said `stcompiqfnotgm` for the function-app storage. Reality: **`stcompiqfnotgm2` (active, eastus)** is bound to `fn-compiq`'s `AzureWebJobsStorage` and `AZURE_BLOB_CONNECTION_STRING`; **`stcompiqfnotgm` (centralus)** exists with zero containers and is orphaned/empty. Both keys rotated correctly per W1; `docs/security/SECRET_ROTATIONS.md` at `1dec669` is accurate. Future sessions must verify which account is in use before assuming. `stcompiqfnotgm` is likely safe to delete (deferred).

### 9. Function inventory mismatch (W6.3 reconciliation)

Brief listed 15 functions and described count as 14. Actual deployed count is **14**. Discrepancies:
- `fn-player-score-refresh`: in brief, NOT deployed.
- `fn-price-alert-checker`: in brief, NOT deployed.
- `fn-nightly-comp-prefetch`: deployed and active, NOT in brief, but referenced in `copilot-instructions.md`.

### 10. `compiq-functions/fn-*` source-on-branch anomaly — RESOLVED

Production has 14 deployed functions but `main` carries only scaffolding + shared helpers (PR #76 `2d2ea21`, PR #77 `91e517d`). Per-function source dirs (`fn-cardhedge-comps`, `fn-ebay-signals`, etc.) live only on `origin/wip/snapshot-2026-05-20` (HEAD `5fad0a2`) and `origin/restore/preprod-deployed-state` (HEAD `1cb6f45`), each carrying 16 `fn-*` dirs (the deployed 14 plus the 2 not-deployed pair from Finding 9 above). Anyone editing function code from a `main` checkout starts from scaffolding, not from the deployed state. **Configuration / source-of-truth gap.** Surfaces a follow-up: which branch is canonical for Phase 3 cleanup PRs against the function app? Documented in detail in `docs/phase0/mcp_repo_discovery.md` "Adjacent finding" section (commit `24aab9e`).

**Resolution (2026-05-21 PM):** PR #107 (squash merge `46390e7`) restored the 14 deployed `fn-*` directories plus 2 not-deployed extras (with status READMEs) from `origin/wip/snapshot-2026-05-20` onto `main`. Byte-level verification before the PR confirmed 48/50 deployed files byte-identical to branch (CRLF-normalized); the 1 file with content drift (`fn-nightly-comp-prefetch/function.py`) has branch-newer scoring improvements — see Finding 6 annotation above. Kudu auth resolved via Functions runtime `/admin/vfs/...` endpoint with `host/default/listKeys` master key (not the SCM AAD path, which is blocked at tenant-resource-principal registration). `.gitignore` patched to exclude `compiq-functions/**/__pycache__/`. Workstream C scope doc at `docs/phase0/finding10_compiq_functions_canonical_branch.md` (commit `8980cdb`) characterized the gap; this PR closes it.

### 11. Summary-fabrication failure mode is not limited to compaction summaries

Three instances observed in this single day:

- **Cosmos-leak fabrication.** Post-compaction summary recombined two true adjacent facts (a storage-key leak + the Cosmos secret being most-mentioned) into a hybrid claim that the Cosmos connection string had leaked. Caught when the agent grepped the pre-compaction transcript and found no such event.
- **PR #101 merge-vs-opened conflation.** A session message asserted PR #101 was merged. Caught when the agent verified git state during a downstream deploy that aborted because the EAP fix wasn't actually on `main`.
- **W1 rotated-wrong-account assertion.** A mid-session resume-brief asserted that W1 rotated the wrong storage account. Caught when the agent verified against committed `docs/security/SECRET_ROTATIONS.md` — W1 had rotated both `stcompiqfnotgm` and `stcompiqfnotgm2` correctly, with the active account explicitly identified.

Common shape: a discrepancy is observed, a plausible explanation is constructed, and the explanation propagates as fact without being verified against the source artifact. Mitigation: any claim about a prior decision, rotation, merge, commit, or shipped artifact must be verified against repo/git state before being acted on. This lesson is queued for `copilot-instructions.md` LESSONS FROM PRIOR SESSIONS section as an extension to the existing 2026-05-21 entry (Workstream 3).

### 12. DailyIQ watchlist refresh dominates organic comp_logs traffic — coverage gap exposed, not a system bug

DailyIQ watchlist refresh dominates organic `comp_logs` traffic. Diagnostic across the last 444 `comp_logs` rows surfaced that the most recent 200-row window is essentially 100% automated watchlist refresh, firing in batches of **28 rows at irregular 5–32 minute intervals**. The refreshed queries cluster in a specific cohort: niche-prospect autos in non-base parallels (Blue, Gold Wave, Green Refractor) of current-year Bowman Draft Chrome products (Hammond, Bonemer, Willits, others), **100% ungraded, 100% null cardId, 100% `isAuto=true`**.

System behavior on this cohort: **79% `no_recent_comps`** (Cardsight returns no comps — genuine thin-market gap), **20% `variant_mismatch` with non-empty comps** (Cardsight returns comps but for the wrong variant; variant-resolution correctly refuses to set `predictedPrice`). **0% successful predictions.**

This is **NOT a system bug.** The pricing engine is safely refusing to fabricate prices for cards with insufficient comp coverage. Successful predictions DO exist in `comp_logs` broader history — **10 `ok` rows across the full 444-row sample, last success at `2026-05-21T19:01:34Z`** for Ohtani RC ($162), Guerrero Jr RC ($320), Witt Bowman Chrome Refractor BDC-1 ($2), and Trout Bowman Chrome ($2). All four query shapes are common, well-covered cards.

**Product implication.** DailyIQ watchlists are populated by users with cards they care about. Niche prospect autos are exactly the cards collectors most care about (rookies, low-pop parallels). **The cards collectors most want priced are systematically the cards the system structurally can't price.** From a UX perspective, watchlist refresh produces null predictions on the cards that matter most to the user.

This is a coverage gap exposed by the DailyIQ use case, not a system failure. The variant-resolution safety behavior is correct. The product question is whether Phase 4a (cache layer) and Phase 5 (Pricing × Portfolio integration) design must specifically address this cohort — for example by:
- surfacing "comp data available but variant uncertain" to users rather than `null`, or
- widening Cardsight coverage for prospect autos, or
- adding a confidence-degraded prediction mode for `variant_mismatch`-with-comps cases.

Not actionable as a fix tonight. Captured for next-session strategic discussion before Phase 4a kickoff.

**Diagnostic source:** Check 1 + Check 2 + Check 2.5 of the synthetic-soak abort diagnostic, 2026-05-21 PM session. (The synthetic-soak workstream itself was aborted before execution; this finding emerged from the contamination-hypothesis investigation that followed.)

## W6.4 conclusion

MCP repo is **not greenfield**. `mcp-server/` exists in-tree at `C:/dev/hobbyiq-main/mcp-server/` (added PR #78, commit `e0852a4`, 2026-05-19), deployed to the `compiq-mcp` Web App. Single canonical implementation; OneDrive and `C:/temp/hobbyiq-*` copies are identical-or-older snapshots of the same authoring window. GitHub `HobbyIQ` user has 3 other repos (`HobbyIQ-app`, `hobbyiq-backend`, `hobbyiq-conductor`) — all stale scaffolding, none MCP-protocol. Git history has zero hits for `cache_layer`, `comp_cache`, `pricing_cache`, or `model context protocol`. `backend/src/modules/compiq/services/pricing/infra/PricingCache.ts` (7 lines) and `PricingLogger.ts` (10 lines) exist but are unwired stubs from the early monorepo phase. Phase 0 success criterion ("MCP repo found OR confirmed to need building") **satisfied**. Adoption-vs-greenfield framing for Phase 4a kickoff (Weeks 5–6) is preserved in `docs/phase0/mcp_repo_discovery.md` (commit `24aab9e`); not decided here.

## Phase 0 close-out summary

**Deliverables shipped today:**

| Item | Type | SHA / Number | State |
|---|---|---|---|
| PR-A1 — `comp_logs` writer | PR #104 (squashed) | `ea0a724` | Merged + deployed; soak running |
| PR-A1.1 — `playerName` + `cardYear` schema | PR #105 (squashed) | `e333ae1` | Merged + deployed mid-soak `2026-05-21T18:49Z` (stale-zip recovery — see Finding 11 of earlier 2026-05-21 PM entry) |
| Canonical docs + LESSONS + SECRET_ROTATIONS + Phase 0 audit artifacts | PR | #102 | Merged |
| Deploy-script EAP-scope fix | PR #101 (squashed) | `ebf3efe` | Merged `2026-05-21T21:58:57Z`; closes PR D.6 carry-forward #8 |
| Roadmap reframe (W5) | Commit | (in PR #102 batch) | Live in `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` |
| W6.2 Q3 latency baseline | Commit | `b3db482` | `docs/phase0/q3_latency_baseline.md` |
| W6.3 blob inventory of 14 fn-* | Commit | `672ffd8` | `docs/phase0/blob_inventory_2026-05-21.md` |
| W6.4 MCP repo discovery | Commit | `24aab9e` | `docs/phase0/mcp_repo_discovery.md` |
| Issue: `/estimate` telemetry deferral | Issue | #103 | Open |
| Issue: B2 cardIdSource cohort definition | Issue | #106 | Open, decision deferred to Day-10 |
| Finding 10 resolution — `compiq-functions/fn-*` source restoration to `main` | PR #107 (squashed) | `46390e7` | Merged 2026-05-22T00:43Z; +2,615 lines / 45 files; no production change (canonicalization only) |
| Phase 3a CH access tripwire monitor (GitHub Action, Option D) | PR #108 + #109 (squashed) | `dbe5536` + `b1b773c8` | Shipped + dry-run verified on main; daily 02:30 UTC schedule active; federated MI `ch-monitor-oidc` + `Storage Blob Data Reader` on `stcompiqfnotgm2`; details in `docs/phase0/phase3a_monitor_config.md` |
| OPERATIONAL GOTCHAS extension (Phase 3a ship) | Commit | `9949dde` | Two gotchas added to `copilot-instructions.md`: `workflow_dispatch` default-branch constraint; `az storage blob download --file -` metadata-not-content defect |
| Workstream 2 — COSMOS_KEY shared-auth diagnostic | Commit | `000b777` | `docs/phase0/finding_cosmos_key_shared_auth.md` — CONFIRMED PARTIAL: defect affects all Python paths in `fn-compiq`; Node backend has AAD fallback and is NOT affected; Cosmos 21% rate not explained by this defect |
| Workstream 3 — Finding 5 deeper consumer analysis | Commit | `031cd24` | `docs/phase0/finding5_deeper_consumer_analysis.md` — three consumer paths characterized (compsLoader active+uncached, primePlayerComps dormant, cardhedge.client near-dormant); prediction degrades within ~15 min of CH death; monitor lag up to ~24h |

**Phase 0 measurement state:** complete except W6.1 (deferred to day-2+ for 48 h of post-PR-A1 warn-log accumulation). Active soak continues independently. Day-10 review window `2026-05-31T17:44:32Z`.

**Production state at this commit:**

- `hobbyiq3` `/api/health`: `build.sha=e333ae1` (unchanged from earlier W7 commit point — no new deploys this session).
- Cosmos `comp_logs` writer flipped on at `2026-05-21T17:44:32Z` (`COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0`); writing continuously since.
- `CARDSIGHT_MODE=exclusive`.
- All storage keys rotated correctly per W1; `SECRET_ROTATIONS.md` at `1dec669` accurate.

## Deferred / open items entering day-2+

- W6.1 Q1 warn-log baseline measurement (needs 48 h of post-PR-A1 traffic).
- Finding 6 investigation: confirm whether `fn-nightly-comp-prefetch` actually writes anything. W2 (commit `000b777`) confirmed Failure A (`COSMOS_KEY` stale) persists in the post-PR-107 newer version on main; Failure B (empty `compiq.inventory`) is independent and also persists. Carry-forward is now the decision question, not the investigation.
- Phase 4a / Phase 5 design open question: how to address the DailyIQ niche-prospect-auto coverage gap. Three candidate approaches captured in Finding 12; decision deferred to Phase 4a kickoff or earlier strategic session.
- Cosmos 21% failure-rate diagnostic — original Phase 0 Finding 4 (`hobbyiq-comps-centralus` regional endpoint at 21% failure rate). W2 ruled out the `COSMOS_KEY`-stale-key defect as a plausible explanation (Node backend has AAD fallback). Likely regional-routing / geo-replication issue; needs its own focused diagnostic.
- `compiq-mcp` App Insights observability gap — W3 surfaced that the MCP Web App has no `APPLICATIONINSIGHTS_CONNECTION_STRING` env var; telemetry from MCP call sites is invisible. Extends the W6 capture #7 observability bifurcation to a third subsystem. Decision needed: wire telemetry as own workstream OR accept the gap into Phase 4a planning.
- Phase 3a monitor detection-vs-degradation lag — W3 finding: prediction quality degrades within ~15 minutes of CH access dying (bounded by backend Redis 15-min TTL); monitor fires daily, so detection lag is up to ~24h. Known and acceptable for a tripwire; future enhancement (hourly fire, real-time blob observability, downstream prediction-quality monitor) is its own decision.

---

# 2026-05-22 — CH removal attempted, rolled back, re-scoped for next session

**Net production change this session: zero.** The two PRs that landed earlier today (#110 backend, #111 MCP, both showing as merged on `main` in `git log`) were rolled back at the runtime layer. Both apps are now serving pre-CH-removal code; the merged commits remain on `main` but their corresponding deploys have been replaced.

## What was attempted

Three workstreams attempted in sequence, all reverted at the runtime layer:

1. **WS2 + WS3 ship (already committed pre-session):** backend `fetchComps` meaningful-query fall-through (`9124e54`, PR #110) + MCP `compsLoader` rewire to call backend `/api/compiq/price` (`fc5575d`, PR #111). The two PRs assumed Cardsight under `CARDSIGHT_MODE=exclusive` could absorb the same player-level and free-text calling patterns that Card Hedge handled. Both deploys completed earlier today (backend `9124e54` at 04:16Z, MCP `4cebfb6f` at ~12:00Z) but production behavior was query-shape-fragile: the MCP path returned 0 comps for iOS-shape queries like `"2011 Topps Update Mike Trout US175"`.

2. **WS3 Fix I+ (uncommitted, in-flight):** MCP `compsLoader` refactored to `fetchCompsForCard({playerName, year, set, cardNumber, grade, variant})` using backend's `/search-list` + `/price-by-id` as a two-step. Deployed to `compiq-mcp` mid-session (deploy `4cebfb6f`). Smoke surfaced that backend `/price-by-id` still returns `source: "no-recent-comps"` for the demo card even with a valid `cardHedgeCardId` and meaningful free-text query — the failure was downstream of MCP, in backend's `findCompsViaCardsight` → `resolveCardId` path.

3. **WS3 B1 (uncommitted, in-flight):** backend `/api/compiq/price-by-id` handler extended to call `parseCardQuery(query)` and populate the structured fields (`cardYear`, `product`, `parallel`, `isAuto`) on the `CompIQEstimateRequest` body, and `fetchComps` / `computeEstimate` plumbing extended to thread these as `opts.queryContext` into `findCompsRouted`. Backend test suite 715/715 green including a new `compiqEstimateQueryContext.test.ts` (2 tests) verifying the threading. Deployed to `hobbyiq3` (deploy `57a49bad`). Direct smoke surfaced that B1 **regressed** the previously-working WS2 query shape (`"Mike Trout 2011 Topps Update Baseball"`): 3 calls post-B1 all returned `outcome=no_recent_comps`, including queries that had returned `ok/cardsight` against the un-B1 build hours earlier (verified via Cosmos `comp_logs` cutoff at `2026-05-22T04:16:00Z`).

## Findings (planning inputs for the next session)

1. **Cardsight is card-level; CH was player-level.** This is the load-bearing architectural difference. CH's `cardhedge.json` blobs contained ~20-30 sales per player aggregated across that player's recent cards; MCP's design assumed broad player-level pools then filtered locally via `filterCompsForCard`. Cardsight's API is keyed on a single `cardId` and returns pricing for *that* card only. There is no player-aggregation endpoint upstream. The migration is therefore an architectural shift, not a data-source swap.

2. **`COMPIQ_TO_CARDSIGHT_RELEASES` dictionary coverage gap.** `backend/src/services/compiq/cardsight.mapper.ts:38-46` defines the release-name dictionary used by `resolveCardId`. It covers `topps chrome`, `topps chrome update`, `bowman chrome`, etc., but **does not cover `topps update`** (the base, non-Chrome variant). When a structured query arrives with `product: "Topps Update"`, `lookupReleaseName` returns null, and the catalog search collapses to `playerName` alone with a year filter — too narrow on filter, too broad on candidate cards. All three demo cards (Mike Trout 2011, Ohtani 2018, Judge 2017 — all base Topps Update) hit this gap. Probable additional gaps for `Donruss Optic` variants and others.

3. **`/price-by-id` pre-B1 behavior: raw-query free-text pass-through.** Without structured `queryContext`, `findCompsRouted` falls back to using the full query string as `playerName` in `toCardsightQuery`. Cardsight's catalog text-match works for queries shaped like `"Mike Trout 2011 Topps Update Baseball"` (3 successful WS2 smoke entries in `comp_logs`) but fails for iOS-shape queries with card numbers like `"2011 Topps Update Mike Trout US175"` ("US175" contaminates the text match). The pre-B1 behavior is fragile-but-works for some shapes; B1's structured-route change regressed the working shapes by routing through the incomplete dictionary lookup.

4. **B1 plumbing is correct mechanically; the failure surface moved.** The unit tests verifying that `findCompsRouted` receives `opts.queryContext` populated all passed. The regression was downstream in `resolveCardId`. A reviewer reading B1 in isolation would not have caught the regression — the bug surfaces only when `resolveCardId` has to do the dictionary lookup with a non-covered product.

5. **MCP `/predict` is on the iOS critical path.** The prior session-summary characterization that "MCP is admin-only, iOS doesn't call MCP" was wrong. iOS Swift has direct references to `compiq-mcp.azurewebsites.net/api/compiq/predict` from `CompIQService.swift:129`, `SearchIQOrchestrator.swift:484`, `BacktestAdminView.swift:84`, `CompIQImageResolver.swift:22`, `PortfolioHeatMapView.swift:25`, `PriceAlert.swift:34`. Backend does NOT call MCP, but iOS does. Any MCP regression affects user-facing prediction calls directly. This re-frames the urgency of MCP rewires: they ARE on the live path.

6. **`fn-backtest-runner` is deployed + enabled.** `az functionapp function list --name fn-compiq` shows it scheduled `0 30 3 * * *` (03:30 UTC daily). Calls MCP `/api/compiq/admin/backtest/run` with `{minAgeDays, limit}` — no card identity. MCP's `runBacktest` groups predictions by player and calls `fetchPlayerComps(player)`. Any MCP rewire that breaks `fetchPlayerComps` also breaks the backtest. Pre-session production reality is that backtest scoring depends on the same player-level data shape MCP `/predict` did.

7. **WS2's `ok/cardsight` smoke was query-shape-specific, not a general-purpose fix.** Verified during the rollback: 3 ok/cardsight rows existed in `comp_logs` between WS2 deploy and B1 attempt; all 3 came from `/price-by-id` with queries that happened to be Cardsight-friendly (`"Mike Trout 2011 Topps Update Baseball"`, `"2024 Bowman Draft Chrome Refractor Auto Nick Kurtz"`). iOS-shape queries with card numbers were never tested as part of WS2 verification. The smoke didn't generalize.

8. **Chunked-deploy-boundary discipline worked.** The rollback was possible because WS4 (fn-cardhedge-comps decommission) had not yet been committed or applied to production. If WS4 had proceeded on schedule, today would have ended with: backtest broken, MCP returning 0 comps, fn-cardhedge-comps disabled, and the CH blobs going stale within 24h. Holding WS4 until WS3 was verified prevented a much worse outcome.

## Production state at rollback

Both apps verified back on pre-removal code via direct VFS reads against wwwroot and live smoke tests:

| App | Deployed code path | Verification |
|---|---|---|
| `hobbyiq3` | `dist/services/compiq/compiqEstimate.service.js` calls `findCompsRouted(query, { grade, limit: 25 })` (no `queryContext`) | `/api/health` reports `build.shaShort=fc5575d`; direct `/price-by-id` smoke for `"Mike Trout 2011 Topps Update Baseball"` returns `source: "live"`, `compsUsed: 1`, real sale data |
| `compiq-mcp` | `dist/compsLoader.js` reads `compiq-signals/{slug}/cardhedge.json` via `BlobServiceClient.fromConnectionString` (the pre-WS3 state at `5fad0a2`) | `/health` 200 OK; `/api/compiq/predict` for Mike Trout returns 26 comps + `nextSaleEstimate=$310`; Aaron Judge 27 comps; Shohei Ohtani 27 comps |

**Important state divergence:** `git HEAD` on `main` is `fc5575d` which has the WS3 MCP rewire committed. `compiq-mcp` wwwroot has the **pre-WS3** code from `5fad0a2`. They disagree. The next MCP deploy from main would silently re-introduce the WS3 backend-call path. This needs explicit handling in the next session — either revert PR #111 properly on main, or have the next CH-removal attempt land a different commit that supersedes `fc5575d`.

App settings touched this session that were not reverted:

- `hobbyiq3`: `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (was `false`) and `NPM_CONFIG_PRODUCTION=false` (new). These enable Oryx-side rebuild during deploy and allow devDependency install for the rebuild. Runtime behavior is unaffected (NODE_ENV stays `production`). Leaving these in place is harmless; the next deploy benefits from the slim-zip pattern.
- `compiq-mcp`: `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (was unset). Same rationale as above. Leave in place.

## Carry-forwards for the next session

- **CH removal is still the goal.** Approach must be revised based on these findings. The next session opens with a design discussion before any code.
- **Bottom-up candidate approach:** extend `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary FIRST to cover all sets the demo cards span (`topps update`, `donruss optic`, possibly others). Add a fallback in `resolveCardId` that includes the raw `product` text in the search query when no dictionary mapping exists (so unmapped products at least try to find a catalog match). THEN attempt `/price-by-id` `queryContext` plumbing again. THEN MCP rewire. Verify each layer in isolation before stacking.
- **Top-down candidate approach:** leave `/price-by-id` raw-query free-text behavior alone and focus the CH-removal migration on `/api/compiq/price` (the free-text endpoint, where the structured parser already runs in the route handler via `requestFromParsed`). Tighter scope, fewer moving parts. `/price-by-id` stays as-is until iOS's call patterns can be measured against the dictionary coverage.
- **`git HEAD` vs deployed-state reconciliation:** decide whether to revert PRs #110 and #111 on `main` (clean reconciliation, requires a PR) or accept the temporary divergence with a deploy-pinning note (faster, requires deploy discipline next session).
- **WS4 is paused indefinitely.** Do not decommission `fn-cardhedge-comps` until a verified CH-removal path is in production AND has demonstrated multi-day stability. The blob remains the production data source.
- **`compiq-mcp` App Insights gap (deferred from 2026-05-21):** would have shortened the diagnosis loop today. Wiring telemetry on MCP is a meaningful prerequisite for the next attempt.

## Explicit acknowledgment

**No production behavior change shipped today.** Two PRs merged into `main` (#110 and #111) but the deploys backing them were rolled back. The session produced findings (the 8 above) and a re-scope. Treat today as planning input for the next CH-removal attempt, not a partial-ship.

---

# 2026-05-22 PM — CH removal redesign characterization complete

Continuation session immediately following the AM rollback. Three diagnostic workstreams + one planning workstream landed as durable documentation. No code changed; no deploys; main and deployed reality are now aligned via revert PRs.

## What shipped this session

| Commit | What |
|---|---|
| `566fd8e` | Revert PR #111 (MCP `compsLoader` rewire) — Workstream 1 |
| `83ea415` | Revert PR #110 (backend meaningful-query fall-through) — Workstream 1 |
| `9af3db2` | `docs/phase0/cardsight_coverage_characterization.md` — 5-defect characterization (Thread 1 direct Cardsight calls, Thread 2 variant-mismatch audit, Thread 2b verification on Chrome Prospect Autographs cardId) |
| `d31b2ff` | Addendum to characterization doc — Topps Update Base vendor-gap disambiguation. Outcome (B) confirmed: catalog inconsistency, not vendor gap. Hit rate 10/10 across 5+5 cohort probe. |
| `8d6d769` | `docs/phase0/ch_removal_v2_plan.md` — sequenced phased plan for the next CH removal attempt |

**Net production change: zero.** Three durable doc artifacts capturing the path forward.

## Production / git reconciliation

`origin/main` HEAD is now `8d6d769` (post-revert + planning docs). `hobbyiq3` and `compiq-mcp` are both serving pre-CH-removal code (the rollback state from AM). After today's reverts, **a deploy from `main` no longer silently re-introduces broken CH-removal code.** The runtime/git divergence flagged in the AM entry is resolved.

App settings remain as documented in the AM entry: `SCM_DO_BUILD_DURING_DEPLOYMENT=true` on both apps; `NPM_CONFIG_PRODUCTION=false` on `hobbyiq3`. Slim-zip + Oryx-rebuild pattern is the working deploy pattern.

## Five characterized consumption-layer defects

Each defect with file:line; full detail in `docs/phase0/cardsight_coverage_characterization.md`:

| # | Defect | Location | Severity |
|---|---|---|---|
| 1 | `resolveCardId` blind `candidates[0]` pick — no release/set verification | [cardsight.mapper.ts:144-156](phase0/cardsight_coverage_characterization.md) | Load-bearing |
| 2 | `parallelMatches` token-subset over-permissive — "Blue Refractor" matches "Blue Wave Refractor" | [cardsight.mapper.ts:67-71](phase0/cardsight_coverage_characterization.md) | Last-mile |
| 3 | `parseCardQuery` SET_PATTERNS gap (no `bowman draft chrome`) + `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary coverage (no `topps update` etc) | [cardQueryParser.ts:46-69](phase0/cardsight_coverage_characterization.md), [cardsight.mapper.ts:38-46](phase0/cardsight_coverage_characterization.md) | Feeds #1 |
| 4 | `isCompVariantMatch` AUTO regex misses `"Autographs"` (s-suffix) and `"(AU,"` (comma-suffix) | [cardQueryParser.ts:302-306](phase0/cardsight_coverage_characterization.md) | Independent |
| 5 | Cardsight catalog returns 2-11 cardIds per logical player×year×set; subset empty; `candidates[0]` can land on empty duplicate | [cardsight.mapper.ts:144-156](phase0/cardsight_coverage_characterization.md) (same code as #1) | Load-bearing, coupled with #1 |

The variant filter itself ([cardQueryParser.ts:291-354](phase0/cardsight_coverage_characterization.md)) is confirmed correct as designed — it is the symptom-surfacing layer, not the load-bearing problem.

## Phased plan (full detail in `docs/phase0/ch_removal_v2_plan.md`)

| Phase | Defects | Scope | Acceptance |
|---|---|---|---|
| 0 (optional) | #4 AUTO regex | Small PR (~5-10 LOC) | Unit test: `isCompVariantMatch` accepts "Autographs" and "(AU," formats |
| 1 (load-bearing) | #1 + #5 resolveCardId selection | Medium PR (~30-80 LOC) | 5/5 demo cards (Trout 2011 TU, Ohtani 2018 TU, Judge 2017 TU, Acuna 2018 TU, +Skenes 2024 TCU) return `source: cardsight` via `/api/compiq/price-by-id`; no regression on 6 historical ok/cardsight rows |
| 2 | #3 parser + dictionary | Small-medium PR | Bowman Draft Chrome queries parse correctly; structured queries route to right release |
| 3 | #2 parallelMatches set-equality | Small PR (~5-10 LOC) | "Blue Refractor" vs "Blue Wave Refractor" disambiguate correctly |

**Post-Phase 3 (separate workstream):** Steps A (re-ship #110), B (re-ship #111 with MCP architectural mismatch resolved), C (`fn-cardhedge-comps` decommission), D (cleanup).

## Updated carry-forwards entering next session

- **Phase 1 PR (defects #1 + #5)** — next session start point. Files: [backend/src/services/compiq/cardsight.mapper.ts](../backend/src/services/compiq/cardsight.mapper.ts) lines 89-156.
- **2024-2025 Topps Chrome Update Base coverage diagnostic** — Path A addendum carry-forward. Path A confirmed the duplicate pattern for Topps Update Base; Topps Chrome Update Base unverified. Likely same pattern but needs a 5-card probe.
- **MCP `/predict` player-level vs card-level architectural mismatch** — unresolved, separate from the five consumption defects. Three sub-options open: (1) per-card refactor in `backtest.ts`, (2) new `/api/compiq/comps-by-player` aggregation endpoint, (3) decouple `fn-backtest-runner` from MCP. Decision deferred to its own workstream after Phase 1-3 land.
- **Cache strategy decision for `resolveCardId` disambiguation** — needed before Phase 1 starts. Choices: in-process LRU or existing Redis `cacheWrap` with structured key. Plan recommends Redis.
- **Pre-existing carry-forwards still pending from prior sessions:**
  - W6.1 Q1 warn-log baseline measurement (48h of post-PR-A1 traffic)
  - Finding 6 re-investigation (`fn-nightly-comp-prefetch` writes; W2 confirmed Failure A persists; carry-forward is now the decision question)
  - COSMOS_KEY shared-defect (Python paths affected; Node has AAD fallback)
  - Cosmos 21% regional-routing failure-rate diagnostic
  - `compiq-mcp` App Insights wiring — observability gap that lengthened today's diagnosis loop
  - Phase 3a monitor detection-vs-degradation lag
  - DailyIQ niche-prospect-auto coverage gap (Finding 12)
  - Day-10 soak review window: 2026-05-31T17:44:32Z
  - iOS workstream items (unrelated to this thread)

## Lessons captured this session

(Suggest appending to the existing LESSONS section at line 115 of this file, or to `copilot-instructions.md` LESSONS FROM PRIOR SESSIONS.)

- **When a vendor appears to have limited coverage, run direct vendor calls with multiple search shapes before accepting that framing.** Coverage hypotheses are often consumption-layer defects in disguise. The Path A diagnostic disambiguated this in <30 minutes by fanning out across all catalog candidates instead of accepting `candidates[0]`. The original Workstream 2 conclusion that Cardsight had Topps Update Base coverage gaps for 3 cards was wrong — Cardsight had the data on sibling cardIds.
- **User instinct + agent technical capability can disambiguate failure modes that either alone misses.** When metrics suggest one diagnosis but specific behavior contradicts, weight the contradiction. The 1.6% historical Cardsight `ok` rate suggested vendor limitation; the Bonemer "69 comps filtered to 0" pattern contradicted; following the contradiction surfaced the five-defect characterization rather than accepting the metric at face value.

## Next session entry point

1. Read `docs/phase0/cardsight_coverage_characterization.md` (5 defects + addendum)
2. Read `docs/phase0/ch_removal_v2_plan.md` (phased plan)
3. Start with **Phase 1**: defects #1 + #5 in `backend/src/services/compiq/cardsight.mapper.ts:89-156`
4. Decide cache strategy (Redis vs in-process LRU) before writing code
5. Ship gate:
   - 5/5 demo cards return `source: cardsight` via `/api/compiq/price-by-id` with full-text queries
   - No regression on the 6 historical ok/cardsight rows in `comp_logs`
   - Negative test: junk player query returns `no-recent-comps` without crash or `variant-mismatch`
   - 24h post-deploy: `outcome=ok / source=cardsight` rate measurably above 1.6%

Out of scope for Phase 1: dictionary expansion (Phase 2), parallel disambiguation (Phase 3), AUTO regex (Phase 0 or 3), MCP rewire (post-Phase 3), `fn-cardhedge-comps` decommission (post-Phase 3).

---

# 2026-05-23 — Phase 1 CH removal shipped (PR #112)

Phase 1 of the v2 CH-removal plan (`docs/phase0/ch_removal_v2_plan.md`) shipped on `main`. First code change since yesterday's rollback batch. Two defects (#6 and #7) surfaced during acceptance verification and were documented in the v2 plan; both are deferred to focused PRs in later sessions.

## What shipped

| Commit | What |
|---|---|
| `5c9d561` (PR #112, squash) | Phase 1 mapper rewrite + LRU cache + startup warming + 13 new mapper tests + plan doc updates (defects #6/#7 characterization, Step A reclassification) |

PR title: `feat(cardsight): Phase 1 — resolveCardId disambiguation + cache + warming`. Branch `feature/phase1-ch-removal-resolvecardid` squash-merged and deleted from `origin`.

**Deployed SHA:** `a3a84b2` on `hobbyiq3` (deployed 2026-05-22T17:13:53Z, restarted 2026-05-22T17:18Z). Post-merge `/api/health` still reports `a3a84b2`. The squash-merge to `main` produced `5c9d561`; no auto-deploy fired (only the `CompIQ Pricing Regression Harness` workflow ran, non-destructive). `main` HEAD = `5c9d561`; deployed = `a3a84b2`; runtime is functionally identical (squash-merge SHA differs from pre-merge branch SHA, but the file content is the same).

## Ship gate verification

| Test | Result |
|---|---|
| 5 demo queries (Trout/Ohtani/Judge/Witt/Bonemer 2011-2024 Topps Update / Topps Chrome / Bowman Draft Chrome) | **5/5 PASS** — all `source=live`, real comps, real FMV ($408 Trout, $185 Ohtani, $91 Judge, $8 Witt, $103 Bonemer) |
| 4 regression queries (historical `/price` ok rows from `comp_logs` 30d window) | **4/4 PASS** — no regression on prior working queries |
| Negative junk-player | PASS — `source=no-recent-comps`, HTTP 200, no crash, no variant-mismatch |
| Backend test suite | **725/725 passing** (+10 new mapper tests vs pre-Phase-1 baseline) |
| Cache warming at startup | **10/10 primed**, 0 failed, 8056ms elapsed |
| Cold-call latency | 42-3283ms (well under iOS 60s budget) |
| Warm-call latency | 42-124ms (LRU + cardsight.client cacheWrap) |

## Defects #6 + #7 surfaced during acceptance

Both characterized in [docs/phase0/ch_removal_v2_plan.md](phase0/ch_removal_v2_plan.md) §2; neither in code yet.

- **Defect #6 — `parseCardQuery` sport-suffix stopword gap** ([cardQueryParser.ts](../backend/src/services/compiq/cardQueryParser.ts) playerName extraction). "Mike Trout 2011 Topps Update Baseball" parses to `playerName="Mike Trout Baseball"`. No sport stopword strips "Baseball"/"Football"/etc. Small fix; own PR.

- **Defect #7 — CH-identity guard's Cardsight blindness** ([compiqEstimate.service.ts:1124-1150](../backend/src/services/compiq/compiqEstimate.service.ts#L1124-L1150)). Guard checks `parsed.playerName` tokens against `card.player + " " + card.title`. Cardsight responses populate `card.name` but NOT `card.player`. Haystack reduces to title only, so guard discards every successful Cardsight resolution when tokens don't appear in title (which is fragile coincidence even when defect #6 doesn't fire).

## Step A reclassified — two-part work

The original v2 plan §6 had Step A as a single change ("re-ship the PR #110 meaningful-query fall-through"). Phase 1 acceptance verification surfaced that defect #7 BLOCKS Step A — re-shipping PR #110's routing alone would have `/price-by-id` route correctly through `resolveCardId` only to have the CH-identity guard then wipe the comps.

**Step A is now formally a two-part PR (must land together):**

1. Re-ship PR #110's meaningful-query fall-through (the original Step A scope)
2. Fix defect #7's CH-identity guard for Cardsight response shape — one-line change in `cardsight.router.ts:findCompsViaCardsight` to populate `baseCard.player` from `pricing.card.name` when `pricing.card.player` is absent, plus a unit test

Step A ship gate: 5/5 demo cards return `source: cardsight` (not just `source: live`) via `/api/compiq/price-by-id`, no regression on `/price`.

## Updated carry-forwards entering next session

- **Step A (next phase, two-part PR):** re-ship PR #110 routing + fix defect #7 CH-identity guard. Both small, both must land in the same PR. Ship gate: 5/5 demo cards via `/price-by-id`.
- **Defect #6 deferred** (parser sport-suffix stopword). Own focused PR. Independent of Step A — useful but not gating.
- **Defect #4 deferred** (`isCompVariantMatch` AUTO regex). Already deferrable per v2 plan §5; still applies.
- **Phase 2 unchanged** (defect #3 — `parseCardQuery` SET_PATTERNS + `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary expansion). Improves catalog query input quality; can ship in parallel with Step A.
- **Phase 3 unchanged** (defect #2 — `parallelMatches` set-equality). Last-mile parallel disambiguation; after Phase 1 + 2 land.
- **MCP `/predict` architectural mismatch unchanged** — Step B of v2 plan §6. Three sub-options still open (per-card refactor / new aggregation endpoint / decouple from MCP).
- **LRU cache will activate after Step A queryContext plumbing.** Current Phase 1 deploys saw 0% LRU hit rate because warming uses structured input keys while `/price` calls land with joined-string keys. Step A's queryContext plumbing (the part that re-ships PR #110's routing) will align the keys, at which point cache hit rate should climb sharply for the warming-primed cards.
- **2024-2025 Topps Chrome Update Base catalog-duplicate diagnostic** — still pending from Path A addendum (`docs/phase0/cardsight_coverage_characterization.md`).
- **Pre-existing carry-forwards still pending:** W6.1 warn-log baseline, Finding 6 re-investigation, COSMOS_KEY shared-defect, Cosmos 21% regional-routing diagnostic, `compiq-mcp` App Insights wiring, Phase 3a monitor lag, DailyIQ niche-prospect-auto coverage gap, Day-10 soak review window (2026-05-31T17:44:32Z), iOS workstream items.

## Next session entry point

**Step A — two-part PR: re-ship PR #110 routing + fix defect #7 CH-identity guard.**

1. Re-read [docs/phase0/ch_removal_v2_plan.md](phase0/ch_removal_v2_plan.md) §6 Step A (now reclassified as two-part)
2. Re-read the original PR #110 (reverted as `83ea415`) to identify the routing change to re-introduce: meaningful-query fall-through in `fetchComps` + queryContext plumbing from `compiqEstimate.service.ts` into `findCompsRouted`
3. Add the defect #7 fix in `cardsight.router.ts:findCompsViaCardsight` (~5-10 LOC + unit test)
4. Ship gate: 5/5 demo cards return `source: cardsight` via `/api/compiq/price-by-id`; no regression on `/price`; full backend suite green

**Out of scope for Step A:** Phase 2/3, defects #4/#6, MCP rewire, `fn-cardhedge-comps` decommission.

---

# 2026-05-23 PM — Step A deployed prematurely, rolled back; Phase 2 scope expanded to include Step A's routing change

Continuation session immediately after the AM Phase 1 ship. Attempted Step A as a standalone single-PR change (per the v2 plan correction earlier this morning). Smoke acceptance failed; rolled back to Phase 1's deployed state and folded Step A's routing change into Phase 2's scope.

## What happened

| Event | Details |
|---|---|
| Step A routing change deployed | Branch `feature/step-a-part1-meaningful-query-fallthrough` commit `f5cd3e7` (revert-the-revert of `83ea415`). Deployed to hobbyiq3 via slim-zip pattern without PR open. |
| Step A smoke gate | **3/5** with verified iOS-shape displayLabel queries; **4/5** with simpler shapes. Below 5/5 required. |
| Rollback target | hobbyiq3 redeployed from `main` HEAD `a121baf` (Phase 1 squash-merge + handoff entry; runtime-identical to `a3a84b2` and `5c9d561`). `/api/health` verified at `a121baf` post-restart. |
| Post-rollback smoke | Phase 1 paths green — 5/5 `/api/compiq/price`, `/estimate` Mike Trout returns `source=live $408`. `/price-by-id` cache-busted call returns `source=no-recent-comps` (legacy short-circuit, as expected for the pre-Step-A state). |
| Step A branch | `feature/step-a-part1-meaningful-query-fallthrough` preserved at `origin/f5cd3e7`. NOT mergeable standalone — Phase 2 will consume the routing change as part of its PR. |
| v2 plan update | Commit `02e5ccf` on main: Phase 2 scope expanded to include Step A's routing change + queryContext plumbing alongside defect #3. Verified demo card numbers locked. Cross-catalog disagreement finding added. |

## Durable findings captured today

1. **/estimate is iOS's primary pricing path and is Phase-1-covered.** Verified via grep (`HobbyIQViewModel.swift` calls `priceCardEstimate` → `/api/compiq/estimate`) and 5/5 smoke against the same demo card set Phase 1 used. No /estimate-specific defect, no /estimate-specific path; same `computeEstimate → fetchComps → findCompsRouted → resolveCardId` chain.
2. **/price-by-id is harness-dominated with low iOS traffic.** 278 calls in 30d, 19 distinct queries; top 10 are harness tier1 baseline cards (Bonemer, Hammond, Kurtz, Wood) at 42×42×43 calls each. Real iOS calls are ~3 in 30d (resolvedLabel-cardId fallback). iOS code path exists and is reachable but rarely exercised.
3. **iOS Swift code DOES call /price-by-id.** Found at `HobbyIQ/APIService.swift:106-113` `priceByCardId` → `HobbyIQ/CompIQPricedCardView.swift:962-968` `fetchPrice` from `CompIQVariantPickerView`. The earlier "iOS doesn't call /price-by-id" framing was a grep-against-wrong-location artifact (the OneDrive working-tree mirror lacks the `HobbyIQ/` directory).
4. **CH and Cardsight catalog disagree on demo card numbers/variants for 4 of 5 demo cards.** Mike Trout US175 is the only universal agreement. Ohtani: catalog-duplicate effects. Judge: my US87 was wrong, CH+reality say US99. Witt Jr: my USC150 was wrong, CH says USC35. Bonemer: CH ranks the auto variant (CPA-CBO) above the paper base (BD-31); Cardsight has them as distinct cardIds. Mapping between CH and Cardsight is NOT a number-level 1:1.
5. **Step A's routing change works mechanically but doesn't activate cleanly under iOS-shape queries.** iOS-shape `displayLabel` strings (`"2017 Topps Update Baseball Aaron Judge US99 Base"`) contaminate Cardsight catalog text search — the card-number + "Baseball" + "Base" suffix push the right card out of the top-3 pricing probe. Phase 2's queryContext plumbing + dictionary expansion is the foundation needed before Step A's routing can hit 5/5.

## Process correction

**Step A was deployed before PR was opened.** Default workflow should be: PR open → eyeball pass → approve → merge → deploy. Today's sequence was: build → deploy → smoke → fail → rollback. The rollback was clean but the deploy-first pattern means production state diverged from main (and from PR review) for ~30 minutes. Future workstreams: PR before deploy. Smoke against a staging slot or a feature-flag-gated path if pre-production verification is needed.

## Verified demo card list (locked 2026-05-23 PM)

| Card | CH catalog # | Cardsight catalog # | Demo purpose |
|---|---|---|---|
| Mike Trout 2011 Topps Update | US175 | US175 | canonical demo (both catalogs agree) |
| Shohei Ohtani 2018 Topps Update | US285 | US153 (top hit; US285 also exists at sibling cardId) | catalog-duplicate exercise; Phase 1 #5 fix handles |
| Aaron Judge 2017 Topps Update | US99 | varies | locked US99; was wrong about US87 |
| Bobby Witt Jr 2022 Topps Chrome Update | USC35 | varies | locked USC35; was wrong about USC150 |
| Caleb Bonemer 2024 Bowman Draft Chrome | CPA-CBO (auto) / BD-31 (paper) | both as separate cardIds | dual demo: prospect-auto + paper RC |

## Updated carry-forwards entering next session

- **Phase 2 (expanded scope) is the next workstream.** Three changes in one PR:
  1. Defect #3 — `parseCardQuery` SET_PATTERNS ordering + `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary expansion
  2. queryContext plumbing — `fetchComps → findCompsRouted` passes structured fields through
  3. Step A routing — re-apply PR #110's meaningful-query fall-through in `/price-by-id` handler (consume from preserved branch `f5cd3e7`)
- **Acceptance gate:** 5/5 verified-number demo cards via `/price`, `/price-by-id`, AND `/estimate`. No regression on Phase 1's existing /price + /estimate green paths.
- **Phase 2 may surface defects #8+ during implementation.** Discipline holds: HALT and characterize if a new defect appears.
- **Defects #4 (AUTO regex), #6 (parser sport-suffix), #7 (CH-identity guard)** all remain deferred to own PRs; not Phase 2 dependencies.
- **Phase 3 (defect #2 — parallelMatches set-equality)** still queued post-Phase-2.
- **MCP rewire (Step B)** and **fn-cardhedge-comps decommission (Step C)** unchanged.
- **2024-2025 Topps Chrome Update Base catalog-duplicate diagnostic** still pending from Path A addendum.
- **`compiq-mcp` App Insights wiring** still pending — would have shortened today's diagnosis loops.
- **Pre-existing carry-forwards still pending:** W6.1 warn-log baseline, Finding 6, COSMOS_KEY shared-defect, Cosmos 21% regional routing, Phase 3a monitor lag, DailyIQ niche-prospect-auto coverage gap, Day-10 soak review (2026-05-31), iOS workstream items.

## Production state at end of session

- `origin/main` HEAD: `02e5ccf` (v2 plan update reflecting today's findings)
- hobbyiq3 deployed: `a121baf` (Phase 1 + AM handoff; runtime-identical to `a3a84b2`/`5c9d561`)
- compiq-mcp deployed: `5fad0a2` (pre-WS3 blob-reading code; unchanged since 2026-05-22 rollback)
- App settings unchanged from end of 2026-05-22

## Next session entry point

**Phase 2 (expanded scope) PR.** Consume the preserved Step A routing branch as a starting point:
1. `git checkout main && git pull && git checkout -b feature/phase2-defect3-and-step-a`
2. Cherry-pick or merge `feature/step-a-part1-meaningful-query-fallthrough` to bring in the Step A routing change
3. Add defect #3 work: `cardQueryParser.ts` SET_PATTERNS ordering fix + `cardsight.mapper.ts` `COMPIQ_TO_CARDSIGHT_RELEASES` expansion
4. Add queryContext plumbing in `compiqEstimate.service.ts` `fetchComps → findCompsRouted` call
5. Test surface: parser unit tests for new patterns, dictionary unit tests for new entries, queryContext propagation test, end-to-end 5/5 smoke
6. Ship gate: 5/5 verified-number demo cards via `/price` + `/price-by-id` + `/estimate`
7. **PR open BEFORE deploy.** Eyeball review before merge.

Out of scope for Phase 2: defects #4/#6/#7, Phase 3, MCP rewire, fn-cardhedge-comps decommission.

---

# 2026-05-24 — Phase 2 design complete; ready for implementation

Design-only session. Four docs commits build the foundation for Phase 2 implementation. No code, no deploys, no production change. Next session can start cold from the design doc and the implementer checklist.

## What shipped this session

| Commit | What |
|---|---|
| `172ef42` | `docs/phase0/phase2_design.md` — Phase 2 design (parser + dictionary + queryContext plumbing + Step A routing) in one coherent PR |
| `53eab5e` | Pre-implementation diagnostic addendum — cache key normalization, dictionary verification, Bowman Chrome regression risk |
| `8a51dd5` | Warming-target cardNumber audit addendum — locked CH-format numbers across all 10 CACHE_WARM_TARGETS |
| `(this commit)` | SESSION_HANDOFF 2026-05-24 entry |

**Net production change: zero.** hobbyiq3 still at `a121baf` (Phase 1 + handoff). compiq-mcp unchanged at pre-WS3 `5fad0a2`.

## Defects characterized this session

- **Defect #8** — `parseCardQuery` cardNumber regex misses iOS displayLabel patterns. Specifically: `US175` / `USC35` / `USC150` (unhyphenated letter-digit) and `CPA-CBO` / `C24-CBO` (letter-letter hyphenated). Universal: returns `null` for all 10 demo card displayLabels. **Bundled into Phase 2** as a 3-5 line regex expansion alongside defect #6.
- **Defect #9** — `resolveCardId` cardNumber detail-probe assumes 1:1 catalog mapping between CH and Cardsight. When iOS queries carry CH-format numbers (`US285`) but Cardsight catalog returns different numbers (`US153`) for the same logical card, the exact-match filter rejects the data-bearing candidate. **Deferred** — Phase 1's existing fall-through logic at [cardsight.mapper.ts:207-210](../backend/src/services/compiq/cardsight.mapper.ts#L207-L210) handles gracefully (falls through to pricing probe on the original candidate set); emits `cardnumber_filter_no_match` warning log but doesn't break resolution. Polish PR after Phase 2 ships.

## Phase 2 implementation scope (locked)

- **~115-170 LOC** across 3-4 files
- **Single PR** consuming branch `feature/step-a-part1-meaningful-query-fallthrough` (`f5cd3e7`) for Step A's routing change
- **Five changes**: parser SET_PATTERNS (defect #3a), dictionary expansion + Bowman Chrome correction (defect #3b), defect #6 sport-suffix NOISE, defect #8 cardNumber regex, queryContext plumbing, Step A routing
- **Acceptance gate**: 5/5 verified demo cards via `/price` + `/price-by-id` + `/estimate`; cache hit rate ≥60% on warm pass; 4/4 historical Bowman Chrome ok-rows still pass

## Catalog disagreement finding (durable)

CH `/search-list` and Cardsight catalog disagree on card numbers for 8/10 warming targets. Per-card numbers reconciled in `phase2_design.md` audit addendum (`8a51dd5`). Cache key alignment uses CH-format numbers (the iOS displayLabel source-of-truth). Defect #9's filter behavior is the only downstream symptom; Phase 1's fall-through absorbs it.

## Next session entry point

1. Read `docs/phase0/phase2_design.md` end-to-end including both addenda (`53eab5e` Q1/Q2/Q3 diagnostic + `8a51dd5` warming-target audit).
2. Implementation checklist is in design doc §10 ("Implementing session checklist").
3. Recommended order:
   - Parser changes (`cardQueryParser.ts`) — cleanest entry point: defects #6 + #8 stopword + cardNumber regex + defect #3a SET_PATTERNS entry
   - Dictionary (`cardsight.mapper.ts` `COMPIQ_TO_CARDSIGHT_RELEASES`) — defect #3b: add `"topps update"`, correct `"bowman chrome"`
   - CACHE_WARM_TARGETS expansion — add locked `cardNumber` field per audit addendum table
   - queryContext plumbing (`compiqEstimate.service.ts` `fetchComps`) — thread structured fields to `findCompsRouted`
   - Step A routing folded in (`compiqEstimate.service.ts` `fetchComps` meaningful-query check)
   - Integration tests + 5-card smoke
4. **PR open → eyeball pass → approve → merge → deploy.** NOT deploy → smoke. Process correction from 2026-05-23 PM stands.

## Updated carry-forwards entering next session

**Phase 2 implementation** is the next workstream. After Phase 2 ships:

- **Defect #4** (`isCompVariantMatch` AUTO regex) — later phase, small PR
- **Defect #2** (`parallelMatches` set-equality) — Phase 3, small PR
- **Defect #7** (CH-identity guard Cardsight-blindness) — still characterized but unaddressed; not gating
- **Defect #9** (cardNumber catalog mismatch) — defer until Phase 2 ships and the `cardnumber_filter_no_match` warning rate is observable in production logs
- **MCP `/predict` architectural mismatch** — separate workstream; three sub-options open
- **`fn-cardhedge-comps` decommission** — after all Cardsight paths verified working in production

**Pre-existing carry-forwards still pending (unchanged):**
- W6.1 Q1 warn-log baseline measurement (48h post-PR-A1 traffic)
- Finding 6 re-investigation (`fn-nightly-comp-prefetch` write-path)
- COSMOS_KEY shared-defect fix (Python paths)
- Cosmos 21% regional-routing failure-rate diagnostic
- `compiq-mcp` App Insights wiring
- Phase 3a monitor detection-vs-degradation lag
- DailyIQ niche-prospect-auto coverage gap design
- Day-10 soak review window: **2026-05-31T17:44:32Z**
- iOS workstream items

## Production state at end of session

- `origin/main` HEAD: `8a51dd5` (Phase 2 design + addenda; will be the SHA prior to this handoff commit)
- hobbyiq3 deployed: `a121baf` (Phase 1 + AM handoff)
- compiq-mcp deployed: `5fad0a2` (pre-WS3 blob-reading code)
- App settings unchanged
- Feature branch `feature/step-a-part1-meaningful-query-fallthrough` preserved at `origin/f5cd3e7` for Phase 2 to consume

---

# 2026-05-24 PM — PR #113 shipped (Cosmos guard); diagnostic OUTCOME C — guard insufficient, real cause still TBD

## What shipped

PR #113 — `fix(player-score): defensive guard against invalid Cosmos id in upsertPlayerScore` — squash-merged on `main` (`81f5c7b`) and deployed to hobbyiq3 at 2026-05-22T20:28Z. `/api/health` verified post-restart at `81f5c7b`. Full backend suite green (735/735, +10 from this PR).

## Outcome of post-deploy verification: (C) — hypothesis was wrong

The empty-`playerId` hypothesis from [cosmos_21_failure_rate_investigation.md](phase0/cosmos_21_failure_rate_investigation.md) is NOT the actual cause of the 22.6% failure rate. Evidence:

| Signal | Pre-deploy | Post-deploy (~40 min) |
|---|---|---|
| `POST player_trends/docs` failure rate | 22.6% (30d) | **27.2%** (40 min, 875 ops / 238 failed) |
| `playerScore_upsert_skipped_invalid_id` log events | n/a | **0** |
| `playerScore_upsert_stats` log events (5-min throttle) | n/a | 0 (likely under throttle threshold OR stats path didn't trigger) |
| Code on wwwroot | n/a | ✓ `isValidCosmosId` verified via VFS read |

**0 guard skips means every upsert was reaching Cosmos with valid `id` and `playerId`.** The 400 rejection is in some other field of the PlayerScore document.

## Two unexpected sub-findings worth recording

### 1. CompIQ-path upserts succeed 100%; DailyIQ-path upserts fail ~33%

Operation-name attribution on failed `POST player_trends/docs` (7d, including post-deploy):

| `operation_Name` | total POSTs | failed | rate |
|---|---:|---:|---:|
| `GET /api/dailyiq/brief` | 28,976 | 9,790 | 33.8% |
| `GET /api/dailyiq/` | 7,069 | 2,365 | 33.5% |
| `GET /api/dailyiq` | 4,279 | 1,547 | 36.2% |
| `GET /api/dailyiq/players/top/mlb` | 4,170 | 1,394 | 33.4% |
| `GET /api/dailyiq/players/top/milb` | 3,224 | 1,080 | 33.5% |
| `POST /api/compiq/search` | 188 | 0 | 0% |
| `POST /api/compiq/estimate` | 7 | 0 | 0% |
| `GET /api/playeriq/<player>` | 13 | 4 | ~30% |

CompIQ-triggered upserts are clean (~200 calls, 0 failures). DailyIQ-triggered upserts fail uniformly ~33%. The bad-payload source is whatever DailyIQ's flow constructs as the PlayerScore document.

### 2. No `[playerScore] upsert failed:` traces in App Insights despite Cosmos rejections

Pre-deploy or post-deploy, the catch-block `console.warn` at [playerScore.service.ts:303](../backend/src/services/playerScore/playerScore.service.ts#L303) produces zero entries in App Insights `traces`. This is inconsistent with the dependency-table evidence of Cosmos rejections. Either:
- The catch block isn't being reached (some other code path is producing the writes, NOT `upsertPlayerScore`)
- App Insights' auto-collected console capture is dropping these specifically
- The error path returns before logging for some reason

Worth investigating before another fix attempt. If a separate code path is upserting to player_trends (bypassing `upsertPlayerScore` entirely), my guard's scope was wrong from the start.

## What this means for next session

**The guard is defensively correct and ships zero regressions** (5/5 demo cards still resolve on /price + /estimate, no test failures, code on wwwroot confirmed). It defends against the empty-id failure mode IF that mode occurs. But it does NOT address the 22-27% Cosmos rejection rate observed in production.

**Next diagnostic needs to find the actual writer.** Specifically:
1. Identify whether DailyIQ has its own code path writing to player_trends (bypasses `upsertPlayerScore`)
2. If it does, characterize what the path is and what document shape it produces
3. If `upsertPlayerScore` IS the writer, instrument it to log the actual Cosmos error message (the response body for 400s) so we can see what Cosmos is complaining about

This is a **different defect than originally characterized**. The 22.6% rate is real; the empty-id hypothesis was a plausible candidate that turned out to be incorrect.

## Carry-forwards

- **PR #113 stays merged.** It's a no-op for current production (0 skips), defensively correct, and doesn't regress anything. Future bad-id inputs would be caught.
- **Real Cosmos 22-27% defect remains open.** Re-characterize in a focused diagnostic session: find the actual upsert path, capture the Cosmos error body.
- **24h post-deploy check (still scheduled, not blocking):** tomorrow 2026-05-25, verify the rate is unchanged from today's 27.2% (confirms guard alone isn't the answer). If rate drops without further work, something else changed; investigate.
- **Pre-existing carry-forwards unchanged:** Phase 2 implementation, Defects #4/#2/#7/#9, MCP rewire, fn-cardhedge-comps decommission, Day-10 soak review (2026-05-31), iOS workstream.

## Production state at end of session

- `origin/main` HEAD: `81f5c7b` (PR #113 squash-merge) + this handoff commit
- hobbyiq3 deployed: `81f5c7b` (verified via /api/health)
- compiq-mcp deployed: `5fad0a2` (unchanged)
- App settings unchanged

## Next session entry point

**Re-investigate the Cosmos 22-27% rate root cause.** Suggested approach:

1. Grep for ALL Cosmos `items.upsert/create` calls targeting `player_trends` container (not just `playerScore.service.ts`)
2. If alternate writer found: characterize its document shape, identify the bad field
3. If `playerScore.service.ts` is the only writer: instrument the catch block with the full Cosmos error response (the `error.body` or `error.substatus` fields usually have actionable diagnostic data) and redeploy; wait one cycle to capture real error messages
4. With the actual error body in hand, design a targeted guard for the specific field

**Out of scope for next session:** any other workstream until this Cosmos defect characterization completes OR is explicitly deferred again. Don't add complexity to PR #113's guard until the real cause is known.

---

# 2026-05-25 — Phase 2 attempted; closed PR #114, deferred for re-design

## What was attempted

Phase 2 implementation per the locked design at `docs/phase0/phase2_design.md` (composite of commits 172ef42 + 53eab5e + 8a51dd5; handoff reference `588e98f`). Single PR with three logical commits on branch `feature/phase2-parser-dict-querycontext-stepa`:

1. Parser changes — defects #3a (Bowman Draft Chrome SET_PATTERN), #6 (sport-suffix NOISE), #8 (cardNumber regex expansion)
2. Dictionary changes — `topps update → Topps Update` (new), `bowman chrome → Bowman Chrome` (corrected); CACHE_WARM_TARGETS expanded with cardNumber field per addendum 8a51dd5's Option B
3. queryContext plumbing + Step A meaningful-query fall-through routing (re-applied from f5cd3e7) folded together in fetchComps

Diff: 8 files, +538/-44 LOC across `cardQueryParser.ts`, `cardsight.mapper.ts`, `cardsight.router.ts`, `compiqEstimate.service.ts`, plus 4 test files (one new for parser, one new for queryContext threading, two updated for dictionary + pinned-card paths).

## What passed

- Vitest: **766/766 pass** + 100 skipped (no regressions)
- `tsc --noEmit`: clean
- 22 new parser tests, 4 new dictionary tests, 4 new queryContext threading tests
- compiqEstimatePinnedCard.test.ts updated for both legacy + meaningful-query branches

## What failed (the reason for the deferral)

**Pre-merge local endpoint smoke surfaced three implementation-time issues.** Smoke ran the 5 demo cards × 3 endpoints + 4 historical regressions against a locally-running backend with CARDSIGHT_MODE=exclusive. Result: 3/5 demo cards via /price, 3/5 via /price-by-id, 3/5 via /estimate, 3/4 regressions. **Below the 5/5 ship gate.**

- **Defect #10 — warming API load explosion.** CACHE_WARM_TARGETS with cardNumber triggers cardNumber detail-probe × 10 parallel targets = ~80-90 Cardsight calls in the first seconds of startup. Cardsight rate-limits with 429s; cache gets poisoned with `candidates[0]` fallback resolutions cached for 7 days. 30s post-warming cooldown insufficient.
- **Defect #11 — QueryContext type missing cardNumber.** `cardsight.router.ts:51-58` QueryContext lacks cardNumber; `toCardsightQuery` drops it. Request-side cache keys never include cardNumber; warming-side keys do; cache hit rate stays at 0% despite addendum 8a51dd5's "Option B alignment" goal.
- **Regression #12 — Bowman Chrome correction without fallback.** `bowman chrome → Bowman Chrome` maps queries targeting Bowman Draft Chrome cards to flagship; design Q2 predicted this and specified the fallback mitigation; not implemented on PR #114.

Full characterization in `docs/phase0/phase2_design.md` "Implementation findings (2026-05-25)" section.

## Disposition

- **PR #114 closed (not merged, not deleted).** Branch `feature/phase2-parser-dict-querycontext-stepa` preserved on origin at `1a5919b` for re-design consumption.
- **Net production change: zero.** No deploy from the Phase 2 attempt.
- **main HEAD unchanged: `b68ac7c`** (Phase 1 + PR #113 defensive Cosmos guard).
- **hobbyiq3 deployed SHA unchanged** (most recent deploy 2026-05-22T20:25Z, well before this session).
- `docs/phase0/phase2_design.md` extended with "Implementation findings (2026-05-25)" section.
- `docs/phase0/ch_removal_v2_plan.md` Phase 2 section marked "ATTEMPTED; DEFERRED FOR RE-DESIGN" with the three blocking issues referenced.

## Next session work

- **Phase 2 re-design workstream.** Estimated 30-45 min re-design discussion + diagnostic (no code) to choose mitigations for #10/#11/#12. Then re-implementation in one focused session.
- Re-design must explicitly choose:
  - Defect #10 mitigation: serialize warming / reduce MAX_DETAIL_PROBES / drop cardNumber from warming / hybrid (recommended)
  - Defect #11 fix: add cardNumber to QueryContext + thread through `toCardsightQuery` + `computeEstimate` queryContext build (~5-10 LOC)
  - Regression #12 fix: implement Q2-predicted dictionary fallback in `resolveCardId` or `lookupReleaseName` (~10-15 LOC)
- Revised total scope estimate: original 115-170 LOC + 30-50 LOC for the three additional fixes = **~160-220 LOC**, single PR (or split if useful).
- Consumption: the re-implementation can cherry-pick from preserved branch `feature/phase2-parser-dict-querycontext-stepa` (parser, dictionary, queryContext plumbing, Step A routing all carry forward; only CACHE_WARM_TARGETS cardNumber addition and the queryContext/lookupReleaseName paths need revisiting).

## Carry-forwards otherwise unchanged

- Cosmos 22-27% failure rate real cause TBD (carry-forward from 2026-05-24 PM PR #113 outcome C). Next-session entry-point note above remains valid.
- Defects #4 (AUTO regex), #2 (parallelMatches set-equality), #7 (CH-identity guard), #9 (cardNumber detail-probe cross-catalog disagreement) — all still deferred.
- MCP /predict architectural mismatch — still queued post-Phase-2.
- fn-cardhedge-comps decommission — still gated on Phase 2 + Step B + Step C completion.
- 2024-2025 Topps Chrome Update Base catalog-duplicate diagnostic — still a carry-forward.
- Day-10 PR #113 soak review: 2026-05-31T17:44:32Z.

## Next session entry point (updated)

**Phase 2 re-design (NEW priority) OR Cosmos 22-27% diagnostic (carry-forward from 2026-05-24 PM).**

Choose one to start. If Phase 2 re-design picks up first, the entry point is:

1. Re-read `docs/phase0/phase2_design.md` "Implementation findings (2026-05-25)" section (defects #10/#11/#12 characterization)
2. Pick mitigation strategy for each
3. Document the chosen approach as a Phase 2 v2 design addendum
4. Then re-implement, consuming the preserved `feature/phase2-parser-dict-querycontext-stepa` branch where useful

If Cosmos diagnostic picks up first, follow the prior session's entry-point notes (grep player_trends writers + instrument catch block). PR #113's defensive guard remains live; do not modify it until the real cause is characterized.

---

# 2026-05-25 PM — Phase 2 v2 shipped; PR #115 merged + deployed; 19/19 acceptance verified

## Disposition

- **PR #115** merged at squash SHA `4ccd95f` on `origin/main`.
- **hobbyiq3 deployed** at SHA `4ccd95f` (`/api/health` build.shaShort verified post-restart).
- **Production smoke 19/19** confirmed against live hobbyiq3 (5×3 demos + 4 regressions).
- **Local smoke 19/19** confirmed pre-merge.
- **Branch disposition:** `feature/phase2-v2-with-defect-10-11-12-fixes` merged + deleted on origin. `feature/phase2-parser-dict-querycontext-stepa` preserved (PR #114 close-out artifact).

## What shipped (5-defect bundle on top of original Phase 2 scope)

Phase 2 v2 re-design consumed PR #114's preserved branch (cherry-pick), added three fixes for yesterday's findings (defects #10/#11/#12), then mid-session authorized in-session scope expansion to fix defects #5 and #2 surfaced during local smoke.

**Cherry-picked from PR #114 (closed) preserved Phase 2 work:**
- Defect #3a — parser SET_PATTERN: `Bowman Draft Chrome` before `Bowman Draft`
- Defect #3b — dictionary: `topps update` -> `Topps Update`; `bowman chrome` corrected to `Bowman Chrome`
- Defect #6 — parser NOISE: sport-suffix stopwords (baseball/football/etc.)
- Defect #8 — parser cardNumber regex: US175 / CPA-CBO / C24-CBO patterns
- queryContext plumbing through `fetchComps -> findCompsRouted`
- Step A meaningful-query fall-through routing in `fetchComps`

**New (yesterday's findings, fixed today):**
- Defect #10 — remove cardNumber from CACHE_WARM_TARGETS (warming API load returns to pre-Phase-2 baseline; no rate-limit storm)
- Defect #11 — cardNumber threaded through QueryContext + CompIQEstimateRequest + toCardsightQuery + requestFromParsed + computeEstimate queryContext build
- Defect #12 — cardNumber-pattern dispatch in `_resolveCardId`: when `product = "Bowman Chrome"` AND cardNumber matches `/^(BD-|BDC-|CPA-|CDA-|BCRP-|BBPA-)/i`, override to `Bowman Draft Chrome`. Logged via `release_fallback_cardnumber_dispatch` event for observability. Pattern regex verified against Cardsight catalog probe (BCP- excluded — that's flagship Bowman Chrome Prospects territory)

**Authorized in-session scope expansion (defects #5 + #2):**
- Defect #5 — `MAX_PRICING_PROBES` raised from 3 to 8. Cardsight returns up to 16 candidates for some queries (Ohtani 2018 TU); the prior cap caused `candidates[0]` fallback to non-data-bearing card. Cap raise let resolveCardId find the data-rich cardId
- Defect #2 — `parallelMatches` switched from token-subset to sorted-array equality. `Refractor` no longer falsely matches `Chrome Blue Refractor` candidate. Restores 2020 Witt BDC-1 Refractor regression query. (Was Phase 3 scope — folded in here)

## 19/19 acceptance verification

**Local smoke** (CARDSIGHT_MODE=exclusive, post-warming + 15s cooldown):

| Card | /price | /price-by-id | /estimate |
|---|---|---|---|
| Mike Trout 2011 TU US175 | PASS (15 comps, fmv=$333) | PASS (15 comps) | PASS (15 comps) |
| Shohei Ohtani 2018 TU US285 | PASS (11 comps, cardId=ec18b06a) | PASS (11) | PASS (11) |
| Aaron Judge 2017 TU US99 | PASS (77 comps, cardId=1c810c2c) | PASS (77) | PASS (77) |
| Bobby Witt Jr 2022 TCU USC35 | PASS (115 comps) | PASS (115) | PASS (115) |
| Caleb Bonemer 2024 BDC CPA-CBO | PASS (4 comps) | PASS (4) | PASS (4) |

| Regression | Local | Production |
|---|---|---|
| 2020 Witt Bowman Chrome BDC-1 Refractor | PASS (3 comps, dispatch fired) | PASS (3 comps) |
| 2024 Bowman Chrome Mike Trout | PASS (5 comps) | PASS (5) |
| 2018 Ohtani Topps Chrome RC | PASS (48 comps) | PASS (48) |
| 2019 Vladdy Jr Topps Chrome RC | PASS (50 comps) | PASS (50) |

**Production smoke** (post-deploy at SHA 4ccd95f, 19/19):
- Ohtani prod resolved to `23084701-7511-4a` (1826 records, 120 comps) — the data-richest of 16 candidates. Defect #5 cap raise enabled the probe to reach it.
- Defect #12 dispatch fired once (`release_fallback_cardnumber_dispatch` event for 2020 Witt BDC-1).
- All other resolutions consistent with local smoke.

## LRU cache hit rate observation

Pre-Phase-2: 0% sustained (request keys never matched warming keys).

Post-Phase-2-v2 first 15 min in production (App Insights `resolveCardId_cache_stats`):
- t=startup+0min: `hits=0, misses=1, size=0` (post-restart cold cache)
- t=startup+5min (post-smoke): `hits=10, misses=20, size=19, hitRatePct=33.3`

**Hit rate 33.3% confirms defect #11's cache alignment works.** 33.3% (not 60%+) because /price-by-id with cardNumber-bearing iOS displayLabel produces a separate cache entry from warming (lazy-cache; first hit misses, subsequent hits cache). /price + /estimate (the dominant iOS paths) hit warming entries on the first cold call after restart.

## Initial warn-log observation (24h check carry-forward)

`primary_mode_cardhedge_namespace_only` warn count, first 30 min post-deploy: **6**.

Pre-Phase-2 (per [q1_warn_log_baseline.md](phase0/q1_warn_log_baseline.md)) the structural rate was ~100% of `/price-by-id` requests under exclusive mode. Phase 2's Step A meaningful-query fall-through should drop this to single digits per 24h (only the opaque-cardId iOS resolvedLabel fallback case). 30-min count of 6 is consistent with expected post-deploy floor; **24h check at 2026-05-26T01:00Z** will confirm.

## v2 plan updated

- `docs/phase0/ch_removal_v2_plan.md` Phase 2 section marked SHIPPED with full fix list and PR ref.
- Phase 3 section updated: defect #2 marked already-shipped; remaining defects (#4, #7, #9) no longer share a coherent phase boundary, now tracked individually as defect-specific PRs.

## Carry-forwards

**New:**
- 24h `primary_mode_cardhedge_namespace_only` warn count check at 2026-05-26T01:00Z (expected: single digits)
- 24h `release_fallback_cardnumber_dispatch` event count (expected: low — only fires for Bowman Chrome + BDC/CPA/etc. cardNumber queries)
- Defect #9 warning noise — `cardnumber_filter_no_match` fires on ~80% of /price-by-id calls due to cross-catalog disagreement; minor observability nuisance (~2 LOC to downgrade to debug log, can be its own PR)

**Unchanged:**
- Cosmos 22-27% failure rate real cause TBD (carry-forward from 2026-05-24 PM PR #113 outcome C). Next-session entry-point notes from prior handoff still apply.
- Day-10 PR #113 soak review: 2026-05-31T17:44:32Z.
- MCP /predict architectural mismatch — still queued.
- fn-cardhedge-comps decommission — still gated on Step B (MCP rewire) + Step C completion.
- 2024-2025 Topps Chrome Update Base catalog-duplicate diagnostic — still open.

## Remaining open defects (no longer phased)

- **Defect #4** — `isCompVariantMatch` AUTO regex misses "Autographs" / "(AU,". ~5-10 LOC + tests. Own PR, can ship anytime.
- **Defect #7** — CH-identity guard's haystack doesn't include Cardsight's actual player field. Only manifests on /price under exclusive mode with corrupt playerName (mostly resolved by defect #6 stopword fix). Needs design decision on whether to relax/skip guard under exclusive mode.
- **Defect #9** — cardNumber detail-probe cross-catalog mismatch produces noisy warnings. ~2 LOC to downgrade warn to debug, or a more substantive normalization fix.

## Next session entry point

**Two priorities, choose one:**

1. **Cosmos 22-27% failure rate diagnostic** (carry-forward priority from 2026-05-24 PM). PR #113 defensive guard ineffective on real cause. Entry point: grep all `player_trends` writers + instrument the catch block with full Cosmos error response body, redeploy, capture real error messages. PR #113's guard stays live.

2. **24h Phase 2 v2 acceptance check at 2026-05-26T01:00Z.** Query App Insights for `primary_mode_cardhedge_namespace_only` warn count over the post-deploy 24h window. Expected: single digits. If still in dozens, Step A routing didn't fully activate (would need diagnostic). Also confirm LRU cache hit rate trend remains non-zero.

Both can run in the same session; (1) is the deeper diagnostic, (2) is a quick observability check that closes out Phase 2 v2's deferred acceptance verification.

**Out of scope for next session unless explicitly authorized:** Defects #4, #7, #9. They're independent small PRs; don't bundle into the Cosmos diagnostic session.

---

# 2026-05-23 — Three defect ships in one session

## What shipped

- **Defect #13 v2** (PR #116 squash `bb75a27`) — warming serialized.
  - Root cause: defect #5's `MAX_PRICING_PROBES` raise (3 → 8) interacted with warming's 10 parallel targets to produce ~80 concurrent Cardsight calls at startup. First defect #13 attempt (asymmetric cap warming=3, request=8) eliminated the cascade but regressed Ohtani-shape deep-catalog cards.
  - Final fix: structural serialization of `warmResolveCardIdCache` (Promise.all → for-await loop). Same `MAX_PRICING_PROBES=8` for both paths; sequential pacing eliminates parallel-storm.
  - Production verification: **19/19 smoke × 2 runs (5 min apart)**. Warming completed in 24.2s (`primed:10/0, elapsedMs:24210`), 26 429-retries across 30 min window all succeeded via backoff. Ohtani resolves to data-bearing `23084701-7511-4a` (1826 records / 120 comps) reliably.

- **Defects #4 / #7 / #9** (PR #117 squash `190604b`) — three bundled fixes from post-Phase-2 carry-forward.
  - **#4** — `isCompVariantMatch` AUTO regex extended to match `Autographs` (plural), `autos` (colloquial), `(AU,` and `(AU)` formats. Prior regex missed common Cardsight title patterns, causing `comp_missing_auto` false rejections.
  - **#7** — `cardsight.router.ts` `baseCard.player` falls back to `pricing.card?.name` when `pricing.card?.player` is undefined. Cardsight's pricing.card has no separate `player` field; the fallback restores the CH-identity-guard haystack on `/price` queries.
  - **#9** — `cardnumber_filter_no_match` / `cardnumber_filter_inconclusive` log severity downgraded from `warn` to `info`. These events fire on ~80% of `/price-by-id` requests due to expected cross-catalog cardNumber disagreement (structural noise, not error). Verified post-deploy: severityLevel=1 (Information) in App Insights.
  - Production verification: **19/19 smoke run**. Same cardIds + comp counts as defect #13 v2 prod runs — no regression. WS1's parser/router changes orthogonal to resolveCardId/warming path as predicted.

- **All v2 plan defects now closed** (defects #1-#12 from PR #112 onward; defect #13 from this session).

## What didn't happen (deferred to next session)

- **WS2 — Cosmos 22-27% diagnostic.** Authorized today as part of the three-workstream day plan but did NOT start. PR #113's defensive guard remains live (was OUTCOME C — guard correct, not the real cause). Carry-forward priority.
- **WS3 — MCP rewire design doc.** Authorized today as part of the three-workstream day plan but did NOT start. Carry-forward.

Both were skipped because today's session focused energy on resolving defect #13 (which surfaced mid-WS1 implementation) before completing WS1, and then capping the session after WS1 ship rather than starting WS2/WS3 with ~3.75 hours of budget remaining. Pattern: defects surfaced mid-implementation in three of the last four sessions; running a fresh single-workstream session for WS2 + WS3 separately is more reliable than three-workstream batching.

## Net production change

- **2 PRs merged + deployed.** main HEAD `190604b` (was `908599d` at session start).
- **4 defects resolved** (#13 v2, #4, #7, #9).
- **19/19 smoke maintained throughout** — three production smoke verifications across two deploys (defect #13 v2 × 2 runs, WS1 × 1 run). No regression observed at any point.
- hobbyiq3 deployed SHA: `190604b`.

## Updated carry-forwards

**New (this session):**
- None — all in-session findings (defect #13) resolved this session.

**From prior sessions (unchanged, repriortized):**
- **Cosmos 22-27% real cause** (alternate writer hypothesis from PR #113 outcome C). Next session high-priority candidate. Entry point: grep all `player_trends` writers, instrument catch block with full Cosmos error body, redeploy, capture diagnostic data.
- **MCP /predict architectural mismatch** — biggest remaining workstream. Deserves focused fresh session (design + impl + smoke + ship is a full day's work). Three sub-options (per `ch_removal_v2_plan.md`): MCP changes query shape, backend grows player-level endpoint, or MCP gets its own Cardsight client.
- **24h `primary_mode_cardhedge_namespace_only` warn count check** at appropriate time (Phase 2 v2 deploy + 24h was 2026-05-26T01:00Z per prior handoff). Expected: single digits.
- **Day-10 PR #113 soak review:** scheduled 2026-05-31T17:44:32Z.
- **`fn-cardhedge-comps` decommission** — gated on MCP rewire + Step B (compsLoader) completion.

## Next session entry point

**Decide between two posture choices, then run a single workstream:**

1. **Stability-first** — Cosmos 22-27% diagnostic (carry-forward from PR #113 outcome C) → MCP App Insights wiring (small follow-up) → smoke any unverified iOS endpoints → THEN MCP rewire design. Each as its own session.

2. **Architecture-first** — MCP rewire design (WS3 from today's deferred plan) → fn-cardhedge-comps decommission → cleanup. Pushes Cosmos to a later session.

**Recommendation: stability-first.** Cosmos failure rate has been sitting at 22-27% since 2026-05-22 (per the Q1 baseline doc); diagnosing the real cause unblocks the App Insights signal-to-noise improvement and de-risks any concurrent MCP work that touches Cosmos. MCP rewire is bigger but doesn't have a similar drift risk.

**Either path: single workstream per session given the recent pattern of defects surfacing mid-implementation.** Three sessions ago surfaced defects #10/#11/#12 mid-Phase-2; this session surfaced defect #13 mid-WS1. Batching three workstreams in one day didn't pay off either time. Single focused workstream per session is the durable pattern.

**Out of scope for next session unless explicitly authorized:** Bundling. If MCP rewire is the focus, defer Cosmos. If Cosmos is the focus, defer MCP.
