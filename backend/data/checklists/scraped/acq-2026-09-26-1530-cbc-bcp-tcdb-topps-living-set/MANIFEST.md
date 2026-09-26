# Topps Living Set (baseball) -- 2018, 2019, 2020, 2024, 2026-09-26

**INGEST AFTER stamp-fix batch 2 merges (setKey registration).** `topps-living-set`
is not a registered setKey today -- see PROBE below. Do not run
`ingest-checklist-csv-to-catalog.cjs` against this directory until the parser
PR that registers `topps-living-set` in `productSetKeys.ts` /
`hobbyIqCardId.service.ts` / the title parser has merged and deployed.

## Why this product, why now

`backend/data/acquisition-worklists/2026-09-26-baseball-top12/` rank 5 traced
491 unbacked "2024 topps base" sales (`C:/tmp/topps24_trace_1530/RESULT.md`).
Of those, 1,632 sales carry the literal string "Living" in their title and
derive to `hiq:baseball:2024:topps:<n>:base:no-auto` with `n` in the 700s --
outside 2024 flagship Series 1/2/Update's real numbering. `card_catalog` holds
**zero** rows for `topps-living`, `topps-living-set`, or any other Living Set
spelling, for any year. This is a genuinely absent product, mis-keyed under
bare `topps` because `inferSetKeyFromTitle`/`computeHobbyIqCardId` do not
recognize "Topps Living[ Set]" as its own product token -- confirmed
empirically below.

A parallel PR ("stamp-fix batch 2") is registering setKey `topps-living-set`
and the "Living"/"Living Set" title token. **This PR uses exactly that key**
and must not be ingested until that PR merges.

## STEP 1 -- sales-per-year measurement (read-only, Cosmos, 2026-09-26)

Paginated `{500,-1}` scan of `sold_comps`, `STARTSWITH(c.hobbyiqCardId,
'hiq:baseball:<year>:topps:')`, filtered client-side on `title` containing
"living" (case-insensitive). No cross-partition COUNT/GROUP BY.

| Year | Scanned (topps:*) | Living sales | Distinct cardNumbers | Priority |
|---|---|---|---|---|
| 2018 | 30,100 | **2,373** | 100 | ACQUIRE (staged) |
| 2019 | 20,637 | **577** | 83 | ACQUIRE (staged) |
| 2020 | 17,746 | **133** | 60 | ACQUIRE (staged) |
| 2021 | 17,126 | 113 | 48 | below threshold |
| 2022 | 27,893 | 41 | 17 | below threshold |
| 2023 | 61,953 | 52 | 18 | below threshold |
| 2024 | 98,118 | **1,632** | 40 | ACQUIRE (staged) |
| 2025 | 242,703 | 139 | 49 | below threshold |
| 2026 | 172,467 | 42 | 19 | below threshold |

