# Catalog & comp integrity — backlog

Opened 2026-08-19 from a user's mis-priced Chipper Jones #31; rewritten
2026-08-20 after a day that changed several of its own conclusions.

**The goal, in Drew's words:** *"Every card in the catalog with all possible
grades. All sold comps matching to the correct card and grade to be able to see
trends."*

Every number here is **measured**, with the script that produced it named. The
audits cost multi-hour full-container scans — read this rather than re-deriving.

---

## The number that decides the plan

Measured 2026-08-20 over **6,950,635** baseball comps, `audit-trend-readiness.cjs`:

| denominator | trendable (≥5 comps, ≥3 months) |
|---|---|
| by SERIES | **14.9%** — median series holds ONE sale, 55.7% are singletons |
| **by SALES** | **73.0%** — only 9.9% of sales sit in a singleton series |

**Read by series count this looks like a coverage crisis. By sales it is not.**
The long tail is a tail: most *series* are singletons, but they carry under a
tenth of the volume. The cards people actually trade already have the data.

So **matching quality is the lever, not acquisition.** The 82,932-comp checklist
gap is real, but it is TAIL coverage. The higher-value work is making the
**183,417 trendable series** correct — a far smaller and more tractable job.

This also reframes the day's parser fixes as the right instinct rather than
incidental cleanup: `Non Auto`, Pristine-as-Black-Label at 12×, grade fractions
read as serials, penny listings topping the index — every one corrupts FAT
series, which is exactly where that 73% lives.

---

## Start here — as of 2026-08-20 end of day

Two items from the previous version of this list are RETIRED, and one is
promoted. Read the retirements first; both were confidently wrong.

**RETIRED — "cross-sport contamination, lower the thresholds."** Twice wrong.
Player-dominance is not the authority (Jason Kelce has 460 GENUINE baseball
rows — First Pitch is a real Topps baseball insert). Set-dominance is not the
authority either: `audit-set-sport` reported 8.69% contamination, 1,243,562
comps, and its two largest moves were BACKWARDS. See the 2026-08-20 section at
the bottom. **The corrected figure is 1.36% (195,440 comps)** — item 4 below.
The 8.69% is withdrawn; never act on it.

**PROMOTED — checklistinsider is built, and it was not a tail play.** It
yielded 2,388,636 card rows, **1,630,139 carrying print runs**, from 599
products with ZERO unparsed workbooks. Print runs are the one field we cannot
reconstruct from anywhere else, and every attempt to read them out of seller
titles bred a defect class. Staged to JSONL; nothing written.

### 1. The opportunity is ENRICHMENT of sets we already own — 70%

Measured 2026-08-20, keyed on `(sport, year, setKey)`:

```text
KNOWN                   717   8.0%   we already hold the same run
FILLABLE                 13   0.1%
CONFLICT                 23   0.3%
NEW                     797   8.9%   parallels absent from the catalog
set held, NO parallels 6,290  70.0%  <- ENRICHMENT, we own the set
set NOT in catalog     1,153  12.8%  acquisition
```

**70% of everything scraped belongs to sets WE ALREADY HOLD and for which we
carry no parallels at all.** That is five times larger than acquisition and
five hundred times larger than the print-run fill this source was chosen for.

The earlier "53.6% never matched a set" is RETIRED. It was an artifact of
keying on `(year, setKey)` without sport: `donruss-elite`, `panini-limited`,
`panini-zenith` and `o-pee-chee` all exist in the catalog as BASEBALL while the
scraped pages were basketball, football and hockey. The setKeys resolved
correctly all along — matching would have merged a basketball product's ladder
into the baseball set of the same name. Adding sport un-merged 105 groups
(262 -> 367) and shrank every disagreement category: CONFLICT 85 -> 23,
NEW 2,841 -> 797.

### 2. Print runs were NOT the prize — measured, and it inverted twice

The first run reported **851 FILLABLE and ZERO KNOWN** because it read only
`parallels[].numberedTo` — the vendor key — while checklist rows carry
`printRun`. Zero corroboration was the tell: if we held print runs at all, some
had to match. `2023 bowman` already carries `{name: "Gold", printRun: 50}`.
**A field absent from the rows you happened to sample is not a field that does
not exist.**

Corrected, then corrected again by the sport key: **13 FILLABLE**. The case for
this source is not filling print-run gaps. It is item 1.

*A third failure worth recording, because it was the most dangerous: the 70%
bucket was COUNTED but never PRINTED. The report stated "judged: 8,993" and
listed categories summing to 2,703 — and looked like a complete breakdown. A
wrong number invites checking; a plausible-looking partial one does not.*

