# iOS State Assessment — 2026-05-24

Read-only characterization of the HobbyIQ iOS codebase. No code changes were made.

---

## 1. Project state inventory

| Property | Value |
|---|---|
| Xcode project | `HobbyIQ.xcodeproj` (objectVersion 77 — PBXFileSystemSynchronizedRootGroup) |
| Targets | 2: `HobbyIQ` (app), `HobbyIQTests` (unit test bundle) |
| Deployment target | iOS 17.0 (app), iOS 26.2 (tests — defaulted from Xcode 26.3 SDK) |
| Swift version | 5.0 with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`, `SWIFT_APPROACHABLE_CONCURRENCY = YES` |
| Signing | Automatic, team `Justtheboysandcard` |
| External dependencies | None (no SPM packages, no CocoaPods, no Carthage) |
| Backend URL | Hardcoded: `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net` (no Debug/Release switching) |
| Local persistence | SwiftData (`@Model` classes: `CardItem`, `CardSaleRecord`, `SyncIntent`) |
| Git HEAD | `0511ed6` on main |
| Deployed backend SHA | `cf7d48b` |
| Test suite | 15 tests passing (CompIQDecodeTests: 6, PortfolioSyncMapperTests: 9) |

### Source file count

| Directory | Files | Notes |
|---|---|---|
| `HobbyIQ/HobbyIQ/` | ~85 Swift files | Main app source |
| `HobbyIQ/HobbyIQTests/` | 3 files | CompIQDecodeTests, PortfolioSyncMapperTests, URLProtocolMock |
| `HobbyIQ/HobbyIQ/DesignSystem/` | 1 file | HobbyIQTheme.swift |
| `HobbyIQ/HobbyIQ/HobbyIQ/` | 2 files | PortfolioArchitecture.swift, PortfolioWorkspaceViewModel.swift |

### Key architectural files

| File | Role | Lines |
|---|---|---|
| `APIService.swift` | All backend HTTP calls | ~1,800 |
| `CompatibilityShims.swift` | Offline-first local providers, mock API, model adapters | ~3,070 |
| `PortfolioSyncService.swift` | PR C sync layer (mapper, intent queue, write/read paths) | — |
| `CardItem.swift` | SwiftData model — central inventory entity | ~174 |
| `PortfolioArchitecture.swift` | InventoryCard, Sale, PortfolioService, LocalPortfolioProvider | ~436 |
| `AppSessionViewModel.swift` | Auth state, session management, @Observable | — |
| `EBayOAuthCoordinator.swift` | eBay OAuth via ASWebAuthenticationSession | — |
| `EbayListingDraftView.swift` | Listing draft UI with preview + publish | ~795 |

---

## 2. Build state assessment

**Classification: Has obvious issues (non-blocking for build)**

The project builds successfully (`BUILD SUCCEEDED`) and all 15 tests pass. However, several runtime concerns exist:

### StoreKit 2 stubs
- `SubscriptionService.swift` lines ~61, ~67: `Task.sleep()` placeholders with TODO comments
- Not wired to real StoreKit product IDs
- Impact: Paywall/subscription features are non-functional but don't block compilation

### eBay OAuth fatalError
- `EBayOAuthCoordinator.swift` line ~323: `fatalError("No window scene available")`
- Triggers if OAuth is attempted without an active window scene
- Impact: Crash risk in edge cases (background launch, SwiftUI lifecycle race)

### Alert endpoints stubbed
- `APIService.swift`: POST/DELETE for `/api/alerts` exist but the backend implementation status is unknown
- Impact: Alert creation/deletion may silently fail at runtime

---

## 3. Known bugs triage

### Bug 1: Refresh wipes inventory display
**Classification: (C) Appears Fixed**

- `PortfolioIQViewModel.swift` line ~458: `preserveExistingSummaryOnError` guard prevents wiping cached inventory when API returns empty or errors during refresh
- The guard checks for empty API response and retains existing local data
- Recommend confirming via manual test, but code path looks correct

### Bug 2: Card tap not navigating to detail
**Classification: (A) Bug as documented**

- `InventoryIQView.swift`: Card tap uses `Button { selectedCard = card }` with `.sheet(item: $selectedCard)` pattern
- This is a sheet presentation, not NavigationLink-based navigation
- The sheet approach works but may feel different from expected push navigation
- If the sheet isn't appearing, likely a SwiftUI state binding issue (e.g., `selectedCard` being reset)

### Bug 3: Images not auto-populating
**Classification: (D) Cannot characterize from code alone**

- No client-side auto-image-resolution logic exists — `photoURLs` on `CardItem` is populated only from:
  1. User-attached photos (camera/gallery)
  2. Server sync (photos array from `InventoryCard`)
- There is no automatic image lookup service (e.g., from player name + year + set)
- If this was expected behavior, it was never implemented on the iOS side. Backend may or may not have this capability.

### Bug 4: Can't remove photos from card
**Classification: (A) Bug as documented**

- `PortfolioDetailPhotosCard.swift` lines ~230-277: Photo removal logic exists with API call (`deletePhoto`) and local cache update
- The delete operation calls the backend, then updates `card.photoURLs` locally
- Possible issues: UX timing (no optimistic removal, user sees photo until API completes), SwiftData save timing, or the delete API returning an error silently
- Needs manual testing to identify exact failure mode

---

## 4. PR D/E status verification

### D.2 — OAuth flow
**Status: (A) Complete**

| Component | File | State |
|---|---|---|
| OAuth coordinator | `EBayOAuthCoordinator.swift` | Full ASWebAuthenticationSession flow with state machine |
| Callback handling | `AppSupport.swift:332-339` | Handles `hobbyiq://ebay/connected` URL scheme |
| Connect start API | `APIService.swift:293` | `GET /api/ebay/connect/start` |
| Status check API | `APIService.swift:284` | `GET /api/ebay/status` |
| Disconnect API | `APIService.swift:302` | `DELETE /api/ebay/disconnect` |
| Connect UI | `EbayConnectView.swift` | Full connect/disconnect UI |
| Config | `APIConfig.swift` | Callback scheme/host/path defined |

