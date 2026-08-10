# HobbyIQ Go-Live Checklist

Living list of items to revisit before the marketplace / storefront
features are publicly promoted. Each item is parked deliberately —
not blocking today, but must be re-evaluated when we open the doors.

Add new items with:

- **Item name** — the change
- **Why parked** — the trade-off at time of parking
- **Trigger** — the condition that promotes it to blocking
- **Where** — file / config / workflow to touch

---

## Azure Storage CORS

### stghobbyiqdev blob CORS = `*` (wildcard)

- **What:** 2026-08-10, added a CORS rule to the `stghobbyiqdev` blob
  service allowing `*` origins on PUT/GET/HEAD/OPTIONS/DELETE. Before
  this, browser PUTs to `blob.core.windows.net` were CORS-blocked and
  every web photo upload failed with "Upload failed."
- **Why wildcard, not a whitelist:** SAS tokens are the actual write
  authorization — 15-min expiry, scoped per-blob, only issued after
  our backend session check on `/api/uploads/card-photo`. Blob reads
  are already public via permanent blob URL. CORS is only a
  browser-side mechanism; wildcard doesn't reduce the security model.
  Whitelist would force us to update the rule for every new subdomain
  (staging, mobile web, etc.) — wildcard scales cleanly.
- **Trigger to revisit:** If we ever move to session-based reads
  (require a signed URL to view an image), or add hotlink protection
  requirements, tighten to a whitelist of hobby-iq.com + subdomains.
- **Verify:**

  ```bash
  az storage cors list --account-name stghobbyiqdev --services b -o table
  ```

---

## Cosmos throughput

### sold_comps autoscale bumped 8K → 40K for backfill sprint

- **What:** 2026-08-10, bumped `sold_comps` autoscale max from 8K to
  40K RU/s to unblock concurrent CH-fanout + setName-normalizer +
  cross-source-dedupe running against the same container.
- **Why parked:** Autoscale means we pay only for burst; when the
  backfill scripts finish, actual consumption should drop back to
  the low-thousand-RU range naturally. No urgent cost pressure.
- **Trigger:** When all these are complete:
  - Normalizer (`bcalxbpjs`) finishes writing normalizedSetKey on
    ~3.87M rows
  - CH fanout GH Actions dispatch (run 31414515858) completes
  - Cross-source dedupe apply run completes
  - Re-slug rev 2 apply run completes
- **Where:**

  ```bash
  az cosmosdb sql container throughput update \
    --account-name hobbyiq-comps --database-name hobbyiq \
    --name sold_comps --resource-group rg-hobbyiq-dev \
    --max-throughput 8000
  ```

  Verify via App Insights sold_comps RU-consumed metric before
  dropping — if consumption hasn't come back down, wait longer.

---

## Marketplace

### Marketplace listings freshness cadence

- **What:** `marketplace-listings-refresh.yml` runs nightly at 07:30 UTC.
  Newly-toggled storefront cards take up to 24h to surface in
  `/api/marketplace/search`.
- **Why parked (2026-08-10):** Real-time write hook would need a new
  `findUserById` helper in `authService.ts` + hooks wired in
  `updateHolding` + `addHolding`. At current volume (1 active
  storefront seller) nightly is fine. Blast-radius of a bad write
  hook on every holding update outweighs the freshness benefit today.
- **Trigger:** First real buyer complaint about stale inventory, OR
  ≥5 active sellers actively toggling cards, OR marketing pushes
  cross-storefront search as a headline feature.
- **Where:**
  1. Fastest bump: `.github/workflows/marketplace-listings-refresh.yml`
     cron → `*/30 * * * *` (≤30 min freshness, no code deploy).
  2. Real-time: add `findUserById` to `backend/src/services/authService.ts`,
     re-enable marketplace sync block at `updateHolding` (marker
     comment already in place at ~L4808), mirror in `addHolding`.
