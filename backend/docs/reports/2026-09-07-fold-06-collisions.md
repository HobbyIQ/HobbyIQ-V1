# fold-06 refused-occupied adjudication — 43 entries, 0 true collisions

Run `34103870615` (REPORT) over `data/catalog-relocations/2026-09-07-pokemon-finish-token-fold-06.json`:

    entries considered      2,000
    RESLUGGED (moved)       1,388
    refused — occupied         43   <- adjudicated here

## The question this report answers

The lane refuses a reslug whose destination is held by a row with a different
`playerName`, because two cards must never share a pricing address. The refusal is
correct as a guard, but it is a *string* compare (`occupiedByDifferentCard` lowercases
and compares raw), so it cannot tell these two cases apart:

  - a FOLD  — the occupant is the same card spelled more fully, or
  - a COLLISION — the occupant is a genuinely different card.

Only a checklist can separate them, so each of the 43 was adjudicated against the
tcgdex checklist rows in `card_catalog` plus read-only prod point reads of both sides.

## The deciding fact

**At every one of the 43 (set, cardNumber) addresses, tcgdex names exactly ONE card.**
There is no plain `Jolteon` at `ex11#7` — only `Jolteon δ`. `ex11`/`ex13`/`ex14`/`ex15`
are the delta-species products, where the δ *is* the card. The moving row is in every
case an `ingest-auto-seed` transcription that dropped a glyph the seed could not carry.

This is the FALSE SPLIT direction that `playerIdentityKey`'s header (#1930) names: the
same card under two spellings getting two keys, so a fold that should resolve refuses.
It is *not* the dangerous FALSE MERGE direction — no plain card is being swallowed,
because the checklist says no plain card exists at these numbers.

Note `playerIdentityKey` alone would **not** have resolved these: it transliterates
δ→"delta", so `Jolteon δ`→`jolteondelta` ≠ `jolteon`. That is deliberate and right —
the checklist, not orthography, is what settles a dropped-suffix pair.

## Verdict

| class | n |
|---|---|
| same card, fuller spelling → **FOLD** (retire the seed row) | 43 |
| wrong cardNumber / wrong set → corrective reslug | 0 |
| genuinely different card → **true collision** | 0 |

No entry is excluded from `...-06b.json` as a collision. The report exists to record
the adjudication, not to park work.

## Direction of the fold, and where the sales go

The seed rows carry the sales (**1,140** across the 43); the canonical twins carry 17.
The fold still goes seed→twin, because identity is decided by the checklist and not by
sales volume — the twin is the row whose name matches the printed card.

These 43 become `retire`, matching the 569 retires already in part 06 for the same
finding. Per the lane's contract a retire leaves its sales **UNPLACED**: the
`hobbyiqCardId` keeps its old value and the address behind it is gone, so the rematch
re-places them onto the surviving canonical row. That hand-off is the intended path and
is stated here so its size (1,140 sales) is visible before the apply, not discovered
after.

A `reslug` was rejected as the shape: the destination is occupied by a live row, so the
move would still refuse — and forcing it would merge two catalog rows without the
survivor rule ever adjudicating them.

## The 43, with both sides as read from prod

