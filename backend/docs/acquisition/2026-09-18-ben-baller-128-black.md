# Acquisition REFUSED — 2022 Topps Chrome Ben Baller #128 "Black"

**Asked 2026-09-18: acquire the Ben Baller #128 Black row from the checklist
source and stage it as a package. Three sources say the card does not exist, so
nothing is staged.**

## The question

One pool row claims it:

```
ONeil Cruz 2022 Topps Chrome Ben Baller Black Rookie RC #128 SP PSA 10 GEM MINT   $85
```

It sits in `hiq:baseball:2022:topps-chrome:128:image-variation:no-auto`, pooled
with two flagship variation sales, and R64 part (c) proposed moving it to
`topps-chrome-ben-baller:128:black`.

## Three sources: there is no Black parallel

| source | parallel ladder |
|---|---|
| **checklistcenter** | Green /99, Blue /75, Gold /50, Orange /25, Chartreuse /15, Rose Gold /10, Red /5, SuperFractor 1/1 — *"There is no BLACK parallel listed"* |
| **Cardboard Connection** (via its checklist/odds page) | Green /99 (1:15), Blue /75 (1:19), Gold /50 (1:28), Orange /25 (1:56), Chartreuse /15 (1:93), Rose Gold /10 (1:139), Red /5 (1:277), SuperFractor 1/1 (1:1,377), plus Purple "Friends & Family" /42 |
| **BaseballCardPedia**, verbatim | *"All base cards except the five high-number short-prints are also available in the following parallels. Green Refractor (serial-numbered to 99 copies) Blue Refractor (serial-numbered to 75 copies) Chartreuse Refractor (serial-numbered to fifteen)"* — and explicitly **no** Black, B&W or Black/White variant |

**Our own catalog agrees.** `topps-chrome-ben-baller` #128 holds 16 rows, all
`checklistcenter`: Base, Refractor Green /99, Blue /75, Gold /50, Orange /25,
Chartreuse /15, Rose Gold /10, Red /5, SuperFractor /1. No Black.

And `topps-chrome-black` — a real, separate product — has **zero** #128 rows, so
"Black" is not naming that product either.

## Why nothing was staged

`no synthetic parallels — only actuals` and R64b: **never mint from sales.**
Staging a `Black` row so the sale has somewhere to go would file $85 at an
address no publisher backs — the same error the two parked #221 "IMAGE
VARIATION SP" sales were held for, and which R64b then resolved by finding the
card was simply the short print.

## What the title probably means (NOT acted on)

Three readings, none source-attested:

1. **The seller's description of the card's look.** Ben Baller's design is a
   black-bordered chrome; "Black" may be describing it rather than naming a
   parallel. If so the card is `topps-chrome-ben-baller:128:base` — which
   exists, checklist-backed (`hiq:baseball:2022:topps-chrome-ben-baller:128:base:no-auto`,
   source `checklistcenter`).
2. **A confusion with the flagship `Topps Chrome Black` product** — but that
   product has no #128 Cruz, so this cannot be right as stated.
3. **A parallel no source documents.** Possible but unevidenced, and one eBay
   title is not a checklist.

Reading 1 is the most likely and the cheapest to verify, but "most likely" is
not attested — so the row is **parked**, not moved.

## Recommendation

- **Park** the Cruz Ben Baller row `identityUnverified` with this note, instead
  of the relocate R64 part (c) proposed. The amended entry is in
  `backend/data/pool-relocations/2026-09-18-r64-cruz-128-trout-200.json`.
- If Drew reads the title as describing the base card, the destination already
  exists and the park becomes a one-line relocate — no acquisition needed.
- Re-check if a source ever documents a Ben Baller Black; nothing to scrape
  today.

## Status of the rest of R64 part (c)

Unchanged and unaffected: the two flagship "Variation #128" rows stay where
they are, and Trout #200's parked row stays parked. Only the Ben Baller entry
moves from relocate to park.