### 3. The 85 CONFLICTs are mostly an ARTIFACT — fix the granularity first

Do not review them as-is. Inspected 2026-08-20: **12 of the 25 displayed lines
(48%) carry MULTIPLE `ours` values**, e.g.

```text
2023 topps  Gold  ours=1,5,2023,75,25,,50,20  theirs=/10
```

That is not a disagreement. Print run is a property of
`(year, setKey, SUBSET, parallel)`, and the reconcile compares at
`(year, setKey, parallel)` — so every card called "Gold" anywhere in a product
collapses into one bucket and any variation between subsets reads as conflict.

**Fix the comparison unit, then re-count.** Reviewing the current 85 would spend
human attention on non-problems.

*Also recorded so nobody else re-derives it: the `2023` and `2024` values in
those `ours` lists are NOT the year-as-serial bug. Topps flagship Gold is
genuinely numbered to its year — 2023 Gold is /2023. Correct data that looks
exactly like a known defect.*

When a genuine conflict list exists it is still never auto-resolved:
pre-release checklists get revised, and this source exists to stop us INFERRING
print runs — overwriting on scrape reintroduces that in a new costume.

### 3b. The 19,188 YEAR-FLAGGED rows — RESOLVED into two opposite classes

A subset naming a different year than its page is not one problem. Measured
2026-08-20 over all 1,630,139 card rows carrying a print run:

```text
9,510  49.6%  "UPDATE" set    2018 Update - Signature Pucks  on a 2023 page
              -> the SUBSET year is REAL. Upper Deck Update sets complete a
                 PRIOR year's set; the card genuinely belongs to 2018.

5,560  29.0%  retro DESIGN    1994 Pacific Gold              on a 2023 page
              -> the CARD is the PAGE year. The year names a design homage.

3,898  20.3%  ambiguous       2020-21 Award-Winning Autographs Gold
              -> small delta, no "Update" marker. Needs a rule or a human.

  220   1.1%  FORWARD-dated   2025 XRC Black Prizm           on a 2024 page
              -> genuinely ahead. XRC cards are issued before their year.
```

**79% is confidently resolvable, and the two large classes resolve in OPPOSITE
directions.** Assigning all 19,188 to the page year — the obvious move — would
have corrupted 9,510 genuine prior-year Update cards. Flagging rather than
guessing was correct, and the discriminator turns out to be simple: the literal
word "Update" in the subset name.

### 4. The corrected sport audit — LANDED: 1.36%

**195,440 comps (1.36%)**, down from the withdrawn 1,243,562 (8.69%). The new
gate refused 146 setKeys as cross-sport franchises — `2022|topps` alone carries
baseball 183,114 against football 214 and is no longer allowed to adjudicate.

Spot-checked before trusting it: the largest moves are Victor Wembanyama cards
in *2023 Topps Now Baseball*, currently slugged `hiq:basketball:`. The title
says Baseball and the set is a baseball product, so the move is correct — the
same shape as the Jason Kelce First Pitch case, resolved the other way. NOT YET
APPLIED.

### 5. Identity-level dedupe — unchanged, still open

Slug-level is done (31,692 rows hidden), but Eric Hartman still shows 28
duplicate identities: ONE card across SEVERAL slugs, invisible to slug grouping.
Needs `cardIdentityKey` grouping and its own dry run — two different slugs might
be two different cards.

### 6. Re-measure before acting on anything below

Every figure in the sections that follow was taken BEFORE the 2026-08-20 fixes
(search authority ranking, the sub-raw clamp removal, the flat-predicted fix).
`isAuto 838+155`, `507 null cardNumbers`, `4,837 CONFLICT comps` and the
trendable-series counts are all stale. Re-measure, then act.

### 7. Watch the post-deploy pricing surfaces — SHIPPED e54c302a

`e54c302a` changed three runtime paths. The one to watch is `/price-by-id`:
predicted price was structurally flat (`effectiveFmv x 1.0`) for EVERY card
because `est.forwardProjectionFactor` is never assigned. Predicted prices on
pinned cards will now move. That is the fix working, not a regression — but it
is the most likely explanation for a sales index that appeared stuck.

---

## The model is right, and the data mostly supports it

| container | role |
|---|---|
| `card_catalog` | the universe — every card × every grade |
| `sold_comps` | observations, each attaching to exactly ONE (card, grade) |
| trends | the price series per (card, grade) over time |

