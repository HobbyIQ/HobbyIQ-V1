# Phase 0 — Session Handoff (2026-05-21)

This document captures Phase 0 findings from the resumed session. It is
the canonical hand-off into Objective 2 (migration plan proposal).

---

## Headline finding — Production observability layer is largely unwired

Coverage and quality measurements that the brief and the original
Cardsight migration roadmap assumed could be sourced from production
telemetry **are not currently possible**. Four independent gaps stack:

1. **`comp_logs` writer removed from codebase.**
   - Reader (`backend/src/services/dailyiq/marketDelta.service.ts`)
     still references the Cosmos `comp_logs` container, but no service
     in `backend/src/` writes to it. Greps for `compLogService`,
     `writeCompLog`, `items.create.*comp`, `comp_logs.*create` return
     zero hits.
   - Implication: no historical record of pricing predictions exists in
     Cosmos. The container retains pre-removal rows but is no longer
     being appended to. This breaks the data path the prior roadmap
     assumed for cohort selection and post-deploy regression analysis.

2. **`compiq_corpus` ML-corpus accumulation disabled.**
   - Container exists; writer (`writeCorpusEntry.ts`) is wired into
     `/api/compiq/price` and `/api/compiq/price-by-id`.
   - Production app setting on `HobbyIQ3`: `COMPIQ_CORPUS_SAMPLE_RATE=0`.
   - Implication: no corpus rows have been captured. The privacy-safe
     ML-training corpus that was supposed to back the migration's
     regression harness is empty.

