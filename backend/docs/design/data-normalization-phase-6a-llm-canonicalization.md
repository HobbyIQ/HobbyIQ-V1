# Data Normalization — Phase 6A: LLM-Driven Canonicalization

**Status:** design draft (2026-07-17). Awaits Drew review before dispatch.
**Prereq:** 90-day backfill (workflow run 29548161686) populates `ch_daily_sales` so distinct-value enumeration returns real corpus data.
**Precedes:** future MCP-server-based iterative exploration + long-tail data-quality auditing.

## What Phase 6A ships

Turns the free-text `player`, `card_set`, and `variant` fields on `ch_daily_sales` into normalized entities backed by canonical lookup tables. Same person spelled 5 different ways collapses to one `player_id`. Same set with year/name variance collapses to one `set_id`. Same parallel with formatting variance collapses to one `variant_id`.

Cross-cutting analytics that were previously "expensive full-text scans" become "cheap partition-hit lookups."

## Why LLM is the right tool for this

Traditional approaches for entity resolution:
- **Deterministic normalization** (lowercase, remove punctuation, strip year) — catches ~30% of variants. Fails on "M. Trout" vs "Mike Trout" or "Bowman Chrome '11" vs "2011 Bowman Chrome".
- **Fuzzy matching** (Levenshtein, Jaro-Winkler) — catches ~50-60%. False-positives on similar-but-distinct names.
- **Embeddings + threshold clustering** — catches ~80%. False-positives on players with truly similar names in the same era.
- **LLM (with world knowledge)** — catches ~95%. Understands "Mike vs Michael," expands nicknames, disambiguates by set/year context. Cost: real but bounded.

The winning combination is **embeddings for cheap first-pass clustering + LLM for adjudication of ambiguous clusters.** Sequential, not parallel — embeddings cluster the easy 80%, LLM handles the top-1% edge cases where the vector distance is ambiguous.

## Data flow

```
ch_daily_sales
       │
       │ SELECT DISTINCT player, count(*)
       │ (partition-broadcast, one-time cost)
       ▼
distinct_players buffer (~50-100k unique strings expected)
       │
       ├── embeddings (OpenAI text-embedding-3-small)
       │        ↓
       ├── vector clustering (cosine similarity >= 0.85)
       │        ↓
       ├── ambiguous edge cases (0.75-0.85 range)
       │        ↓
       ├── LLM adjudication (Claude Haiku 4.5)
       │        ↓
       ▼
ch_players_canonical container (new)
       │
       │ { canonical_id, canonical_name, aliases[],
       │   sport, source, confidence }
       ▼
future ingest jobs join sale.player → canonical_player_id
```

Same shape for `card_set` and `variant`. Three separate pipelines, one architecture.

## Cost analysis

Assumptions (validate with the probe script before running):
- 50-100k unique player strings across 90 days
- Top 1000 players cover ~80% of sale volume
- Long tail is 90% duplicates of established players

### Embeddings pass
- OpenAI `text-embedding-3-small`: $0.02 per 1M tokens
- Avg 3 tokens per player name × 100k names = 300k tokens
- Cost: **~$0.006** (six-tenths of a cent)

### LLM adjudication pass (Claude Haiku 4.5)
- Only ~5% of vectors are ambiguous → ~5k edge-case pairs to adjudicate
- Batch 100 candidates per LLM call: 50 calls
- Each call: ~500 input tokens + ~800 output tokens
- Input cost: 50 × 500 / 1M × $1.00 = **$0.025**
- Output cost: 50 × 800 / 1M × $5.00 = **$0.20**
- Player total: **~$0.23**

### Full corpus (players + sets + variants)
- Players: ~$0.25
- Sets (est. 20-40k unique): ~$0.10
- Variants (est. 5-15k unique): ~$0.05
- **Grand total: <$0.50 for the entire one-time canonicalization pass**

Materially cheaper than the $250-500 I estimated in the initial discussion — embeddings do 95% of the work at nearly-zero cost, and LLM only fires on the hard cases.

## LLM prompt pattern

Batched adjudication. Send Claude a group of candidate clusters where the vector similarity is ambiguous, ask it to resolve.

```
Prompt template:
"You're normalizing player names from a sports card database.
For each candidate group below, decide whether all strings refer
to the SAME player. If yes, output the canonical form. If no,
split the group. Consider set/year context to disambiguate.

Groups:
Group 1: ['Mike Trout', 'M. Trout', 'Michael Trout', 'M Trout']
Group 2: ['Chris Sale', 'Christopher Sale', 'Chris Sale (WSox)']
Group 3: ['Anthony Rizzo', 'Tony Rizzo']

Output JSON:
[
  {group: 1, resolution: 'same', canonical: 'Mike Trout',
   aliases: ['M. Trout', 'Michael Trout', 'M Trout'],
   confidence: 0.98},
  ...
]"
```

Prompt engineering will iterate. Start simple, tune on Drew-labeled fixtures.

## Cosmos schema

### `ch_players_canonical`

