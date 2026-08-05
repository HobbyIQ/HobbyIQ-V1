# Card → Variant → Grade tree schema

## Container

Single container: `card_catalog`, partitioned by `/cardId`. Three
distinct document types distinguished by the `kind` field:

- `kind: "card"` — the card itself (parent)
- `kind: "variant"` — one variant per (parallel · isAuto · printRun)
- `kind: "grade"` — one grade leaf per observed (variant · gradeCompany · gradeValue)

Every doc in a tree shares the SAME `cardId` (the root card's canonical
id). Cosmos routes all descendants of one card to a single partition,
so a card-panel read touches one logical partition even though it
returns 25-40 documents.

## Legacy compatibility

Existing `card_catalog` rows (from `bulk-build-from-pool`,
`ingest-auto-seed`, `bccp-product-structure`, etc.) coexist. They have
`cardId = id` (the flat legacy slug) and land in their own partitions.
The tree docs live in NEW partitions keyed on the root card. No legacy
row gets rewritten by this migration — the tree is additive.

## Card node

```json
{
  "id": "card::hiq:baseball:2018:bowman-chrome:1",
  "cardId": "hiq:baseball:2018:bowman-chrome:1",
  "kind": "card",
  "parentId": null,
  "canonicalCardId": "hiq:baseball:2018:bowman-chrome:1",
  "sport": "baseball",
  "year": 2018,
  "setKey": "bowman-chrome",
  "cardNumber": "1",
  "playerName": "Shohei Ohtani",
  "brand": "bowman",
  "parentSetKey": "bowman",
  "rookie": true,
  "source": "tree-builder-v1",
  "builtAt": "2026-08-05T15:00:00.000Z"
}
```

`id` prefix `card::` is what disambiguates from legacy `card_catalog`
rows at the same slug. `canonicalCardId` is a convenience mirror of
`cardId` — makes SQL `WHERE canonicalCardId = @root` fast without
worrying about the `card::` prefix.

## Variant node

```json
{
  "id": "variant::hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "cardId": "hiq:baseball:2018:bowman-chrome:1",
  "kind": "variant",
  "parentId": "card::hiq:baseball:2018:bowman-chrome:1",
  "canonicalCardId": "hiq:baseball:2018:bowman-chrome:1",
  "variantSlug": "hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "parallel": "Base",
  "parallelSlug": "base",
  "isAuto": false,
  "printRun": null,
  "distribution": null,
  "source": "bccp",
  "builtAt": "2026-08-05T15:00:00.000Z"
}
```

`variantSlug` matches the LEGACY flat slug convention so old code paths
querying `hobbyiqCardId` on sold_comps still resolve. `source` records
which checklist the variant was cataloged from (`bccp`, `clc`,
`baseball-almanac`, `holding-only` when a user's holding is the sole
witness).

## Grade node

```json
{
  "id": "grade::hiq:baseball:2018:bowman-chrome:1:base:no-auto:psa9",
  "cardId": "hiq:baseball:2018:bowman-chrome:1",
  "kind": "grade",
  "parentId": "variant::hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "canonicalCardId": "hiq:baseball:2018:bowman-chrome:1",
  "variantSlug": "hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "gradeSlug": "hiq:baseball:2018:bowman-chrome:1:base:no-auto:psa9",
  "gradeCompany": "PSA",
  "gradeValue": 9,
  "gradeLabel": "PSA 9",
  "materializedAt": "2026-08-05T15:00:00.000Z",
  "observedSalesAtBuild": 93
}
```

Grade nodes are materialized LAZILY — only when a sold_comp is observed
at that (variant, grade) combination. This keeps the grade tree
proportional to real signal, not to the Cartesian product of every
possible grade tier.

`observedSalesAtBuild` is a snapshot at build time — not a live
counter. The live FMV pipeline still queries sold_comps directly.

## Traversal patterns

**Card-panel read** (render everything about this card):

```sql
SELECT * FROM c
WHERE c.cardId = "hiq:baseball:2018:bowman-chrome:1"
```

Returns Card + N Variants + M Grades. Single-partition, cheap.

**Variant picker** (list all parallels for a card):

```sql
SELECT * FROM c
WHERE c.cardId = @cardRoot AND c.kind = "variant"
```

**Grade curve** (list all observed grades for a variant):

```sql
SELECT * FROM c
WHERE c.parentId = @variantId AND c.kind = "grade"
```

## sold_comps re-link

Every sold_comp gets a new `gradeId` field pointing at its exact leaf:

```json
{
  "id": "cardhedge::...",
  "cardId": "hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "hobbyiqCardId": "hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  "gradeId": "grade::hiq:baseball:2018:bowman-chrome:1:base:no-auto:psa9"
}
```

`gradeId` is denormalized so downstream reads DON'T need to walk the
tree from cardId → variant → grade to filter. `hobbyiqCardId` stays
for legacy reads that haven't migrated yet.
