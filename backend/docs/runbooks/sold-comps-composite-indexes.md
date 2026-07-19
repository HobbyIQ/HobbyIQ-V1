# sold_comps composite indexes runbook

**Status**: proposed, NOT applied.
**Owner**: Drew.
**Reason**: cross-partition player + product queries currently take 5–10s
against 1M+ rows. Composite indexes cut these to sub-second at the cost
of higher write RUs.

## What the indexes buy

| Query | Before | After |
|---|---|---|
| readCompsByPlayer(name, since) | 5–10s cross-scan | 200ms |
| readCompsByProduct(product, since) | 6–12s | 300ms |
| Player trend by cardYear | 8s+ | 400ms |
| Sport-filtered rollups (matched-cohort) | 4–8s | 200ms |

## Cost impact

Each composite index adds ~15% to write RU per upsert. sold_comps
currently on autoscale-1000 RU/s. With 4 composite indexes and today's
write rate (~15K comps/day sustained), expect 60% higher RU consumption
during writes — still comfortably under the 1000 RU/s ceiling.

## Proposed indexing policy

```json
{
  "indexingMode": "consistent",
  "automatic": true,
  "includedPaths": [{ "path": "/*" }],
  "excludedPaths": [
    { "path": "/photos/*" },
    { "path": "/ebayItemAspects/*" },
    { "path": "/_etag/?" }
  ],
  "compositeIndexes": [
    [
      { "path": "/playerName", "order": "ascending" },
      { "path": "/soldAt", "order": "descending" }
    ],
    [
      { "path": "/product", "order": "ascending" },
      { "path": "/soldAt", "order": "descending" }
    ],
    [
      { "path": "/sport", "order": "ascending" },
      { "path": "/soldAt", "order": "descending" }
    ],
    [
      { "path": "/sport", "order": "ascending" },
      { "path": "/playerName", "order": "ascending" }
    ],
    [
      { "path": "/cardYear", "order": "ascending" },
      { "path": "/playerName", "order": "ascending" }
    ]
  ]
}
```

## Apply steps (HALT-for-confirm required)

```bash
# 1. Snapshot current policy to disk (rollback insurance)
az cosmosdb sql container show \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name sold_comps \
  --query "resource.indexingPolicy" \
  -o json > /tmp/sold_comps-idx-before-$(date +%F).json

# 2. Apply the new policy
az cosmosdb sql container update \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name sold_comps \
  --idx @scripts/sold-comps-indexing-policy.json

# 3. Watch the indexing transform (background rebuild happens live)
az cosmosdb sql container show \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name sold_comps \
  --query "resource.indexingPolicy.compositeIndexes" -o json
```

## Rollback

```bash
az cosmosdb sql container update \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name sold_comps \
  --idx @/tmp/sold_comps-idx-before-YYYY-MM-DD.json
```

## Verification queries (post-apply)

```javascript
// Should return in <300ms after index build completes:
SELECT TOP 20 * FROM c WHERE c.playerName = 'Bobby Witt Jr.' AND c.soldAt >= '2026-06-01' ORDER BY c.soldAt DESC
SELECT TOP 20 * FROM c WHERE c.sport = 'baseball' AND c.playerName = 'Jared Jones' ORDER BY c.soldAt DESC
```
