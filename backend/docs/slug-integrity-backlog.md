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

## Tomorrow — start here

1. **Cross-sport contamination in the index.** Marcus Mariota and Shedeur
   Sanders (football) and Cristiano Ronaldo (soccer) still appear in the
   BASEBALL market-movers list. Their `sport` field AND their slug both say
   baseball, so this is bad data rather than a query bug. The sport sweep's 85%
   dominance / 25-comp minimum leaves thin-history players untouched — it needs a
   second pass at lower thresholds, with its own dry run.

2. **Scope the repairs to trendable series.** Everything below is currently
   phrased as "repair the container". Given the 73% finding, the first cut should
   be: of the 183,417 trendable series, how many are contaminated? That list is
   the actionable one, and it is much shorter than the container.

3. **Identity-level dedupe.** The slug-level pass is done (31,692 rows hidden),
   but Eric Hartman still shows 28 duplicate identities because they are ONE card
   across SEVERAL slugs — invisible to slug grouping. Needs `cardIdentityKey`
   grouping, and its own dry run: two different slugs might be two different
   cards.

4. **checklistinsider ingest** — still worth building for print runs, but it is
   now a TAIL play rather than the main event. Rank it below matching work.

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
