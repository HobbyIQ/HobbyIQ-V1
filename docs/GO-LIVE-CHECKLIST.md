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

### Autoscale rollback — measured 2026-09-07

Read the live state first; never scale from memory:

```bash
cd backend && node scripts/cosmos-throughput.cjs --report
```

| container | mode | max RU/s | Azure floor | 7-day avg | 5-min peak |
| --- | --- | --- | --- | --- | --- |
| `sold_comps` | autoscale | 40,000 | **10,000** | ~1,460 RU/s | 17,900 RU/s |
| `card_catalog` | autoscale | 400,000 | **40,000** | ~1,530 RU/s | 12,000 RU/s |
| `ch_daily_sales` | manual | 400 | 400 | ~29 RU/s | — |
| `portfolio` | autoscale | 1,000 | 1,000 | — | — |

Floors are `az cosmosdb sql container throughput show ... --query
resource.minimumThroughput`. **The floor is `highest-ever-provisioned / 10`, so
it only ever rises.** `sold_comps` has been at 100,000 at some point, so its
floor is 10,000 and 8,000 is unreachable forever — that is why every hardcoded
`8000` teardown below fails.

#### sold_comps: 40K max — do NOT roll back yet

- **Old trigger (dead):** the Aug-10 doc named the `bcalxbpjs` normalizer, CH
  fanout run `31414515858`, cross-source dedupe, and re-slug rev 2. All four
  finished in August. Item 17 / P2-2 of the go-live audit.
- **New trigger:** the **GREAT REMATCH program quiesces** — measured as
  `gh run list --workflow=backfill-runner.yml` dropping below ~10 runs/day for
  3 consecutive days. On 2026-09-07 it was **200+ runs/day**; throttling now
  would stall catalog work, which is the whole program.
- **Launch week vs steady state:** during launch week the fleets need the 40,000
  ceiling (peak observed 17,900 RU/s — a 10,000 ceiling would throttle).
  In steady state, consumption is ~1,460 RU/s, so the floor alone covers it.
- **Target when it fires:** 10,000, not 8,000. **The floor is the target.**

  ```bash
  cd backend && node scripts/cosmos-throughput.cjs --container=sold_comps --max=10000
  ```

  The script lands on Azure's reported floor if the target is under it, so
  passing a stale low number is safe but prints a correction — fix the caller.

#### card_catalog: 400K → 40K is the live cost item (P1-6)

Spine passes are **done**, so memory's "400k until spine passes finish, then
40k" condition is **already met**. Consumption evidence: 7-day average ~1,530
RU/s, biggest 5-minute peak **~12,000 RU/s** (the `catalog-cardYear-backfill`
`CONCURRENCY: 128` window). 12,000 is well under the 40,000 floor, so **no
fleet breaks at 40K** — the floor still buys 3.3x headroom over the worst
observed burst.

- **Cost delta:** billed idle floor drops 40,000 → 4,000 RU/s.
  **~$76.80/day → ~$7.68/day — saves ~$69/day (~$2,074/month).** This is the
  single largest silent cost line going into launch.
- **Command (DO NOT RUN — live Cosmos config is a HALT item, Drew's go only):**

  ```bash
  cd backend && node scripts/cosmos-throughput.cjs --container=card_catalog --max=40000
  ```

  Note the floor is already 40,000, so this is the lowest reachable setting;
  Azure will refuse anything below it and the script will land on 40,000 anyway.

#### Every raise must land back on the floor

Four workflows raise `sold_comps` to 40,000 and lower it in an `always()` step:
`nightly-slug-backfill`, `printrun-merge`, `reslug-setkey`, `slug-drift-audit`.
All four have a teardown — none is missing — but **three assert an unreachable
`SOLD_IDLE_MAX: "8000"`** and fail every run:

| workflow | idle target | reachable? |
| --- | --- | --- |
| `nightly-slug-backfill` | 10000 | yes |
| `printrun-merge` | 8000 | **no — under the 10,000 floor** |
| `reslug-setkey` | 8000 | **no** |
| `slug-drift-audit` | 8000 | **no** |

Since #1954 the script parses Azure's rejection and lands on the floor instead
of failing, so those three now succeed at 10,000 — but their env values are
still misleading and should be corrected to `10000` when each is next touched.

**Rule for new callers:** an idle target is a *floor request*, not a constant.
Set it to the current floor from `--report`, and never assume it stays put.

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
