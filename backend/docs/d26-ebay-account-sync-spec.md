# D26 — the eBay account sync resolves every sale to a card

Ruled by Drew 2026-08-30 04:05Z ("Resolve to a card + record the sale");
order: after D28, before D21. Drew's words: "when we sync sold ebay data
directly from the account for reconciliation and for processing, not sure it
is working at all … and it needs to link to cards even if we didn't list from
the app."

## What runs today (measured 2026-08-30 03:15Z)

- `src/jobs/ebayOrderPoll.job.ts` — an in-process hourly scheduler on HobbyIQ3
  (`EBAY_ORDER_POLL_INTERVAL_HOURS`, lock-guarded across workers). It runs:
  the last cycle logged
  `done users=8 orders=29 matched=0 deduped=0 noMatch=29 markFail=0 fetchFail=2 refreshExpired=0 cursorsAdvanced=0`.
- `src/services/ebay/ebayOrderPoll.service.ts` `pollEbayOrdersForUser`:
  `GET /sell/fulfillment/v1/order?filter=lastmodifieddate:[cursor..]`, then per
  line item `listingId = legacyItemId ?? listingId` →
  `findHoldingByEbayListingIdAcrossUsers(listingId)` → `markHoldingSoldFromEbay`.
  **A line item matches only a holding that carries OUR listing id** — a card
  listed outside the app never matches. No-match emits
  `ebay_poll_no_matching_holding` and the order is dropped.
- App Insights (traces, 3d): `ebay_poll_no_matching_holding` **5,821**,
  `ebay_poll_summary` 1,252; by user: `user-199fcbc9` 2,503 (13 distinct
  listings), `user-7b6cbc92` 1,863 (9), `user-cfacd098` 828 (4),
  `user-f31442a6` 627 (3). The same listings recur every hour.
- The cursor (`lastPolledAt`) advances only from `maxLastModifiedProcessed`,
  which only matched orders feed → with 0 matched the cursor never moves and
  the same 29 orders are re-fetched every cycle (`cursorsAdvanced=0`).
- `fetchFail=2`: two users' token refresh/fetch fails every cycle
  (`refreshExpired=0`, so not the refresh path — read the per-user error).

## Deliverables

1. **Resolve each sold line to a catalog card.** Input: the order line's
   title (+ item specifics via `GET /sell/inventory` or the item's aspects
   when available: year, set, card number, player, parallel, grade). Run it
   through the same identity path the import uses (`identityFromFields` →
   the catalog matcher; D12-b), with D28's card-number guard. ≥ 0.9 →
   auto-link; below → the line parks with its best candidate for the user's
   confirm (the D12-a parked-match shape on a "sold sale" record, not on a
   holding).
2. **Record the sale in the pool.** A user's own sale is an observed
   transaction: write it to `sold_comps` under the resolved identity with
   `source: "ebay-account"`, `userId`, `ebayOrderId`, `ebayListingId`, the
   sold price net of nothing (gross sale price; fees on the holding's P&L, not
   the comp), the sold date, and `title`. Idempotent on `(ebayOrderId,
   lineItemId)`. The pool's prewrite dedup treats it like any tca-ebay row
   (the same sale may also arrive from TCA — dedup by listing id + date).
3. **Mark the holding sold when the seller holds that card.** After the
   identity resolves: find the seller's active holding on that identity
   (prefer one carrying the listing id; else the exact identity + grade;
   else the identity un-graded) → `markHoldingSoldFromEbay` (existing,
   idempotent on holdingId+orderId). When the user holds no such card, the
   sale still records (deliverable 2) and appears in their sales history.
4. **The cursor advances on every processed order.** No-match / parked /
   recorded-without-holding are *processed*, not failures; only a fetch or
   write failure pins the cursor. Back-walk overlap stays.
5. **Expired tokens surface.** `fetchFail` per user becomes a stored
   `ebayConnection.status = "reconnect-required"` + reason, shown on the
   account page ("Reconnect eBay") and in the poll summary by user; the poll
   skips a reconnect-required user rather than failing them every hour.
6. **Reconciliation + observability.** Summary line per cycle:
   `users, orders, lines, resolved(auto/parked), recorded, holdingsMarked,
   cursorsAdvanced, reconnectRequired, failed`; `reportWrites` on the pool
   write; the freshness canary gains an `ebay-account` source floor once the
   flow is live.
7. **Backfill.** The 29 re-fetched orders (and the last 90 days per connected
   user) run once through the new path; Drew's 13 listings should resolve
   and appear in his sales history and, where he held the card, as sold.

## Guardrails

- Never mint a catalog row from a sale (Drew's rule); an unresolvable sale
  parks — it joins the acquisition list, it does not create a card.
- FMV stays the projected next sale of the exact-identity pool; a user sale
  is one more observed transaction, weighted like any other (no seller
  premium).
- Never run write paths locally; the backfill runs through the runner;
  REPORT ONLY first; gate merges on exit codes; deploy after every
  backend/src merge and check `/api/health`.
- Do not touch secrets: the eBay app credentials and user tokens stay in
  KeyVault/App Service settings; nothing to stdout.
