# Parallels Reference Catalog — Cosmos Container Setup (Issue #33, Phase 2a)

Operational record of the empty container provisioning for the parallels
reference catalog. No data was ingested in this phase. See the authoritative
schema design in [parallels-reference-schema.md](parallels-reference-schema.md).

## Cosmos Account & Database

| Item            | Value                                              |
|-----------------|----------------------------------------------------|
| Account name    | `hobbyiq-comps`                                    |
| Resource group  | `rg-hobbyiq-dev`                                   |
| Location        | Central US                                         |
| Account kind    | `GlobalDocumentDB` (SQL API)                       |
| Capacity mode   | Provisioned (free tier enabled)                    |
| Database name   | `hobbyiq`                                          |
| Endpoint        | `https://hobbyiq-comps.documents.azure.com:443/`   |

Note: this account also backs the production HobbyIQ workload (`comp_logs`,
`dailyiq_*`, etc.) — adding new empty containers is non-destructive to those
collections.

## Containers Created

Both containers were created empty with the configuration below. Indexing
policy is the Cosmos default (all paths indexed). No TTL. No unique-key
policy. No composite indexes were added in this phase — composites listed in
the schema doc §3.2 / §3.3 will be added in Phase 2b after benchmarking.

| Container             | Partition key | Throughput model            |
|-----------------------|---------------|-----------------------------|
| `parallel_attributes` | `/set`        | Manual provisioned 400 RU/s |
| `ch_card_index`       | `/set`        | Manual provisioned 400 RU/s |

### Exact `az` commands used

```bash
az cosmosdb sql container create \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name parallel_attributes \
  --partition-key-path "/set" \
  --throughput 400

az cosmosdb sql container create \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name ch_card_index \
  --partition-key-path "/set" \
  --throughput 400
```

## Deviation from the Phase 2a Prompt: Throughput Model

The prompt and the schema doc both *suggested* serverless throughput as the
lowest-commitment option. We deviated to **manual provisioned 400 RU/s per
container** because:

1. **Serverless is account-scoped, not container-scoped.** The existing
   `hobbyiq-comps` account was provisioned at creation with
   `capacityMode: null` (i.e. provisioned-throughput) and `enableFreeTier:
   true`. Cosmos does not support mixing serverless containers inside a
   provisioned account, so serverless was not available without standing up
   a new account.
2. **Matches the established codebase pattern.** Every existing container in
   this account (`comp_logs`, `dailyiq_briefs`, etc.) runs manual 400 RU/s
   with no autoscale. The Phase 2a prompt explicitly allowed deviating from
   serverless "if there's a specific reason in the codebase patterns to use
   provisioned" — there is.
3. **Free tier absorbs the cost.** The free-tier discount on this account
   covers the first 1,000 RU/s of provisioned throughput at no charge.
   Adding 800 RU/s of new capacity (400 × 2) keeps the account within the
   discounted band.
4. **Schema doc invited Phase 2 to revisit.** §3.3 of the schema doc says
   the throughput recommendation must be benchmarked; this deviation is
   consistent with that note.

If real workload pressure later shows hot partitions or RU spikes, switching
either container to autoscale is a non-destructive throughput update and can
be done in Phase 2b.

## Smoke Test (write / read / delete, both containers)

Executed against the dev endpoint using `@azure/cosmos` with a single
disposable test document per container, then immediately deleted. Test data
did not persist past this step.

Test documents:

```json
// parallel_attributes
{ "id": "test|test|test", "set": "test", "parallelName": "test", "isAutograph": false, "_smoke": true }
// ch_card_index
{ "id": "test|test|test", "set": "test", "_smoke": true }
```

Results (HTTP status):

| Container             | Create | Read | Delete |
|-----------------------|--------|------|--------|
| `parallel_attributes` | 201    | 200  | 204    |
| `ch_card_index`       | 201    | 200  | 204    |

Both containers accept writes against partition key `/set`, return the
written document by `(id, /set)` lookup, and delete cleanly. Containers are
empty after the smoke test.

## What Was NOT Done in Phase 2a

- No production data migrated, mirrored, or copied.
- No real parallel/card data ingested — Phase 2b will load this.
- No composite indexes, TTL, unique-key policies, or stored procedures
  added beyond Cosmos defaults.
- No infra-as-code (Bicep/Terraform) committed — the existing pattern in
  this account is ad-hoc `az` provisioning; matching that here.
- Schema doc was not modified.

## Verdict

Ready to proceed with Phase 2b (data ingestion). Both containers exist with
the schema-mandated partition key, accept writes, and round-trip data
correctly under the production-equivalent SDK.
