## Alternate validation case selection and result

Date: 2026-05-17T13:26:56.125Z
Reason for alternate case: Drake Baldwin live data insufficient (Hypothesis A confirmed)

### Candidate scoring
Source artifact: backend/docs/investigations/mechanism-1-alternate-candidate-scan-2026-05-17.json

| Player | Total 90d CPA comps | Distinct curated peers >=1 comp | Anchor candidate (BC CPA /499) | Anchor candidate (BD CPA /499) | Meets criteria? |
|---|---:|---:|---:|---:|---|
| Wyatt Langford | 0 | 0 | 0 | 0 | no |
| Druw Jones | 0 | 0 | 0 | 0 | no |
| Termarr Johnson | 0 | 0 | 0 | 0 | no |
| Elijah Green | 0 | 0 | 0 | 0 | no |
| Jacob Berry | 0 | 0 | 0 | 0 | no |
| Cam Collier | 0 | 0 | 0 | 0 | no |
| Brooks Lee | 0 | 0 | 0 | 0 | no |
| Justin Crawford | 0 | 0 | 0 | 0 | no |
| Daniel Susac | 0 | 0 | 0 | 0 | no |
| Kumar Rocker | 0 | 0 | 0 | 0 | no |
| Owen Murphy | 0 | 0 | 0 | 0 | no |
| Andrew Painter | 0 | 0 | 0 | 0 | no |

Scan result: no winner found (`winner: null`) after all 12 priority candidates.

Observed CH behavior during scan:
- `findCompsByQuery` resolved a card id for each candidate.
- Subsequent comps call returned HTTP 422 for each resolved card id.
- As a result, every candidate had zero returned 90-day sales in this run.

Additional context:
- Current curated peer universe in checked-in 2022 Bowman Chrome CPA registry is 21 parallels (not 33).

### Selected validation case
No candidate met all 5 selection criteria in this live scan.

- Player: N/A
- Subject parallel: N/A
- Reason: CH live comps endpoint returned 422 across all candidates; no candidate had measurable 90-day CPA peer depth in this run.

### Mechanism 1 result against live CH
Not executed for an alternate subject, because no qualifying candidate was found.

- marketValue: N/A
- predictedPrice: N/A
- predictedPriceRange: N/A
- predictedPriceAttribution: N/A

### Math verification
Not applicable (no qualifying alternate case was runnable).

### Ship recommendation
Hold.

Reason:
- Alternate-case validation could not be completed against live CH because no candidate met the minimum criteria under current live responses (HTTP 422 on comps retrieval across all scanned candidates).
- This does not by itself prove a Mechanism 1 math defect; it blocks live validation evidence for the ship gate.

Suggested immediate next step:
1. Re-run this same bounded scan when CH comps endpoint is stable (no 422 wave), then stop early on first qualifying winner and run live Mechanism 1 validation for that winner.
2. If 422 persists, decide whether to accept fixture-based validation for Phase C with explicit operational risk note about CH live dependency.
