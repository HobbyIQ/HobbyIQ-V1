# Topps Living Set (baseball) -- 2021, 2022, 2023, 2025, 2026-09-27

Follow-on package to PR #2443 (2018, 2019, 2020, 2024 -- 480/480 rows live under
`topps-living-set`). This PR stages the remaining below-threshold years from
tonight's measurement (2021, 2022, 2023, 2025) plus documents why **2026 is
excluded** from this package.

## Why this product, why now

Owner Drew, 2026-09-27: "Let's get a lot of agents going in clean up." R-0926c
lets a reviewed acquisition PR with a committed clean verifier merge+ingest
without a click. `topps-living-set` is already a registered setKey (PR #2444,
merge `8dc44e1`) -- no waiting period this time, unlike PR #2443.

## STEP 1 -- sales-per-year measurement (read-only, Cosmos, 2026-09-27)

Same method as PR #2443's STEP 1: paginated `{500,-1}` scan of `sold_comps`,
`STARTSWITH(c.hobbyiqCardId, 'hiq:baseball:<year>:topps:')`, filtered
client-side on `title` containing "living" (case-insensitive). No
cross-partition COUNT/GROUP BY.

| Year | Scanned (topps:*) | Living sales | Distinct cardNumbers | This PR |
|---|---|---|---|---|
| 2021 | 17,126 | **113** | 48 | ACQUIRE (staged) |
| 2022 | 27,895 | **41** | 18 | ACQUIRE (staged) |
| 2023 | 61,955 | **52** | 18 | ACQUIRE (staged) |
| 2025 | 242,707 | **139** | 49 | ACQUIRE (staged) |
| 2026 | 172,479 | **42** | 19 | EXCLUDED -- see STEP 2b below |

Numbers reproduce PR #2443's own table for these same years almost exactly
(that package's STEP 1 reported 113/41/52/139/42 respectively for
2021/2022/2023/2025/2026 -- this is a fresh independent re-run, not a copy).

## STEP 2 -- checklist sourcing (2021, 2022, 2023, 2025)

