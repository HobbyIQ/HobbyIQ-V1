# The 19 ruled `ja-` keys with no tcgdex JA set under their own code

**Date:** 2026-09-07 · **Mode:** READ-ONLY — every number below is a live read of
`api.tcgdex.net/v2` (218 EN sets, 184 JA); nothing was written to Cosmos and no lane was armed ·
**Scope:** the 19 keys #1959 named as lacking a checklist.

Companion to #1959 (CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY, R5), which ruled the address and
stated the cost: *"19 of the 38 keys have a tcgdex-ja checklist behind them and 19 do not."* This
report answers the question that ruling deferred — **for each of the 19 without, is a permissive
source actually missing, or is the set served under an id we never looked up?**

## Headline

**8 of the 19 are not acquisitions at all.** tcgdex serves the Japanese product, under its own
Japanese id — `PMCG2`, `E1`, `PCG*` — and our lanes never asked for it, because they searched by the
*English* code. Only 4 need a publisher we do not hold.

| verdict | keys | what it means |
|---|---:|---|
| **served by tcgdex under a JA id** | 8 | the checklist exists upstream today; a lane scope change reaches it |
| **empty upstream** | 3 | tcgdex serves the set, `cards: []` — the XY/SWSH-era hole already pinned |
| **absent from tcgdex** | 4 | BW-era; no permissive source held |
| **JA product is a different print** | 4 | DP-era; the JA twin is a separate product, see below |

## The cells

Format is the repo's per-`year | setKey` acquisition cell. `sourceRef` is the tcgdex JA set id — the
address the lane must ask for, **not** the English code the ruling keys on.

| year | setKey | JA product (alias) | candidate source | sourceRef | cards | status |
|---:|---|---|---|---|---:|---|
| 1996 | `ja-base1` | expansion-pack | tcgdex-ja (MIT) | `PMCG1` | 102 | **HELD — queue it** |
| 1997 | `ja-base2` | jungle | tcgdex-ja (MIT) | `PMCG2` | 48 | **HELD — queue it** |
| 1997 | `ja-base3` | mystery-of-the-fossils | tcgdex-ja (MIT) | `PMCG3` | 48 | **HELD — queue it** |
| 1998 | `ja-gym1` | leaders-stadium | tcgdex-ja (MIT) | `PMCG5` | 96 | **HELD — queue it** |
| 1999 | `ja-gym2` | challenge-from-the-darkness | tcgdex-ja (MIT) | `PMCG6` | 98 | **HELD — queue it** |
| 2001 | `ja-ecard1` | base-expansion-pack | tcgdex-ja (MIT) | `E1` | 128 | **HELD — queue it** |
| 2002 | `ja-ecard2` | the-town-on-no-map | tcgdex-ja (MIT) | `E2` | 92 | **HELD — queue it** |
| 2002 | `ja-ecard3` | wind-from-the-sea | tcgdex-ja (MIT) | `E3` | 90 | **HELD — queue it** |
| 2020 | `ja-swsh2` | rebellion-crash | tcgdex-ja (MIT) | `S2` | **0** | EMPTY upstream |
| 2020 | `ja-swsh3` | infinity-zone | tcgdex-ja (MIT) | `S3` | **0** | EMPTY upstream |
| 2020 | `ja-swsh4` | amazing-volt-tackle | tcgdex-ja (MIT) | `S4` | **0** | EMPTY upstream |
| 2011 | `ja-bw2` | red-collection | — | `BW2` absent | — | **NO SOURCE HELD** |
| 2012 | `ja-bw4` | dark-rush | — | `BW4` absent | — | **NO SOURCE HELD** |
| 2012 | `ja-bw7` | plasma-gale | — | `BW7` absent | — | **NO SOURCE HELD** |
| 2013 | `ja-bw9` | megalo-cannon | — | `BW9` absent | — | **NO SOURCE HELD** |
| 2007 | `ja-dp1` | space-time-creation | — | `DP1` absent | — | see "different print" |
| 2007 | `ja-dp2` | secret-of-the-lakes | — | `DP2` absent | — | see "different print" |
| 2007 | `ja-dp3` | shining-darkness | — | `DP3` absent | — | see "different print" |
| 2008 | `ja-dp6` | intense-fight-in-the-destroyed-sky | — | `DP6` absent | — | see "different print" |

