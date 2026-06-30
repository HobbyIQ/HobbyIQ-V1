# `/api/compiq/scan` Telemetry Queries

CF-COMPIQ-SCAN-TELEMETRY (2026-06-30). Sample KQL for the `compiq_scan_attempt` event emitted from [compiq.routes.ts](../../src/routes/compiq.routes.ts) `/scan` handler.

## Event shape

```json
{
  "event": "compiq_scan_attempt",
  "hint": "auto",                      // raw | graded | auto (what iOS asked for)
  "matchPath": "cert-ocr",              // cert-ocr | image-match | null (no match)
  "matchConfidence": 0.96,              // 0.0-1.0; null on no match
  "matchConfidenceBucket": "high",      // none | very_low | low | medium | high
  "hadCertInfo": true,                  // cert-OCR returned a cert_number
  "certGrader": "BGS",                  // present on cert-ocr path only
  "imageInputKind": "url",              // url | base64
  "durationMs": 1842,
  "timestamp": "2026-06-30T18:10:00Z"
}
```

Privacy: never logs imageUrl or imageBase64 content — only the outcome shape.

## Queries

### Q1 — Daily scan volume + match rate

```kql
traces
| where timestamp > ago(7d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| extend matchPath = tostring(p.matchPath)
| summarize
    attempts = count(),
    matched = countif(isnotempty(matchPath)),
    matchRate = round(100.0 * countif(isnotempty(matchPath)) / count(), 1)
    by day = startofday(timestamp)
| order by day desc
```

**Read as:** scan adoption + matchRate trend. Healthy launch: matchRate climbing into the 70-90% range as users learn what photos work.

### Q2 — Match path distribution (cert-OCR vs image-match)

```kql
traces
| where timestamp > ago(14d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| extend matchPath = tostring(p.matchPath)
| summarize attempts = count() by matchPath
| order by attempts desc
```

**Read as:** which path is doing most of the work. cert-OCR dominance = users mostly scanning slabs. image-match dominance = raw card scanning is the primary flow.

### Q3 — Confidence distribution by match path

```kql
traces
| where timestamp > ago(7d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| extend
    matchPath = tostring(p.matchPath),
    bucket = tostring(p.matchConfidenceBucket)
| where isnotempty(matchPath)
| summarize attempts = count() by matchPath, bucket
| order by matchPath, bucket
```

**Read as:** how confident the AI is on real matches. If `image-match` skews low/very_low, raise the confidence threshold for "show a result" vs "ask user to retake."

### Q4 — Cert-OCR coverage by grader (validates the [[grader-validation-iou]])

```kql
traces
| where timestamp > ago(30d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| where tostring(p.matchPath) == "cert-ocr"
| extend grader = tostring(p.certGrader)
| where isnotempty(grader)
| summarize attempts = count(), avgConfidence = avg(todouble(p.matchConfidence)) by grader
| order by attempts desc
```

**Read as:** which graders are successfully OCR'd in the wild. Closes the [[grader-validation-iou]] empirically — if BGS/SGC/CGC counts climb with healthy confidence, real-world coverage is confirmed without manual testing.

### Q5 — `hint=auto` heuristic effectiveness

```kql
traces
| where timestamp > ago(7d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| where tostring(p.hint) == "auto"
| extend matchPath = tostring(p.matchPath)
| summarize
    total = count(),
    certOcrHits = countif(matchPath == "cert-ocr"),
    imageMatchHits = countif(matchPath == "image-match"),
    noMatch = countif(isempty(matchPath))
| extend
    certOcrPct = round(100.0 * certOcrHits / total, 1),
    imageMatchPct = round(100.0 * imageMatchHits / total, 1),
    noMatchPct = round(100.0 * noMatch / total, 1)
```

**Read as:** on `hint=auto`, the route tries cert-OCR first then falls back. If a high % of `auto` requests end up on image-match (cert-OCR miss), iOS users are scanning raw cards but iOS isn't sending `hint=raw`. Update iOS to pass the explicit hint when known.

### Q6 — Scan latency by path + input kind

```kql
traces
| where timestamp > ago(7d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| extend
    matchPath = tostring(p.matchPath),
    inputKind = tostring(p.imageInputKind),
    ms = toint(p.durationMs)
| summarize
    p50 = percentile(ms, 50),
    p95 = percentile(ms, 95),
    p99 = percentile(ms, 99),
    n = count()
    by matchPath, inputKind
| order by matchPath, inputKind
```

**Read as:** url vs base64 latency profile. Expect url to be faster (CH downloads once). If base64 p95 is materially slower, iOS should be guided toward upload-then-URL.

### Q7 — No-match cluster analysis (what's failing?)

```kql
traces
| where timestamp > ago(14d)
| where message contains "compiq_scan_attempt"
| extend p = parse_json(message)
| where isempty(tostring(p.matchPath))
| extend
    hint = tostring(p.hint),
    inputKind = tostring(p.imageInputKind),
    ms = toint(p.durationMs)
| summarize attempts = count(), avgMs = avg(ms) by hint, inputKind
| order by attempts desc
```

**Read as:** which combinations fail most. High no-match on `hint=raw` + base64 = iOS raw scan UX needs work (lighting, framing guide, etc.).

## Dashboard slot

Pair with the existing [calibration dashboard](./calibration-dashboard.md). Suggested layout:

1. **Q1** as a line chart (volume + matchRate over time) — KPI tile
2. **Q4** as a bar chart (grader coverage) — validates [[grader-validation-iou]]
3. **Q3** as stacked bars (confidence distribution)
4. **Q5** as a single stat tile (auto-hint hit-mix)

## Related

- [[grader-validation-iou]] — Q4 is the production proof; once iOS scan UI ships and Q4 shows non-zero counts for non-PSA graders with healthy confidence, the IOU is closed.
- [iOS coordination doc](../ios-prompts/compiq-scan-route.md)
