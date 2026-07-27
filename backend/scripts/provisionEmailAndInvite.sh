#!/usr/bin/env bash
# CF-EMAIL-VERIFICATION follow-on (Drew, 2026-07-27).
#
# One-shot provisioning + invite runner. Drew invokes this from the repo
# root and it walks the entire ACS-email-invite pipeline end-to-end:
#
#   1. Register Microsoft.Communication provider (idempotent).
#   2. Create Email Communication Services + Azure-managed subdomain
#      (idempotent — skips if the name already exists).
#   3. Create Communication Services + link the managed domain.
#   4. Grab the sender address + primary connection string, plumb both
#      onto HobbyIQ3 App Service settings via a single upsert. Also sets
#      WEB_ORIGIN so verification links resolve to the branded page.
#   5. Sources COSMOS_CONNECTION_STRING + AUTH_SESSION_SECRET from
#      HobbyIQ3 into local env (never written to disk, never printed).
#   6. Flips lsinnard1002@gmail.com → pro_seller entitlementOverride.
#   7. Runs sendUserInvite.ts on lsinnard1002@gmail.com.
#
# Guardrails:
#   - No secrets ever hit stdout. Connection strings pipe env→env; the
#     script only prints resource names, resource IDs, and the "sent"
#     verdict.
#   - Every az/cosmos step is idempotent — safe to re-run.
#   - Any step that fails aborts the script (set -euo pipefail).
#   - --dry-run flag prints the plan without touching anything.
#
# Usage:
#   bash backend/scripts/provisionEmailAndInvite.sh
#   bash backend/scripts/provisionEmailAndInvite.sh --dry-run
#   INVITE_EMAIL=someone@else.com bash backend/scripts/provisionEmailAndInvite.sh
#
# Prereqs:
#   - az CLI logged into the HobbyIQ sub
#   - Node 22+ (for --experimental-strip-types)
#   - Run from the repo root (script uses ./backend/... paths)

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
RG="rg-hobbyiq-dev"
EMAIL_SVC="hobbyiq-email-svc"
COMM_SVC="hobbyiq-comm-svc"
DOMAIN_RESOURCE="AzureManagedDomain"
APP_SERVICE="HobbyIQ3"
WEB_ORIGIN="https://hobby-iq.com"
INVITE_EMAIL="${INVITE_EMAIL:-lsinnard1002@gmail.com}"
ENTITLE_TIER="pro_seller"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

log() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn(){ printf "  \033[1;33m!\033[0m %s\n" "$*"; }
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf "  \033[2m[dry-run]\033[0m %s\n" "$*"
    return 0
  fi
  eval "$@"
}

# ─── 0. sanity ──────────────────────────────────────────────────────────
log "0/7 Preflight"
if ! command -v az >/dev/null 2>&1; then
  echo "az CLI not on PATH — install it or use Azure Cloud Shell" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH" >&2
  exit 1
fi
SUB_ID=$(az account show --query id -o tsv 2>/dev/null || true)
if [[ -z "$SUB_ID" ]]; then
  echo "Not logged into az — run 'az login' first" >&2
  exit 1
fi
ok "az sub $(az account show --query name -o tsv)"

if [[ ! -f "backend/scripts/sendUserInvite.ts" ]]; then
  echo "Run this from the repo root (backend/scripts/sendUserInvite.ts not found)" >&2
  exit 1
fi
ok "repo root check"

if ! az extension list --query "[?name=='communication']" -o tsv | grep -q communication; then
  log "0.5/7 Installing az communication extension"
  run "az extension add --name communication --yes"
fi
ok "communication extension installed"

# ─── 1. Register Microsoft.Communication ────────────────────────────────
log "1/7 Microsoft.Communication provider"
STATE=$(az provider show --namespace Microsoft.Communication --query registrationState -o tsv)
if [[ "$STATE" != "Registered" ]]; then
  run "az provider register --namespace Microsoft.Communication --wait"
fi
ok "provider registered"

