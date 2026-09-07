# The `unknown` setKey pool — census, 2026-09-07

**READ ONLY.** Nothing in this report was written to Cosmos. Every number below is
either MEASURED (a completed paged sweep) or SAMPLED (stated with its sample size).
No number is an unlabelled extrapolation.

The question: how many `sold_comps` rows sit on a setKey of `unknown` (slug segment 4),
on `hobbyiqCardId` **and** on `cardId`, by sport × year × source — and what would the
CURRENT parser (post #1911 / #1914 / #1918 / #1919 / #1922) derive for them?

Prompted by #1922, which found 1,031 of 1,500 `SP CHAMPIONSHIP` titles stored under
`unknown`, and by the Pokémon EN census, which noted an `unknown` population of its own.

---

## 0. The headline, and a correction to the standing number

| | rows |
|---|--:|
| **Population (either field carries `unknown`)** | **664,810** |
| `hobbyiqCardId` segment 4 is `unknown` | 664,125 |
| `cardId` segment 4 is `unknown` | 269,061 |
| both fields `unknown` | 268,376 |
| `hobbyiqCardId` only | 395,749 |
| `cardId` only (hiq names a real product) | 156 |
| `cardId` unknown, `hobbyiqCardId` absent | 529 |

**The two fields do not agree, and the gap is the finding.** `hobbyiqCardId` carries
`unknown` on 664,125 rows; `cardId` carries it on 269,061 — a 395,749-row difference.
The pool reader ORs both fields, so the larger number is the one that describes how many
sales are pooled under a product that names nothing.

### The 889,860 constant is not reproducible today

`backend/scripts/census-unknown-setkey.cjs` hardcodes `POPULATION_TOTAL = 889860` and
every extrapolation it prints is scaled to it. That constant selects on `cardId` only
(`CONTAINS(c.cardId, ":unknown:")`). Measured today under **that same predicate**, by a
paged id-only projection walked to exhaustion:

```
CONTAINS(cardId,':unknown:') matched 269,060  complete=true
  segment 3 IS unknown/empty : 269,060   <- the prior census's population predicate
  ':unknown:' elsewhere in slug: 0
```

269,060 measured by the cross-check, 269,061 by the independent sweep — agreement to one
row of concurrent ingest, from two separately written scripts. The prior figure is
**3.3× the live count under its own definition.** Every `~total` and every `± CI` the
census script prints is inflated by that factor.

This is not evidence the rows were repaired: the census's own predicate reaches 269k rows
and no more, while the population that actually matters (either field) is 664,810. Whether
889,860 was measured against a different predicate, a different container state, or was
mis-transcribed, this report cannot say from the outside — but **it must not be used as a
denominator again until it is re-measured.** Concretely: `POPULATION_TOTAL` needs to
become a measured input, not a literal, and the population predicate needs to read both
fields.

Method: `CONTAINS` is the FILTER (index-servable); the segment-4 read in JS is the
PREDICATE. No cross-partition `COUNT` was run anywhere in this census. Throughput was
measured before the sweep (2,566 rows/s on a 2-minute probe) and held at 2,067 rows/s
over the full 322-second sweep of 664,810 rows.

---

## 1. The population, per sport × year band

**Measured.** Complete sweep, 664,810 rows, 322s.

| sport | pre-1970 | 1970-79 | 1980-89 | 1990-99 | 2000-09 | 2010-14 | 2015-19 | 2020-22 | 2023+ | total |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| pokemon | — | — | 1 | 21,182 | 71,288 | 11,578 | 46,687 | 56,946 | 207,967 | **415,649** |
| baseball | 7,323 | 943 | 2,560 | 9,945 | 13,327 | 4,703 | 7,218 | 11,293 | 48,643 | **105,955** |
| basketball | 80 | 174 | 7,764 | 26,630 | 4,929 | 1,674 | 1,828 | 1,902 | 6,639 | **51,620** |
| other | 44 | 13 | 5 | 3,355 | 8,581 | 217 | 264 | 3,462 | 27,071 | **43,012** |
| football | 5,039 | 488 | 744 | 2,153 | 2,897 | 523 | 976 | 1,595 | 6,597 | **21,012** |
| hockey | 1,402 | 158 | 27 | 190 | 1,075 | 423 | 841 | 2,113 | 6,521 | **12,750** |
| non-sport | 9 | 146 | 1,942 | 5,027 | 82 | 244 | 325 | 864 | 3,764 | **12,403** |
| soccer | 62 | 13 | 1 | 54 | 175 | 116 | 91 | 236 | 1,661 | **2,409** |
| **total** | 13,959 | 1,935 | 13,044 | 68,536 | 102,354 | 19,478 | 58,230 | 78,411 | 308,863 | **664,810** |

No row landed in an `unknown` year band: every population row carries a `cardYear`.

**Pokémon is 62.5% of the population on its own.** The modern era dominates —
308,863 rows (46.5%) are 2023 or later, which is where ingest volume is.

### Per sport × source

**Measured.** Counted by source, per the standing rule.

| sport | cardhedge | tca-ebay | cardsight | ebay-user-purchase |
|---|--:|--:|--:|--:|
| pokemon | 304,812 | 110,837 | — | — |
| baseball | 22,085 | 83,863 | 6 | 1 |
| basketball | 39,578 | 12,042 | — | — |
| other | 25,300 | 17,712 | — | — |
| football | 9,512 | 11,488 | 12 | — |
| hockey | 1,950 | 10,800 | — | — |
| non-sport | 7,413 | 4,990 | — | — |
| soccer | 137 | 2,272 | — | — |
| **total** | **410,787** | **254,004** | **18** | **1** |

Two sources own the whole population: **cardhedge 61.8%, tca-ebay 38.2%.** The 19 rows
from `cardsight` (retired from matching 2026-08-16) and `ebay-user-purchase` are a
rounding error. This is an **ingest-side** defect in two vendor lanes, not a long tail
of odd provenance — which matters, because a fix at the two emitters stops the bleeding
while the rematch pays down the stock.

---

## 2. What the current parser derives for them

**Sampled.** 2,000 rows per sport, 16,000 rows total, classified through the fleet's own
`deriveIdentity` + `classifyRow` — imported from `rematch-sold-comps.cjs` and
`lib/rematch-classify.cjs`, never re-implemented, so these are the verdicts the rematch
would itself produce. `checklistBacked` was resolved by point-read on each destination
slug: the same question, on the same key, the fleet asks before it writes.

Note the sampling frame: 2,000 per sport is a far heavier sample of soccer (83% of its
2,409 rows) than of Pokémon (0.5% of 415,649). Per-sport shares are sound; the total
line is a sum over sports, not a population-weighted estimate.

### Verdict classes, all 16,000 sampled rows

| class | rows | share |
|---|--:|--:|
| UNDERIVABLE | 9,745 | 60.9% |
| CONFLICT | 5,012 | 31.3% |
| IMPROVE | 1,236 | 7.7% |
| AGREE | 7 | 0.04% |
| PROTECTED | 0 | 0% |
| **writable (the fleet would actually move it)** | **715** | **4.5%** |

`filled:setKey` — the parser reading a product where the row stores none — fires on
**6,244 rows (39.0%)**. Only 1,236 of those reach IMPROVE, and only 715 are writable.
**The parser reads the product on eight times as many rows as the fleet may move.**

Zero rows derived `unknown` a second time: when the parser refuses, it refuses at the
`inferSetKeyFromTitle` step (`setkey-unknown-unsupported`), never by minting `unknown`
as an answer. `unknown-is-also-a-guess` is holding.

### Per sport

| sport | sampled | UNDERIVABLE | CONFLICT | IMPROVE | AGREE | writable | writable % |
|---|--:|--:|--:|--:|--:|--:|--:|
| basketball | 2,000 | 480 | 1,079 | 441 | — | **423** | 21.1% |
| pokemon | 2,000 | 819 | 615 | 566 | — | **153** | 7.6% |
| hockey | 2,000 | 668 | 1,215 | 117 | — | **70** | 3.5% |
| football | 2,000 | 1,309 | 623 | 68 | — | **52** | 2.6% |
| soccer | 2,000 | 1,620 | 360 | 19 | 1 | **9** | 0.4% |
| baseball | 2,000 | 905 | 1,069 | 25 | 1 | **8** | 0.4% |
| non-sport | 2,000 | 1,969 | 31 | — | — | **0** | 0% |
| other | 2,000 | 1,975 | 20 | — | 5 | **0** | 0% |

Applying each sport's writable share to its own measured population gives a projected
**~44,000 writable rows of 664,810 (6.6%)** — dominated by basketball (~10,900) and
Pokémon (~31,800). Labelled an estimate: it is a per-sport rate applied to a measured
count, not a measured total.

**`non-sport` and `other` are dead ends at 0% writable** — 55,415 rows between them,
98.5% UNDERIVABLE. No rematch scope helps these; they need vocabulary, and per §3 the
vocabulary needs checklists behind it before recognition buys anything.

### Why rows refuse

| reason | rows |
|---|--:|
| `setkey-unknown-unsupported` | 9,653 |
| `filled:setKey` (parser read a product) | 4,645 |
| `not-checklist-backed` | 4,509 |
| `split-identity:HIQ-SPLIT:segments:printRun` | 798 |
| `filled:setKey,printRun` | 726 |
| `split-identity:HIQ-SPLIT:segments:setKey` | 430 |
| `changed:cardYear` | 301 |
| `filled:setKey,parallel` | 216 |
| `split-identity:HIQ-SPLIT:segments:sport` | 150 |
| `improve-title-names-a-finish-family-the-derivation-...` | 105 |
| `guard:cardnumber-unparsed` | 92 |

Two reasons carry the population. **`setkey-unknown-unsupported` (9,653, 60%)** is the
vocabulary bucket: the title names a product the parser has no rule for, so it refuses
rather than guess. **`not-checklist-backed` (4,509, 28%)** is the checklist bucket: the
parser DID read the product, and the destination has no checklist-backed catalog row.

The second is the important one, because it is not a parser failure at all — it is a
vocabulary win that is not yet a writable row, and it becomes writable the day that
product's checklist lands, **with no code change**.

### An incidental finding: the sport field is wrong on hockey rows

Sampled rows drawn from the `sport: baseball` query returned hockey cards:

```
hiq:baseball:2023:unknown:68:...  "2023-24 Upper Deck Engrained #68 Chris Chelios /299"
hiq:baseball:2025:unknown:lf-26:...  "2025-26 Upper Deck MVP #LF-26 Juuse Saros ..."
hiq:baseball:2021:unknown:53:...  "2021 Upper Deck Artifacts ... Collin Morikawa #53"
hiq:baseball:2024:unknown:hsr-tsj:... "2024-25 Hoops Terrence Shannon Jr. ... RC"
```

`split-identity:...:segments:sport` fires on 150 sampled rows and `changed:sport` on 34.
This overlaps #1924's 94,275 sport-mismatched rows and is **out of scope here** — but it
means the baseball row of the table above overstates baseball and understates hockey and
basketball by an unmeasured amount. Named, not fixed.

---

## 3. Where the rows would go, and whether they may

Top 30 derived destinations by sample rows. `backed` = the destination slug has a catalog
row from a strict checklist source. Sources counted, per the standing rule.

| # | destination (`year\|setKey`) | sample rows | onto backed slug | backed % | catalog sources |
|--:|---|--:|--:|--:|---|
| 1 | `1991\|upper-deck` | 418 | 417 | 99.8% | sportscardchecklist-2026-09-04:417 |
| 2 | `1990\|nba-hoops` | 366 | 0 | **0%** | — |
| 3 | `1995\|nba-hoops` | 275 | 0 | **0%** | — |
| 4 | `2025\|upper-deck` | 258 | 9 | 3.5% | checklistinsider-2026-08-27:5, -08-28:4 |
| 5 | `2024\|upper-deck` | 160 | 10 | 6.3% | checklistinsider-2026-08-28:7, -08-27:3, ingest-auto-seed:2 |
| 6 | `1933\|goudey` | 134 | 134 | 100% | sportscardchecklist-2026-09-05:134 |
| 7 | `2025\|leaf` | 103 | 0 | **0%** | — |
| 8 | `2025\|sv08-5` | 98 | 98 | 100% | pokemon-tcg-data-scraped-2026-08-14:81, tcgdex-scraped-2026-08-16:17 |
| 9 | `2023\|upper-deck` | 97 | 8 | 8.2% | checklistinsider-2026-08-28:7, ingest-auto-seed:4 |
| 10 | `2021\|upper-deck` | 85 | 20 | 23.5% | checklistcenter-2026-09-06:20, ingest-auto-seed:14 |
| 11 | `2024\|leaf` | 84 | 0 | **0%** | — |
| 12 | `2022\|upper-deck` | 78 | 9 | 11.5% | ingest-auto-seed:9, checklistcenter-2026-09-06:8 |
| 13 | `2000\|pacific` | 70 | 0 | **0%** | — |
| 14 | `2025\|topps-finest` | 70 | 4 | 5.7% | hobbymonitor-2026-09-04:3, checklistinsider-2026-08-27:1 |
| 15 | `2026\|leaf` | 64 | 0 | **0%** | — |
| 16 | `1999\|base4` | 62 | 0 | **0%** | — |
| 17 | `2023\|sv01` | 60 | 0 | **0%** | — |
| 18 | `2005\|upper-deck` | 57 | 0 | **0%** | sales-attested:5, ingest-auto-seed:2 |
| 19 | `2025\|sp-authentic` | 54 | 6 | 11.1% | checklistinsider-2026-08-28:4, -08-27:2 |
| 20 | `2025\|o-pee-chee` | 50 | 9 | 18.0% | checklistinsider-2026-08-27:9 |
| 21 | `2026\|me02-5` | 49 | 49 | 100% | pokemon-tcg-data-scraped-2026-08-14:49 |
| 22 | `2023\|leaf` | 46 | 0 | **0%** | — |
| 23 | `2022\|swsh11` | 46 | 1 | 2.2% | ingest-auto-seed:32, tcgdex-scraped-2026-08-16:1 |
| 24 | `1948\|leaf` | 44 | 25 | 56.8% | sportscardchecklist-2026-09-05:25 |
| 25 | `2025\|topps-finest-uefa-club-competitions` | 43 | 0 | **0%** | — |
| 26 | `2019\|sm12` | 43 | 43 | 100% | tcgdex-scraped-2026-08-16:43 |
| 27 | `2025\|sv01` | 43 | 0 | **0%** | — |
| 28 | `2026\|me05` | 42 | 0 | **0%** | — |
| 29 | `1963\|parkhurst` | 40 | 0 | **0%** | — |
| 30 | `1959\|parkhurst` | 39 | 0 | **0%** | — |

**15 of the top 30 destinations have ZERO checklist-backed rows.** Of the 3,078 sampled
rows landing on these top 30, only 842 (27.4%) land somewhere a checklist attests.
567 distinct destinations appeared across the whole sample.

### How the classifier treats an unbacked destination

It **refuses the move, and it does so by changing the class.** From
`lib/rematch-classify.cjs`, immediately after the strictly-more-specific test passes:

```js
// Strictly more specific: nothing dropped, nothing changed, something filled.
// Now the second gate -- a match proves nothing unless checklist-backed.
if (!checklistBacked) {
  reasons.push(`filled:${axes.filled.join(",")}`, "not-checklist-backed");
  return { ...base, klass: CONFLICT, axes, reasons: [...], writable: false };
}
```

A row that is strictly more specific on every axis but whose destination has no
checklist-backed catalog row does **not** come back as IMPROVE-and-unbacked. It comes
back **CONFLICT**, carrying `filled:<axes>` and `not-checklist-backed`, with
`writable: false`. So:

- **A move onto a destination without checklist rows cannot happen.** Not by policy that
  someone must remember to apply — by class. The apply scopes arm on class, and this row
  is not in an appliable class.
- **Reading the class alone will mislead you.** `klass === IMPROVE && !backed` matches
  *nothing*, because the gate runs inside the class decision. The 4,509 rows tagged
  `not-checklist-backed` are counted as CONFLICT above, and eleven of every twelve of
  them are vocabulary successes waiting on a checklist, not rival readings of the card.
  Read the REASON, not the class. (The existing census script carries this same warning
  in its comments, learned the same way.)
- `2005|upper-deck` (row 18) shows the rule biting exactly as intended: the destination
  has catalog rows from `sales-attested` and `ingest-auto-seed`, and it still counts as
  **0 backed** — because neither is a strict checklist source. Self-derived rows do not
  vouch for themselves. `catalog_match_rate_is_self_confirming` is holding.

### The acquisition list

From the dispatched Pokémon census run (§4), products the parser now READS whose
checklists we do not have, ranked by rows — the order they are worth acquiring in:

```
2023|swsh12-5   30      2026|mep        28      2026|m5         27
2025|m2a        23      2021|cel25cc    22      2024|sv08       17
2025|svp        17      2021|cel25      15      2019|sm115      15
2019|smp        13      2024|svp        12      2024|sv8a       12
2022|swsh9      12      2023|sv-p       10      2025|sv-p       10
```

And the top products the vocabulary has no rule for at all (1,540 distinct proposed keys
over 1,579 raw spellings in that shard). The `chkProbe` column is the count of real card
numbers from that product that already have a checklist-backed catalog row:

```
proposedKey                       rows  chkProbe  representative spelling
mep-first-partner-illustration      31     0/10   mep first partner illustration
topps-pristine                      17     0/12   pristine alolan ninetales gx
ultra                               16     0/11   mep en-me ultra-premium collection
japanese-mega-dream-ex              16     0/12   japanese mega dream ex
simplified-chinese-cbb3-c-gem       14      0/2   simplified chinese cbb3 c-gem
japanese-25th-anniversary-coll      13      0/6   japanese 25th anniversary collection
one-piece-japanese-promos           12      0/9   one piece japanese promos
first-partner-illustration-col      11      0/6   first partner illustration collection
rocket-1st-edition-dark              9      0/8   rocket 1st edition dark
japanese-vs-1st-edition              9      0/9   japanese vs 1st edition
```

**Every probed spelling scores 0.** Teaching the parser these products would move exactly
zero rows today: recognition without a checklist is a vocabulary win and a pricing no-op.
The vocabulary program and the checklist program have to land together, and the checklist
is the binding constraint. (`one-piece-*` entries are a separate matter — One Piece is a
non-Pokémon TCG parked behind the write-first-ask-permission ruling.)

---

## 4. Is a new lane needed? No — the existing scopes already cover this

**`scope=improve` already covers `unknown` → key moves. No new scope, and no one-off patch.**

The mechanism, in `lib/rematch-classify.cjs`:

```js
const GENERIC_SETKEYS = new Set(["", "unknown", "none", "unspecified", "base-set"]);

function storedSetKeyIsBlank(stored, derivationReasons = []) {
  const v = lower(stored?.setKey);
  if (GENERIC_SETKEYS.has(v)) return true;
  ...
}
```

A stored `unknown` is **blank**, not a rival answer. So `unknown` → a real product diffs
as `filled:setKey` — a FILL — and a fill with nothing dropped and nothing changed is
IMPROVE. It is not a lateral change and never classifies as one. `scope=improve` maps to
exactly `[IMPROVE]` in `APPLY_SCOPE_ALIASES`, so the running IMPROVE fleet writes these
rows with no new code and no new lane. That is what the ~715-of-16,000 writable figure
counts.

The three ruled scopes of 2026-09-06 (`grade-from-title`, `year-from-title-vintage`,
`sport-from-product`) are irrelevant here: each arms only by its own name, none is armed
by `improve`, and none addresses a blank setKey.

### The in-slot row filter is the right way to run it

`setkey_like=unknown` (#1907) is the correct instrument, and it is exact rather than
approximate. From `rematch-sold-comps.cjs`:

```js
if (seg !== SETKEY_LIKE && !seg.startsWith(`${SETKEY_LIKE}-`)) return false;
```

The filter is a `-`-bounded prefix on the row's **stored** setKey segment read off the
slug. `unknown` contains no hyphen and no real product key begins `unknown-`, so
`setkey_like=unknown` selects **exactly the population of this report and nothing else**.

Three properties that make it the right tool rather than merely a working one:

1. **It narrows the rows a slot CLASSIFIES, never the rows a slot OWNS.** The measured
   32-slot shard table is untouched and slots stay disjoint; a filtered run of slot N is
   a strict subset of an unfiltered run of slot N.
2. **It reads the STORED row, not the derivation.** A filter reading the derived key
   would silently change which rows are counted as the deriver changed, and two runs of
   one dispatch would disagree.
3. **It makes a narrow dispatch cheap** — excluded rows are skipped before any
   derivation, catalog read or classification — and the banner prints
   `skipped-by-filter` vs `classified`, so a small `seen` reads as the filter working
   rather than the shard being empty.

**No new `workflow_dispatch` input is required.** `setkey_like`, `sports`, `slot`, `slots`
and `scope` all exist and all bind today.

### The exact census dispatch, per slot, for the biggest sport

Pokémon: 415,649 rows, 62.5% of the population. Report-only census over all 32 slots:

```bash
for slot in $(seq 0 31); do
  gh workflow run backfill-runner.yml --repo HobbyIQ/HobbyIQ-V1 --ref main \
    -f script=rematch-sold-comps \
    -f mode=census \
    -f apply=false \
    -f setkey_like=unknown \
    -f sports=pokemon \
    -f slot="$slot" -f slots=32
done
```

`mode=census` is read-only and ignores `scope`. `slots=32` is the rematch's own measured
fan-out — it declares sharding as its normal operating mode (`alwaysShard: true`), so
unlike the opt-in lanes it shards on the env alone and `slot=0` is a real slot 0.

An apply, when one is authorised, is the same dispatch with `mode=apply-improve`,
`scope=improve`, `apply=true`. That is a separate decision and this report does not make
it.

### The run dispatched for this report

One report-only census was dispatched and completed:
[run 34070612285](https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/34070612285) —
`script=census-unknown-setkey apply=false sports=pokemon slot=1 slots=32`,
head SHA `a3ab6a6ead09d1823ecb7b447d0dece42d35a057`, conclusion **success**.

```
census-unknown-setkey  READ ONLY -- this script has NO write path, and the runner's apply input is ignored.
  sharding ON -- slot 1/32. THIS RUN COVERS 1/32 OF THE POPULATION; dispatch every slot 0..31 or the sweep is partial.
  SPORTS filter: pokemon
  scanned 124,596 rows in 329s (379 rows/s)
  population sampled: 3,974 of 889,860 measured unknown-key rows (14.29%)
  shard 1/32 -- 120,622 rows belong to other shards

  BUCKET                       sampled      share    extrapolated (95% CI)
  fleet fixes (IMPROVE+backed)     436      11.0%       97,629 ± 8,647
  reads product, no checklist      556      14.0%      124,500 ± 9,598
  needs vocabulary               2,004      50.4%      448,737 ± 13,833
  underivable                       84       2.1%       18,809 ± 3,980
  CONFLICT                         894      22.5%      200,185 ± 11,553
  AGREE                              0       0.0%            0 ± 1
  PROTECTED (report-only)            0       0.0%            0 ± 1

  UNDERIVABLE by reason:
    guard:cardnumber-unparsed      65   ~14,555
    non-card-format                13    ~2,911
    lot-or-range                    6    ~1,344
```

Note `census-unknown-setkey` was chosen over `rematch-sold-comps mode=census` for the
dispatch because it splits the CONFLICT class into the two buckets that matter —
"reads the product but has no checklist" vs "needs vocabulary" — which is exactly the
distinction §3 turns on. It also carries a hard gate: an `apply=true` dispatch of it is
refused outright by the workflow, so it cannot be run any way but read-only.

**The extrapolated column of that banner is wrong and should be disregarded** — it scales
by the 889,860 constant refuted in §0. The `sampled` and `share` columns are sound. Its
shard-1 shares (11.0% fleet-fixable, 50.4% needs-vocabulary) sit close to this report's
independent Pokémon sample (7.6% writable, 41% UNDERIVABLE), from a different sampling
frame and a different script — two roughly agreeing measurements of the same thing.

---

## 5. What this says to do

1. **Fix the constant before quoting it.** `POPULATION_TOTAL = 889860` in
   `census-unknown-setkey.cjs` overstates its own population 3.3×, and the population
   predicate should read `hobbyiqCardId` as well as `cardId` — 395,749 rows are invisible
   to it today. Until then, no number that script extrapolates should be quoted.
2. **The IMPROVE fleet already pays down what is payable** — ~44,000 rows projected, no
   new lane, no new input, no one-off patch. `setkey_like=unknown` + `sports=<sport>` is
   the dispatch, and `mode=census` proves each slot before any apply is considered.
3. **The binding constraint is checklists, not the parser.** The parser reads a product
   on 39% of rows and the fleet may move 4.5%; 15 of the top 30 destinations have zero
   checklist-backed rows, and every probed vocabulary candidate scores 0/N. Teaching the
   parser more products moves nothing until the checklists land. The acquisition list in
   §3 is ordered by rows for exactly that reason.
4. **Two ingest lanes emit the whole population** — cardhedge (61.8%) and tca-ebay
   (38.2%). The rematch pays down the stock; only an emitter fix stops the flow. Worth
   sizing how many rows these two lanes add per day under an `unknown` key.
5. **`non-sport` and `other` (55,415 rows) are inert** at 0% writable, 98.5% UNDERIVABLE.
   They should not be dispatched against until they have a vocabulary and checklists.
6. **The sport field defect (§2) overlaps #1924** and distorts the per-sport table by an
   unmeasured amount. Named here, owned there.

---

## Method, and what was not done

- **Read-only throughout.** No write path was invoked; the one dispatched run was
  `apply=false` against a script the workflow refuses to run with `apply=true`.
- **Population sizing**: complete paged sweep, id-only projection, `CONTAINS` as filter +
  segment-4 read in JS as predicate, 664,810 rows in 322s at 2,067 rows/s. Throughput was
  measured on a 2-minute probe before the full sweep was launched.
- **Cross-check**: a second, independently written script re-walked the prior census's
  own `cardId`-only predicate to exhaustion and returned 269,060 against the sweep's
  269,061.
- **Classification**: 16,000 rows (2,000 per sport) through the fleet's imported
  `deriveIdentity` + `classifyRow` with per-destination catalog point reads. A census that
  models the classifier measures the model, so the classifier itself was called.
- **No cross-partition `COUNT` was run**, and no query was left to run for minutes.
- **Not done**: no apply, no scope change, no parser or vocabulary change, no checklist
  acquisition, and no fix to the sport-field defect. Every one of those is a separate
  decision on separate evidence.
