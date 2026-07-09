# Launch Dashboard — KQL Cheat Sheet

Pin these queries in Azure Portal → Application Insights → `hobbyiq-insights` (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`) to a dashboard. Ordered by "what would tell you the app is broken first."

**Rollout monitoring cadence:** eyeball every hour the first day, every four hours the first week, once a day after.

---

## 1. Is the API up?

**Uptime + p95 latency per route (last 24h)**

```kusto
requests
| where timestamp > ago(24h)
| where name startswith "POST /api" or name startswith "GET /api"
| summarize count()=count(),
            error_rate=round(100.0 * countif(success == false) / count(), 1),
            p95_ms=round(percentile(duration, 95), 0)
  by name
| order by count_ desc
| take 20
```

**Watch for:** any route with `error_rate > 5%` or `p95_ms > 5000`. Baseline is <1% errors and p95 <2s.

---

## 2. Sibling fallback health

**Fallback fire rate (was 0 pre-launch; expect climb as thin-market cards get requested)**

```kusto
traces
| where timestamp > ago(24h)
| where message contains "sibling_fallback"
| extend p = parse_json(message)
| extend evt = tostring(p.event)
| summarize count() by evt
| order by count_ desc
```

**Expected mix:** `sibling_fallback_success` should dominate. `sibling_fallback_no_premium` should be near-zero (PR #316 was supposed to eliminate the empirical-only bail path). `sibling_fallback_no_base_found` should be under 10% of successes — anything higher signals CH catalog gaps we need to escalate.

**Floor-lift frequency (validates the hobby-consensus multipliers)**

```kusto
traces
| where timestamp > ago(7d)
| where message contains '"event":"sibling_fallback_success"'
| extend p = parse_json(message)
| extend parallel = tostring(p.parallel),
         floorApplied = tobool(p.floorApplied)
| summarize total = count(),
            lifted = countif(floorApplied),
            liftPct = round(100.0 * countif(floorApplied) / count(), 1)
  by parallel
| order by total desc
```

---

## 3. Search + cert coverage

**Cert lookup success rate**

```kusto
requests
| where timestamp > ago(24h)
| where name == "POST /api/compiq/lookup-by-cert"
| summarize total = count(),
            success_rate = round(100.0 * countif(success) / count(), 1),
            p95_ms = round(percentile(duration, 95), 0)
```

**Zero-result searches (candidates for LLM alias tuning)**

```kusto
traces
| where timestamp > ago(7d)
| where message contains "compiq.search"
| where message contains "\"candidates\":0" or message contains "catalog-miss"
| extend p = parse_json(message)
| summarize count() by tostring(p.query)
| top 20 by count_
```

**Alias corrections firing (learning-loop input signal)**

```kusto
requests
| where timestamp > ago(24h)
| where name == "POST /api/compiq/suggest-corrections"
| summarize count(), p95_ms=round(percentile(duration, 95), 0)
```

**Selection log volume (feeds nightly promote-learned-aliases)**

```kusto
requests
| where timestamp > ago(24h)
| where name == "POST /api/compiq/log-selection"
| summarize count()
```

If this is near zero, iOS isn't invoking `/log-selection` after search picks — the learning loop won't have data to promote from.

---

## 4. Pricing surfaces

**Card panel volume + latency**

```kusto
requests
| where timestamp > ago(24h)
| where name startswith "GET /api/compiq/card-panel"
| summarize count(), p50=percentile(duration, 50), p95=percentile(duration, 95)
```

**Trajectory rate distribution**

```kusto
traces
| where timestamp > ago(24h)
| where message contains "trajectory_rate_derived"
| extend p = parse_json(message)
| extend signal = tostring(p.signal)
| summarize count() by signal
| order by count_ desc
```

`matched-cohort-cached` should be the dominant signal source once the overnight matched-cohort job has warmed. `raw-weekly` fallback should be a small tail — if it's growing, the matched-cohort corpus needs more coverage.

---

## 5. CH catalog quality signals

**Cert-lookup description rebuilt (CH mis-attributed player field)**

```kusto
traces
| where timestamp > ago(7d)
| where message contains "cert_lookup_captured"
| extend p = parse_json(message)
| where p.card !has "descriptionRebuilt"
   or tobool(parse_json(message).card.descriptionRebuilt) == true
| summarize count() by tostring(p.player)
| order by count_ desc
| take 20
```

**CH endpoint failures (upstream watch)**

```kusto
traces
| where timestamp > ago(6h)
| where message contains "cardhedge.client"
| where message contains "HTTP 5" or message contains "HTTP 429"
| project timestamp, message = substring(message, 0, 200)
| order by timestamp desc
| take 30
```

Any sustained 5xx or 429 from CH means users are getting incomplete pricing — that's the escalation trigger.

---

## 6. Cost + budget

**LLM alias spend (when the batch job is running or live-fallback is on)**

```kusto
traces
| where timestamp > ago(24h)
| where message contains "llm_alias_generated" or message contains "llm_query_suggestions"
| extend p = parse_json(message)
| extend cost = todouble(p.estimatedCostUSD),
         input = toint(p.inputTokens),
         output = toint(p.outputTokens)
| summarize total_cost = round(sum(cost), 4),
            total_input_tokens = sum(input),
            total_output_tokens = sum(output),
            call_count = count()
```

Threshold: if `total_cost` climbs past $5 in a single day and `LIVE_LLM_ALIAS_FALLBACK_ENABLED=true`, the flag should be reviewed.

**CH call volume (proxy for compute cost)**

```kusto
traces
| where timestamp > ago(24h)
| where message contains "\"event\":\"ch_call\""
| summarize count()
```

---

## 7. Recent user errors

**5xx responses from any user-facing route**

```kusto
requests
| where timestamp > ago(6h)
| where toint(resultCode) >= 500
| project timestamp, name, resultCode, duration
| order by timestamp desc
| take 30
```

If this ever exceeds 20/hour we should treat it as an incident.

**Exceptions surfaced**

```kusto
exceptions
| where timestamp > ago(12h)
| project timestamp, outerType, outerMessage, method
| order by timestamp desc
| take 20
```

---

## Launch-day playbook

1. **Hour 0-1:** watch `#1 uptime` — every route should be answering under 2s. Any spike in error_rate → check `#7 5xx` for stack traces.
2. **Hour 1-6:** watch `#2 sibling fallback` and `#3 cert coverage`. If `sibling_fallback_no_base_found` climbs above 30% of fallback fires, CH catalog is missing SKUs for the players getting requested — escalate to CH support with the top-20 unresolved queries from `#3`.
3. **Day 2+:** watch `#3 zero-result searches` — the top 20 queries there are the alias/typo gaps. Feed them into the manual alias admin route (`POST /api/admin/aliases`) OR run the promote-learned-aliases job.
4. **Weekly:** review `#5 CH catalog quality` for mis-attributed cert lookups — the top players are candidates for the CH escalation email.

## Reference

- App Insights instance: `hobbyiq-insights` (from memory: [[hobbyiq3-app-insights-destination]])
- Alias admin: `POST /api/admin/aliases` (bearer `ADMIN_API_TOKEN`)
- Nightly aggregation script: `backend/scripts/promote-learned-aliases.cjs`
- CH escalation drafts: `scratchpad/ch-support-escalation-*.md`