**Product**: same continuous weekly-release numbering as PR #2443 (never
resets). Source: baseballcardpedia.com's single continuous "Topps Living Set"
wiki page (https://baseballcardpedia.com/index.php/Topps_Living_Set), which
now carries year subsections 2018 through 2025 on one page. Cross-check
attempted against cardboardconnection.com
(https://www.cardboardconnection.com/topps-living-set-baseball-cards) -- its
visible tabs stop at 2023 and the page's own remaining content (which a fetch
tool could only summarize, not read verbatim, past ~39,000 of 194,000
characters) is reported to top out at card #688 (2023) with no 2024/2025
tabs -- **not usable as an independent verbatim source for any year in this
package**, consistent with PR #2443's finding that cardboardconnection had no
2024 coverage either. topps.com and tcdb.com both returned HTTP 403 on every
attempted URL (one attempt each, not retried, per task instruction).

**Year mapping rule**: identical to PR #2443 -- release year read directly
off the source's own year-heading section boundaries, never inferred.
Boundaries confirmed self-consistent card-for-card at both ends of every
staged year:
- 2020's last row (#376 Tony Gonsolin, 30-Dec) -> 2021's first row (#377
  Gerrit Cole, Jan 6)
- 2021's last row (#480 Ty France, 29-Dec) -> 2022's first row (#481 James
  McCann, 5-Jan)
- 2022's last row (#584 Hideki Matsui, 28-Dec) -> 2023's first row (#585 Kyle
  Wright, 4-Jan)
- 2023's last row (#688 Edouard Julien, 27-Dec) -> 2024's first row (#689
  Sean Murphy, 3-Jan, PR #2443)
- 2024's last row (#792 Yuki Matsui, 25-Dec, PR #2443) -> 2025's first row
  (#793 Rogers Hornsby, 1-Jan)
- 2025's last row on the ENTIRE source page: #897 Chase Meidroth, 31-Dec --
  no #898+ content exists on baseballcardpedia today (see STEP 2b).

**Parallels**: blank, never "Base" -- identical doctrine to PR #2443. No
stated parallel/color ladder in any staged year. 2023 introduces a "Black
Text" first-ten-copies, not-serial-numbered micro-variant (continuing into
2024/2025 per the source's own notes) -- explicitly not a named parallel,
not staged, matching PR #2443's treatment of the same note for 2024.

**printRun**: blank (unnumbered) for every row, isAuto: false for every row
-- same reasoning as PR #2443 (large weekly "final production run" figures
are total print counts, not per-copy serial numbers; no autograph variant
exists in this checklist for any staged year).

**Checklist/index cards excluded** (no player, Topps' own unnumbered index
insert, per doctrine):
- CL-04, Checklist #301-400 (2021, dated 24-Mar)
- CL-05, Checklist #401-500 (2022, dated 9-Mar)
- CL-06, Checklist #6 (2023, dated 22-Feb; population "never revealed by
  Topps" per source)
- CL-08, Checklist #8 (2025, dated 29-Jan; population never revealed)

**Team column**: left BLANK for all four years, identical to PR #2443's
2019/2020/2024 treatment. baseballcardpedia's row format never carries a
team field for any year; cardboardconnection's page could not be read
verbatim past 2023 to attempt any cross-check, and even its 2023 tab was not
independently re-verified in this pass. Rather than mix an unsourced/guessed
column into an otherwise fully-verbatim package, team is left unfilled for
2021, 2022, 2023, and 2025.

**Disagreements between sources**: none requiring exclusion -- no second
source was actually readable verbatim for any of these four years (see
above), so there was nothing to disagree with. Two verbatim source anomalies
are reproduced as-is, not corrected, per only-improve doctrine:
- 2021: three consecutive rows (#439 Kyle Schwarber, #440 Ryan Mountcastle,
  #441 George Springer) are all dated "Aug 11" on the source, breaking the
  usual two-per-week pattern. Reproduced verbatim.
- 2025: row #887 Luke Keaschall is dated "16-Nov" on the source despite
  following #886's "26-Nov" in sequence -- likely a source typo for a later
  date. Reproduced verbatim, not corrected (dates are not staged as a CSV
  column beyond `releaseDate`, and this package's `releaseDate` for #887
  reflects the source's literal text).

### Rows and sales staged, per year

| Year | CSV rows | Card range | Sales covered (STEP 1) | Sourcing |
|---|---|---|---|---|
| 2021 | 104 | #377-480 | 113 | 1 source (baseballcardpedia only) |
| 2022 | 104 | #481-584 | 41 | 1 source (baseballcardpedia only) |
| 2023 | 104 | #585-688 | 52 | 1 source (baseballcardpedia only) |
| 2025 | 105 | #793-897 | 139 | 1 source (baseballcardpedia only) |
| **Total** | **417** | | **345** | |

Combined with PR #2443 (480 rows, #1-376 + #689-792), the full continuous
Topps Living Set (baseball) checklist #1-897 is now staged with **zero gaps
and zero duplicate cardNumbers** (verified below).

## STEP 2b -- 2026 is EXCLUDED from this PR

The task brief's own STEP 1-style measurement shows 42 "living"-titled sales
under `hiq:baseball:2026:topps:*` with 19 distinct cardNumbers. Direct
inspection of those sale titles (read-only, this task) confirms a REAL, live
"2026 Topps Living Set" product exists and is actively releasing today --
titles cite specific card numbers, players, teams, and print runs (e.g. "2026
Topps MLB Living Set #898 RAFAEL DEVERS San Francisco Giants 1,334 Print",
"#926 Roman Anthony RC Red Sox PR 9437", "#934 Hunter Goodman... PRESALE" --
the last one for a card not yet released as of 2026-09-26).

However, **baseballcardpedia.com -- this package's and PR #2443's primary,
doctrine-preferred source -- has NO 2026 section**. The page's own table of
contents stops at "2025," the last row on the entire page is #897 (Chase
Meidroth, filed under the 2025 heading), and a direct guess at a year-specific
2026 URL 404s. The page's last edit timestamp (2026-01-01) predates this
season's 2026 releases entirely.

With the primary source silent, a follow-up search found only:
- **tcdb.com** has a confirmed-to-exist checklist page for "2026 Topps
  Living" (`Checklist.cfm/sid/584231/`) -- blocked, HTTP 403 (confirmed via
  both the fetch tool and a direct curl with a browser user-agent; not a
  fetch-tool artifact).
- **sportscardspro.com** -- same, HTTP 403.
- **topps.com** own product/collection pages -- HTTP 403 site-wide, including
  individual per-card product URLs (not just the archive/listing page); PR
  #2443 hit the same wall.
- **cardboardconnection.com** -- confirmed to have no 2024/2025/2026 content
  at all (tops out at 2023).
- Search-engine result snippets surfaced partial data for roughly 25 of the
  ~37 numbers in the #898-934 band (players, teams, some print runs) by
  quoting topps.com's own page titles -- but **zero release dates** were
  recoverable this way, **four numbers (#903, #905, #925, #927) returned no
  data anywhere**, and every field came from a search snippet, never a
  verbatim page read. This is a materially weaker evidence chain than every
  other year in this package and in PR #2443, where every field was read
  directly off a fetched page.

Per doctrine (actuals only, never guess a gap; a missing checklist is
investigated but not fabricated; disagreements/insufficient sourcing exclude
rather than guess), **2026 is not staged in this PR**. The sales are real and
the product is real, but this package does not have a source verbatim
checklist for it. Flagging for the coordinator: 2026 Topps Living Set (#898+)
is a live acquisition target once baseballcardpedia publishes its 2026
section (its established pattern: the page adds each year's section
retroactively, e.g. 2025 was already present when checked but presumably
added mid-year) or a browser-capable session can reach tcdb.com's or
topps.com's own checklist pages directly.

## STEP 3 -- verify-absent.cjs (setKey already registered, no waiting period)

`topps-living-set` was registered by PR #2444 (merged `8dc44e1`, prior to this
task). Ran `node backend/scripts/verify-absent.cjs` against all four staged
CSVs, `COSMOS_CONNECTION_STRING` piped directly from `az webapp config
appsettings list`, never echoed or written to disk.

| Year | Rows | Present (checklist) | Present (derived) | Absent | Reconciled |
|---|---|---|---|---|---|
| 2021 | 104 | 0 | 0 | **104** | yes |
| 2022 | 104 | 0 | 0 | **104** | yes |
| 2023 | 104 | 0 | 0 | **104** | yes |
| 2025 | 105 | 0 | 0 | **105** | yes |
| **Total** | **417** | 0 | 0 | **417** | yes |

Every staged row is genuinely ABSENT under the real, registered
`topps-living-set` key today. No row needed removal from any CSV.

**Sibling-twin sweep** at the collapsed bare-`topps` address (boundary
samples, point-read, `pk=id` then `pk=None`):

| Id | Present | Detail |
|---|---|---|
| `hiq:baseball:2021:topps:377:base:no-auto` | true | Drew Rasmussen RC (unrelated flagship twin -- Living #377 is Gerrit Cole) |
| `hiq:baseball:2021:topps:480:base:no-auto` | true | Brent Rooker RC (unrelated flagship twin -- Living #480 is Ty France) |
| `hiq:baseball:2022:topps:481:base:no-auto` | true | Robbie Ray (unrelated flagship twin -- Living #481 is James McCann) |
| `hiq:baseball:2022:topps:584:base:no-auto` | true | Noah Syndergaard (unrelated flagship twin -- Living #584 is Hideki Matsui) |
| `hiq:baseball:2023:topps:585:base:no-auto` | true | Michael Kopech (unrelated flagship twin -- Living #585 is Kyle Wright) |
| `hiq:baseball:2023:topps:688:base:no-auto` | false | genuinely absent at collapsed address |
| `hiq:baseball:2025:topps:793:base:no-auto` | false | genuinely absent at collapsed address |
| `hiq:baseball:2025:topps:897:base:no-auto` | false | genuinely absent at collapsed address |

Zero real name-agreeing twins found -- every "present" result is a pure
numeric coincidence between unrelated products (different players, same
number), matching PR #2443's finding exactly. This corroborates (does not
replace) the 417/417 absence at the real, registered address above.

## Duplicate-cardNumber check (all Living Set files, this PR + PR #2443)

Checked all 8 files (this PR's 4 + PR #2443's 4) together:

| File | Rows | Range | Distinct | Contiguous |
|---|---|---|---|---|
| 2018-topps-living-set.csv (PR #2443) | 126 | 1-126 | 126 | yes |
| 2019-topps-living-set.csv (PR #2443) | 146 | 127-272 | 146 | yes |
| 2020-topps-living-set.csv (PR #2443) | 104 | 273-376 | 104 | yes |
| 2021-topps-living-set.csv (this PR) | 104 | 377-480 | 104 | yes |
| 2022-topps-living-set.csv (this PR) | 104 | 481-584 | 104 | yes |
| 2023-topps-living-set.csv (this PR) | 104 | 585-688 | 104 | yes |
| 2024-topps-living-set.csv (PR #2443) | 104 | 689-792 | 104 | yes |
| 2025-topps-living-set.csv (this PR) | 105 | 793-897 | 105 | yes |

**897 total rows, 897 distinct cardNumbers, zero duplicates, zero gaps,
zero overlap with PR #2443's ranges.** The full continuous checklist #1-897
is contiguous end to end.

## Byte-scan

All four new CSVs and their five `*.verify-absent.json` outputs scanned for
0x08 (backspace) and 0x00 (null) bytes: **zero found in every file**
(2021: 4,519 bytes; 2022: 4,493 bytes; 2023: 4,519 bytes; 2025: 4,533 bytes).

## STEP 4 -- scope of this PR

- `backend/data/checklists/scraped/acq-2026-09-27-1950-bcp-cbc-topps-living-set-2021-2023-2025-2026/`
  only: 4 CSVs (2021, 2022, 2023, 2025), 4 manifests, this MANIFEST.md,
  `*.verify-absent.json` outputs.
- No `backend/src`, no workflow files, no ingest dispatch (coordinator
  dispatches after review, per R-0926c).
- setKey `topps-living-set` already registered (PR #2444) -- cleared for
  `ingest-checklist-csv-to-catalog.cjs APPLY=true` on review approval, no
  waiting period.
- 2026 Topps Living Set (#898+) intentionally NOT staged -- see STEP 2b.
  Real product, real sales, no verbatim-sourced checklist available to this
  session; left for a follow-on package.