### The 8 held ones are a lane scope miss, not a gap

Same shape as the 1933 Goudey finding in `checklist-gaps-my-domain-2026-09-05.md`: *"'no permissive
source' was a statement about this repo's cell list, not about the web."* Here the cell list is the
lane's id filter. `scrape-tcgdex-ja.cjs` asks tcgdex for the set whose id equals the **English** code,
and there is no JA set called `base2` — the Japanese Jungle is `PMCG2`. The set was never missing; the
lane asked for it by a name it does not have.

These 8 are already in `data/ingest-universe.json` as `tcgdexja::` entries and the vintage lane already
knows their English names (`SET_EN` in the scraper names `PMCG1`-`PMCG6`). What it does **not** yet do
is key them to the ruled `ja-<code>` address — it keys by name,
`<year>-japanese-<name>-pokemon`. Reaching the ruled key is a **key derivation** change to that lane,
which is a vocabulary decision and is therefore **reported here, not made in this PR.**

### The 4 DP cells are not the same card, and must not be minted as if they were

`PCG1` "伝説の飛翔" (2004-04-09, 82 cards) is *not* the Japanese print of EN `dp1` "Diamond & Pearl"
(2007-05-01). The eras do not line up: the JA alias `space-time-creation` names a 2007 JA product
tcgdex does not serve, while `PCG1`-`PCG6` are the 2004-05 PCG-era sets, which are **their own
products with their own ids** and are already in the universe under those ids. Minting `PCG1` onto
`ja-dp1` would be the same defect in the other direction — a different card on a shared address.

**These four need the DP-era JA source, not a re-pointing of PCG.** Left as `NO SOURCE HELD`.

### The 3 empty ones are a known source hole, already pinned

`S2`/`S3`/`S4` answer HTTP 200 with a populated `cardCount` and `cards: []`. That is the exact
condition `tcgdexJaEmptySetIsNotALaneFailure.test.ts` pins as *"a set the source does not card is not
a broken lane"* (32 of 97 vintage entries behave this way). No acquisition is possible until tcgdex
fills them; the key still **stands** as the correct address.

## Sources checked and REFUSED

Unchanged from `fetchPokemonSetCodes.cjs`, and re-affirmed here because these 4 BW cells are exactly
where the temptation to relax it appears:

- **pokemontcg.io** — free tier is **NON-COMMERCIAL only** (dev.pokemontcg.io/terms). HobbyIQ is a
  commercial product. **REFUSED on licence, not on quality.**
- **Bulbapedia** — **CC BY-NC-SA 2.5**; the NC clause forbids commercial reuse. **REFUSED.**
- **sportscardchecklist.com** — the vintage workhorse for baseball/football/hockey, but it is
  **sports-only**; it publishes no Pokémon checklists. Not a candidate for any cell here.

tcgdex remains the only held permissive Pokémon source (MIT, `tcgdex/cards-database`).

## What a reader should do with this

1. The **8 HELD** cells want a lane change so the tcgdex JA vintage sets stage under their ruled
   `ja-<code>` key. That is a vocabulary decision on top of R5 and belongs in its own ruled PR.
2. The **4 BW** cells are a genuine acquisition ask — a permissive JA source for the 2011-13 BW era.
3. The **3 SWSH** and **4 DP** cells need nothing from us: one is an upstream hole, the other is a
   product-identity question that must not be closed by substitution.

**Nothing in this report was applied.** No Cosmos write, no staging, no manifest change.
