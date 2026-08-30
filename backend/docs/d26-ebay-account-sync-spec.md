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

---

## BUILT on `feat/d26` (2026-08-30). APPLY is Drew's dispatch.

### What the re-measure found (07:46Z, five cycles after the spec's 03:15Z)

The numbers had not moved at all: `users=8 orders=29 matched=0 deduped=0
noMatch=29 markFail=0 fetchFail=2 refreshExpired=0 cursorsAdvanced=0`.

- **The cursor has never advanced for anyone, ever.** Not "not lately" —
  `lastPolledAt` is **NULL on all 8 `ebay_connections` docs**, read directly.
  `cursorAdvanced: true` appears **0 times** in three days of traces. The poll
  shipped 2026-06-01. Every user's window still starts at their `connectedAt`.
- Per user, over 3 days: `user-199fcbc9` 2,531 no-match events / 13 listings ·
  `user-7b6cbc92` 1,863 / 9 · `user-cfacd098` 828 / 4 · `user-f31442a6` 627 / 3.
  Six users emit a summary; 4 + 9 + 3 + 13 = 29 orders, and two users never
  reach the summary at all.
- **`fetchFail=2` had zero explaining log lines.** `ebay_poll_fetch_failed`
  has **0 occurrences** in the window, because the failure returned from the
  TOKEN step — above the only line that logged. The two users are
  `admin-testing-hobbyiq` and `user-8aa46493`: both have a refresh token that
  is live *by date* (expiring 2027-11 and 2028-02) and an **expired access
  token**, so `getAccessToken` takes the refresh branch and eBay rejects the
  grant. Their connection docs' `updatedAt` last moved 2026-07-12 and
  2026-08-22; the six healthy users' `updatedAt` moves every cycle.
- The in-process scheduler is duplicating: in 24h, **64 `done` lines across 2
  role instances** and 100 `cycle skipped` — roughly 2.7 completed cycles an
  hour where the interval says one. The Redis single-flight lock is working
  but leaky (an App Service restart re-arms the first-run timer).

### The seven deliverables

1. **Resolve.** `services/ebay/ebayAccountSaleIdentity.service.ts` —
   `parseListingTitle` → `applyBrowseEnrichment` (the same aspect reader the
   purchase side uses) → `normalizeHoldingFields` → `resolveIdentityFromFields`.
   D28's `judgeCardNumber` and D23's `sameCardNumber` come along inside that
   path; there is no second copy of either. ≥ `ADD_SLUG_OVERRIDE_MIN_CONFIDENCE`
   (0.9) auto-links, below parks. Sealed boxes, breaks, memorabilia and
   supplies never reach the matcher.
2. **Record.** New pool source `ebay-account`, idempotent on
   `(ebayOrderId, lineItemId)` via `sourceExternalId = "<orderId>::<lineItemId>"`.
   Gross price. Added to every consumer allowlist that reads user sales
   (canonicalFmv ×2, compiqEstimate ×2, priceSanityGate, anomalyDetection,
   cleanliness, confidenceScore 0.9, preIngestClean, compsStaging, the rematch
   route, flagComp) — a row written is a row read.
   **Exactly one pool row per sale.** When the holding carries a pinned hiq
   slug its ledger emit owns the row (`ebay-user-sale`); otherwise the poll
   writes `ebay-account`. Disjoint by construction, reported as
   `recordedViaHolding` / `recordedViaAccount`.
3. **Mark.** `findSellerHoldingForIdentity` — the listing id first (cross-user,
   unchanged), then the seller's own inventory by exact identity **+ grade**,
   then the identity un-graded. It walks `Object.values(doc.holdings)` and
   reports `holdingsWalked`. A PSA 9 is never marked sold by a PSA 10's sale.
4. **Cursor.** Advances on every PROCESSED order. No-match, parked and
   recorded-without-holding are processed. Only a write failure pins it. The
   old test that pinned the opposite rule is **inverted in place**, with the
   measurement on it, rather than deleted.
5. **Reconnect.** `connectionStatus: "reconnect-required"` + reason on the
   connection doc, surfaced by `GET /api/ebay/status` (`status`,
   `reconnectReason`) and skipped by the poll. `getAccessToken` no longer
   **deletes** the record on expiry — deleting it is exactly why
   `refreshExpired` read 0 forever and why a dead connection could never be
   shown a "Reconnect eBay" button. A transient 5xx is *not* terminal.
   New: `GET /api/ebay/account-sales[?status=parked]` — what the sync saw, and
   the confirm queue.