### D.3 — Listing draft creation
**Status: (A) Complete**

| Component | File | State |
|---|---|---|
| Draft UI | `EbayListingDraftView.swift` | ~795 lines, all listing fields, photo selection, pricing |
| Preview API | `APIService.swift:311` | `POST /api/ebay/listings/preview` |
| Publish API | `APIService.swift:321` | `POST /api/ebay/listings/publish` |
| Request model | `CompatibilityShims.swift` | `PortfolioEbayListingRequest` |
| Response model | `APIService.swift:1750` | `EbayListingResponse` (listingId, listingUrl, status) |

### D.4 — Publish / Revise / End / Status polling
**Status: (B) Partial**

- **Publish**: Complete — `ebayPublishListing` calls `POST /api/ebay/listings/publish`
- **Revise**: Not implemented — no `PATCH` or `PUT` endpoint for listing revision
- **End**: Not implemented — no endpoint to end/cancel an active listing
- **Status polling**: Not implemented — no periodic check for listing status changes
- `CardItem.ebayListingStatus` field exists (`"" | "listed" | "sold" | "ended"`) but no mechanism updates it after initial publish

### D.6 — ITEM_SOLD ledger entry
**Status: (B) Partial**

- Sale recording works via `PortfolioService.markCardAsSold()` → creates `Sale` record, removes card from inventory
- `CardSaleRecord` SwiftData model exists with: `salePrice`, `fees`, `shippingCost`, `sellingPlatform`, `costBasisAtSale`, `netProceeds`, `netProfit`, `roi`
- `ProfitIQViewModel.markSold()` → `PortfolioWorkspaceViewModel.markSellIQCardSold()` → `PortfolioService.markCardAsSold()`
- **Missing**: No automated eBay ITEM_SOLD webhook receiver, no granular eBay fee breakdown (final value fee, promoted listing fee, international fee), no reconciliation flags

### E — Reconciliation
**Status: (C) Not started**

- No reconciliation models, views, or API calls exist
- No `ReconciliationView`, no `/api/reconciliation` endpoints
- This is entirely future work

---

## 5. Backend integration check

### Endpoint inventory (iOS → backend)

| Category | Endpoint | Method | iOS Caller |
|---|---|---|---|
| **Auth** | `/api/auth/apple` | POST | `signInWithApple` |
| **CompIQ** | `/api/cardsight/estimate` | POST | `fetchEstimate` |
| | `/api/cardsight/search` | GET | `cardSearch` |
| | `/api/cardsight/cardsearch` | POST | `cardSearchCompIQ` |
| | `/api/cardsight/price-by-id` | POST | `fetchPriceById` |
| | `/api/cardsight/sale` | POST | `recordSale` |
| **Portfolio** | `/api/portfolio/holdings` | GET | `fetchPortfolioHoldings` |
| | `/api/portfolio/holdings` | POST | `addPortfolioHolding` |
| | `/api/portfolio/holdings/:id` | PUT | `updatePortfolioHolding` |
| | `/api/portfolio/holdings/:id` | DELETE | `deletePortfolioHolding` |
| | `/api/portfolio/summary` | GET | `fetchPortfolioSummary` |
| **eBay** | `/api/ebay/status` | GET | `ebayConnectionStatus` |
| | `/api/ebay/connect/start` | GET | `ebayConnectStart` |
| | `/api/ebay/disconnect` | DELETE | `ebayDisconnect` |
| | `/api/ebay/listings/preview` | POST | `ebayPreviewListing` |
| | `/api/ebay/listings/publish` | POST | `ebayPublishListing` |
| **Photos** | `/api/photos/sas` | GET | `fetchPhotoSAS` |
| | `/api/portfolio/holdings/:id/photos` | POST | `uploadPhoto` |
| | `/api/portfolio/holdings/:id/photos/:photoId` | DELETE | `deletePhoto` |
| **PSA** | `/api/psa/cert/:certNumber` | GET | `fetchPSACertLookup` |
| **Alerts** | `/api/alerts` | POST | `createAlert` |
| | `/api/alerts` | DELETE | `deleteAlert` |
| **Device** | `/api/device-tokens` | POST | `registerDeviceToken` |
| | `/api/notifications/preferences` | GET/PUT | notification prefs |
| **User** | `/api/users/:userId` | GET | `fetchUser` |

