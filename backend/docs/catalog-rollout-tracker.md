# Catalog-First Rollout Tracker

**Owner:** Drew
**Started:** 2026-08-04
**Approach:** decade-first, sport-per-decade, systematic — no skipping

For each cell: `B` = backfill done, `E` = enrichment done, `L` = ladder authored, `⏳` = running, `—` = todo, `n/a` = not applicable

## 2020s decade — priority 1

### Baseball

| Year | Backfill | Enrich | Notes |
|---|---|---|---|
| 2020 | — | — L needed | Bobby Witt CPA-BWJ auto lives here |
| 2021 | — | — L needed | |
| 2022 | — | — L needed | |
| 2023 | — | — L needed | |
| 2024 | ✓B (10,883 patched, 43s) | — | L done for Bowman Chrome + Draft + Topps Chrome |
| 2025 | ⏳ running | — | L done for Bowman Chrome + Draft + Topps Chrome |
| 2026 | ⏳ running | — | L done for Bowman Chrome + Draft + Topps Chrome; Victor Figueroa cards |

### Basketball / Football / Hockey / Soccer (2020s)

All todo. Do after baseball decade completes.

## 2010s decade — priority 2

### Baseball

| Year | Backfill | Enrich | Notes |
|---|---|---|---|
| 2010 - 2017 | — | — L needed | |
| 2018 | — | — L done | Ohtani rookie lives here |
| 2019 | — | — L needed | |

### Basketball / Football / Hockey / Soccer (2010s)

All todo.

## 2000s decade — priority 3

### Baseball

| Year | Backfill | Enrich | Notes |
|---|---|---|---|
| 2000 - 2009 | — | — L needed | |

## Pre-2000 — priority 4

Vintage. Rollup + backfill still work; ladders per year may not exist for very old products.

## Playbook per year

For each (decade, year, sport):

1. **Backfill:** `npx tsx backend/scripts/backfill-soldcomps-canonical.ts --year YYYY --sport SPORT --auto-approve`
   Fast with patch-ops: ~30-60 sec for ~10K delta rows.

2. **Author ladder (per product family):** research Beckett + Topps + Cardsmiths, hand-author rungs in `parallelLadders.ts`, tsc + commit.

3. **Enrichment:** `npx tsx backend/scripts/enrich-parallel-ladder.ts --year YYYY --set-key SETKEY --auto-approve`
   Seeds missing parallels per the ladder.

4. **Mark ✓ in this doc.**

## Ladders authored (as of 2026-08-04)

| Product family | Year | Auto | Non-auto |
|---|---|---|---|
| Bowman Chrome | 2018 | ✓ | ✓ |
| Bowman Chrome | 2024 | ✓ | ✓ |
| Bowman Chrome | 2025 | ✓ | ✓ |
| Bowman Chrome | 2026 | ✓ | ✓ |
| Bowman Draft | 2024 | ✓ | ✓ |
| Bowman Draft | 2025 | ✓ | ✓ |
| Bowman Draft | 2026 | ✓ | ✓ |
| Topps Chrome | 2024 | — | ✓ |
| Topps Chrome | 2025 | — | ✓ |
| Topps Chrome | 2026 | — | ✓ |

Missing families that would help coverage: Bowman Draft Chrome Sapphire, Bowman Sterling, Panini Prizm (any year), Topps Chrome Update, Bowman Platinum, Stadium Club Chrome.
