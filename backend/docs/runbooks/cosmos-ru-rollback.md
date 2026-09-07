# Cosmos RU rollback — runbook

**Measured 2026-09-07.** Companion to `docs/GO-LIVE-CHECKLIST.md` →
"Cosmos throughput". Live Cosmos config changes are a **HALT** item: they need
Drew's explicit go even when provably safe. Everything in step 1 is read-only.

---

## 1. Read the live state (read-only, always do this first)

```bash
cd backend && node scripts/cosmos-throughput.cjs --report
```

```
container       mode       max RU/s  floor / note
--------------  ---------  --------  -----------------------
sold_comps      autoscale  40000     ~4000 RU/s billed idle
card_catalog    autoscale  400000    ~40000 RU/s billed idle
ch_daily_sales  manual     400       400 RU/s billed flat
portfolio       autoscale  1000      ~100 RU/s billed idle
```

The "billed idle" column is `max / 10` — what you *pay* at rest. That is **not**
the same as the **scaling floor**, the lowest max Azure will accept:

```bash
az cosmosdb sql container throughput show \
  --account-name hobbyiq-comps --database-name hobbyiq \
  --resource-group rg-hobbyiq-dev --name sold_comps \
  --query resource.minimumThroughput -o tsv     # -> 10000
```

## 2. The floor only ever rises

Azure sets the autoscale minimum to `max(1000, storage floor,
highest-ever-provisioned / 10)`. **It never falls.** `sold_comps` touched
100,000 at some point, so its floor is pinned at 10,000 permanently — and every
hardcoded `--max=8000` teardown is unreachable by construction.

Azure says so verbatim in the rejection:

```
The offer should have valid throughput values between 10000 and 1000000
inclusive ... Requested throughput 8000 is less than required minimum
throughput 10000. Minimum limit 10000 is because of Highest RUs provisioned
100000.
```

Since **#1954** `cosmos-throughput.cjs` parses that number and lands on the
floor rather than failing the step. Before #1954 the teardown failed on every
run and left `sold_comps` parked at the 40,000 working ceiling — the exact bill
the scale-down exists to avoid. `nightly-slug-backfill` failed that way on
09-04, 09-05, 09-06 and 09-07 (run `34107636603`, step "Lower sold_comps
throughput back to idle": **failure**). #1954 merged 2026-09-07 15:43Z, *after*
that 09:44Z run — **the 09-08 run is the first one that exercises the fix.
Check it.**

## 3. Every raise must have a teardown that lands on the floor

Four workflows raise `sold_comps` to 40,000. All four already lower it in an
`if: always()` step, so **no raise is missing a teardown** — but three name an
unreachable idle target:

| workflow | `SOLD_IDLE_MAX` | reachable? |
| --- | --- | --- |
| `.github/workflows/nightly-slug-backfill.yml` | `10000` | yes |
| `.github/workflows/printrun-merge.yml` | `8000` | **no** |
| `.github/workflows/reslug-setkey.yml` | `8000` | **no** |
| `.github/workflows/slug-drift-audit.yml` | `8000` | **no** |

Post-#1954 those three still succeed (the script corrects them to 10,000), but
the values lie. Correct each to `10000` when the workflow is next touched.

**Auditing for a new one:** every `--max=$..._WORK_MAX` needs a matching
`--max=$..._IDLE_MAX` under `if: always()` in the same job.

```bash
grep -rn "cosmos-throughput" .github/workflows/
```

## 4. sold_comps 40K → floor: NOT YET

The checklist's original trigger is dead (it named August runs). The live
trigger:

> **The GREAT REMATCH program quiesces** — `gh run list
> --workflow=backfill-runner.yml` under ~10 runs/day for 3 straight days.

On 2026-09-07 it was **200+ runs/day**. Observed 5-minute peak on `sold_comps`
is **17,900 RU/s**, so a 10,000 ceiling *would* throttle the fleets during
launch week. Steady-state average is only ~1,460 RU/s, so once the program
quiesces the floor covers it comfortably.

When it fires, the target is the **floor (10,000)**, not the historical 8,000:

```bash
cd backend && node scripts/cosmos-throughput.cjs --container=sold_comps --max=10000
```

## 5. card_catalog 400K → 40K: ready, awaiting Drew's go (P1-6)

The spine passes are **done**, so the "400k until spine passes finish, then 40k"
precondition is already satisfied.

Evidence it is safe:

- 7-day average consumption: **~1,530 RU/s**
- biggest 5-minute burst: **~12,000 RU/s** (the `catalog-cardYear-backfill`
  `CONCURRENCY: 128` window on 09-04 22:20Z)
- 12,000 << the 40,000 floor → **nothing breaks at 40K**; 3.3x headroom remains
  over the worst burst actually observed. No catalog fleet has ever needed the
  400,000 ceiling.

Cost: billed idle drops 40,000 → 4,000 RU/s, i.e. **~$76.80/day → ~$7.68/day,
saving ~$69/day (~$2,074/month)** — the largest silent cost line at launch.

**Command — DO NOT RUN without Drew's explicit go (HALT):**

```bash
cd backend && node scripts/cosmos-throughput.cjs --container=card_catalog --max=40000
```

40,000 *is* card_catalog's floor, so this is the lowest reachable setting.

## 6. After any scale change

1. Re-run `--report` and confirm the new max (the script also read-back-asserts
   and throws on mismatch).
2. Watch `cosmos-throttle-429` for 24h. A 429 burst means the ceiling was real
   work, not slack — raise it back and re-measure before retrying.
3. Confirm the next `nightly-slug-backfill` teardown step is green.

## Appendix — measuring consumption

```bash
az monitor metrics list --resource hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --resource-type Microsoft.DocumentDB/databaseAccounts \
  --metric TotalRequestUnits \
  --filter "CollectionName eq 'card_catalog' or CollectionName eq 'sold_comps'" \
  --start-time "$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --interval PT5M --aggregation Total -o json
```

`Total` over a `PT5M` bucket ÷ 300 = average RU/s in that window. Use `PT5M`,
not `P1D`: a daily average hides the bursts that decide whether a ceiling is
load-bearing (card_catalog's daily average is 1,530 RU/s but it peaks at
12,000).
