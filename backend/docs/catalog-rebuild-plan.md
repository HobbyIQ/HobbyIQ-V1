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
- ℹ Fleet conclusions read "failure" on budget-stopped runs: the scripts exit 4
  at the budget marker and the "Run backfill" step goes red, but every
  self-relaunch step ran (checked per family: unconfirmed s1, exploded s1,
  clean s0, ginter s3 → relaunch step success). Ledger of every completed run
  since 12:40Z lives in the session scratch; A1 (clean) slot 2 finished in one
  window, slots 0/1/3 relaunched; A2 all 8 relaunched; B1 exploded all 8
  relaunched; B3 ginter slots 0–2 done, slot 3 relaunched; tail ×4 done
  (34,566 rows); B4 #3 wrote 6,065 rows.
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
  **Player-name rungs (the #1392/#1396 shape, spine-wide):** dry run #2 (4 slots,
  14:36Z) found 22 products carrying player-name parallels — 17 are roster
  explosions (2012 Topps 170, 2013 Topps 174, 2011 Topps 156, both A&G 131,
  2011 Heritage 71 …; slot 3 alone would retire 471,494 rows) and 5 are ONE
  mis-parsed row whose playerName is a real rung ("Die Cut" ×2, "Artist's
  Proof", "Triple Exposure", 2004 Bowman Chrome ×2) — retiring those would delete
  the real parallel. #1405: PLAYERRUNG_MIN=5 hits or the product is kept. **Dry run #3 (33258362517):
  17 products flagged, all roster explosions; the 5 singletons kept under the
  floor; slot 3 alone 471,018 rows.** APPLY ×4 dispatched 15:16Z (33259764716
  33259767774 33259771243 33259775326).
- ☐ B2 Retire the MIS-PARSED rows (83,838; 45,292 are 1990 Donruss, ~26k Leaf via
  checklistcenter) — `retire-exploded-checklist-rows` MODE=misparsed, after B1.
- ◐ B3 Unify `topps-allen-ginter` → `topps-allen-and-ginter` (checklist-majority
  form: 656k vs 71k checklist rows) via `rename-setkey` (#1372). Dry run: 191,521
  rows — 175,521 move, 15,958 fold, 0 failed → APPLY on 4 slots: slots 0–1 done
  (87,577 moved, 7,895 folded, 24,892 sales re-pointed, 0 failed), 2–3 running.
- ◐ B4 Re-scrape the exploded / mis-parsed bcp products through the fixed parser
  (#1368) and the explosion gate (#1373): the e2e bcp phase now takes years /
  titles / phases from the runner (#1377); dispatched 13:18Z for 2005–2015 flagship
  + the 17 exploded non-flagship titles. Run 2 (#1380) scraped 105 pages and
  ingested 480,754 rows for 2005–2015 — but older set pages list per-player SP
  rosters inside the Parallels section as bare list items, so 2008 Topps came back
  with 18 player-name "rungs" × 661 rows and 2010 Update with ~150. #1392 makes a
  player of the same product an impossible rung in the scraper, the ingest, and a
  new retire MODE=playerrung; run 3 re-scrapes 2005–2015 with the guard
  (mode=reingest). The first playerrung dry run caught its own false positives
  (the old cross-join put rung words in the player field too, so "Refractor" read
  as a player) — #1396 makes the oracle person names only (2–5 tokens, no parallel
  vocabulary) in the retire, the ingest gate, the scraper and the converter; dry
  run #2 in flight, nothing applied. Run 1 landed the 12 reachable titles
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
  player(s) → the ONE in the title; exploded addresses skipped. 1/64 samples:
  ~23k rows → ~4,700 parsed (20%), every printed parse correct; misses are honest
  (10k addresses with no checklist yet — the exploded spine and wrong-vocabulary
  keys; 4.6k whose ingest slug is the wrong sport/product; 2.8k `unknown` set).
  Designation tags (RC/AS/DP…) stripped (#1389). Full run after B1.
- ◐ D2 `identity-triangulation` (#1381) — BUILT: 200 checklist cards with sales ×
  (sale-shaped canonicalize, holding-shaped canonicalize, title search) vs the
  checklist id. Finding (ii) fixed: #1386 (live `2c65690`). Finding (i) fixed: #1398
  — scoring is a pure tested function; a row is no longer rewarded for set-key
  tokens or parallel words the query never said, and Base is preferred when the
  query says base or names no finish (4 tests reproduce the baseline misses).
  Harness re-run #1 (33257676925) died on a Cosmos 429 — `sold_comps` sits at its
  10k floor under the fleets and the harness had no retry; #1402 gives every read
  retry/backoff + SDK retry options. **Re-run #2 (33257941327, 14:40Z), same 200
  cards: sale 86.0% (flat), holding 90.5 → 96.5%, search 30.5 → 42.0%, ALL THREE
  26.0 → 37.0%.** Two of the three search misses "#BD-143 Base" → base-cards and
  "#TCA-ARU Base" → topps-chrome-black STILL reproduced on real rows while the
  #1398 tests passed on synthetic ones. Diagnosed read-only against prod: the
  number arm DID retrieve the right row (157 / 79 candidates, expected present)
  and scoreCatalogRow DID rank it first (2.006 vs 1.539); the post-scoring
  CF-SEARCH-PRODUCT-NARROWS step then dropped it — its vocabulary was
  ANCHOR_STOPWORDS, which carries "baseball" and "base", so the query demanded
  a set text containing the SPORT and the Beckett row (setName "Bowman Draft")
  went. #1410: narrowToNamedProduct is a pure exported function over
  PRODUCT_WORDS (brands + product lines only); 4 real-shape tests, mutation-
  checked (3 fail under the old vocabulary). **Re-run #3 (33259153271, 15:03Z):
  sale 87.0%, holding 96.5%, search 47.5%, ALL THREE 43.0%** (26.0 → 37.0 → 43.0
  across the day). Live: `b5274b4`. Finding (iii) measured: the pool's sport
  TAG never disagrees with the slug's sport (0 of 16M across 6×6 sport pairs) —
  the tag is derived from the same place as the slug, so wrong-product sales
  can only be found from the TITLE ("Score 🏈", "Upper Deck ... Rookies Jersey",
  "UEFA"); a title-based measurement is queued for after the fleets drain.
  Remaining shapes in the 63 misses: (iv) sale/holding both land on
  `bowman-chrome:bcp-125` [not-found] for a `bowman:bcp-125` checklist card —
  the family ladder (bowman-chrome → bowman) is not walked on a miss (D6);
  (iii) wrong-product pool sales still present (a Score football title under
  baseball bowman:53, UD hockey under topps-pristine:114, UEFA under
  topps-chrome:2) — needs a pool-wide wrong-sport measurement, only-improve
  cannot fix a wrong product. **BASELINE (before the spine passes), baseball ≥2016, 200 cards:
  sale → same card 86.0%, holding → 90.5%, search → 30.5%, ALL THREE 26.0%.**
  Findings, each its own fix: (i) SEARCH ranks a rarer parallel row above the
  base row the title names ("#217 X-Fractor" → platinum-anniversary refractor;
  "#BD-143 Base" → base-cards) and bleeds across products ("#TCA-ARU" → chrome-black
  cba-mr) — search scoring must weight exact number + set and honour "Base";
  (ii) HOLDING path leaks the product name's year/sport into the set key
  ("2024 Panini Prospect Edition Baseball" → `2024-panini-prospect-edition-baseball`,
  not found) — strip leading year/season and trailing sport before normalizeSetKey;
  (iii) some POOL sales sit under the wrong product entirely (a 2025 Score football
  title under a baseball Bowman slug; an Upper Deck hockey title under
  topps-pristine) — measure wrong-product matches pool-wide; only-improve cannot
  fix a wrong product. Re-run after C.
- ◐ D3 checklistcenter → canonical CSV converter — SHIPPED #1395 (acquire +
  convert + e2e phase `clc` + retire MODE=source; old ingesters refuse to run;
  smoke test 6 products / 48,437 rows / 0 refused); dry run over 2020–2026 in
  flight → APPLY → MODE=source retire of the old `checklistcenter*` rows AFTER the
  clean rows land. Scoped 13:50Z: 547 product URLs
  **Dry run #1 (33257173424, 14:36Z): 531 pages fetched (351 xlsx, 180 html-only,
  0 failed), 500 products converted (279 xlsx / 221 html), 3,198,710 CSV rows →
  3,194,074 catalog rows would land; 36 products REFUSED** by the >150-rung /
  >2,000-number explosion gate (2025 Topps Series 1: 514 rungs; 2024 A&G: 2,115
  numbers; 2025 Panini Flawless 152 rungs at the ingest). Right guard, wrong scope:
  a CLC xlsx lands each insert set's ladder on that set's OWN cards — the rung
  count grows with the insert sets and says nothing about a cross-join, which
  still puts 600 "rungs" inside ONE category. #1405 scopes the gate per subset
  (converter) / per category (ingest); a category over the line is dropped and
  the rest of the file lands. **Dry run #2 (33258360806) replayed dry run #1's refusals**:
  the cached CSV directory skipped the converter, so the per-subset gate never
  ran — #1407: pages are cached, CSVs rebuild from them every run. It also ran
  as SHARD 0/16 (the runner's slots default) — dispatch with slots=1.
  **Dry run #3 (33258751353) crashed the converter** (ReferenceError: #1405 had
  removed the report-only sets the return line read; `node --check` is syntax,
  not a smoke test) — #1411, smoke-run locally on 3 products (19,371 rows;
  the html-only 2018 Donruss Optic page converted to 0 rows — look at html
  card-list parsing after the xlsx-backed products land). **Dry run #4
  (33259229904): 510 products converted (311 xlsx / 199 html), 4,255,085 rows,
  7 subsets refused — among them the BASE subsets of 2025 Topps Series 1 (359
  "rungs" on a 350-card set), Series 2 (280) and 2026 Bowman (171).** Pulled
  the three locally: the converter was building the cross-join ITSELF — every
  xlsx line is already one (card, finish) pair, and the converter pooled a
  section's finishes into one ladder and multiplied it onto every card of the
  section ("Team Card Holo Foil" on Trout #1; base #1 got "Chrome Prospects
  Gold Refractor", BCP-1 got "Gold Pattern Refractor"). 2023 Leaf Metal's 200
  base "rungs", by contrast, are 200 REAL Leaf parallels — a count gate cannot
  judge a manufacturer-published xlsx. #1413: the xlsx path emits one row per
  line (nothing multiplied, no count gate), strips the per-card type qualifier
  ("Future Stars", "Chrome Prospects", "Paper Prospects") when most of the
  card's finishes extend it, and reads auto from the finish ("Auto Silver
  Prismatic" → Silver Prismatic, isAuto). Local: Series 1 base 126,000 → 22,235
  rows; 2026 Bowman base 80,324 → 18,381; Leaf 12,866 auto rows marked. Known
  residue: the two-word section heuristic truncates insert category slugs
  ("insert:under-the", "insert:chrome-prospect") — informational, not identity.
  **Dry run #5 (33259741463): 510 products, 2,879,911 rows → 2,869,277 would
  land, no converter refusals, one 1,395-row category (2023 Leaf Eclectic
  [insert:leaf-metal], 154 rungs) caught by the ingest gate.** APPLY ×8
  dispatched 15:20Z. **LANDED 16:05Z: 2,869,277 rows under
  `checklistcenter-2026-08-29`, exactly the dry run's number** (shards 0–7:
  351,828 / 405,031 / 334,792 / 353,739 / 351,022 / 359,362 / 309,888 /
  403,615). Shards 3 and 4 exited non-zero AFTER writing: gate-dropped rows
  (card-line, player-name, exploded category) were not declared to
  reportWrites, so it called 2,065 / 6,434 rows "vanished" — #1430 declares
  them. The runner ids I recorded for the D3 fleet were partly fleet
  relaunch children created in the same seconds (the ledger, not the
  dispatch list, is the record). MODE=source retire dry run = 33262435380. Also seen in the same run: the bcp ladders re-ingest now
  skips 762,534 player-name-parallel rows (#1396 working as built).
  cached at c:/tmp/clc (ladders only, no card lists → bounded 547-page re-fetch);
  the old HTML ingester split ladders on commas (player names became rungs) and
  swallowed multi-ladder paragraphs; converter = scrape-checklistcenter-products +
  convertChecklistCenterToChecklistCsv (bcp rung guards, `;`-only split, setKey from
  the URL slug, never normalizeSetKey) + e2e phase `clc` + MODE=source retire of the
  old rows AFTER the clean re-ingest. ~590 lines, 5 files.
- ◐ D4 One valuation path — retire the Cardsight-era graded compiler onto the
  canonical engine (docs/pricing-obedience-audit.md). **Scoped 2026-08-29 (agent
  read of every consumer):** the graded compiler is inert in prod (its flag is
  off), and the digest was SILENT — its gate read `pricingMeta.method`, which
  nothing writes; fixed #1400 (fmvMethod derived from `pricingSource ===
  "unified-pricing"`; the gate also accepts a basis note starting `unified:`),
  and #1401 re-pinned the three digest tests that had been red since #1342.
  Plan, 7 PRs, in order: (1) rung label — name the tier that priced a holding;
  (2) digest gate = #1400 ☑; (3) route slugs — every pricing route resolves the
  hiq slug before pricing; (4) ONE grade curve, and an iOS field-population
  contract: `resolvedMarketValue` is a computed chain in
  `HobbyIQ/CompIQCardGrades.swift:184-190` (trendAdjustedValue → value →
  weightedMedianPrice → plainMedianPrice), so the curve entry must pin which
  fields each valueSource populates (`tests/gradeCurveEntryFieldPopulation.test.ts`);
  (5) adapter for the legacy shape; (6) retire the Cardsight seam; (7) delete
  `gradedPriceProjection`. **PR 1 ☑ #1419** (`fmvRung.ts`: closed FmvRungLabel
  union, `rungLabel` written by unifiedPricing / canonicalFmv /
  observedGradeCurve / priceFromOurPool; `PortfolioHolding.fmvRung` at every
  fairMarketValue write site with nulls on legacy paths; the digest gate reads
  fmvRung first — a cross-grade-fallback price no longer digests even with a
  `unified:` basis note). **PR 3 ☑ #1418** (slugFromParsedQuery for /search and
  /price; /price-by-id passes originalHiqSlug ?? a partition-scoped vendor-id
  lookup). Findings from the build, each its own PR: (a) the `/price`
  canonical-first template passes `parsed.brand` as setKey — "2017 Topps
  Chrome" slugs to `:topps:`, a LIVE mis-identity; (b) raw holdings never take
  the unified early exit (`computeUnifiedPrice` fills the top-level price only
  when `opts.grade.company` is set, and portfolioStore passes `grade: null`);
  (c) `pricingSource` has the staleness hazard fmvRung now guards against
  (batch legacy writes never reset it). **PR 4 ☑ #1432 — ONE grade curve:**
  `gradeCurveEntry.ts` is the adapter + contract (trendAdjustedValue =
  marketValue, never null on a unified tier; `value` carries the same
  projection so a median can no longer hide in iOS's fallback slot; medians
  diagnostic; predictedPricePct null on the weighted-median rung); CF-RAW-IS-A-
  TIER — `grade: null` now prices the Raw tier (raw holdings NEVER took the
  unified path before); the tree enricher (the last writer on
  /observed-grade-curve) is deleted and unified-only tiers (PSA 1–7, CSG/HGA)
  appended; the four portfolioStore headline chains now read `marketValue ??
  predictedPrice ?? fmv` — the tile / card-page number — instead of the +7d
  read. **Visible:** holdings' headline FMV moves from the +7d prediction to
  the fit-at-now market value; the iOS LAST SALE cell reads `entry.value`
  first and will show the market value until iOS decodes `newestSalePrice`
  (already on the wire). 860/860 tests, 3 mutation checks. Left for PR 5/6:
  `canonicalFmv.buildGradeLadder` is still a SECOND curve rendered by iOS
  (GradeLadderSection); `treeGradeCurve.service.ts` now uncalled; the
  service's estimate passes and monotonic clamps still write entry fields.
- ◐ D5 Phase 07 — the catalog writers. **Scoped 2026-08-29 (agent replicated the
  guard test's walk, read-only): 68 files match the guard, 5 are false positives
  (they write `sold_comps`), 2 of the 3 "canonical" passes are COMMENT matches —
  the honest number is 60 real `card_catalog` writers, 1 compliant
  (`ensureCatalogRow`).** The guard misses `.item().patch/replace/delete` (37 more
  mutators, every `retire-*` script). Classes: (c) LIVE MINTERS — 4 in src;
  (d) live patchers — 15 runner scripts (safe, cannot mint); (b) row movers — 7
  new + 8 allowlisted, one shape copied 15 times (6 of 7 drop `searchTokens` on a
  setKey move, 5 of 7 never retire graded children, none union `vendorIds`, 5 do
  no authority check); (a) dead — 20 files, ~4,000 lines (vendor enumerators dead
  by #1362, sales seeders dead by #1353, superseded ingesters, one-shot fixes).
  **PR 6 ☑ #1403/#1404: the two hash-id runtime minters are gone** —
  `ebayAutoHolding` wrote `ebay-browse:<sha>` rows from eBay item-specifics on
  every enriched import (a vendor feed), `ebayReviewQueue` wrote a duplicate
  `user-verified:<sha>` row beside the canonical seed path; neither id was a slug,
  so no reader could find them. Guard test `noHashIdCatalogMinters.test.ts`.
  **PR 8 ☑ #1408**: `checklistDiff` (admin pasted-checklist add) builds through
  deriveCatalogEntry/upsertCatalogEntry with authoritativeSetKey; #1409 drops
  the three converted files from the guard's debt list. PR 1 (guard rewrite)
  **PR 2 ☑ #1417**: `catalogRowOps.service.ts` — `moveCatalogRow` /
  `retireCatalogRow` / `rebuildSearchFields` / `isGradedChildOf`; authority
  decides collisions, vendorIds union, sales re-pointed before the delete,
  15 tests (4 mutation-checked). **Hazard it found:** the census pattern
  `STARTSWITH(c.id, id + ":") AND IS_DEFINED(c.gradeTier)` also matches the
  NUMBERED sibling's graded children (`…:no-auto:num-50:psa-10` starts with
  `…:no-auto:`) — every existing mover (including the clean-parallel-annotations
  and rename-setkey fleets that ran today) deletes them. Recoverable: the
  C-chain's materialize-graded-identities regenerates graded rows; PR 3 moves
  the fleets onto isGradedChildOf. Also: src `buildSearchTokens` lacks the
  searcher-view/ASCII-fold passes its CJS twin has (O'Neal, Agüero) — port
  those ~25 lines.
  **PR 1 ☑ #1414**: the guard measures honestly (112 writers, 9 canonical, 41
  mutators now visible, 5 false positives gone, red-capable); it surfaced two
  more hand-rolled minters — `seedCardCatalog.ts` and
  `cardsight-bulk/phase-a-crawl-cards.cjs` — both for PR 5 (delete).
  **PR 3 ☑ #1431**: the seven movers go through `moveCatalogRow` (−326/+176;
  MOVERS self-emptied in the guard; map-derived's double-counted reconciliation
  fixed; a setKey field/id-segment disagreement now fails loudly; provenance
  unified to movedFrom/movedReason/movedAt). The running clean-parallel-
  annotations / rename-setkey relaunch children pick this code up at their
  next relaunch (`--ref main`), so REPORT-ONLY validation runs were
  dispatched first: clean slot 0/4 = 33262432618, rename slot 3/4 =
  33262433937. Next: PR 7 (approveVendorUnmatched — NEEDS DREW), PR 4
  (8 allowlisted movers), PR 5 (delete class (a): workflows reference
  catalog-sales-synth.yml, tcdbBatchFill in catalog-gap-digest.yml, and 6
  backfill-runner whitelist entries — remove those with the files).
  Remaining, smallest first: PR 1 fix the guard (import-match, not text-match;
  extend WRITES to patch/replace/delete; pair TOUCHES+WRITES to one container
  var); PR 8 `checklistDiff` onto deriveCatalogEntry/upsertCatalogEntry; PR 2
  `catalogRowOps.service.ts` (moveCatalogRow / retireCatalogRow: id fields,
  parallelSlug/playerSlug/cardYear re-derived, searchTokens/searchText/displayName
  rebuilt, authorityRank collision, vendorIds union, sales re-pointed, graded
  children retired, copy-before-delete) + tests; PR 3 convert the 7 rogue movers
  (guard goes green); PR 7 `approveVendorUnmatched` — NEEDS DREW: a vendor sale
  that failed to match becomes an identity row on one admin click, stamped
  `admin-approved` (authority rank 0) — refuse like #1362, or route through the
  merge so it loses to a checklist row; PR 4 convert the 8 allowlisted movers;
  PR 5 delete class (a) — HOLD `create-tiffany-cards-from-base` /
  `create-product-line-cards-from-base` (synthetic parallels; Drew ruling) and the
  two `*-product-structure` importers (D3 may consume).
- ◐ D8 **The title outranks the vendor tag** (Drew, 2026-08-29 15:25Z, holding
  `ca7a150b` — 2026 Bowman Chrome CPA-MG Marconi German Gold Refractor /50:
  "Bases are tagged to this gold or the gold is tagged to bases"). Read-only
  diagnosis: under the gold slug 38 of the 40 latest rows were CardHedge base
  autos at $5–12 whose titles never said gold, stamped `parallel: Gold` because
  `persistVendorSalesToPool` let `identity.parallel` (the vendor PRODUCT tag:
  CH's variant, TCA's structured hint) overwrite the title parse, and the
  long-form rule then folded `:gold:` into `:gold-refractor:`. The holding
  priced off a $10 pool. **Exact pool-wide counts** (title never says the
  stamped colour word): CH Gold 226 / Gold Refractor 7 / Blue 161 / Blue
  Refractor 467 / Black 132 / Silver 551 / Green 105 / Purple 73 / Red 66; TCA
  colour refractors 1–3% each (Gold Refractor 299); Cardsight 5–30%. A separate
  **"Refractor" bucket** — CH 163,272 / TCA 37,854 / Cardsight 14,422 rows
  stamped Refractor whose title never says it — is CH's variant against our
  own composed "… #CPA-ZC Base" suffix and cannot be judged from the title:
  **NEEDS DREW** (is CH's Bowman Chrome auto "Refractor" variant the base auto
  or the /499 refractor?). Fixes: **#1420/#1421** — `parallelTheTitleAllows()`,
  a pure tested rule at the seam: a sale's parallel is what its title says; a
  vendor tag can neither add a finish the title lacks nor replace one it
  names; disagreements counted (`vendorParallelOverruled`). **#1416/#1422** —
  `repair-parallel-from-title` (colours only): dry run #1 scanned 4,842 rows,
  would repair 3,998 (1,755 → Base, 2,243 → the finish the title names) — but
  199 "Blue Refractor → Refractor" / 196 "Gold Refractor → Refractor" were
  titles saying "Refractor /150" with the colour omitted: a REFINEMENT, not a
  contradiction (moving them would mint `refractor:num-150`, a rung no
  checklist has) — #1422 keeps those (#1424 the bare-colour short form: "Blue"
  IS "Blue Refractor"); dry run #2: 2,535 → APPLY. **The first "APPLY" wrote
  nothing** — the runner exports BACKFILL_APPLY, not APPLY (#1427; memory
  [[runner-exports-backfill-apply]]); APPLY #2 = 33261692593, verify by the
  Cosmos count of `reslugedReason`, not the log. **Refractor bucket settled by
  price** (read-only): under 2025 Bowman Chrome CPA-EP `:refractor:auto`, CH
  rows whose title never says "refractor" sell at a $60.95 median (n=695); the
  ones that say it, $140 (n=67); the true base pool, $47 — a silent title is
  the base auto, the same seam as the gold. #1426 MODE=refractor; dry run ×8
  (33261514583…33261533112) → APPLY ×8. **Parser defect found on the way:**
  `ebayTitleParser` names ONE token from a flat list with "refractor" ahead of
  the colours, so "Gold Refractor 1st #/50" parses as bare "Refractor" and
  captures no print run — #1428 makes the seam adopt a vendor tag that
  REFINES the title's finish (else a real Gold Refractor sale would have lost
  its gold under title-wins); **#1433 fixes the parser itself** — a typed
  finish vocabulary, modifiers kept in the title's order ("Reptilian Green
  Refractor"), Sapphire only with a colour, Printing Plate colour-last,
  team/product colour words blanked ("Blue Jays", "Topps Chrome Black"),
  `printRun` captured (#/50, 14/50, numbered to 50, 1/1; grade fractions
  protected; seasons rejected). Finding: the ingest seam parses with
  `parseListingIdentity` (a separate 1,735-line parser that already
  composes), so the seam's refinement rule (#1428) is defence; the consumers
  of #1433 are the repair script, ebayImportRematch and ebayAutoHolding. Also shipped alongside: #1425 `/price`
  canonical-first slugs the PRODUCT (parsed.set ?? parsed.brand), not the
  brand. **Re-pricing the holding:** the app's own `POST /holdings/:id/refresh`
  (or the next batch reprice) — no local write path; Drew can tap refresh on
  the card once the pool is clean. Also seen under the base sibling: "Yellow 21/75" filed as base
  (the numbered-refractor inference is a parser gap), and CH composed titles
  "2026 2026 Bowman …" (doubled year).
- ☐ D7 **eBay import into the portfolio** (Drew, 2026-08-29): an imported eBay
  purchase/sale matches to any existing `sold_comps` row so there are NO
  duplicates in the system; if it is not there, a new sale is created (through
  the one writer, source `ebay-user-purchase` / `ebay-user-sale`, keyed by
  the eBay item id + content hash), matched to a checklist card, and the
  portfolio holding is populated with that same card. These are REAL sales and
  are treated as such — first-class comps in the pool, never a second copy.
  MAPPED 2026-08-29 13:45Z — what the code does today, against the five requirements:
  - the import (`POST /api/portfolio/erp/purchases/import/ebay` → ebayBuyerHistory →
    ebayAutoHolding) creates the HOLDING and pins the checklist slug, but **never
    writes the sale** — the purchase enters sold_comps only if the user later
    confirms it, or a suggester/rematch happens to fire;
  - the eBay item id / order-line-item id are stored on the purchase entry only,
    **never on the holding**, so 4 of 5 comp paths key the pool row by
    `holding::<id>` — dedupe by eBay id is impossible there; the sell path passes
    no id at all (clients never send `ebayOrderId`);
  - the rematch route and the suggester file comps under **CardHedge vendor ids**
    (via a CardHedge search — a vendor call in matching) while the confirm path uses
    the `hiq:` slug: holding and sale routinely carry different identifiers;
  - a dedupe hit returns `{written:true}` like a write and no id, so nothing links
    the holding to its sale; the canonical-scoring gives a `holding::` key +50 so a
    collision DELETES the row that carried the real eBay id.
  Fix plan, in order: **D7a** the import writes the sale through recordSoldComp with
  the real eBay ids (order line item id, item id) and the holding's checklist slug;
  recordSoldComp returns {written, id, deduped}; the holding stamps ebayItemId /
  ebayOrderId / soldCompId. **D7b** every user-comp path keys by the eBay id (sell
  path falls back to the holding's id server-side); real-id rows outrank
  `holding::` rows. **D7c** the rematch resolves through canonicalize (internal), never
  CardHedge, and files under the slug; the suggester stops emitting comps. **D7d**
  the writer's catalog reconcile for user sources no longer depends on
  CATALOG_MATCH_ONLY_ENABLED.
  **Status 14:00Z:** D7a shipped (#1388, live `3c15787`) — the writer returns
  {id, deduped, hobbyiqCardId}; real eBay ids outrank `holding::` keys; the
  import stamps ebayItemId/ebayOrderId on the holding and writes the purchase to
  the pool at import, keyed by the order line item id, under the holding's slug;
  the sell path falls back to the holding's ids. D7c shipped (#1390, deploy next)
  — the rematch resolves through canonicalize (no CardHedge), supersedes the old
  pool row when the slug moves, and the suggester no longer writes sales.
  D7b + D7d shipped (#1393, deploying): backfill stamps the eBay ids onto existing
  holdings from their purchase entry (dry run: 92 holdings, 70 stamp, 22 have no linked
  purchase, 0 failed → APPLY running); user-owned sales reconcile against the catalog
  regardless of CATALOG_MATCH_ONLY_ENABLED. Backfill APPLIED: 70 holdings stamped,
  6 docs written, 0 failed. **D7 complete in code and data** (live via the 14:07Z
  deploy); the double-import check is the remaining acceptance test.
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
