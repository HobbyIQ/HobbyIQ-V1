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
  source and lists the kept ones. **Dry run #3 (33267576465): 516 products in
  the replacement source; retiring 356 of 428 old products (1,096,192 of
  1,201,444 rows); KEPT 72 products / 105,249 rows the re-ingest does not
  cover** (2024 Leaf Metal 8,435; 2018 Bowman 7,115; 2020 Bowman 5,441; 2018
  Bowman Draft 5,387; 2018/2019 Stadium Club; 2026 Leaf; 2018 Donruss Optic …
  — the html-only pages that converted to 0 rows; an acquisition list for the
  CLC converter's html path). #1460: the retire's self-relaunch forwards
  `sources` + `scope` (a child without them would FATAL on #1455's guard).
  **APPLY ×8 dispatched 18:25Z** (33268119635 … 33268143439) — **CANCELLED
  20:05Z** after three shards had deleted ~30k of the 1,096,118 old-CLC rows
  (retired=15,014 / 10,005 / 5,005; the other five were still scanning).
  Why: Drew's picker for 2025 Bowman Draft CPA-MWI showed no Gold, and the
  read-only look found the new spine does not carry the Bowman colour ladder
  at all — **checklistcenter-2026-08-29 has 18.6 parallels per card for 2025
  Bowman Draft (only refractor / red refractor / superfractor of the plain
  ladder) and 5.4 per card for 2025 Bowman Chrome, while 2025 Topps Chrome
  converts with the full ladder (19.3 per card)**; for CPA-MWI the new source
  has 13 rows (Wave / Lava / Gumball / Peanuts / plates) and no Gold Refractor
  /50, Purple /250, Blue /150, Green /99 or Orange /25 — those live only under
  bcp today. The #1458 replaced-by guard is PRODUCT-level (the product exists
  under the replacement source) and says nothing about per-card coverage, so
  any source retire can delete rows the replacement never re-minted. Two
  follow-ups: (1) **D3b** (building, `feat/d3b`): the CLC converter expands
  section-level parallel ladders per card (Bowman pages state the ladder once
  per section; the per-line path only emits parallels that appear as their own
  rows), fixture-tested on CPA-MWI, then `MODE=reingest`; (2) the retire's
  guard becomes per-(cardNumber, parallel, printRun) coverage — a product is
  retired only when the replacement covers ≥ 95% of its old keys, and the
  uncovered keys are listed; a read-only old-vs-new coverage measurement over
  the 60 largest old-CLC products landed 21:40Z: **the new source covers
  126,390 of 551,845 old keys = 23%.** 2025 topps-chrome old 15,157 rows →
  new 6,895 (20% — my earlier "Topps Chrome converts fine" counted OLD rows
  under the `checklistcenter*` prefix); 2025 bowman-draft 8,591 → 3,658 (0%);
  2026 donruss 13,778 → 2,431 (5%); 2025 panini-prizm 9,694 → 1,599 (6%);
  2025 topps-finest 5,462 → 5,155 rows yet 0% keys; 2025 panini-select 9,892 →
  10,015 rows yet 0% keys (old names carry glued subset prefixes — "set
  concourse …", "prizms …", "auto crystal …", "paper …" — so exact keys
  understate coverage; the raw row counts are the honest signal); 2024
  leaf-metal, 2018 bowman, 2020 bowman → new has nothing. So the D3
  re-ingest's 2,869,277 rows sit mostly in a few Leaf/Series products and the
  flagship Topps/Bowman/Panini conversions are thin across the board — the
  converter drops most of each product's ladders, not only Bowman's. D3b's
  scope widened accordingly (Topps Chrome + Prizm pages in the diagnosis and
  fixtures; `audit-source-coverage.cjs` as a runner probe with exact AND
  prefix-normalized keys; the MODE=source guard becomes per-product coverage
  ≥ 95%, kept products printed with their number). **The old-CLC retire stays
  cancelled until a re-ingest passes that gate.** The cancelled runs printed
  no budget marker, so nothing relaunched.
  **CORRECTION (D3b, #1472, 22:50Z): the converter never dropped the ladder.**
  The 2025 Bowman Draft workbook lists all 26 rungs for CPA-MWI and the xlsx
  path emits all 26. The root cause is `upsertCatalogEntry`'s tie-break in
  `cardCatalog.service.ts`: `entry.confidence > existing.confidence` is
  `0.95 > undefined` = false, so every old-label row at the SAME id (old
  checklistcenter, bcp, beckett — none carry a confidence) kept its old
  source label and the re-ingest was a no-op on it (2,090 old rows in that
  product carry the re-ingest's `lastSeenAt`). The 13 "missing" rungs exist
  at the same ids under other labels; the 23% key coverage above IS this
  mislabeling. Had the retire run to completion it would have deleted the
  re-attested rows themselves. Fix: missing confidence = 0, the incoming
  winner keeps the replaced row's image/sale-counts/move-history, the ingest
  prints `kept the existing row N`; converter html-path gaps fixed on the
  side (label families reach their rungs, `SuperFractor 1/1` → /1,
  parenthesised odds no longer shred into rungs, 14 doubled-sport URLs);
  `audit-source-coverage.cjs` (exact + normalised keys; leaf-vivid 51% → 100%
  normalised) and the retire's per-product ≥ 95% floor shipped. **Order:**
  deploy (33274840453) → re-ingest `MODE=reingest PHASES=clc` (report-only
  shard 0/8 dispatched 22:55Z, 33274846587, to read the `kept` counters)
  → APPLY ×8 → `audit-source-coverage` → retire with the floor. **Dry shard
  0/8 (33274846587) ran the whole CLC phase: 547 products fetched (html
  547, xlsx 351), the html path now expands section ladders (2018 Bowman:
  27 rungs × 706 numbers = 7,084 ladder rows; 2020 Bowman 28 × 734), shard 0
  read 491,013 csv rows and would write 489,042, explosion gate refused 0 —
  so the whole set is ≈3.9M rows (2.87M before the ladder fix). APPLY ×8
  dispatched 00:05Z (relaunch children follow the marker).** **Shard 5
  finished first (01:05Z, within budget, reconciled):** the runner's cached
  workdir holds every staged source, so `MODE=reingest` re-upserts all five
  — that is the fix reaching them all: checklistcenter-2026-08-29 313,906
  written / 48,401 kept-by-higher-authority (before #1472 every one of
  these would have been "kept"); bcp-ladders 151,262 / 36,238 kept; beckett
  65,309 / 54,969 kept; checklistinsider 559,400 / 529,490 kept (the spine
  already holds those ids); tcgdex 1,003 / 1,003 kept; explosion gate
  refused 0 everywhere. When all eight shards land → `audit-source-coverage`
  (old checklistcenter/-html vs checklistcenter-2026-08-29, exact +
  normalised keys) → retire only products ≥ 95%. **All eight shards landed by
  02:15Z**, every one reconciled (CLC phase per shard 313k–416k written /
  30k–104k kept-by-authority; the gate refused one cross-join insert, 2023
  Leaf Eclectic "leaf-metal" 154 parallels × 25 numbers, and one 2016 Topps
  "double-play-rip-cards" 920 parallels × 1 number). `audit-source-coverage`
  (33278726520, 02:50Z): **406 old-CLC products / 820,174 rows remain (the
  fixed tie-break already relabelled ~300k of the 1.1M); 349 products are
  BELOW the 95% floor and stay; ~57 clear it** — every Leaf product at
  100% normalised (the old rows' glued subset prefixes), Topps Chrome 2023,
  Chrome Sapphire, Fire, Tribute, Finest, Rip, Tier One, Diamond Icons,
  Gilded, 206, Pro Debut, Black & White, Panini Immaculate, 2024 Select … The
  below-floor shape is specific: Topps flagship (Series 1/2/Update 2020–2025)
  uncovered keys are plain `base` rows and foil parallels, Donruss/Prizm
  uncovered keys are the Panini ladders (artist proof /25, carolina blue
  laser /249 …) — the html converter still misses those two page shapes →
  **D3c** (queued behind D17 — one builder at a time). Retire dry run with the floor dispatched 03:05Z (MODE=source, SOURCES old CLC, scope new CLC)
  — **verdict (33279788445): retiring 57 of 408 products (133,471 of 820,174
  rows), KEPT 351 products / 686,703 rows under the floor; every sale
  re-pointable (sales-unplaced 0).** The APPLY ×8 dispatch was BLOCKED by the
  auto-mode classifier (a delete fleet) — Drew runs it or allows the pattern:
  `gh workflow run backfill-runner.yml -f script=retire-exploded-checklist-rows
  -f apply=true -f mode=source -f sources=checklistcenter,checklistcenter-html
  -f scope=checklistcenter-2026-08-29 -f slot=N -f slots=8`, N = 0…7. Also seen in the same run: the bcp ladders re-ingest now
  skips 762,534 player-name-parallel rows (#1396 working as built).
  **D3b (2026-08-29 ~22:00Z, `feat/d3b`): the ladder was never lost — the LABEL was.**
  The brief: CLC lacks Bowman's plain colour ladder (2025 Bowman Draft CPA-MWI: 13 rows,
  no Gold Refractor /50, Purple /250, Blue /150 …; 18.6 parallels/card vs bcp's 54).
  Measured: the 2025 Bowman Draft WORKBOOK lists all 26 rungs for CPA-MWI and the xlsx
  path emits all 26 (12,531 rows, 15.8 parallels/card over 787 cards — bcp's 54/card is
  the exploded cross-join, "BDC 1 Eli Willit" is one of its "parallels", not a target).
  Cosmos holds the 13 "missing" rungs under OTHER labels at the SAME id: Refractor /499,
  Black /10, Red /5, SuperFractor under `beckett-checklist`; Blue /150 under
  `baseballcardpedia`; Red Lava, Black X-Fractor under `checklistinsider-2026-08-27`;
  2,090 old `checklistcenter` rows with lastSeenAt 15:31Z — touched by the re-ingest.
  ROOT CAUSE `cardCatalog.service.ts` upsertCatalogEntry: the class tie-break
  `entry.confidence > existing.confidence` is `0.95 > undefined` → false. Every old
  checklistcenter / baseballcardpedia / beckett-checklist row carries NO confidence
  field, so it won the tie and kept its label; the re-ingest's 2,869,277 "written" rows
  were largely no-op upserts (lastSeenAt only). The key-coverage read (new source covers
  23% of the 60 largest old products' keys; 2025 bowman-draft 0%) is this mechanism, not
  a converter gap; the brief's 12,249 "CLC" rows were 8,591 old + 3,658 new.
  FIX, five commits: (1) `mergeCatalogEntries` (exported, tested directly —
  theCleanestOneWins.test.ts had pinned a COPY of the rule): missing confidence = 0, an
  exact tie still keeps the existing row; an incoming winner now carries the replaced
  row's image / sale counts / move history (`PRESERVED_ON_REPLACE`) and drops
  name-derived fields (displayName, searchText, checklistBacking). (2) ingest prints
  `of which kept the existing row N` as a slice of written (a null upsert return is
  failed, not written). (3) converter html path — the REAL gaps, all page text: a ladder
  label's finish family reaches its rungs ("Refractor Parallels: Gold" → Gold Refractor;
  Prizm / Wave / Lava / RayWave / Geometric / Ice / Flash; an insert-set label like "Prime
  Number Parallels" appends nothing); "SuperFractor 1/1" → run 1 (was "SuperFractor 1",
  no run); ';' inside parentheses no longer splits (Topps Chrome's odds became rungs
  "1:1 Jumbo"); the 14 doubled-sport URLs (`2020-bowman-baseball-baseball`) no longer land
  under `bowman-baseball` / `leaf-metal-baseball`; xlsx: Select's "- Gold Prizms"
  separator. Every product prints sections / laddersFound / ladderRows; `--report`
  writes nothing. Fixtures are trimmed real pages + workbook rows
  (tests/fixtures/clc, tests/clcConverterSectionLadder.test.ts: Bowman Draft, Topps
  Chrome control, Select, Prizm). (4) `audit-source-coverage` (runner-whitelisted,
  read-only): per old product, keys the replacement covers — exact and normalised
  (glued subset prefix / auto / prizm(s) / (rc) stripped, colour + finish words never) —
  uncovered keys, a TOTAL line, `min_coverage_pct` flagging. (5) retire MODE=source:
  the REPLACED_BY presence guard → per-product coverage ≥ MIN_COVERAGE_PCT (runner input,
  default 95) from the SAME lib (`scripts/lib/sourceCoverage.cjs`); under the floor the
  product is KEPT and printed with its coverage. Local html-path parallels/card after:
  2025 bowman-draft 12.6 (bare colours → long form; xlsx path unchanged at 15.8),
  bowman-chrome 12.7, topps-chrome 17.3 (odds fragments gone), panini-prizm 17.9,
  panini-select 13.6, 2020 bowman 10.4, 2018 bowman draft 10.0.
  ORDER: merge → dispatch "Daily 5AM ET Refresh & Deploy" (src change) → HOLD the
  MODE=source retire: if the 18:25Z APPLY ×8 fleet is still running it is deleting rows
  the re-ingest re-attested — cancel by script identity, re-measure → re-ingest
  `ingest-checklists-end-to-end` MODE=reingest PHASES=clc slots=8 on main (the merge fix
  relabels the re-attested rows; the `kept the existing row` line should be small) →
  `audit-source-coverage` sources=checklistcenter,checklistcenter-html
  scope=checklistcenter-2026-08-29 → only then MODE=source retire with the floor.
  RESIDUE: an html variation section ("Base Image Variation Set") emits a blank-parallel
  row that shares the base card's id; Panini naming differs by path (html "Blue Prizm",
  xlsx "Prizms Blue" / "Blue Prizms") — the normalised key absorbs it, the slug does not.
  **D3c — the two page shapes (2026-08-30, `feat/d3c`): the converter never dropped
  them; the LABEL was never going to carry them.** The brief read the audit's uncovered
  keys (2024 Topps Series 1 `33|base|`, `33|rainbow foil|`; 2025 Donruss `53|artist proof
  /25`, `carolina blue laser /249`) as rows the converter drops. Measured on the real
  pages: both products convert on the xlsx path and the runner's own log (33274846587)
  emits 2024 Topps Series 1 = 20,043 rows (Base + all 37 foil/holiday finishes on 370
  cards) and 2025 Donruss = 17,722 (Base 1–100 + Rated Prospects 101–200 × 68 finishes);
  shards 2–7 each print `rows not reached 0` for the CLC phase. The rows are in Cosmos —
  at their CANONICAL ids, under someone else's label. Two mechanisms: (1) the ingest
  mints ids through `computeHobbyIqCardId`, which collapses the setKey (`topps-series-1`
  → `topps`, `donruss` → `panini-donruss`, `leaf-vivid` → `leaf`, `BCP-` → `bowman-
  chrome`), so the old raw-upserted row `hiq:baseball:2024:topps-series-1:33:base:no-auto`
  and the re-ingested `hiq:baseball:2024:topps:33:base:no-auto` are two documents and the
  new write never replaces the old; (2) at the canonical id an EARLIER checklist source
  already sits at equal authority and confidence — bcp ladders are ingested before CLC in
  the same job, insider/beckett landed 08-27 — and `mergeCatalogEntries` keeps the
  existing row on an exact tie (`cardCatalog.service.ts:255`, "kept the existing row"
  30k–104k per shard). Point reads: `…:2024:topps:33:base:no-auto` = baseballcardpedia-
  ladders-2026-08-29; `…:33:rainbow-foil` / `gold:num-2024` / `vintage-stock:num-99` /
  `royal-blue` = bcp-ladders-2026-08-28; `…:2025:panini-donruss:53:artist-proof:no-auto:
  num-25`, `101:base`, `101:artist-proof-black:num-1` = checklistinsider-2026-08-27;
  `…:2025:leaf:1:base:no-auto` = beckett-checklist-2026-08-27 under setKey
  leaf-spectacular (the Leaf id collapse conflates products — the vocabulary decision,
  not fixed here). The audit's held set was `c.source = @new` only
  (`lib/sourceCoverage.cjs:66`, D3b) — every kept key counted as uncovered, hence 349/406.
  FIX 1, `scripts/lib/sourceCoverage.cjs` (audit + retire share it): coverage is measured
  on IDENTITY — the old row's canonical id (isAuto either way) held by any
  checklist-authority source that is not being retired (`COVER_BY=replacement` restores
  the label-only reading); the held rows come from one `STARTSWITH(c.id, 'hiq:sport:year:
  canonKey:')` query per canonical prefix (cached, 6 deep). The text normalisation gained
  what the old rows actually look like: blank ≡ Base; a card-TYPE label the old ingester
  glued onto a numbered range ("Rated Prospects …", "Rookie and Veteran Retail Autographs
  …" — bare, unnumbered, no finish word, the card has no plain row, ≥3 extensions) is
  strippable, shortest strip first ("rated prospects optic gold" meets "optic gold" before
  "gold"; "Optic" on card 53 is NOT a type because 53 has a plain row, so Optic Gold /10
  never reads as Gold /10); a bare colour meets its long form (`TRC-1|green|10` = Green
  Refractor /10, the colour = refractor ruling); a null run meets the checklist's numbered
  plain card (`HSHA-BW|base|` = Base /25); a parallel filed in subsetName with "Base" as
  the parallel is that parallel ("Bowman Sterling Aqua Refractor" / Base /125 — misfiled,
  not fabricated); "Subset Key: FS=Future Stars" legend rows (1,050 on 2020 Series 1) leave
  the denominator and are counted. Every line prints who holds the keys.
  FIX 2, the converter, on real gaps the diagnosis found on the way (all page text):
  html `clean()` read "Red #/25 or Less" as "Red #/25" with NO run — the "or less" strip
  ran after the run parse (2020 S1 auto sets ×26; 2021/2022 Donruss "Career Stat Line
  #/500 or less" ×262 each, "Gold #/25 or less", "Pink Fireworks #/199"; 2021 Prizm "Blue
  #/149" ×100); xlsx `sectionSplit` took the first TWO words as the section, so a
  three-word section with no parallels became a parallel of its own first two words
  ("Challenge Code" ×30, "Topps Baseball" ×25 on 2024 S1; "Recollection Collection" ×23 —
  in Cosmos today; "Image Variation" ×335 on 2025 Update — Golden Mirror Image Variation
  collapsed onto the base card's id), a lone "Autographs" stayed as a parallel (×78/×36),
  "Autographs Prizms Gold" listed without its plain row became a type and Gold Vinyl lost
  its Gold ("Vinyl" ×190 on 2022 Prizm DP), Leaf's Base/Auto marker stayed in the finish
  ("Talent Base Crystal Black", "Base Laser Black" — 15,576 Leaf Vivid identities; Leaf
  Metal "Tritanium Prismatic White" → "White", 15,348), Bowman mega autos read "Mega
  Autographs Chrome Gold Mojo Refractor" (1,248). Now: a "Base …" value belongs to Base;
  the shortest plain Set value that word-prefixes a value heads it; a value others extend
  heads its own section (a head ending in a colour needs ≥2 under it: "Black Gold"
  yes, "Autographs Prizms Gold" no); siblings under the same two words share their
  common words less trailing finish words ("Tritanium", "1991 Gold Leaf Prospects" keeps
  its Gold; Relic/Relics twins split); a lone "… Variation(s)" whose numbers are base
  numbers is a Base finish; a lone value with a finish tail keeps it ("Mega Futures" +
  "Chrome Mojo"). Row counts per product are UNCHANGED (18 cached products: 308,531 rows
  before and after; 2025 Leaf Vivid 40,552 → 40,552, 100% coverage before and after);
  only names moved. Tests: `tests/clcConverterPageShapes.test.ts` (trimmed real
  workbooks/page: 2024 Topps Series 1, 2025 Donruss, 2025 Update, Leaf Vivid control, Leaf
  Metal, 2026 Bowman, 2022 Prizm DP, 2020 Series 1 html) + `tests/sourceCoverageIdentity.
  test.ts` (stub slug + fake container: kept-under-another-label, blank ≡ Base, type
  label, the Optic guard, colour ≡ refractor, legend, COVER_BY both ways).
  NUMBERS (local, old Cosmos keys vs the converted CSV, identity-based): 2024
  topps-series-1 **100%** (exact 99.6; was 52%), 2025 topps-update-series **99.1** (21),
  2022 update 100 (37), 2020 series-1 100 (45), 2023 chrome-platinum-anniversary 100 (12),
  2025 donruss **100** (2), 2024 donruss 100 (4), 2026 donruss 100 (8), 2025 panini-prizm
  100 (6), 2022 prizm-draft-picks 100 (6), 2026 bowman 100 (84), 2026 leaf-metal 100 (94),
  2025 leaf-vivid 100 (100, the control) — 131,789 keys, 99.9% (the residue is 108
  2025-Update plain insert rows whose card number the workbook lists under a different
  prefix). The 2025 Prizm residue of 391 old rows is 87 "Base /N" artifacts covered via
  their subsetName. Donruss inserts numbered 1..N without a prefix (Bomb Squad #1, Diamond
  Kings #1, Coming Attractions #1) collapse onto one id per number+parallel — pre-existing,
  the id carries no subset; noted, not fixed.
  ORDER: merge (scripts + tests only; no `backend/src`, no deploy) → re-ingest
  `ingest-checklists-end-to-end` `MODE=reingest PHASES=clc` slots=8 on main (renamed
  identities mint their ids; the misnamed rows the D3 re-ingest wrote under
  checklistcenter-2026-08-29 — "Talent Base Crystal Black", "Recollection Collection",
  "Challenge Code" … — are NOT touched by it and need a staleness retire of that label:
  follow-up) → `audit-source-coverage` `OLD_SOURCES=checklistcenter,checklistcenter-html`
  (default `COVER_BY=any-checklist`; read the "covered keys held by" line — the retire
  deletes old rows whose identity bcp / insider / beckett hold at the canonical id, i.e.
  duplicates at non-canonical ids; Drew decides whether that is the reading he wants
  before APPLY) → `retire-exploded-checklist-rows MODE=source SOURCES=checklistcenter,
  checklistcenter-html MIN_COVERAGE_PCT=95` dry run → APPLY.
  cached at c:/tmp/clc (ladders only, no card lists → bounded 547-page re-fetch);
  the old HTML ingester split ladders on commas (player names became rungs) and
  swallowed multi-ladder paragraphs; converter = scrape-checklistcenter-products +
  convertChecklistCenterToChecklistCsv (bcp rung guards, `;`-only split, setKey from
  the URL slug, never normalizeSetKey) + e2e phase `clc` + MODE=source retire of the
  old rows AFTER the clean re-ingest. ~590 lines, 5 files.
  **Merged #1497 (07:00Z 08-30).** The third time tonight the converter was
  not the gap: `computeHobbyIqCardId` collapses the setKey (`topps-series-1`
  → `topps`, `donruss` → `panini-donruss`, `leaf-vivid` → `leaf`), the
  rows exist at those canonical ids under bcp-ladders / checklistinsider
  labels, and the OLD CLC rows sit at non-canonical ids; the audit counted
  `c.source = @new` only. Identity-based coverage (any non-retired checklist
  source holding the canonical id) puts the 18 worst products at 99.9%.
  Re-ingest #2 ×8 with the fixed converter dispatched 07:00Z (33282281037 …
  33282311099). **NEEDS DREW (below): with identity-based coverage the
  MODE=source retire deletes old-CLC rows at NON-canonical ids whose identity
  another checklist source holds at the canonical id — duplicates by
  doctrine (one identity per card), sales re-pointed; say go.** Follow-up: the
  misnamed rows the first re-ingest wrote under `checklistcenter-2026-08-29`
  ("Talent Base Crystal Black", "Recollection Collection" …) need a staleness
  retire of that label (rows not touched by re-ingest #2).
  **One-of-one APPLY, first shards (07:05Z):** slot 0 repaired 28,277 (moved
  25,325, folded 2,200, replaced 746; graded children 9,899), slot 6 repaired
  27,874; ~2,900 refusals per shard are the setKey-field drift
  (`bowman`/`bowmans-best`, `upper-deck`/`upper-deck-series-1`,
  `topps-heritage`/`-high-number`) — the card-profile APPLY running now
  fixes the field, a second one-of-one pass picks them up; reconciled.
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
  **PR 5 (branch `fix/d4-pr5-sibling-estimate-obeys-doctrine`, 3 commits)
  — the sibling estimate seam obeys the doctrine.** Fixture: holding
  `ca7a150b`, three exact raw sales under `hobbyiqCardId`, `cardId` a
  different card, $1,109.44 = sibling × 8.00× FLOOR persisted as FMV;
  the same run's log computed the exact pool (our-pool, `unified-market-
  value`, n=3, $182.50) and filed it "estimated" because priceFromOurPool
  did not know the method. (1/3) The parallel-premium floor is gone:
  `PRINT_RUN_TO_FLOOR` (1/1 100× … /500 1.5×, ×1.8 non-auto),
  `applyPrintRunFloor`, `floorForPrintRun[ByClass]` deleted; the ONE
  multiplier source is `empiricalParallelPremium.ts` (the calibration
  table's measurement, n ≥ 5); the sibling seam returns null without a
  measurement, drops the Base-card × 10× cross-class bridge, and derives
  PSA 10 via getGraderPremium instead of × 8; compiqEstimate's three floor
  projections and Tier 6 refuse a numbered parallel with no measurement.
  (2/3) `cross-setkey` stays inside the product family
  (`productFamilyKey`: first two segments; bowman ↔ bowman-chrome and
  sapphire refused) and the PLAYER (folded), print run never
  contradicting; no known player → the rung is refused (`crossSetKeyRule.
  ts`). (3/3) `exactPoolSupremacy.ts`: every estimate write in
  portfolioStore (six reprice sites + autoPriceHolding's surface) asks
  the gate — an identity of the holding (hobbyiqCardId FIRST, cardId,
  their numbered/un-numbered twins) with ≥ 1 sale in 180d blocks the
  estimate; the exact pool prices it (unified engine, hobbyiqCardId ALONE
  before any cardId union, ≥ 1 sample) or a stale estimate is withheld
  and cleared; the estimate is telemetry. priceFromOurPool classifies an
  exact-pool rung as observed. Labels: `sibling-estimate` (fmvRung,
  pricingSource, meta.method), every unified write stamps
  `pricingSourceMeta { method: rungLabel }`, the final surface says
  `unified-pricing` when unified was the authority. Tests:
  `siblingEstimateNeverOutranksExactPool.test.ts` (39; the fixture end to
  end through /reprice/batch), 6 mutation checks. **Left for PR 6:** the
  `finalChosen` chain in autoPriceHolding's final-authority block still
  reads `predictedPrice ?? marketValue ?? fmv` (the +7d read first —
  CF-ONE-GRADE-CURVE reversed that everywhere else); the sibling site
  still writes its estimate INTO `fairMarketValue` (the rail's firewall
  keeps estimates in `estimatedValue`) — both pre-existing, left as-is.
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
  **First-pass findings (three of the inventory's slices landed 18:20–18:35Z;
  the consolidated matrix is still assembling):**
  - *Import / eBay / misc (group C):* user SALES from the eBay order poll are
    written into the pool keyed by the holding's vendor `cardId`
    (`portfolioStore:7324`), and so are user PURCHASES (`:2491`); the spreadsheet
    import's resolver is a Wave-3b stub returning nothing (every non-round-trip
    row "unresolved", round-trip ids taken verbatim, no `hobbyiqCardId`, no
    pricing after commit, dedup skipped for null ids); the suggester can hand
    back a CardHedge id as `suggestedCardId`; `createListing` publishes to eBay
    without linking the listing to the holding (its sale can never be
    matched); the listing composer prices `predictedPrice` ahead of FMV; the
    flat wire shape carries NO rung/provenance (only the nested `pricing`
    envelope, and that drops to null unless three fields agree), while
    `quickSaleValue/premiumValue/suggestedListPrice` and the buy/hold/sell zones
    are hardcoded multipliers (0.85 / 1.15 / 1.05 / 0.9). → **D12-a** (SHIPPED on
    `feat/d12a`, 8 commits, 2026-08-29 — paragraph below) + **D12-b** (building, `feat/d12b`: the import resolves through
    the catalog, round-trip ids must be existing hiq slugs, one identity, price
    on commit).
  - *Pricing engines (group A):* `withDerivedSlug` MINTS an hiq slug from free
    text with no catalog read and OVERWRITES any existing slug, and
    `priceFromOurPool` prices off it; `addHolding` adopts a 0.72 fuzzy match as
    both ids when nothing is pinned, `updateHolding` writes `hobbyiqCardId`
    ungated; a fifth headline chain (`:3805`) still reads `predictedPrice`
    first; `computeUnifiedPrice` unions vendor-id and slug rows with no
    print-run/parallel/title filter; `getGraderPremium`'s lower rungs are still
    hardcoded tables (PSA 8 → 1.0; static GRADER_PREMIUMS; canonicalFmv's
    gradeTierMultiplier table); the sibling fallback's ×8 / ÷8 PSA-10 constants
    and `parallelPremiumFloors` (/1 → 100×, /50 → 8× …) — PR 5/6 in flight;
    `hobbyIqFmv` returns a method string not in its own union. → D12-a shipped
    the identity items (below); the multiplier tables are D4 PR 6.
  - **D12-a SHIPPED** (`feat/d12a`, 8 commits, 2026-08-29; backend/src changed —
    dispatch "Daily 5AM ET Refresh & Deploy" after merge). §1 every user
    sale / purchase emit (order poll, manual sell, Add Card purchase) keys its
    sold_comps row by `poolIdentityForHolding(h)` — the pinned hiq slug or
    nothing: no identity → withheld + `user_comp_withheld_no_identity`; the
    vendor id rides as `vendorCardId` metadata; the purchase uses D9's
    `purchaseSaleIdentity()` key so the import row and the Add Card row are
    one row. §2 `withDerivedSlug` is gone: `fillDerivedSlugFromCatalog` fills
    only an ABSENT slug and only when `catalogSlugIfExists` (point read at
    (slug, slug), un-numbered twin aware, fails closed) holds it; the catalog
    resolve runs BEFORE the fill on add and update; `priceFromOurPool` never
    derives at price time and prices only a catalog-row slug (else null +
    `our_pool_slug_not_in_catalog`). §3 one gate (0.9) pins both fields on
    add and update; below it the match is the existing proposal
    (`catalogMatchSlug` … → the wire's `proposedIdentity` → /accept-identity),
    NOT `cardStatus: pending-review` (written in exactly one place); a
    body-supplied `hobbyiqCardId` is accepted only when it names a catalog row
    (`hobbyiqCardIdSource: "pinned"`, else `holding_slug_rejected_not_in_catalog`).
    §4 the fifth (and a sixth) headline chain read `marketValue ??
    predictedPrice ?? fmv`, pinned line-wise over portfolioStore (8 chains).
    §5 `createListing` links the holding itself on every publish
    (`result.linked`). §6 the suggester's `cardId` is hiq-only — `idKind`,
    `candidate.vendorCardId`, `SuggestBatchSummary.vendorIdDropped`. §7 the
    composer lists FMV before predictedPrice. §8 `querySoldComps` throws
    `SoldCompsQueryError`; the vendor source propagates; the resolver reports
    `sourceErrors` and does not cache a null reached through one. Each item
    has a test that fails under the old code (`tests/d12a.*.test.ts`) and a
    mutation check. **Left for a follow-up:** the wire shape's read-time
    `deriveHoldingSlug` fallback (responseAssembly `composeHoldingWireShape`)
    still mints a display slug for legacy holdings; `resolveCard` callers do
    not yet read `sourceErrors`; a body-supplied `cardId` that is an hiq slug
    is not catalog-gated (only `hobbyiqCardId` is); `querySoldComps`'s cardId
    filter passes ledger entries that carry no cardId (none do).
  - *Analysis surfaces (group B):* none of the 15 analysis services touch a
    pricing engine or an hiq slug — grade-worthy, timing forecast, parallel
    ladder, missing parallels, sub-raw discovery price from `ch_daily_sales`
    medians/means over (player, year, number) with every grade and parallel
    mixed; `gradedMedianPrice` is a MEAN; the parallel ladder has no card-number
    filter; missing-parallels compares CardHedge ids to Cardsight ids; four
    different grading-cost constants (80 / 79.99 / 60 / 50); `createIfNotExists`
    DDL runs on GET routes; the `/breakdown` analyzer reads `year`/`cost`/
    `status` fields the wire shape never emits (vintage logic dead, ROI 0,
    sold holdings counted); the yearbook applies a clamped portfolio
    multiplier as a sold-value proxy; player-trend partitions key on the raw
    name while ids are slugged. → probes + fixes queued after D12.
  - *Alerts, digests, pushes (group D, 20:15Z):* the **cascade push is a
    structural no-op** — `cascade-detect.yml` never passes the APNs env, so the
    provider is null, every push no-ops, `pushSent:0`, green nightly (iOS DOES
    write `pushOnCascade`); the cost-basis digest's exact-pool writers on the
    batch path sit behind `PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED` (prod:
    true — verified read-only) and its send result is discarded three times
    over with a hardcoded recipient and no env override; DailyIQ marks the day
    "notified" at zero sends; watchlist-digest and grade-worthy scan zero users
    because nothing in iOS writes `pushOnWatchlistDigest`/`pushOnGradeWorthy`;
    the four admin notify crons gate on HTTP 200 only; nightly-cleanliness is
    structurally incapable of going red and auto-applies four unreconciled
    writers; three Azure alerts read a retired Cardsight metric; the freshness
    canary cannot tell the firehose from the webhook trickle (the 08-03 outage
    shape); `cardsight-pricing-nightly` still calls the retired vendor's API on
    a cron; verdict-flip is a permanent dry-run scaffold on a cron. → **D13**
    (building, `feat/d13`): the APNs env for cascade, delivery-checked digest
    with an `OPS_ALERT_EMAIL` override, DailyIQ marks only when a push was
    attempted, notify workflows assert `pushProviderConfigured` + print counts,
    cleanliness/publish workflows exit non-zero on nothing, Cardsight + verdict
    crons removed, a row-count axis on the freshness canary. **Merged #1471
    (22:45Z)**: 30 files; measured tca-ebay 9,280–114,513 rows/day (floor
    2,300; raise toward 25,000 once a firehose-era week is confirmed — Drew);
    the retired Cardsight was still writing 0–3 rows/day. **D12-a merged
    #1473 (22:53Z)**: user comps pool under the hiq slug or are withheld
    (`user_comp_withheld_no_identity`), `fillDerivedSlugFromCatalog`
    replaces `withDerivedSlug` (fill-only, catalog-backed, fails closed), one
    0.9 gate pins both ids on add/update (below it → proposal fields, not the
    literal pending-review status — judgment call flagged), fifth + sixth
    headline chains fixed, listings link their holding, the suggester emits
    hiq ids only, composer FMV-first, `querySoldComps` throws instead of
    failing open. Deploy 33274840453 carries D13 + D3b + D12-a — **live
    23:20Z, health serves `1714a06`.** **D12-b merged #1475 (23:15Z)**: the
    spreadsheet import resolves through the catalog (`importResolver.ts` +
    the shared `identityFromFields.ts` lifted out of the eBay import; a
    round-trip `hiq:` slug is identity only if the catalog holds it; one
    identity written and re-checked at the persist site; priced on commit
    through the add-card path; collisions keyed by the resolved slug, a
    title-tuple key for unresolved rows; `hobbyiqCardId` exported as the
    round-trip anchor). Two bugs found on the way: SheetJS typed a Serial
    cell `/50` as the Excel date serial 18264 before any parser saw it
    (`raw: true`), and the preview cap read `req.user.tier` (never existed)
    so every preview projected against the free cap. Deploy #2
    33275053457 carries it — **live 23:35Z, health serves `162e769`.**
    `feat/d12a`) + **D12-b** (**delivered on branch `feat/d12b`, unmerged — 7
    commits, tsc 0, the six import suites + the D9 eBay fixture green, a
    mutation check per commit**). The import resolves through the catalog:
    `importResolver.ts` point-reads a round-trip `hiq:` slug (an identity only
    when the catalog holds it; a vendor id or a slug we do not hold is a HINT
    on the envelope, `identityHint`, never persisted), otherwise resolves the
    row's fields through holdingFieldNormalizer + the ONE derivation the eBay
    import runs — `identityFromFields.ts`, lifted out of
    `ebayAutoHolding.resolveImportIdentity` so both imports run one rule
    (never an empty card number; number-by-player; the matcher asked with the
    parallel + print run + player; the 0.9 bar) — with source `import`, which
    never seeds. The print run is split out of the serial ("/50", "12/50") or
    the parallel ("Gold Refractor /50"); the sport comes from a Sport /
    Category column, the product, or a 4-sport probe (one confident answer
    or `ambiguous`). A match BELOW the bar stays `unresolved` (no new bucket —
    iOS keys its rendering on the five) with the suggestion on `resolution`;
    committed anyway it is written with NO identity, `needsReview` + the
    reason, the suggestion parked on `catalogMatchSlug` (the wire's
    `proposedIdentity`) for accept-identity, which adopts AND prices it.
    Commit writes ONE identity — `cardId = hobbyiqCardId =
    catalogVerifiedSlug`, printRun, confidence / matchedBy, identityVerified
    for exact / round-trip — after re-checking the slug at the persist site
    (canonical AND still in the catalog: a row retired between preview and
    commit is refused, not a 16th D10 orphan), then prices every holding it
    added with an identity through `repriceOneHolding` → `autoPriceHolding`,
    the add-card path with #1462's exact-pool gate inside: inline up to 5,
    above that a `kind: "pricing"` import-job the client polls. No identity,
    no price. The collision key is the resolved slug (+ grade / serial), and a
    row with no slug is keyed by its title tuple — the old "no cardId → no
    collision check possible" had let the entire unresolved population (every
    arbitrary-sheet row, with the resolver stubbed) bypass dedup; two
    identical rows in one file collide too. The export writes `hobbyiqCardId`
    and the import treats it as the round-trip anchor. Two more defects found
    on the way and fixed in their own commits: SheetJS's CSV reader turned a
    Serial cell "/50" into 18264 (Excel's 1950-01-01) before any column
    parser saw it (`raw: true`); the preview projected every user against
    the free cap because it read `req.user.tier`, a field AuthUser never had
    (it now reads effectivePlanFor + config/entitlements, the table commit
    reads). Contract notes for iOS: envelope fields `resolution` /
    `identityHint`, `pricing` on the commit result and `kind: "pricing"` job
    docs are all additive; the `sport` column is import-only. Deploy: after
    merge, dispatch "Daily 5AM ET Refresh & Deploy" (backend/src) and verify
    the health sha.
  - **D13 — alert gates prove delivery** (built on `feat/d13`, 8 commits,
    2026-08-29 ~21:00Z; tsc 0; every item pinned by a test AND a mutation
    check that went red). The defect had one shape: a gate reads a field
    nothing writes, a send result is discarded, or a job locks state as
    "done" at zero sends — green while sending nothing. Each fix makes the
    failure VISIBLE (non-zero exit / warn-level event / red workflow).
    (1) *Cascade push*: `cascade-detect.yml` fetched no APNs env → null
    provider → `pushSent:0`, exit 0 for six weeks. Now the five-variable
    APNs block (as watchlist-digest.yml), `isPushProviderConfigured()`
    exported from notification.service, the fan-out reports `optedInUsers`,
    and the pure `cascadePushExitCode({newEvents, optedInUsers,
    providerConfigured})` (in `portfolioiq/cascadeNotify.service.ts` — the
    file lives there, not under `signals/`) is red iff events were owed to
    opted-in users and the sender did not exist; test
    `cascadePushExitCode.test.ts` (truth table + a null-provider sender
    still surfaces owners); mutant: decision disabled → 2 red. (2)
    *DailyIQ*: `markNotified(date)` ran even with no provider, so a re-run
    skipped the day. Marks only when the provider is configured (zero
    opted-in users still marks — a legitimate zero); otherwise warn-event
    `dailyiq_push_provider_missing {date, optedInUsers}` and the day stays
    unmarked; test `dailyiqMarksOnlyOnAttempt.test.ts`; mutant: always-mark
    → 1 red. (3) *Divergence digest*: three swallows + a literal recipient
    → `divergenceDigestSend.ts`: `sendDivergenceDigest` never throws,
    returns `{delivered, reason, users, rows}`, emits
    `cost_basis_digest_not_delivered {reason, users, rows}` (acs-
    unconfigured / email-provider-failed / send-threw / email-module-
    unavailable) or `cost_basis_digest_delivered`; recipient =
    `OPS_ALERT_EMAIL` (trimmed) || the historical literal, never logged;
    test `divergenceDigestSend.test.ts` incl. a structural pin that the
    reprice site no longer calls sendEmail; mutant: result swallowed → 3
    red. (4) *Notify workflows*: the three admin routes spread
    `pushProviderConfigured` into `.summary`; watchlistDigestNotify /
    gradeWorthyPushNotify results carry it and the two scripts exit 1 when
    it is false on a scheduled run (`GITHUB_EVENT_NAME=schedule` or
    `REQUIRE_PUSH_PROVIDER=1`; dispatch warns); grade-arbitrage / sell-side
    / personal-prospect print `notify summary: candidates=N pushesSent=M
    providerConfigured=…` every run and exit 1 on a scheduled non-dry-run
    with `false` — read via jq `has()` because `//` treats false as missing;
    an API without the field prints `unknown` and stays green; test
    `notifyProviderGate.test.ts`; mutant: `exit 1`→`exit 0` → 1 red; the
    block was run locally with a jq shim (schedule+false → 1; +true → 0;
    dispatch → 0; dry-run → 0). (5) *nightly-cleanliness*: missing
    `ADMIN_API_TOKEN` and an empty anomalies response were warn + exit 0 →
    both exit 1; the four dispatches stay and print their backfill-runner
    run URL; mutant: guard → exit 0 → 2 red. (6) *market-insights publish*:
    200 with an empty snapshot was green → `publish summary: …` every run,
    exit 1 when gainers+losers+notable == 0; mutant → 1 red. (7)
    *Retired vendor*: `cardsight-pricing-nightly` schedule removed
    (retired 2026-08-16; it was still writing 2–3 rows/day into sold_comps
    — 08-24, 08-27), `verdict-flip-push-fanout` schedule removed (permanent
    dry-run scaffold, `.cjs:68,149`), `cardsight` dropped from ingest-
    health `KNOWN_SOURCES`; test `workflowAlertGates.test.ts` (pins 5, 6,
    7); mutant: cron back → 1 red. (8) *Freshness canary*: `MIN_ROWS_24H`
    per-source floor on the trailing-24h row COUNT (default off; 429
    retry; both axes report before exit). Measured read-only 2026-08-29,
    UTC days 08-22..08-28 — `tca-ebay` 100190 / 114513 / 108922 / 100966 /
    9340 / 11911 / 9280 (min 9280); `cardhedge` 197620 / 36640 / 58927 /
    96621 / 101911 / 58272 / 32422. Floor = ~25% of the minimum day →
    `tca-ebay=2300` in the workflow; NOTE the 08-26 step-down 100k → 10k
    is the very shape the axis exists for — an end-to-end read-only run
    saw 441,477 `tca-ebay` rows in the trailing 24h (firehose flowing);
    once a firehose-era week is confirmed, raise toward 25,000. Test
    `freshnessCanaryRowFloor.test.ts`; mutant: floor never fails → 2 red.
    **Deploy note**: `backend/src` changed (notification.service,
    cascadeNotify, dailyiq.job, portfolioStore, divergenceDigestSend, the
    three admin routes, two notify services, ingestHealth) → dispatch
    "Daily 5AM ET Refresh & Deploy" after merge; until then the admin
    routes lack `pushProviderConfigured` and the workflows print
    `providerConfigured=unknown` (green by design).
  - *Cron + runner writers (group E):* 52 cron workflows, ~40 writers, **zero
    cron writers call reportWrites**; the reconciliation test is blind to 23
    patch-only writers, camelCase names, no-APPLY-token scripts and every
    service-mediated write (~30 writers it certifies without inspecting);
    permanently dry under the runner (flag never exported):
    `recover-chrome-collapse-damage`, `ingest-2026-bowman-auto-checklist`;
    apply even on `apply=false`: `refresh-market-signals`,
    `refresh-calibration-multipliers`, `reprice-user-holdings`,
    `drain-staging-backlog`; marker printed but no relaunch step:
    `retire-prose-parallel-rows`, `fold-unnumbered-twins`,
    `map-yearprefixed-setkeys`, `apply-setkey-rulings`; ten relaunch steps gate
    on progress>0 instead of the marker; `grade-explode` (nightly, mints graded
    rows) runs against `retire-unreferenced-graded-rows`/`materialize-graded-
    identities` in opposite directions; `bcp-sweep` + `checklist-refresh`
    re-scrape the exploded-spine source daily with no #1373 gate;
    `priceAlertEvaluator` prices a Cardsight UUID through `computeEstimate`.
    → **D14** (building, `feat/d14`): reconciliation test v2 (patch writers,
    cron population, marker ⇔ relaunch lint, declared debt that may only
    shrink); the cron writers get reportWrites in a follow-up batch.
  - *Web + MCP (group F):* one dead web call (`POST /api/portfolio/identify`,
    never existed — the scan page uploads then 404s); the web renders no rung
    or provenance (`method.ladderRung`/`provenance.pricingSource` typed, never
    shown); BuyerIQ can display a pool median as "Market" (falls to
    `weightedMedianPrice`); `/api/players/:name` tiers and the grade-analysis
    ROI are backend medians shown as prices; `apps/api` is a legacy Express +
    Prisma API (999 files, committed dist + zip) nothing deploys or imports;
    `mcp-server` is a plain Express app on a separate App Service that nothing
    live calls (not iOS, not web, not backend), prices from a comp MEDIAN +
    hardcoded grade multipliers + an LLM prompt, identity a text tuple never a
    slug, and keeps two unauthenticated backend routes alive for itself. →
    queued: delete `apps/api`, retire the MCP routes (NEEDS DREW), render the
    rung on web, fix the BuyerIQ fallback and the identify 404.
  **The matrix's top-10 probes, by money-at-risk:** (1) audit-all-holdings +
  rung/identity block → D14; (2) `probe-price-routes` (replay slugs through
  `/price-by-id`, `/canonical-fmv`, `/hobbyiq-fmv`, grade-curve; rung ∈
  vocabulary, setKey not a brand, cross-route disagreement) → D14; (3)
  `probe-grade-curves` (card-panel vs canonical ladder vs card-detail per
  tier); (4) `audit-pool-identity` → D14; (5) reconciliation v2 → D14; (6)
  `probe-dailyiq-identity`; (7) route identity-gate lint
  (`noFreeTextPricing.test.ts`); (8) `probe-notify-jobs` (rung of every push's
  price); (9) alert liveness → D13; (10) smoke v2 (rung + setKey + ±30% of
  canonical-fmv). Surface reductions first: the 9 always-empty CH/CS handlers,
  2 unmounted stubs, `/api/ops/cardsight-probe`, `bcp-sweep`.
  **What Drew saw on the 2025 Bowman Draft CPA-MWI picker (20:20Z):** 102
  un-graded rows across 11 sources for one card; the picker asked for 25 →
  Gold fell off the end (**#1466**: 100 rows, the backend's cap); `2025 2025
  Bowman Draft Baseball` (setName carries the year — fixed in the row, and a
  vocabulary item: setName should not carry the year at all); `Max Williams,`
  (beckett-checklist rows keep the trailing comma — a repair for the beckett
  converter); 21 bcp rows whose "parallel" is another card (`BDC 17 Ethan
  Conrad`) — the exploded-spine footnote shape the name-cleaning pass targets;
  checklistinsider rows (`Gold Border /50`, `Gold Geometric Refractor /50`)
  with `isAuto:false` on a CPA- card — that source's auto boundary is wrong
  (isAuto is the card-number prefix); `gold:auto:num-50` AND
  `gold-refractor:auto:num-50` both present (the Colour ≡ Refractor fold has
  not reached this card); the row's right-hand number is a sales MEDIAN
  (`salesSummary.median30d`) — now labelled `med` as a picking hint; the
  picker should carry the exact-pool FMV instead (queued).
  **Measured 21:55Z:** trailing-comma `playerName` = beckett-checklist 9,199 +
  catalog-explode-actuals 507 + tcdb 97 + small others; checklistinsider rows
  with `isAuto=false` on auto-prefixed card numbers (cpa-/bdc-/pa-/ra-) =
  **98,382 of 4,092,438** (2025 bowman basketball 13,927; 2025 bowman-draft
  9,528; 2024 bowman-draft 5,513; 2025 topps-chrome-platinum 5,487; 2026
  bowman-chrome 5,058); `setName` starts with the year in EVERY source
  (12.47M bcp, 4.09M checklistinsider, 1.71M new CLC …) — a display rule, not
  a rewrite. → **D15** (building, `feat/d15`): `repair-trailing-comma-player-
  names` (patch + search fields) and `repair-isauto-from-cardnumber-catalog`
  (a mover through catalogRowOps; the product's auto prefixes decided by the
  majority of its checklist sources, never by text). The `gold:auto:num-50` /
  `gold-refractor:auto:num-50` twin is `merge-bare-colour-parallels`'s case —
  dry run for 2025 dispatched 20:25Z (33273454220). Also identified:
  `baseballcardpedia-ladders-2026-08-29` (725k rows) is the e2e ingest's
  re-scraped bcp under the #1373 gate — the sane bcp, not the exploded one.
  **D14 — the probes (built on `feat/d14`, 2026-08-29; every one READ-ONLY,
  one scorecard block, exit 0 on a bad number, `LIMIT` env, whitelisted on the
  runner with `apply` irrelevant):**
    **Merged #1480 (00:35Z 08-30).** The scorecard the audit asked for, first
    numbers (2026-08-30, read-only): **routes** — the four pricing routes
    disagree by >25% on **44.2%** of (slug, Raw) (2018 Bowman #49 Gold:
    $11,995 / $11,995 / $3,893.55 / $88 across price-by-id, canonical-fmv,
    hobbyiq-fmv, grade-curve); price-by-id labels `direct-comp` (not a rung)
    and shows an exact-pool rung 0% of the time; hobbyiq-fmv `method` outside
    its union 80%; grade-curve served under a vendor id 89%; FMV null 8 / 8.5
    / 0 / 0.5%. **Pool** — `cardId` not hiq 79.8% (cardhedge 97%, tca-ebay
    0%; the canonical id lives in `hobbyiqCardId`, missing 1.6%); user
    purchases keyed `holding::` 59% / item id 40%, sales 100%
    timestamp-keyed (D12-a's keying fixes future rows; a backfill re-keys the
    old ones — queued); CH rows under both `ch-daily::` and `ch-comp::` for
    49 of 100 cards. **Holdings** — fmvRung null 38%, non-exact 27%,
    estimate shown 23%, isEstimate with an exact pool ≥3: 8 of 23 (the
    fold → conform → reprice chain's population). **Writes** — runner
    writers reconciling 29/75, cron writers 0/23, marker-printers relaunched
    on the marker 11/24 — all declared debt that may only shrink. → **D16**
    (building, `feat/d16`): one computation behind the four routes, the
    probe as its acceptance test (target: disagreement <5%, labels 100% in
    vocabulary, grade curve by slug). Runner baseline runs dispatched 00:38Z
    (audit-pool-identity 33276073374; probe-price-routes 33276077524) —
    **the runner reproduces the baseline: routes disagree >25% on 86/200 =
    43.0%** (worst: null no-recent-comps / null no-basis / $0.88
    exact-pool-last-sale / $0.15 exact-pool-weighted-median on a pool of 3);
    pool probe: hobbyiqCardId missing 253,307 of 16.1M (1.6%). These are the
    numbers D16 must move.
  - `audit-pool-identity` — sold_comps identity per source: partition key not
    an hiq: slug, `hobbyiqCardId ≠ cardId`, CardHedge rows keyed `ch-daily::`
    AND `ch-comp::` for one card (whole partitions read, (day, price) pairs
    matched across shapes), what keys a user purchase/sale, verified rows
    whose parallel's first word is absent from the title (Cosmos-side NOT
    CONTAINS, Base excluded). First run (16,135,582 rows, 6 sources,
    2,000/source sampled, 351s): cardId not hiq: **79.8%** (cardhedge 97.0% —
    the vendor id is the partition key; tca-ebay 0.0%, cardsight 0.7%);
    hobbyiqCardId missing 1.6% (253,307); cardId ≠ hobbyiqCardId 73.7% of the
    sample (4,504 / 6,113) — tca-ebay **45.9%** and cardsight 75.1% with the
    cardId already an hiq: slug, i.e. the sale is filed under one card and
    matched to another; ebay-user-purchase 75.2%, ebay-user-sale 77.8%. User
    keys: purchases `holding::` 59.4% / item id 39.6%, sales are
    **100% timestamp-keyed** (null sourceExternalId), manual `admin-manual::`.
    CardHedge: 49 of 100 cards carry both key shapes and 693 (3.1%) (day,
    price) pairs exist under both — the same sale in the pool twice.
    Verified parallel-word-absent 18 (4.7%), ebay-user-purchase 26.8%,
    "Refractor" the top offender.
  - `probe-price-routes` — replays checklist-confirmed slugs with ≥ 3 raw
    sales / 180d through `/price-by-id`, `/canonical-fmv`, `/hobbyiq-fmv` and
    `/observed-grade-curve` (Raw) under the harness session at ≤ 4 rps, the
    rung vocabulary read from the TS unions at run time. First run (45 slugs:
    1 in 7 candidates had a pool, the pull is now 15× LIMIT): label in
    vocabulary price-by-id **6.7%** — it emits the canonical METHOD
    (`direct-comp` ×36, `no-recent-comps` ×4, `projected` ×2), no rungLabel
    on that wire; canonical-fmv / hobbyiq-fmv / grade-curve 100%. Exact-pool
    rung 0% / 80% / 100% / 100%. `cardIdentity.setKey` = slug 100% on
    price-by-id; **no identity on the other three wires**. FMV null 8.9% /
    13.3% / 0% / 0%. **Routes disagree by > 25% on 55.6%** (25 / 45 — 2021
    Bowman Chrome CPA-EHA Refractor Auto: $13.09 / $13.09 / $125.00 /
    $243.75 off a pool of 14; three routes label the same exact pool
    `exact-pool-projection` and read it to different numbers). hobbyiq-fmv
    `method` outside its own union 91.1% (`unified-market-value`);
    grade-curve answered under a vendor id 82.2%; median rung with ≥ 8
    sales 0 / 20. The LIMIT=200 run (1,535 candidates probed, 800 requests,
    ~35 min at the RU floor): price-by-id label in vocabulary 2.5%
    (`direct-comp` ×177, `no-recent-comps` ×17), exact-pool rung 0% / 89.0%
    / 99.0% / 99.5%, FMV null 8.0% / 8.5% / 0% / 0.5% — canonical-fmv answers
    `no-basis` on 17 slugs whose exact pool hobbyiq-fmv priced; **routes
    disagree by > 25% on 44.2%** (88 / 199; worst, 2018 Bowman #49 Gold:
    $11,995 / $11,995 / $3,893.55 / $88.00 off a pool of 3); hobbyiq-fmv
    median rung with ≥ 8 sales 5 / 48 (10.4%), `method` outside its union
    80.0%; grade-curve under a vendor id 89.0%.
  - `audit-all-holdings` RUNGS block — appended, existing output untouched:
    judged from the persisted fields, never from estimateBasis prose. First
    run (all users, 92 holdings, 10 clean): fmvRung null **38.0%** (35), not
    an exact-pool rung 27.2% (25: rare-card-anchor ×11, cross-grade-fallback
    ×10, sibling-parallel ×3, same-printrun-cross-parallel ×1), cardId ≠
    hobbyiqCardId 28.3% (26), cardId not hiq: 10.9% (10), estimatedValue
    shown because fairMarketValue is null 22.8% (21), isEstimate while the
    exact pool has ≥ 3 raw sales in 180d **8 of 23** (34.8%).
  - `everyWriteJobReconciles` v2 — `.patch(` and `.create(` are writes,
    `.replace(` only in its Cosmos shape (the v1 pattern called eight
    HTML-escaping digests writers), camelCase names, the cron population
    (every `scripts/*.cjs` a workflow invokes, no APPLY needed — a cron is
    always live), and the marker ⇔ relaunch contract judged with comments
    stripped. Measured: runner writers 29 / 75 reconcile (debt 46, was 26
    declared — `reslugAllSoldComps` and 21 patch-only writers were invisible;
    `ingest-product-checklist` leaves the list because its writes are
    service-mediated and the net cannot see them); cron writers **0 / 23**
    (`cosmos-throughput` excluded by name — it replaces an OFFER, not rows);
    marker-printers relaunched on the marker 11 / 24 (debt 13: four with no
    relaunch step, nine gating on progress > 0). Every debt list is sorted,
    may only shrink, and a wired or vanished entry fails the test.
    Mutation-checked four ways. → next, by doctrine: wire the 23 cron
    writers, key the nine relaunch steps on the marker, give price-by-id a
    rungLabel and the three wires an identity, and find why canonical-fmv,
    hobbyiq-fmv and the curve read one exact pool to three numbers.
    **D15 — what the CPA-MWI picker showed, as three catalogRowOps movers
  (`feat/d15`, unmerged, 2026-08-29; tests 3 files / 7 mutation checks, tsc 0,
  writer guard 28/91 compliant (was 24/87), reconciliation 30/56):** (1) `repair-trailing-comma-player-names` — 9,837 rows
  end in "," (beckett-checklist 9,199 — 1,715 of the comma rows are graded
  children; explode-actuals 507, tcdb 97, cardhedge 19, bcp 8, auto-seed 6,
  checklistcenter 1), 2 in ";", 148 in " " (cardhedge-graded). Every sampled
  row is "Full Name," — no "Last, First" exists — so only the trailing run of
  [,;whitespace] is trimmed (a trailing "." is "Jr.", 656,452 rows, untouched);
  playerSlug is recomputed with hobbyIqCardId.slugify (the checklist ingest's
  and the matcher's slugifier — "Moisés" → moises; the builder's private
  playerSlugify would give moiss); searchText / displayName rebuilt by
  `rebuildSearchFields`; searchTokens UNIONED (the comma never reached a
  token; a graded row keeps its grade tokens, the nightly fold passes
  survive). A patch — the slug has no player segment. **Root cause closed:**
  `cleanPlayerName` at deriveCatalogEntry and at the CSV ingest's row parse.
  Dry run LIMIT=200: 208 candidates → WOULD REPAIR 208 (23 graded), 0 failed.
  (2) `repair-isauto-from-cardnumber-catalog` — the 98,382 checklistinsider-
  2026-08-27 rows with isAuto=false on an auto-prefixed number are TWO shapes:
  41,609 CPA-/CDA- rows already sit at a `:auto` id (the generator forces nine
  prefixes) with a stale FIELD → a heal; every BDC-/PA-/RA- row sits at
  `:no-auto` → a move iff the product's OTHER checklist families rule the
  prefix signed (one GROUP BY per product over every source's un-graded rows,
  ~7k RU; each family votes by its row majority, dated scrape runs fold into
  one family, vendor/derived never vote, the source under repair never votes;
  no ruling → only field-vs-id heals; a ruling that contradicts the
  generator's forced list is REFUSED and printed). Sharded by product
  (sha1(sport|year|setKey)) so a slot computes each product's evidence once;
  2025 bowman basketball is 2.5% of the source. Dry run LIMIT=200 (498
  products, 4,092,310 rows in scope), first product 2025 bowman/basketball:
  35 (product, prefix) pairs — 28 ruled, 7 no ruling, **1 REFUSED: CPA
  ruling=no-auto by the only other family, `bccp 0/609`** (bccp rows tagged
  basketball on a Bowman product — the exploded-spine shape; the generator
  forces CPA → :auto, so 6,930 rows wait for a ruling, not a move); 200 heals
  on BDA- (`…:bda-ac:…:auto` with isAuto=false — and those ids say
  `bowman-draft` while the row's setKey field says `bowman`: conform-card-
  profile's population; moveCatalogRow refuses a MOVE on such a row, a heal
  it allows). (3) `conform-one-of-one-parallels` — Drew: "superfractors are
  1/1"; glossary: every plate is 1/1. 255,229 un-graded rows whose id's
  parallel segment matches `(^|-)superfractors?(-|$) | printing-plate |
  (^|-)(one-of-one|1-of-1)(-|$)` sit at an id without `:num-1` (printRun null
  246,271; /4 8,861 — checklistinsider "Printing Plates Parallel", the four
  plates read as a run; 1368310399850795000 ×49; /200 ×39; 2021 ×5; strings),
  and 55 `:num-1` ids carry a field ≠ 1 (healed in place). The plural is
  admitted deliberately (`superfractors` 21,536, `superfractors-refractor`
  8,075 — a category header glued into the name; the singular-only regex
  would have skipped 26 distinct slugs); one-of-one / 1-of-1 are 25 real
  rungs (class-3-red-one-of-one, od-1-of-1); prose footnote slugs are skipped
  and counted. Dry run LIMIT=200: 208 candidates → 207 actionable — moved 155
  / folded 37 / replaced 15 (checklistcenter outranks the explode's derived
  num-1 twin), 1 sale re-pointed, **2,277 graded children retired (≈11 per
  row → the full run retires ~2.8M graded rows; regenerable — dispatch
  `materialize-graded-identities` after)**, 1 prose, 0 failed. **Dispatch
  (runner-whitelisted; relaunch steps keyed on the budget marker):** dry
  first with `apply=false slots=1` and read the REFUSED / failed lines; then
  APPLY sharded — comma `slots=4` (≈10k rows, one cycle; `sources` optional);
  isAuto `slots=8` (`sources` defaults to checklistinsider-2026-08-27;
  `sports` / `years` scope; `VERBOSE=true` prints every pair); one-of-one
  `slots=8` (255k moves, ~2.8M graded deletes; each move runs one sales query
  against sold_comps at its 10k floor). Then the D10 chain: conform-holdings
  → reprice → re-explode.
    **Mover validation (report-only, 140-min budget each, 20:10Z):**
  clean-parallel-annotations dry — 30,564 rows this slot: 758 heal / 5,979
  move / 1,075 fold / 1,482 replace-a-derived-twin / 2,970 graded children /
  **3,076 failed** (dry-run failures are moveCatalogRow refusals — read the
  reasons before any APPLY); rename-setkey dry (`topps-allen-and-ginter`) —
  12,894 rows: 11,267 move / 711 fold / 905 replace / 2,539 sales re-pointed /
  0 failed.
    **Merged #1477 (23:40Z).** Dispatched: `repair-trailing-comma-player-names`
    APPLY (33275249458); `conform-one-of-one-parallels` full dry run
    (33275255335 — the LIMIT=200 dry was 207/208 actionable; the full run's
    graded-children count decides whether `materialize-graded-identities`
    runs right after); `repair-isauto-from-cardnumber-catalog` full dry run
    (33275261214). The agent's un-graded print-run breakdown (null 246,271;
    /4 8,861; a 19-digit mis-parse ×49) does not show my /50 ×234, /25 ×255
    … — those were graded rows; the un-graded population is what the mover
    touches.
    **D16 — one valuation path behind the four routes (built on `feat/d16`,
  2026-08-30, 7 commits, unmerged; backend/src changed — dispatch "Daily 5AM ET
  Refresh & Deploy" after merge).** The D14 probe's finding was one shape four
  times: `/price-by-id` ran canonical-fmv's ladder over a cardId-keyed
  five-source pool and stamped `source: "direct-comp"` (a METHOD, 0% exact-pool
  rung on that wire), then the CH pipeline priced the same slug a second way
  when that found nothing; `/hobbyiq-fmv` ran the unified engine at the
  density window and labelled it `unified-market-value` (outside its own
  union); `/observed-grade-curve` swapped the slug for the majority vendor id,
  ran the legacy build's own read + trajectory + sibling pass, then a unified
  overlay at a FIXED 180d window; `/canonical-fmv` answered no-basis on slugs
  the others priced. Same rows, four engines, four windows. **Built:**
  `oneValuationPath.service.valueIdentity({ id, grade?, printRun? })` — the
  ENTRY, not a fifth engine: identity resolved once (catalog slug; a vendor id
  maps through sold_comps and the catalog must hold it; nothing minted; a slug
  the catalog does not hold is refused as priceFromOurPool refuses it), the
  exact pool priced once by the unified engine through
  `priceHoldingFromExactPool` (hobbyiqCardId alone first, its twin second,
  ≥ 1 sale — #1462's rule), the grade curve = that same result over the
  canonical tiers through gradeCurveEntry's one writer; **headline(T) ==
  curve[T] by construction** because the engine gained `perTierWindows`
  (one 180d read, every tier runs the 60/90/180 cascade on its own rows —
  pinned identical to the cascade's answer for the requested tier; the
  self-comp rule per window). No pool at the tier → this identity's other
  tiers × the empirical ratio (`grade-curve-estimate`; the engine's
  getGraderPremium cross-grade rescale is NOT used for a headline — D4 PR 6's
  tables) → with no sale at any grade the GATED ladder (computeHobbyIqFmv,
  `skipExactPool`) under its own rung name → null with `fmvReason` on every
  route. `oneValuationPathAdapters` shapes the four wires from one Valuation
  (pure, pinned engine-free); every surface carries `rungLabel` (closed
  vocabulary), `valueSource`, `identity`, `fmvReason`; price-by-id's `source`
  is the rung (a null keeps `no-recent-comps` + `marketTier: null` — iOS's
  no-data check); hobbyiq-fmv's `method` is `direct-slug` for the exact pool
  (computeHobbyIqFmv itself fixed — the string is gone from src); canonical's
  `method` is `direct-comp` for the exact pool and the ladder's own names
  otherwise (union widened); the curve is served UNDER THE SLUG with
  `rungLabel` on every priced tier; the legacy curve overlay (card-panel,
  bulk, the portfolio tile) moved to per-tier windows too. Legacy pipelines
  survive only for vendor ids the catalog cannot name. **Judgment calls
  (flagged):** (1) thin pools n = 1–2 are priced by the unified engine's
  weighted-median rung on every route (hobbyiq-fmv used rare-card-anchor /
  the drift-adjusted last sale below conf 0.3) — the persist site's rule
  since #1462; the engine does not implement `exact-pool-last-sale`, a
  follow-up if the thin-pool aggregation should drift-adjust; (2) the
  observed-tier floor pass (CF-GRADE-CURVE-MONOTONIC) is not applied on the
  one path's curve — it rewrites an observed number; the projected-tier cap
  is; (3) `/hobbyiq-fmv maxAgeDays` no longer honoured (a caller window = a
  second computation); (4) the catalog check fails CLOSED — a catalog outage
  nulls the four routes (was: hobbyiq-fmv priced without a catalog read);
  (5) `/card-detail`, `/card-panel`, `/observed-grade-curves-bulk` and the
  portfolio persist site still call their engines directly (their windows
  now match; routing them through the entry is the follow-up). **Before
  (this branch's 50-slug read-only sample, 2026-08-30, slugs in
  `backend/docs/d16-probe-sample-slugs.txt` — replay with `SLUGS_FILE`):
  routes disagree > 25% on 17/50 = 34.0%** (runner 200-sample baseline
  43.0%); label in vocabulary price-by-id 4.0% (`direct-comp` ×44,
  `no-recent-comps` ×4) / 100 / 100 / 100; exact-pool rung 0% / 88% / 100% /
  100%; FMV null 8% / 8% / 0% / 0%; hobbyiq-fmv `method` outside its union
  88%; grade-curve under a vendor id 86%; worst: 2021 Bowman Chrome CPA-EHA
  Refractor Auto $13.09 / $13.09 / $125.00 / $243.75 off a pool of 14.
  **Tests:** `oneValuationPath.contract.test.ts` (8 — ONE fixture pool at the
  engine's read seam `exactPoolReader` through all four handlers: identical
  FMV + rung on Raw / PSA 10 / thin tiers / the empirical fill, labels from
  the TS unions, method in-union, curve under the slug, the same null +
  reason, no second engine via spies), `oneValuationPath.pin.test.ts` (8
  source pins), `oneValuationPath.test.ts` (12), `unifiedPerTierWindows.test.ts`
  (5); required-green set + touched tests 260/260; tsc 0. **Mutation checks
  (each reverted):** a second computeHobbyIqFmv on /hobbyiq-fmv → pin 1 +
  contract 5 red; the curve route back on buildObservedGradeCurve → contract
  4 red; `source: "direct-comp"` → contract 1 red; the entry on the cascade
  instead of per-tier → pin 1 red; per-tier mode collapsed to one window →
  engine test 4 red. Full suite 593/598 files — the 4 reds reproduce on
  `origin/main` (explodeCatalogGrades.cjs load ×2, allCanonicalVerticals,
  slugGuardResolverParity); signalFetchObservability is a load flake (green
  alone). **After-number:** re-run `probe-price-routes` on the runner after
  the deploy with `SLUGS_FILE` pointing at the committed list (LIMIT=50) and
  the 200-sample default; expect disagreement → ~0% on priced slugs (the
  four are one call), null ≤ the catalog-miss rate, labels 100% in
  vocabulary, `grade-curve under a vendor id` 0%.
    **Merged #1483 (01:45Z 08-30); deploy #3 33277935264 — live 02:20Z,
    health `c23d976`. Same-slug replay: routes disagree by >25% on 0 of 50
    (was 17 of 50 = 34.0%); label in vocabulary 100% / 100% / 100% / 100%
    (price-by-id was 4%); exact-pool rung 100% on all four (price-by-id was
    0%); FMV null 0% everywhere (was 8%); hobbyiq-fmv method outside its
    union 0% (was 88%); grade curve under a vendor id 0% (was 86%); all four
    routes show the identical rung distribution — leading-edge ×21,
    weighted-median ×16, projection ×13.** The 200-sample runner probe re-run
    (33278464941) is the official after-number: **routes disagree by >25% on
    0 of 200 (was 86 of 200 = 43.0%)** — the scorecard's first line is closed. D17 (building,
    `feat/d17`, the one builder running per Drew's "use what we have before
    credits"): `/card-detail`, `/card-panel`, the bulk curves, the portfolio
    persist site and the price-alert evaluator through the same entry.
    D18 built (`feat/d18`, below). Queued, not launched: D19 (re-key the old
    user comps; collapse the CH `ch-daily::`/`ch-comp::` dual ids), D20 (web: render the rung,
    the BuyerIQ median fallback, the identify 404, FMV in the picker). Judgment calls to read
    (NEEDS DREW if any should go the other way): thin pools (n = 1–2) now
    price from the unified weighted-median rung on every route (the persist
    site's ≥ 1 rule) — `/hobbyiq-fmv` used to drift-adjust the last sale
    below conf 0.3; a graded tier with no pool uses this identity's observed
    tiers × the empirical ratio (`grade-curve-estimate`), never the hardcoded
    cross-grade rescale; the observed-tier floor clamp is not applied on the
    one path (it rewrote an observed number); `/hobbyiq-fmv maxAgeDays` is no
    longer honoured (a caller-chosen window is a second computation); the
    catalog check FAILS CLOSED — a slug the catalog does not hold, or a
    catalog outage, nulls all four routes with `fmvReason`; `/card-detail`,
    `/card-panel`, the bulk curves and the portfolio persist site still run
    their own calls with the same window policy — routing them through the
    entry is the follow-up. The per-tier overlay also moves `/card-panel`
    tier numbers and the portfolio tile on the next reprice (dense tiers
    from a 180d fit to their density window).
    **D17 — every price surface through the one entry (built on `feat/d17`,
  2026-08-30, 6 commits, unmerged; backend/src changed — dispatch "Daily 5AM
  ET Refresh & Deploy" after merge).** The five surfaces D16 left on their
  own calls, each routed through `valueIdentity` so the number is one
  computation everywhere: **(1) `/card-detail`** — the `fmv` block is
  `toHobbyIqFmvResponse` over the valuation (byte-identical to
  `/hobbyiq-fmv`) and every ladder tier is the valuation's curve entry;
  computeHobbyIqFmv + computeGradeBreakdownSingleScan are gone from it.
  **(2) `/card-panel`** — the slug branch serves the entry's curve under the
  slug with the catalog identity block; the majority-vendor resolver, the
  legacy build, the second overlay and the grade-rescue pass survive only
  for vendor ids the catalog cannot name. **(3) `/observed-grade-curves-bulk`**
  — `valueIdentitiesBulk` (the entry many times: deduped, BULK_CONCURRENCY =
  8 workers, one exact-pool read per identity) serves every slug; curves keyed
  by the REQUESTED id so a 500-id caller can join (iOS keys BulkGradeCurve by
  cardId), slug additive. **(4) the portfolio persist site** —
  `holdingValuation.ts` is the adapter over the entry (decides what a
  valuation becomes on a holding, nothing about the price): an exact-pool
  rung → the unified write, observed; `grade-curve-estimate` → persisted as
  an ESTIMATE under its rung (this replaces the engine's cross-grade rescale
  off getGraderPremium's tables being persisted as observed — the seam D16
  flagged); cost-basis floor / unresolved / unpriced → nothing written.
  autoPriceHolding and repriceHoldingsForUser ask it FIRST (not env-flagged,
  as the tile rung was not), the supremacy gate before its re-price; the
  grade-curve tile rung and its GROUP BY resolver are removed; the flagged
  legacy exact-pool reads run only for identities the catalog cannot name,
  and for a resolved identity the entry declined they do not run at all (they
  could only produce the number it declined to) — the gated ESTIMATE chain
  still does. The entry takes `cardId` so the pool is asked in #1462's order
  (slug, twin, cardId ∪ slug) and reports `pooledVia`. **(5) the price-alert
  evaluator** — `alert.cardId` through the entry, else the snapshot's derived
  slug adopted only when the catalog holds exactly ONE of its auto forms
  (fill-only, catalog-backed, as D12-a); unresolvable → counted skip with a
  null evaluation, never priced from text; compiqEstimate no longer imported.
  **Judgment calls (flagged):** card-detail `gradeLadder[].method` now carries
  the rung (was `direct-slug` / `anchor-projected` — D16's move on
  price-by-id's `source`), `maxAgeDays` accepted and not honoured; card-panel
  `ratePerWeek` / `signalSource` / `siblingFallback` null on the one-path
  branch; bulk corpus rows persist under the slug; the persist site stamps
  `pricingSourceMeta.compsUsed` as the TIER's pool (the routes' number, not
  the whole curve's) and `sourceVendor: "hobbyiq-pool"` (the gate's
  convention since D4 PR 5); a holding whose slug has no rows but whose
  vendor cardId has is still priced from that pool (attempt 3) while the
  card page, which knows only the slug, says null — a data gap (rows without
  a slug), not a rule; the advanced-alerts evaluator
  (`advancedAlerts/ruleEvaluator.ts`) still prices from text — follow-up.
  **Pre-existing gap seen under a mutation:** the reprice mid-path
  (`bExact`, after computeEstimate) has no cost-basis floor — unreachable for
  catalog-resolved identities now, still live for unresolved ones.
  **Harness finding:** concurrent dynamic imports race vitest's async mock
  factory (`importActual`) — engine spies undercount under concurrency; the
  bulk contract pins the read count at the `exactPoolReader` seam (a static
  mock) instead. **Tests:** `oneValuationPath.contract.test.ts` (+15: the same
  fixture pool through card-detail, card-panel, the bulk route, and
  repriceHoldingsForUser + autoPriceHolding via POST /holdings/:id/refresh
  against the mocked reader — identical FMV + rung on Raw / PSA 10 / the PSA
  8 fill, the shared null + reason, legacy surviving only for identities the
  catalog cannot name, the cost-basis floor), `oneValuationPath.pin.test.ts`
  (+6), `priceAlertEvaluator.job.test.ts` (rewritten, 7); required-green set
  + touched persist tests 237/237; tsc 0. **Mutation checks (each reverted):**
  card-detail header on computeHobbyIqFmv → pin 1 + contract 3 red; card-panel
  slug branch off → contract 3 red; bulk slugs to the legacy build → contract 2
  red; the persist site skipping the entry → contract 4 red (Raw's comp count
  and basis, PSA 10, PSA 8 persisted as cross-grade-fallback, the floor);
  alerts through computeEstimate → job test 1 + pin 1 red. **After-number:**
  `audit-all-holdings` PRICE column after the next reprice — persisted
  fairMarketValue vs `/hobbyiq-fmv` for (slug, grade) should disagree on 0
  exact-pool-rung holdings; the D16 probe replay (`SLUGS_FILE`) unchanged.
    **Merged #1488 (03:30Z 08-30); deploy #4 33279979918 (expect `a1cf6bc`).**
    Persist stamps changed with it: `pricingSourceMeta.compsUsed` is the
    tier's pool (the routes' number), `sourceVendor: "hobbyiq-pool"`,
    `grade-curve-estimate` persisted as an estimate (`isEstimate: true`).
    Flagged for later: `advancedAlerts/ruleEvaluator.ts` still prices from
    text; a holding whose slug has no rows but whose vendor id has is still
    priced (attempt 3) while the slug-only card page says null — a data gap
    the pool re-key (D19) closes. After-number: `audit-all-holdings`'s PRICE
    column after the next reprice-all should show no exact-pool-rung
    disagreement between a persisted FMV and `/hobbyiq-fmv`. **D3c**
    (building, `feat/d3c`, the single builder): the converter's two
    below-floor page shapes — Topps flagship base rows + foil parallels,
    Panini ladders — with the coverage measurement as the acceptance number.
    **D18 — every write job reconciles (built on `feat/d18`, 2026-08-30, 4
  commits, unmerged; backend/src changed — `bulkOutcome` in
  writeReconciliation — dispatch "Daily 5AM ET Refresh & Deploy" after
  merge).** The debt the v2 guard measured, shrunk mechanically and pinned.
  **(1) Relaunch** — the nine count-gated steps (repair-parallel-subset-fold,
  canonicalize-vendor-shaped-rows, retire-numbered-base-rows,
  repair-pokemon-glued-numbers, map-pokemon-setkeys-to-checklist,
  backfill-playerslug, conform-card-profile, materialize-graded-identities,
  retire-unreferenced-graded-rows) grep the budget marker and forward
  slot/slots/mode/sports/years/scope/sources verbatim, as the fold step does;
  rehome-catalog-rows-to-own-partition, which printed no marker and was
  SIGKILLed at the step ceiling (a killed job cannot report progress), owns
  RUN_MINUTES=140 and prints it, and its relaunch forwards
  years/setkey_like/parents_only/limit/scan_limit. Marker-printers relaunched
  on the marker **15/27 → 25/28 (debt 12 → 3)**; the three left
  (apply-setkey-rulings, map-yearprefixed-setkeys, retire-prose-parallel-rows)
  have no relaunch step at all — giving them one is an ops decision (a fleet
  that keeps going), not a lint fix. **(2) Cron writers** — all 23 call
  reportWrites around their real write loop with disjoint counters and a
  header saying what each means; nothing they write changed, only what they
  measure. Measurement defects found on the way: backfill-search-fields
  charged a bulk batch that THREW a flat 100 failed rows (over-accounted every
  short last batch; now exact through `bulkOutcome` — 2xx written / 429·449·503
  retry / else failed, unit-tested); purge-old-sales-derived and
  sold-comps-cross-source-dedup dropped 404s from every count;
  rollup-sold-comps-daily only logged an upsert error; phase-b-crawl-pricing
  counted a thrown upsert as "skipped"; tca-firehose-ingest never tallied
  catalogUnmatched and let a FETCH error pose as a row error;
  drainCatalogSeedQueue swallowed a failed seed-status upsert as "non-fatal";
  tca-match-enricher's delete-then-create re-key can lose a row (named in its
  header, not fixed). Cron writers reconciling **0/23 → 23/23 (debt 0, floor
  pinned)**. reportWrites is compiled TS and dist/ is gitignored, so the
  eleven cron workflows that never built it gain `npx tsc` after install —
  two of them (grade-explode, nightly; sold-comps-ch-backfill) already
  required dist/ and have been crashing at require(); a new guard makes the
  build step the rule (a workflow that runs a dist-requiring script must
  build). **(3) Runner switches** — the six group-E scripts read what the
  runner exports: recover-chrome-collapse-damage (RECOVER_MODE, permanently
  dry) and ingest-2026-bowman-auto-checklist (INGEST_APPLY) fall back to
  BACKFILL_APPLY, both reconciled; refresh-market-signals /
  refresh-calibration-multipliers (default-on, wrote on apply=false) honour
  BACKFILL_APPLY under the runner while the cron workflows' explicit
  `*_APPLY: "true"` still wins; reprice-user-holdings and drain-staging-backlog
  (no flag, wrote on every dispatch) honour BACKFILL_APPLY — `-f apply=true`
  in the runbooks is unchanged. A new guard case reads the runner's exported
  switches from the yml and requires every whitelisted writer (the net plus
  five named service writers) to read one; runnerWriters() no longer needs an
  APPLY token to see a writer, so recover-chrome-collapse-damage joined the
  population (runner writers reconciling 32/78 → 33/79; the 46 declared are
  unchanged — each needs its own counters understood before it is wired).
  **(4) The guard itself** — `wired` was `includes("reportWrites")`, which the
  import line alone satisfied; it now demands a call outside comments (the
  mutation check found it). Stays on the list, with reasons: the 46 runner
  writers; reprice-user-holdings is NOT reconciled because the service's
  `requested` is ALL holdings while repriced+skipped cover only the candidates
  after the min-age filter and the maxHoldings slice — a wrong intended fires
  WORK VANISHED on every portfolio over 200; the service would have to return
  the candidate count. Mutation-checked four ways (count-gate a relaunch,
  un-wire a cron writer, drop a build step, point a writer at an unexported
  switch — each red); tsc --noEmit 0. Verify the write after merge: the next
  nightlies' logs must each show a `reconciled:` line (a green run without
  one is the old failure shape), and grade-explode should complete for the
  first time since gradeLadder was wired.
    **Merged #1503 (09:35Z 08-30); deploy #6 33283656704.** Verified with the
    exit-code gate (tsc 0, vitest 0). Found on the way: `grade-explode` and
    `sold-comps-ch-backfill` had been crashing at `require()` — their
    workflows never built `dist/`; eleven workflows gain `npx tsc` and a guard
    makes it structural; the v2 guard's `wired` predicate was satisfied by an
    import line alone (now demands a call). Left declared: the 46 runner
    writers, three marker-printers with no relaunch step (`apply-setkey-
    rulings`, `map-yearprefixed-setkeys`, `retire-prose-parallel-rows` — an
    ops decision), `reprice-user-holdings` / `drain-staging-backlog` (no
    honest `intended` on the caller side). Named, not fixed:
    `tca-match-enricher`'s delete-then-create re-key. **D19** (building,
    `feat/d19`, the single builder): re-key the old user comps to the D9/D12-a
    identity (a sale is never lost: create-verify-delete), collapse the
    CardHedge `ch-daily::` / `ch-comp::` dual ids (refusing any pair whose
    grade or parallel differs), variance printed before "duplicate".
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
  every portfolio user). **D9 (#1454) and D4 PR 5/6 (#1462) landed →
  `reprice-user-holdings` MODE=all dispatched 18:40Z (33268405103) with the
  PR 5/6 deploy (33268395668 — landed, health serves the PR 5/6 sha); the
  reprice is queued behind the fleets (GitHub runs ~35 runner jobs at once and
  the relaunch children fill the slots); result and the re-audit recorded here
  when it runs.** → **ran 19:20–19:40Z (33268405103): 12 users; Drew 45
  requested / 37 repriced / 8 skipped (confidence gate + pending-review);
  the flagged Marconi German Gold Refractor /50 now reads **$182.50
  observed, `exact-pool-weighted-median`, our-pool, n=3** (was $1,109.44
  sibling × 8.00× floor). The new gate withheld five estimates because an
  exact pool existed (`estimate_withheld_exact_pool_exists`: a 1999 Black
  Diamond base with 8 sales under the un-numbered twin, a 2005 Bowman Chrome
  base with 5, a 2024 Bowman Draft CPA-TG Blue /150 with 2, a 2026 Bowman
  CPA-BG Black X-Fractor with 2 under the un-numbered twin) and one
  unidentified holding's price was withheld at write (Marek Houston,
  cardsight-sourced, no slug). Those twins are exactly the fold →
  conform chain's population. Re-audit (`audit-all-holdings`) after fold +
  conform. The fold → conform passes run again once fold-unnumbered-twins'
  report-only run finishes — **it did (33264277457): WOULD FOLD 1,091
  un-numbered twins (6,915 sales re-pointed, 120 graded children), 20
  refusals where the row's `setKey` field disagrees with its own slug
  (`bowman` vs `bowman-chrome`/`bowman-paper` — conform-card-profile's
  population). APPLY dispatched 20:22Z (33273328022) — **ran to its 140-min
  budget: 6,899,700 base ids with exactly one numbered variant after the
  re-ingest, 330,268 candidates reached, FOLDED 4,136 (14,137 sales
  re-pointed, 328 graded children), 11,832 checklist twins left for the
  cross-source mode, 77 refusals (setKey ≠ slug), reconciled; it predates
  its relaunch step, so relaunched by hand 03:05Z (33279764127) — from here
  the marker-keyed step continues it.** conform-holdings dry run dispatched
  with it (33279767793) — **92 holdings: 40 resolve exact, 1 fuzzy, 35 already
  agree, 6 corrections, 51 unresolved (no catalog match ≥ 0.8), 0 failed.
  Two of the corrections say the APPLY must wait:** (1) the three Max Williams
  CPA-MWI "Refractor" holdings would land on the UN-numbered
  `refractor:auto` (checklistinsider, 13 sales) while the checklist's
  `:num-499` (22 sales) is the card — the cross-source fold must run first;
  (2) Bobby Witt Jr. BD152 would move from `2020:bowman-draft` to
  `bowman-draft-1st-edition` at 0.95 — because the real base row
  `2020:bowman-draft:bd152:base:no-auto` is MISSING (its ten bccp parallels
  exist; the base row is the Topps-flagship "base rows" shape D3c is fixing)
  and the only base row left is a **CardHedge-minted** 1st Edition twin.
  **Drew (04:35Z): "bobby witt came out of bowman draft … first edition is
  another bowman set" — the correction is wrong on its face: Bowman Draft
  and Bowman Draft 1st Edition are different products; conform gets a guard
  (never adopt a vendor-minted row; a product-changing correction needs a
  checklist-authority target).** So:
  cross-source fold APPLY → D3c re-ingest → conform APPLY → reprice-all →
  audit-all-holdings. Measured while looking (04:20Z): **vendor- and
  sale-minted un-graded catalog rows still present — cardsight 664,927,
  cardhedge 133,911 (104,081 carrying vendorIds), pool 75,650, sold-comps
  stubs 59,890, tree-builder-v1 14,473, ebay-browse 62 ≈ 950k rows** the
  doctrine says should not exist; where a checklist row shares the id the
  re-ingest's tie-break already replaced them, so these are the ones with no
  checklist twin: an acquisition list plus garbage — NEEDS DREW (below).**
  **Drew's rulings (05:00Z 08-30):** (1) retire the ~950k vendor-/sale-minted
  rows — **GO** → `retire-exploded-checklist-rows` MODE=source with
  `REPLACED_BY=none` (#1492: no coverage guard for sources that have no
  replacement; prints every holding still pointing at one) — dry run
  33280778780; (2) "CPA is what?" → Chrome Prospect Autograph, an autograph
  by definition → `FORCE_AUTO_PREFIXES` (#1492; the runner's `scope` input
  carries it, #1493) — isAuto dry with CPA forced 33280807658; (3) the
  one-of-one graded-children churn (~2.8M derived rows deleted and rebuilt
  by materialize) explained — proceed after its dry run, materialize right
  after; (4) MCP: retire as a pricing engine; a thin MCP tool over
  `/api/compiq/price-by-id` is the only useful shape later.
  **Conform guards (#1491, #1492):** only checklist-authority rows are
  identity targets; a product-changing correction is REFUSED and reported
  (dry #2: Ohtani HMT1 `topps-chrome` → `topps-chrome-update` — probably a
  real correction, HMT-1 is the Update card — and two Bowman ↔ Bowman Chrome
  CPA cases: rulings, not bot moves); the composed slug must exist as a row
  (else its one numbered twin — after the folds the Max Williams holdings land
  on `:num-499`); an existing numbered identity is never demoted (Griffey
  `:num-3000` stays); the year-token regex typo (`/^d{4}$/`) fixed. Dry #2:
  91 holdings, 25 agree, 7 corrections, 3 refused, 2,058 vendor rows ignored,
  56 unresolved. Dry #3 with the row rule dispatched (33280773925).
  **Cross-source fold dry (33274650026):** 8,798,694 numbered rows, 6,896,738
  unique-/N base ids; in the first 102,812 candidates WOULD FOLD 2,344 (282
  one-of-one, 2,062 cross-source; 3,590 sales re-pointed), 408 ambiguous, 395
  same-source-lists-both, 124 refusals (setKey ≠ slug), **6,942,991 not
  reached** — APPLY ×8 dispatched 05:18Z (33280658423 … 33280680511).
  **Dry-run verdicts (05:45Z):** conform dry #3 with the row rule — 91
  holdings, 28 exact, 15 agree, 10 corrections, 3 refused (the Ohtani /
  Antunez / Arias rulings), 63 unresolved (the acquisition list; grows as
  composed slugs with no row stop being "resolved"). `conform-one-of-one-
  parallels` full dry (slot 0/1): 72,628 candidates reached before the
  budget, 71,107 actionable, WOULD REPAIR 64,580 (moved 57,715, folded 5,089,
  replaced 1,762, healed 14), graded children 61,789 — the ~2.8M estimate
  was wrong by an order of magnitude; 6,527 refusals are rows whose setKey
  FIELD disagrees with their own slug (`bowman` vs `bowmans-best`) → APPLY
  ×8 dispatched 05:50Z (Drew's OK; the marker-keyed relaunch continues each
  shard; materialize-graded-identities after). `repair-isauto` dry (before
  the CPA ruling): 56 of 498 products reached, REPAIRED 72,213 (healed 27,218
  field→id, moved 37,310, folded 2,994, replaced 4,691) but **122,791
  refusals — the same setKey-field-vs-slug drift** (`topps` vs
  `topps-series-1`), so `conform-card-profile` runs FIRST (dry dispatched
  05:50Z); the 2026 Topps Series 1 prefixes (BSA, 91A, MLMA, HLAR, 75YA …)
  and 2025 Chrome Update (CRDA, AC, RA, 90CUA) are ruled auto 2-0 / 1-0 by
  the checklists; BDA on 2025 bowman/basketball has no other family (630
  rows). isAuto dry with CPA forced (33280807658) still running.
  **`conform-card-profile` dry (33281366096, 06:40Z): profileVersion 3,
  360k+ rows scanned in report-only (every row rewritten by design), 0
  failed → APPLY ×8 dispatched 06:48Z (33281825609 … 33281846820; the
  progress-gated relaunch continues each shard).** In flight at 06:50Z: the
  eight cross-source fold shards, the eight one-of-one shards, the eight
  card-profile shards, the fold relaunch, the vendor-source retire dry, the
  CPA-forced isAuto dry — 27 runner jobs. Order from here: card-profile →
  isAuto APPLY (CPA forced) → materialize-graded-identities (after one-of-one)
  → D3c re-ingest → conform-holdings APPLY → reprice-all → audit-all-holdings;
  the two retires (old-CLC floor-gated; vendor-minted) wait on Drew's
  dispatch (classifier) and the vendor dry run's banner.
  **Card-profile shards 0/1 (08:05Z): wrote 471,799 / 528,460 rows, 0
  failed — and exited RED: intended counted every row seen (3.77M, kept for
  shard stability) while skipped declared neither the other slots' 7/8 nor
  the already-clean rows → UNACCOUNTED 87.5% (the sibling-counter shape).
  #1499 declares both; shards 2–7 run the old accounting (writes fine, exit
  red for the same reason). D18 (building, `feat/d18`, the single builder):
  cron writers reconcile, the nine progress-gated relaunch steps become
  marker-keyed, runner flag hygiene.**
  **Drew (08:40Z): holding 7a90172d — "How is this not linked to a card yet?"**
  Theo Gillen 2024 Bowman Draft CPA-TG Blue Refractor /150 PSA 9. It IS
  linked, to the wrong forms: `hobbyiqCardId` = the UN-numbered twin (now
  folded away — the row is MISSING), `cardId` = a `sales-attested`
  `bowman-chrome` row (0 sales); the checklist card
  `…:bowman-draft:cpa-tg:blue-refractor:auto:num-150` exists (CLC, 5 raw
  sales). The conform-holdings APPLY moves it there. Two bugs it exposed,
  fixed in **#1501**: (1) the exact-pool gate formed the `:num-N` candidate
  only from the holding's `printRun` field — this holding has none — so it
  saw 0 sales under the un-numbered id and let a **sibling-parallel $3.26**
  through; `exactSalesCountQuery` now counts `STARTSWITH(id + ":num-")` for
  an un-numbered hiq candidate; (2) that sibling rung was persisted as
  `valuationStatus: observed`, `isEstimate: false` — `estimatesAreNeverObserved`
  at `writeUserDoc` relabels any non-exact-pool rung (`estimate_relabelled_at_
  write`). Deploy #5 33283468648. **Process slip:** #1501 merged with the D16
  contract test red in the run — a failed FILE (its `beforeAll` hook timed
  out at 30 s under load) with zero failed TESTS, and my gate counted tests;
  it passes alone on main (23/23). The gate reads vitest's exit code from
  here on.
  **Drew (10:20Z): "search select to inventory … isn't selecting the right
  card … it is the blue refractor, but priced super low and has no comps
  when I know there are comps."** Replayed the web's `/api/search/cards`
  dispatcher read-only: the full query ranks the checklist card #1; the
  short ones are honest ambiguity (`theo gillen blue refractor` ties five
  real Gillen Blue Refractors at 0.9 — 2025 Bowman #BTP-76, 2024 Draft
  #BD-73, Bowman's Best, Bowman Chrome #BMA-TG, the CPA-TG auto; `2024
  bowman draft theo gillen blue` ranks the base card's Blue /150 first
  because the query never said refractor or auto) and the rows show year /
  set / #number / Auto, so the pick is the user's. The price and "no comps"
  are the identity forms: `hobbyiqCardId` on the folded-away un-numbered
  twin, `cardId` on a sale-minted `bowman-chrome` row, while the checklist
  row `…:num-150` holds 5 raw sales → **conform-holdings APPLY dispatched
  10:30Z (33284403692; dry #3's corrections are exactly the numbered-twin
  moves: Gillen, Caminiti, Griffey Radiance /1000, Sykora, Max Williams Gold
  /50 — the Max Williams Refractors still land on the un-numbered row until
  the cross-source folds finish, then a second pass) + Drew's reprice
  (33284407911)** — the after-number is this holding's FMV from its 5 sales.
  Runner landings by 10:30Z: card-profile 8/8 (writes good, exits red on
  the pre-#1499 accounting), one-of-one shards 0/2/3/4/6 (≈28k repairs
  each), re-ingest #2 shards 3/5.
  **The conform APPLY (33284403692) corrected 10 but SKIPPED Gillen:** the
  new row rule counted `…:num-150:psa-9` / `:psa-10` — graded children —
  as numbered twins and called the card ambiguous (Caminiti, with no
  children yet, went through and now prices $205.40 from its own pool).
  **#1506:** `numberedTwinsOf()` matches `<id>:num-N` exactly and the
  candidate query excludes graded rows; **APPLY #2 (33284681106) moved both
  Gillen Blue Refractor holdings to `…:num-150`** (8 corrections, reconciled);
  reprice #3 dispatched (33284849571). The pool behind that card: five raw
  sales — $125, $161.50, $192.51, $250 (2025) and **$729 on 2026-08-20** —
  and the projection's 60-day window holds only the last, so the raw
  holding reads $729 (`exact-pool-weighted-median`): the projected-next-sale
  doctrine at n = 1, D16's flagged judgment call — **NEEDS DREW (below)**.
  Deploys #5/#6 live (`ca2c467`). **Reprice #3 (33284849571, 12:40Z): 44
  requested / 32 repriced. Gillen raw holding $729 `exact-pool-weighted-
  median` (observed, window 180d, n = 2); Gillen PSA 9 holding $885.37
  `grade-curve-estimate` (estimated: this card's own raw sales × the
  empirical PSA 9 ratio) — was $3.26 sibling-parallel "observed"; Caminiti
  $205.40 from its own pool; the three Max Williams Refractors $18.74
  `exact-pool-projection` (n = 29 in 60 days) on the un-numbered row until
  the cross-source folds land.** Gap seen on the way: Max Williams Gold
  Refractor /50 carries $32.46 with NO rung and `valuationStatus: observed`
  — a pre-rung legacy price the write-time firewall (#1501) cannot see; the
  next reprice-all re-stamps every holding, and the firewall should also
  treat "priced with no rung" as not-observed (queued, small).
  Runner landings by 13:00Z: one-of-one 7/8 (≈28k repairs each, ~2.9k
  setKey-drift refusals per shard for the second pass), re-ingest #2 6/8
  (each shard now "kept the existing row" for ~95% — the identity is held
  at the canonical id, as D3c said).
  **reprice-all #2 (33285350714, 13:25Z, after the conform pass): 12 users,
  91 requested / 49 repriced / 42 skipped (pending-review + the confidence
  gate); the write-time firewall fired on a `same-printrun-cross-parallel`
  rung persisted as observed (`estimate_relabelled_at_write`), and the
  unidentified Marek Houston holding stayed withheld. `audit-all-holdings`
  MODE=all dispatched right after (33285582918) — its RUNGS block is the D10
  after-number against 14/92 clean, fmvRung null 38%, estimate shown 23%,
  isEstimate with an exact pool ≥ 3: 8 of 23.** **Result (33285582918,
  14:25Z): 91 holdings — clean 21 (was 14), fmvRung null 27 = 29.7% (was
  38%), non-exact rung 15 = 16.5% (was 27.2%), cardId ≠ hobbyiqCardId 25 =
  27.5%, cardId not hiq 10 = 11%, estimatedValue shown 0 (was 22.8%),
  isEstimate with an exact pool ≥ 3: 9 of 17. Rung labels now on the wire:
  exact-pool-weighted-median ×25, exact-pool-projection ×17,
  grade-curve-estimate ×13, exact-pool-leading-edge ×6, last-sale ×1.** The
  identity backlog is the acquisition list: noSlug 22, notInCatalog 14,
  unbacked 16 (vendor-minted rows Drew said GO on), twinOfNumbered 2 — the
  vendor retire + D3c re-ingest + a second conform pass close most of it.
  The 23 PRICE-OFF-POOL flags were mostly an audit artifact: a graded
  holding compared to the RAW pool median (PSA 10 1991 Score Griffey $229
  vs a $2 raw median; the Tiffany Maddux $1,757 vs $55; the Judge; the
  Aaron). **#1515:** the flag compares to the holding's own tier; audit #2
  33285811376. What remains real in that list is the n = 1 window (Gillen
  raw $729 vs a 5-sale median of $192.51) — Drew's rule. **Audit #2
  (tier-aware, 16:45Z): clean 30 of 91 (was 14/92 at the start of D10),
  priceOffPool 10 (was 23), isEstimate while an exact pool ≥ 3 exists: 0 of
  17 (was 9), fmvRung null 27 / non-exact 15 unchanged — the identity
  backlog.** **Cross-source fold, generation 1 (eight shards, each at its
  140-min budget, 17:00Z): FOLDED 63,204 (vendor/user twins ≈ 20k, 1/1 by
  definition ≈ 2.5k, cross-source ≈ 40k), sales re-pointed 123,771, graded
  children retired 14,253, 6,592 refusals (the setKey-field drift, now
  healed by card-profile), 2,221 same-source-lists-both left alone; each
  shard scanned ≈ 4.7M of the 7.0M base ids — the marker-keyed relaunch
  children (generation 2, 33286102649 … 33286125906) finish the rest.**
  **Vendor-source retire dry (33280778780, 17:50Z, REPLACED_BY=none over
  cardsight, cardhedge, pool, the three sold-comps stubs, tree-builder-v1,
  ebay-browse): 2 of 69 hiq-identified holdings point at one of those rows
  (they become unresolved — the acquisition list); the dry hit its budget
  before the per-row totals. APPLY ×8 needs Drew's dispatch (classifier) —
  see NEEDS DREW.** **isAuto dry with CPA forced (33280807658): 1,534
  (product, prefix) pairs — 975 ruled, 0 refused; 136,110 rows to repair
  (healed 47,940, moved 69,781, folded 5,572, replaced 12,817); the 147,745
  "failures" were the setKey-field drift, since healed by card-profile →
  APPLY ×8 dispatched 18:05Z (scope=CPA; 33286986728 … 33287013122).**
  **Re-ingest #2 complete (8/8, 18:20Z), every shard reconciled** — the
  converter's page-shape fixes and the tie-break are on every staged source;
  `audit-source-coverage` #2 (identity-based, old CLC vs new) dispatched
  18:25Z — its number decides the floor-gated retire Drew dispatches.
  **isAuto APPLY, first shards (19:20Z):** shard 1 repaired 28,222 / refused
  25,575; shard 6 repaired 2,817 / refused 22,912 — the refusals are NOT the
  drift card-profile healed: `moveCatalogRow: newSlug says setKey
  "topps-chrome" but the row says "topps-chrome-update-series"` — **the id's
  setKey segment is the collapsed parent product (`computeHobbyIqCardId`)
  while the row's `setKey` field carries the real product.** Measured
  read-only (sample 4,000 per family): topps-series-1 → `topps` 75%
  (250k rows), topps-series-2 → `topps` 78% (261k), topps-update-series →
  `topps-update` 63% (187k), topps-chrome-update-series → `topps-chrome`
  76% (169k), **bowman-draft-1st-edition → `bowman-draft` 94%** (3.7k —
  Drew's ruling says different products), upper-deck-series-1 →
  `upper-deck` 100% (12k), topps-heritage-high-number → `topps-heritage`
  78% (51k), leaf-vivid / leaf-metal → `leaf` 56% (300k), and Donruss both
  ways (panini-donruss → `donruss` 63%; donruss → `panini-donruss` 36%) —
  **≈1.19M rows in these families alone.** The movers refuse rather than
  guess (right). This is the setKey vocabulary decision the memory flagged
  ("normalizeSetKey collapses products — consistent but wrong identity; a
  vocabulary decision, not an ingest patch") — **NEEDS DREW (below) → D23.**
  Also seen: parallel slugs with the odds glued in
  (`negative-refractor-181-hobby-138-jumbo-…-mojo-refractor`) from an older
  ingest — the name-cleaning pass's population.
  **Runner landings by 15:30Z:** `conform-one-of-one-parallels` 8/8 shards —
  ≈224k rows repaired (moved ≈200k, folded ≈18k, replaced ≈6k), ≈82k
  regenerable graded children retired, ≈23k refusals (the setKey-field
  drift the card-profile pass has since healed) for a second pass;
  re-ingest #2 7/8 (each shard ≈95% "kept the existing row" — the identity
  is held at the canonical id); the vendor-mode fold relaunch (single slot)
  folded 236 one-of-one twins and stopped at its budget — its marker-keyed
  relaunch continues it, though the cross-source ×8 fleet covers the same
  base ids. `materialize-graded-identities` ×8 dispatched 15:32Z
  (33285887598 … 33285911031) to rebuild the graded children behind the
  moves; the second one-of-one pass follows it. Drew (22:30Z): "I see 2 max williams superfractors …
  superfractors are 1/1" — bcp's un-numbered `superfractor:auto` beside
  beckett's `:num-1`, and the same pair on Refractor /499, Black /10, Red /5,
  Red Lava, Sky Blue. **#1470:** the fold's decision is a pure tested rule
  (`foldTwinRule.ts`): vendor/user twins fold as before; a SuperFractor or
  printing plate folds into its /1 whatever its source (CF-A-SUPERFRACTOR-IS-
  ONE-OF-ONE; mis-parsed print runs beside the /1 no longer make it
  ambiguous); `MODE=cross-source` folds a checklist twin whose own source
  lists no numbered variant (one source omitted the print run another lists
  — only-improve) and leaves a source that lists both alone. Cross-source
  dry run 33274650026. The catalog has 50,966 un-numbered SuperFractor rows
  and 158,741 un-numbered printing plates (+7,149 at "/4") → D15's third
  script `conform-one-of-one-parallels`. `merge-bare-colour-parallels` 2025:
  8,877 chrome bare-colour rows, 1,861 with a long-form twin → APPLY
  dispatched 22:52Z (33274680156) — **wrote 1,873, reconciled (intended
  59,676 = written 1,873 + skipped 57,803)**; the 7,068 with no long-form row
  need a rename mode (queued). `repair-trailing-comma-player-names` APPLY
  (33275249458): **11,702 repaired, 1,804 of them graded children, 0 failed,
  reconciled** — "Ethan Petry," is "Ethan Petry" again. Web picker fix #1466 deployed (SWA run 33273147531).
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

    **D19 — the pool keeps every sale once (built on `feat/d19`, 2026-08-30, 4
  commits, unmerged; backend/src unchanged — no deploy).** D9 / D12-a fixed
  every FUTURE user emit; the D14 probe measured what the OLD rows still
  carry, and D19 is the backfill: two report-only, sharded, marker-relaunched
  runner scripts over one helper. **The helper**
  (`scripts/lib/relocate-sold-comp.cjs`): /cardId is the partition key, so a
  re-key is a new document plus a delete — the helper writes the kept row,
  reads it back (id, cardId and a stamp field must match), and only then
  deletes the old rows one by one; an upsert or read-back failure deletes
  nothing, a failed delete is a DUPLICATE reported on its own line and never
  retried into a missing row (tca-match-enricher's delete-then-create is the
  opposite order). **`rekey-user-comps`** (ebay-user-purchase +
  ebay-user-sale, 110 rows): LINK the row to its holding (the `holding::`
  key, the eBay order / item id it carries, or — sales — the ledger entry
  with the same soldAt instant and price); IDENTITY by D12-a
  (holding.hobbyiqCardId → holding.cardId-if-slug → the row's own
  hobbyiqCardId, each only when the catalog holds it, else UNRESOLVED with a
  reason); KEY by D9 (`purchaseSaleIdentity`: order id → item id →
  holding::, price = SUBTOTAL; a sale: ledger.ebayOrderId → the holding's
  ids → the D7b timestamp key); rows deriving one (id, cardId) are one
  transaction — what varied is printed before the word duplicate, two grades
  or two parallels REFUSE. Dry run (read-only, 2026-08-30): 2 already
  canonical, **58 would re-key** (33 onto the order id, 34 keep their key and
  change partition only), **4 would collapse** (7 documents → 4: the import's
  `holding::` row beside the poll's row, or one `holding::` id under two
  partitions), 0 refused, **42 unresolved** — 34 `slug-not-in-catalog` (the
  row's only slug is a retired or never-minted row:
  `2026:bowman:cpa-oc:refractor:auto`, `1997:topps-finest:238:base`,
  `2024:bowman-chrome:cpa-id:refractor:auto` … — D10's acquisition list, not
  a re-key), 7 `holding-two-identities`, 1 no identity; 54 of the 110 rows
  name holdings that no longer exist and re-home on their own slug with the
  key kept. Two rulings to read (NEEDS DREW if either should go the other
  way): (1) a re-keyed purchase takes D9's SUBTOTAL from its purchase record —
  **30 rows move from totalCost to subtotal** (74.86 → 64, 1,260 → 1,250 …),
  the price the live import has written since #1454; (2) a holding whose
  cardId and hobbyiqCardId are BOTH hiq slugs and disagree (the D9
  two-identities finding: `…cpa-ce:red-refractor:auto:num-5` vs
  `…cpa-ce:chrome-refractor:auto`) may not move a sale off a catalog-held
  slug on a coin toss — 7 rows wait for conform-holdings.
  CF-A-SALE-IS-NEVER-LOST prints the count per source and per contributor
  before and after: 110 → 106 expected (= 110 − 65 deleted + 61 created; the
  4 collapses are the only net change), a mismatch is exit 4.
  **`collapse-ch-dual-ids`**: 1,842 `ch-comp::` rows (a shape nothing writes
  today) name 105 CH cards; every partition read whole (11,296 rows) and
  grouped by (day, price cents): **979 pairs** (one row of each shape), 73
  ambiguous groups, 784 comp rows the daily path never saw. The variance
  histogram, before any rule: soldAt 100% (the two paths report different
  times of the same day), imageUrl 99.9%, parallelSlug 88.5%, parallel
  78.4%, hobbyiqCardId 72.9%, setName 71.8%, title 70.2% (the comp path kept
  the real listing title; the daily path composed `YEAR SET #NUM VARIANT`),
  cardNumber 30.8%, isAuto 12.8%, printRun 9.5%, grade 7.9%. **Refused 660
  of 979**: parallel-differs 517 (`Base → Mojo Refractor` 80, `Base → Chrome
  Refractor` 72, `Reptilian Refractor → Blue Refractor` 35, `Refractor →
  Base` 32 …), grade-differs 77 (RAW → PSA 10 ×43, RAW → PSA 9 ×33),
  auto-differs 49, cardnumber-differs 17 — two rows that disagree on the
  grade or the parallel are two sales by the rule, and the parallel table is
  a finding in its own right: for ONE CH card id the comp path stamped a
  parallel the daily path's title never said (the retired warm-pool shape) —
  a question for the writers, not a licence to guess here. **Would collapse
  319** (kept ch-daily 164 / ch-comp 155 — a catalog-held slug outranks a
  title, then the real title outranks the composed one; imageUrl folded 155,
  composite 74, parallelSlug 60; the dropped row's title / slug / parallel
  ride on `collapsedFrom`). Tests (`d19.poolKeepsEverySaleOnce`, 31 cases):
  the link, the derivation through the real `purchaseSaleIdentity`, the group
  plan and its refusals, the pairing, the CH decision, the helper against a
  fake container (create fails → nothing deleted; read-back differs → nothing
  deleted; delete fails → duplicate reported, tried once; 404 → not ours),
  and the fleet discipline (report-only default, BACKFILL_APPLY, the marker,
  reportWrites, whitelist + marker-keyed relaunch); seven mutation checks
  red. The reconciliation guard's write net learns `relocateSoldComp(`, so a
  script that writes only through the helper is a writer to it (runner
  writers reconciling 33/79 → 35/81; marker-printers relaunched on the marker
  25/28 → 27/30; the debt lists unchanged). Dispatch
  after merge: `rekey-user-comps` apply (one slot, 110 rows), then
  `collapse-ch-dual-ids` apply (105 cards), then re-run `audit-pool-identity`
  — the after-numbers are user purchases keyed by the order id with cardId
  hiq for every linked row, and (day, price) pairs under two shapes = the
  refused 660 only. Not touched: `manual-user-entry` (`admin-manual::` keys,
  3 rows) and the 360,872 CardHedge rows keyed by a bare bubble id.
    **Merged #1508 (12:05Z 08-30)**, exit-code gate (tsc 0, vitest 0 over 69).
    Dry runs (prod, LIMIT=200): re-key 110 user rows → 58 re-keyed (33 onto
    the D9 order id), 4 collapsed, 42 unresolved (34 slug-not-in-catalog =
    the acquisition list, 7 two-minded holdings held for conform, 1 no
    identity), 30 prices move to D9's subtotal; CH dual ids 979 pairs → 319
    collapse, **660 refused** (parallel differs 517 — Base→Mojo Refractor 80,
    Base→Chrome Refractor 72 …; grade differs 77; auto 49; number 17): the
    comp path stamped parallels the daily path's titles never said — a writer
    finding, not a merge. **APPLYs dispatched 12:08Z** (rekey 33285006502;
    collapse 33285011415). Incidental: `catalogSlugIfExists` tested
    `/:num-d+$/` — a literal d — so the un-numbered-twin fallback behind
    #1473's fill-only adoption and the gate's twin lookup never fired;
    **#1509** fixes it (deploy #7 33285176280). **D20** (building, `feat/d20`,
    the single builder): the web renders the rung/provenance chip, the
    BuyerIQ median fallback goes, the recent-comps median stops posing as a
    stat, the dead identify call becomes an honest page, the picker shows the
    last sale + count, the 17 pre-existing web tsc errors go.
    **D19 APPLYs landed (13:20Z):** rekey — 110 user rows → **59 re-keyed**
    (34 onto the D9 order id), 4 transactions collapsed (7 docs → 4), 41
    unresolved (33 slug-not-in-catalog, 7 two-minded holdings, 1 no
    identity), 0 failed, 0 duplicates left; pool before 110 → after 106 =
    110 − 66 deleted + 62 created — CF-A-SALE-IS-NEVER-LOST holds,
    reconciled. Collapse — 319 CH pairs collapsed (kept ch-daily 164 /
    ch-comp 155; folded imageUrl 155, composite 74, parallelSlug 60), **660
    refused** as two sales (grade 77, parallel 517, auto 49, number 17 —
    e.g. CH card 1746983719903x669… daily=RAW Refractor CPA-TW vs comp=PSA 9
    on the same day and price: the comp path's grade/parallel stamps
    disagree with the daily path's titles — the writer finding stands).
    Deploy #7 live (`6d0faa9`, the twin regex). **#1512 (deploy #8
    33285570523):** the write-time firewall also relabels a priced holding
    with NO rung as an estimate (`no_rung_relabelled_at_write`) — the Max
    Williams Gold /50 $32.46 "observed" shape.

- ○ D21 **The grade curve is the graded card, and the page says how sure it
  is** (Drew, 2026-08-30 15:50Z: "add to our list on the grade curve to be
  directly linked to the graded card ID? Something to show accuracy of the
  entire card page"). Queued behind D20 (one builder at a time).
  (a) **Every grade-curve tier row is keyed to its own graded identity** —
  the materialized graded row (`…:num-150:psa-10`) is the tier: the one
  entry (`valueIdentity`) returns each tier with its graded id, that tier
  reads the exact pool under that id (grade-consistent rows), and the card
  page / card-panel / grade-curve responses carry `tierCardId` so a tier is
  a card the user can open (recent sales, holdings, listings) — not a
  derived number. Where no graded row exists yet, the tier says so
  (`materialize-graded-identities` mints it; never mint from the page).
  (b) **A card-page accuracy panel built from facts, not a score:**
  identity — checklist-backed (which source, when last seen) or provisional;
  pool — per tier: n in the window used (60/90/180), last sale date, the
  rung label (observed vs estimate) and the comps behind it; provenance —
  what priced each tier and why (`fmvReason` when null); and "what would
  make this better" (a checklist to acquire, a tier with no sales, a twin
  to fold). One shape on the wire for iOS and web; the web renders it via
  D20's provenance chip work. Acceptance: `probe-price-routes` gains a
  per-tier identity check (every tier id exists as a catalog row and its
  pool rows carry that id), and the card page for the Gillen Blue /150
  shows PSA 9 as `…:num-150:psa-9` with its own (empty, today) pool and the
  raw-derived estimate labelled as such.

    **D20 — the web says what the engine says (built on `feat/d20`,
  2026-08-30, 8 commits, unmerged; `apps/web` only — deploys on merge via
  `deploy-web.yml`, no backend dispatch).** Group F's web findings, each
  its own commit. **(1) The rung is rendered.** `lib/rung.ts` mirrors the
  CLOSED vocabulary in `fmvRung.ts` (6 exact-pool + 19 fallback + no-basis)
  and turns a label into words — "projected from 5 sales of this card",
  "estimate from sibling parallels", "estimate from the grade curve" — with
  observed / estimate / unpriced / unknown; a label the web does not know
  renders as `unknown rung "<label>"`, a missing one as "rung not
  reported", never hidden and never assumed observed. `holdingProvenance()`
  reads the envelope's `method.ladderRung`, then
  `pricingSourceMeta.method` (holdingValuation's stamp — the envelope
  builder's `buildMethod` does not know `unified-pricing` and reports
  `kind: "unknown", ladderRung: null` for every one-path holding; a
  backend follow-up), then the flat `fmvRung`. `ProvenanceChip` renders
  it under the number on the holding detail (the curve tile's rung when
  the curve priced the grade, the persisted holding's otherwise), the
  portfolio row, the card page hero (tile `rungLabel` / price-by-id
  `rungLabel`, `source` as the legacy carrier; the footer's "source:"
  string is gone), each grade-ladder tier, and every grade-curve tier.
  The legacy `gradeBreakdown` ladder tier (vendor ids the catalog cannot
  name) showed `medianPrice` as its number — it now shows the tier's
  LAST SALE, labelled "legacy breakdown, rung not reported". **(2)
  BuyerIQ** fell through `trendAdjustedValue → weightedMedianPrice →
  value` and printed a pool median as "Market $X"; `lib/gradeCurveValue.
  pickGradeCurveTierValue()` is `trendAdjustedValue ?? value` (positive
  only), the medians never read, "No price yet" + the engine's reason
  (`fmvReason`) otherwise, the rung chip beside the number. **(3)
  RecentCompsList** computed a client-side median and rendered "Median
  (n)" in the stat row directly under the FMV; the row is now "Sales
  shown — facts about the list below, not the value above": count, low,
  high, newest. **(4) The identify page** posted the uploaded blob to
  `POST /api/portfolio/identify`, which has never had a handler (upload,
  then 404); `identifyCardFromBlob()` and its types are deleted, the page
  says photo identification is not available on the web yet and links
  Search / Add-a-card, no route invented. **(5) The catalog picker's**
  number was `salesSummary.median30d` labelled `med` (#1466); the search
  hit carries no last-sale PRICE (`salesSummary` = count, medians,
  `lastSaleAt`, trend), so the row shows "N sales · last YYYY-MM-DD" and
  no dollar figure. **(6) tsc:** the 16 pre-existing `TS18047` errors
  (`params`/`searchParams` possibly null, nine pages) reproduce only when
  `next-env.d.ts` carries `next/navigation-types/compat/navigation` —
  the OneDrive checkout's generated file does, a fresh `next build`'s
  does not (which is why the deploy was green); every read is now
  `params?.get(...) ?? default`, 0 errors under both. **(7) Tests:**
  `apps/web` gains vitest (node env, pure helpers only, 27 cases): the
  rung words and the legacy-engine wording, a contract pin that reads
  `fmvRung.ts` + `CanonicalFmvMethod` + `HobbyIqFmvMethod` from backend
  source and requires the web's list to equal them, `holdingDisplayValue`
  / `fmvPerUnitOf` (observed before estimate, cost-proxy never a value, a
  declined envelope never falls through), and the tier pick (never a
  median). **Gates:** `tsc --noEmit -p apps/web` 0 (fresh next-env and
  with the compat reference), `next build` 0, `npm test` 27/27 exit 0.
  **Not done / flagged:** no screenshots (no session, no prod calls); the
  envelope builder's `unified-pricing` gap above; `/api/players/:name`
  tiers and the grade-analysis ROI are still backend medians shown as
  prices (group F, not in D20's list); the marketing pricing page still
  lists "Card scan / auto-identify". Turbopack refuses a junctioned
  `node_modules` ("points out of the filesystem root"), so the worktree
  was built from its own `npm ci`.
    **Merged #1519 (16:20Z 08-30); SWA deploy 33286215812.** Verified in the
    canonical checkout after `npm install` (the branch adds vitest) and a
    cleared stale `.next`: web tsc 0, 27/27 tests exit 0. Flagged backend
    gap: `pricingEnvelope.builder.buildMethod` does not know
    `unified-pricing` (`method.kind: unknown`); the web reads
    `pricingSourceMeta.method` meanwhile — queued (small).
  **Drew (16:00Z): holding deced7d3 — "trending up and no $18 purchases
  recently."** Max Williams CPA-MWI Refractor, raw: sales by week May-w2
  $16.99 ×2, May-w3 $10.94–$25 ×4, Jun/Jul $10.51–$15, Aug-w1 $30, Aug-w2
  $19.50–$21, **Aug-w3 ×10 $25–$38 (median $30, last $38)**; persisted
  **$18.74 `exact-pool-projection`** — anchored on the 60-day window's
  median ($14) plus the slope (12%/wk), so it sits below every one of the
  last ten sales. The mirror of Gillen's one-sale $729: the projection must
  be anchored on the LEADING EDGE. **Drew (16:10Z): holding 3fe98abe — "this
  is an image variation, is that accounted for?"** No: 2020 Bowman Draft
  Witt #BD152 (PSA) has no variation field, the catalog has no
  image-variation row for it, D3c's `sectionsOf` folds a lone "Variation"
  section into Base (wrong: an SP image variation is its own card), and its
  only pool row is a **2020 Bowman Draft 1st Edition** sale ($4) under the
  plain Draft id — a product qualifier the title says and the slug lacks.
  → **D22** (building, `feat/d22`, the single builder): the projection
  anchored on the leading edge with the n = 1 policy as a named default
  (Drew can flip), image/photo variations as their own identity
  (vocabulary → glossary, converter, title parser + seam, holding
  derivation), and `repair-parallel-from-title MODE=product` (a title's
  "1st Edition" / "Sapphire" / "Chrome" / "Update" never pools under the
  plain product; unmatched → acquisition list). D21 follows D22.
  **Drew (17:35Z): "image variations are typical in card sets, so we need to
  fix that"** → D22's variation work is a CLASS across products (Topps SP /
  SSP photo variations every year, Bowman and Bowman Draft image variations,
  Heritage action / throwback, Chrome / Prizm, Stadium Club): inventory
  first (variation sections per source and product family from the cached
  pages; catalog rows already carrying variation words vs sections the
  converter folded into Base), a vocabulary for the family, every converter
  path, the title parser + seam, the pool repair, and holdings carrying the
  variation in `parallel`. Memory: image-variations-are-their-own-card.

    **D22 — the projection is the leading edge; a variation is a card (built
  on `feat/d22`, 2026-08-30, 5 commits, unmerged; backend/src changed —
  dispatch "Daily 5AM ET Refresh & Deploy" after merge).** Two measured
  defects (Drew, 08-30). **A. The projection lagged the leading edge.** Max
  Williams CPA-MWI Refractor raw (holding deced7d3): ten sales at $25–38 in
  the newest week, $12–21 before; persisted **$18.74** `exact-pool-projection`
  ("window=60d n=29 median=$14 trend=up 12.1%/wk"). The OLS fit's level was
  the WINDOW's centroid — the mean price at the mean date, five weeks back —
  so the slope carried a $14-era level forward and never reached the market
  that had just paid $25–38 ten times. `projectFromLeadingEdge`
  (nextSaleProjection): the level is the pool's recency-weighted median at
  its own recency-weighted time, and the window's OLS trend moves it forward
  from THERE to now; the newest-sale ±25% band and the slope-sanity cap stay.
  Fixture (Drew's weeks, through `valueIdentity` on the mocked reader):
  **$35.15** — anchor $30 sitting 13.2d back, +9.1%/wk applied 13.2d,
  predicted +7d $37.88 — inside the last ten sales' range, was $18.74. **The
  n = 1 policy** (Gillen CPA-TG Blue /150, afd40fed: 180d window n=2, the
  $729 sale carries >99.9% of the recency weight, so the weighted median WAS
  the one sale): `ONE_SALE_WINDOW_POLICY` in unifiedPricing — **default
  `last-sale`, Drew's ruling 19:50Z: "Keep — the latest sale is the market"**
  → **$729** under `exact-pool-last-sale` (the label now says one sale carried
  it; was `exact-pool-weighted-median`), the basis printing what the named
  alternative would say; **`widen`** (off; `ONE_SALE_WINDOW_POLICY=widen`): a
  one-sale window does not win on its own — the widest window's leading edge
  (median of the newest ≤ 3) stands under `exact-pool-leading-edge`, **$489.50**
  for Gillen. A carrying sale that AGREES with the leading edge (within 25%)
  leaves the weighted median standing; exactly one sale in 180d stands under
  last-sale in either policy. Every tier carries `projectionNote` (what the
  rung did) and `windowNote` (the cascade's path); the basis states the window
  choice ("window=180d [60d n=1, 90d n=1, 180d n=2, 180d with all 2]"), the
  anchor and the note. Persist stamps untouched; the D16 contract's THIN
  fixture ($0.88 at 12d, $0.15 at 60d — the same shape) pins
  `exact-pool-last-sale` $0.88 (same number, honest label). Not changed: the
  gated ladder's own rungs (`projectNextSaleFromComps` branch 1) still anchor
  on the window centroid — follow-up. **B. Image variations are not a card
  yet** — "image variations are typical in card sets, so we need to fix that";
  "it will have the same card number but be called IV, Image Variation or
  other uses in sold comp data"; the PSA label on holding 3fe98abe reads
  "2020 BOWMAN DRAFT #BD152 BOBBY WITT JR. SP-CHROME MINT 9". **Inventory
  (read-only, 08-30):** the catalog holds **1,066 distinct parallel spellings**
  with a variation word — Clear Variation 4,888 vs Clear Variations 700; Ssp
  2,792 vs SSP 2,587; Image Variations 1,886 vs Image Variation 1,460 vs IMAGE
  VARIATION 350; Golden Mirror under five spellings (1,034 / 760 / 1,129 / 391
  / 350); Lightboard Logo under two (1,744 / 1,724) — by source
  checklistcenter 22,883 + 21,264, cardboardchecklist 15,624, checklistinsider
  14,502, bcp ~13k, beckett ~6k, ingest-auto-seed 6,252; by product
  topps-chrome 18,688, topps-heritage 9,767, allen-and-ginter 8,661,
  topps-series-1 7,116, topps 6,385, topps-update-series 5,502, bowman 3,646,
  bowman-chrome 3,519, stadium-club 2,816, bowman-draft 1,046; 65 html-path
  `subsetName`s carrying "variation" (Donruss / Optic / Stadium Club "Base
  Variations Set" — the blank-parallel residue D3c named). On 29 real CLC
  pages the converter emitted **101 variation (section|finish) keys, 30 of
  them BLANK under an `insert:image-variations`-style category — the plain
  card's own id**; the rest plural ("Clear Variations"), "Variations"-only
  under an insert's name, or "Super Short Prints". Pool: **443,988 rows under
  BASE slugs of 15 products with variation sections; 8,937 (2.0%) titles carry
  a variation token** — bare SP 5,194 (much of it "SP Authentic" and
  short-printed INSERTS), SSP 1,780, Variation 1,011, Short Print 775,
  Image/Photo Var 75, IV 77 (74 of them "Iván"), Var 25. **Vocabulary**
  (`variationVocabulary.ts`, glossary §3): `image-variation` (SP is the
  default tier, not spelled; `-sp` is an accepted alias and folds),
  `image-variation-ssp`, `<kind>-variation` for a named kind (golden-mirror,
  true-photo, clear, team-color, lightboard-logo, murakami, frozenfractor,
  action, throwback-uniform, nickname, color-swap, chrome — Heritage only —,
  black-&-white, rookie-design, wbc-flag, retrofractor …; image/photo come off
  only when what remains is a KNOWN kind, so "True Photo" keeps its photo and
  an unknown "Rookie Image Variation" keeps every word), a finish after the
  word keeps its place (`image-variation-gold-speckle-refractor`), the
  grader-label forms SP-CHROME / SSP-CHROME / SP-PAPER carry a stock word kept
  only where the checklist distinguishes chrome from paper, and a bare "SP" /
  "Short Print" is NOT a variation (Heritage's short print is the base card).
  **Identity = the base card's number + the finish**: never a twin (twins
  differ only by `:num-N` — the fold's own regex, pinned) and never folded.
  **Wired:** the slug layer (`normalizeParallel`; on chrome stock a bare
  variation is not a refractor); both title parsers (a strong form names the
  finish; weak markers SP / SSP / IV / Short Print ride to the seam — "IV"
  with Unicode boundaries, `#SSP-RC` card numbers excluded);
  `parallelTheTitleAllows` (a marker corroborates a vendor's variation tag,
  never a colour tag); `persistVendorSalesToPool` (a marker becomes a
  variation only when the product's checklist holds the plain image variation
  for that card — `variationParallelsForCard`, memoised per batch; a label's
  stock word is reduced to what the checklist holds); the holding normalizer
  (R9 `parallel_variation_vocabulary`) and `identityFromFields` (the holding
  CAN be the variation through the `parallel` it has); the PSA grader
  ("SP-CHROME" → "Image Variation Chrome"; was the parallel text "Sp Chrome").
  **Converters:** CLC xlsx `sectionsOf` anchors a variation Set value PER
  NUMBER onto the plain section holding that number (its prefix section, else
  Base, else the smallest) with the vocabulary's finish — 2024 Bowman Chrome's
  "Image Variations" mix rookies and BCP- prospects; CLC html files a "Base
  Image Variation Set" subset the same way, and "Base Paper Set" / "Base
  Chrome Set" are now the base set (2020 Bowman Draft minted no plain BD-152
  base row before); bcp's scrape reads a Variations heading as a base-category
  section with the finish; Beckett / checklistinsider already fold via
  `classifySections` (rung "Image Variation" / "SP Variation" / "SSP
  Variation" — the slug layer speaks). **After:** on the same 29 pages 160 of
  178 keys named; the 18 blank are own-numbered sections (WBC-1…, BCP-251+,
  CRAV-, "2023 AFL MVP SP") — correctly not variations of a base number.
  Fixtures, all real pages: 2024 Topps Chrome / 2023 Series 1 / 2024 Heritage
  (xlsx), 2020 Bowman Draft (the Witt page) / 2023 Stadium Club (html), plus a
  drift guard pinning the converters' CJS mirror to the TS vocabulary.
  **Product qualifiers** (`productQualifiers.ts`): "1st Edition" / "Sapphire"
  / "Chrome" / "Update" in a title move the plain setKey — the grammar now
  keeps `bowman-draft-1st-edition` / `bowman-1st-edition` (it collapsed them
  to bowman-draft; the Witt $4 sale's road) — while bowman → bowman-chrome and
  Topps Chrome Update are REFUSED and counted (the family ruling; the D6
  vocabulary collision: the grammar collapses "Topps Chrome Update" into
  topps-chrome while the checklist holds `topps-chrome-update-series`).
  `repair-parallel-from-title` gains **MODE=variation** and **MODE=product**
  (+ LIMIT, `reportWrites`, the relaunch step forwards mode / sources / scope /
  slots; out of the reconciliation debt list). **Dry runs (LIMIT=200,
  read-only, cardhedge + tca-ebay): product — 6 would re-key (2022 Bowman
  Draft → `bowman-draft-1st-edition` rows that exist), 194 UNMATCHED (no
  catalog row at the qualified key — the acquisition list; 2020 BD-152 1st
  Edition Blue Foil among them; D23's setKey rename supersedes these targets —
  counted, never minted), 0 refused in the sample; variation — 1 would re-key
  (2025 Topps Chrome #246 → `lightboard-logo-variation`), 193 markers left
  (2003 Flair `#SSP-RC` card numbers, the "SP Authentic" brand — the
  corroboration rule held).** **The Witt holding (3fe98abe):** before, the
  cert path minted the parallel text "Sp Chrome" and the holding sat on
  `bowman:bd152:base` / `bowman-draft:bd152:base`; after, the descriptor
  reads "Image Variation Chrome", the title "…#BD152 SP-Chrome…" parses the
  same, and the derivation asks the catalog for the variation — **NOT FOUND
  today**: the catalog holds no variation row for 2020 BD152 until the 2020
  page is re-ingested with this converter (then the label's "Chrome" reduces
  to the page's plain `image-variation`, which has no chrome/paper split).
  **Flagged:** the html path slugs the number `bd-152` (slugify keeps the
  hyphen) while the bccp rows and the holding say `bd152` — a card-number
  normalisation ruling (BD-152 ≡ BD152) is needed before that identity
  resolves; "Logofractor Edition" and "Complete Set" are product qualifiers
  the table does not carry yet; the CLC html path's `insert:` category prefix
  vs the ingester's `insert-` check is a D3c question this build did not
  open. **Gates:** tsc 0; vitest 0 over the required set + `projectionIsThe-
  LeadingEdge`, `variationIsACard`, `variationSectionsOnRealPages`; **mutation checks
  (each reverted, each red):** the anchor without recency weighting (half-life
  → 100,000d: the old window centroid) → Max Williams red; the policy default
  flipped to `widen` → the Gillen default red; the parser ignoring the
  variation read → the abbreviation fixtures red; the seam's marker
  corroboration off → the vendor-tag test red; the slug layer without the
  vocabulary → the slug table red; the converter filing "Base Paper" as an
  insert → the Witt page red; the per-number anchor off → the 2024 Topps
  Chrome page red; the repair script back in the reconciliation debt list →
  the guard red.
    **Merged #1531 (21:05Z 08-30); deploy #9 33289559745.** Verified in the
    canonical checkout (tsc 0; vitest 0 over 12 files). Drew on the Witt
    holding (20:50Z): "this is bowman draft, BD clearly states it for 2020
    Bowman Draft … and is an image variation or SP" — identity = 2020
    bowman-draft BD-152 image variation (SP), chrome; the slab's "SP-CHROME"
    now reads as Image Variation, the row appears when the 2020 page
    re-ingests through the new converter (dispatched 21:20Z, YEARS=2020),
    then the conform pass resolves the holding. The BD-152 / BD152 spelling
    is D23's hyphen rule. **Per-holding identity rulings (#1530):**
    `backend/data/holding-identity-rulings.json` + `conform-holdings
    SCOPE=rulings` — Drew ruled Ohtani HMT1 → `topps-chrome-update`,
    Antunez CPA-BA and Arias CPA-FA → `bowman` (dry run then APPLY
    dispatched). `clean-parallel-annotations` APPLY ×8 dispatched 20:57Z
    (Drew: run it now; the 81,714 slash-id rows wait for a purge script).
    **Round-3 rulings (21:15Z):** BDA- on 2025 Bowman basketball — the
    builder reads the page and rules from its text; vintage — acquire TCDB
    next (→ D25, after D24); Pokémon — reopen after D23 and the retires.
    **D23 — the id carries the product (built on `feat/d23`, 2026-08-30, 5
    commits, unmerged; backend/src changed — dispatch "Daily 5AM ET Refresh &
    Deploy" after merge).** Drew's ruling, as code: (a) `productSetKeys.ts` is
    the one spelling per product, consulted by `normalizeSetKey` ahead of the
    regex vocabulary — `topps-series-1/2`, `topps-series-1-1st-edition`,
    `topps-update-series` (baseballcardpedia's "Topps Update" — 630k rows — is
    a spelling of it), `topps-updates-and-highlights` (2006–09, as named),
    `topps-chrome-update-series`, `topps-heritage-high-number`,
    `bowman-draft-1st-edition`, `upper-deck-series-1/2`, and every Leaf product
    the catalog's own field spellings name (the bare `/leaf/` rule collapsed
    all 400k of them). Only `spelled` entries take part in naming; the rest
    carry family data and leave their spelling to the vocabulary's ordering
    ("Bowman Chrome Prospects" still folds to bowman-chrome, "Donruss Optic"
    stays panini-optic). (b) **Donruss — judgment call.** Every baseball
    checklist source names the modern product "Donruss" (519,422 rows;
    "Panini Donruss" only in football, hobbymonitor and derived rows), so the
    name cannot carry the ruling; `DONRUSS_SPELLING_POLICY` (compile-time)
    does: default `panini-era` (2009+ → panini-donruss, before → donruss —
    Drew's "Panini-era products keep the prefix", and the ids already say so),
    alternative `as-named`. (c) The family is READ FROM THE TABLE, never a
    prefix of the key — `productFamilyKey`, the matcher's family step and its
    widening (exact keys in an IN, never `-series` prefixes), `deriveParentSetKey`
    and the reference ladder; an unknown key is its own family; a legacy
    spelling (`topps-update`) sits in its product's family so pool rows keep
    pricing while the fleet runs; `productFamilyIsATable.test.ts` scans the
    family modules for the prefix idioms. (d) The card-number segment keeps
    the checklist's hyphen (bd-152; US135 has none); every compare is
    `sameCardNumber`, every lookup `cardNumberVariants` (an indexable IN over
    the case / hyphen-free / hyphenated spellings): matcher, resolver, search,
    verify, the cross-setkey rung, the sibling count, the vendor-sale bands,
    the holding matcher, the rematch. `deriveCatalogEntry` writes the id's
    setKey segment into the field (both halves at mint); `productQualifiers`
    lifts the Chrome Update refusal. **Full-population estimate (read-only,
    `MODE=estimate`): 2,532,021 rows** — topps-update-series 775,578, Donruss
    (era) 378,495, topps-series-2 216,681, topps-series-1 213,779,
    topps-chrome-update-series 199,073 (incl. 27k `topps-chrome` rows whose
    setName says Update), leaf-metal 131,740, leaf-vivid 109,224, the other
    Leaf lines ≈460k, topps-heritage-high-number 39,820, upper-deck-series-1/2
    11,558 / 17,162, topps-chrome-update-sapphire 8,111 (the `-edition` field
    spelling), bowman-1st-edition 7,610, topps-series-1-1st-edition 4,396,
    bowman-draft-1st-edition 3,427; `topps-updates-and-highlights` 0 (its
    181,417 rows were slugified straight to the product and are canonical).
    **Dry runs (LIMIT=200, report-only, `rename-setkey-to-product.cjs`
    MODE=product per family):** topps-series-1 208 → moved 162 / replaced 46
    (sales 3,310, graded children 1,084); topps-series-2 208 → 116 / 92
    (1,934; 1,405); topps-series-1-1st-edition 205 → 205 moved;
    topps-update-series 208 → moved 134 / folded 3 / replaced 71 (1,204;
    1,936); topps-chrome-update-series 208 → 166 / 27 / 15 (2,775; 1,217);
    topps-chrome-update-sapphire 214 → 42 / 12 / 2 + **158 field heals**;
    topps-heritage-high-number 208 → 158 / 50; bowman-draft-1st-edition 213 →
    213 moved; upper-deck-series-1/2 208 → 208 each; leaf-vivid 208 → 155 / 53;
    leaf-metal, leaf-optichrome 208 → 208; leaf-metal-draft 207 / 1;
    leaf-trinity 204 / 4; Donruss (era) 224 → moved 64 / folded 148 / refused
    12 (`not-an-identity-row`: graded ids without a gradeTier). Zero failed,
    zero gone, zero name-over-field. The folded / replaced twins are the
    **old-CLC rows** (`checklistcenter` / `-html` minted product-spelled ids
    directly: 41,201 topps-update-series, 35,591 topps-series-2, 25,939
    topps-series-1, +22k html), so the fleet lands the new checklist row on top
    of the old-CLC duplicate wherever both exist and the retire finishes the
    rest. **MODE=hyphen** (SOURCES=bccp, LIMIT=200): 2,881 candidates → 201
    actionable (folded 179 / replaced 22 onto a checklist-authority twin),
    2,671 refused for no twin, 9 refused because the twin was a derived row.
    **MODE=holdings:** 12 users / 88 holdings — 54 canonical, 20 no id, 1
    vendor id, **1 re-point: Witt 3fe98abe `bd152` → `bd-152`** (derived,
    confirmed by point read — D22's flag), 12 unresolved (products absent
    from the catalog: 1992 Studio with an `undefined` setKey, 1987 Bellingham,
    UD Black Diamond D24 /1500, Traded Tiffany 70T, Finest ×3, Bowman's Best
    BBP4 under `bowman`, four Bowman / Bowman Chrome CPA parallels — the
    acquisition list, not D23's). Refusals: MODE=hyphen without SOURCES and
    SCOPE naming no ruled product both exit 1. **Pace:** each dry-run row is
    four round trips at ~2.5 s under today's fleet contention (24 rows in
    37 s at concurrency 8), so 2.5M rows at 8 slots × 16 is a multi-day fleet;
    dispatch at 16 slots × concurrency 24 once the current fleets finish, and
    expect ~10–15 sale patches per Topps-flagship row. **Dispatch order:**
    merge → deploy (`/api/health` sha) → `gh workflow run backfill-runner.yml
    -f script=rename-setkey-to-product -f apply=true -f mode=product -f slot=N
    -f slots=8 -f concurrency=16` (N = 0…7; relaunches on the budget marker,
    every input forwarded) → `-f mode=holdings -f apply=true -f slot=0 -f
    slots=1` → (optional) `-f mode=hyphen -f sources=bccp -f apply=true -f
    slot=N -f slots=8` → `materialize-graded-identities` (the retired children
    regenerate under the new ids) → re-run `audit-source-coverage` → the
    old-CLC duplicate retire (Drew's GO after D23) → then Drew's order below.
    Unmatched pool rows still keyed under an old spelling (no catalog row at
    `topps-update:…`) are the rematch's population; the family table keeps
    them pricing within the family meanwhile.
    **Order after D23 (Drew, 05:05Z 08-30): D28 → D26 → D21 → D24 → D25.**
    **Landed 08-30 06:50–09:10Z:** D23 merged **#1540**, deploy #11 `456c814`;
    the rename fleet dispatched **16 slots × concurrency 24** (Drew's call;
    2,532,021 rows; Donruss stays `panini-era`, 2009 boundary — Drew ruled);
    MODE=holdings re-pointed 1 (Witt bd152 → bd-152), 12 unresolved = products
    absent from the catalog (acquisition list). D28 merged **#1541**, deploy
    #12 `2cfca64`; the base-cards clean ×8 and the grade repair ×8 dispatched
    09:05Z (the classifier let those through); the remaining repair modes
    (slash / ordinal / year / nonumber), the after-measure (compare against
    45,718) and Harrison's ruling APPLY follow. D26 merged **#1543**, deploy
    #13 — the backfill runs REPORT ONLY first, then APPLY (single slot; the
    measured shard axis is 8/6-2/3-1-3-1). #1542: conform writes both id
    fields (Max Williams' cardId had kept the folded-away un-numbered slug →
    no comps) and a ruling corrects the displayed card number (Harrison read
    "#9" after moving to #150). Harrison's Ohtani: ruled onto
    `hiq:baseball:2018:topps-chrome:150:refractor:no-auto` 08:35Z; Antunez
    and Arias holdings were SOLD by Harrison 03:31Z (POST …/sell) — not lost.
    **"Fix this quickly" (Drew, 08:30Z): Max Williams Refractor** — the
    identity sat on the un-numbered `…:cpa-mwi:refractor:auto` (0 pool
    rows) while the checklist's `…:num-499` held 35 sales; conform APPLY
    33302312918 corrected 12 identities; reprice followed. The two code
    defects (the Edit-card search ranking Carson/Jett Williams 2025 Bowman
    colour refractors above Max Williams' Bowman Draft CPA-MWI Refractor
    auto; readers not falling through to an un-numbered identity's single
    numbered twin) are a two-builder workflow with three refuters each.
    **D29 — one row per card (Drew's rulings 09:40Z, building):** (1) when
    the checklist numbers a parallel, every sale-minted twin (un-numbered or
    differently numbered) folds onto the checklist's numbered row and its
    sales re-point there (322 CPA plain-Refractor autos 2020–2026 are split
    this way; Harris #CPA-MH: `…:refractor:auto` 57 sales +
    `…:refractor:auto:num-499` 1 sale + the checklist's
    `…:base-refractor:auto:num-499`); (2) a CPA row lives under the product
    whose DEDICATED checklist names it — bcp's Bowman page is not that
    (1,075 cards filed under both bowman and bowman-chrome); where two real
    products list the number both rows stay and sales split by the title's
    product words; contradictions with the Antunez/Arias rulings are
    reported, not silently resolved; (3) the Edit-card picker shows print
    run · product · ✓ checklist · N sales, sale-minted rows rank below
    checklist rows (after the search workflow lands).
    **D30 — no duplicate card, ever (Drew, 09:50Z: "find any duplicate
    cards in the card catalog and consolidate all sales onto it. This will
    be a big big big issue for us if sales are split across different cards
    in the card catalog of the same card").** A read-only measurement
    workflow (8 slices by sport × year band; one equivalence key built from
    the rulings: product as named, hyphen-insensitive number, cleaned
    parallel — base-glue, colour ≡ colour-refractor per card, True-colour,
    superfractor spellings — auto by prefix; graded children excluded)
    produces `catalog-duplicates-measure.md`: multi-row groups, rows,
    groups whose SALES are split, sales involved, holdings on a non-winner
    row, by kind × sport, the winner rule per kind, and the AMBIGUOUS
    groups (Drew's rulings). The consolidation fleet generalises D29's
    machinery (catalogRowOps fold + relocate-sold-comp + holdings map walk
    + graded children; sharded; reconciled) over that worklist, then a
    nightly `catalog_duplicates` canary axis so a split pool can never
    return silently.
    **D30 measured (8 slices, 2026-08-30 09:05–10:30Z, snapshot under
    three running fleets):** 20,518,726 un-graded rows; **1,102,131
    multi-row groups** (2,485,267 rows in them); **17,762 groups whose SALES
    are split across rows, 684,571 sales in them**; 11 holdings on a
    non-winner row. By kind: id-setkey-drift 300,221 (the D23 rename mid-
    flight — old and new spellings both present; includes a `bowman-paper`
    spelling the fleet emits that is not in the product table), numbered-
    vs-un-numbered 290,400, colour-vs-colour-refractor 201,034 (measured
    under the rule Drew retracted the same morning — see D31), print-run
    conflict 81,987 (not duplicates), setKey spelling 31,161, superfractor
    spelling 26,854, hyphen 26,736, base-glue 23,006, refractor spelling
    21,279, cross-product CPA 13,869, no-auto ghost 13,816, player-differs
    12,490 (the CPA-AG case — NOT duplicates), printing-plate spelling
    10,596. Slice JSONs under the session scratchpad `d30/`; the synthesis
    and critique agents died on subagent credits — the table above is the
    main session's sum. **The builders (D29 twins/CPA, the search + comps
    repair round) also died on subagent credits with their diagnoses
    complete; they resume when credits are bought.**
    **D31 — colour follows the checklist (Drew, 12:05Z: "color does not
    always mean refractor. remove rules, and follow it to the checklist or
    catalog"; merged #1546, deploy #14).** Measured against the checklist
    rows of the 13 chrome-stock products: Topps Tribute names **19,099**
    bare-colour parallels (Red 3,025 · Green 2,868 · Purple 2,584 · Gold
    2,369 …) with no refractor form; Topps Chrome names **57,818** (Gold
    Wave, RayWave, Aqua Lava …); where ONE checklist lists both forms they
    are two cards — 2000 Bowman Chrome Retro/Future vs Retro/Future
    Refractor (494), Finest Uncommon vs Uncommon Refractor (600), Sterling
    Rookies vs Rookies Refractor (200), Platinum Autographs vs Autographs
    Refractor /199 (35); and the rule rewrote the checklist's own rows at
    mint — 45,706 Topps Chrome, 18,034 Tribute, 17,944 Bowman Chrome, 9,563
    Chrome Sapphire rows whose slug says -refractor while their checklist
    text does not. Removed: CF-CHROME-COLOR-IMPLIES-REFRACTOR (product-level
    append on 14 setKeys), CF-TRUE-COLOR-IMPLIES-REFRACTOR, CF-MOJO-IMPLIES-
    REFRACTOR, the True-{Colour} → {Colour} Refractor and Mega Mojo → Mojo
    Refractor aliases; `merge-bare-colour-parallels.cjs` retired. The
    generator writes the parallel as named; the catalog resolver (unique
    long-form candidate, catalogSlugIfExists) maps "Gold" onto "Gold
    Refractor" only when that is the one gold row the card has. **Follow-ups
    (D30's fleet):** re-key the pool rows the rule minted (sales under
    `<colour>-refractor` whose card's checklist names `<colour>`) and the
    checklist rows it rewrote at mint (slug → the checklist text's form);
    where two checklist SOURCES spell one card both ways (Topps Chrome
    15,819; Sapphire 8,132; Tribute 5,345 …) — **RULED 12:50Z: the majority
    spelling among the checklist sources for that product wins; tie → the
    longer form.** Also ruled: **D30 runs as ONE fleet, all kinds in
    parallel**; Drew buys subagent credits and the builders resume (D29 twins
    + CPA, the search + comps repair round, then the D30 fleet). Spec:
    `docs/d30-consolidation-fleet-spec.md` (winner rules per kind, the key
    after D31, the fleet shape, the ambiguous list). #1548 flipped the four
    alias pins; the full suite on main is back to the three baseline reds.
    **Rulings 13:10Z (Drew, "ask me questions if needed"):** (1) the vendor-
    source retire ×8 and the purge ×8 — **run both now, Drew's dispatch**
    (a watch reports each run's banner and reconciliation); (2) the eBay poll
    **cuts over to a GitHub cron** — merged **#1550**: `run-ebay-order-poll`
    on the runner (every connected user through `pollEbayOrdersForUser`,
    dryRun unless BACKFILL_APPLY, reconciled, red on per-user errors) +
    `ebay-order-poll-hourly.yml` at :23 UTC; the in-process scheduler
    stays armed until `EBAY_ORDER_POLL_DISABLE_SCHEDULER=true` is set on
    HobbyIQ3 — **a live App Service change, HALT for Drew's confirm** after
    the runner poll's REPORT-ONLY validation run is green; the two
    reconnect-required connections (admin-testing, user-8aa46493) stay so
    until those users reconnect — **DONE 12:28Z: runner poll validated REPORT ONLY (8 users, 29 orders, 10 resolved / 11 parked / 8 unresolvable, 2 reconnect-required), Drew's go, `EBAY_ORDER_POLL_DISABLE_SCHEDULER=true` set on HobbyIQ3, health `3fe0878` back at 12:29:31Z, both workers logged "scheduler disabled" on boot; the cron owns the poll from 12:23Z's successor at :23 hourly; its first APPLY hour recorded 10 of 29 line items**; (3) **D32 — "Sales to confirm"**: a screen
    for the parked (17) and unresolvable (19) eBay sales — confirm links the
    sale to a checklist row, reject parks it on the acquisition list; spec
    `docs/d32-sales-to-confirm-spec.md`, the next builder after credits;
    (4) **builder order once credits are on: search+comps repair → D29
    twins/CPA → D30 fleet → D21 → D24 → D25** (D32 slots after the D30 fleet
    unless Drew moves it).
    **D28 fleets 11:45–12:40Z:** slash 8/8 (12,345 sales re-keyed, 3 failed),
    ordinal 7/8 done (≈6.3k re-keyed of ≈353k scanned — the guard agreed on
    98%), year ×8 and nonumber ×8 running; the after-measure
    (`measure-card-number-integrity` MODE=shapes, compare against 45,718)
    follows the last slot. The D23 rename ×16: every first-generation run
    finished and relaunched on the budget marker; generation counts are in
    the runner.
    **Also landed 08-30 11:30–12:40Z:** D28 grade repair 8/8 (≈50k sales
    re-keyed), slash 8/8 (≈12k), ordinal/year/nonumber ×8 dispatched 12:35Z;
    D26 backfill REPORT ONLY 33303042961 (8 users, 55 orders, 19 auto-
    resolved / 17 parked / 19 unresolvable, 0 holdings marked sold) → APPLY
    33309736501 (55 = 18 written + 37 skipped); conform #1545 aligned 15
    stale cardIds; Max Williams and Harrison both on one identity, both
    fields, exact-pool projection.
    **D28 — the card number is never a grade, a print run, a year, an
    ordinal, or a lot (BUILT on `feat/d28`; APPLY is Drew's dispatch).**
    Harrison's Ohtani (`user-67878bb5` / holding
    `2925db74-649e-487a-bc40-a0d6bba67b34`, "2018 Topps Chrome Refractor
    PSA 10", pitching = the standard #150 Refractor) sat on
    `hiq:baseball:2018:topps-chrome:9:refractor:no-auto` and priced from a
    Paul DeJong 1983 35th Anniversary Refractor #83T-22 and an Ohtani 1983
    Topps Refractor #83T-6, all three keyed to "9" lifted from **"PSA 9"**.
    **THE STRICT MEASURE** (the title states an explicit `#X` that is NOT
    the stored `cardNumber`), run sharded because the full-pool query timed
    out at 10 min — `scripts/measure-card-number-integrity.cjs`, READ ONLY,
    with no write path in it at all: over the grade slice (`cardNumber IN
    ('8','9','10')`, **362,477 rows**) **15,261** — cardhedge 13,442 /
    tca-ebay 1,814 / cardsight 5; over all five measured shapes
    (**1,356,860 rows**) **45,718** — cardhedge 31,385 / tca-ebay 13,505 /
    cardsight 828. (The first pass of that second slice read 64,957. It was
    taken before the spelling fix below and counted "BCP-10" against a title
    printing "#BCP10" as a disagreement: **19,239 of the 64,957 — 30% of the
    apparent defect — were punctuation, not a mis-key.** That is why the
    measure ran before the numbers were written down.) Re-measured through the
    corrected guard, the shapes are: grader-digit **36,448** (ch 22,214 / tca
    14,190), print-run-slash **9,217** (tca 9,210 — almost entirely one
    source), year-as-number **8,361** (tca 5,654 / ch 2,707), ordinal **1,255**
    (ch 929 / tca 326), print-run-bare **675**, an unread `#` with no
    cardNumber **77**, lot-count **9**;
    the "`#` in the title, no cardNumber" bucket needs all three spellings of
    "missing" — `NOT IS_DEFINED` alone returns **0**, because those rows carry
    `cardNumber: null` rather than an absent field. With `IS_NULL` and `= ''`
    added it measures **754**, the spec's number exactly; the repair's
    `nonumber` mode uses the same three-way test.
    **The writers, traced.** `parseTitleIdentity.extractCardNumber` already
    refused grader digits (08-24) — and it was one of FIVE derivations:
    (1) `chRowToSoldComp.ts` copied `cardNumber: row.number` verbatim, and
    CardHedge's `description` IS the source listing's title line, so its
    28,706 grade-digit rows are CH assigning the sale to the wrong product
    and us trusting it; (2) the tca-ebay path (`tca-firehose-ingest.cjs` →
    `persistVendorSalesToPool`) takes `identity.cardNumber ??
    parseListingIdentity(title)` and then lets the LLM / vision enricher
    fill a null one — three chances to write a grade, and the 08-24 guard
    covered only the middle one; (3) `ebayTitleParser.parseListingTitle` has
    its own two regexes (`#N` with no lookbehind, and any 2-5 letters glued
    to digits) and is what gave Harrison's holding "#9"; (4)
    `cardOcr.parseCardNumber` reads `#([A-Z0-9-]{1,12})` off a slab whose
    label prints the grade; (5) `identityFromFields` takes the field as
    given from a spreadsheet cell or a holding. Grepping the MAPPING rather
    than the module found **three more**, and two of them could never have
    been fixed by a guard alone: `bulk-import-ch-daily-to-sold-comps.cjs`
    keeps its OWN copy of the CH mapping — the copy that wrote ~4.2M of the
    current pool rows — so fixing chRowToSoldComp alone would have left the
    single biggest writer of the defect untouched; and
    `emit-staging-to-pool.cjs` (MODE=chdaily) plus canonicalFmv's CH ingest
    both SYNTHESISED the title out of the very field in question
    (`${year} ${set} #${number} ${variant}`), so the title agreed with the
    number BY CONSTRUCTION and no guard could ever have caught anything
    through it. Both now select CH's own `c.description` — the source
    listing's title line, confirmed present on `ch_daily_sales` — judge the
    number against that, and carry the real title to the pool.
    **The fix: `src/services/portfolioiq/cardNumberIntegrity.ts` — one
    pure, tested ruling applied at all eight.** An explicit `#X` in the title
    WINS over any vendor field (logged `card_number_vendor_disagrees`,
    counted on `VendorPersistResult`); a number the title shows to be a
    grader's digit, a `/N` print run or the bare N of one, a 1900-2035 year,
    an ordinal or a lot count is REFUSED. Every refusal requires the title
    to actually say the thing: a bare "9" whose title never mentions a grade
    is left alone. Two corrections the measurement forced: the explicit-`#X`
    reader had to widen (`#SMLB10`, `#90CB-7`, `#83T-6` are a `#` it could
    not parse, and every miss falls through to the vendor's digit — the bug
    itself), and a slash is a print run only NUMBER-over-NUMBER, because
    the slash rows are real SKUs ("2003 Fleer Avant **#AAC/BG**"
    numbers a dual-player insert by both players' initials; "N/A" is the
    slug builder's own word for unnumbered). A THIRD correction came from the
    canary, on live ingest, before any of it shipped: CardHedge stores
    "BCP-10" and the listing it came from prints "#BCP10". Comparing raw
    strings called that a mis-key on 1.13% of the last six hours of rows —
    and let the TITLE'S spelling win, which would have written the
    hyphen-free form, the exact population D23's MODE=hyphen exists to fold
    back. `sameCardNumber` makes hyphens and punctuation SPELLING, not
    identity: where the two agree on letters and digits the STORED spelling
    stands and nothing is counted. The canary reads 0.00% after. 73 pins
    across
    `cardNumberIntegrity.test.ts` (a KEEP case beside every refusal) and
    `cardNumberIntegrityParity.test.ts` (the verbatim 08-24 corpus through
    BOTH rules, so the two cannot drift); every rule mutation-checked.
    **The repairs.** `repair-card-number-from-title.cjs` re-derives with the
    guard and gives each row one outcome: MOVED through
    `lib/relocate-sold-comp.cjs` when the derived identity exists in
    card_catalog (checklist authority preferred, else the numbered twin
    `foldTwinRule` allows); PARKED — the number segment cleared to the
    player-precision address, `cardNumberUnreadable: true` — when it does
    not; or left alone when the guard agrees. A number that WAS read but has
    no catalog row parks carrying `cardNumberFromTitle`: that is an
    acquisition list, not a parse failure. The new slug is surgery on
    segment 4, never a full recompute, so a setKey the resolver spells
    differently today cannot ride along on a card-number repair.
    `clean-base-cards-parallel-slug.cjs` takes the checklist's section
    heading off the rung name: `base-cards-<x>` → `<x>` (MODE=cards,
    unambiguous — no product calls a rung "Base Cards Refractor"), and
    `base-<x>` → `<x>` only where the row's own subsetName / setName says
    "Base" (MODE=subset); without that evidence the row is LEFT, because
    "Base Variation Refractor" and "Base Pitching Refractor" are real rung
    names and stripping them would be the 3.1x bloat mistake in reverse.
    **Report-only counters (2026-08-30, run locally — a dry run touches
    nothing; the runner dispatch is Drew's).** repair MODE=grade slot 0/8:
    **44,402 rows scanned** (the other 318,075 belong to slots 1-7 —
    12.25% against an even eighth's 12.5%, so the hash-of-partition-key axis
    is measured, not assumed), **6,278 repaired** = 306 moved onto a checklist
    row / 18 onto a numbered twin (foldTwinRule) / 144 onto a vendor-or-derived
    row / 4,593 PARKED with no readable number / 1,217 PARKED carrying a number
    the catalog has no row for; **38,037 left alone because the guard agreed**
    (86% — the blast radius is bounded and measured, not asserted); 86
    unparsable slugs, 1 with no player to park under, **0 failed, 0 not
    reached**, and the reconciliation closes exactly (44,402 = 6,278 + 38,037 +
    86 + 1). Why the number changed: grader-digit 4,555, the title's #X
    overruling the vendor 1,744, bare print run 64, lot count 2 — cardhedge
    4,182 / tca-ebay 2,173 / cardsight 10. Extrapolated across 8 slots the
    grade slice alone is ~50k repairs. (The same run under the pre-spelling-fix
    guard reported 6,528; the 250-row difference is the "BCP-10" vs "#BCP10"
    class it was wrongly parking.)
    base-cards clean MODE=cards slot 0/8, the whole slot: **1,139 scanned**
    (+7,908 in slots 1-7 — 9,047 total, the spec's number exactly),
    **1,137 cleaned** = 586 moved / 481 folded onto a row already there / 70
    replacing a lower-authority twin, 60 of them landing on a `:num-N`
    address through foldTwinRule; 0 sales re-pointed (no sale ever computed a
    "Base Cards" parallel from a title, so none pointed at these slugs), 0
    graded children retired, 2 refused. cardboardchecklist 1,120 / beckett 19.
    The rung names recovered: **Refractor 631**, Autograph Variation 56,
    Chrome Variation 55, Lightboard Logo Variation Refractor 33, Short Prints
    29, Image Variations Refractor 26, …. The 2 refusals are rows whose id
    says `topps` while their `setKey` FIELD says `topps-series-2` —
    moveCatalogRow's CF-A-KEY-NEEDS-BOTH-HALVES guard, D23's rename
    population, not this repair's; they are now counted on their own line
    rather than charged to `failed`.
    **The year-as-number catalog rows are NOT a retire.** Measured over the
    1,666,260 rows with a four-character `cardNumber`: **2,074** have
    `cardNumber === year`, and **1,438 of them are checklist-authority**
    (bccp 1,057 + bccp-graded 292, plus checklistcenter / cardboardchecklist
    / cardboardconnection / baseball-almanac / checklist-batch-fill),
    against 370 derived, 232 unknown and 34 vendor. By the spec's own rule
    that makes it a CONVERTER bug rather than a delete — the checklist
    ingest is putting the product's year in the card-number column — so no
    retire is dispatched and the converter is the next fix. (The spec's
    1,319 counted a narrower slice; the 2,074 here includes graded children,
    which are regenerable and follow their parents.)
    **Harrison's ruling** is in `data/holding-identity-rulings.json`:
    `2925db74-649e-487a-bc40-a0d6bba67b34` (`user-67878bb5`) from
    `hiq:baseball:2018:topps-chrome:9:refractor:no-auto` to
    `hiq:baseball:2018:topps-chrome:150:refractor:no-auto`. That target
    **already exists** (source `bccp`, checklist authority, verified by
    point read), so the ruling does NOT wait on the base-cards clean. Worth
    knowing before the APPLY: the holding's `hobbyiqCardId` is the `from`
    the ruling matches on, but its `cardId` had drifted to a DIFFERENT
    PRODUCT — `variant::hiq:baseball:2018:bowman-chrome:9:refractor:no-auto:num-499`
    — and the rulings path sets both fields to `to`, which is what makes
    this one ruling enough. Verified report-only: `SCOPE=rulings` reads
    `rulings 4  would apply 1  skipped 3  failed 0` —
    `WOULD RULE 2925db74 Shohei Ohtani #9: …:9:refractor:no-auto ->
    …:150:refractor:no-auto`. The
    two mis-keyed sales' correct targets, both confirmed present: DeJong →
    `hiq:baseball:2018:topps-chrome:83t-22:1983-topps-baseball-refractor:no-auto`
    (cardboardchecklist — there is no `83t-22:refractor` row at all), Ohtani
    → `hiq:baseball:2018:topps-chrome:83t-6:1983-topps-baseball-refractor:no-auto`
    (cardboardchecklist), exactly the slug the spec predicted.
    **The canary.** `checkSoldCompsCleanliness.cjs` grows a
    `card_number_integrity` axis — counts by shape AND by source, alert
    above 0.5% (measured 0.03% over the last 6h of live ingest; the defect
    at its peak wrote 24,383 rows in 24h, which is percent-scale, not
    basis-point scale). It requires the COMPILED guard rather than a second
    copy of its rules, so `cleanliness-canary.yml` now installs dev deps and
    builds.
    **APPLY, in order (Drew's dispatch — merge and deploy first, then):**
    (1) `gh workflow run backfill-runner.yml -f script=clean-base-cards-parallel-slug -f apply=true -f mode=cards -f slot=N -f slots=8 -f concurrency=16` (N = 0…7);
    (2) `gh workflow run backfill-runner.yml -f script=repair-card-number-from-title -f apply=true -f mode=grade -f slot=N -f slots=8 -f concurrency=12` (N = 0…7), then the same fleet with `-f mode=slash`, `-f mode=ordinal`, `-f mode=year`, `-f mode=nonumber`;
    (3) `gh workflow run backfill-runner.yml -f script=conform-holdings-to-catalog -f apply=true -f scope=rulings -f slot=0 -f slots=1`;
    (4) `gh workflow run backfill-runner.yml -f script=reprice-user-holdings -f apply=true`;
    (5) `gh workflow run backfill-runner.yml -f script=materialize-graded-identities -f apply=true` (the graded children retired by the moves regenerate under the new ids);
    (6) the after number: `-f script=measure-card-number-integrity -f apply=false -f mode=shapes`, compared against the **45,718** above.
    Both write scripts relaunch on their own budget marker with every input
    forwarded, and both exit 1 on a MODE they were not given.
    **D26 — eBay account sync resolves every sale to a card (RULED 04:05Z;
    after D28).** Measured: the hourly in-process poll
    (`jobs/ebayOrderPoll.job.ts`) runs — its last cycle read `users=8
    orders=29 matched=0 noMatch=29 fetchFail=2 cursorsAdvanced=0`; 5,821
    `ebay_poll_no_matching_holding` events in 3 days across 4 users
    because a sold line item matches ONLY a holding carrying our listing id
    (`findHoldingByEbayListingIdAcrossUsers`), and with nothing matched the
    cursor never advances — the same 29 orders are re-fetched every hour.
    Ruling: each sold line resolves to a catalog card from its eBay title +
    item specifics through the matcher the import uses (≥ 0.9 auto-links;
    below parks for the user's confirm); the sale is written to the pool
    under that identity (source `ebay-account`); when the seller holds
    that card the holding is marked sold; the cursor advances on every
    processed order; expired tokens surface a "reconnect eBay" state. Spec:
    `docs/d26-ebay-account-sync-spec.md`.
    **BUILT on `feat/d26`; APPLY is Drew's dispatch.** Re-measured 07:46Z,
    five cycles after the spec's reading and byte-identical to it. Two things
    the re-measure added. **The cursor has never advanced for anyone, ever** —
    `lastPolledAt` is NULL on all 8 `ebay_connections` docs and
    `cursorAdvanced: true` has 0 occurrences in three days, so this is not
    "stalled recently", it is "never once since 2026-06-01". And **`fetchFail=2`
    had no explaining log line at all**: `ebay_poll_fetch_failed` has 0
    occurrences, because the failure returns from the TOKEN step above the only
    line that logs — the two users (`admin-testing-hobbyiq`, `user-8aa46493`)
    have a refresh token live by DATE and an expired access token, so eBay is
    rejecting the refresh grant and nothing said so. Shipped: the resolve /
    record / mark ladder in `ebayAccountSaleIdentity.service` +
    `ebayOrderPoll.service`; the `ebay-account` pool source wired through all
    11 consumer allowlists; exactly one pool row per sale (the holding's ledger
    emit when the holding carries a pinned slug, `ebay-account` otherwise —
    disjoint, counted separately); `findSellerHoldingForIdentity` walking the
    holdings MAP with a grade rung; the cursor inversion (the old test is
    inverted IN PLACE with the measurement on it, not deleted);
    `connectionStatus: "reconnect-required"` on the connection doc with
    `GET /api/ebay/status` + `GET /api/ebay/account-sales` surfacing it, and
    `getAccessToken` no longer DELETING the record on expiry (deleting it is
    why the state was invisible); `reportWrites` on the cycle; and
    `scripts/backfill-ebay-account-sales.cjs` (whitelisted, sharded by user —
    measured 8/0 at SLOTS=1, 6/2 at 2, 3/1/3/1 at 4 — budget marker, relaunch
    step, REPORT ONLY by default). A sale still never mints a card: the matcher
    is asked as `ebay-title` and `ebay-account` is kept out of
    `USER_SEED_SOURCES`, both asserted structurally. Two follow-ups NOT in the
    PR and stated in the spec: the freshness canary's `ebay-account` floor waits
    until APPLY lands rows (a floor over zero rows is a canary nobody believes),
    and the hourly scheduler SHOULD move from in-process to a GH Actions cron —
    it duplicates today (64 completed cycles in 24h across 2 workers where the
    interval says 24) and `reportWrites`' exit code is meaningless inside the
    API process — but that cutover needs the
    `EBAY_ORDER_POLL_DISABLE_SCHEDULER=true` App Service flip, which HALTs for
    Drew, so it is its own change.
    **D27 — VERIFIED means a checklist-backed card (merged #1537, deploy #10
    `6561893`).** Drew's screenshot (03:50Z): the PSA 9 Gillen sat on the
    same checklist row as the raw one and read UNVERIFIED — the chip was the
    manual Confirm-gate flag alone. Ruling: VERIFIED whenever the identity
    resolves to a checklist-backed catalog row, by Confirm, import, the
    conform sweep, or a ruling; UNVERIFIED only when fuzzy/parked; Confirm
    stays as the override. `stampChecklistBackedIdentity` (tested) after a
    confident pin in add/update; the conform sweep stamps holdings on
    checklist rows (APPLY 33290995633 succeeded after the merge); the
    rulings path stamps; reconciliation = holdings patched. Also merged
    tonight: **#1536** the Gain-$ / cost / return sorts order by the number
    the row shows (`holdingCost`/`holdingGain`); **#1534** the rulings path
    (fs/retry) — rulings APPLY 33290006435 wrote 3 = 3 (Ohtani → Topps
    Chrome Update; Antunez, Arias → Bowman); **#1535 + #1538**
    `purge-unaddressable-catalog-rows` — 81,714 card_catalog rows whose id
    carries '/' (old `card::`/`variant::` ids with a print run parsed as
    the card number; bccp 69,341 · tree-builder-v1 8,294 · pool 4,079; 0
    holdings point at them; the SDK cannot address them) are deleted by
    `_self` through a stored procedure, sharded by partition key,
    `PURGE_SOURCES` allowlist, a holdings guard that WALKS the holdings map
    (`JOIN h IN c.holdings` iterates nothing on a map — #1538), budget
    marker, reconciled. Dry 33290356725 (slot 0/8): 10,467 rows in 1,070
    partitions, 0 refused. **Drew: GO (05:05Z) — his dispatch.**
- ~~A single fresh sale carrying the number~~ **RULED KEEP (19:50Z 08-30): "Keep — the latest sale is the market."** D22's `ONE_SALE_WINDOW_POLICY` default is `last-sale` (Gillen $729 under `exact-pool-last-sale`); `widen` (n ≥ 2 before the window wins; $489.50) is the named alternative, off.
- **A single fresh sale carrying the number — original note:** Gillen Blue Refractor /150 —
  project); or cap a one-sale window's move against the prior window.

## NEEDS DREW (not code)

- **Purge the 81,714 unaddressable catalog rows — RULED GO 05:05Z, Drew's
  hand (classifier):**
  `gh workflow run backfill-runner.yml -f script=purge-unaddressable-catalog-rows -f apply=true -f slot=N -f slots=8`
  for N = 0…7. Each slot relaunches itself on the budget marker; the
  summary prints PURGED / refused (source) / refused (held) / failed / not
  reached and reconciles.

- **Process (Drew, 21:40Z): decisions are sent as answerable question widgets
  (options + recommendation, ≤ 4 per round), never as a prose list; this
  section is the record, not the request.** Vendor-source retire: **Drew runs
  the eight dispatch commands himself** (21:45Z); a watch reports each run's
  banner and reconciliation as it lands.

- **RULED 2026-08-30 19:50Z (Drew, in detail):**
  1. **One-sale window: KEEP — "the latest sale is the market."** A window
     with a single sale wins on its own (Gillen stays $729). D22 keeps
     "needs n ≥ 2" as a named, OFF alternative; the leading-edge anchoring
     (Max Williams from its last ten sales) is unchanged.
  2. **setKey identity: the product as the checklist names it** —
     `topps-series-1`, `topps-series-2`, `topps-update-series`,
     `topps-chrome-update-series`, `bowman-draft-1st-edition`,
     `upper-deck-series-1`, `topps-heritage-high-number`, `leaf-vivid`,
     `leaf-metal`; the family (`topps` ⊃ `topps-series-1`) only for
     pricing fallbacks and search. **Maker prefix: KEEP `panini-` on
     Panini-era products** (the checklist says "Panini Donruss" → `panini-donruss`;
     pre-Panini Donruss stays `donruss`) — i.e. literally as the checklist
     names it. → **D23** (after D22): the slug generator stops collapsing;
     a rename fleet through catalogRowOps over the ≈1.2M+ disagreeing rows,
     sales and holdings re-pointed; the pool's `hobbyiqCardId` follows;
     the search family ladder and `crossSetKeyRule`'s `productFamilyKey`
     read the family from a table, not from the id.
  3. **Retire the old-CLC duplicates at non-canonical ids: GO — after D23**
     (the canonical id changes; coverage is re-measured then).
  4. **Retire the MCP server as a pricing engine + delete `apps/api`: GO**
     → D24 (repo removal by a builder; the `compiq-mcp` App Service and
     the two unauthenticated backend routes it kept alive; the Azure resource
     deletion is a live mutation — the exact `az` command will be listed
     for Drew's hand, as with the retire dispatches).
  Order from here: D22 → D23 → D21 (tier ids depend on the vocabulary) →
  D24. The vendor-source retire (REPLACED_BY=none) does not depend on D23
  and can be dispatched now (classifier — Drew's hand).
- **RULED 2026-08-30 20:15Z (second round):**
  5. **An unmatched vendor sale NEVER mints** (D5 PR 7,
     `approveVendorUnmatched`): the sale stays in the pool under its
     provisional slug, the card joins the checklist-acquisition list
     (product + number + player), admin approve means "a real card we lack a
     checklist for", and it prices only once a checklist covers it → D24
     carries the code change.
  6. **Fuzzy adds/imports below the 0.9 bar park on the holding and the
     user confirms** (as D12-a/b built): "we think this is X — confirm?";
     no admin-queue traffic; nothing prices until confirmed.
  7. **Freshness floor `tca-ebay=25000`** — merged #1528.
  8. **The `compiq-mcp` App Service is DELETED** (`az webapp delete`,
     20:20Z, after an exact-name check; `rg-hobbyiq-dev` now holds HobbyIQ3
     and hobbyiq3-worker only). D24: remove `mcp-server/`,
     `compiq-functions/`, `apps/api` from the repo and retire the two
     unauthenticated backend routes (`/api/compiq/comps-by-player`,
     `/api/compiq/player-in-set-momentum`) it kept alive.

- **The setKey vocabulary (D23):** the id collapses the product (`topps-series-1`
  → `topps`, `topps-chrome-update-series` → `topps-chrome`,
  `bowman-draft-1st-edition` → `bowman-draft`, `upper-deck-series-1` →
  `upper-deck`, `topps-heritage-high-number` → `topps-heritage`,
  `leaf-vivid`/`leaf-metal` → `leaf`) while the field keeps it — ≈1.19M rows
  disagree with their own id. Your rulings (Draft ≠ 1st Edition; Update is
  the Update card) say the FIELD is the identity. **Recommendation:** the id
  setKey = the product as the checklist names it, one spelling per product
  (`topps-series-1`, `topps-series-2`, `topps-update-series`,
  `topps-chrome-update-series`, `bowman-draft-1st-edition`,
  `upper-deck-series-1`, `topps-heritage-high-number`, `leaf-vivid`,
  `leaf-metal`), Donruss as `donruss` for every year (the hobby says "2025
  Donruss"; Panini is the maker, not the product — same logic would make
  `prizm`, `select`, `optic`: say if you want the maker prefix kept), with the
  product-family ladder (`topps-series-1` ⊂ `topps`, `bowman-chrome` ⊂
  `bowman`) kept ONLY for pricing fallbacks (the cross-setkey rule) and
  search, never for identity. Cost: a rename fleet through catalogRowOps
  (sales and holdings re-pointed) over ≈1.2M+ rows and the slug generator
  changed first. Say go on the vocabulary and I'll build D23.

- **Two retire dispatches the auto-mode classifier blocks for me (run as-is,
  N = 0…7):**
  `gh workflow run backfill-runner.yml -f script=retire-exploded-checklist-rows -f apply=true -f mode=source -f sources=checklistcenter,checklistcenter-html -f scope=checklistcenter-2026-08-29 -f slot=N -f slots=8`
  (old-CLC rows: 57 products / 133,471 rows at the 95% floor as of the last
  dry; re-measure after re-ingest #2 with `audit-source-coverage` first) and
  `gh workflow run backfill-runner.yml -f script=retire-exploded-checklist-rows -f apply=true -f mode=source -f sources=cardsight,cardhedge,pool,sold-comps-stub-2026-08-12,sold-comps-stub-scarcity-scraped-2026-08-16,sold-comps-stub-2026-08-11,tree-builder-v1,ebay-browse -f scope=none -f slot=N -f slots=8`
  (the ~950k vendor-/sale-minted rows you said GO on; 2 holdings affected).

- **A single fresh sale carrying the number:** Gillen Blue Refractor /150 —
  four 2025 sales $125–$250, one $729 twelve days ago; the 60-day window has
  one sale, so the card reads $729. That is "projected next sale" at n = 1
  (D16). Options: keep (the latest sale IS the market); require n ≥ 2 in the
  window before the window wins (else widen to 90/180 and let the trend
  project); or cap a one-sale window's move against the prior window. Rule?

- **Retire old-CLC duplicates at non-canonical ids (D3c):** identity-based
  coverage says the old `checklistcenter`/`checklistcenter-html` rows are
  duplicates of rows another checklist source holds at the canonical id
  (`topps-series-1:33` vs `topps:33`); the floor-gated MODE=source retire
  would delete them with sales re-pointed. One identity per card says yes;
  it is a semantic change to the guard, so: go?

- ~~Retire the vendor-/sale-minted catalog rows (~950k)~~ **GO (05:00Z 08-30)** — dry run running; APPLY needs the classifier allowance or Drew's dispatch.
- **Retire the vendor-/sale-minted catalog rows (~950k) — original note:** cardsight 664,927,
  cardhedge 133,911, pool 75,650, sold-comps stubs 59,890, tree-builder-v1
  14,473 un-graded rows with no checklist twin at their id. Doctrine says
  only checklists mint; holdings pinned to one of these (e.g. Witt's
  CardHedge-minted 1st Edition twin) become "unresolved" — honest, and the
  conform pass reports them. Proposed: `retire-autoseed-window` /
  MODE=unconfirmed with the same coverage-style guard (print the holdings and
  sales pointing at each retired row first; keep rows with ≥ 1 holding as an
  acquisition list). Say go / not yet.

- ~~isAuto ruling, 2025 Bowman (basketball) CPA-~~ **RULED: CPA = Chrome Prospect Autograph = auto** (05:00Z 08-30).
- **isAuto ruling — original note:** the only other checklist
  family (bccp, 609 rows) says no-auto for a prefix the generator forces to
  `:auto`; 6,930 rows wait. The bccp rows tagged basketball on a Bowman
  product look like the exploded-spine shape — likely retire, not rule.
- **Freshness floor:** `tca-ebay` MIN_ROWS_24H is 2,300 (25% of the worst
  measured day, 9,280, during the 08-26 firehose-off step); today's 441,477
  says raise toward 25,000 once a firehose-era week is confirmed.
- **Below-gate import matches:** D12-a/b park a 0.72 match on the proposal
  fields (`catalogMatchSlug` + `needsReview`), not the literal
  `pending-review` status (which would push every fuzzy manual add into the
  Verify queue). Say if you want the literal status.
- **One-of-one conform at full scale** retires ~2.8M regenerable graded
  children (≈11 per moved row) → `materialize-graded-identities` right after;
  the graded-tier RU window matters (card_catalog is at 400k until the spine
  passes finish).
- **MCP server + `apps/api`:** nothing live calls either; the MCP prices
  from a comp median + hardcoded grade multipliers + an LLM prompt and keeps
  two unauthenticated backend routes alive for itself. Retire both?

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

    **"wont reconcile" (Drew, 12:40Z) — fees never arrived.** Root cause, two
    layers in the in-process finances enrichment job: SHADOW mode by default
    (only the exact string "false" writes; HobbyIQ3 never set it) and every
    cycle lock-skipped on both workers after each restart (the single-flight
    lock survives restarts and is never released — a hazard for every
    in-process job whose interval is long; note for D26's scheduler
    follow-up). **#1553**: `run-ebay-finances-enrichment` on the runner
    (shadow unless BACKFILL_APPLY; reconciled) + a 6-hourly cron; REPORT
    ONLY then APPLY 33312256301 = 1 written: Drew's 2018 Bowman Chrome Ohtani
    #1 sale (08-17) reconciled at $2,396.85 net payout, realized P&L $46.85;
    the Griffey sale (08-30) waits its 2-day fee window. **Flags flipped on
    Drew's go:** `EBAY_ORDER_POLL_DISABLE_SCHEDULER=true` 12:28Z and
    `EBAY_FINANCES_ENRICHMENT_DISABLE_SCHEDULER=true` 12:54Z — both workers
    logged "scheduler disabled" on boot, health `3fe0878`. **#1554**: the
    reconciliation card's "Saving…" never cleared on success (a 200 in
    0.6 s) — fixed. **D34 (Drew, 12:56Z: yes, small builder after the
    current round):** the fee BREAKDOWN (final value fee, payment processing,
    promoted listing, ad fee, other fees, actual shipping) came back null
    though the net payout mapped from the two Finances transactions — map
    eBay's per-fee transaction lines into the seven fields with fixtures from
    real orders and re-run enrichment for already-reconciled sales so the
    tax export is complete; spec `docs/d34-fee-lines-spec.md`.
    **"why is my live eBay purchase not included" (Drew, 12:58Z) — corrected
    picture:** the weekly purchase sync DID fire at 06:46Z today and imported
    it (Justin Gonzalez 2026 Bowman #CPA-JG, $255.49, source ebay-auto); its
    identity parked at 0.98 against `…cpa-jg:refractor:auto`, an un-numbered
    row the catalog no longer has (the checklist row is `:num-499`), so it is
    withheld from value — the numbered-twin resolver (repair round) + a
    conform pass pins it. The "cycle skipped" lines were the losing worker.
    **#1555**: the purchase sync also runs on the runner daily (07:11 UTC),
    restart-proof; the in-process weekly stays armed (idempotent).
    **Drew's inventory audit (13:00Z, 43 active holdings, read-only):**
    Max Williams Gold `aff3236a` sits on the right checklist row
    (`…cpa-mwi:gold-refractor:auto:num-50`) whose pool is 0 — the ONLY Gold
    /50 sale we hold (PSA 9, $142.50, 08-06) is keyed to
    `bowman-chrome:cpa-mwi:gold-refractor:auto` (title "Bowman Draft
    Chrome", un-numbered) → D33's re-key; then it prices from that one sale.
    8 holdings have NO identity with parked candidates at 0.95–0.98 (Judge
    2017 Gold Label, Caglianone RA-JC, Jeter BBP4 ×2, the 1996 Bowman's Best
    BBP-14 group card, Griffey Finest Bronze, Gonzalez CPA-JG, Harris CPA-MH
    X-Fractor) — all un-numbered candidate ids the catalog no longer holds →
    the resolver + conform. 10 point at rows that no longer exist: Ohtani HMT1
    (`topps-chrome-update` → `-series` by the D23 rename AFTER the holdings
    re-point ran; re-dispatched MODE=holdings 13:02Z) and Trout US175
    (`topps-update` → `-series`, same), the rest acquisition-list products
    (1997 Finest #238 with 380 sales, 1999 Finest HA8, 1987 Bellingham, 1987
    Topps Traded Tiffany 70T with 307 sales, 1992 Studio, 1999 Black Diamond
    /1500). 7 sit on non-checklist rows (user-verified / ingest-auto-seed /
    ebay-user-purchase) for products without a checklist. Ripken (277b05a3)
    is a bare CH-id holding with no fields at all.
    **Process (Drew, 14:00Z): "all work pushed to opus to execute … You are an
    orchestrator agent."** Every subagent runs `model: 'opus', effort: 'high'`;
    this session writes specs and workflow scripts, dispatches, reads
    results, and brings decisions as question widgets. Applied to the live
    runs (stopped, edited, resumed from cache).
    **Search + comps fixed — merged #1557 and #1558, deploy #15.** Three
    adversarial rounds (two refuted, the third clean, all proofs read-only on
    prod): (a) the Edit-card search — a bare colour names the card's colour
    parallel in whichever form the catalog holds it, the finish suffix is
    never a word the query had to say and is no longer charged as unnamed
    ("2025 bowman refractor auto max williams" → the Bowman Draft CPA-MWI
    Refractor first; 10- and 13-token queries proven); (b) identity readers
    — `resolveIdentityToCatalogRow` (exact | numbered-twin | none; two twins
    refuse), every reader and the valuation entry read [id, twin] in BOTH
    directions from one function (the catalog fold moved rows, not sales —
    8 of 200 stems carried rows under the un-numbered form), memoised, a
    print-run probe instead of the 112-RU cross-partition scan, fail-open on
    non-404; a bridge until the D30 fleet re-keys the pool. After deploy: a
    conform APPLY + reprice pins the 8 parked holdings and the Gonzalez
    purchase. A builder's junction cleanup had emptied the canonical
    `backend/node_modules/.bin`; restored with `npm install --prefer-offline`.
    **D35 — the eBay confirm path had no pin gate (merged #1560, deploy #16).**
    Why 8 of Drew's holdings had no identity with parked candidates at
    0.95–0.98: `ebayReviewQueue.confirmHolding` reimplemented the ≥0.9 gate
    inline and wrote ONLY `cardId` — `hobbyiqCardId` appeared nowhere in the
    file — so no guard refused them; a second code path never wrote the
    field (and stamped identityVerified on any truthy cardId, even a raw
    CardHedge id). Confirm now runs `applyCatalogMatchToHolding` (one gate,
    both fields, checklist-only); four conform lookups widened where D23
    allows (cardNumberVariants, set/player agreement). Measured on Drew's
    whole portfolio REPORT ONLY: corrected 0 → 3 (Jeter BBP4 PSA 7, the 1996
    Bowman's Best BBP-14 group card, Harris CPA-MH X-Fractor), unresolved
    28 → 18, product-change refusals 0 → 4. Three Opus refuters clean; 92
    new tests. **Drew's rulings 16:05Z (D36, building):** Gonzalez ca820b08
    → `hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499` (CPA ships in
    the Bowman release; "Gonzales" in the catalog is the same player);
    Caglianone 9b971b03 → the 2026 Topps Chrome RA-JC Refractor auto (the
    listing's own title; RA-JC is not a 2024 Bowman Draft number); Finest is
    **topps-finest** (product-table entry; the "finest" checklist rows
    rename); Jeter 5979f485 → bowmans-best BBP4 Atomic Refractor; Griffey
    6f4f079b → black-diamond D24 /1500; Griffey 86cb8844 → studio #232 (the
    literal "undefined" setKey in its stored id is a separate bug to find).
    Judge 2017 Topps Gold Label = acquisition (the product has ZERO
    checklist rows); Ripken 277b05a3 = field recovery (no set/number on the
    holding). **Holdings re-point (MODE=holdings, 12:59Z):** Ohtani HMT1 →
    `topps-chrome-update-series`, Trout US175 ×3 → `topps-update-series`
    (the rename had moved their rows after the first pass). **Drew's vendor
    retire is running:** one slot's first generation retired 75,016 rows in
    its 140-minute budget and relaunched on the marker (run 33313043109) —
    correction: that run was `mode=exploded slot 7/8` (the old-bcp-spine
    retire the plan sequences after the rename + coverage audit), not the
    vendor-source retire; its other seven slots wait for the audit.
    **Auto-dispatch (Drew, 16:40Z: "auto dispatch and notify me on
    completion"; permission rule `Bash(gh workflow run backfill-runner.yml*)`
    added 16:50Z):** the purge ×8 and the vendor-source retire ×8
    (`mode=source`, `scope=none`, eight sources) dispatched 16:55Z; every
    later fleet (twins fold, D33 repair modes, D30 consolidation, the
    exploded/old-CLC retire after the coverage audit) dispatches itself as
    its prerequisite lands; a push notification at completion.
    **D33 converter merged #1562** (the h3 is a product boundary; a card is
    not a parallel; ", Jr." → "Jr."; fixtures from the real 2020/2025 pages).
    The rows track (`repair-bcp-misfiled-parallels`: names 139,572 · card-as-
    parallel 784 → retire (≈×12 with graded children) · number-glued 440 ·
    first-edition 510 · chrome-ladder 560, all dry, 0 failed) and the picker
    track (live proof on Drew's Witt query: doubled-year labels 0, ✓
    checklist on 25 rows, print run + "N sales · last date") conflict with
    #1562 in three files → the landing round rebases them. **D29 twins**
    READY from its refuters but one test fails in the canonical checkout
    (the scope refusal does not exit 1 there) → landing round. **D29 CPA**
    refuted MAJOR for reach (an exact-parallelSlug key reaches ~26% of the
    population: 2021 cpa-am's three spellings never meet) → round 2 on a
    normalised key (D28's cleaning + same-print-run spelling rule; two print
    runs never merge). **D36** BLOCKED: its branch silently reverted #1560 —
    rebuilt on current main in the landing round (targets corrected by its
    own dry run: Griffey D24 → `black-diamond:d24:base:no-auto` — the
    checklist does not number the base; Griffey 232 → `donruss-studio`).
    **Process:** a builder's junction cleanup emptied the canonical
    `backend/node_modules/.bin` twice (`npx vitest` then fails with no test
    output and rc 1); gates now invoke `node node_modules/vitest/vitest.mjs`
    and every builder prompt forbids touching the canonical tree.
    **Landed 18:40–19:00Z:** **#1564** D33 rows + picker (`repair-bcp-
    misfiled-parallels` MODE=names/card-as-parallel/number-glued/first-
    edition/chrome-ladder; the picker says the year once and shows print
    run · ✓ checklist · N sales); **#1565** D29 twins (`fold-checklist-
    numbered-twins`; the scope refusal runs before the requires so a stale
    dist cannot fake it); **#1566** D36 rulings (from:null + a fields block;
    Gonzalez → 2026 Bowman CPA-JG /499, Caglianone → 2026 Topps Chrome
    RA-JC /499 with year/set corrected, Jeter → bowmans-best BBP4, Griffey →
    black-diamond D24 base, Griffey → donruss-studio #232; Finest →
    `topps-finest` in the product table). Deploy #18. **Purge done:** 8/8
    slots, 81,749 rows, every slot reconciled exactly, 0 refused. **Vendor
    retire ×8** running (first 140-minute generation). **D29 CPA (round 2,
    landing):** correct and safe; refuted only on REACH — the measured
    ceiling on the declared scope is 1,896 two-product groups of 90,584
    (648 fold ≈ 677 rows; 562 no dedicated row; 339 target not a product;
    196 keep-both; 123 print-run disagreement); the 1,075-card figure from
    the D30 measure and the 6,106-row projection both came from a
    parallel-agnostic key that D31 forbids, and 2021 CPA-AM is an initials
    collision (Mojica vs Martin) the player gate rightly refuses. Merged as
    measured once its landing agent resolves the conflicts with #1564–#1566.
    **D30 fleet builder launched 19:00Z** (Opus; re-measures two slices with
    the D31 key first). The post-deploy chain runs itself: rulings APPLY →
    twins + repair-bcp REPORT-ONLY → APPLY each when clean → conform →
    reprice; then the CPA fleet, then D30's, then the coverage audit → the
    exploded/old-CLC retire; Drew is notified at completion.

    **D30 FLEET BUILT, 2026-08-30 ~20:15Z (#1571, REPORT ONLY — no APPLY yet).**
    `consolidate-catalog-duplicates.cjs` + the pure rule
    `src/services/catalog/duplicateWinnerRule.ts`, on the shape of
    fold-checklist-numbered-twins (#1565). MODE=all plus per-kind modes
    (colour / spelling / numbered / no-auto-ghost / setkey / cpa); shard axis
    hash(identityKey) % SLOTS, **measured** at 1.006x (baseball, 202,487
    groups) and 1.016x (football, 41,626) for SLOTS=8.

    **The D31 key is the SOURCE STRING — one scrape run.** Two readings were
    written, measured against ground truth and REFUTED: collapsing runs to the
    publisher makes 2025 Topps Chrome #79's printing plates "two cards" (a plate
    is 1/1; there is no refractor plate — a real duplicate stays split forever);
    discriminating on print run MERGES Topps Finest #197's `uncommon` /
    `uncommon-refractor`, which Drew named as two cards, 600 of them. One run
    listing both forms is the site saying "two cards"; two runs disagreeing is
    the site re-spelling one card. Publisher-collapse is used ONLY for rule 3's
    majority so two runs of one site cannot vote twice. All five nameable cases
    are pinned in `consolidateDuplicateRule.d31Colour.test.ts`.

    **Three defects in the modules the fleet calls, all measured, all handled:**
    (1) REACH — `decideChecklistNumberedFold` skips `twin-is-checklist`, but
    65,856 of baseball's 78,560 numbered-vs-unnumbered groups have BOTH rows
    checklist. A thin wrapper would report green while reaching ~22% of its own
    kind, so the cross-checklist case is decided by duplicateWinnerRule and the
    dry run PRINTS the reach split. (2) SALES WIDTH — `moveCatalogRow` re-points
    only `hobbyiqCardId = @exact`; pool keys extend the id with `:num-N` and
    grade segments (31 exact + 9 extending on one measured loser), so the fleet
    enumerates `id OR STARTSWITH(id + ':')` and attributes each key to the
    LONGEST matching row. (3) PARTITION KEY — 37.8% of 2025-baseball and 13.2%
    of football pool rows carry a hiq slug as cardId; those go through
    relocateSoldComp and are counted on their own line (`salesRelocated` is
    never summed with `salesRepointed`).

    **(3b) contentHash HAZARD, reported not applied:** `computeContentHash` and
    its mirror in relocate-sold-comp.cjs STILL strip a trailing " Refractor"
    ("Colour = Colour Refractor is one card") — the rule D31 retracted. The
    collision only bites when a fold lands a Gold and a Gold Refractor sale in
    one partition at equal price/date/grade, which is exactly what MODE=colour
    creates. The dry run counts would-be collisions and **APPLY exits 2 while any
    are outstanding**, so the pool dedup cannot eat a real sale.

    **The pool re-key is the real work:** 698,294 sales sit on a non-winner row
    across the two measured slices versus 309,461 rows to move and 6 holdings.

    **Ambiguous → Drew, 69,378 groups, reasons disjoint.** The biggest bucket
    (two-checklist-print-runs, 51,182) is split into `near-miss (<=10% apart)`
    and `distinct rungs`: sampling 40 showed 30 are /149-vs-/150 concentrated in
    2024 bowman-chrome-mega-box — one source's transcription error rulable once
    per (product, parallel), not 51k decisions.

    **TWO SPEC CLAIMS ARE STALE and were corrected here:** (1) `bowman-paper` IS
    in productSetKeys.ts:159 (`P("bowman-paper", { family: "bowman", parent:
    "bowman" })`), so the spec's "a spelling the fleet emits that is not in the
    product table — fix the fleet, not the rows" is wrong; bowman vs bowman-paper
    is a real parent/child product pair needing a RULING. (2) the by-kind table
    in the spec predates the purge, D28's repairs and D31 — the 19:31Z
    re-measure supersedes it for both measured slices.

    Also landed: the nightly **`catalog_duplicates` canary axis**
    (`checkCatalogDuplicates.cjs` + `catalog-duplicates-canary.yml`), keyed on
    SALES-SPLIT groups rather than duplicate rows — an empty duplicate row splits
    no pool, which is why the purge removed 81,749 rows while sales-split groups
    barely moved (9,572 → 7,636). Groups the fleet would call AMBIGUOUS are
    reported and never alerted on. Runner whitelist + marker-keyed relaunch
    forwarding slot/slots/mode/scope verbatim.

    **NOT DONE / next:** APPLY is Drew's dispatch (REPORT ONLY on slot 0/8
    first). The other six slices (basketball, hockey/soccer/other, pokemon, the
    three older baseball bands — ~14.5M of 20.5M un-graded rows) are UNMEASURED
    under the D31 key; football has 0 cross-source spelling families where
    baseball has 89, so the per-kind mix must not be extrapolated. Re-run the
    measure immediately before APPLY — baseball's id-setkey-drift fell
    146,196 → 57,088 in one day as the D23 rename landed.

    **A BASE CARD IS NOT A 1/1 — a real defect the dry run caught, and an
    operator error that needs Drew (2026-08-30 20:11–20:12Z).** While validating
    the fleet I ran it with `BACKFILL_APPLY=true` against prod to check the
    contentHash guard refuses. That was a mistake — the guard sits at the END of
    the run, so the group loop wrote before reaching it, and a 2-minute timeout
    killed the run mid-loop. **Blast radius, fully identified: 190 sold_comps
    rows, ONE loser group, zero card_catalog rows moved:**
    `2024:panini-prizm:347:base:no-auto` → `…:num-1`.

    It is also a genuine RULE defect, and in the expensive direction. Jayden
    Daniels RC #347 has an un-numbered base row (beckett, 190 sales) and a base
    row transcribed **/1** by checklistinsider-2026-08-28. Rule 2 ("numbered
    beats un-numbered") folded the real base card onto the /1, carrying 190
    ordinary base sales ($24–$136) onto a row that reads as a one-of-one — a real
    1/1 Daniels rookie is worth thousands, so the FMV corruption is severe. Same
    shape as the Finest #197 merge D31 exists to prevent.

    Fixed by `baseCardCannotBeOneOfOne` (a base row at /1 beside an un-numbered
    base row → AMBIGUOUS, never folded either way), pinned in
    `consolidateDuplicateRule.baseNotOneOfOne.test.ts` with a mutation check. The
    guard is scoped to a parallel slug of literally `base`/empty, so Prizm's real
    1/1 parallels (black-finite, choice-nebula, gold-vinyl, stars-black) still
    fold. **Measured effect: football 2024 consolidatable groups 5,827 → 5,780 —
    47 base cards in ONE sport-year that would have had their pools folded onto a
    mis-transcribed /1.**

    **NEEDS DREW: the 190 rows are still on the /1 row.** A scoped, verified
    revert is written and NOT run — `C:/tmp/d30out/REVERT-190-rows.cjs`, dry-run
    by default. It re-points only rows whose `reslugedFrom` is that exact loser
    AND whose `reslugedReason` contains "D30 r2", so it cannot touch anything
    another job moved. Run it from `backend/` after Drew's go.