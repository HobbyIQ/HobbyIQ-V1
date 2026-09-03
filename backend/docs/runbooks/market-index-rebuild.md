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

> **The floor is an ASSUMPTION, not a Drew ruling.** 0.50 is what this PR
> proposes. It is one constant (`MIN_USED_WEIGHT`) if Drew rules differently.

## Report first (read-only — this is the default)

```bash
COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv)" \
node backend/scripts/rebuild-market-indexes.cjs
```

Writes nothing. Prints a per-sport before/after for the last 30 days. The
banner states the mode before anything runs. One sport at a time
(`--sports=hockey`) is much faster than all five.

### Measured 2026-09-03, read-only against live prod

| Sport | Before | Fresh/basket | After | usedWeight | Withheld (30d) |
|---|---|---|---|---|---|
| baseball | 109.59 | 94/100 | **113.83** | 1.00 | 0 |
| basketball | 90.20 | 82/100 | **94.18** | 1.00 | 0 |
| football | 102.64 | 67/100 | **98.36** | 0.84 | 0 |
| **hockey** | **4577.46** | **1/43** | **135.68** | 0.67 | 0 |
| **pokemon** | 73.01 | 10/100 | *withheld* | 0.30 | **30** |

Hockey is the headline: persisted carry-forward brings `usedWeight` from
0.056% to 67%, and the 36x fabrication collapses to 135.68.

**Pokémon is the finding the audit did not name.** Even with the full history
carried, only 30% of its basket weight can be valued — so all 30 stored points
were as fabricated as hockey's, just less visibly. Under the floor pokemon
publishes nothing until its pool thickens or its basket is reselected. That is
the correct outcome (no number beats a wrong number), but it means **the
pokemon tile goes empty**, which is a product-visible change worth a look
before `--apply`.

## Apply

```bash
COSMOS_CONNECTION_STRING="..." \
node backend/scripts/rebuild-market-indexes.cjs --apply
```

Points are upserted by `(sport, date)`, so a re-run overwrites a day rather
than appending a second point for it. Idempotent.

## Flags

| Flag | Meaning |
|---|---|
| `--apply` | Persist. Without it the run is read-only. |
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
