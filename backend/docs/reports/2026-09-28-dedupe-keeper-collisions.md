# Dedupe-keeper-collision remediation, 2026-09-28

Source: `C:/tmp/dedupeaudit_141758/REPORT.md` + `ALL-GENUINE-COLLISIONS.ndjson`
(213 rows, 204 unique `saleId` after removing 9 exact-duplicate audit rows).

## What this is

The 2026-09-26/27 isAuto-flip dedupe-by-list lists (`fb2025-isauto-strays`,
`bb2026-isauto-strays`) picked their surviving copy of a duplicate sale by a
**bare cardNumber match with no player check**. Where that bare number
collided across two unrelated products — an insert/autograph card number
(`RRA-AM`, `RA-TW`, `BPA-SH`, `91B2-CB`, ...) landing on a flagship product's
plain numeric slot (`#25`, `#7`, ...) — the "keeper" a sale survived as is a
real card_catalog row, but for a **different card and a different player**.
213 such sales were confirmed by the 2026-09-28 audit
(`namesAgree(sale.playerName ?? sale.title, row.playerName)`, playerName-first
precedence, matching `repoint-sales-by-list.cjs`'s own gate 6).

This pass re-derives each sale's own identity from its title using the real
deriver (`parseListingIdentity` + `computeHobbyIqCardId`, wired identically to
`rematch-sold-comps.cjs`'s own `deps` object, via
`scripts/lib/rematch-derive-identity.cjs`), then classifies each sale into
exactly one of three outcomes. **Read-only against Cosmos throughout — no
writes, no dispatches. The APPLY hold is in force.**

## Method

1. **Residency check** (point-read `sold_comps` at `(saleId, keepCardId)`):
   204/204 unique sales confirmed resident at `keepCardId` exactly as the
   audit recorded it. Zero `not-resident` skips.
2. **Derive** the sale's own identity from `saleTitle` via
   `deriveIdentity()` (the same function/deps `rematch-sold-comps.cjs` uses
   from `dist/`). 117/204 (57%) produced a usable slug; 87/204 could not
   (`cardnumber-unparsed` — the title states no `#N`-shaped card number at
   all, e.g. "Bo Nix — Purple Geometric Refractor Auto /75"; or
   `setkey-unknown-unsupported` — the parser could not resolve a product,
   e.g. "Wild Card 5 Card Draw").
3. **Point-read `card_catalog`** at the derived slug for the 117 derivable
   sales: 16/117 hit an existing row; 101/117 hit nothing (no checklist row
   at that address at all).
4. **Classify the 16 hits**: `catalogAuthorityOf(row.source)` must be
   `"checklist"` (15/16 are; 1 — `ingest-auto-seed` — is `"derived"` and is
   refused), and `namesAgree(sale.playerName/title, row.playerName)` must
   pass (4/15 pass cleanly; 11/15 fail — a genuine SAME-PRODUCT card-number
   collision at the derived address itself, e.g. 2025 Panini Score's Rookie
   Signatures insert numbering colliding with 2025 Score base numbering:
   `#28` is Drew Allar in one section and Joe Milton III in the other).

## Outcome (204 unique sales)

| class | count | file |
|---|---|---|
| **A. repoint** — checklist-grade destination, namesAgree confirmed | **4** | `backend/data/sales-repoints/2026-09-28-dedupe-keeper-collisions-repoint.json` |
| **B. park** — no checklist row exists for the derived product/number | **101** | `backend/data/pool-relocations/2026-09-28-dedupe-keeper-collisions-park.json` |
| **C. needsRuling** — title underivable, or derived address is occupied by a different player/not checklist-grade | **99** | `backend/data/sales-repoints/2026-09-28-dedupe-keeper-collisions-needsRuling.json` |
| not-resident (sale moved since the audit) | **0** | — |
| **total** | **204** | |

(213 raw audit rows − 9 exact duplicates = 204 unique; the repoint list
counts entries, not raw audit rows.)

### C breakdown

| needsRuling reason | count |
|---|---|
| title-underivable (no card number / no product resolvable from the title) | 87 |
| derived address exists, checklist-grade, but namesAgree fails (different player at that address) | 11 |
| derived address exists but is NOT checklist-grade (`derived`/`vendor` authority) | 1 |

## Per-source-product counts

**A. repoint (4)** — the sale's own re-derived product:

| product | count |
|---|---|
| topps-chrome | 2 |
| bowman (paper) | 1 |
| topps | 1 |

**B. park (101)** — the sale's own re-derived product (none of these exist in
`card_catalog` at all for this card number; every one is a checklist
acquisition gap, not a bug):

