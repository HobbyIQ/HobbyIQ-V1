# fn-price-alert-checker

**Deployed status: NOT currently deployed in `fn-compiq` production.**

This function source is preserved on `main` per the Finding 10 source-restoration
resolution (post commit `8e63679`), but the function is **not currently registered
in the deployed `fn-compiq` Function App**. Restoration to `main` was additive and
does not change production.

## What it does

Timer-triggered function (cron `0 0 */6 * * *`, every 6 hours) that scans every
active price alert, asks the MCP server for the current predicted price for each
card, and triggers a push notification + DB update via the TS backend whenever
an alert's threshold is met.

Pipeline:
1. `GET /api/alerts/internal/all` on the TS backend (auth: `x-admin-key`)
   → list of active alerts.
2. For each alert, `GET <MCP>/predict/{cardId}` (auth: `x-functions-key`)
   → current predicted price.
3. If threshold met (`direction=above && current >= target`, or `direction=below
   && current <= target`), `POST /api/alerts/internal/trigger` on the TS backend
   to fire APNs push and mark triggered.

## Dependencies before deploy

- Backend routes (auth: `x-admin-key`):
  - `GET /api/alerts/internal/all`
  - `POST /api/alerts/internal/trigger`
- MCP route: `GET /predict/{cardId}` (auth: `x-functions-key`, optional if open)
- Env vars on `fn-compiq`:
  - `HOBBYIQ_BACKEND_URL`
  - `ALERTS_ADMIN_KEY` (must match `COMPIQ_ADMIN_KEY` / `ALERTS_ADMIN_KEY` on TS)
  - `COMPIQ_MCP_URL`
  - `COMPIQ_MCP_KEY` (function key for MCP `/predict`, optional if open)

**Existence of the backend and MCP routes was not verified during the restoration
PR.** Confirm all routes are implemented and reachable before any deploy.

## To deploy

Out of scope for the source-restoration PR (Finding 10 resolution). Requires
a separate change that registers this function with the deployed `fn-compiq`
Function App. Verify dependencies above first.
