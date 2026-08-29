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
- **Pokémon scorecard** (same measure as baseball): 17.8% → **36.1%** any-backing
  after the era fix + re-annotate (55,986 derived rows: card-confirmed 20,174,
  checklist-confirmed 47, unconfirmed 35,765 — 34,016 of them `ingest-auto-seed`)
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
- **A vendor search never mints a card either** (#1362): `persistVendorCatalog`
  — fire-and-forget behind every CardHedge search hit — had written 117
  `cardhedge::` rows at 09:53Z from the post-deploy cache warm. Refuses now
  regardless of `PERSIST_VENDOR_CATALOG_ENABLED`. Two gates, one doctrine:
  checklists mint, user-owned cards may seed, nothing else writes a card.
- **Relaunch discipline** (#1361): a self-relaunch fires iff the script printed
  its budget-stop line, never on cancel, and forwards slot/slots/mode/sports.
  Overnight the rematch relaunch had dropped its slot (11 copies of slot 0/16),
  the mapper/annotation/e2e chains looped on "did anything", and card_catalog
  took ~650k 429s per half hour.
- **Staging drained** by the one-pool emission (2026-08-29 morning):
  awaiting-catalog 669,820 → 84, player-precision 340,942 → 42, anomaly
  184,181 → 0, pending-manual 74,954 → 13; 1.46M player-less rows now sit in
  `needs-parse` for the promoter's parser. Sales Index 15.97M → 16.10M
  (66k of it from the emission; the parked sales were mostly already in the
  pool under another id).
- Internal holding resolver built (no vendor calls); dry-run: 31/92 resolved,
  12 corrections

## RUNNING (Drew's "do it", 2026-08-29 12:20Z — all four rulings taken)

1. ~~R5 rematch~~ **DONE 11:52Z** — 8 slots, 15,852,221 rows scanned,
   18,885 re-slugged (only-improve), 0 failed, 0 relaunches. Unplaced pool
   rows 17,104 → **11,598**.
2. ~~Holdings APPLY~~ **DONE 12:24Z** — 92 holdings, 38 resolved exact (≥.95)
   and written, 1 fuzzy left alone, 0 failed. Re-run after step 4 folds.
3. ~~RU rollback~~ **DONE 12:28Z** for sold_comps (100k → **10k**, its floor:
   Cosmos refuses below 10% of the highest max ever provisioned, so 8k is gone)
   and title_parse_cache (2,000 → 400). card_catalog stays 400k until step 4
   finishes, then 40k (its floor).
4. **"Clean the names"** — `clean-parallel-annotations` (#1367; bcp scraper
   + ingest note column #1368). Dry run on 4 slots in flight → APPLY → mapper
   redo (baseball) → re-annotate → scorecard v4 → holdings APPLY again.
   Acceptance: Ohtani `…:150:refractor:no-auto` is a checklist row,
   checklist-confirmed, its sale-minted twin gone.
5. **Retire unconfirmed sale-minted rows** — `retire-autoseed-window`
   MODE=unconfirmed (#1365/#1366): dry run in flight → APPLY. Card-confirmed
   sale-minted rows stay until step 4 folds them.

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

- **The mis-parsed 83,838 checklist rows** whose `parallel` column holds
  player-pair text or page prose ("Eric Davis (as) Andy Nezelek", "Topps
  Released A Mini Sized Factory Set (each Card Measuring 2", "Purple RayWave
  Refractor ("): a column-shift / prose-capture bug in the vintage converters
  (bccp, checklistcenter). Their own repair — re-scrape or retire; ruling
  needed on which.
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