- Partition: `/canonical_id` (small, high-cardinality)
- Doc id: `canonical_id`
- No TTL (canonical entities are permanent)

```typescript
interface CanonicalPlayerDoc {
  id: string;                    // = canonical_id (uuid v4)
  canonical_id: string;
  canonical_name: string;        // "Mike Trout"
  aliases: string[];             // ["mike trout", "M. Trout", "Michael Trout", ...]
  sport: string | null;          // "Baseball" (inferred from majority sport of aliased sales)
  source:                        // How this canonical was resolved
    | "llm-adjudication"
    | "embedding-cluster"
    | "user-attested";
  confidence: number;            // 0..1
  llm_cost_usd?: number;         // Track spend per entity
  first_seen: string;            // ISO
  last_seen: string;             // ISO
  sale_count: number;            // total sales matched to this player
}
```

Same shape for `ch_sets_canonical` and `ch_variants_canonical`.

### Join at ingest time

Extend the existing `ch_daily_sales` ingest to look up `canonical_player_id`, `canonical_set_id`, `canonical_variant_id` from these new containers at write time. Store as separate fields alongside the raw strings — never mutate the raw values (audit history stays).

## When to run this

**One-time pass:**
1. 90-day backfill completes (workflow run 29548161686)
2. Run probe script → get real cardinality numbers
3. Run canonicalization pipeline once (players → sets → variants)
4. Result: 3 new populated Cosmos containers

**Ongoing maintenance:**
- Nightly (or weekly, depending on new-name arrival rate): re-run for any strings that don't map to an existing canonical entity
- Cost: <$0.01 per nightly run (only new strings need processing)

## What Phase 6A does NOT do

- **No attribution-quality integration** — that's Phase 2 of the image pipeline. Different problem.
- **No card_id canonicalization** — CH's `card_id` is already stable + unique. Only the string fields are dirty.
- **No downstream product changes** — cross-cutting queries CAN use the canonical IDs, but existing queries keep working against the raw strings. Zero-risk migration.
- **No user-facing surface** — canonical names might eventually surface in the UI (unified player pages), but not this phase.

Phase 6A is the substrate. What we build on top of it is Phase 6B+.

## What Phase 6A unlocks

- **Top players by volume** (partition-hit on `ch_players_canonical`, then join to sales — cheap).
- **Player pages** (surface all sales for "Mike Trout" regardless of spelling).
- **Cross-set analytics** ("compare Trout's card values across releases").
- **Duplicate-detection warnings** in the add-holding flow ("Did you mean 'Michael Trout'? We have data as 'Mike Trout'").
- **Better search** (query autocomplete uses canonical entities + all aliases).
- **Reduced Cosmos RU cost** on player-scoped queries (partition-hit vs cross-partition scan).

## Success metrics

- ≥ 95% of raw player strings map to a canonical entity (misses are typographical errors we can't resolve).
- ≤ 5% false-positive rate on Drew's manual spot-check of 100 random mappings.
- Long-tail: top 1000 players cover ≥ 80% of sale volume.
- Zero regression on any pricing hot-path query.

## Dependencies

Already in repo:
- `@anthropic-ai/sdk` (used for alias generation in `aliasGeneration.service.ts`)
- `openai` (used elsewhere — check for embedding API access)
- `@azure/cosmos` (obvious)

Env vars needed:
- `CLAUDE_API_KEY` (already required)
- `OPENAI_API_KEY` (present if we use OpenAI embeddings; alternative: Voyage AI or Cohere)

Optional:
- `CLAUDE_CANONICALIZATION_MODEL` — defaults to Haiku 4.5
- `CANONICALIZATION_EMBEDDING_MODEL` — defaults to text-embedding-3-small

## Testing plan

- **Prompt fixtures**: 10 hand-labeled candidate groups. Assert LLM output matches Drew's ground truth ≥ 80% of the time.
- **Embedding cluster tests**: synthetic vectors, verify threshold behavior at 0.85 boundary.
- **Cost tracking tests**: mock the API, verify per-call cost accounting.
- **Store idempotency**: re-running the canonicalization pass on the same input doesn't create duplicates.
- **Alias merging**: if two runs produce overlapping alias sets, they merge cleanly.

## Open questions for Drew

- **OpenAI vs Anthropic for embeddings**: OpenAI's text-embedding-3-small is well-established; Voyage AI is Anthropic-adjacent and often better on text. Which do we want to depend on?
- **Sport inference from aliases**: if 90% of sales for the aliased player are Baseball, we tag the canonical as Baseball. Handle multi-sport cases (Bo Jackson, Deion Sanders)?
- **Adjudication threshold**: send to LLM when cluster similarity is 0.75-0.85. Too tight? Too loose? Real corpus will tell.
- **Canonical name style**: "FirstName LastName" preferred? Handle suffixes (Jr, Sr, III)?
- **Confidence bar for auto-application**: only apply canonical mappings with confidence >= 0.9? Or trust everything the LLM outputs?
