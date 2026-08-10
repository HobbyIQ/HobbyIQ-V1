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
