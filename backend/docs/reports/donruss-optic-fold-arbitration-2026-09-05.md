# donruss-optic football 2024 — the fold arbitration, re-measured under the new survivor rule

Read-only, 2026-09-05. Live `card_catalog` and `sold_comps`. Nothing written, nothing dispatched.

This re-runs the population the 2026-09-05 arbitration judged (`donruss-optic-arbitration-2026-09-05.md`), under `CF-A-FOLD-NEVER-CHANGES-THE-PLAYER`. **Two of the judgment's load-bearing measurements do not reproduce**, and both change what the dispatch should be. They are stated first, because the ruling's application depends on them.

## 0. What does not reproduce — the destination is not what was measured

The judgment reports the destination as **1,846 rows, 100% `hobbymonitor`**, and concludes "there is **no** checklistinsider transcription at the destination at all… the authority gradient runs backwards." Re-read today:

| side | rows | identity / graded | source mix |
|---|---|---|---|
| alias `panini-optic` | 17,003 | 14,984 / 2,019 | `checklistinsider` 15,995 · `ingest-auto-seed` 1,008 |
| dest `donruss-optic` | **13,080** | 13,080 / 0 | **`checklistcenter` 11,234 (86%)** · `hobbymonitor` 1,846 (14%) |

The 1,846 hobbymonitor rows are real and are exactly the slice the judgment saw — but they are 14% of the destination, not all of it. The destination is majority **`checklistcenter`**, a first-class transcription that requires no corroboration at all.

**Consequence.** The judgment's premise ("the vendor-ish transcription wins 100% of the time, purely by being there first") described a 186-pair sample drawn from the hobbymonitor slice. The true twin population is **10,197 pairs**, and the source pairing across them is overwhelmingly checklistinsider-vs-checklistcenter — two real transcriptions, neither demoted. The market-referee finding ("checklistinsider wins 24, hobbymonitor 5") likewise does not generalise: over the full population the two sides win **30 and 30**.

That is why the rule shipped here is about **evidence** and not about a source's name. A rule that demoted `hobbymonitor` would have been right in #1795, right on the judgment's 186-row sample, and **wrong on 97% of the actual population**.

## 1. The rule

`chooseSurvivor` (`backend/src/services/catalog/catalogRowOps.service.ts`) now runs:

1. **Authority** — unchanged, and still decisive. A rank gap is already an answer; a derived seed row's guess at a player is not evidence against a checklist.
2. **The player, within one authority class** — two rows naming *different people* at one address are contradicting each other about what card this is. That is not a tiebreak. It is settled by corroboration or not at all:
   - **arm 1, a second strict source** at the identity cell — `corroborationOf` from `sourceCorroboration.ts`, called by name rather than re-spelled. A copy the second source *contradicts* (`player-disagrees`) loses, whichever side of the move it is on.
   - **arm 2, the sale titles' majority** at that card number — the refereeing the audit already did, handed in via `playerEvidence.titlePlayerCounts` rather than re-derived.
   - **neither corroborated → REFUSE, by name.** `action: "refused"`, both names on the result, and **nothing is written**: no upsert, no sale re-pointed, no graded child retired, no delete.
3. vendorIds → sales → confidence → the incumbent keeps its address (unchanged).

A survivor that won on arbitration carries a **marker**, never a silent absorb: `supersededPlayerName`, `playerArbitratedBy`, `playerArbitrationDetail`. The contradiction disqualifies the *row*, not the card.

`playerEvidence` is optional and **omitting it means "I gathered nothing"** — so a different-player collision then refuses rather than folding. Every existing caller that passes nothing becomes safe by default; none becomes wrong.

## 2. football 2024, re-measured under the rule

Full population, not a sample: all 14,984 alias identity rows point-checked against the destination.

