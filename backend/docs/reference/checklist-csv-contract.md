# The one checklist CSV format

Every checklist fetcher emits this shape. It is a rule, not a preference —
`feedback_every_ingest_uses_the_one_checklist_format`. `ingest-scraped-checklist.cjs`
is the only consumer, and it reads the header by name, so a file that adds an
unknown column is ignored rather than misread.

## Columns

The first six are REQUIRED and their order is fixed:

| # | column | meaning |
|---|---|---|
| 1 | `category` | `base`, `insert-<slug>`, or `auto-<slug>` |
| 2 | `cardNumber` | as the checklist prints it, no `#` prefix |
| 3 | `parallel` | the rung name. **Blank means unknown/plain — never the string `Base`** |
| 4 | `isAuto` | `true` / `false` |
| 5 | `printRun` | **serial-only truth** — see below |
| 6 | `player` | the player named on the card |

Optional trailing columns, in this order when present:

| # | column | meaning |
|---|---|---|
| 7 | `parallelNote` | the page's own footnote for the rung, verbatim |
| 8 | `rarity` | a set-level production / scarcity statement — see below |

A file may stop after column 6. A consumer must tolerate both the 6-column and
the 8-column form; blank is always a legal value.

## `printRun` is serial-only truth

`printRun` is a number **stamped on the card itself**. It is written only when
the source states a serial for the cards this row covers, scoped to the card
range and players the page names (`CF-A-PRINT-RUN-IS-A-FUNCTION-OF-(RANGE, PARALLEL)`,
`CF-THE-EXCEPT-BLOCK-IS-NOT-THE-RULE`).

Everything else is blank. Blank is unknown. A guessed default is a lie that
outlives every later sweep, because a well-formed wrong print run silently
splits or merges a comp pool and no `only-improve` pass can ever see it.

## `rarity` — the descriptive companion (Drew ruling, 2026-08-30)

`CF-RARITY-IS-NOT-A-PRINT-RUN`. #1571 §5 ruled that pack odds "must map to a
rarity field and must never be coerced into printRun". Until this column existed
there was no such field, so every figure the print-run guards refused was simply
**dropped**.

`rarity` carries a set-level production or scarcity statement that is NOT a
per-card serial, in the source's own words:

| source text | `printRun` | `rarity` |
|---|---|---|
| `serial-numbered to 100` | `100` | blank |
| `1987 Topps Tiffany — approximately 30,000 sets produced` | blank | `approximately 30,000 sets produced` |
| `1997 Finest — the easiest to pull (1:12/packs)` | blank | `1:12/packs` |
| `1996 Metal Universe — inserted 1:24 packs` | blank | `inserted 1:24 packs` |

The two never trade places. A set-production figure ("30,000 sets") and a serial
("/30000") are different claims about different objects: one counts factory sets,
the other counts copies of one card. Writing a production figure into `printRun`
manufactures exactly the confidently-wrong row the scoping rules exist to prevent.

**It is descriptive only.** Nothing in valuation reads `rarity`. It must never
become a multiplier, a synthetic print run, or a scarcity score. Adding a
valuation consumer is a separate ruling, not an implementation detail.

The scraper's `extractRarity()` returns the page's own sentence fragment rather
than a parsed number, so the figure stays auditable back to its source. A
set-production figure below 1,000 is refused — at that size the sentence is far
more likely a mis-caught serial.

## Manifest

Each CSV is paired with `<name>.manifest.json` naming `year`, `setKey`,
`setName`, `sport`, `sourceUrl`, and `parallelColumnAuthoritative`. The BCP
scraper additionally writes `ladder[].rarity` and a page-level `setRarity`.

## Staging

Acquired files land in `backend/data/checklists/scraped/`. The orchestrator then
dispatches:

```
CSV_PATH=backend/data/checklists/scraped/<name>.csv \
SOURCE_LABEL=<source> node backend/scripts/ingest-scraped-checklist.cjs   # dry-run
```

`APPLY=true` writes to `card_catalog`. Read the banner before APPLY.
