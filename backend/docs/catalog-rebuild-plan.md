# The catalog rebuild — full plan and state

Drew + Claude, 2026-08-28 → 29. The one-page truth for any session picking this
up. Doctrine that governs everything here: **the checklist is the spine** —
identity comes from checklists, sales and holdings match TO it, no pass invents
vocabulary, numbered Base is legitimate where a checklist lists it, FMV is a
projected next sale from the exact-identity pool, never a median, and **a sale
never mints a catalog row** (vendor comps included — only checklists mint;
user-owned cards may seed).

## DONE and verified

- Catalog addressing 99.9% (`id === cardId === slug`, point-readable)
- Flagship parallel ladders 2016–2026 ingested (bcp-ladders 2026-08-28:
  234,863 rows; 2026 Topps alone: 99 rungs), then the **insert sections** of
  Topps / Topps Chrome / Topps Chrome Update (#1350: 92 products, 558,470 rows,
  bcp-ladders 2026-08-29: 339,769 rows)
- Checklist ingest guarded: authority-checked source names, verbatim fields,
  category-structure decides Base, one point-read per row (23k rows/min)
- Pokémon identity unified (numbers unglued, setKeys onto TCG-code vocabulary;
  era names stripped too, #1355)
- Year-prefix twin setKeys unified across sports; season keys ruled
  (first year + bare key); bowman-paper folded into bowman BY RULING
- `playerSlug` on every derived row (flagship-first backfill), and the
  checklist-backing bridge needs a first AND last name (#1351)
- **Baseball scorecard** (derived identity rows judged against the spine):
  v1 34.6% → v2 87.9% → v3 interim **89.1%** any-backing (2.28M rows:
  card-confirmed 1.89M, checklist-confirmed 138k, unconfirmed 249k = 10.9%,
  half of them `ingest-auto-seed`, half `catalog-explode-actuals`). The 17.9M
  unstamped baseball rows are the checklist spine itself — never judged.
- Parallel mapping (cascade: exact / squash / unique long-form / family-refined)
- **Pricing, live in prod**: never a bare median; exact-identity supremacy at
  the holdings/notify path (>= 3 exact comps → unified answer, no fallback rung
  may set the tier); divergence digest fires ONLY on exact-pool prices —
  fallback divergences are `engine_divergence_suspect` telemetry
- **Sales cannot mint catalog rows** (#1353, live sha `c66f97d`):
  `ensureCatalogRow` fires only for user sources; the matcher's seed refuses
  non-user / non-checklist input regardless of env. Found the hard way — the
  one-pool emission (#1352) let 10,620 sale-minted rows in over ~45 minutes;
  every one is retired (#1354, #1356) and its sales stamped
  `catalogUnplacedReason` for the rematch. Pre-merge runner shards kept
  minting for 30 minutes AFTER the deploy — cancel fleets by script identity,
  not dispatch time.
- Internal holding resolver built (no vendor calls); dry-run: 31/92 resolved,
  12 corrections

## RUNNING (self-driving; each step fires on the last one's completion)

1. **R5 rematch** — `reslugAllSoldComps`, 8 slots, dispatched 2026-08-29
   02:31Z (only-improve; also re-resolves the 14.6k sales the retire unplaced)
2. Baseball re-annotation v3 fleet draining → compile the final scorecard
3. Pokémon: mapper chain (era fix) → re-annotate → pokémon scorecard
4. → RU rollback (Drew's go given, after the rematch + emission drain):
   card_catalog 400k→~2.5k, **sold_comps 100k→8k** (raised 40k→100k TEMP
   2026-08-29 02:52Z — it was pinned at 100% with 24k 429s/5min under the
   rematch + emission), **title_parse_cache 2,000→400** (manual, same
   moment). Locally `az cosmosdb sql container throughput update`; from CI
   the data plane — the CI principal has no control plane
5. → holdings APPLY (`conform-holdings-to-catalog`, replace gate 0.95)

## NEXT BUILDS (in order)

1. **One-pool emission, redo** — re-drain `comps_staging` (awaiting-catalog
   670k, awaiting-verify 1.83M, player-precision 373k, chdaily ~284k) now that
   an unmatched sale enters the pool flagged instead of minting a row; the
   1.46M `needs-parse` sales go through the title parser first
2. **checklistcenter → canonical CSV converter** — last legacy source into the
   guarded pipe (its old ingester raw-upserts and must not be rerun)
3. **One valuation path** — retire the Cardsight-era graded compiler onto the
   canonical engine; route the 3 compiq route call sites through the canonical
   resolver. Acceptance: docs/pricing-obedience-audit.md
4. Phase 07 — 58 writers bypassing upsertCatalogEntry (the red guard test
   `oneWayToBuildACatalogRow` names them)

## NEEDS DREW (not code)

- **755,755 pre-existing `ingest-auto-seed` rows** (sale-minted before
  2026-08-29 01:40Z, all sports): delete-vs-keep. They are the self-confirming
  class; 114k of baseball's 249k unconfirmed are these. A retire is one
  dispatch away (`retire-autoseed-window` with an earlier SINCE) once ruled.
- Pokémon promo ambiguity: `*-black-star-promos` derived keys match several
  era promo sets (dp / hgss / xy / sm / swsh / sv) — needs the year→era rule
- Vintage sourcing: 1990s baseball (Score/Fleer/etc.), Japanese Pokémon
  (593 keys / 65k rows) — no held source covers them
- Set-family rulings as annotation surfaces new pairs (bowman-chrome ≠ bowman
  stays inviolate)

## ACCEPTANCE (the definition of done)

- Ohtani: `hiq:baseball:2018:topps-chrome:150:refractor:no-auto` PSA 10 prices
  from its own pool (130 comps at last measure); the divergence digest stays
  quiet on it
- Hartman: exact sales anchor; $339-class outputs impossible
- Scorecard: checklist-confirmed + card-confirmed majority for baseball (met:
  89.1%); every `unconfirmed` row carries a named acquisition reason
- A sale, a holding, and a search all resolve to the SAME checklist-minted card
- `ingest-auto-seed` never grows again (count it; #1353 is the guard)