# ─── 2. Email Communication Services + managed domain ────────────────────
log "2/7 Email Communication Services"
if az communication email show -n "$EMAIL_SVC" -g "$RG" >/dev/null 2>&1; then
  ok "$EMAIL_SVC already exists"
else
  run "az communication email create -n $EMAIL_SVC -g $RG --location global --data-location UnitedStates"
  ok "created $EMAIL_SVC"
fi

if az communication email domain show -n "$DOMAIN_RESOURCE" \
      --email-service-name "$EMAIL_SVC" -g "$RG" >/dev/null 2>&1; then
  ok "$DOMAIN_RESOURCE already exists"
else
  run "az communication email domain create -n $DOMAIN_RESOURCE \
        --email-service-name $EMAIL_SVC -g $RG \
        --location global --domain-management AzureManaged"
  ok "created $DOMAIN_RESOURCE"
fi

# ─── 3. Communication Services + link domain ────────────────────────────
log "3/7 Communication Services + link domain"
if az communication show -n "$COMM_SVC" -g "$RG" >/dev/null 2>&1; then
  ok "$COMM_SVC already exists"
else
  run "az communication create -n $COMM_SVC -g $RG --location global --data-location UnitedStates"
  ok "created $COMM_SVC"
fi

DOMAIN_ID=$(az communication email domain show -n "$DOMAIN_RESOURCE" \
              --email-service-name "$EMAIL_SVC" -g "$RG" --query id -o tsv 2>/dev/null || echo "")
if [[ -z "$DOMAIN_ID" && "$DRY_RUN" == "0" ]]; then
  echo "Could not read domain id — aborting before we misconfigure" >&2
  exit 1
fi

CURRENT_LINKED=$(az communication show -n "$COMM_SVC" -g "$RG" \
                  --query "linkedDomains[0]" -o tsv 2>/dev/null || echo "")
if [[ "$CURRENT_LINKED" != "$DOMAIN_ID" ]]; then
  run "az communication update -n $COMM_SVC -g $RG --linked-domains \"$DOMAIN_ID\""
  ok "linked domain"
else
  ok "domain already linked"
fi

# ─── 4. Resolve sender + connection string, push to App Service ─────────
log "4/7 Push env to $APP_SERVICE"

# NEVER echo either of these. Everything below pipes to az settings via
# quoted env var and is redacted before any print.
FROM_ADDR=""
CONN=""
if [[ "$DRY_RUN" == "0" ]]; then
  FROM_ADDR=$(az communication email domain show -n "$DOMAIN_RESOURCE" \
                --email-service-name "$EMAIL_SVC" -g "$RG" \
                --query "mailFromSenderDomain" -o tsv 2>/dev/null || echo "")
  if [[ -z "$FROM_ADDR" ]]; then
    # Fallback field name for older API versions.
    FROM_ADDR=$(az communication email domain show -n "$DOMAIN_RESOURCE" \
                  --email-service-name "$EMAIL_SVC" -g "$RG" \
                  --query "fromSenderDomain" -o tsv 2>/dev/null || echo "")
  fi
  CONN=$(az communication list-key -n "$COMM_SVC" -g "$RG" \
           --query primaryConnectionString -o tsv)
  if [[ -z "$FROM_ADDR" || -z "$CONN" ]]; then
    echo "Could not resolve sender domain or connection string" >&2
    exit 1
  fi
fi

SENDER="DoNotReply@${FROM_ADDR}"
if [[ "$DRY_RUN" == "1" ]]; then
  SENDER="DoNotReply@<managed-domain>"
fi

# Push all three settings in one call so the App Service only restarts
# once. Setting-value contains an equals sign inside the connection
# string, so we use the array-style flag form.
if [[ "$DRY_RUN" == "1" ]]; then
  printf "  \033[2m[dry-run]\033[0m az webapp config appsettings set … (ACS_EMAIL_CONNECTION_STRING=***, EMAIL_FROM_ADDRESS=%s, WEB_ORIGIN=%s)\n" \
    "$SENDER" "$WEB_ORIGIN"
