# `cardsightCardId` → `cardId` Field Rename — iOS Coordination

**Status:** ✅ CLOSED. Backend renamed (PR #216); iOS shipped in `d9e21bf` (refactor(ios): rename `cardsightCardId` → `cardId`).

CF-CARDID-RENAME (2026-06-30). Long-overdue rename of a field whose name no longer matches the data source. Cardsight was retired in CF-CARDHEDGE-HARD-CUTOVER (2026-05-30); the field has been a CardHedge catalog id ever since. The new name `cardId` is source-neutral and future-proof (e.g., eBay-direct migration won't require another rename).

## Backend behavior right now (post-PR #216)

- **All internal code** uses `cardId`.
- **All API responses** emit `cardId` only (the `cardsightCardId` key is GONE from response shapes).
- **Cosmos read normalization**: existing user docs with the legacy `cardsightCardId` field are normalized at read time. Old data still works.
- **Cosmos write**: new writes only emit `cardId`; the legacy field is dropped at next save.
- **Request back-compat (one-way)**: `/api/compiq/price-by-id` still accepts EITHER `cardId` OR `cardsightCardId` in the request body, preferring `cardId` when both present. **Other routes hard-cut to `cardId` only** — iOS callers of those routes break instantly if not updated.

## Affected request bodies / response shapes

| Endpoint | Request key | Response key |
|---|---|---|
| `POST /api/compiq/price-by-id` | `cardId` (legacy `cardsightCardId` also accepted) | `cardId` |
| `POST /api/compiq/scan` | n/a (no card id in request) | `cardsightCardId` STILL on response — see below |
| `POST /api/compiq/search` | n/a | `cardId` (on each candidate) |
| `POST /api/portfolio/holdings` (add) | `cardId` | n/a |
| `PATCH /api/portfolio/holdings/:id` (update) | `cardId` | n/a |
| `GET /api/portfolio/holdings/:id` | n/a | `cardId` |
| `GET /api/portfolio/holdings` (list) | n/a | `cardId` on each |
| Estimate / response embedding | n/a | `cardId` |

### Scan-route exception

`POST /api/compiq/scan` ships in PR #215 emitting `cardsightCardId` on its response shape (it was the first feature using the new name in spec). After this rename PR, the scan-route response shape is `cardId` — same value, new key. iOS scan flow needs the field-name update at the same time it ships the UI.

## iOS migration steps

1. **Update Codable structs** for every response shape that carried `cardsightCardId` — rename the property to `cardId`. For Swift's CodingKeys: just rename the case, the JSON key matches now.
2. **Update request bodies**: send `cardId` instead of `cardsightCardId`. (Most surfaces hard-cut; only `/price-by-id` keeps back-compat.)
3. **Storage keys (CoreData/UserDefaults)**: if iOS persists the field, migrate stored values. Most iOS clients reconstitute from API responses so this is usually not needed.
4. **Analytics events**: anywhere the field name was logged, update the property name.

## Test plan (post-iOS update)

- Open existing portfolio → all holdings still load (Cosmos read-normalization handles legacy stored field)
- Add a new holding → confirm `cardId` ships in the request and gets persisted under the new name
- Run `/price-by-id` with the new field name → confirm price returns
- Test back-compat: send `cardsightCardId` to `/price-by-id` from a hardcoded test → confirm it still works (back-compat will be removed in a future CF; this is the transition safety net)

## When the back-compat alias gets dropped

`/api/compiq/price-by-id` accepts both names today. Once iOS minimum supported version sends only `cardId`, file a follow-up CF to remove the legacy alias. Recommended: wait 2 App Store releases after the iOS update lands so users on older versions don't break.

## Rollback safety

The change is read-tolerant: a deploy roll-back doesn't lose data because Cosmos still has the legacy field on existing docs. New writes during the rollout interval emit `cardId`; if rolled back, the old code can't read those — but newly-written docs are rare during a short rollback window, and the old code's read paths would just return null for those holdings (effectively unbreaking after a re-deploy forward).

## Related

- [[cardidentity-snake-case-convention]] — engine's `cardIdentity` returns `card_id` (snake_case). That's a separate type and not affected by this rename. The dispatcher's `CardIdentity` TYPE still uses camelCase fields like `candidateId`.
- [[engine-owns-signals-not-ch-product]] — the rename to source-neutral `cardId` aligns with the eBay-direct migration direction.
