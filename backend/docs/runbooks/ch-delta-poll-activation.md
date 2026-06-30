# CardHedge Delta-Poll Activation Runbook

**Status:** Foundation shipped (PR #211). Dormant in prod until both env vars are set.

CF-CH-DELTA-POLL-FOUNDATION (2026-06-30). Replaces the 6h periodic portfolio refresh path's CardHedge call volume with incremental delta polling: only re-price cards whose underlying sales data actually changed.

## What's already in place

- **`subscribePriceUpdates(items)`** wrapper at `backend/src/services/compiq/cardhedge.client.ts`. Enrolls (card_id, grade) pairs in CH's price-tracking. Requires `CARD_HEDGE_CLIENT_ID` env var; returns null and skips when unset.
- **`getPriceUpdates(since, opts?)`** wrapper at same location. Polls for updates since the last seen `update_timestamp`.
- **`chDeltaPoll.job.ts`** background worker. Wired into `server.ts` startup. Reads checkpoint from `backend/.data/ch-delta-poll-checkpoint.json`, polls every `CH_DELTA_POLL_INTERVAL_MIN` minutes (default 15), advances checkpoint on success, emits structured `ch_delta_poll_cycle` telemetry per cycle.
- **17 + 13 pin tests** covering wrappers + worker behavior.

## What's needed to activate

### Step 1 — Register a CardHedge client_id

Contact CardHedge support to obtain a client_id for subscription enrollment. From the API docs:

> **Requires a CardHedge Client ID** (`client_id`). Contact Card Hedge if you don't have one.

This is a one-time provisioning step on CH's side. They'll provide a string identifier that authenticates HobbyIQ's subscription set against the delta-poll feed.

### Step 2 — Set env vars in HobbyIQ3 App Service

```bash
az webapp config appsettings set \
  --name HobbyIQ3 \
  --resource-group rg-hobbyiq-dev \
  --settings \
    CARD_HEDGE_CLIENT_ID="<value-from-CH>" \
    CH_DELTA_POLL_ENABLED="true"
```

Optional override:
- `CH_DELTA_POLL_INTERVAL_MIN` — defaults to `15`. Lower = more frequent polls = lower latency on sale → reprice. Higher = fewer CH calls.

App Service restarts on settings change → the worker re-evaluates the gate on next boot.

### Step 3 — Verify the worker started

Check App Insights or the App Service log stream for:

```
[ch-delta-poll] starting — interval 15min, first run in 60s
```

(Or `[ch-delta-poll] not started — ...` if a gate is still missing.)

### Step 4 — Verify polls firing

After ~60s + the interval, look for the structured event in App Insights traces:

```kql
traces
| where timestamp > ago(1h)
| where message contains "ch_delta_poll_cycle"
| extend p = parse_json(message)
| project timestamp,
    since = tostring(p.since),
    updatesReceived = toint(p.updatesReceived),
    newCheckpoint = tostring(p.newCheckpoint),
    advanced = tobool(p.checkpointAdvanced)
| order by timestamp desc
```

Healthy baseline: a row per 15min interval, `updatesReceived` between 0 and a few hundred depending on how much portfolio activity CH has subscribed.

### Step 5 — Subscribe portfolio cards (separate follow-up CF)

This PR ships the foundation only. Cards must still be enrolled via `subscribePriceUpdates` for their updates to flow into the poll feed. The follow-up CF wires:

1. On `POST /api/portfolio/holdings` add → fire `subscribePriceUpdates([{cardId, grade, externalId: holdingId}])`
2. On startup migration → batch-subscribe every existing holding's (cardId, grade) pair
3. On update arrival → reverse-map via `external_id` → `holdingId` → trigger reprice for that holding only

Until that CF lands, the delta poll runs but yields zero updates (nothing is subscribed yet) — the cycles are wasted but harmless. Disable via `CH_DELTA_POLL_ENABLED=false` if needed.

## Cost / capacity model

With ~N portfolios totaling M holdings:
- **Today (6h periodic):** ~M × 2 CH calls per refresh window. For 1000 cards across all users: ~2000 calls / 6h = ~8000 calls/day.
- **Delta poll (after Step 5):** 1 poll call / 15min = ~100 polls/day, regardless of M. Plus subscription calls on holdings add (one-time per holding).
- **Net:** ~80× call reduction at the polling layer. Reprice triggers still hit CH for sales lookups but only for the small subset of cards with new activity that cycle.

## Rollback

```bash
az webapp config appsettings set --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --settings CH_DELTA_POLL_ENABLED=false
```

The worker stops polling on next boot. The periodic 6h reprice in `portfolioReprice.job.ts` is independent and keeps running. Checkpoint file remains on disk for clean resume when re-enabled.

## Related

- [[engine-owns-signals-not-ch-product]] — engine consumes CH sales data, not CH product fields. Delta poll respects this: updates are SALES events, not CH FMV opinions.
- [[deploy-pattern]] — manual workflow dispatch after merge.
- [[card-hedge-api-key-location]] — `CARD_HEDGE_API_KEY` lives alongside the new `CARD_HEDGE_CLIENT_ID` in HobbyIQ3 App Service settings.