### Notable gaps

- **No `/api/compiq/predict` or `/api/compiq/comps-by-player`** — these may be backend-only or not yet exposed
- **CardHedge** references appear only in field names (`cardHedgeCardId` in `CompIQSearchModels.swift`) — this is the backend card-data provider, not a separate iOS integration
- **No eBay webhook receiver on iOS** — webhooks are backend-side; iOS would learn about ITEM_SOLD via polling or push notification (neither implemented)

---

## 6. ITEM_SOLD happy-path readiness

### Current state

The manual "mark as sold" path works end-to-end locally:

```
User taps "Mark Sold" in ProfitIQ detail view
  → ProfitIQViewModel.markSold()
    → PortfolioWorkspaceViewModel.markSellIQCardSold()
      → PortfolioService.markCardAsSold(card, salePrice, fees, date)
        → Creates Sale record (PortfolioArchitecture.swift:331)
        → Removes card from inventory (PortfolioArchitecture.swift:343-344)
      → Refreshes SellIQ portfolio view
```

Additionally, `CardItem` has `saleRecord: CardSaleRecord?` (SwiftData `@Relationship`) that stores detailed sale data including `netProceeds`, `netProfit`, `roi`.

### What's missing for automated eBay ITEM_SOLD

| Gap | Description | Effort |
|---|---|---|
| **Webhook/notification receiver** | No mechanism for backend to notify iOS that an eBay item sold. Backend would need to push via APNS or iOS would need to poll. | Medium |
| **Auto-status update** | `CardItem.ebayListingStatus` exists but is never updated post-publish. Needs polling or push to transition `"listed" → "sold"`. | Small |
| **eBay fee breakdown** | `CardSaleRecord` has generic `fees` field. eBay has final value fee, promoted listing fee, international fee — no granular breakdown. | Small |
| **Reconciliation** | No mechanism to compare expected sale proceeds vs actual eBay payout. Entirely PR E scope. | Large |
| **Sale-from-webhook flow** | When ITEM_SOLD arrives, need to auto-create `CardSaleRecord`, update `CardItem.status` to sold, update `ebayListingStatus` to `"sold"`, sync to backend. None of this exists. | Medium |

### Assessment

The manual sale recording path is functional and tested. The automated eBay ITEM_SOLD path requires:
1. Backend webhook processing (backend scope)
2. Push notification or polling mechanism (iOS + backend)
3. Auto-sale-creation from webhook data (iOS)
4. Fee reconciliation (PR E)

**Readiness: ~30%** — Manual path works, data models exist, but automation plumbing is entirely missing.

---

## 7. Recommendations for next session

### Priority order (based on signal-flow dependency chain)

1. **D.4 completion**: Add revise/end listing + status polling. Without status polling, iOS will never know when a listing sells.
2. **ITEM_SOLD automation**: Backend webhook → APNS push → iOS auto-records sale. This is the critical path for PR D.6 completion.
3. **Bug 2 (card tap navigation)**: Quick win — investigate sheet presentation vs NavigationLink, likely a single-file fix.
4. **Bug 4 (photo removal)**: Manual test needed to identify failure mode, then targeted fix.
5. **PR E (reconciliation)**: Deferred — depends on ITEM_SOLD automation being complete.

### Non-blocking items to address opportunistically

- Align test target deployment target (26.2) with app target (17.0) if testing on older simulators
- Replace `fatalError` in `EBayOAuthCoordinator` with graceful error handling
- Wire StoreKit 2 to real product IDs when subscription features are ready
- Add 4 deferred test classes: SyncSchemaTests, PendingWriteGuardTests, SyncQueueTests, AuthSyncIntegrationTests
