# The catalog rebuild — full plan and state

Drew + Claude, 2026-08-28. The one-page truth for any session picking this up.
Doctrine that governs everything here: **the checklist is the spine** — identity
comes from checklists, sales and holdings match TO it, no pass invents
vocabulary, numbered Base is legitimate where a checklist lists it, FMV is a
projected next sale from the exact-identity pool, never a median.

## DONE and verified

- Catalog addressing 99.9% (`id === cardId === slug`, point-readable)
- Flagship parallel ladders 2016–2026 ingested (bcp-ladders, 234,863 rows;
  2026 Topps alone: 99 rungs)
- Checklist ingest guarded: authority-checked source names, verbatim fields,
  category-structure decides Base, one point-read per row (23k rows/min)
- Pokémon identity unified (numbers unglued, setKeys onto TCG-code vocabulary)
- Year-prefix twin setKeys unified across sports; season keys ruled
  (first year + bare key); bowman-paper folded into bowman BY RULING
- `checklistBacking` annotation on all four sports' derived rows
- Parallel mapping (cascade: exact / squash / unique long-form) applied
- **Pricing, live in prod**: never a bare median; exact-identity supremacy at
  the holdings/notify path (>= 3 exact comps → unified answer, no fallback rung
  may set the tier); divergence digest fires ONLY on exact-pool prices —
  fallback divergences are `engine_divergence_suspect` telemetry
- Internal holding resolver built (no vendor calls); dry-run: 31/92 resolved,
  12 corrections

## RUNNING (self-driving; each step fires on the last one's completion)

1. R2 verbatim reingest (4 shards) — restores what the numbered-Base
   retirement over-deleted, checklist words exact
2. → map redo (baseball, `mode=redo`, 8 slots) against the new rungs
3. → REANNOTATE all sports → **THE SCORECARD** (checklist-backing, before/after)
4. → R5: full 15.9M-sale rematch (`reslugAllSoldComps`, only-improve)
5. → RU rollback (Drew's go given): card_catalog 400k→~2.5k, sold_comps
   40k→8k — data plane, CI principal has no control plane
6. → holdings APPLY (`conform-holdings-to-catalog`, replace gate 0.95)

## NEXT BUILDS (in order)

1. **checklistcenter → canonical CSV converter** — last legacy source into the
   guarded pipe (its old ingester raw-upserts and must not be rerun)
2. **One valuation path** — retire the Cardsight-era graded compiler onto the
   canonical engine; route the 3 compiq route call sites through the canonical
   resolver (they have no hiq slug in scope; deriving it per-route is the
   refactor, not a patch). Acceptance: docs/pricing-obedience-audit.md
3. **Live matcher** — the runtime resolve path (sale/holding → checklist card →
   rung from ladder) becomes THE matcher, so derived rows stop being minted
4. Phase 07 — 58 writers bypassing upsertCatalogEntry (the red guard test
   `oneWayToBuildACatalogRow` names them)

## NEEDS DREW (not code)

- Vintage sourcing: 1990s baseball (Score/Fleer/etc.), Japanese Pokémon
  (593 keys / 65k rows) — no held source covers them
- Set-family rulings as annotation surfaces new pairs (bowman-chrome ≠ bowman
  stays inviolate)

## ACCEPTANCE (the definition of done)

- Ohtani: `hiq:baseball:2018:topps-chrome:150:refractor:no-auto` PSA 10 prices
  from its own pool (130 comps at last measure); the divergence digest stays
  quiet on it
- Hartman: exact sales anchor; $339-class outputs impossible
- Scorecard: checklist-confirmed + card-confirmed majority for baseball;
  every `unconfirmed` row carries a named acquisition reason
- A sale, a holding, and a search all resolve to the SAME checklist-minted card
