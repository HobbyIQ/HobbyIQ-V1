# fn-player-score-refresh

**Deployed status: NOT currently deployed in `fn-compiq` production.**

This function source is preserved on `main` per the Finding 10 source-restoration
resolution (post commit `8e63679`), but the function is **not currently registered
in the deployed `fn-compiq` Function App**. Restoration to `main` was additive and
does not change production.

## What it does

Nightly batch job (cron `0 0 4 * * *`, 04:00 UTC) that refreshes PlayerIQ
scores for every tracked player by POSTing to the TS backend's internal
refresh endpoint. The backend handles all Cosmos writes; the function batches
the request to avoid timing out a single big call.

## Dependencies before deploy

- Backend route `POST {COMPIQ_BACKEND_URL}/api/playeriq/refresh`
  with header `x-admin-key: {BACKEND_ADMIN_KEY}` and body
  `{"players": ["Mike Trout", "Shohei Ohtani", ...]}`
- Env vars on `fn-compiq`:
  - `COMPIQ_BACKEND_URL`
  - `BACKEND_ADMIN_KEY` (must match the backend's `x-admin-key` requirement)

**Existence of the backend route was not verified during the restoration PR.**
Confirm route is implemented and reachable before any deploy.

## To deploy

Out of scope for the source-restoration PR (Finding 10 resolution). Requires
a separate change that registers this function with the deployed `fn-compiq`
Function App. Verify dependencies above first.