```
identity move candidates (alias)     14,984
  MOVE (no twin at destination)       4,787
  FOLD on the ordinary ladder         9,990   (authority-decided: 0)
  FOLD, alias wins on corroboration      30
  FOLD, dest  wins on corroboration      30
  REFUSED (neither corroborated)        147   across 30 card numbers
  subset-derived                          0   (see §3)
```

**Authority-decided: 0.** Every one of the 10,197 twin pairs is same-class (rank 3 on both sides), which is precisely the tie the judgment identified — now confirmed over the full destination rather than a 186-row slice.

**The polarity flips within one product**, which is the whole argument for an evidence rule:

```
ALIAS WINS                                       DEST WINS
#40 gold  Ja'Marr Chase  x11 > Will Shipley 0    #9  base Michael Penix Jr. x31 > Tyler Allgeier 2
#38 b-pan Joe Burrow     x10 > Trey Benson   0   #11 b-pan Rome Odunze      x29 > Kyle Pitts      1
#41 base  Chase Brown    x 2 > Xavier Legette 0  #16 gold  Josh Allen       x26 > Mark Andrews    0
#34 gold  D'Andre Swift  x 3 > Ricky Pearsall 0  #6  dragon Bo Nix          x23 > Budda Baker     2
```

checklistinsider wins 30 and loses 30. Neither transcription is the reliable one.

### The 147 refusals — small, and named

30 card numbers, listed in full so a human can settle them. A sample:

```
#18 dragon/ice/gold-vinyl  alias "Kyle Hamilton"  (0) vs dest "Devin Leary" (0); market top "Derrick Henry" x31
#2  holo   alias "Jalin Hyatt"    (0) vs dest "James Conner"  (0); market top "Jayden Daniels"     x43
#4  b-pan  alias "Zay Jones"      (1) vs dest "Marvin Harrison Jr." (11); market top "Drake Maye"  x49
#19 gold   alias "Josh Allen"    (24) vs dest "Lamar Jackson"  (3); market top "Justin Jefferson"  x26
#24 gold   alias "Dawson Knox"    (6) vs dest "Johnny Manziel" (6); market top "Roger Staubach"    x29
```

The shape is consistent and it is the reason these refuse rather than resolve: **the market's top seller at the number is usually a third player neither catalog names.** Both transcriptions are wrong at these 30 numbers, and a rule that picked one would have picked wrong. 147 rows is 0.98% of the cell.

## 3. The subset axis — measured, and NOT required for this move

#1744's grammar (`hiq:{sport}:{year}:{setKey}[:sub-{slug}]:{number}:{parallel}:{auto}`) is deliberately narrow: `subsetInId` is a **persisted catalog decision**, set at ingest only where a cardNumber "appears under more than one subset at this rung". The segment joins the identity *only where two subsets share numbers*.

The judgment proposed that Optic's rookie/insert subsets must carry the segment before any row moves. Measured:

```
alias rows whose `parallel` swallows a subset phrase          1,120  (7.5%)
  ("Rookie Primary Colors Dragon", "My House! Gold Vinyl", …)
(number, parallelSlug) cells holding >1 player where at
  least one row is subset-bearing — i.e. collisions a
  subset segment would fix                                        0
```

**Decision: no subset segment is derived for this move.** The condition #1744 states — two subsets sharing a number — does not occur in this cell. The subset text is riding in `parallel`, which makes those rows' *parallel* wrong, but it does not make their *identity* ambiguous: because the phrase is in the parallel slug, subset-bearing rows already occupy distinct cells from base rows, and zero cells hold two players by way of a subset clash.

Adding a segment where no clash exists is precisely what #1744's header forbids ("a matcher that read 'Aptitude for Altitude' out of a title and appended it would mint a subset-bearing id for a card that has no clash, which is the fragmentation this rule exists to avoid").

**The parallel-hygiene defect is real and is separate work**: 1,120 rows whose `parallel` should be a subset field plus a clean parallel. That is a parser repair on the checklistinsider ingest, not a change to the identity grammar, and it is not gated on this move. Filed, not fixed here.