Measured 2026-08-20 across **40,090,298** catalog rows / 56 sources:

| authority | rows | share | may decide? |
|---|---|---|---|
| CHECKLIST | 34,176,691 | 85.2% | yes |
| VENDOR | 2,167,086 | 5.4% | no — records how a vendor *types* |
| DERIVED | 3,405,953 | 8.5% | **no — the catalog judging itself** |
| UNKNOWN | 340,568 | 0.8% | no (incl. 133,568 with source `"undefined"`) |

The grade explode is **correct and complete**: 597,433 rows carry grade fields
and 597,433 carry `parentSlug` — exactly consistent. There is no schema repair
to do. An earlier estimate of ~3,452 rows needing a grade backfill was **zero**.

---

## Shipped and deployed

| fix | effect | prod |
|---|---|---|
| `Non Auto` parsed as signed | unsigned base cards in auto pools | `75802d4` |
| **Pristine conflated with Black Label** | **~5,200 ordinary BGS 10s priced at a 12× multiplier** | `3afe710` |
| grade fraction read as a serial | `PSA 9/10` → `/10`; /150 cards in /9 pools | `aad1e1b` |

Data repairs applied — **171,151 rows**, all reversible via
`hobbyiqCardIdBefore` / `sportBefore` / `setKeyBefore` / `unifiedBy`:

```text
sport leaks              48,536   0 failed   (0 Sharpe rows left on the baseball #31 slug)
setKey punctuation       87,884   0 failed
card-number hyphen       21,753   0 failed   (bcp25 -> 0, all 570 on bcp-25)
CPA- setKey split         6,180   0 failed   (gold tier visible: $51 /75, $76 /50, $725 /15)
catalog setKey unify      6,399   0 failed   (fragmentation -855; ZERO cards worsened)
```

Shared contracts extracted, each replacing copies that had drifted:
`cardIdentityKey` / `gradeOf` (9 tests), `catalogAuthority` (12 tests).

---

## Open work, highest leverage first

### 1. Scope — everything applied is baseball, mostly Bowman

The tools all take `--sport` now, but the sweeps have not run for:
`pokemon` 2,427,233 · `football` 2,287,136 · `basketball` 1,979,377 ·
`hockey` 222,009 · `soccer` 70,259 comps.

**Season spans are a live hazard outside baseball.** `2024/25 Panini Prizm`
parses as a print run of 25. Baseball never writes years that way, so the guard
in `audit-title-contradicts-slug` is untested in the sports that need it.

### 2. Search still shows doubles — the dedupe

**27,261** identities have several rows behind ONE slug, because a catalog id of
`cardhedge::<vendor-record-id>::<hash>` is scoped to the **vendor listing**, not
the card. Eric Hartman's `cpa-eha` has **21 rows, one slug**.

Sequenced deliberately **after** the setKey unify: dedupe first would pick a
survivor *per setKey*, cementing the split while reporting success. The unify is
now done, so this is unblocked.

Nothing is mispriced by this — it is a search/display defect.

### 3. Comps are still slugged from titles, not matched to the catalog

`diagnose-catalog-rematch`, Bowman 2023-26, 1,025,607 comps:

```text
EXACT      820,897   80.0%    already matches
FILLABLE    21,798    2.1%    checklist supplies the serial   <- the win
AMBIGUOUS      822    0.1%
CONFLICT     4,837    0.5%    comp claims a serial the checklist denies
NO MATCH   177,253   17.3%
```

The 2.1% is modest; the *structural* value is that matching against a ladder
makes text-extraction bugs impossible rather than guarded. Every parser bug
today lived in that gap. **Fill-only** — never overwrite a populated segment.

### 4. Acquisition — the real ceiling

**17.3% NO MATCH**, and `audit-orphan-causes` says **93.1% is a genuine checklist
gap**, only 6.9% our own malformed slugs.

> This reverses, then re-reverses, an earlier reading. A handful of `#null`
> examples suggested ORPHAN was mostly our own mess; measured properly it is not.
> **Examples from an unordered scan are not a sample.**

Sources, verified 2026-08-20:

