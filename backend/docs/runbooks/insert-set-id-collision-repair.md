# Insert-set id collisions — measure, register, re-ingest

**Status:** the guard is live (`ingest-checklist-csv-to-catalog.cjs` refuses);
the 2014 World Cup repair is BLOCKED on a src registration that is not in this
PR. Ruling R30, Drew 2026-09-13.

## What went wrong

`ingest-checklist-csv-to-catalog.cjs` computed every row's id from
`(sport, year, setKey, cardNumber, parallel, printRun, isAuto)` and **never read
the CSV's `category` column**. A product whose insert sets restart their
numbering at 1 therefore wrote all of them onto one address.

Measured on `backend/data/checklists/scraped/acq-2026-09-13-tcdb/`
(2014 Panini Prizm FIFA World Cup, 5,462 rows, 136 sub-checklists):

```
5,462 upserts  ->  2,949 distinct documents
```

Card number `1`, blank parallel, no auto, no print run occurs **ten times** —
the base card plus nine insert subsets, nine different players — and all ten
computed

```
hiq:soccer:2014:panini-prizm-fifa-world-cup:1:base:no-auto
```

whose base card is Rais M'Bolhi. Cristiano Ronaldo (Aerial Assault #1), Lionel
Messi (World Cup Stars #1), Gonzalo Higuain (Net Finders #1), the Fuleco mascot
and a Belo Horizonte stadium poster all landed on top of him in turn, inside one
run. The last writer for each id decided which player that card is.

`catalog rows written` counts **upsert calls**, so the run printed 5,462 and
reconciled clean. That is why the defect survived.

## Step 0 — measure, before changing anything

`backend/scripts/census-catalog-id-collisions.cjs` is **read only**; no write
path exists in it. It joins the catalog cell against the staged checklist and
names the rows whose stored `playerName` is not the player the checklist puts at
that address.

```bash
COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
SPORT=soccer YEAR=2014 SET_KEY=panini-prizm-fifa-world-cup \
DIR=backend/data/checklists/scraped/acq-2026-09-13-tcdb \
node backend/scripts/census-catalog-id-collisions.cjs
```

It reports, separately:

- **ids the checklist CONTESTS** — more than one checklist row computes this id,
  so it answers for several cards and at most one of them can be right;
- **rows whose player is WRONG** — the stored name is not any player the
  checklist puts there;
- **rows that AGREE**, **claimed ids not in the cell**, and **stored ids the
  checklist does not claim** (another source's rows).

Run it against any older product with numbered insert sets too — `(sport, year,
setKey)` is an argument for exactly that reason. Without `DIR` it reports the
cell's population and says it could not name the wrong rows, rather than
guessing.

## Step 1 — register the keys (a src change, NOT in this PR)

The ingest now refuses the file and prints the list. For the World Cup it is
nine keys, the nine families that number 1..N:

```
panini-prizm-fifa-world-cup-world-cup-stars      588 rows
panini-prizm-fifa-world-cup-team-photos          384 rows
panini-prizm-fifa-world-cup-cup-captains         360 rows
panini-prizm-fifa-world-cup-world-cup-matchups   336 rows
panini-prizm-fifa-world-cup-guardians            300 rows
panini-prizm-fifa-world-cup-net-finders          300 rows
panini-prizm-fifa-world-cup-world-cup-posters    144 rows
panini-prizm-fifa-world-cup-aerial-assault        65 rows
panini-prizm-fifa-world-cup-fuleco                36 rows
```

The other four families on the page — Signatures, Combo Signatures, Fans of the
Game, Eusebio Tribute — are **not** on the list and must not be registered:
their card numbers are prefixed (`CS-BS`, `S-XX`), so they never collided and
separating them would split pools that are already correct.

Every one of the nine currently resolves to **`panini-prizm`** — a fold *past*
the product key onto the bare flagship. `normalizeSetKey` runs inside
`computeHobbyIqCardId` even under `authoritativeSetKey: true`, so an
unregistered key cannot reach an id at all. **Writing anyway would be strictly
worse than the collision**, which is why the ingest refuses instead.

Registration takes **both halves**, exactly as R30's Flair Showcase Rows did
(commit `6398263b`):

1. `backend/src/services/catalog/productSetKeys.ts` —
   `S(key, { parent: "panini-prizm-fifa-world-cup" })` per key. `spelled` is
   what makes `productSetKeyForName` answer ahead of the regex vocabulary.
2. `backend/src/services/portfolioiq/hobbyIqCardId.service.ts` — one anchored
   rule per key, placed **above** the `/panini-prizm/` family pattern, in the
   `(?:^|-)<key>(?:-|$)` form. This is what holds if the product table is ever
   absent; its loader degrades to an empty doc by design.

Pin all nine as fixed points in `backend/tests/hobbyIqCardId.test.ts`, and pin
that the catch-all did not widen.

## Step 2 — re-ingest the same directory

Nothing else. The staged CSVs are unchanged and already correct; only the
derivation was wrong.

```bash
COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
DIR=backend/data/checklists/scraped/acq-2026-09-13-tcdb \
SOURCE=tcdb-2026-09-13 REINGEST=true APPLY=true \
node backend/scripts/ingest-checklist-csv-to-catalog.cjs
```

`REINGEST=true` is required: the first (defective) run left `.ingested` markers
beside the CSVs, and without it the resume skips the file.

**Why a plain re-ingest is the whole repair.** Upserts are by id:

- the base rows land on
  `hiq:soccer:2014:panini-prizm-fifa-world-cup:<n>:…` and **overwrite in place**
  the wrong-player documents the defective run left there, restoring the base
  player;
- the insert rows no longer compute those ids at all — they land on their own
  registered keys, as new documents.

No delete, no move, no manual repair list. Check the run's own reconciliation:
`catalog rows written` must equal `distinct ids`, and the run now exits non-zero
if it does not.

## Step 3 — confirm

Re-run the census from step 0. After a successful repair:

- **ids the checklist CONTESTS** → 0 (the checklist rows that used to contest
  those ids now compute insert-set ids instead, which is itself the proof the
  separation landed);
- **rows whose player is WRONG** → 0.

Then check the pool: the 2,974 soccer/2014 sales currently sitting on
`panini-prizm` are expected to fold onto the right products through the GREAT
REMATCH, per the acquisition manifest's own note.

## The other two refusals in tonight's batch

`acq-2026-09-13-scc` refuses three files, and **none of them is this defect**:

```
1989-pro-set-football.csv          #47  William Perry / Ron Morris
                                   #53  Mike Ditka CO / Mike Ditka HOF
                                   #260 Raymond Berry CO / Raymond Berry HOF
1989-score-football.csv            #316 Eric Thomas ERR SB / Eric Thomas COR SB
1998-99-sp-authentic-basketball.csv #23 Michael Jordan PROMO / Shawn Kemp
```

Every group is **inside one `base` category**: the checklist itself prints one
number twice. A set key cannot separate those, and inventing an axis for them
would be minting from nothing. They need a **ruling on the axis** (a CO/HOF and
an ERR/COR pair are two cards; a PROMO may be a different product) before they
can be ingested, and the guard's job here is to say so rather than let one
silently overwrite the other — which is what would have happened before.

`acq-2026-09-13-insider` passes all 11 files, 12,940 rows, 12,940 distinct ids,
zero keys derived: its inserts number in their own ranges.

## cardboardconnection (#2114) — the same rule, a different input shape

#2114 stages **207 files, 68,329 rows**, one file per subset, and declares the
subset in the **manifest** (`"subset": "Great Significance"`) rather than in the
`category` column. It relies on the ingest's older `:sub-` mechanism (the
2026-09-04 ruling) to separate them.

**That mechanism cannot do this job, and if it could it would give one card two
addresses.** Measured 2026-09-13:

1. **It is reactive.** The branch is `if (known && knownClaim && knownClaim !==
   productClaim)` — it fires only when a row is *already stored* at the plain id
   claiming a different subset. Into an empty cell the first file's rows land
   **plain**; only a later file's rows get a segment. The address a card ends up
   at depends on **file order**.
2. **It never runs in report mode** — `if (!APPLY) { written++; return; }`
   precedes it, so a dry run cannot see any of it.
3. **It is asymmetric by construction** — the incumbent is re-minted, *moved*,
   and the plain id vacated. That is a repair for two rows, not an addressing
   scheme for 197 files.
4. **Two addresses for one card class.** Great Significance #1 would be
   `…:nba-hoops:1:base:auto:sub-great-significance` under #2114 and
   `…:nba-hoops-great-significance:1:base:auto` under #2106's form.

**R30's key form is canonical** (Drew's ruling), and #2106 already proves it:
`panini-rookies-and-stars-rookies-signatures` **is** a `normalizeSetKey` fixed
point today, registered in src. So the guard reads a manifest-declared `subset`
on the **same axis** as a per-row `category` and both derive the same key. The
`:sub-` path is **not retired** — it still answers the clash the *catalog*
discovers between two *stored* rows (#1741), where no checklist asserts
anything — but it is disarmed for any row the pre-flight already moved onto its
own key, so the subset is never spelled twice.

### The measurement has to be per PRODUCT, not per file

Each cbc file is internally distinct, so a per-file guard passes all 207 and
reports 68,329 rows on 67,789 ids — while the product cells hold **1,803
contested addresses**:

```
nba-hoops 2022             10,111 rows ->  9,703 ids   200 contested
panini-prizm-draft-picks    9,591 rows ->  7,748 ids   835 contested
panini-spectra             11,766 rows -> 11,033 ids   485 contested
panini-donruss             10,715 rows -> 10,420 ids   124 contested
nba-hoops 2023             10,166 rows ->  9,739 ids   159 contested
```

`hiq:basketball:2022:nba-hoops:1:base:auto` is claimed by Great Significance #1
(Joe Ingles), Hoops Art Signatures #1 (Paolo Banchero), Hoops Ink #1 (Cade
Cunningham) and Hot Signatures Hyper Gold #1 (Luka Doncic). In **none** of the
1,803 does an unclaimed row take part — every contested address is claimed by
two or more *named* subsets, which is the R30 shape exactly.

So the ingest takes the measurement **once, over every staged file, grouped by
(sport, year, setKey)**. The unit of refusal stays the file.

### Verdict on `acq-2026-09-13-cbc`

| | files | rows |
|---|---|---|
| **REFUSE** (`unregistered-set-keys`) | **175** | 7,385 |
| **PASS** | **32** | 60,404 = 60,404 distinct ids |

**170 distinct keys** to register, across the five contested products. The four
clean products — `upper-deck-series-1` (2022/2023/2024), `upper-deck-series-2`,
`topps-chrome-platinum` — declare no subset and pass untouched.
