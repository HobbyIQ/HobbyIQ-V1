# D28 — the card number is never a grade, a print run, a year, an ordinal, or a lot

Ruled by Drew 2026-08-30 05:05Z: **build right after D23, before D26.**

## Why

Harrison's holding `2925db74` (`user-67878bb5`) — "2018 Topps Chrome Refractor
PSA 10, Shohei Ohtani, pitching" (the standard #150 Refractor) — sat on
`hiq:baseball:2018:topps-chrome:9:refractor:no-auto`, a nameless bccp row at
**#9**, and priced from two sales keyed to "#9": a Paul DeJong 1983 35th
Anniversary Refractor **#83T-22** and an Ohtani 1983 Topps Refractor **#83T-6**.
All three got "9" from **"PSA 9"** in a title whose real number the parser
could not read. Drew: "find other bugs like that as well."

## Measured (sold_comps, 16,135,717 rows; card_catalog) — 2026-08-30 04:40Z

| shape | count | notes |
|---|---|---|
| grade digit as card number: `cardNumber ∈ {8,9,10}`, title has `<PSA\|BGS\|SGC\|CGC> n`, no `#n` | **43,224** | upper bound (a real #9 graded PSA 9 also matches); cardhedge 28,706 · tca-ebay 14,463 · cardsight 55; **24,383 written in the last 24h — live** |
| print run as card number: `cardNumber` contains `/` | **25,093** | tca-ebay 18,679 · cardhedge 6,411; 18,026 in the last 7d |
| bare print-run value as card number (`cardNumber=N`, title has `/N`, no `#N`) | ≈1,950 | 25:602 · 50:411 · 99:252 · 150:388 · 199:154 · 250:78 · 299:55 · 499:13 |
| "1st" → #1 (title has `1st`, no `#1`) | 1,334 | the "1st Bowman" trap |
| LOT → #2 | 79 | |
| a `#` in the title, no cardNumber stored | 754 | the parser never read it |
| catalog rows whose cardNumber equals the year | 1,319 | e.g. `hiq:baseball:2018:topps-chrome:2018:gold-refractor:no-auto` (cardhedge) |
| checklist rows with "Base Cards" glued into the parallel name (`:base-cards-` in the id) | 9,047 | cardboardchecklist-scraped-2026-08-14 8,858 · beckett-scraped-2026-08-25 189; `parallelName` undefined on all — why 2018 Topps Chrome #150 has `150:base-cards-refractor:no-auto` and no `150:refractor:no-auto` |
| catalog rows at #8/#9/#10 (the pools these sales pollute) | 190k+ | checklistinsider 76,360 · baseballcardpedia 54,436 · checklistcenter 20,778 · … |

The strict measure — the title states a different explicit `#X` than the
stored digit — timed out at 10 minutes over the full pool. **It is the
builder's first number** (run it sharded by `_ts` month, or over the
`cardNumber IN ('8','9','10')` slice with the grader token first).

## Where the numbers come from (code)

- `src/services/portfolioiq/parseTitleIdentity.service.ts` — `extractCardNumber`
  already refuses grader digits (CF-A-GRADE-IS-NOT-A-CARD-NUMBER, 2026-08-24:
  `GRADER_BEFORE_NUMBER`, `NUMBER_FOLLOWERS`, `standaloneCardNumber`). The live
  writers are therefore **elsewhere**:
  - `src/services/portfolioiq/chRowToSoldComp.ts:140` — `cardNumber: row.number`
    verbatim from CardHedge (their product's number; the Pokémon cases —
    "Surfing Pikachu V #8 PSA 9" landing on `cel25:9` — may be CardHedge
    assigning the sale to the wrong product, which we then trust). Decide:
    when the title states an explicit `#X` that disagrees with `row.number`,
    which wins? (Recommend: the title's explicit `#X`, with the disagreement
    logged and counted.)
  - the tca-ebay path (`.github/workflows/tca-firehose-ingest.yml` → its
    script) — find its derivation; it wrote 14,463 grade-digit rows and
    18,679 print-run rows.
  - `src/services/portfolioiq/ebayTitleParser.service.ts` `parseListingTitle`
    (import side; gave Harrison's card "#9").
  - `src/services/ocr/cardOcr.service.ts` `parseCardNumber` (slab OCR).
- The slug: `computeHobbyIqCardId` takes `cardNumber` as given — every wrong
  number becomes a wrong identity and a wrong pool.

## Deliverables

1. **One rule, every emitter.** A shared `cardNumberIntegrity` guard applied
   at every write of `cardNumber` (CH converter, TCA ingest, eBay title
   parser, OCR, import): a number is never a grader's digit (`PSA 9`,
   `BGS 9.5`, `CGC 10`, `SGC 8`), never a `/N` print run or the bare N of one,
   never a 4-digit year in 1900–2035, never "1st"/"2nd", never a LOT count;
   an explicit `#X` in the title always wins over a vendor field, and the
   disagreement is logged (`card_number_vendor_disagrees`) and counted. Pin
   every shape with tests, including the verbatim titles above.
2. **Re-key the mis-keyed sales** through `scripts/lib/relocate-sold-comp.cjs`
   (D19's mover: one identity per row, twins folded, graded children
   handled): re-derive the number from the title with the new guard; move
   the row when the derived identity exists in the catalog (checklist-backed
   preferred); otherwise clear `cardNumber` and the slug's number segment and
   park the row (`cardNumberUnreadable: true`) — a sale must never stay under
   a card it is not. Runner-whitelisted, sharded, budget marker, reconciled.
3. **The base-cards clean.** `base-cards-<x>` → `<x>` (and `base-<x>` where
   the checklist's subset label was "Base") through `catalogRowOps.moveCatalogRow`,
   folding onto an existing `<x>` row when one exists (the checklist row
   outranks a sale-minted one — `foldTwinRule`). Extend
   `clean-parallel-annotations` if that is where subset glue is handled.
4. **Retire the year-as-number catalog rows** (1,319; vendor/sale-minted —
   confirm by source before deleting; anything checklist-backed is a
   converter bug to fix instead).
5. **Harrison's holding:** a ruling in `data/holding-identity-rulings.json`
   `2925db74` → `hiq:baseball:2018:topps-chrome:150:refractor:no-auto`
   (exists after step 3), `SCOPE=rulings` APPLY, then reprice; verify the
   card page shows Ohtani #150 Refractor sales only.
6. **The measure, before and after:** re-run the table above (and the strict
   measure) after the re-key; both numbers in the PR body. The freshness
   canary / nightly cleanliness gets a `card_number_integrity` check so the
   shapes cannot return silently.

## Guardrails

- Never run the write paths locally; everything through the backfill runner
  (`BACKFILL_APPLY`), REPORT ONLY first, marker-keyed relaunch, `reportWrites`.
- `holdings` is a map — walk it in JS, never `JOIN h IN c.holdings`.
- Gate merges on exit codes (`tsc rc`, `vitest rc`); branch names carry date+time.
- Every backend/src merge needs the "Daily 5AM ET Refresh & Deploy" dispatch and a
  `/api/health` shaShort check.
