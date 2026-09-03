# Runbook — Market index rebuild (C-1 / H-11)

Recompute the stored 180-day market index series under the unified method.

## Why this exists

The 2026-09-03 pricing audit found the stored series was not internally
comparable. Two different methods were writing into it:

- **Nightly append** seeded carry-forward from a 14-day lead-in only. A basket
  member with no sale in 14 days dropped out, and `indexLevel` renormalizes by
  the weight that survived — so the survivors inherited 100% of the influence.
  Hockey printed **4577.46** off ONE fresh member of a 43-card basket.
- **Backfill** accumulated carry-forward across its walk (immune to the above)
  but selected its basket at the span's **end date**, valuing 116 of 181 points
  against a basket chosen with their own future (H-11).

Re-running `--backfill` under the old code would therefore silently rewrite
recent history to different values. Both paths now run one method, so a rebuild
reproduces the same numbers the nightly would.

## The three fixes this rebuild applies

1. **Persisted carry-forward** — each member's last known value and its `asOf`
   live in a `members::<sport>` doc, so the nightly seeds from the full history
   rather than 14 days. This is what keeps `usedWeight` near 1.0.
2. **usedWeight floor** — a point publishes only at `usedWeight >= 0.50`.
   Below it the point is **withheld**: the series carries the prior level
   flagged `stale` with a `withheldReason`, never a fabricated number.
3. **No lookahead** — the basket is re-resolved as each day's own quarterly
   epoch rolls, so a point dated D is valued on a basket selected from rows
   at or before D.
4. **Minimum basket size** — an epoch with fewer than `MIN_BASKET_SIZE` (25)
   eligible cards builds no basket at all, and its days are withheld. The
   `usedWeight` floor cannot cover this: a 4-card basket is fully valued by
   construction, so `usedWeight` is 1.00 and every one of its days clears the
   floor. This applies to **stored** baskets too, not just newly selected
   ones — see "the pokemon 2026-Q2 basket" below.

> **Both thresholds are ASSUMPTIONS, not Drew rulings.** 0.50
> (`MIN_USED_WEIGHT`) and 25 (`MIN_BASKET_SIZE`) are what this PR proposes.
> Each is one constant if Drew rules differently.

## Report first (read-only — this is the default)

```bash
COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv)" \
node backend/scripts/rebuild-market-indexes.cjs
```

Writes nothing, and this is enforced rather than asserted. The recompute runs
against a container facade (`readOnlyContainer`) whose every write method
throws and records the attempt; the run then checks the recorded count is zero
and exits 1 if it is not. One sport at a time (`--sports=hockey`) is much
faster than all five.

> **This lane was NOT write-free before 2026-09-03.** It handed the real
> series container to `ensureBasket`, which upserts a basket doc for any epoch
> that has none stored. A report over the 180-day span crosses quarters with
> no basket yet, so a run announcing "REPORT-ONLY (no writes)" minted them.
> Nine basket docs reached prod this way on 2026-09-03 — 2026-Q1 for all five
> sports and 2026-Q2 for four — including a **4-member pokemon 2026-Q2
> basket**. No point docs were written (points only land under `--apply`), so
> no history was rewritten, but the baskets are frozen quarterly fixtures that
> any later run reuses. That is what `MIN_BASKET_SIZE` now rejects on read.

### Measured 2026-09-03, read-only against live prod

| Sport | Before | Fresh/basket | After | usedWeight | Withheld (30d) |
|---|---|---|---|---|---|
| baseball | 109.59 | 94/100 | **113.83** | 1.00 | 0 |
| basketball | 90.20 | 82/100 | **94.18** | 1.00 | 0 |
| football | 102.64 | 67/100 | **98.36** | 0.84 | 0 |
| **hockey** | **4577.46** | **1/43** | **135.68** | 0.67 | 0 |
| **pokemon** | 73.01 | 10/100 | *withheld, carries 34.50* | 0.30 | **30** |

Hockey is the headline: persisted carry-forward brings `usedWeight` from
0.056% to 67%, and the 36x fabrication collapses to 135.68.

**Pokémon is the finding the audit did not name.** Even with the full history
carried, only 30% of its basket weight can be valued — so all 30 stored points
were as fabricated as hockey's, just less visibly. Under the floor pokemon
publishes nothing until its pool thickens or its basket is reselected.

The tile does **not** go blank: it shows **34.50, labelled carried**, with the
withheld reason. 34.50 is the last level pokemon actually published — the
2026-03-07 point, the newest stored point that was not itself withheld.

A withheld day always carries the last *published* level, never a level from a
different computation. Before this was pinned, the same run reported the carry
as **181.94**, which no run had ever published for a recent day: it was the
2026-06-30 level produced by the accidentally-minted 4-card 2026-Q2 basket.
Four cards are fully valued by construction, so `usedWeight` was 1.00, the
floor waved every Q2 day through, and that quarter published 328.69, 257.51
and finally 181.94 — which then carried forward across the whole Q3 withhold.
Rejecting the undersized stored basket is what retires that number, with no
data migration.

## Apply

```bash
COSMOS_CONNECTION_STRING="..." \
node backend/scripts/rebuild-market-indexes.cjs --apply
```

Points are upserted by `(sport, date)`, so a re-run overwrites a day rather
than appending a second point for it. Idempotent.

## Outstanding: the nine baskets minted on 2026-09-03

These are still in `daily_price_series` and are **not** cleaned up by this PR —
deleting prod docs is a HALT-for-Drew call, not a script side effect:

| Sport | Epoch | Members | Minted |
|---|---|---|---|
| baseball | 2026-Q1 | 100 | 14:12:56Z |
| hockey | 2026-Q1 | 21 | 14:22:37Z |
| basketball | 2026-Q1 | 100 | 14:22:45Z |
| football | 2026-Q1 | 100 | 14:22:46Z |
| pokemon | 2026-Q1 | 100 | 14:22:46Z |
| basketball | 2026-Q2 | 100 | 14:25:36Z |
| football | 2026-Q2 | 100 | 14:25:36Z |
| **pokemon** | **2026-Q2** | **4** | 14:26:07Z |
| baseball | 2026-Q2 | 100 | 14:35:59Z |

`MIN_BASKET_SIZE` makes the two undersized ones (pokemon Q2 at 4, hockey Q1 at
21) inert — they are rejected on read, so no day is valued against them. The
seven full-size ones are legitimate baskets for their epochs and selected with
no lookahead (eligibility ends at the epoch base date), so they are correct
even though the run that created them should not have written. Drew's call
whether to delete the two dead ones or leave them rejected.

## Flags

| Flag | Meaning |
|---|---|
| `--apply` | Persist. Without it the run is read-only, enforced by a write-refusing container facade. |
| `--as-of=DATE` | Target day, `YYYY-MM-DD` (default: today UTC). |
| `--sports=a,b` | Restrict to these sports (default: all five). |
| `--compare-days=N` | Days of before/after to print (default 30). |

No dispatch input changes: this is a hand-run script. The nightly workflow
(`market-indexes-compute.yml`) is untouched and now benefits from the same
fixes automatically.

## After a deploy

The index is **display-only** — no pricing path imports it, confirmed in the
audit — so a wrong level never reached a holding's value. The nightly job still
needs `backend/dist` rebuilt, and any `backend/src` merge needs the
**"Daily 5AM ET Refresh & Deploy"** dispatch to actually deploy.
