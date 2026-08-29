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

## EXECUTION CHECKLIST (Drew, 2026-08-29 13:00Z: "make a checklist and start executing")

Ordered; each item starts when the one above it lands. ☐ open · ◐ running · ☑ done.

**A. In flight**
- ◐ A1 `clean-parallel-annotations` APPLY, 4 slots (dry run: 402,289 rows — 242,194 move,
  44,194 fold, 8,233 replace a sale-minted twin, 23,127 heal, 0 failed)
- ◐ A2 `retire-autoseed-window` MODE=unconfirmed — dry run: **383,803** rows, 238,640
  with pointing sales, 0 failed → APPLY running on 8 slots (#1371 gave it shards +
  a budget-gated relaunch)

**B. Spine hygiene (before anything matches against it again)**
- ◐ B1 Retire the EXPLODED checklist products — the spine-wide scan: **140 products,
  11.49M rows, 51.8% of the spine** (10.0M from the old undated `baseballcardpedia`
  scrape, 1.3M checklistinsider): cards cross-joined with players — 2012 Topps has
  99,994 card numbers and "Adam Jones" as a parallel; 2025 Topps 162,763 numbers.
  They also inflate "card-confirmed" (any number, any player in the set matches), so
  the 89.2% scorecard was partly propped by them and will drop, then be re-earned.
  `retire-exploded-checklist-rows` (#1371) computes the list at run time (>150
  parallels or >2,000 card numbers per product+source; sizing fixed #1376). Dry run:
  **255 products / 13.2M rows** of the old `baseballcardpedia` source (95% of it —
  the whole scrape was a cross-join) → **APPLY running on 8 slots**. checklistinsider is only PARTLY exploded (real rungs on every
  card + a garbage tail), so it gets MODE=tail (#1375): retire a flagged product's
  (product, parallel) groups with < 5 rows or card-line parallels, keep the rest.
  Dry run: 510 flagged products, ~34.5k tail rows retired, 5.996M real rungs kept →
  **APPLY running on 4 slots**. The ingest now refuses such a file whole (#1373).
- ☐ B2 Retire the MIS-PARSED rows (83,838; 45,292 are 1990 Donruss, ~26k Leaf via
  checklistcenter) — `retire-exploded-checklist-rows` MODE=misparsed, after B1.
- ◐ B3 Unify `topps-allen-ginter` → `topps-allen-and-ginter` (checklist-majority
  form: 656k vs 71k checklist rows) via `rename-setkey` (#1372). Dry run: 191,521
  rows — 175,521 move, 15,958 fold, 0 failed → APPLY running on 4 slots.
- ◐ B4 Re-scrape the exploded / mis-parsed bcp products through the fixed parser
  (#1368) and the explosion gate (#1373): the e2e bcp phase now takes years /
  titles / phases from the runner (#1377); dispatched 13:18Z for 2005–2015 flagship
  + the 17 exploded non-flagship titles. Run 1 landed the 12 reachable titles
  (57,038 rows; A&G / Updates-and-Highlights titles 404) but NO flagship years —
  `--titles` had replaced the per-year list (#1380 fixes: titles add). Run 2
  dispatched 13:27Z for 2005–2015 flagship + A&G `%27s` title variants.
  FINDING: the ingest keys re-scraped products through `normalizeSetKey`, which
  collapses products into families (Topps Co-Signers → `topps`, UD Premier →
  `upper-deck`, every Donruss → `panini-donruss`) — sales do the same, so they
  match, but the identity is wrong. Vocabulary decision, listed under D.

**C. Rebuild passes on the clean spine**
- ☐ C1 `conform-card-profile` — displayName/searchTokens re-derived from the id for
  every moved row
- ☐ C2 `map-derived-parallels-to-rungs` MODE=redo — baseball, football, basketball,
  hockey, soccer (the sports that had annotated rows), 8 slots
- ☐ C3 **Full rematch** `reslugAllSoldComps`, 8 slots, all 16.1M (only-improve)
- ☐ C4 Re-annotate all sports (baseball 16 slots) → **scorecard v4**; acceptance:
  Ohtani `…:150:refractor:no-auto` is a checklist row, checklist-confirmed
- ☐ C5 `materialize-graded-identities` — re-mint the graded children the cleaning
  deleted
- ☐ C6 Rung-acquisition report v2 (card-confirmed-not-rung-confirmed by product)
- ☐ C7 Holdings APPLY again
- ☐ C8 card_catalog RU 400k → 40k (floor)

**D. Next builds**
- ◐ D1 `parse-player-from-checklist` (#1378) — BUILT. The 1,459,254 player-less
  sales all carry a slug; (sport, year, setKey, cardNumber) → the checklist's
  player(s) → the ONE in the title; exploded addresses skipped. 1/64 sample dry run
  running for precision; full run after B1 retires the explosion.
- ◐ D2 `identity-triangulation` (#1381) — BUILT: 200 checklist cards with sales ×
  (sale-shaped canonicalize, holding-shaped canonicalize, title search) vs the
  checklist id; baseline run in flight (before the spine passes), re-run after C.
- ☐ D3 checklistcenter → canonical CSV converter (it produced 27,662 annotated and
  ~26k mis-parsed rows; the old ingester raw-upserts and must not be rerun)
- ☐ D4 One valuation path — retire the Cardsight-era graded compiler onto the
  canonical engine (docs/pricing-obedience-audit.md)
- ☐ D5 Phase 07 — 58 writers bypassing upsertCatalogEntry
- ☐ D7 **eBay import into the portfolio** (Drew, 2026-08-29): an imported eBay
  purchase/sale matches to any existing `sold_comps` row so there are NO
  duplicates in the system; if it is not there, a new sale is created (through
  the one writer, source `ebay-user-purchase` / `ebay-user-sale`, keyed by
  the eBay item id + content hash), matched to a checklist card, and the
  portfolio holding is populated with that same card. These are REAL sales and
  are treated as such — first-class comps in the pool, never a second copy.
  Scoping now: map the existing path (ebayImportRematch routes, ebayAutoHolding,
  the CF-IMPORT async job) against those five requirements; fix the gaps.
- ☐ D6 **Identity key ≠ family key.** `normalizeSetKey` folds distinct products into
  a family (Co-Signers → topps, UD Premier → upper-deck, 1990 Donruss →
  panini-donruss) on both sales and checklists. Decide: identity key = the
  product, family key = a separate fallback field; then re-slug catalog + pool.

## NEEDS DREW (not code)

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