| source | status |
|---|---|
| **cardboardchecklist.com** | free public **MCP** at `/api/mcp`, no auth, 1987–2026, 8 sports. Card-level coverage only — **no print runs, no colour parallels**. Closes just **2.4%** of ORPHAN. |
| **checklistinsider.com** | ✅ **the one to build** — static HTML, 3 script tags, carries parallel ladders **with print runs** (`Blue Refractor /150`, `Black /10`, `Platinum 1/1`). We hold only 5,810 rows. |
| cardboardconnection.com | ❌ **dead** (DNS). Search engines still serve cached pages, so it looks alive. Was the only gap-fill source. |
| groupbreakchecklists.com | ❌ dead |
| topps.com / ripped.topps.com / Blowout PDFs | ❌ **403 behind bot protection** — not usable programmatically |
| tcdb.com | 403 to bots; scraped once (produced 23,515 `bbm-` rows with no setName) |

`cardboardchecklist` still earns its keep as an **independent check**: it
confirmed `CPA-WJ` exists only in 2024 Bowman, corroborating a direction derived
from our own data — and corrected a claim that the /499 and unnumbered CPA-WJ
pools were two products.

### 5. Wire the six private `isChecklistSource` copies to `catalogAuthority`

`audit-card-number-conflicts`, `audit-checklist-conformance`,
`checklist-gap-report`, `repair-card-number-from-checklist`,
`repair-cardnumber-hyphen`, `unify-catalog-setkeys`.

**Use the right predicate — they do not ask the same question.**
`canAdjudicate` for *which cards exist*; `isTranscriptionGrade` for *how a value
is spelled*. `baseballcardpedia` and `bccp` disagree with themselves 12–18% on
hyphenation, so they count for coverage and not for formatting. Widening the
formatting predicate flipped **51 prefixes** from repair to blocked.

### 6. Smaller measured items

- **`gradeQualifier` is set on 0 of 1,212** Black Label comps. Not load-bearing
  for price (grade is detected from the title at pricing time) but wrong.
- **4,837 CONFLICT comps** — the grade-fraction parser fix is deployed, so this
  should shrink; re-measure before repairing.
- **11,001 identities** span several setKeys where *both* are checklist-backed —
  genuinely different cards, correctly left alone. **5,592** unproven.
- **507** Bowman comps with literal `"null"` as a card number.
- `mma` derived from a card-number suffix (`88BA-MMA` → sport `mma`).
- **76 word-boundary setKey pairs** (`turbo-charged` vs `turbocharged`) — a
  naming question needing a checklist, not a vote.

### 7. Colour recovery — text is exhausted

253 plain-refractor CPA-MG comps run **$1.25–$725, all raw**. The $725, the $255
and the $1.25 carry the *identical* title `"2026 2026 Bowman Baseball #CPA-MG
Base"`. The parallel is absent at the **source**, which is why re-running the
parser over 20,000 rows improved **6**.

Only the image path remains. `cardColourHue.service.ts` is written but **not
committed to `src`** — measured on real eBay photos it returns 1% saturated
border, because the card does not fill the frame. It needs card-edge detection.

### 8. Ops

- **Page timeout** — a card page reported "Request timed out after 30s". Two
  theories disproven; API measures 0.2–0.36s. Needs a tester repro with the
  network tab.
- **Chronic CI reds** — `observedGradeCurve` ×2, red since 7/31. Verified
  pre-existing (reverting the parser to `origin/main` reproduces them exactly).
  **Investigated 2026-08-20 and NOT solved** — recorded so the next attempt
  starts further along:
  - the failing assertion expects `trendAdjustedValue` 220 (`1 + 0.10 × 12`)
    and gets **176**, an effective multiplier of **1.76**
  - the rate comes from `matchedCohort.medianRatio - 1`, NOT the momentum path
    the fixture name suggests
  - `releaseDecay` BLENDS the rate:
    `decayRatePerWeek × blend + rawRate × (1 - blend)` — but only when a
    `releaseCardKey` exists, and the test passes none
  - 1.76 is reachable two ways: rate ≈0.063 at 12 weeks, or 0.10 at ~7.6 weeks.
    Which one is happening is still unknown.
  - an isolated probe replicating the test's mocks returns
    `valueSource: "unavailable"`, so the test depends on shared `beforeEach`
    setup — reason about THAT before reading the service again
  - a previous attempt to mock `releaseDecayPrior` broke two legitimate tests
    and was reverted; that path is a known trap

  **Why it matters more than it looks:** every PR requires hand-comparing test
  totals against a remembered baseline to tell a real break from these. A
  genuine failure would most likely be waved through as "the chronic ones".
- **`backfill-parallel-enrichment` is DISARMED** (2026-08-20). It re-derives the
  whole slug and was caught pushing `bowman:cpa-eha` back to
  `bowman-chrome:cpa-eha`. Requires `I_HAVE_READ_CF_DISARM=yes` to write.