6. **Reconciliation.** The cycle line reports the whole funnel and
   `reportWrites` proves it: every line is `written | skipped | failed`, with
   the two pool paths as sub-totals on their own line
   (CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER), tolerance 0.
7. **Backfill.** `scripts/backfill-ebay-account-sales.cjs`, runner-whitelisted,
   REPORT ONLY by default, sharded by connected user with the distribution
   printed before any work, the exact budget marker, a marker-keyed relaunch
   step, and `reportWrites`. It calls the SAME `pollEbayOrdersForUser`, so
   there is no second ladder to drift. It leaves `lastPolledAt` alone.
   Measured shard distribution over the 8 connected users: SLOTS=1 → 8;
   SLOTS=2 → 6/2; SLOTS=4 → 3/1/3/1. **SLOTS=1 is the honest dispatch** at this
   size; the axis exists for when it is not.

### Guardrails held

- **A sale never mints a card.** The matcher is asked as `ebay-title`, which is
  in neither `TRUSTED_SOURCES` nor `USER_SEED_ALLOWED_SOURCES`; `ebay-account`
  is deliberately kept OUT of soldCompsStore's `USER_SEED_SOURCES`, the set
  that reaches `ensureCatalogRow`. Both asserted, and both assertions fail when
  the allowlist is edited.
- **FMV is unchanged.** An account sale is one more observed transaction at
  confidence 1.0 / trust 0.9, weighted like any other. No seller premium.
- **The user doc is bounded.** `EBAY_ACCOUNT_SALES_MAX` (1000) caps the sale
  array — it shares a 2 MB Cosmos doc with holdings, ledger, purchases and
  price history, and a Pro Seller's 90-day replay would otherwise eat 0.7 MB
  of it. The sales themselves live in `sold_comps` and the ledger.

### Two follow-ups, deliberately NOT in this PR

**The freshness canary's `ebay-account` floor.** `checkSoldCompsFreshness.cjs`
takes its sources from `MONITOR_SOURCES` / `MIN_ROWS_24H` in
`sold-comps-freshness-canary.yml`. Turning the floor on before a single
`ebay-account` row exists would make the canary red immediately and teach
everyone to ignore it. Add `ebay-account` to `MONITOR_SOURCES` (and a measured
`MIN_ROWS_24H`) **after** the APPLY backfill lands rows — the floor should come
from the observed daily count, not from a guess.

**The scheduler: move it to a GH Actions cron. Recommended, separately.**

Reasons to move:
- Every other data job in this repo is a cron (`ch-daily-sales-ingest`,
  `tca-firehose-ingest`, `sold-comps-daily-delta`, `nightly-slug-backfill`).
  This is the only ingest running on a `setInterval` inside the API process.
- It duplicates today. 64 completed cycles in 24 hours across two workers where
  the interval says 24. `runSingleFlight`'s Redis lock skipped 100 and still
  let 64 through, because an App Service restart re-arms the first-run timer
  under the lock's TTL. A cron has one runner and no lock to be leaky.
- `reportWrites` sets `process.exitCode` on a shortfall, which is the whole
  point of it — and inside the API process that exit code is meaningless, so
  the job has to *suppress* it (`ebayOrderPoll.job.ts` does, explicitly). On a
  runner the shortfall would simply turn the run red, which is the signal
  CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW exists to give.
- The credentials work on a runner: `backfill-ebay-account-sales` already
  fetches `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_ENV` /
  `AUTH_SESSION_SECRET` from App Service, masked. The cron would be that same
  step plus a `schedule:` trigger.

Why not here: the cutover's only real risk is the **App Service setting flip**
(`EBAY_ORDER_POLL_DISABLE_SCHEDULER=true`), which is a live prod config change
and HALTs for Drew's explicit go. Bundling it would block this PR — which is
about making the sync CORRECT — behind that confirm. Ship the correctness, then
move the trigger: a new workflow, a thin `run-ebay-order-poll.cjs` wrapper over
`runEbayOrderPollJob`, and the one setting.
