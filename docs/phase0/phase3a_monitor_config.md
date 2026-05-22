# Phase 3a — CH Access Tripwire Monitor: Deployed Configuration

**Shipped:** 2026-05-22 (UTC; 2026-05-21 PM Eastern)
**Scope doc:** [docs/phase0/phase3a_ch_monitor_scope.md](phase3a_ch_monitor_scope.md) (commit `8e63679`)
**Implementation option:** D — GitHub Action with federated managed identity

## Deployment record

| Item | Value |
|---|---|
| Initial workflow PR | [#108](https://github.com/HobbyIQ/HobbyIQ-V1/pull/108) — squash-merged at `dbe55368` (`2026-05-22T01:17:04Z`) |
| Blob-read fix PR | [#109](https://github.com/HobbyIQ/HobbyIQ-V1/pull/109) — squash-merged at `b1b773c8` (`2026-05-22T01:23:06Z`) |
| Workflow file | [`.github/workflows/ch-monitor.yml`](../../.github/workflows/ch-monitor.yml) |
| Schedule | `cron: '30 2 * * *'` UTC (02:30 UTC daily) |
| First production fire | `2026-05-22T02:30Z` (scheduled) |
| Manual trigger | `gh workflow run ch-monitor.yml --ref main --field dry_run={true,false}` |
| Test runs verifying ship | [#26262741066](https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/26262741066) (exposed bug), [#26262908027](https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/26262908027) (post-fix, SUCCESS) |

## Azure-side resources

### User-assigned managed identity

| Property | Value |
|---|---|
| Name | `ch-monitor-oidc` |
| Resource group | `rg-hobbyiq-dev` |
| Location | `eastus` |
| Subscription | `ce160cf3-ee69-4832-ade2-f0cf57ba2f57` |
| clientId | `e6815ab7-f657-4ea1-97de-d0ce6ea0e95b` |
| principalId | `d7ade861-67be-4385-8660-ba896ec87c1b` |

### Federated credential (production)

| Property | Value |
|---|---|
| Name | `github-main-ch-monitor` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:HobbyIQ/HobbyIQ-V1:ref:refs/heads/main` |
| Audience | `api://AzureADTokenExchange` |

The temporary `github-branch-test` federated credential was created during ship-test (for PR-branch testing) and is documented as deleted in the same commit that lands this doc.

### Role assignment

| Property | Value |
|---|---|
| Role | `Storage Blob Data Reader` |
| Scope | `stcompiqfnotgm2` storage account (`/subscriptions/{sub}/resourceGroups/rg-hobbyiq-dev/providers/Microsoft.Storage/storageAccounts/stcompiqfnotgm2`) |
| Principal | `ch-monitor-oidc` (objectId `d7ade861-...`) |

No other role assignments on this MI. Minimal least-privilege.

## GitHub-side resources

### Repository secrets

| Secret name | Purpose |
|---|---|
| `CH_MONITOR_CLIENT_ID` | clientId of `ch-monitor-oidc` |
| `CH_MONITOR_TENANT_ID` | Azure tenant (`7cac07a9-554a-4123-b13b-10788fdeb008`) |
| `CH_MONITOR_SUBSCRIPTION_ID` | Azure subscription (`ce160cf3-ee69-4832-ade2-f0cf57ba2f57`) |

Distinct namespace from existing `AZUREAPPSERVICE_*` secrets (used by `main_hobbyiq3.yml`).

## Monitor behavior

### Monitored players (5)

`aaron-judge`, `mike-trout`, `shohei-ohtani`, `juan-soto`, `ronald-acuna-jr` — matches W6.3 blob inventory.

### Per-player threshold

A breach fires for any active player when **either**:

- `comp_count < 10` — catches CH-access-revoked. Per Workstream A finding: when CH 401s, `fn-cardhedge-comps` still writes blobs with `no_match`/`no_data` payloads (`comp_count: 0`), so storage-metric-level alerts can't see this; content inspection is required.
- Blob `lastModified` older than `25 h` — catches function-not-running.

### Tolerance

- Missing `comp_count` field → `WARN_MISSING_FIELD`, NOT breach (per W6.3 caleb-bonemer schema-gap note; the active 5 players all carry the field, but tolerance is in place for future schema evolution).
- Unreadable blob (auth error OR 404) → breach with verdict `UNREADABLE`.

### Notification

GitHub Issue with title `[CH-MONITOR] CH access degraded — ongoing` (stable across days). Dedup logic: workflow searches for an existing open `[CH-MONITOR]` issue; if found, appends a comment with the day's evaluation. Multi-day outage produces ONE issue with N daily comments.

Issue body includes:
- Per-player evaluation table (comp_count, last_modified, age, verdict)
- Specific breach list
- Context (threshold values, source function, source blob path, Phase 3 cleanup pointer)
- Workflow run URL

No labels applied (would require labels to pre-exist; lazy provisioning).

## Reproducibility — exact commands used

### Azure-side setup

```bash
# Managed identity
az identity create \
  --resource-group rg-hobbyiq-dev \
  --name ch-monitor-oidc \
  --location eastus

# Production federated credential
az identity federated-credential create \
  --resource-group rg-hobbyiq-dev \
  --identity-name ch-monitor-oidc \
  --name github-main-ch-monitor \
  --issuer https://token.actions.githubusercontent.com \
  --subject 'repo:HobbyIQ/HobbyIQ-V1:ref:refs/heads/main' \
  --audiences api://AzureADTokenExchange

# Role assignment
az role assignment create \
  --assignee-object-id d7ade861-67be-4385-8660-ba896ec87c1b \
  --assignee-principal-type ServicePrincipal \
  --role 'Storage Blob Data Reader' \
  --scope '/subscriptions/ce160cf3-ee69-4832-ade2-f0cf57ba2f57/resourceGroups/rg-hobbyiq-dev/providers/Microsoft.Storage/storageAccounts/stcompiqfnotgm2'
```

> **Note:** the role-assignment command requires `MSYS_NO_PATHCONV=1` on Windows MSYS2/Git-Bash to prevent the leading slash from being mangled into a Windows path.

### GitHub secrets

```bash
gh secret set CH_MONITOR_CLIENT_ID --repo HobbyIQ/HobbyIQ-V1 --body '<clientId>'
gh secret set CH_MONITOR_TENANT_ID --repo HobbyIQ/HobbyIQ-V1 --body '<tenantId>'
gh secret set CH_MONITOR_SUBSCRIPTION_ID --repo HobbyIQ/HobbyIQ-V1 --body '<subscriptionId>'
```

### Manual dispatch (verification / dry-run)

```bash
gh workflow run ch-monitor.yml --ref main --field dry_run=true
# Then locate the run:
gh run list --workflow ch-monitor.yml --limit 1
gh run view <run-id> --log
```

## Operational gotchas (worth knowing for any future ch-monitor work)

1. **`workflow_dispatch` only fires from the default branch.** GitHub Actions intentionally rejects dispatching workflow files that don't exist on `main`. Pre-merge testing on a feature branch via `workflow_dispatch` is NOT possible. PR #108 documents the discovery of this constraint. Workaround: merge first, then dispatch on main; OR add `on: push:` trigger temporarily; OR observe first scheduled fire.
2. **`az storage blob download --file -` does NOT stream content to stdout.** It dumps blob metadata JSON to stdout while the actual content goes to the "-" destination silently. Use `--file <tempfile>` then `cat`. PR #109 captures the fix for this. The same defect was hit in Workstream A's initial debug pass and should have been the YAML's pattern from day one.
3. **MSYS path-conversion mangles ARM scopes on Windows Git-Bash.** Set `MSYS_NO_PATHCONV=1` before any `az` command that includes a leading-slash ARM scope. Otherwise `MissingSubscription` error.
4. **federated identity for App Service deploys is via user-assigned MI**, not via App Registration in this tenant. Two existing MIs (`oidc-msi-9e0e` orphaned, `oidc-msi-8761` active for `main_hobbyiq3.yml`) live in `rg-hobbyiq-dev`. New MI for ch-monitor follows the same pattern.

## v2 enhancement candidates (out of scope for ship)

- Distinguish auth-error vs blob-404 in the "UNREADABLE" branch (both currently surface the same breach message).
- Slack/webhook notification step (currently GitHub Issue is the only notification surface).
- Auto-label `incident,ch-monitor` on created issues (requires pre-creating the labels in repo settings).
- Node.js 24 upgrade for `azure/login@v2` (`@v2` runs on Node.js 20 which is deprecated June 2026; this is a separate broader Actions upgrade workstream, not ch-monitor-specific).