| # | from (moving, id) | playerName | source | sales | occupant playerName | occupant source | tcgdex name at (set,#) | class |
|---|---|---|---|---|---|---|---|---|
| 1 | `hiq:pokemon:2005:ex11:7:reverse-holo:no-auto` | Jolteon | `ingest-auto-seed` | 54 | Jolteon δ | `finish-attested:cardhedge` | `Jolteon δ` | FOLD |
| 2 | `hiq:pokemon:2005:ex11:18:reverse-holo:no-auto` | Vaporeon | `ingest-auto-seed` | 76 | Vaporeon δ | `finish-attested:cardhedge` | `Vaporeon δ` | FOLD |
| 3 | `hiq:pokemon:2006:ex15:14:reverse-holo:no-auto` | Cloyster | `ingest-auto-seed` | 20 | Cloyster δ | `pokemon-tcg-data-scraped-2026-08-14` | `Cloyster δ` | FOLD |
| 4 | `hiq:pokemon:2023:sv2a:122:reverse-foil:no-auto` | Mr. Mime | `ingest-auto-seed` | 6 | mr-mime | `finish-attested:cardhedge` | `mr-mime` | FOLD |
| 5 | `hiq:pokemon:2006:ex15:68:reverse-holo:no-auto` | Trapinch | `ingest-auto-seed` | 14 | Trapinch δ | `pokemon-tcg-data-scraped-2026-08-14` | `Trapinch δ` | FOLD |
| 6 | `hiq:pokemon:2004:ex5:86:reverse-foil:no-auto` | Ancient Technical Machine Steel | `ingest-auto-seed` | 6 | Ancient Technical Machine [Steel] | `pokemon-tcg-data-scraped-2026-08-14` | `Ancient Technical Machine (Steel)`, `Ancient Technical Machine [Steel]` | FOLD |
| 7 | `hiq:pokemon:2006:ex15:20:reverse-holo:no-auto` | Mantine | `ingest-auto-seed` | 18 | Mantine δ | `pokemon-tcg-data-scraped-2026-08-14` | `Mantine δ` | FOLD |
| 8 | `hiq:pokemon:2006:ex15:10:reverse-holo:no-auto` | Snorlax | `ingest-auto-seed` | 50 | Snorlax δ | `finish-attested:cardhedge` | `Snorlax δ` | FOLD |
| 9 | `hiq:pokemon:2006:ex15:37:reverse-holo:no-auto` | Seadra | `ingest-auto-seed` | 11 | Seadra δ | `pokemon-tcg-data-scraped-2026-08-14` | `Seadra δ` | FOLD |
| 10 | `hiq:pokemon:2006:ex15:71:reverse-holo:no-auto` | Wooper | `ingest-auto-seed` | 23 | Wooper δ | `pokemon-tcg-data-scraped-2026-08-14` | `Wooper δ` | FOLD |
| 11 | `hiq:pokemon:2009:pl2:71:reverse-holo:no-auto` | Nidoran | `ingest-auto-seed` | 6 | Nidoran ♀ | `pokemon-tcg-data-scraped-2026-08-14` | `Nidoran ♀`, `Nidoran♀` | FOLD |
| 12 | `hiq:pokemon:2006:ex15:88:reverse-holo:no-auto` | Rainbow Energy | `ingest-auto-seed` | 7 | δ Rainbow Energy | `pokemon-tcg-data-scraped-2026-08-14` | `δ Rainbow Energy` | FOLD |
| 13 | `hiq:pokemon:2006:ex15:15:reverse-holo:no-auto` | Dewgong | `ingest-auto-seed` | 12 | Dewgong δ | `pokemon-tcg-data-scraped-2026-08-14` | `Dewgong δ` | FOLD |
| 14 | `hiq:pokemon:2006:ex15:30:reverse-holo:no-auto` | Flaaffy | `ingest-auto-seed` | 8 | Flaaffy δ | `pokemon-tcg-data-scraped-2026-08-14` | `Flaaffy δ` | FOLD |
| 15 | `hiq:pokemon:2006:ex15:25:reverse-holo:no-auto` | Xatu | `ingest-auto-seed` | 9 | Xatu δ | `pokemon-tcg-data-scraped-2026-08-14` | `Xatu δ` | FOLD |
| 16 | `hiq:pokemon:2006:ex14:30:reverse-foil:no-auto` | Charmeleon | `ingest-auto-seed` | 29 | Charmeleon δ | `pokemon-tcg-data-scraped-2026-08-14` | `Charmeleon δ` | FOLD |
| 17 | `hiq:pokemon:2006:ex14:2:reverse-foil:no-auto` | Blastoise | `ingest-auto-seed` | 61 | Blastoise δ | `finish-attested:cardhedge` | `Blastoise δ` | FOLD |
| 18 | `hiq:pokemon:2006:ex15:38:reverse-holo:no-auto` | Shelgon | `ingest-auto-seed` | 11 | Shelgon δ | `pokemon-tcg-data-scraped-2026-08-14` | `Shelgon δ` | FOLD |
| 19 | `hiq:pokemon:2014:xy4:97:reverse-holo:no-auto` | Head Ringer | `ingest-auto-seed` | 3 | Head Ringer Team Flare Hyper Gear | `finish-attested:cardhedge` | `Head Ringer Team Flare Hyper Gear` | FOLD |
| 20 | `hiq:pokemon:2006:ex15:50:reverse-holo:no-auto` | Horsea | `ingest-auto-seed` | 50 | Horsea δ | `pokemon-tcg-data-scraped-2026-08-14` | `Horsea δ` | FOLD |
| 21 | `hiq:pokemon:2006:ex15:45:reverse-holo:no-auto` | Cyndaquil | `ingest-auto-seed` | 37 | Cyndaquil δ | `pokemon-tcg-data-scraped-2026-08-14` | `Cyndaquil δ` | FOLD |
| 22 | `hiq:pokemon:2006:ex13:17:reverse-holo:no-auto` | Vileplume | `ingest-auto-seed` | 22 | Vileplume δ | `finish-attested:cardhedge` | `Vileplume δ` | FOLD |
| 23 | `hiq:pokemon:2006:ex15:44:reverse-holo:no-auto` | Chikorita | `ingest-auto-seed` | 29 | Chikorita δ | `pokemon-tcg-data-scraped-2026-08-14` | `Chikorita δ` | FOLD |
| 24 | `hiq:pokemon:2005:ex11:8:reverse-holo:no-auto` | Latias | `ingest-auto-seed` | 50 | Latias δ | `finish-attested:cardhedge` | `Latias δ` | FOLD |
| 25 | `hiq:pokemon:2006:ex15:61:reverse-holo:no-auto` | Ralts | `ingest-auto-seed` | 11 | Ralts δ | `pokemon-tcg-data-scraped-2026-08-14` | `Ralts δ` | FOLD |
| 26 | `hiq:pokemon:2004:ex5:84:reverse-foil:no-auto` | Ancient Technical Machine Ice | `ingest-auto-seed` | 7 | Ancient Technical Machine [Ice] | `pokemon-tcg-data-scraped-2026-08-14` | `Ancient Technical Machine [Ice]`, `Ancient Technical Machine (Ice)` | FOLD |
| 27 | `hiq:pokemon:2006:ex15:35:reverse-holo:no-auto` | Nidorino | `ingest-auto-seed` | 13 | Nidorino δ | `pokemon-tcg-data-scraped-2026-08-14` | `Nidorino δ` | FOLD |
| 28 | `hiq:pokemon:2003:ecard3:131:reverse-foil:no-auto` | Miracle Sphere Y | `ingest-auto-seed` | 3 | Miracle Sphere γ | `pokemon-tcg-data-scraped-2026-08-14` | `Miracle Sphere Gamma`, `Miracle Sphere γ` | FOLD |
| 29 | `hiq:pokemon:2006:ex15:59:reverse-holo:no-auto` | Pupitar | `ingest-auto-seed` | 4 | Pupitar δ | `pokemon-tcg-data-scraped-2026-08-14` | `Pupitar δ` | FOLD |
| 30 | `hiq:pokemon:2005:ex11:17:reverse-holo:no-auto` | Umbreon | `ingest-auto-seed` | 75 | Umbreon δ | `finish-attested:cardhedge` | `Umbreon δ` | FOLD |
| 31 | `hiq:pokemon:2006:ex15:11:reverse-holo:no-auto` | Togetic | `ingest-auto-seed` | 35 | Togetic δ | `finish-attested:cardhedge` | `Togetic δ` | FOLD |
| 32 | `hiq:pokemon:2006:ex15:2:reverse-holo:no-auto` | Feraligatr | `ingest-auto-seed` | 32 | Feraligatr δ | `finish-attested:cardhedge` | `Feraligatr δ` | FOLD |
| 33 | `hiq:pokemon:2006:ex15:13:reverse-holo:no-auto` | Arbok | `ingest-auto-seed` | 18 | Arbok δ | `pokemon-tcg-data-scraped-2026-08-14` | `Arbok δ` | FOLD |
| 34 | `hiq:pokemon:2003:ecard3:136:reverse-foil:no-auto` | Mystery Plate D | `ingest-auto-seed` | 3 | Mystery Plate δ | `pokemon-tcg-data-scraped-2026-08-14` | `Mystery Plate δ`, `Mystery Plate Delta` | FOLD |
| 35 | `hiq:pokemon:2018:sm5:138:reverse-holo:no-auto` | Unit Energy | `ingest-auto-seed` | 9 | Unit Energy LightningPsychicMetal | `finish-attested:cardhedge` | `Unit Energy LightningPsychicMetal` | FOLD |
| 36 | `hiq:pokemon:2019:sm115:63:reverse-holo:no-auto` | Misty's Water Command | `ingest-auto-seed` | 40 | Misty’s Water Command | `finish-attested:cardhedge` | `Misty’s Water Command`, `Misty's Water Command` | FOLD |
| 37 | `hiq:pokemon:2006:ex14:15:reverse-foil:no-auto` | Cacturne | `ingest-auto-seed` | 35 | Cacturne δ | `pokemon-tcg-data-scraped-2026-08-14` | `Cacturne δ` | FOLD |
| 38 | `hiq:pokemon:2005:ex11:3:reverse-holo:no-auto` | Dragonite | `ingest-auto-seed` | 76 | Dragonite δ | `finish-attested:cardhedge` | `Dragonite δ` | FOLD |
| 39 | `hiq:pokemon:2006:ex13:16:reverse-holo:no-auto` | Rayquaza | `ingest-auto-seed` | 54 | Rayquaza δ | `finish-attested:cardhedge` | `Rayquaza δ` | FOLD |
| 40 | `hiq:pokemon:2006:ex15:7:reverse-holo:no-auto` | Nidoqueen | `ingest-auto-seed` | 36 | Nidoqueen δ | `finish-attested:cardhedge` | `Nidoqueen δ` | FOLD |
| 41 | `hiq:pokemon:2006:ex15:3:reverse-holo:no-auto` | Heracross | `ingest-auto-seed` | 38 | Heracross δ | `finish-attested:cardhedge` | `Heracross δ` | FOLD |
| 42 | `hiq:pokemon:2003:ecard3:129:reverse-foil:no-auto` | Miracle Sphere A | `ingest-auto-seed` | 10 | Miracle Sphere α | `pokemon-tcg-data-scraped-2026-08-14` | `Miracle Sphere Alpha`, `Miracle Sphere α` | FOLD |
| 43 | `hiq:pokemon:2006:ex15:1:reverse-holo:no-auto` | Ampharos | `ingest-auto-seed` | 29 | Ampharos δ | `finish-attested:cardhedge` | `Ampharos δ` | FOLD |

Every row's destination is the canonical `reverse-holofoil` address and every
destination twin was confirmed live by point read (43/43).

## Sub-classes of the 43

| shape | n | example |
|---|---|---|
| δ delta-species suffix dropped | 32 | `Jolteon` vs `Jolteon δ` (ex11#7) |
| δ prefix dropped | 1 | `Rainbow Energy` vs `δ Rainbow Energy` (ex15#88) |
| Greek letter transcribed to a Latin letter | 2 | `Miracle Sphere A` vs `Miracle Sphere α` (ecard3#129) |
| δ transcribed as "D" | 1 | `Mystery Plate D` vs `Mystery Plate δ` (ecard3#136) |
| ♀ gender symbol dropped | 1 | `Nidoran` vs `Nidoran ♀` (pl2#71) |
| bracketed subtitle dropped | 2 | `Ancient Technical Machine Steel` vs `... [Steel]` (ex5#86) |
| trailing mechanic / subtitle dropped | 2 | `Head Ringer` vs `Head Ringer Team Flare Hyper Gear` (xy4#97) |
| display name vs slug-cased name | 1 | `Mr. Mime` vs `mr-mime` (sv2a#122) |
| curly vs straight apostrophe | 1 | `Misty's Water Command` vs `Misty’s Water Command` (sm115#63) |

The apostrophe pair (sm115#63) is the one case `playerIdentityKey` *would* have folded
on its own — `occupiedByDifferentCard` refused it only because that guard compares raw
strings instead of identity keys. Noted as a follow-up, not fixed here: this list is a
data correction, and changing a delete-bearing lane's guard is its own change.
