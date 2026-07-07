# Trajectory Signal Source Distribution

## Purpose

Show how often each trajectory signal source fires. Tells us where our coverage gaps are — if `null` dominates, matched-cohort + parallel-tier + release-decay aren't reaching enough cards. If `release-decay-only` dominates, we're relying too heavily on the prior instead of real market signals.

## Instance

App Insights: **hobbyiq-insights** (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`)

## Queries

### 1. Distribution over the last 24h

```kusto
traces
| where timestamp > ago(24h)
| where message contains '"event":"trajectory_rate_derived"'
| extend p = parse_json(message)
| extend signal = tostring(p.signal)
| summarize count() by signal
| sort by count_ desc
```

### 2. Distribution over 7 days as a stacked area

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"trajectory_rate_derived"'
| extend p = parse_json(message)
| extend signal = tostring(p.signal)
| summarize count() by bin(timestamp, 6h), signal
| render areachart with (kind=stacked)
```

Trend to watch: `matched-cohort-cached` should dominate over time as the overnight job's coverage grows. If `parallel-tier` or `release-decay-only` sustain > 30% of daily volume, matched-cohort coverage isn't keeping pace with the growing card catalog.

### 3. No-signal rate (coverage gap)

```kusto
let derived = traces
  | where timestamp > ago(24h)
  | where message contains '"event":"trajectory_rate_derived"'
  | count;
let noSignal = traces
  | where timestamp > ago(24h)
  | where message contains '"event":"trajectory_rate_no_signal"'
  | count;
derived
| extend derivedCount = Count
| project derivedCount
| extend noSignalCount = toscalar(noSignal | project Count)
| extend totalRequests = derivedCount + noSignalCount
| extend noSignalPct = round(100.0 * noSignalCount / totalRequests, 2)
| project totalRequests, derivedCount, noSignalCount, noSignalPct
```

Target: < 10% no-signal rate on baseball cards. Anything above 20% means our signal chain is missing meaningful coverage.

### 4. Which sets/tiers fall through to no-signal most?

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"trajectory_rate_no_signal"'
| extend p = parse_json(message)
| extend player = tostring(p.player)
| extend hadTier = tobool(p.hadParallelTierKey)
| extend hadRelease = tobool(p.hadReleaseCardKey)
| summarize count(), tierUnavail = countif(hadTier == false), releaseUnavail = countif(hadRelease == false)
  by player
| sort by count_ desc
| take 30
```

Players with high no-signal counts + `hadTier == false` are the ones the parallel-tier discoverer isn't seeing. Feed those into a manual matched-cohort backfill.

### 5. Release-decay fire rate by set

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"release_decay_applied"'
| extend p = parse_json(message)
| extend matchedKey = tostring(p.matchedKey)
| extend weeksSinceRelease = todouble(p.weeksSinceRelease)
| summarize count(), meanWeeks = avg(weeksSinceRelease) by matchedKey
| sort by count_ desc
```

Which products are we most-often applying decay to? Any entries with `matchedKey` ending in `:auto` come from `releaseAutoDetect` (CF #290), not the hard-coded table. Those are the auto-discovered releases; verify they look right.

## Scheduled alerts (recommended)

**Signal coverage regression** — fire when the 24h no-signal rate exceeds 25%:
- Frequency: 6h
- Window: last 24h
- Query: #3 above
- Threshold: `noSignalPct > 25`
- Action: email `drew@justtheboysandcards.com` (per `reference_ops_alert_email` memory)

**Parallel-tier degradation** — fire when `parallel-tier` share drops below 5% for two consecutive days (suggests the tier discovery is failing):
- Frequency: 12h
- Window: last 24h
- Query: #1 above, filtered to `signal == "parallel-tier"`
- Threshold: `count_ < N` where N is 5% of daily derivation volume

## What to do with the numbers

If matched-cohort share drops < 60% → prioritize expanding the overnight job's covered player list.

If release-decay-only spikes > 15% of daily volume → the auto-detect is likely misfiring on non-release additions. Sanity-check `release_auto_detected` events against calendar knowledge.

If total derivation volume drops sharply while no-signal stays flat → the entire trajectory pipeline may be error-throwing silently; check `[observedGradeCurve]` warn logs.
