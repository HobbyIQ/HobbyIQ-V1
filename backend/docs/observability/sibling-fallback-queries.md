# Sibling Fallback Observability

## Purpose

The sibling-card price fallback (`siblingCardPriceFallback.service.ts`) fires when a card has no closed-sale comps at any grade AND `enableSiblingFallback` is on. It derives an estimate from a same-player Base Auto (or Base card cross-class) × parallel-premium (empirical or floor). Each firing emits `sibling_fallback_success` (or an early-bailout event) with full lineage.

These queries let ops:
1. See how often the fallback fires and for which sets/parallels
2. Watch how often the hobby-consensus floor overrides the empirical premium (validates whether we should retire the floor)
3. Watch how often we fall back cross-class (Base card instead of Base Auto) — validates the 10× cross-class multiplier
4. Watch the empirical-vs-effective divergence — big gap = calibration is under-representing that parallel tier

## Instance

App Insights: **hobbyiq-insights** (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`)

## Queries

### 1. Fire rate over the last 24h

```kusto
traces
| where timestamp > ago(24h)
| where message contains '"event":"sibling_fallback_success"'
| summarize count()
```

If this returns 0 over a full day when `/card-panel` traffic is non-zero, either (a) coverage is now so complete that no thin-market cards hit the branch, or (b) the branch is short-circuiting upstream. Cross-check against a known-thin card to disambiguate.

### 2. Floor-lift frequency by parallel

Tells us which parallels the empirical calibration is materially under-representing. A parallel where floor lifts ≥ 50% of the time is a candidate for empirical-table recalibration.

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_success"'
| extend p = parse_json(message)
| extend parallel = tostring(p.parallel)
| extend floorApplied = tobool(p.floorApplied)
| summarize total = count(), lifted = countif(floorApplied), liftPct = round(100.0 * countif(floorApplied) / count(), 1) by parallel
| sort by total desc
```

### 3. Cross-class fallback frequency

The 10× cross-class auto premium is a hobby-consensus guess. If cross-class fires < 5% of the time, few users are hitting it and the guess doesn't matter much. If it fires > 20%, the premium value is load-bearing and worth empirically calibrating (see `scripts/calibrate-cross-class-premium.cjs`).

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_success"'
| extend p = parse_json(message)
| extend crossClass = tobool(p.siblingIsCrossClass)
| summarize total = count(), cross = countif(crossClass), crossPct = round(100.0 * countif(crossClass) / count(), 1)
```

### 4. Empirical-vs-effective divergence distribution

Ratio > 3× means the floor is doing a lot of work. Ratio = 1 means empirical stood.

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_success"'
| extend p = parse_json(message)
| extend empirical = todouble(p.empiricalPremium)
| extend effective = todouble(p.parallelPremium)
| where empirical > 0
| extend divergenceRatio = effective / empirical
| summarize
    count(),
    p50 = percentile(divergenceRatio, 50),
    p90 = percentile(divergenceRatio, 90),
    p99 = percentile(divergenceRatio, 99),
    maxRatio = max(divergenceRatio)
```

### 5. Top 20 sets driving fallback usage

Which sets are the biggest consumers of the sibling path — tells us where CH catalog gaps are worst (candidates for the CH support escalation).

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_success"'
| extend p = parse_json(message)
| extend year = toint(p.year), set = tostring(p.set), parallel = tostring(p.parallel)
| summarize count() by year, set, parallel
| sort by count_ desc
| take 20
```

### 6. Recent Willits Orange Auto trace (post-deploy sanity check)

Verifies the specific card that motivated PR #303 + #305 is emitting the expected lineage. Expected values (as of 2026-07-07):
- `parallel == "Orange"`, `isAuto == true`, `inferredPrintRun == 25`
- `empiricalPremium ≈ 4.364`, `parallelPremium == 15` (floor lifted)
- `floorApplied == true`, `siblingIsCrossClass == false` (Willits has Base Auto SKU)
- `estimatedRawPrice` in the low-thousands range

```kusto
traces
| where timestamp > ago(24h)
| where message contains '"event":"sibling_fallback_success"'
| where message contains "Willits" or message contains "willits"
| project timestamp, message
| take 20
```

### 7. Early-bailout: no-premium events

When the parallel doesn't match any calibration entry AND doesn't match the Bowman Chrome Prospects proxy — indicates a parallel we need to add to the calibration table (or the Panini Prizm coverage list).

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_no_premium"'
| extend p = parse_json(message)
| summarize count() by tostring(p.year), tostring(p.set), tostring(p.parallel)
| sort by count_ desc
| take 20
```

## Follow-ups

- **Recalibration signal**: any parallel where `liftPct` (query 2) > 60% over a full week AND sample size > 20 should trigger a `scripts/discover-ch-parallels.cjs` re-run to refresh the empirical table. If empirical re-derivation still lands below floor, the floor IS the durable answer for that parallel.
- **Cross-class threshold**: if query 3 shows crossPct > 20% sustained, prioritize `scripts/calibrate-cross-class-premium.cjs` to replace the 10× guess with empirical median-of-medians.
- **CH catalog gap escalation**: query 5 output feeds directly into the CH support escalation list — sets with high fallback count are sets where CH is missing SKUs and we're paying the cost via sibling proxying.
