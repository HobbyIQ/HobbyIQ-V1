# HobbyIQ

Sports card portfolio + pricing platform. iOS app (SwiftUI) + Node backend (TypeScript, Azure App Service) + Cosmos DB. Owned by Drew (Just The Boys and Cards LLC).

## Working here

You have full read/write in this repo. Users read every diff — bias to **small, coherent PRs** over sweeping changes. The user's memory is authoritative on style preferences; check `~/.claude/projects/.../memory/MEMORY.md` before making judgment calls that echo prior corrections.

**Golden rules loaded in from memory:**
- FMV is the **projected next sale** from a comp pool's trend — NEVER a median or mean.
- Every PR that touches `backend/src` needs a manual **"Daily 5AM ET Refresh & Deploy"** workflow dispatch after merge (merging alone does NOT deploy).
- Live prod config changes (Cosmos indexing policy, Azure App Service settings, KeyVault) HALT for user confirm even when provably safe.
- Never echo secrets to stdout/chat. Pipe env vars directly, never materialize to disk.
- `resolvedMarketValue` on iOS holdings is deprecated — canonical FMV is the truth.
- M365 / Outlook / SharePoint tools are off-limits for HobbyIQ work.

## Repo shape

```
backend/               Node + TypeScript API (Azure App Service HobbyIQ3)
  src/routes/          Express routes
  src/services/        Business logic (compiq/, portfolioiq/, signals/, ebay/, ...)
  scripts/             One-off + scheduled ops scripts
  tests/               vitest
  docs/runbooks/       Playbooks for prod ops (deploy, backfill, indexes)
HobbyIQ/               Swift iOS app (Xcode project)
mcp-server/            MCP server (compiq-mcp Azure Function)
.github/workflows/     GH Actions (deploy, harnesses, nightly signal jobs)
```

## Prod surface

- **Backend**: `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net`
  - Health: `GET /api/health` returns `{ build: { shaShort } }` — verify deploys landed
  - Canonical FMV: `POST /api/compiq/canonical-fmv`
  - Cert lookup: `POST /api/compiq/lookup-by-cert`
  - Market movers: `GET /api/compiq/market-movers`
  - Recent sales: `GET /api/compiq/cards/:cardId/recent-sales`
  - Listing range: `GET /api/compiq/cards/:cardId/listing-range`
- **Cosmos DB**: `hobbyiq-comps` account, `hobbyiq` database, rg `rg-hobbyiq-dev`
  - `sold_comps` — unified comp pool (partition /cardId, sport-tagged since 2026-07-19)
  - `ch_daily_sales` — CardHedge nightly ingest (partition /card_id, 2M+ rows, 8yr)
  - `portfolio` — user docs (partition /userId)
- **Telemetry**: App Insights `hobbyiq-insights` (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`)

## When Claude runs in this repo

- `npm test` — vitest
- `npx tsc --noEmit` before pushing TS changes; tsx + vitest is more permissive than tsc strict
- `gh pr create` for PRs; commits use HEREDOC-style multi-line messages
- Cosmos read scripts under `backend/scripts/` — always source `COSMOS_CONNECTION_STRING` via `az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev` and pipe direct into env, never to disk
- Deploy: `gh workflow run "Daily 5AM ET Refresh & Deploy"` after every `backend/src` merge; verify with `curl /api/health` sha

## For mobile / phone Claude sessions

See `.claude/QUICK-COMMANDS.md` for the 10 things Drew runs most often (health check, dry-run notify jobs, current backfill status, look up a cardId, etc.).
