# CardHedge Cost Tracking

## Context

Every outbound CH API request now emits a `ch_call` telemetry event (CF-CH-COST-TRACKING 2026-07-06). Payload:

```jsonc
{
  "event": "ch_call",
  "source": "cardhedge.client",
  "path": "/cards/prices-by-card",   // canonical path (no query string)
  "status": 200,                      // HTTP status; 0 on network error
  "took_ms": 245,                     // wall-clock latency of the fetch
  "ok": true,                         // matches Response.ok
  "error": "..."                      // present only on network exception
}
```

The wrapper adds no functional change to callers — behavior is byte-identical to the direct fetch. Errors are logged AND rethrown.

## Instance

App Insights: **hobbyiq-insights** (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`)

## Queries

### 1. Daily call volume by endpoint

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"ch_call"'
| extend p = parse_json(message)
| extend path = tostring(p.path)
| summarize count() by bin(timestamp, 1d), path
| render columnchart with (kind=stacked)
```

Highlights which endpoints dominate the CH bill. Expected order (usually): `/cards/comps`, `/cards/prices-by-card`, `/cards/card-search`, `/cards/all-prices-by-card`. If `/cards/card-search` overtakes `/cards/comps`, that suggests the pricing cache is missing more often than it should.

### 2. p50 / p90 / p99 latency by endpoint

```kusto
traces
| where timestamp > ago(24h)
| where message contains '"event":"ch_call"'
| extend p = parse_json(message)
| extend path = tostring(p.path)
| extend took_ms = toint(p.took_ms)
| summarize
    count(),
    p50 = percentile(took_ms, 50),
    p90 = percentile(took_ms, 90),
    p99 = percentile(took_ms, 99)
    by path
| sort by count_ desc
```

CH SLAs run typically < 500ms p50, < 1500ms p99. Sustained p99 > 3000ms on any single endpoint = degradation worth flagging to CH support.

### 3. Error rate by endpoint

```kusto
traces
| where timestamp > ago(24h)
| where message contains '"event":"ch_call"'
| extend p = parse_json(message)
| extend path = tostring(p.path)
| extend ok = tobool(p.ok)
| summarize count(), errors = countif(ok == false) by path
| extend errorRate = round(100.0 * errors / count_, 2)
| sort by errorRate desc
```

Any endpoint > 5% error rate over 24h = actionable. Common causes:
- Timeout at the CH edge (`took_ms > 20000` + `status: 0`)
- Rate limit (`status: 429`)
- Their transient 5xx (should self-heal)

### 4. Total daily calls (raw cost proxy)

```kusto
traces
| where timestamp > ago(30d)
| where message contains '"event":"ch_call"'
| summarize dailyCalls = count() by bin(timestamp, 1d)
| render timechart
```

Multiply by CH's per-call rate to project the monthly bill. If dailyCalls trends UP faster than user count, cache hit rate is degrading — investigate.

### 5. Cost per active user (proxy)

Combine `ch_call` count with distinct-user telemetry:

```kusto
let calls = traces
  | where timestamp > ago(24h)
  | where message contains '"event":"ch_call"'
  | count;
let users = traces
  | where timestamp > ago(24h)
  | where message contains "\"userId\""
  | extend p = parse_json(message)
  | summarize dcount(tostring(p.userId));
print
    totalCalls = toscalar(calls | project Count),
    dailyActiveUsers = toscalar(users | project dcount_)
| extend callsPerUser = round(1.0 * totalCalls / dailyActiveUsers, 2)
```

Baseline expectation: 20-50 CH calls per DAU (heavy pricing users can be 100+). Sustained > 200 calls/DAU indicates cache issues or aggressive polling.

## Scheduled alerts (recommended)

**Error rate regression** — fire when 24h error rate on any single endpoint exceeds 8%:
- Frequency: 1h
- Window: last 24h
- Query: #3 above, filtered to `errorRate > 8`
- Action: email `drew@justtheboysandcards.com`

**Daily volume anomaly** — fire when daily calls exceed the 7-day rolling average by > 40%:
- Frequency: 4h
- Detects sudden volume spikes that presage a bill surprise

## What to do with the numbers

If `/cards/card-search` dominates → the picker is cache-missing too much; investigate `SEARCH_TTL_SEC` or the cache key normalization.

If `/cards/prices-by-card` dominates → holding auto-reprice is running too often; check `repriceHoldingsForUser` cadence or user-cap gating.

If latency spikes on ALL endpoints simultaneously → CH itself is degrading. Compare against their status page.

If error rate spikes but latency stays low → hitting a rate limit (429) or malformed request payload (400). Grep `error` field on the trace event.