| product | count |
|---|---|
| leaf | 14 |
| leaf-metal | 12 |
| topps-chrome | 17 |
| panini-select | 5 |
| panini-prizm-draft-picks | 5 |
| topps-tier-one | 5 |
| topps-finest | 5 |
| topps-tribute | 5 |
| panini-photogenic | 6 |
| panini-rookies-and-stars | 4 |
| bowman-chrome | 3 |
| score | 3 |
| topps | 3 |
| panini-prizm | 2 |
| panini-immaculate | 2 |
| upper-deck | 2 |
| topps-signature-class | 1 |
| topps-chrome-black | 1 |
| panini-donruss | 1 |
| panini-mosaic | 1 |
| donruss-elite | 1 |
| donruss-optic | 1 |
| panini-national-treasures | 1 |
| topps-resurgence | 1 |

**C. needsRuling (99)**:

| product | count |
|---|---|
| (title underivable — no product identified) | 87 |
| panini-rookies-and-stars (different-player collision within the product) | 7 |
| score (different-player collision within the product) | 4 |
| topps-chrome-black (not checklist-grade at the derived address) | 1 |

## Examples

- **Repoint** `tca-ebay::147381765593` — "2025 Topps Chrome Andrew Mukuba
  Rookie Autograph Orange /25 Eagles RRA-AM" sits at
  `hiq:football:2025:topps-chrome:162:orange-refractor:no-auto:num-25`
  (Cameron Dicker's base card — number `162`'s plain address) because the
  keeper pick matched only the bare `/25` print run and `orange-refractor`
  segments. Re-derives to
  `hiq:football:2025:topps-chrome:rra-am:orange-refractor:auto:num-25`,
  Andrew Mukuba's own checklist row, namesAgree-confirmed. `allowCrossProduct`
  is needed because `cardNumber` (162 vs RRA-AM) and `isAuto` (false vs true)
  differ — that disagreement is exactly the collision this list exists to fix.
- **Park** `tca-ebay::318351387794` — "2025 Leaf Optichrome Football — 1 of 1
  — Tempest — Autograph — Steve Young #1/1" sits at
  `hiq:football:2025:bowman:1:base:no-auto` (John Mateer's row). Re-derives to
  `hiq:football:2025:leaf:1:unknown:auto:num-1` — Leaf Optichrome has never
  been acquired into this catalog, so nothing backs that address. Parked
  rather than guessed.
- **needsRuling (different-player collision at the derived address)**
  `tca-ebay::389539511156` — "2025 Score Joe Milton III Base Signatures Auto
  #28 Patriots" re-derives to `hiq:football:2025:score:28:base:auto`, which
  IS a checklist-grade row — for Drew Allar. 2025 Panini Score's Rookie
  Signatures insert section numbers its cards independently of the base set,
  and this deriver has no insert-subset axis to tell the two `#28`s apart.
  Flagged for a human, not repointed onto Drew Allar's card.
- **needsRuling (title underivable)** `tca-ebay::257522247087` — "2025 Wild
  Card 5 Card Draw — Bhayshul Tuten Auto — 1/3 Jaguars Running Back" — the
  parser cannot resolve "Wild Card" to a registered setKey.

## What this pass does NOT do

- No writes. No `BACKFILL_APPLY`/`APPLY` dispatch of either list.
- No retire of the emptied `keepCardId` catalog rows the repoint list moves
  sales OFF of — that is `relocate-catalog-rows-by-list`'s own follow-up,
  exactly as `repoint-sales-by-list.cjs`'s own header states the two-step
  sequence.
- No acquisition of the checklist gaps the park list's evidence names (Leaf
  Optichrome, 2026 Topps Chrome Olympics/Disney/UFC inserts, Panini
  Immaculate, the 1991 Topps Autograph Insert reprint set, etc.) — flagged
  for the acquisition queue.
- No resolution of the 99 needsRuling rows — every one needs a human decision
  (an insert-subset numbering rule, or a better title parse) this pass cannot
  make safely.
