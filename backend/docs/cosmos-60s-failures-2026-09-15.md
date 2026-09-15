# Cosmos calls failing at exactly 60,000 ms

**Found** 2026-09-15 while attributing a slow `/api/compiq/price` deploy smoke.
**Status** OPEN — reported, not investigated. Scheduled separately.
**Not caused by** #2163 / #2164 / #2165 / #2170 / #2178 / #2181. See "It predates the bundle".

## What the signal is

App Insights `dependencies` rows against `hobbyiq-comps.documents.azure.com`
with `duration` at or just under **60,000 ms** and `success == false`. 60,000 ms
is the `@azure/cosmos` 4.9.3 default `requestTimeout`
(`ConnectionPolicy.js:27`), so these are calls the SDK gave up on at its own
ceiling — not slow calls that completed.

## Volume

30-day window:

| | |
|---|---|
| total ~60 s calls | **2,130,145** |
| oldest sample | **2026-08-16T14:21:31.502Z** |
| newest sample | 2026-09-15T13:19:15.812Z |

By hour over the last 24 h — note this is bursty, not a constant rate:

```
2026-09-14T13Z       59        2026-09-15T01Z      489
2026-09-14T14Z      143        2026-09-15T02Z       86
2026-09-14T15Z      130        2026-09-15T03Z       78
2026-09-14T16Z      130        2026-09-15T04Z      428
2026-09-14T17Z       72        2026-09-15T05Z       78
2026-09-14T18Z      132        2026-09-15T06Z      709
2026-09-14T19Z   26,749        2026-09-15T07Z       89
2026-09-14T20Z   53,732   <-   2026-09-15T08Z       38
2026-09-14T21Z    1,182        2026-09-15T09Z      103
2026-09-14T22Z    6,886        2026-09-15T10Z       99
2026-09-14T23Z    1,045        2026-09-15T11Z      817
2026-09-15T00Z    8,324        2026-09-15T12Z      346
                               2026-09-15T13Z       20
```

The 19:00–20:00Z spike on 09-14 is ~80,000 failures in two hours, then it
decays. A baseline of 50–150/hour persists between spikes.

## Which operations and containers

Last 24 h, `duration >= 59000`, grouped:

| container | role | n | failed |
|---|---|---:|---:|
| **card_catalog** | HobbyIQ3 | **96,872** | 96,872 |
| card_catalog | hobbyiq3-worker | 2,760 | 2,752 |
| card_catalog (`pkranges`) | HobbyIQ3 | 930 | 930 |
| sold_comps | HobbyIQ3 | 312 | 312 |
| comps_staging | hobbyiq3-worker | 230 | 230 |
| *(root `GET /`)* | HobbyIQ3 | 165 | 165 |
| sold_comps | hobbyiq3-worker | 101 | 99 |
| comps_staging | HobbyIQ3 | 85 | 85 |
| title_parse_cache | HobbyIQ3 | 74 | 74 |
| player_trends | HobbyIQ3 | 16 | 16 |

**`card_catalog` is ~97% of it**, overwhelmingly `POST .../docs` (query
execution), and overwhelmingly on the API role rather than the worker. The 930
`pkranges` failures are notable separately: that is partition-key-range
metadata, which the SDK fetches before a cross-partition query — a failure
there fails the query before it starts.

## It predates the bundle

Checked explicitly, because the 20,000 ms sibling bucket looked at first like
`COSMOS_REQUEST_TIMEOUT_MS` from #2164:

- **60 s bucket**: oldest sample **2026-08-16**, a month before any of these
  PRs existed. 26,749 in the 19:00Z hour of 09-14 alone — before #2163 was
  written.
- **20 s bucket**: oldest sample **2026-09-14T16:38:41Z**, still ~20 hours
  before #2164 merged (2026-09-15T13:02:38Z). It matches
  `services/compiq/cardhedge.client.ts:16` `DEFAULT_TIMEOUT_MS = 20_000`,
  which is a CH client timeout and unrelated to the Cosmos connection policy.

Neither bucket is attributable to the pricing-path work.

## Why it matters

A 60 s failed call is not just a slow request — the SDK's retry policies sit
*above* `requestTimeout`, so one logical operation can spend multiples of 60 s
before surfacing. This is the most likely mechanism behind the original
`/api/compiq/price` hangs to Azure's 240 s front-end kill, and it will keep
producing them wherever a request path touches `card_catalog` under load.

The pricing-path PRs bounded the *caller* (request deadlines, abort signals,
one client, fewer queries). They did not address whatever makes `card_catalog`
queries fail at the ceiling in the first place.

## Suggested starting points

Not investigated; these are where I would look.

1. **Is it throttling?** Check `429` rates and RU consumption on `card_catalog`
   for the 09-14 19:00–21:00Z spike. `card_catalog` was scaled to 100k RU
   (memory: Cosmos RU state 2026-09-07) — confirm that is still in effect and
   whether the spike coincides with a scale-down.
2. **Is it one query shape?** `dependencies.data` carries only the URL, so
   attribution needs either the `operation_Id` joined to a request, or
   correlating the spike with what was running (a backfill lane, a rematch
   wave, the checklist ingest).
3. **Is it the `pkranges` failures cascading?** 930 metadata failures could
   each fail a cross-partition query that had not yet issued.
4. **Does the spike correlate with a deploy or a lane start?** 09-14 19:00Z is
   the obvious anchor.

## Query to reproduce

```kusto
dependencies
| where duration >= 59000
| extend coll = extract(@'colls/([^/]+)', 1, tostring(data))
| summarize n=count(), failed=countif(success==false) by coll, tostring(name), cloud_RoleName
| order by n desc
```
