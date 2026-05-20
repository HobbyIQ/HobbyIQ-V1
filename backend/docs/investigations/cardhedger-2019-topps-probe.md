# Card Hedger 2019 Topps Probe (Phase A.5)

Date: 2026-05-17
Scope: Read-only probe, 2019 Topps only, 8 sample queries.

## Probe method

- Used existing compiled client methods only from `backend/src/services/compiq/cardhedge.client.ts`:
  - `searchCards`
  - `identifyCard`
  - `findCompsByQuery`
- Also captured raw upstream responses for:
  - `POST /cards/card-search`
  - `POST /cards/card-match`
- Query count: 8
- Rate behavior: inserted >=900ms spacing between raw calls and >=1s between query cases.
- Full raw + parsed log artifact:
  - `backend/docs/investigations/cardhedger-2019-topps-probe-samples.json`

## Sample query set

1. 2019 Topps Series 1 Shohei Ohtani #1
2. 2019 Topps Series 1 Mike Trout #100
3. 2019 Topps Gold /2019 Vladimir Guerrero Jr. #700
4. 2019 Topps Black /67 Mookie Betts #50
5. 2019 Topps Chrome Negative Refractor Pete Alonso RC
6. 2019 Topps Update Rookie Debut Autograph Vladimir Guerrero Jr.
7. 2019 Topps Chrome Rookie Autograph Fernando Tatis Jr.
8. 2019 Topps 150 Years of Professional Baseball Mike Trout

## Per-query raw + parsed log summary

| Query | Raw card-search | Raw card-match | Parsed result card.variant | Parsed sales count | Variant warning |
|---|---:|---:|---|---:|---|
| Shohei Ohtani #1 | 200 | 200 | Base | 7 | [] |
| Mike Trout #100 | 200 | 200 | Base | 7 | [] |
| Gold /2019 Vlad #700 | 200 | 200 | Base | 7 | ["/2019"] |
| Black /67 Mookie #50 | 200 | 200 | Base | 7 | ["/67", "black"] |
| Chrome Negative Pete Alonso RC | 200 | 200 | Sepia Refractor | 6 | [] |
| Update Rookie Debut Autograph Vlad | 200 | 200 | Base | 7 | ["autograph"] |
| Chrome Rookie Autograph Tatis | 200 | 200 | Base | 7 | [] |
| 150 Years Mike Trout | 200 | 200 | Base | 7 | [] |

## Structural question answers

### Question 1: Print run data shape

Does CH return structured print runs (example `printRun: 50`)?
- No explicit structured print-run field was observed in sampled `card-search`, `card-match`, or normalized `comps` outputs.

Observed card-search object keys (sample):
- `description`, `player`, `set`, `number`, `variant`, `card_id`, `image`, `category`, `category_group`, `set_type`, `7 Day Sales`, `30 Day Sales`, `rookie`, `gain`, `prices`

Observed card-match object keys (sample):
- `confidence`, `reasoning`, `description`, `player`, `set`, `number`, `variant`, `card_id`, `image`, `category`, `prices`

Observed comps/sales keys (normalized by client):
- `price`, `date`, `grade`, `source`, `sale_type`, `title`, `url`

Where print-run-like info appears:
- Mostly in free text fields and user query tokens, not in dedicated numeric fields.
- Example: query asked for `/2019` and `/67`, but parsed result still fell back to `variant: "Base"` with warnings.

Probe conclusion for Q1:
- Print-run signals are not reliably exposed as structured fields in the sampled response shape.
- Print-run intent appears primarily embedded in text context (query/title/variant wording), and often not retained in matched card variant for these 2019 Topps parallel queries.

### Question 2: Coverage

Did CH return data for every queried 2019 Topps subject?
- Transport-level coverage: yes (all 8 queries returned HTTP 200 for both raw endpoints).
- Semantic coverage (exact requested parallel/autograph intent): mixed/partial.

Evidence of semantic misses:
- `2019 Topps Gold /2019 Vladimir Guerrero Jr. #700` -> fallback `variant: "Base"`, warning `["/2019"]`
- `2019 Topps Black /67 Mookie Betts #50` -> fallback `variant: "Base"`, warning `["/67", "black"]`
- `2019 Topps Update Rookie Debut Autograph Vladimir Guerrero Jr.` -> fallback `variant: "Base"`, warning `["autograph"]`
- `2019 Topps Chrome Negative Refractor Pete Alonso RC` -> returned `variant: "Sepia Refractor"` instead of negative

Probe conclusion for Q2:
- 2019 Topps appears present in CH for base-level and general card retrieval.
- Exact parallel/autograph coverage for these sample intents appears partial and inconsistent.

### Question 3: Catalog vs comp surface

Does the same response shape carry catalog/structural data usable for `parallel_attributes` ingestion?
- The current sampled shape does include card metadata fields (`set`, `number`, `variant`, `description`, `category`, etc.), but:
  - no explicit structured print-run field observed
  - no explicit durable parallel taxonomy field observed
  - no bulk catalog export method in current client

Current client endpoint surface:
- `POST /cards/card-search` (free text search)
- `POST /cards/card-match` (single AI match)
- `POST /cards/comps` (price comps by card_id)

From current client implementation, there is no method for:
- full set catalog pull (all cards for set/year)
- structured parallel + print-run catalog retrieval

Probe conclusion for Q3:
- Current CH usage surface is comp-first and query-centric.
- It is not currently a catalog-grade ingestion surface for robust `parallel_attributes` population.

## Recommendation

Recommendation: **Option B-infeasible** (for the current client surface and observed sample shape).

Rationale:
1. Structured print-run fields were not observed in sampled payloads.
2. Parallel/autograph intent frequently degraded to base fallback for 2019 Topps sample queries.
3. No bulk catalog method exists in the current client API surface for set-level extraction.

Interpretation:
- CH remains valuable as a comp/sales source.
- Based on this probe, CH should not be assumed to close the print-run catalog gap for Phase A ingestion without either:
  - a separate CH catalog endpoint with structured print runs, or
  - additional trusted source(s) for authoritative parallel+print-run structure.