else
  az webapp config appsettings set --name "$APP_SERVICE" --resource-group "$RG" \
    --settings \
      "ACS_EMAIL_CONNECTION_STRING=$CONN" \
      "EMAIL_FROM_ADDRESS=$SENDER" \
      "WEB_ORIGIN=$WEB_ORIGIN" \
    >/dev/null
  ok "settings pushed to $APP_SERVICE"
fi

# App Service takes ~60s to pick up new env vars (per feedback memory).
# Not fatal if we skip the wait — the invite send below runs LOCALLY
# with env vars sourced fresh, so App Service's restart timing only
# matters for the /api/auth/send-verification web path.
ok "sender = $SENDER"

# ─── 5. Source Cosmos + session secret into local env ───────────────────
log "5/7 Source Cosmos + session secret"
if [[ "$DRY_RUN" == "0" ]]; then
  COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
    --name "$APP_SERVICE" --resource-group "$RG" \
    --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)
  AUTH_SESSION_SECRET=$(az webapp config appsettings list \
    --name "$APP_SERVICE" --resource-group "$RG" \
    --query "[?name=='AUTH_SESSION_SECRET'].value" -o tsv)
  export COSMOS_CONNECTION_STRING
  export AUTH_SESSION_SECRET
  export ACS_EMAIL_CONNECTION_STRING="$CONN"
  export EMAIL_FROM_ADDRESS="$SENDER"
  export WEB_ORIGIN="$WEB_ORIGIN"
  if [[ -z "${COSMOS_CONNECTION_STRING:-}" ]]; then
    echo "COSMOS_CONNECTION_STRING empty — cannot proceed" >&2
    exit 1
  fi
  ok "env populated (values not echoed)"
else
  printf "  \033[2m[dry-run]\033[0m would source COSMOS_CONNECTION_STRING + AUTH_SESSION_SECRET into env\n"
fi

# ─── 6. Flip lsinnard entitlement to pro_seller ─────────────────────────
log "6/7 Flip $INVITE_EMAIL → entitlementOverride=$ENTITLE_TIER"
if [[ "$DRY_RUN" == "1" ]]; then
  printf "  \033[2m[dry-run]\033[0m would upsert entitlementOverride on the user doc\n"
else
  node -e "
    const { CosmosClient } = require('./backend/node_modules/@azure/cosmos');
    (async () => {
      const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
        .database('hobbyiq').container('users');
      const email = process.argv[1];
      const tier  = process.argv[2];
      const { resources } = await c.items.query({
        query: 'SELECT * FROM c WHERE c.docType = \"user\" AND c.emailLower = @e',
        parameters: [{ name: '@e', value: email.toLowerCase() }]
      }).fetchAll();
      if (resources.length === 0) {
        console.error('user not found:', email);
        process.exit(1);
      }
      const u = resources[0];
      if (u.entitlementOverride === tier) {
        console.log('already', tier, '— userId:', u.userId);
        return;
      }
      u.entitlementOverride = tier;
      await c.item(u.id, u.userId).replace(u);
      console.log('flipped userId:', u.userId, '→', tier);
    })().catch(err => { console.error(err.message); process.exit(1); });
  " "$INVITE_EMAIL" "$ENTITLE_TIER"
  ok "entitlement flipped"
fi

# ─── 7. Send the invite ─────────────────────────────────────────────────
log "7/7 Send invite to $INVITE_EMAIL"
if [[ "$DRY_RUN" == "1" ]]; then
  printf "  \033[2m[dry-run]\033[0m would run: node --experimental-strip-types backend/scripts/sendUserInvite.ts %s\n" "$INVITE_EMAIL"
else
  node --experimental-strip-types backend/scripts/sendUserInvite.ts "$INVITE_EMAIL"
fi

log "DONE"
echo "  ACS provisioned, HobbyIQ3 configured, entitlement flipped, invite sent."
echo "  Next step for you: dispatch 'Daily 5AM ET Refresh & Deploy' so the"
echo "  backend picks up the new env vars (App Service already restarted"
echo "  from the settings-set above, but a deploy re-confirms shaShort)."