## 4. Dispatch plan — catalog then pool, football 2024 only

REFUSED is 147 rows (0.98%) across 30 named numbers, and every one is inspectable from §2. That is small and named, so a dispatch is recommended **for this cell only**.

| # | lane | scope | expected |
|---|---|---|---|
| 1 | `rekey-product-setkey` **MODE=catalog** | `sport=football years=2024 from=panini-optic to=donruss-optic` REPORT | the §2 counts, re-confirmed on the day |
| 2 | same, **APPLY** | as above | 4,787 MOVE · 10,050 FOLD · 147 refused-and-reported · 2,019 graded retired |
| 3 | `rekey-product-setkey` **MODE=pool** | `sport=football years=2024 from=panini-optic to=donruss-optic` REPORT then APPLY | sales carried by segment surgery; mints nothing |
| 4 | re-read | the 30 refused numbers | a human ruling, or a checklist acquisition |

**`RETIRE_UNTWINNED` stays OFF for this cell.** It exists to stop `hobbymonitor` minting identities untwinned; here the moving side is `checklistinsider`, which is not a distrusted source, and the 4,787 MOVEs land at a destination that is 86% `checklistcenter`. Arming it would divert 4,787 legitimate moves.

**The other eight cells are NOT cleared.** football 2023/2025/2022 and basketball 2024/2023/2022/2021/2025 must each be re-measured in REPORT first — the judgment's own caution, and §0 is why: this cell's source mix was misread once already, and there is no reason to assume another cell's matches it.

## 5. Separate defect — 2025 product filed under cardYear 2024

Reported, **not fixed here**. Counted:

```
Optic football sales by cardYear:  2023 2,422 · 2024 5,474 · 2025 10,405
2025-rookie sales carrying cardYear 2024:                        350
```

The judgment named four players. Measured:

| player | Optic sales | where they sit | 2024 catalog rows naming them |
|---|---|---|---|
| Bo Nix | 405 | 2024#209 x265, 2024#3 x42, **2025#31 x36**, 2024#6 x23 | 249 |
| Jaxson Dart | 1,146 | 2025#273 x750, 2025#2 x195, 2025#11 x46 | **0** |
| Cam Skattebo | 449 | 2025#228 x288, 2025#5 x67 | **0** |
| Treveyon Henderson | 142 | 2025#248 x72, 2025#23 x50 | **0** |

**The judgment's framing is half right.** Dart, Skattebo and Henderson are correctly filed under 2025 and correctly absent from the 2024 catalog — they surfaced in the §2 referee only because that tally keyed on card *number* across both years, so 2025 #2 and 2024 #2 pooled together. That is a defect in the referee's keying, not in the data.

Bo Nix is different and is a genuine defect: **350 sale rows** carry `cardYear: 2024` on titles that are 2024 product but at numbers the 2024 catalog does not hold that way (`#209 Red Hyper` x265). Separately, a real year-attribution error exists in the **referee's** cross-year number collision, which is why the 30 refusals above show a "market top" that is often a 2025 rookie.

A second shape, larger and cleaner to fix: **50 card numbers whose top seller neither catalog names**, 69 sale rows, all of them insert-code numbers the catalog has no rows for at all (`#FYF-CDN` Cooper DeJean x6, `#SSH-TBY` Tank Bigsby x4, `#DTB-LJN` Lamar Jackson x2). That is a checklist-coverage gap for Optic's insert sets, not a year defect.

Recommended follow-up, in order: (a) key the pool referee on (year, number) not number alone; (b) audit the 350 `cardYear: 2024` Bo Nix rows; (c) acquire the Optic insert-set checklists behind the 50 uncovered numbers.

---

*Evidence: live Cosmos reads 2026-09-05 via `backend/scripts/probe-optic-fold-corroboration.cjs`, `probe-optic-dest-composition.cjs`, `probe-optic-year-defect.cjs`. Read-only; nothing written.*
