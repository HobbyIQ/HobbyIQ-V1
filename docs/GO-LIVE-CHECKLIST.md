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

## Alerts

### Verify Azure Monitor alerts + destination before launch

- **What:** 6 metric alerts live in `rg-hobbyiq-dev` today (all
  enabled), routing to the `hobbyiq-ops-alerts` action group. Before
  we open the doors publicly, we need to (a) confirm the destination
  is right, (b) sanity-check the thresholds, (c) test-fire that mail
  actually lands.
- **Why parked (2026-08-10):** Alerts are set up and enabled; the
  work is verification + address change, not new build.
- **Trigger:** Any of:
  - Marketing pushes the app / web publicly
  - >1 active seller or >5 active buyers using the platform
  - Right before opening `hobby-iq.com` to non-invite traffic
- **Where — action group:** currently `hobbyiq-ops-alerts` →
  `drew@justtheboysandcards.com`. Consolidation with the digest
  address means this should flip to `drew@hobby-iq.com` (see
  [[reference_ops_alert_email]] memory — currently outdated).

  ```bash
  az monitor action-group update \
    --name hobbyiq-ops-alerts --resource-group rg-hobbyiq-dev \
    --add-action email primary drew@hobby-iq.com
  # then remove the old address once the new one is confirmed
  ```

- **Where — alerts to review:**

  | Alert | Severity | Threshold today |
  | --- | --- | --- |
  | `appservice-http5xx` | 1 | Any non-zero in 24h |
  | `appservice-health-degraded` | 1 | Health <100% for 5 min |
  | `appservice-response-time-elevated` | 2 | Avg > 2s over 15 min (baseline 270ms) |
  | `appinsights-exception-surge` | 2 | Exceptions > 10 in 15 min (baseline 0-3/hr) |
  | `appinsights-failure-count` | 2 | Failed requests > 5 in 15 min (baseline 0-1/hr) |
  | `cosmos-throttle-429` | 2 | Any 429 |

  Note: `cosmos-throttle-429` will spuriously fire during any RU
  bump / backfill sprint (like today's 8K→40K bump on sold_comps).
  Consider muting during known-sprint windows, or raising threshold
  to `>N per hour` so a single 429 during a normal-load period still
  pages but expected backfill noise doesn't.

- **Where — coverage gaps to add before launch:**

  1. **Deploy failure** — "Daily 5AM ET Refresh & Deploy" workflow
     failure → alert. Today a failed deploy is silent.
  2. **CH ingest freshness canary** — already exists via
     `checkSoldCompsFreshness.cjs` per [[reference_freshness_canary]];
     verify it's on the cron and its output routes to
     `drew@hobby-iq.com`.
  3. **Deal-scanner job failure** — `buyerIqDealScanner.job` runs
     in-process on App Service; a crash today is silent.
  4. **Storefront visibility drops to 0** — sanity canary for the
     marketplace_listings pool.

- **Test-fire before launch:** send a synthetic 5xx (curl a known
  404-that-returns-500 route) to verify the flow actually delivers to
  the right inbox. Alerts sit dormant until an incident; don't want
  to discover a mis-configured MX record during a real outage.

---

## Azure Storage CORS

### card-images container = blob-level public read

- **What:** 2026-08-10, enabled `allowBlobPublicAccess=true` at the
  storage account level AND set `card-images` container to
  `publicAccess=blob`. Before this, browser `<img>` and iOS
  `AsyncImage` requests to blob URLs returned 401 (uploads worked but
  photos rendered as broken-image icons).
- **Why blob-level, not container-level:** Blob-level allows anonymous
  GET on individual blobs (needed for `<img>` tags) but blocks
  container listing. Container-level would additionally allow anyone
  to enumerate all blobs — unnecessary and slightly worse posture.
- **Why public at all:** URLs contain a UUID + timestamp
  (unguessable), user photos are already the product surface
  (displayed publicly on `/u/<username>` storefronts), and iOS
  AsyncImage / web `<img>` can't send auth headers without a proxy
  layer.
- **Trigger to revisit:** If users start uploading sensitive content
  we don't want indexed (e.g., cert scans with visible PII), promote
  to a signed-read proxy on the backend and switch container back to
  private.
- **Verify:**

  ```bash
  az storage container show --account-name stghobbyiqdev --name card-images --query "properties.publicAccess"
  ```

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
