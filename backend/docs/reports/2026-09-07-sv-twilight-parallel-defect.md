# "SV Twilight Masquerade" mints a `twilight` parallel — 2,379 pool rows

**Status: FINDING, report-only.** Surfaced by the I9 stale-reference investigation
(#1964). Not fixed here — findings are data, never auto-fixes
(`project_pricing_invariant_auditor`), and a parallel-vocabulary change needs its
own measured lane.

## What happens

`parseListingIdentity` reads **`Twilight` as a PARALLEL** when a Pokémon title
names the set as `SV Twilight Masquerade`:

```
2024 Pokemon SV Twilight Masquerade Teal Mask Ogerpon Ex #211 PSA 10
  parallel: "Twilight"
  slug    : hiq:pokemon:2024:sv06:211:twilight:no-auto     <- WRONG
  correct : hiq:pokemon:2024:sv06:211:base:no-auto
```

The card is a base Ogerpon ex #211 from Twilight Masquerade. There is no
`Twilight` parallel; the word is half the set's name.

## The trigger is the `SV ` prefix, and it is specific to this set

| title | parallel |
|---|---|
| `2024 Pokemon SV Twilight Masquerade Teal Mask Ogerpon Ex #211` | **`Twilight`** |
| `2024 Pokemon SV Twilight Masquerade Pikachu #025` | **`Twilight`** |
| `2024 Pokemon Twilight Masquerade Teal Mask Ogerpon Ex #211` | `Base` ✓ |
| `Pokemon Teal Mask Ogerpon Ex #211` | `Base` ✓ |

And it is *only* Twilight — every other SV set reads correctly:

| title | parallel |
|---|---|
| `2024 Pokemon SV Surging Sparks Pikachu #025` | `Base` ✓ |
| `2024 Pokemon SV Stellar Crown Bulbasaur #143` | `Base` ✓ |
| `2024 Pokemon SV Shrouded Fable Mew #030` | `Base` ✓ |
| `2024 Pokemon SV Paldean Fates Charizard #234` | `Base` ✓ |
| `2024 Pokemon SV Prismatic Evolutions Umbreon #161` | `Base` ✓ |

## Why

`pokemonSetAliases.ts` carries `twilight-masquerade`,
`pokemon-twilight-masquerade`, `2024-twilight-masquerade`,
`scarlet-violet-twilight-masquerade` and
`2024-pokemon-scarlet-violet-twilight-masquerade` — but **not** the `sv-` prefixed
form. With `SV ` in front, the set-name match misses, the phrase is not consumed
as a set, and `Twilight` survives to the parallel reader, which accepts it as a
colour-ish token.

The other SV sets are unaffected because none of their names begins with a word
the parallel vocabulary will take (`Surging`, `Stellar`, `Shrouded`, `Paldean`,
`Prismatic` are not parallel tokens; `Twilight` reads as one).

## Blast radius

**2,379 rows** in `sold_comps` carry `SV Twilight Masquerade` in their title
(`c.sport='pokemon' AND CONTAINS(UPPER(c.title),'SV TWILIGHT MASQUERADE')`,
measured 2026-09-07). Every one of them is a candidate for a `:twilight:` slug
that should be `:base:` or the card's real parallel — a **split pool**, which is
the one-card-one-row-one-pool defect (`feedback_one_card_one_row_one_pool`).

The rows are visible in the I9 census as `AGREE -> CONFLICT` under the current
parser with axis `filled:parallel`: the row is correctly filed on `:base:` today
and today's parser wants to move it to `:twilight:`. **The stored rows are right
and the parser is wrong**, which is the opposite of the usual direction and is
why it is worth naming — an `IMPROVE` lane acting on `filled:parallel` would
move 2,379 correct rows onto a parallel that does not exist.

## Recommended fix (not applied here)

1. Add the `sv-` prefixed aliases to `pokemonSetAliases.ts`
   (`sv-twilight-masquerade`, and audit the other SV sets for the same gap).
2. Consider whether `Twilight` should be in the parallel vocabulary at all for
   the pokemon vertical — the set-name guard is the right layer, but a token that
   is only ever a set name is safer excluded.
3. Pin with the five titles above, both directions.

Until then: an IMPROVE apply lane touching `filled:parallel` on pokemon should
**refuse** `twilight` as a destination parallel.
