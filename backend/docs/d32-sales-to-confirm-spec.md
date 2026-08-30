# D32 — "Sales to confirm": the parked eBay sales get a screen

Ruled by Drew 2026-08-30 13:10Z ("Yes — a 'Sales to confirm' list in the
app, next builder after credits"). Order: after the search+comps repair, D29
and the D30 fleet unless Drew moves it.

## Why

D26's 90-day replay (2026-08-30, 8 users, 55 orders): 19 sold lines resolved
to a catalog card automatically (≥ 0.9), **17 parked** (best candidate below
the bar), **19 unresolvable** (no checklist row). Parked and unresolvable
sales sit in `doc.ebayAccountSales[]` (capped `EBAY_ACCOUNT_SALES_MAX=1000`)
with no screen. The hourly poll (now the GH cron `ebay-order-poll-hourly.yml`
→ `run-ebay-order-poll`) keeps adding to them.

## Deliverables

1. **API** (`backend/src/routes/…`, session-scoped, the owner only):
   - `GET /api/portfolio/ebay-account-sales?status=parked|unresolvable|recorded`
     — each entry: order id, line item, sold price, sold date, title, the
     best catalog candidate (slug, display name, confidence, why) for parked,
     the parse for unresolvable (year/product/number/player/parallel/grade),
     and whether the seller holds that card.
   - `POST /api/portfolio/ebay-account-sales/:id/confirm` `{ slug }` — links
     the sale: writes the `ebay-account` pool row under the confirmed identity
     (idempotent on orderId+lineItemId), marks the holding sold when the seller
     holds it (the D26 rule), records `confirmedBy: "user"`. Only a
     checklist-authority row is accepted (`catalogAuthorityOf`); a sale never
     mints a row.
   - `POST …/:id/reject` — parks it as unresolvable with a reason; it joins the
     acquisition list (product + number + player) like an unmatched vendor sale.
   - Picker: the same catalog search the Edit-card modal uses (after the
     search-ranking fix lands), seeded with the sale's parse.
2. **Web** (`apps/web`): a "Sales to confirm" page under Portfolio (and a
   count badge in the nav when > 0): parked first (candidate shown with the
   D20 provenance chip and "N sales · last date" for the candidate row),
   Confirm / Pick another / Reject; then "Unresolvable — cards we don't have
   yet" as a read-only acquisition list; then "Recorded" for the last 90 days
   with the card link. Empty state says the poll runs hourly.
3. **iOS**: not in this slice; the API is shaped so the app can add it.
4. **Tests**: the confirm path pins (checklist-only target; idempotent write;
   holding marked only when held; reject → acquisition list); web vitest for
   the list's states.
5. **Observability**: `ebay_account_sale_confirmed` / `_rejected` events;
   the poll summary gains `parkedOpen` per user.

## Guardrails

Session-scoped routes only (never the two unauthenticated compiq routes'
shape); no medians; no minting; gate merges on exit codes; deploy after the
backend/src merge and check `/api/health`.
