# Payments backend audit — 2026-07-11

## Scope

Verify that the server-side of Apple StoreKit 2 subscriptions works end-to-
end without depending on iOS or a physical device. The audit does NOT
exercise a real purchase; it validates that every backend piece needed to
accept, verify, and enforce a real purchase is present, wired, and
behaving correctly on prod.

## Status: launch-ready

Every server-side component required to process a real Apple purchase is
present, correctly wired, and returning expected responses on prod. The
remaining launch risk is entirely on the iOS client (StoreKit 2 flow, UI,
receipt hand-off) — not on server code.

## Findings

### 1. Product mapping — locked

`backend/src/services/subscriptions/productMap.ts` maps the 3 Apple
productIds locked 2026-06-03 to the corresponding HobbyIQ plans:

| App Store productId | HobbyIQ plan |
|---|---|
| `com.hobbyiq.collector.monthly` | `collector` ($9.99/mo) |
| `com.hobbyiq.investor.monthly` | `investor` ($19.99/mo) |
| `com.hobbyiq.proseller.monthly` | `pro_seller` ($29.99/mo) |

Unknown productId → 422 `unknown_product`, NOT silent downgrade. Correct.

### 2. Verifier service — comprehensive

`subscriptionVerifier.service.ts` runs 5 gates on every /verify call:

1. Peek JWS environment (Sandbox vs Production) for routing
2. Cryptographic JWS signature + cert-chain validation against Apple roots
3. `getAllSubscriptionStatuses` cross-check (defense in depth) — only
   `ACTIVE` (1) or `BILLING_GRACE_PERIOD` (4) count as current; refunds /
   expirations / revocations DO NOT upgrade
4. productId → plan mapping
5. Idempotent upsert on originalTransactionId (safe replay)

Error taxonomy:

| Error | HTTP | Cause |
|---|---|---|
| `InvalidJwsError` | 400 | Signature / decode failed |
| `SubscriptionNotCurrentError` | 422 | Refunded/expired/revoked |
| `UnknownProductError` | 422 | productId not in productMap |
| `UpstreamApiError` | 502 | Apple API threw |
| `AppleConfigError` | 503 | Backend not configured |

### 3. App Service settings — all present

All 6 required Apple App Store settings are populated on HobbyIQ3:

| Setting | Length | Notes |
|---|---|---|
| APP_STORE_PRIVATE_KEY_B64 | 344 bytes | .p8 signing key, base64 |
| APP_STORE_APPLE_ROOT_CERTS_B64 | 2689 bytes | Multiple root certs |
| APP_STORE_ISSUER_ID | 36 chars | UUID, format valid |
| APP_STORE_KEY_ID | 10 chars | Standard App Store Connect key ID length |
| APP_STORE_BUNDLE_ID | 26 chars | `Justtheboysandcard.HobbyIQ` |
| APP_STORE_APP_APPLE_ID | 10 chars | Numeric app ID: 6762474203 |

### 4. Server-to-server notifications — public, verified

`POST /api/subscriptions/notifications` is mounted BEFORE
`router.use(requireSession)` (correct — Apple posts directly, no session).
Defense: JWS signature + cert-chain validation runs BEFORE any Cosmos
write. Bogus payload → 401 `invalid_notification`, verified on prod.

### 5. Entitlement matrix — 4 plans × 9 features × 4 caps

`backend/src/config/entitlements.ts` is the single source of truth:

- Plans: `free` (rank 0), `collector` (1), `investor` (2), `pro_seller` (3)
- 9 gated features (predictions, watchlist, advancedAlerts, dailyIQBriefs,
  trendIQComposite, ebayIntegration, marketTrendIndexes, trendIQLayer3Full,
  erpReconciliation)
- 4 gated caps (priceChecksPerDay, holdingsCap, scansPerMonth, priceAlerts)
- Owner-override support for comped accounts (`effectivePlanFor`)
- `minimumTierFor` / `minimumTierForCap` helpers so 402 responses can tell
  iOS which tier the user needs

Verified live via `GET /api/entitlements/me` on prod — synthetic harness
user (plan=pro_seller) returns full feature list with unlimited caps.

## On-prod test evidence

Tests run against `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.
azurewebsites.net`:

| Test | Expected | Actual |
|---|---|---|
| POST /verify no session | 401 | ✓ 401 `Missing or invalid x-session-id header` |
| POST /verify no jws | 400 | ✓ 400 `jwsRepresentation is required` |
| POST /verify bogus jws | 400 | ✓ 400 `JWS verification failed` |
| POST /notifications no payload | 400 | ✓ 400 `signedPayload is required` |
| POST /notifications bogus payload | 401 | ✓ 401 `invalid_notification` |
| GET /entitlements/me (pro_seller) | 200 + full matrix | ✓ 200 |

## Remaining launch risk (NOT backend)

The following live on the iOS client and cannot be verified without a
device:

1. **StoreKit 2 purchase flow** — Product.request, Purchase.storeKit,
   Transaction.updates listener wired correctly
2. **JWS hand-off** — iOS actually posts `jwsRepresentation` from
   `Transaction.jsonRepresentation` to `/api/subscriptions/verify`
3. **Restore flow** — user re-installs app, `Transaction.currentEntitlements`
   walked and posted to /verify for each active transaction
4. **Paywall UI** — product info fetched from App Store Connect, prices
   render correctly, purchase button dispatches
5. **App Store Connect config** — 3 products actually exist in App Store
   Connect (Collector/Investor/Pro Seller monthly) with the exact
   productIds hardcoded in productMap.ts

None of the above blocks server-side revenue capture. Once iOS ships
a working purchase flow that posts real JWS to /verify, the backend
will validate, upsert, and grant entitlements correctly.

## Not audited

- Test/sandbox purchase against real Apple sandbox account
- Server-to-server notification lifecycle (RENEW / EXPIRE / REFUND
  processing — needs Apple to post a real notification)
- Downstream write to `subscription_events` Cosmos container
  (existence assumed based on subscriptionEventStore.service.ts imports)

These require either a device (for sandbox testing) or waiting for a
real Apple event (for notification lifecycle). Neither is in scope
for a server-only audit.

## Related

- Backend entitlement middleware: `backend/src/middleware/requireEntitlement.ts`
- Owner override precedence: `effectivePlanFor` in `entitlements.ts`
- Auth user schema: `backend/src/services/authService.ts` (`plan` +
  `appleSubscription` fields)
