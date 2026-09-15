# Staging slot + swap deploy (R56)

**Status** code merged; the slot and its settings are created by Drew (live config).
**Why** no cold process should ever take user traffic. Before this, every deploy
restarted production and the first ~4.5 minutes of pricing requests took 14–22 s
while lazy singletons built inside real users' requests.

## What the deploy does now

```
build → deploy to STAGING SLOT → wait for /api/health
      → /api/health/warm (blocks until the singletons are built)
      → smoke the SLOT  ── fails? STOP. production keeps the old build.
      → az webapp deployment slot swap
      → verify production /api/health sha == the sha we built
      → smoke production once more
      → reprice-all (unchanged, still gated on the deploy job)
```

The gate is the slot smoke. **A build that cannot price is never swapped in**, so
a bad deploy costs a red run rather than an outage.

## The one setting that must be sticky

`HIQ_SLOT_ROLE=staging` **must be marked as a slot setting (sticky)** on the
staging slot.

Sticky means the value stays with the **slot**, not with the code, across a swap.
That is the property that makes this safe:

- **before the swap** — the slot reads `staging`, runs no in-process jobs, serves
  only `/api/health` and `/api/health/warm`;
- **after the swap** — the newly-promoted instance *is* production, reads no
  `HIQ_SLOT_ROLE`, and starts its jobs normally; the old production instance
  lands in the slot, picks up `HIQ_SLOT_ROLE=staging`, and goes quiet.

**If it is marked non-sticky it will swap along with the code and silence
production.** That is the single most damaging mistake available here.

## Settings table

| Setting | Sticky (slot setting) | Why |
|---|---|---|
| `HIQ_SLOT_ROLE` | **YES — sticky** | The whole gate. Must stay with the slot. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | shared | Same resource; slot telemetry is wanted, tagged by `server_role`. |
| `COSMOS_CONNECTION_STRING` | shared | The slot must read the real catalog to smoke truthfully. |
| `AUTH_SESSION_SECRET` | shared | The slot must accept the harness token to be smoked. |
| `TIER1_HARNESS_TOKEN` | shared | Same. |
| `CARDHEDGE_API_KEY` / `CH_*` | shared | Read-only vendor reads during smoke. |
| `APNS_KEY_P8`, `APNS_*` | shared | Inert on the slot — `HIQ_SLOT_ROLE` stops the senders. |
| `EBAY_*` | shared | Inert on the slot for the same reason. |
| `STAGING_DRAINER_ENABLED` | **sticky, set `false` on the slot** | Belt and braces: the role gate already stops it, but this job promotes rows and deserves two locks. |
| `WEBSITE_*` (platform) | platform-managed | Azure sets these; `WEBSITE_SITE_NAME` differs per slot by design. |

**Rule of thumb:** everything the slot needs in order to be smoked *truthfully*
is **shared**; only what decides **who acts** is sticky. A slot that read a
different database would not be testing the build you are about to ship.

## What `HIQ_SLOT_ROLE=staging` turns off

All twelve in-process schedulers (`services/ops/slotRole.ts` has the list and
the reasoning). The ones that would actually hurt:

| Job | If it double-ran |
|---|---|
| `priceAlertEvaluator`, `advancedAlertsEvaluator` | users get **every push notification twice** |
| `portfolioReprice` | two repricers **write** the same holdings |
| `ebayOrderPoll` | two pollers share **one cursor** — one advances past orders the other never processed, and those orders are never seen again |
| `stagingDrainer` | the same `comps_staging` row is promoted twice |

`/api/health` and `/api/health/warm` stay up, which is exactly what the deploy
needs to warm and smoke the slot.

## Creating the slot (Drew — live config)

```bash
az webapp deployment slot create \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev --slot staging

az webapp config appsettings set \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev --slot staging \
  --settings HIQ_SLOT_ROLE=staging STAGING_DRAINER_ENABLED=false

# The sticky marking. Without this the gate swaps into production.
az webapp config appsettings set \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev --slot staging \
  --slot-settings HIQ_SLOT_ROLE STAGING_DRAINER_ENABLED
```

Verify before the first swap:

```bash
# Expect role=staging, backgroundJobs=disabled in the slot's log stream
curl -s https://hobbyiq3-staging.azurewebsites.net/api/health | jq .build

# Expect slotSetting:true for HIQ_SLOT_ROLE
az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev --slot staging \
  --query "[?name=='HIQ_SLOT_ROLE']"
```

## Rolling back

`az webapp deployment slot swap` again with the same arguments: the previous
build is sitting in the staging slot and swaps straight back. This is faster and
safer than redeploying, and it is the main operational win of the slot beyond
cold starts.

## Cost

A slot on the same App Service Plan adds **no plan cost** — slots share the
plan's compute. It does consume plan memory/CPU while warming, so a plan already
near its ceiling should be checked before enabling. Tier/cost confirmation was
with the coordinator at time of writing.

## What this does not solve

The swap eliminates *user-visible* cold starts. A restart for any other reason
(platform recycle, crash, scale-out) still produces a cold process, and
`warmStart()` — which runs at boot regardless of role — is what bounds that
case.
