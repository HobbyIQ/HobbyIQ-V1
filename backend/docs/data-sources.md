# CompIQ External Data Sources

This document records the authorization and provenance for every external
data source the CompIQ predictive engine ingests beyond Card Hedge.

Each agent module under `backend/src/agents/` references this file in its
header comment to keep authorization tracked at the code level.

---

## Beckett Checklist S3 Bucket

- **Source:** `https://beckett-www.s3.amazonaws.com/news/news-content/uploads/{YYYY}/{MM}/{Year}-{Brand}-{Sport}-Checklist[-N].xlsx`
- **Authorization:** Owner-attested explicit permission from Beckett for CompIQ
  to fetch and ingest the checklist `.xlsx` files hosted on the public S3 bucket
  above.
- **Date of permission:** Recorded by owner on 2026-05-16.
- **Intended use:**
  - Ingest **parallel structures** (color tier name + print run) for every set
    Beckett publishes a checklist for.
  - Ingest the **canonical card-number / player / team** mapping for every
    base, prospect, insert, autograph, relic, and numbered variant.
  - Feed CompIQ's `parallel_attributes` lookup and the predictive multiplier
    table (writes happen in Phase B; Phase A is fetch + parse only, no
    production writes).
- **Cadence:** Pulled on-demand per set + cached locally; not a live signal.
- **Failure mode:** A missing or unreadable checklist must NEVER block a price
  prediction. Downstream callers fall back to existing CH-derived parallels.

Phase A scope is documented in `backend/src/agents/beckett/`:
- `beckettChecklistFetcher.ts` — HTTP fetcher with suffix/month variability
- `beckettChecklistParser.ts` — `.xlsx` → structured intermediate representation

Phase B (not yet implemented) will write parsed output into
`parallel_attributes` (Cosmos) and the multiplier table.

---

## Cardboard Connection Checklist (WordPress Uploads)

- **Source:** `https://www.cardboardconnection.com/wp-content/uploads/{YYYY}/{MM}/{filename}.xlsx`
- **Observed filename family:**
  - `{Year}-{Brand}-{Sport}-checklist-Excel-spreadsheet.xlsx`
  - plus case/suffix/series variants discovered by probe ladder in
    `backend/src/agents/cardboardConnection/cardboardConnectionUrlDiscovery.ts`
- **Authorization:** Owner-attested explicit permission from Cardboard
  Connection for CompIQ to fetch and ingest the checklist `.xlsx` files hosted
  at the WordPress upload paths above.
- **Date of permission:** Recorded by owner on 2026-05-17.
- **Intended use:**
  - Parallel source to Beckett (not a replacement).
  - Ingest structure + print run + card identity rows for CompIQ predictive
    engine coverage where Beckett archive depth is thin, especially pre-2020
    baseball products.
  - Stage-only ingestion in Phase A.4 under
    `backend/data/cardboard-connection-sweep/` (no production writes).
- **Cadence:** On-demand per set + cached locally; not a live signal.
- **Failure mode:** Missing/404 checklist is informational and must not block
  predictions; ingestion layer continues with other sources.

Phase A.4 scope is documented in `backend/src/agents/cardboardConnection/`:
- `cardboardConnectionUrlDiscovery.ts` — WordPress month/filename probe ladder
- `cardboardConnectionFetcher.ts` — `.xlsx` downloader with retries + magic-byte guard
- `cardboardConnectionParser.ts` — `.xlsx` parser to staged intermediate schema
