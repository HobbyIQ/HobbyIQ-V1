# The HobbyIQ Catalog

**The authoritative record of every sports card HobbyIQ knows about.**

## What it is

One Cosmos container — `card_catalog` (account `hobbyiq-comps`, database
`hobbyiq`, partition `/cardId`) — holds every distinct card identity the
system has ever seen. Each row is one canonical card, keyed by its
deterministic `hobbyiqCardId` slug:

```
hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallel>[:<auto|no-auto>][:num-<printRun>]
```

Snapshot: **~9.6M distinct identities** (2026-08-10) — 89.9% baseball,
8.7% football, 1.3% basketball, no other sports at scale yet.

The slug is a hash of identity, not provenance. Multiple ingest sources
(BCP, ChecklistCenter, CardHedge, Cardsight, Beckett, TCA) writing the
same card converge on the same row via upsert. The `source` field on
any row is provenance only — it does not affect identity or uniqueness.

## Why it matters

The catalog **is the moat** ([[project_catalog_is_the_moat_not_vendor_apis]]).
Every user request answers from indexed catalog rows, not live vendor
API calls. When our catalog knows about a card, we can:

- Match sold_comps to a canonical identity (`hobbyiqCardId`)
- Compute FMV from the sibling pool for that identity
- Show grade-tier variants (raw, PSA, BGS, SGC, CGC) via materialized rows
- Detect gaps: cards that sold on eBay but aren't in our catalog

Anything else — Cardsight for cert lookup, TCA for freshest sales, CH
for historical volume — is a data source that FEEDS the catalog. None of
them ARE the catalog.

## What lives on a row

Required for identity: `hobbyiqCardId`, `cardId`, `sport`, `cardYear`,
`setKey`, `cardNumber`, `parallel`, `isAuto`, optionally `printRun`,
`gradeCompany`, `gradeValue`, `gradeTier`.

Enrichment: `playerName`, `team`, `setName`, `searchTokens`, `photoUrl`,
`verificationStatus` (unverified / medium / high / verified), plus
provenance (`source`, `catalogBatch`, `builtAt`, `catalogVersion`).

## How gaps get found

Nightly at 06:00 UTC the **HobbyIQ Catalog Gap Report**
(`emailCatalogGapDigest.cjs`) scans sold_comps for rows without a
`hobbyiqCardId` match, buckets them by `(year, setName, sport)`, and
ranks by unlock volume — how many sold_comps would map to catalog if
we ingested that checklist next. Result mails to
`drew@hobby-iq.com`. That report IS the gap-finding tool.

Enhancements over the raw bucket list: sport rollup, year rollup,
suggested source per gap (BCP URL for baseball, ChecklistCenter for
football/basketball).

## When to touch it

- **Add cards**: run an ingest script under `backend/scripts/ingest*`.
  Every ingester computes the slug deterministically so re-runs are
  idempotent upserts.
- **Explode grade tiers**: `explodeCatalogGrades.cjs` materializes
  Raw + PSA 6-10 + BGS 8-10 + Black Label + SGC 8-10 + CGC 8-10 for
  every base identity so sold_comps map cleanly.
- **Fix a field on a specific row**: `catalogReview.routes.ts`
  admin surface — one card at a time, audit-logged.
- **NEVER**: hand-write into Cosmos without going through a script
  that computes the slug. A row without `hobbyiqCardId` is an orphan
  that no user query will ever hit.

## Ingestion sources (2026-08-10)

| Source                       | Records | Notes |
|------------------------------|--------:|-------|
| bccp + baseballcardpedia + bccp-graded + baseballcardpedia-graded | ~4.7M | Baseball checklists 1950-2026, scraped from baseballcardpedia.com. Nightly sweep via `bcp-sweep.yml`. |
| checklistcenter + -graded + -html + -html-graded | ~2.9M | Multi-sport checklists. |
| cardsight + cardsight-graded | ~1.5M | Cardsight taxonomy pass. |
| cardhedge + cardhedge-graded | ~552K | Auto-created when a CH query returns a row not in the catalog. |
| beckett-checklist + -graded  | ~69K | Beckett checklist ingester. |
| tcdb-scrape                  | ~5K | Long-tail from TCDB. |
| pool                         | ~76K | Emitted directly from sold_comps observation (Phase 4). |
| Others                       | ~small | Baseball Almanac, product-structure scrapers, user-verified, ebay-browse. |

`tree-builder-v1` and `sales-derived` are **dead sources**
([[project_catalog_dead_sources_2026_08_08]]) — retire their rows via
`nukeSalesDerivedCatalog.cjs`.
