# CH Black Label Title Preservation Probe — Runbook

**Status:** Script authored 2026-07-15 (PR #496). Awaiting first run.
**Script:** `backend/scripts/ch-probe-bgs-black-label-titles.cjs`
**Runtime:** ~1-2 minutes for the default query set (5 well-covered players × up to 3 cards each × 60 comps).

## What it answers

Does CardHedge's `/v1/cards/comps` endpoint preserve `Black Label` / `Pristine` / `BL` text in the returned sale titles when the card actually has Black Label sales? If yes, our `detectGradeFromTitle` regex correctly routes those comps to the BGS `"10 Black Label"` multiplier tier at ingest. If no, CH strips the sub-tier server-side and the fix has to happen at their taxonomy layer.

## Run it (Windows / PowerShell)

The script reads `CARD_HEDGE_API_KEY` from an env var — never echoes. Pull the key from HobbyIQ3 App Service settings into the process env, run, then clear:

```powershell
$env:CARD_HEDGE_API_KEY = (az webapp config appsettings list `
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev `
  --query "[?name=='CARD_HEDGE_API_KEY'].value" -o tsv).Trim()

node backend/scripts/ch-probe-bgs-black-label-titles.cjs > backend/docs/investigations/ch-black-label-title-probe-$(Get-Date -Format 'yyyy-MM-dd').txt

Remove-Item Env:CARD_HEDGE_API_KEY
```

Do NOT paste the key value into chat, into a commit, or into any file. The `Remove-Item` on the last line is load-bearing — it drops the key from the current shell session so subsequent commands can't leak it.

## Run it (macOS / Linux)

```bash
export CARD_HEDGE_API_KEY=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='CARD_HEDGE_API_KEY'].value" -o tsv | tr -d '\r\n')

node backend/scripts/ch-probe-bgs-black-label-titles.cjs \
  > backend/docs/investigations/ch-black-label-title-probe-$(date +%Y-%m-%d).txt

unset CARD_HEDGE_API_KEY
```

## Interpretation

The script prints (at the end):

```
Cards probed:            N
BGS 10 comps returned:   M
Black Label / Pristine:  K
Preservation rate:       K/M %
```

- **K/M ≥ 20%:** CH preserves the tier in titles frequently enough that `detectGradeFromTitle` catches it in the wild. Ingest path is safe. Log the number and move on.
- **K/M < 5%:** CH is stripping the sub-tier server-side (or the queried cards genuinely have almost no Black Label sales — check the sample titles under "WITH BL/Pristine text" to disambiguate). Escalate to CH's taxonomy team; document the gap.
- **K/M in-between:** ambiguous. Look at the WITH/WITHOUT samples — do the Black Label titles cluster around obvious high-premium cards? Are the WITHOUT titles clearly non-Black-Label BGS 10s? Adjust the query set and re-run against known-BL cards.

## Follow-up if K/M is low

- Capture 3-5 sample titles from Drew's own Black Label holdings (if any) with the exact wording CH sent us.
- Open a CH support ticket referencing the sample titles and the taxonomy note in `backend/src/services/cardsight/cardsightGradesTaxonomy.ts`.
- Until CH fixes it upstream, the `PortfolioHolding.isBlackLabel` bit remains the sole path preserving the tier for user holdings. Comp-side we'd be forced to accept the 3.5× tier misclassification for CH-sourced BL sales.

## Follow-up if K/M is high

- Note the preservation rate in the CH investigation index for future reference.
- No further action needed; ingest path was already safe.