Threshold was >=100 sales/year (task's own cutoff). Four years staged: 2018,
2019, 2020, 2024. 2021-2023/2025-2026 are left for a follow-on package --
their sale counts are real but small, and title-text noise (Star Wars Living
Set, UEFA Living Set, non-baseball "Living" listings, condition-lot titles)
is a larger share of the signal at low volume; not measured card-for-card
here.

Note on the "cardNumber range" column originally requested: the naive numeric
range (e.g. 2018's raw min-max was reported as "1-2875" before this cleanup)
is polluted by resale-listing noise (print-run digits, PSA grade digits, lot
sizes) bleeding into a loose numeric parse of the title -- it is NOT the
authoritative range. The real per-year ranges come from the checklist sources
in STEP 2, and match the sales' own distinct-cardNumber counts exactly for
the two years with the strongest signal (2018: sales in range 1-126 confirmed
by direct sample; 2024: sales at #729/#737 confirmed by direct sample -- both
land inside the ranges staged below).

## STEP 2 -- checklist sourcing

**Product**: continuous weekly-release numbering starting at #1 in March
2018, never resetting across years. 1953-Topps-style base design, artwork by
Mayumi Seto, print-to-order (no serial numbers on base cards). Source:
baseballcardpedia.com's single continuous "Topps Living Set" wiki page
(https://baseballcardpedia.com/index.php/Topps_Living_Set), which carries
year subsections 2018 through 2025 on one page -- there is no year-specific
URL (all guessed year-specific URLs 404; the combined page is the only
address). Cross-checked against cardboardconnection.com's "Ultimate Topps
Living Set Baseball Cards Checklist Breakdown Guide"
(https://www.cardboardconnection.com/topps-living-set-baseball-cards) for
2018 (full) and 2020 (partial, #273-305). topps.com and tcdb.com both
blocked every fetch attempt (HTTP 403) across all four years -- neither
contributed any row data.

**Year mapping rule**: baseballcardpedia states an explicit release date
("the date each card was first made available") for every card, in
day-month form under each year's own heading. A card's `year` in this
package is that release year, taken directly from which year-heading
section the card's row sits under on the source page -- not inferred, not
computed, read directly off the source's own section boundaries. Boundaries
confirmed self-consistent card-for-card at both ends of every staged year
(e.g. 2018's own last row #126 Justin Upton 26-Dec agrees with 2019's own
first row #127 Kris Bryant 2-Jan, both read off the same single page).

**Parallels**: blank, never "Base" -- following the 1975 Topps Mini
convention (`acq-2026-09-22-scc-topps-mini-1975/`) and PR #2433's CTH
package convention for a stated ladder. Living Set has no stated
parallel/color ladder in any staged year; both sources agree explicitly
(baseballcardpedia documents a "Black Text" first-ten-copies, not-serial-
numbered micro-variant only from 2023 onward, well outside every year staged
here). Blank means "no sourced parallel exists," never "unknown" and never
"Base."

**printRun**: blank (unnumbered) for every row -- Living Set base cards are
explicitly stated as NOT serial-numbered on every source page, despite each
card having a large "final production run" figure. That figure is a total
print count, not a serial number, and is not staged as `printRun` (which
means "this specific copy is numbered N of a stated run"). isAuto: false
for every row -- no autograph variant exists in this checklist.

**Checklist/index cards excluded**: CL-01, CL-02 (2019), CL-03 (2020), CL-07
(2024) are Topps' own unnumbered index inserts bundled with a release week.
No player, not staged, per doctrine (a checklist card is not a priceable
card).

**Team column**: available and cross-corroborated for 2018 only (both
sources agree on print run for all 126 rows; cardboardconnection supplies
team, baseballcardpedia supplies release date -- complementary, not staged
independently, so both are recorded). For 2019/2020/2024, `team` is left
BLANK: baseballcardpedia's row format never carries a team field for any
year, cardboardconnection.com either 404'd (2019, 2024) or truncated its
own page before reaching the relevant rows for most of 2020 (#306-376), and
the partial #273-305 team recovery for 2020 came through a fetch tool's
secondary summarization step, not the raw page bytes -- flagged by the
sourcing agent as high-confidence but not verbatim-guaranteed. Rather than
mix that lower-confidence partial column into an otherwise fully-verbatim
package, team is left unfilled for 2019/2020/2024 rather than guessed.

**Disagreements between sources**: none requiring exclusion. The only
cross-source discrepancies found were house-style differences (accented vs
unaccented names: "Ronald Acuña, Jr." vs "Ronald Acuna"; "Jackie Bradley,
Jr." vs "Jackie Bradley Jr.") and one cardboardconnection self-typo ("San
Deigo Padres" -> corrected to "San Diego Padres" in the 2018 CSV's team
column). Every card number, player identity, and print run staged agrees
exactly across every source that covers it.

### Rows and sales staged, per year

| Year | CSV rows | Card range | Sales covered (from STEP 1) | Sourcing |
|---|---|---|---|---|
| 2018 | 126 | #1-126 | 2,373 | 2 sources, full cross-check |
| 2019 | 146 | #127-272 | 577 | 1 source (baseballcardpedia only) |
| 2020 | 104 | #273-376 | 133 | 2 sources, partial cross-check (#273-305) |
| 2024 | 104 | #689-792 | 1,632 | 1 source (baseballcardpedia only); #729/#737 cross-checked directly against this task's own Cosmos sales sample |
| **Total** | **480** | | **4,715** | |

## STEP 3 -- verify-absent.cjs: CANNOT be trusted for this key today

Ran `node backend/scripts/verify-absent.cjs` against all four staged CSVs
with `setKey: "topps-living-set"` in each manifest. **Every single row in
every file reports "present"** (2018: 126/126, 2019: 146/146, 2020: 104/104,
2024: 23/104 present + 81/104 absent). This is NOT evidence the cards exist
-- it is the exact defect this task predicted, confirmed:

```
node -e "
const { computeHobbyIqCardId } = require('./dist/services/portfolioiq/hobbyIqCardId.service.js');
console.log(computeHobbyIqCardId({
  sport: 'baseball', year: 2024, setKey: 'topps-living-set',
  cardNumber: '729', parallel: 'Base', isAuto: false, printRun: null,
  authoritativeSetKey: true,
}));
"
# => hiq:baseball:2024:topps:729:base:no-auto
```

With `topps-living-set` unregistered, `resolveSetKeyForSlug` /
`normalizeSetKey` silently collapse it to bare `topps` (confirmed: zero
matches for "living" anywhere in `hobbyIqCardId.service.ts` or
`productSetKeys.ts`). Every point-read this verifier makes today lands on
the FLAGSHIP `topps` address at that card number, not a real
`topps-living-set` address. Direct inspection of the "present" rows proves
this is noise, not signal:

- `hiq:baseball:2018:topps:1:base:no-auto` reads `source:
  baseballcardpedia-ladders-2026-08-29` -- this is 2018 flagship Topps #1,
  which happens to also be Aaron Judge (same player, two unrelated physical
  products, pure numeric coincidence: Living Set #1 is also Judge).
- `hiq:baseball:2024:topps:689:base:no-auto` reads `playerName: "Josh Bell"`
  -- a real, different flagship 2024 Topps card. Living Set's #689 is Sean
  Murphy. Different players, same number, unrelated products.
- `hiq:baseball:2024:topps:715/732/772/789:base:no-auto` read `playerName:
  null`, `source: "bccp"`, `displayName: "2024 Topps #<n>"` -- empty
  placeholder stubs with no real identity, `imageSource: "sold-comps-pool"`
  (backfilled from a sale's own image), most plausibly seeded by the very
  Living Set sales this package exists to fix, not genuine flagship rows.

Manual sibling-twin sweep (point-read at the collapsed id, `namesAgree`-style
comparison) across all 480 staged rows:

| Year | Real name-agreeing twin | Coincidence (diff player, same #) | Genuinely absent at collapsed id |
|---|---|---|---|
| 2018 | 1 (Judge #1, see above) | 125 | 0 |
| 2019 | 0 | 146 | 0 |
| 2020 | 0 | 104 | 0 |
| 2024 | 0 real (4 flagged were null-playerName stubs, not real rows) | 19 | 81 |

Zero genuine collisions found (every "twin" is either a pure numeric
coincidence between unrelated products, or a nameless derived stub). This
package's own verifier output is saved per-CSV
(`*.verify-absent.json`) for the record, alongside this documented caveat --
**do not read those files as confirmation of absence**; they confirm only
that the collapsed, WRONG address is occupied by unrelated flagship data
today, which is exactly why ingestion must wait for the key registration.

### Unregistered-key probe (committed per task instruction)

`testprobe/probe.csv` + `probe.manifest.json` (single row, #729 Shohei
Ohtani, setKey `topps-living-set`) run through `verify-absent.cjs` reproduces
the same collapse on a minimal example:

```json
{
  "csv": "probe.csv", "totalRows": 1,
  "presentChecklist": 0, "presentDerived": 0, "absent": 1, "reconciled": true
}
```
Result id: `hiq:baseball:2024:topps:729:base:no-auto` (confirmed empty at
both partition-key shapes as of 2026-09-26 -- genuinely absent today, but at
the wrong, collapsed address; not proof this task's real target address is
absent, since that address does not exist yet).

## Byte-scan

All four CSVs scanned for 0x08 (backspace) and 0x00 (null) bytes: **zero
found in every file** (2018: 7,411 bytes; 2019: 6,316 bytes; 2020: 4,499
bytes; 2024: 4,484 bytes).

## STEP 5 -- fresh verify-absent run AFTER key registration (2026-09-26, post PR #2444 merge)

PR #2444 (stamp-fix batch 2, merge commit `8dc44e1`) registered `topps-living-set`
in `productSetKeys.ts`. Re-ran `verify-absent.cjs` against all four staged CSVs
plus `testprobe/probe.csv` from a fresh clone of this branch merged onto
current `main`, after `npm ci && npm run build`.

**The earlier `*.verify-absent.json` outputs (STEP 3, committed pre-#2444) are
FALSE POSITIVES/NEGATIVES BY CONSTRUCTION** -- they were computed while
`topps-living-set` collapsed silently to bare `topps` in
`computeHobbyIqCardId`, so every id they point-read was the wrong,
flagship-`topps` address. Do not read those files (still present in git
history/prior commit) as evidence about the real product. **This run's
outputs, below, replace them as the record.**

Confirmed id shape now resolves under the real key, e.g.
`hiq:baseball:2024:topps-living-set:737:base:no-auto` (no collapse).

| Year | Rows | Present (checklist) | Present (derived) | Absent | Reconciled |
|---|---|---|---|---|---|
| 2018 | 126 | 0 | 0 | **126** | yes |
| 2019 | 146 | 0 | 0 | **146** | yes |
| 2020 | 104 | 0 | 0 | **104** | yes |
| 2024 | 104 | 0 | 0 | **104** | yes |
| probe | 1 | 0 | 0 | **1** | yes |
| **Total** | **480** (+1 probe) | 0 | 0 | **480** (+1) | yes |

Every staged row is genuinely ABSENT under `topps-living-set` today. No row
needed removal from any CSV.

**Sibling-twin re-sweep at the collapsed `topps` address** (sample of the 8
rows flagged in STEP 3, re-read live to confirm the collapsed address is
unchanged and nothing has moved since the original sweep):

| Year | # | Collapsed id | Present | Detail |
|---|---|---|---|---|
| 2018 | 1 | `hiq:baseball:2018:topps:1:base:no-auto` | true | Aaron Judge, src=baseballcardpedia-ladders-2026-08-29 (unrelated flagship twin, unchanged) |
| 2024 | 689 | `hiq:baseball:2024:topps:689:base:no-auto` | true | Josh Bell (unrelated flagship twin, unchanged) |
| 2024 | 715 | `hiq:baseball:2024:topps:715:base:no-auto` | true | playerName null, src=bccp (nameless stub, unchanged) |
| 2024 | 729 | `hiq:baseball:2024:topps:729:base:no-auto` | false | still absent at collapsed address |
| 2024 | 732 | `hiq:baseball:2024:topps:732:base:no-auto` | true | playerName null, src=bccp (nameless stub, unchanged) |
| 2024 | 737 | `hiq:baseball:2024:topps:737:base:no-auto` | false | still absent at collapsed address |
| 2024 | 772 | `hiq:baseball:2024:topps:772:base:no-auto` | true | playerName null, src=bccp (nameless stub, unchanged) |
| 2024 | 789 | `hiq:baseball:2024:topps:789:base:no-auto` | true | playerName null, src=bccp (nameless stub, unchanged) |

Matches STEP 3's findings exactly -- no new writes landed at the collapsed
address since the original sweep. This corroborates (does not replace) the
480/480 absence at the real, registered address above.

Byte-scan of the five new `*.verify-absent.json` outputs for 0x08/0x00: zero
found in every file.

## STEP 4 -- scope of this PR

- `backend/data/checklists/scraped/acq-2026-09-26-1530-cbc-bcp-tcdb-topps-living-set/`
  only: 4 CSVs, 4 manifests, this MANIFEST.md, refreshed `*.verify-absent.json`
  outputs (STEP 5).
- No `backend/src`, no workflow files, no ingest dispatch.
- ~~**INGEST AFTER stamp-fix batch 2 merges**~~ -- DONE: PR #2444 merged
  (`8dc44e1`), fresh verify-absent run (STEP 5) confirms 480/480 absent under
  the real `topps-living-set` key. Cleared for
  `ingest-checklist-csv-to-catalog.cjs APPLY=true`.