---

## Unmeasured, and it should be measured first

**Trend readiness.** Everything above fixes the *correctness* of matches, but a
trend needs enough sales on one card **in one grade over time** — never measured.

- series **THIN** → perfect matching still yields no trend; **coverage** is the lever
- series **FAT** → the sales exist and land wrong; **matching** is the lever

`audit-trend-readiness.cjs` answers it. Choosing between those on intuition is
what produced this document's reversals.

---

## The pattern, worth keeping

Across one day, the mechanism was right and the **direction or scope** was wrong
**seven times** — twice in code written while fixing the others. Every one was
caught by checking against an *independent authority* before writing, and
several only because the target side was measured first.

- Blanket hyphenation would have corrupted `BDPP` — 61,756 checklist rows, never
  hyphenated. `bdpp19` is correct as it stands.
- "Same player = safe to merge" would have flattened a $500 Sapphire into a $5
  paper base. Ohtani #17 is four real cards.
- Majority-wins on setKey elected `x's-and-o's`, `all-out!` and `bbm-` as
  canonical, entrenching punctuation into slugs.
- An exact source allowlist reported **6.1%** checklist coverage where the truth
  is **87.8%** — it discarded baseballcardpedia's 918,828 rows.
- Widening that same allowlist for the *hyphen* question flipped 51 prefixes to
  blocked on wiki noise. **Source quality is question-dependent.**
- Requiring literal unanimity then blocked BCP on **6 bare rows out of 81,291**.
- A positionally-blind grade regex flagged 221 rows whose *card number* begins
  `PSA-`.

And two process rules bought the hard way:

- **Never apply at a scope that was not dry-run**, and never edit a script a
  queued job will later load. A `--family` default edited mid-flight silently
  widened a run from Bowman to every baseball family.
- **A measurement that cannot run must fail loudly.** An empty connection string
  returned a clean zero; a 403 killed a 2h43m scan. Both now abort explicitly.

---

## 2026-08-20 — set-level sport authority: measured, and WRONG. Not applied.

`audit-set-sport` ran to completion over 14,310,254 comps and reported **8.69%
CONTRADICT (1,243,562 rows)**. That number is not a contamination rate and
nothing was applied from it.

**The reported repair was backwards on its two largest categories** —
533,076 `basketball -> baseball` and 515,655 `football -> baseball`.

### What broke

Authority was ranked over checklist-backed rows only, then gated at 0.95
dominance. Dominance over a single-sport sample is always 1.0:

```
2024 panini-donruss
  ALL rows       baseball 5,503   football 19,130   basketball 4,031
  CHECKLIST rows football 3,993   ONLY
  -> dominance 1.0000, authority "football", 0.95 gate PASSES
```

We have no checklist for Donruss **baseball** 2024. The product plainly exists —
5,503 catalog rows of it. **Absence of checklist COVERAGE was read as absence of
the PRODUCT**, condemning every genuine baseball comp in the set.

Titles settle it. Of 4,000 comps slugged `hiq:baseball:2024:panini-donruss:`,
those naming a sport said:

```
baseball 424   soccer 32   football 0
```

Zero. The audit wanted all 4,000 moved to football.

### The deeper fact

**A setKey does not name a sport.** Donruss, Topps Chrome, Prizm and Select are
cross-sport franchises. `2021 topps-chrome` alone carries baseball 27,554,
soccer 335, racing 78, non-sport 46. There is no set-level sport authority
without sport already in the key — which is circular.

This is the **second** reversal on sport authority. Player-dominance failed on
Jason Kelce (460 real baseball rows in a football player's name); set-dominance
fails on every cross-sport franchise. The lesson is not "pick a better level" —
it is that **sport is a property of the card, and set-level and player-level
signals are both priors about its neighbours.**

### Fixed in the script, needs a re-run

- **Multi-sport detection now reads ALL catalog rows.** A vendor row is weak
  evidence of what a card IS, but perfectly good evidence that the product
  EXISTS in that sport. New `minOther=200` gate, absolute rather than ratio —
  4% of a large set is thousands of real cards, and a ratio gate lets them past.
- **Title veto.** A title naming a sport beats the set-level verdict, because
  that is direct evidence about *this* card. High precision, low recall: only
  ~11% of titles name a sport, so it can stop a repair but must never drive one.

The corrected numbers are **not yet measured** — the re-run is a ~2h scan.
Until then there is no trustworthy cross-sport contamination figure.
