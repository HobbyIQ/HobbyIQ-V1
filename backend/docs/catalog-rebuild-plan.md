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
  normalised keys) → retire only products ≥ 95%. Also seen in the same run: the bcp ladders re-ingest now
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
    **Merged #1483 (01:45Z 08-30); deploy #3 33277935264.** After it lands the
    same-slug replay (`SLUGS_FILE=backend/docs/d16-probe-sample-slugs.txt
    LIMIT=50`) is the after-number against 34.0%. Judgment calls to read
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
  population). APPLY dispatched 20:22Z (33273328022); conform-holdings
  APPLY follows it.** Drew (22:30Z): "I see 2 max williams superfractors …
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

## NEEDS DREW (not code)

- **isAuto ruling, 2025 Bowman (basketball) CPA-:** the only other checklist
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
