# Drew's quick-run cheat sheet

Point mobile / web Claude at these when you need something fast, away from your desk.

## Health + sanity

**Is prod healthy?**
```
curl -s https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health
```
Look at `build.shaShort` — should match latest merge on `main`.

**What's the latest deploy?**
```
gh run list --workflow "Daily 5AM ET Refresh & Deploy" --limit 3
```

**Any red workflows in the last 24h?**
```
gh run list --limit 20 --json name,status,conclusion,createdAt --jq '.[] | select(.conclusion != "success" and .conclusion != null) | "\(.createdAt) \(.name) → \(.conclusion)"'
```

## Signal / notify jobs (dry-run first, always)

**Preview tomorrow's grade-arbitrage pushes:**
```
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun":true,"minUpliftX":3,"sport":"baseball"}' \
  https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolio/admin/grade-arbitrage-notify/run
```

**Preview sub-raw inversions:**
```
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"sport":"baseball","dryRun":true,"windowDays":30}' \
  https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolio/admin/sub-raw-inversion/scan
```

**Preview sell-side notify:**
```
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun":true}' \
  https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolio/admin/sell-side-notify/run
```

## Look up a card at a show

Ask Claude directly: **"look up Bobby Witt Jr 2020 Bowman Chrome CPA-BWJ BGS 9 comps"** — it'll run a targeted Cosmos query on `ch_daily_sales` and summarize. Or hit the endpoint:

```
POST /api/compiq/canonical-fmv
{ "cardId": "1606922959335x293409091214639100", "gradeCompany": "BGS", "gradeValue": 9 }
```

## Deploy after merging a backend PR

```
gh workflow run "Daily 5AM ET Refresh & Deploy"
# Wait ~4 min
curl -s https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health | jq .build.shaShort
```

## Backfill status

```
tail -3 /tmp/backfill-out.log   # if running locally
# OR check the last written row in sold_comps for a specific cardId
```

## Data-org state

- **sold_comps**: sport-tagged since 2026-07-19. Composite indexes on `(playerName, soldAt)`, `(product, soldAt)`, `(sport, soldAt)`, `(sport, playerName)`, `(cardYear, playerName)`.
- **sold_comps_daily**: nightly rollups — empty container, populate via `scripts/rollup-sold-comps-daily.cjs`.
- **ch_daily_sales**: 2M+ rows, 2018-present. Read-only source.

## When something looks wrong

Trust the code, not your memory. Grep before assuming. `gh pr list` and `git log --oneline -20` before drawing conclusions about "we shipped X yesterday."
