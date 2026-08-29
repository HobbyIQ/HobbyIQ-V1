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
  sale 87.0%, holding 96.5%, search 47.5%, ALL THREE 43.0%**; **re-run #4
  (33262940112, 17:45Z, after the D3 landing + colour repair): sale 87.0%,
  holding 97.5%, search 49.5%, ALL THREE 45.0%** (26.0 → 37.0 → 43.0 → 45.0
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
  dispatch list, is the record). MODE=source retire dry run = 33262435380 — **NEAR MISS:** dispatched without
  `SOURCES` it fell to the script's `baseballcardpedia` default and reported
  retiring 13,142,137 rows across 1,927 products (the whole undated bcp
  source). Dry run, nothing written; #1455 makes MODE=source refuse to run
  without explicit SOURCES and gives the runner a `sources` input; scoped
  dry run #2 (`checklistcenter,checklistcenter-html`) = 33266850438: **428 products /
  1,201,383 rows** — the expected size. One more guard before the APPLY: the CLC
  re-ingest covered 510 of 547 products (21 converted empty, 16 no page), so
  retiring every old row would drop checklist coverage for the rest — #1458
  `REPLACED_BY` (default `checklistcenter-2026-08-29`; the runner's scope
  input doubles as it) retires only products present under the replacement
  source and lists the kept ones. Dry run #3 = 33267576465 → APPLY. Also seen in the same run: the bcp ladders re-ingest now
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
  **PR 5/6 building (worktree) against the Marconi fixture:** the $1,109.44
  was `autoPriceHolding` falling to `attemptSiblingPriceFallback`, whose
  CF-PARALLEL-PREMIUM-FLOOR (2026-07-06) applies a hardcoded "hobby-consensus"
  parallel multiplier when the empirical premium is missing — 8.00× here,
  "floor lifted from 1.00×" — keyed by a CardHedge id, persisted with
  `isEstimate: true` while three exact gold sales existed, and labelled
  `pricingSource: "unified-pricing"`. The build: retire the floor (a missing
  empirical premium is honest silence, the rule mapSiblingToRepriceFmv already
  applies to other grades); exact-pool supremacy at the persist site (an
  estimate is never written when EITHER of the holding's identity fields, or
  their numbered/un-numbered twin, has an exact sale); cross-setkey stays
  inside the product family and the player and respects the print run; the
  labels tell the truth (`sibling-estimate`, the fallback fmvRung).
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
  33262433937. **PR 5 ☑ #1436**: 26 dead writers deleted (−6,162 lines) plus
  the `catalog-sales-synth` workflow; runner whitelist 105 → 99 live scripts,
  `min_sales` input gone; writer census 112 → 87, hand-rolled minters 54 → 29.
  Held: the tiffany/product-line synthetic creators (ruling), the two
  `*-product-structure` importers (D3), and 13 transitively-dead sweep
  orchestrators / shell wrappers that spawn deleted files
  (`baseballAlmanacSweep`, `baseballCardPediaSweep`, `beckettFullSweep`,
  `checklistCenterSweep`, `cardsight-bulk/run-all-*`, `run-*-bulk-build.sh`,
  `run-*-tree-*.sh`, `run-pool-resume-after-crash.sh`) — follow-up delete;
  the Beckett/checklistcenter sweeps carry product-URL enumeration D3 may
  want first. The other guard (`everyWriteJobReconciles`) had ONE pre-existing
  red — `conform-holdings-to-catalog` wrote holdings without reconciling —
  #1437 wires reportWrites (#1438 fixes the require order #1437 put above the
  const it used; the smoke's FIRST line is the gate, not its exit code).
  **PR 4 ☑ #1443**: the eight allowlisted movers on catalogRowOps (−136 net;
  `fixVladBCP150Catalog` already deleted by PR 5); the helper gains a same-
  slug / different-partition REHOME (18/18 tests); writer guard 24 of 87
  compliant, hand-rolled minters 22. Flagged behaviour changes: `migrate-
  catalog-setkey` now MOVES (collision by authority) instead of create-if-
  absent — the 409 rule was the derived-beats-checklist defect; both reslug
  scripts skip graded rows (their generator yields the parent slug); rehome
  drops the read-back (the upsert ack is the verification); `dedupe-catalog-
  setkeys` loses its searchTokens union (defect #1). #1444: the reconciliation
  guard now counts `moveCatalogRow`/`retireCatalogRow` as writes (converted
  movers had dropped out of its population). **D5 remaining:** PR 7
  `approveVendorUnmatched` (NEEDS DREW); the 13 transitively-dead sweep
  orchestrators / shell wrappers (delete after D3 harvests their product-URL
  enumeration); keyless-partition shadows stay hand-addressed by design.
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
- ◐ D11 **Audit the whole app** (Drew, 2026-08-29 18:15Z: "maybe we should audit
  the whole app too?"). Yes — every defect today had one shape: a rule right in
  one place and absent in the next, or one number from two computations,
  invisible until a MEASUREMENT compared a surface's output to a ground truth
  (the checklist row, the listing title, the exact-identity pool). The audit is
  the same three questions asked of every surface, each answered by a
  read-only probe that prints a number: **IDENTITY** (does the surface resolve
  the hiq slug on a checklist row before it works?), **POOL** (does it price or
  list from the exact pool — title-, grade-, print-run-consistent?), **PRICE**
  (one computation, a truthful rung label, no floors or model multipliers,
  gates that admit exact pools and refuse fallbacks) — plus **WRITES** (only
  checklists mint; every write job reconciles; every fleet carries the budget
  marker + relaunch; whole-scope writes name their scope) and **CONTRACTS**
  (iOS ↔ API field population — `resolvedMarketValue` was a hidden consumer;
  the digest was silent because its gate read a field nothing wrote). Probes
  that exist: identity-triangulation (26 → 45% today), audit-all-holdings
  (14/92 clean), the writer + reconciliation guards (24/87, 25/50), the
  deploy's pricing smoke test. Gaps: the routes, the jobs, the iOS contracts.
  **Step 1 (in flight, read-only): the inventory** — every route, cron/runner
  writer, iOS consumer, ingest path and alert gate mapped to the questions and
  to the probe that would measure it, ranked by money-at-risk (`/price`,
  canonical-fmv, portfolio, DailyIQ, market movers, card-panel first). Step 2:
  build the top probes as one read-only `audit-app` family on the runner and
  keep their numbers here as the scorecard. Step 3: fix by doctrine, re-measure.
- ◐ D10 **Look at all holdings for everyone** (Drew, 2026-08-29 17:15Z). The three
  defects under holding `ca7a150b` are not specific to it. **#1448
  `audit-all-holdings`** (read-only, runner-whitelisted): per holding —
  IDENTITY (slug on a checklist row / an un-numbered twin of a numbered
  checklist row / an unbacked row / not in the catalog), POOL (rows under the
  slug whose titles name a different colour than the slug; print-run mix),
  PRICE (persisted FMV > 2x off the exact recent pool; a cross-identity rung) —
  one line per holding, then the roll-up. **First run (17:40Z): 92 holdings /
  12 users — 14 clean.** Identity: 22 with NO hiq slug (legacy CardHedge-id
  holdings, e.g. `1675907831540x…`), 15 on a catalog row that no longer exists
  (retired today or never minted: `2025:bowman-chrome:cpa-ws:blue-refractor`,
  `1992:undefined:232`, `1987:1987-bellingham-baseball:15`), 7 un-numbered
  TWINS of numbered checklist rows (Marconi /50, Caminiti /150, Antunez /499,
  Arias /250, Sirota /499, SPX Radiance /1000 …), 19 on unbacked rows
  (`user-verified`, `ingest-auto-seed`, `holding-seeded`). Pool: 6 contradict
  their slug (Griffey '97 Finest #238 "Base" holding bronze sales; a Black &
  White Red Ink row flagged by the colour heuristic — noise). Price: 27 persisted
  FMVs > 2x off their own exact pool and 11 priced by a cross-identity rung —
  the same Leo De Vries CPA-LD Blue holding priced $428 against an $869 pool
  for FOUR holdings across THREE users; Trout US175 $955 vs $405; Griffey '91
  Score #396 $281 vs $2.75; Ohtani '18 Bowman Chrome #1 $2,106 vs $8,195 (the
  first run compared against pools that included graded rows — #1451 makes it
  raw-vs-raw; re-run after the fixes). 6 have no price. **Fix chain, all
  users:** fold-unnumbered-twins APPLY → conform-holdings-to-catalog APPLY
  (52 unresolved = the acquisition/ruling list) → repair-parallel-from-title
  for the contradicting pools → `reprice-user-holdings` MODE=all (#1451 —
  every portfolio user; dispatch AFTER D9 and D4 PR 5/6 land so no floor
  price is re-persisted) → audit again.
- ◐ D9 **The eBay import → holdings pipeline** (Drew, 2026-08-29 17:20Z: "we
  need to fix the whole ebay import to holdings process, bc it seems broken").
  The Marconi purchase IS the fixture. Real listing title (`purchase.notes`):
  "2026 Bowman Marconi German Chrome Auto Gold Refractor 1st #/50 Nationals";
  Browse aspects: only `{Sport: Baseball}`; the checklist row
  `…:cpa-mg:gold-refractor:auto:num-50` existed. The import produced:
  `cardTitle` "2026 Bowman Chrome Refractor Marconi German" (Gold and /50
  dropped by a rebuild), `playerName` "Marconi German," (trailing comma),
  canonicalize called with an EMPTY card number and parallel "refractor"
  (`catalogMatchSlug: …:bowman-chrome::refractor:auto`, not-found), `cardId`
  from the suggester's Refractor card and `hobbyiqCardId`/`catalogVerifiedSlug`
  from a later rematch (two identities on one holding, neither the checklist
  row), a self-seeded un-numbered catalog twin (`ebay-user-purchase`, printRun
  null) with the sale under it. **And the $1,109.44 is explained:**
  `estimateBasis: "sibling: 1778814561816x… × 8.00× parallel (floor lifted from
  1.00×)"`, `isEstimate: true` — a sibling-rung estimate keyed by a CardHedge id
  with a model multiplier, while three exact gold sales existed; `pricingSource:
  "unified-pricing"` was a mislabel. Fix in a worktree (D9 agent): one parse
  (the listing title; #1433 composes Gold Refractor + /50), one match (card
  number + the title's finish + print run → the checklist row), one identity
  (cardId = hobbyiqCardId = catalogVerifiedSlug = soldCompSlug), no seed when a
  checklist row resolves, the sale under the resolved slug keyed by the eBay
  order id; fixture test first (red on main), then fixes. **☑ #1454 (deploy
  33266797637):** `cardTitle` from the RESOLVED identity (keeps Gold and /50;
  the listing title verbatim on `ebayListingTitle`); player/set/number/
  parallel through holdingFieldNormalizer; canonicalize never called with an
  empty number (`resolveCardNumberByPlayer`, internal catalog, unique-or-
  nothing) and always with the title's parallel + printRun + player;
  `cardId = hobbyiqCardId = catalogVerifiedSlug` pinned from the one match,
  `printRun` on the holding; no catalog mint when a checklist row resolves, a
  NUMBERED seed when none does; the sale keyed by the eBay ORDER id at
  SUBTOTAL ($182.50 — D7a's totalCost changed; shipping/tax stay in cost
  basis) shared by import / confirm / rematch; recordSoldComp supersedes the
  same id under another partition; the rematch passes printRun (a /50 card
  could only reach its row at fuzzy 0.72 before). 5-case fixture test (red on
  main → green), 4 mutation checks, 560 tests. The pricing call's sibling-×8
  path is D4 PR 5/6 (building). **Delivered on branch `fix/d9-ebay-import-one-identity`
  (unmerged; 3 commits, `tests/ebayImportOneIdentity.test.ts` red on main
  4/5, green after, 4 mutation checks, tsc 0):** `resolveImportIdentity`
  (ebayAutoHolding.service) is the one derivation — final fields through
  holdingFieldNormalizer; a title with no card number asks
  `resolveCardNumberByPlayer` (internal, unique-or-nothing); canonicalize
  gets number + the title's parallel + printRun + player, never an empty
  number; cardId = hobbyiqCardId = catalogVerifiedSlug from the one match
  (≥0.9); `printRun` travels on the holding; cardTitle is rebuilt from the
  RESOLVED identity (finish, #number, /N) and the listing title is kept on
  `ebayListingTitle`. The sale: `purchaseSaleIdentity` (order id, SUBTOTAL
  — $182.50, shipping stays in cost basis) is shared by import, confirm and
  the rematch route, which had three keys and two prices; recordSoldComp
  takes `printRun` (outranks the title regex) and supersedes the same id
  filed under another partition (the twin). Confirm's
  `verifiedSlugFor`: a verified number + a canonical pin → the pin is the
  verified slug. Not touched: the pricing call (D4 PR 5/6), the matcher.
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
  the base auto, the same seam as the gold. #1426 MODE=refractor. **Dry run ×8
  (17:40Z): each shard would repair ~25k rows — ≈203k total, 94% → Base, the
  rest to the finish the title names (Black, Mojo, Purple, Red, Blue, Yellow,
  Aqua …); 0 refinements, 0 failed.** #1453: a NAMED finish resolves through
  `canonicalize` before the slug is written (a bare "Black" would otherwise
  mint `:black:` where the checklist spells `black-refractor`). **APPLY ×8
  dispatched 18:05Z** (33266618162 … 33266636316) with the #1446 self-relaunch.
  **Reprice run (33263161323, 64 min, Drew's user): requested 45, repriced 37,
  skipped 8.** For the Marconi holding the engine COMPUTED the right answer —
  `our_pool_fallback_wired_from_reprice_hit … unified-market-value, compsUsed 3,
  fmv 182.5` — and the persisted $1,109.44 / isEstimate / floor basis SURVIVED
  (lastUpdated never moved): the persist path refuses an exact-pool price
  while keeping a floor estimate, and the pass pinned `cardId` (the wrong
  identity) before `hobbyiqCardId`. Handed to the D4 PR 5/6 builder as a
  fixture case. The same run logged `sibling_fallback_floor_only …
  floorMultiplier 3` for Theo Gillen CPA-TG — the floor being deleted. **Parser defect found on the way:**
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
  (or the next batch reprice) — no local write path. **Colour APPLY #2 landed:
  2,427 rows repaired, 2,427 verified carrying the stamp in Cosmos** (Silver
  504, Blue Refractor 273, Gold 169 → Base …). The holding's PERSISTED value
  was wrong the other way too: `fairMarketValue: 1,109.44`, method
  `cross-setkey`, 3 comps — against a purchase of $187.49 and a clean gold
  pool of $182.50 / $187.49 / $102.50 (no CPA-MG row anywhere prices above
  $187 except the 1/1 Superfractor at $2,500 and a Gold Ink /15 at $725; the
  cross-setkey rung crosses ANY setKey on year+number+parallel, and CPA-MG is
  a different player in 2025 — Beckett initials collide). Repriced through
  the sanctioned path `reprice-user-holdings` (runner; REPRICE_USER_ID is
  Drew's) after the #1432/#1433 deploy (`9f14942`) — result recorded below
  when it lands. Residual to measure later: a CH "Gold Shimmer /50" row still
  sits under gold-refractor — the title names a MORE specific finish than the
  stamp (the colour pass only looks at titles that lack the colour word); a
  "title is more specific than the stamp" pass with the #1433 parser is the
  next measurable repair. **Where the $1,109 came from — traced as far as
  the data allows:** the cross-setkey rung matches on year + number +
  isAuto + sport and the row's `parallel` FIELD, any setKey; for this card
  that is exactly three rows — the two real golds and a `2026:bowman:cpa-mg:
  gold-refractor:auto:num-75` Cardsight row ("TRUE GOLD Rookie Auto", the
  PAPER Bowman gold /75, $51) — i.e. it crossed the product boundary the
  ladder refuses AND a print-run boundary. The pure next-sale projection on
  those three still stays bounded ($234, bounds $168–$392), so the $1,109 is
  not that rung's math either; the reprice with the #1432 engine (running)
  is the answer that matters. **Identity gap underneath it:** the holding sits
  at `…:cpa-mg:gold-refractor:auto` — a USER-SEEDED catalog row
  (`ebay-user-purchase`, printRun null) — while the checklist row is
  `…:gold-refractor:auto:num-50` [checklist, printRun 50]; the un-numbered
  twin must fold into the numbered checklist row (sales re-pointed) and the
  holding must re-derive to it (a key needs both halves). A REPORT-ONLY
  `conform-holdings-to-catalog` (33263873824) **confirmed it does not**: 92
  holdings, 39 resolved exact, 2 corrected (Antonio Gomez BSPA-AG → sapphire),
  38 "already agreed" — the Marconi holding among them, because the exact
  un-numbered id EXISTS — and 52 unresolved (the acquisition/ruling list:
  1997 Fleer, 2005 Bowman Chrome Draft, set splits bowman-draft|bowman-chrome|
  sapphire, black-diamond rungs …). `merge-unambiguous-printrun` (2026-08-18)
  already applies the right rule to the POOL (one numbered variant → merge;
  two or more → leave alone) but never touched the catalog twin and is not
  runner-wired. **#1441 `fold-unnumbered-twins`** applies the same rule to the
  CATALOG through moveCatalogRow: a non-checklist un-numbered row with exactly
  one numbered checklist twin (and no un-numbered checklist row) folds into
  it — authority keeps the checklist row, sales re-pointed before the delete,
  graded children retired; ambiguous /N sets and checklist-source twins are
  left alone. Report-only run = 33264277457 → APPLY → conform-holdings APPLY
  (the holding re-derives to num-50 once the twin is gone) → reprice.
  Also noted: COUNT(source = checklistcenter-2026-08-29) is 1,714,619 against
  2,869,277 written — the authority contest keeps a higher-ranked existing
  source on rows the CLC ingest merged into, so a source count understates
  what an ingest touched ([[count-by-source-not-row-count]] cuts both ways). Also seen under the base sibling: "Yellow 21/75" filed as base
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

**Queued 2026-08-29 (newest first):**
- **Holding headline = fit-at-now market value (#1432).** portfolioStore's
  four chains used to read the +7d prediction first; the tile, hobbyIqFmv and
  the card page read `marketValue`. They now agree on marketValue. If you
  want the +7d read as the holding headline instead, say so — it is a
  one-line revert in portfolioStore, but then the tile and the card page must
  change too (one number, one computation).
- **Cross-setkey rung ("same year+number+parallel, ANY setKey")** — prices
  **9 of the 92 holdings today** (Verlander 2005 BDP129 at $64 vs $259 cost;
  the Marconi gold at $1,109 vs $187; Theo Gillen CPA-TG Blue at $697 …). It
  rescued fragmented ingest but it can cross to a different product's card
  with the same number in the same year. Ruling: keep it only within a
  product FAMILY (bowman ↔ bowman-chrome per the ladder) and require the
  playerName to match?
- **approveVendorUnmatched** (D5 PR 7): a vendor sale that failed to match
  becomes an identity row on one admin click, stamped `admin-approved`
  (authority 0). Refuse like #1362, or route through the merge so a
  checklist row always beats it?
- **Synthetic-parallel creators** `create-tiffany-cards-from-base` /
  `create-product-line-cards-from-base`: delete (no synthetic parallels —
  actuals only) or keep with a source stamp?
- **bcp-125 pairing:** sale and holding both say "2026 Bowman Chrome Prospects
  BCP-125" and land on `bowman-chrome:bcp-125` (not found); the checklist
  files BCP-125 under `bowman`. The family ladder is deliberately refused
  for bowman ↔ bowman-chrome. Is a BCP-prefixed number in the flagship year
  always the Bowman product?
- Pokémon promo-era rule; vintage sourcing (unchanged).

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
