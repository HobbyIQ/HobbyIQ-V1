# Acquisition note — does 2022 Topps Chrome #221 have an Image Variation SP?

**Opened 2026-09-18 under R64 extended (Drew). Two real PSA 10 sales are PARKED
until a source answers this.**

## The question

Two CardHedge sales state an Image Variation **SP** at card #221:

```
BOBBY WITT JR 2022 TOPPS CHROME SP PSA 10 IMAGE VARIATION RC #221 JC   $1,050
BOBBY WITT JR 2022 TOPPS CHROME SP PSA 10 IMAGE VARIATION RC #221      $725
```

No checklist in the catalog attests such a card.

## What the catalog says today

| source | evidence |
|---|---|
| `beckett-scraped-2026-09-01` | 30 SP/SSP image-variation rows for 2022 `topps-chrome`. Card numbers run **1, 1, 4, 6, 8, 14, 22, 24, 25, 35, 35, 42, 66, 74, 80, 81, 96, 99, 113, 128, 128, 129, 133, 150, 165, 166, 177, 200, 201, 220** — **221 is not among them.** |
| `cardpedia-drew-ruling-2026-09-11` | BCP lists #221 under Gimmicks → **Sonic**, and the 2026-09-12 list recorded that Beckett's SP and SSP lists do not include 221. |

So the only variation tier any source attests for #221 is **Sonic**.

## Why the rows are parked, not minted

`no synthetic parallels — only actuals` and R64 extended: **never mint from
sales.** A sale title is a claim, not a checklist. Minting an
`image-variation-sp` row for #221 on the strength of two titles would file real
money at an address no publisher backs — the failure one level up from a
synthetic parallel. Absent beats wrong.

The two rows are therefore parked `identityUnverified` in
`backend/data/pool-relocations/2026-09-18-r64-witt-221-four-cards.json`.

## What would resolve it

Check whether **#221 appears in an SP (or SSP) image-variation list** for 2022
Topps Chrome:

1. **Cardboard Connection** — 2022 Topps Chrome Baseball checklist page; it
   carries the variation tiers as sections. Note the 09-11 ruling already
   recorded that "Cardboard Connection has no Sonic section (2 tiers)", so it
   is the natural place to see whether its SP tier includes 221.
2. **TCDB** — `2022 Topps Chrome` set page, variations subset. (TCDB returned
   HTTP 403 to WebFetch on 2026-09-16; it may need a different fetch path.)
3. Beckett, if it comes back — its SP/SSP lists are the ones that currently
   exclude 221, so a re-scrape would either confirm the exclusion or correct it.

## The three outcomes

- **#221 IS in an SP list** → mint `image-variation-sp`, unpark the two rows
  onto it, cite the source.
- **#221 is NOT in any SP list** → the two titles are mis-stated (a seller
  writing "SP" for the Sonic short print is plausible: the Sonic rows
  themselves say "Short Print"). Fold the two onto Sonic, with the reason.
- **Sources disagree** → report both and ask Drew, as with the Dodger Blues
  13-vs-15 discrepancy.

Do **not** guess between these from price alone: the parked PSA 10s ($725,
$1,050) sit in the same band as the Refractor PSA 10s ($975.99, $1,000), so
price does not separate them.
