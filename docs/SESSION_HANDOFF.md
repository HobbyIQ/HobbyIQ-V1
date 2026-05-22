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

### 7. `fn-compiq` App Insights observability also unwired

99 trace rows + 2 request rows in 30 days across the entire 14-function app. Only `fn-ebay-signals` and `fn-reddit-signals` emit visible telemetry. Blob mtime is the only reliable invocation signal for the other 7 timer functions. The bifurcation pattern from `hobbyiq3` repeats — observability is structurally underdeveloped across the system, not just on the API.

### 8. Storage-account naming discrepancy

Brief said `stcompiqfnotgm` for the function-app storage. Reality: **`stcompiqfnotgm2` (active, eastus)** is bound to `fn-compiq`'s `AzureWebJobsStorage` and `AZURE_BLOB_CONNECTION_STRING`; **`stcompiqfnotgm` (centralus)** exists with zero containers and is orphaned/empty. Both keys rotated correctly per W1; `docs/security/SECRET_ROTATIONS.md` at `1dec669` is accurate. Future sessions must verify which account is in use before assuming. `stcompiqfnotgm` is likely safe to delete (deferred).

### 9. Function inventory mismatch (W6.3 reconciliation)

Brief listed 15 functions and described count as 14. Actual deployed count is **14**. Discrepancies:
- `fn-player-score-refresh`: in brief, NOT deployed.
- `fn-price-alert-checker`: in brief, NOT deployed.
- `fn-nightly-comp-prefetch`: deployed and active, NOT in brief, but referenced in `copilot-instructions.md`.

### 10. `compiq-functions/fn-*` source-on-branch anomaly

Production has 14 deployed functions but `main` carries only scaffolding + shared helpers (PR #76 `2d2ea21`, PR #77 `91e517d`). Per-function source dirs (`fn-cardhedge-comps`, `fn-ebay-signals`, etc.) live only on `origin/wip/snapshot-2026-05-20` (HEAD `5fad0a2`) and `origin/restore/preprod-deployed-state` (HEAD `1cb6f45`), each carrying 16 `fn-*` dirs (the deployed 14 plus the 2 not-deployed pair from Finding 9 above). Anyone editing function code from a `main` checkout starts from scaffolding, not from the deployed state. **Configuration / source-of-truth gap.** Surfaces a follow-up: which branch is canonical for Phase 3 cleanup PRs against the function app? Documented in detail in `docs/phase0/mcp_repo_discovery.md` "Adjacent finding" section (commit `24aab9e`).

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
| Deploy-script EAP-scope fix | PR | #101 | **Opened, NOT merged** — follow-up pending |
| Roadmap reframe (W5) | Commit | (in PR #102 batch) | Live in `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` |
| W6.2 Q3 latency baseline | Commit | `b3db482` | `docs/phase0/q3_latency_baseline.md` |
| W6.3 blob inventory of 14 fn-* | Commit | `672ffd8` | `docs/phase0/blob_inventory_2026-05-21.md` |
| W6.4 MCP repo discovery | Commit | `24aab9e` | `docs/phase0/mcp_repo_discovery.md` |
| Issue: `/estimate` telemetry deferral | Issue | #103 | Open |
| Issue: B2 cardIdSource cohort definition | Issue | #106 | Open, decision deferred to Day-10 |

**Phase 0 measurement state:** complete except W6.1 (deferred to day-2+ for 48 h of post-PR-A1 warn-log accumulation). Active soak continues independently. Day-10 review window `2026-05-31T17:44:32Z`.

**Production state at this commit:**

- `hobbyiq3` `/api/health`: `build.sha=e333ae1` (unchanged from earlier W7 commit point — no new deploys this session).
- Cosmos `comp_logs` writer flipped on at `2026-05-21T17:44:32Z` (`COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0`); writing continuously since.
- `CARDSIGHT_MODE=exclusive`.
- All storage keys rotated correctly per W1; `SECRET_ROTATIONS.md` at `1dec669` accurate.

## Deferred / open items entering day-2+

- PR #101 merge (deploy-script EAP-scope fix).
- W6.1 Q1 warn-log baseline measurement (needs 48 h of post-PR-A1 traffic).
- Finding 6 investigation: confirm whether `fn-nightly-comp-prefetch` actually writes anything.
- Finding 5 investigation: trace the `fn-cardhedge-comps` 27-comp-uniform pattern's consumer chain.
- Finding 10 reconciliation: choose canonical branch for `compiq-functions/fn-*` source-of-truth, then PR back onto `main`.
- Finding 4: add App Insights `hobbyiq-insights` component-naming note to `copilot-instructions.md` Part 9.
- Finding 2: roadmap edit to move Phase 4a p95-reduction baseline from "Phase 0 baseline (doesn't exist)" to "Day-10 post-PR-A1."
- Workstream 3 (this prompt): extend LESSONS section in `copilot-instructions.md` with Finding 11.
- Phase 4a / Phase 5 design open question: how to address the DailyIQ niche-prospect-auto coverage gap. Three candidate approaches captured in Finding 12; decision deferred to Phase 4a kickoff or earlier strategic session.