3. **Router warn line under-captured by App Insights.**
   - `primary_mode_cardhedge_namespace_only` warn fires inside
     `cardsight.router.ts` Site B short-circuit.
   - 30-day App Insights `traces` query returns **156 captures** for the
     warn vs **1660** `/api/compiq/price-by-id` requests over the same
     window. Capture rate ≈ 9%.
   - Two possible causes (either is bad): App Insights trace sampling is
     dropping ~91% of records, OR the warn isn't actually firing on
     every `/price-by-id` call (which would tighten 1.4b verdict A2 —
     "Site B fires on every /price-by-id" must be downgraded to "Site B
     fires on the cohort that reaches the router; the rest of the
     traffic exits earlier on a path we have not characterized").
   - Implication: cannot use this warn to enumerate the production
     cardId universe.

4. **Cosmos `hobbyiq-comps-centralus` regional endpoint at 21% failure
   rate** (filed as a separate finding under Objective 1.4 earlier in
   this session — recorded here for stack-up).

### Net implication for Phase 2

Phase 2 migration **cannot be sized for regression risk from existing
production data**. There is no usable production cohort, no captured
ML corpus, and no reliable router-warn enumeration. The migration must
ship with strong logging built in from day one and accept **post-deploy
discovery as the measurement approach** — coverage and regression are
observed after the fact, not predicted before the fact.

---

## Verified facts (1.6a, 1.6b)

### 1.6a — `CARDSIGHT_MODE` production value

`az webapp config appsettings list -n hobbyiq3 -g rg-hobbyiq-dev` →
**`CARDSIGHT_MODE = exclusive`**. Confirms `cardsight.router.ts` Site B
short-circuit is the active path for `cardIdSource: "cardhedge"`
traffic. The router returns `[]` immediately for those calls.

### 1.6b — Cardsight catalog freshness smell test

5 read-only `searchCatalog` calls against `https://api.cardsight.ai/v1/catalog/search?segment=baseball`. Header `X-API-Key` only.

| Card | HTTP | results | latency ms | pass |
|---|--:|--:|--:|:--:|
| Paul Skenes 2024 Bowman Chrome Auto | 200 | 1 | 10123 | ✓ |
| Jackson Chourio 2024 Topps Chrome Auto | 200 | 20 | 10678 | ✓ |
| Roman Anthony 2024 Bowman Chrome Prospects Auto | 200 | 0 | 5337 | n/a |
| Junior Caminero 2024 Topps Chrome Rookie | 200 | 20 | 9036 | ✓ |
| Wyatt Langford 2024 Topps Chrome RC | 200 | 8 | 12133 | ✓ |

**Pass rate: 4 / 4 valid queries.** The Roman Anthony query is
invalid — Anthony's 2024 issue is in Bowman's Best, not Bowman
Chrome Prospects. Cardsight correctly returned zero rows because the
card does not exist as queried; this is **not** a catalog gap.

**Headline (1.6b-1):** Cardsight catalog appears populated for current
product in this small smell-test sample. **Not a coverage claim** —
sample size is 4 manually-curated cards, not a representative
cross-section.

#### Finding 1.6b-2 — Latency margin is tight

Observed p50 latency for `searchCatalog`: **9–10 s** across the 4
valid queries (range 5.3–12.1 s). Client `DEFAULT_TIMEOUT_MS` is
**15 s**. Steady-state usage already runs at 60–80% of timeout budget
on a single call. Any latency spike on Cardsight's side will produce
user-visible timeouts.

Implication: Phase 2 plan must explicitly choose where this is
handled — timeout tuning, retry/backoff at the client, or aggressive
cache layer (currently `cs:catalog` TTL via `cacheWrap`). Punting to
Phase 4a is acceptable but must be a documented choice, not an
oversight.

#### Finding 1.6b-3 — Search-quality first-result mismatch

First-result family mismatch on **2 of 4 valid queries**:

- Junior Caminero "Topps Chrome Rookie" → first hit `Topps Allen &
  Ginter X` Base Set
- Wyatt Langford "Topps Chrome RC" → first hit `Topps Heritage` Base
  Set

The `relevance` field clusters tightly (5.10–5.52) across all results
irrespective of how well the result matches the query's product
family, suggesting the API's ranking is not aggressively penalizing
product-family mismatch.

User-facing impact is distinct from coverage: a user who searches
"Topps Chrome" and is shown a `Topps Heritage` card has been served
*the wrong card*, not *fewer cards*. This is a different failure mode
from 1.6b-1 / 1.6b-2 and needs separate handling — result reranking,
query-augmentation (e.g., reinforce product family on the API call),
or a confidence threshold below which the UI degrades to a
disambiguation prompt rather than auto-selecting.

Implication: Phase 2 plan must explicitly choose whether result
quality is in-scope or deferred.

---

## Stage 2 (original 1.6 plan) — CANCELED

Original 1.6 plan called for top-N coverage spot-check of production
free-text queries and cardIds against Cardsight. Canceled because the
two source datasets are too compromised to support a coverage number:

- Axis 1 (`/search` traces) is largely synthetic-looking harness traffic
  (49–72 hits per unique query within a 6-day window, mixed sports).
- Axis 2 (`/price-by-id` warn) is at 9% trace coverage — too biased.
- No CH-ID → Cardsight-ID translator exists, so direct lookup of the
  12-id Axis 2 cohort isn't even available without an attribute
  recovery path.

Source-audit detail and raw rows: see
`docs/phase0/cardsight_coverage_2026-05-21_sources.md`.

---

## Status going into Objective 2

- Objective 1.1 — blocked + documented (earlier)
- Objective 1.2, 1.3 — complete
- Objective 1.4 — route stats + zero CH deps + Cosmos 21% logged
- Objective 1.4b — verdict A2 (production NOT calling cardhedger.com)
  with the caveat above on warn capture rate
- Objective 1.5 — router audit complete, capability gaps catalogued
- Objective 1.6a — `CARDSIGHT_MODE=exclusive` confirmed
- Objective 1.6b — 4/4 valid queries pass; latency (1.6b-2) and
  search-quality (1.6b-3) elevated to first-class findings
- Objective 1.6c — this document
- Objective 2 — **deferred. Awaiting explicit go from user. Coverage
  sizing will not be improvised; migration plan ships with strong
  logging and post-deploy observation as the measurement approach.**

HALT.
