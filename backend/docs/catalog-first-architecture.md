# Checklist-First Catalog Architecture

**Author:** Session with Drew, 2026-08-04
**Status:** Design doc → Tier 2 implementation shipping this session.
**Owner:** Drew
**Related:** `backend/docs/ios-unified-rebuild-blueprint.md`, memory rules `project_catalog_is_the_moat_not_vendor_apis`, `project_no_public_data_api`, `project_persist_vendor_lookups_architecture`

---

## The problem

The `card_catalog` today is **reactive** — we synthesize entries FROM sales as they land. That produces:

- **Duplicates:** same physical card gets multiple catalog rows because TCA + CH + CS all tag it differently. 257 "2024 Bobby Witt" catalog entries mostly with `undefined setKey`.
- **Gaps:** cards that haven't sold yet (new releases, rare parallels) have no catalog row → no cardId → no unified pricing → sibling rescue produces wrong numbers.
- **Noise:** eBay import fuzzy-matched sales create catalog rows with garbage grades ("PSA undefined"), broken parallel labels, mismatched years.
- **No canonical source of truth:** matching a user's holding to a catalog entry is guesswork.

Symptoms we saw today:
- Bobby Witt BGS 9.5 → priced at $6.92 (non-auto base cards mislabeled)
- Cam Caminiti Blue Refractor → priced at $18 (sibling rescue from 213 unrelated Bowman Draft sales)
- 1991 Score Griffey #396 → "no comps" in inventory despite 1 pool row (slug mismatch)
- 2024 Topps Dynasty Bobby Witt → doesn't appear in search (setKey undefined)

Every one of these traces to catalog data quality.

## The move: proactive catalog from published checklists

Every card that CAN exist is defined ONCE, by its product checklist. Sales get **matched** to a canonical entry — they don't create new ones.

```
2024 Bowman Chrome Prospect Autographs (product)
  CPA-BWJ: Bobby Witt Jr.
    ↳ Base Refractor
    ↳ Blue Refractor (/150)
    ↳ Green Refractor (/99)
    ↳ Gold Refractor (/50)
    ↳ Orange Refractor (/25)
    ↳ Red Refractor (/5)
    ↳ Superfractor (1/1)
    ↳ Black & White Shimmer
    ↳ Black & White Red Ink SSP (unnumbered)
```

Every row → one `card_catalog` doc with a deterministic slug:

```
hiq:baseball:2024:bowman-chrome:cpa-bwj:red-refractor:auto:num-5
hiq:baseball:2024:bowman-chrome:cpa-bwj:superfractor:auto:num-1
hiq:baseball:2024:bowman-chrome:cpa-bwj:black-white-red-ink:auto
```

Sales match to that entry via the canonical tuple. No duplicates. No gaps.

## Three-tier architecture

### Tier 1 — TCA `/catalog` live lookup

**Coverage:** modern products TCA has indexed
**Effort:** 0 (already have API access; honors your "not steal it" memory rule)
**Quality:** high

TCA is our biggest volume source (117K sales/day today). Every TCA sale already carries TCA's catalog identity. We just need a **matcher** that reads TCA's identity fields and maps them to our canonical slug at ingest time. No mirror of TCA's catalog — we consult it live per lookup.

**What we build:** a small mapper inside `tcaWebhook.routes.ts` and `tcaFirehose.job.ts` that reads `(tca.year, tca.set, tca.number, tca.parallel, tca.isAuto, tca.printRun)` and either:
- Finds an existing canonical `card_catalog` entry with the same tuple, OR
- Creates a fresh entry with `source: "tca-catalog-mirror"` when the checklist tier hasn't seeded that release yet

The stored entry ONLY carries the tuple + TCA's `sourceExternalId`. When TCA's identity changes upstream, we re-consult TCA live for the new tuple — don't lock in a stale mirror.

### Tier 2 — LLM checklist ingest **(this session's build)**

**Coverage:** new + backlog releases that TCA doesn't cover cleanly
**Effort:** medium (LLM prompt + review UI)
**Quality:** high

For each release we want in the catalog:
1. Provide a checklist SOURCE (Topps product page URL, PDF, or plain-text checklist).
2. LLM extracts structured `{cards: [{number, player, parallels: [{name, printRun}]}]}` with a strict schema.
3. Upsert to `card_catalog` with `source: "checklist:topps.com/product/2024-bowman-chrome"` and `confidence: 0.95`.
4. Drew reviews the diff, approves.

Time budget per release: ~15 min LLM + ~15 min Drew review = one Bowman Chrome release cataloged per half-hour. A modern-baseball corpus (~30 releases/year × 5 years = 150 releases) = ~75 hours of investment for near-complete modern coverage.

### Tier 3 — User-verified backfill

**Coverage:** anything a user actually holds
**Effort:** 0 net-new (already have pending-review flow)
**Quality:** very high (Drew personally reviews)

Every `pending-review` eBay-import holding Drew approves becomes a permanent catalog seed. Victor Figueroa Red Ink SSP was this pattern — hand-seeded a catalog entry after review, and now his holding + comp both anchor to it.

Roll this into a small queue: when Drew hits "approve" on a pending-review row, if no catalog entry matches, auto-seed one from the holding's identity fields. He's already reviewing — the catalog row is a free byproduct.

## The canonical slug format

Existing format already works — this doc just codifies it:

```
hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallelSlug}:{autoFlag}[:num-{printRun}]
```

Rules:

| Component | Rule | Examples |
|---|---|---|
| `sport` | baseball, basketball, football, hockey, soccer, pokemon (parked) | `baseball` |
| `year` | 4-digit release year | `2024`, `1991` |
| `setKey` | lowercase kebab of set name; strip year prefix + sport suffix | `bowman-chrome`, `topps-chrome`, `score` (NOT `1991-score-baseball`) |
| `cardNumber` | lowercase; keep hyphens; strip `#` | `cpa-bwj`, `396`, `bcp-117` |
| `parallelSlug` | lowercase kebab of parallel name; canonical (`refractor` not `refracto`) | `base`, `refractor`, `blue-refractor`, `black-white-red-ink` |
| `autoFlag` | `auto` or `no-auto` | `auto` |
| `printRun` | when serially numbered | `num-5`, `num-99`, `num-150` |

**Canonicalization rules that already exist and MUST NOT be re-invented:**

- `feedback_slug_recompute_only_improve` — never demote a slug to less specific
- `project_market_language_normalization` — "True Blue" = "Blue Refractor" in canonical
- `project_product_family_ladder` — bowman-chrome → bowman, topps-chrome-update → topps-chrome
- `reference_cardsight_pristine_ten_conflation` — CS conflates BGS 10 Black Label with Pristine 10; preserve via title text

Anything in `hobbyiqCardIdSlug.service.ts` (or equivalent) is authoritative.

## Data flow after the rebuild

**Ingest path (unchanged externally; new matcher internally):**

```
TCA sale lands → tca-webhook / firehose
              → catalogMatcher.canonicalize(tuple) → hobbyiqCardId
              → sold_comps row written with canonical cardId + hobbyiqCardId
              → duplicates prevented by contentHash keyed on canonical id
```

**Read path (already unified per Session A):**

```
Portfolio hero / Grade Curve / recent-sales
  → computeUnifiedPrice(cardId | hobbyiqCardId)
  → queries sold_comps by canonical id, no fuzzy matching
  → returns marketValue + predictedPrice
```

**Pending-review flow (small addition):**

```
User approves pending-review holding
  → catalogMatcher.canonicalize(cleanedFields)
  → if no match: auto-seed card_catalog with source: "user-verified"
  → holding.cardId + hobbyiqCardId set to canonical slug
```

## What we build this session

### 1. `checklistIngest.service.ts` — LLM extractor

Input:

```typescript
{
  source: "topps-product-page" | "beckett-checklist" | "manual-text",
  sourceUrl: string | null,
  rawContent: string,    // HTML or plain text of the checklist
  contextHints: {
    year: number,
    sport: string,
    setName: string,       // e.g. "2024 Bowman Chrome"
    subset?: string,       // e.g. "Prospect Autographs"
  },
}
```

Output (validated against a strict JSON Schema before any Cosmos write):

```typescript
{
  release: {
    year: number,
    sport: string,
    setKey: string,        // canonicalized
    setName: string,       // original
    productLine: string | null,   // e.g. "prospect-autographs"
  },
  cards: [
    {
      cardNumber: string,
      player: string,
      isAuto: boolean,
      parallels: [
        {
          name: string,                // "Blue Refractor"
          slug: string,                 // "blue-refractor" (canonicalized)
          printRun: number | null,
          isSsp: boolean,
        }
      ]
    }
  ],
}
```

Uses Azure OpenAI Foundry Models (existing `enrichment.service.ts` pattern). Cost per release: ~$0.02 in tokens. Sanity checks:

- Card count ≥ 20 (catches truncated extractions)
- Every card has ≥ 1 parallel (base at minimum)
- No duplicate `cardNumber` within a release
- Parallel slugs match a known canonical vocab (fallback: LLM re-slugging)

### 2. `catalogMatcher.service.ts` — the canonical function

One function every ingest path calls:

```typescript
canonicalize(input: {
  year: number,
  sport: string,
  setName: string,
  cardNumber: string,
  parallel: string | null,
  isAuto: boolean,
  printRun: number | null,
}): Promise<{
  slug: string,           // the canonical hiq: id
  found: boolean,          // true = matched existing catalog row
  confidence: number,      // 0-1
  matchedBy: "exact" | "fuzzy-parallel" | "family-fallback",
}>
```

Behavior:

1. Compute the canonical slug from input.
2. Query `card_catalog` for that exact slug. If found → return.
3. Fuzzy match on parallel (handle "True Blue" → "Blue Refractor" per memory).
4. Fall through to product-family (Bowman Chrome variants → Bowman Chrome canonical).
5. If nothing matches AND source is trusted (checklist or TCA), seed a fresh row.
6. Return the slug + confidence.

### 3. `ingest-checklist.script.ts` — Drew's driver

CLI script Drew runs per release:

```bash
npx tsx backend/scripts/ingest-checklist.ts \
  --url "https://www.topps.com/pages/2024-bowman-chrome-baseball-checklist" \
  --year 2024 \
  --set "Bowman Chrome" \
  --sport baseball
```

Prints a diff summary:

```
Release: 2024 Bowman Chrome (bowman-chrome)
  New catalog entries: 175
  Updated: 8 (parallel additions)
  Skipped: 12 (already matched)
  Total cards in checklist: 195

Sample:
  + hiq:baseball:2024:bowman-chrome:cpa-bwj:red-refractor:auto:num-5   Bobby Witt Jr.
  + hiq:baseball:2024:bowman-chrome:cpa-bwj:black-white-red-ink:auto   Bobby Witt Jr.
  ~ hiq:baseball:2024:bowman-chrome:cpa-bwj:base-refractor:auto       (parallel slug canonicalized)

Approve? [y/N]
```

Drew reviews, `y`, entries land in `card_catalog`. Every downstream pipeline picks them up.

### 4. Review UI hook-in (deferred to next session)

Add "Add missing card" quick-action to the pending-review queue. When a holding can't match ANY catalog entry, Drew clicks the button, LLM extracts identity from the holding's photos + title, seeds a catalog row. Follow-up session — needs iOS/web work.

## Session backlog beyond this session

**Dedupe pass** (short, high-impact):
Run once after checklist ingest covers a release. Reads all `card_catalog` rows in a release, groups by canonical tuple, promotes the highest-confidence row, demotes duplicates to `superseded: true`. Reference-only rewrites, no destructive writes.

**Backfill priority queue:**
Order releases by "holdings that would benefit" descending. If 50 users hold 2024 Bowman Chrome cards, that release goes first. Start with:
1. 2024 Bowman Chrome (Bobby Witt, Cam Caminiti, Owen Carey)
2. 2018 Bowman Chrome (Ohtani)
3. 2020 Bowman Chrome Prospects (Bobby Witt auto)
4. 2026 Bowman Chrome (Victor Figueroa, misc)
5. 1991 Score (Griffey)
6. ... and outward

**TCA live matcher wire-up:**
Deferred — smaller scope than the checklist ingest but touches every TCA ingest path. Do after Tier 2 has a few releases under its belt so the matcher has real canonical entries to match against.

**iOS "Missing card" flow:**
When identity can't be resolved, offer user "This card isn't in our catalog yet — add it?" and route to a submission form. Turns every user into a checklist contributor.

## Success metrics

Post-rollout for a release:

- **Zero "undefined setKey" catalog rows** for that release
- **Every user holding** in that release matches to a canonical `card_catalog.id`
- **Grade Curve view** shows real per-parallel rows (not diluted-across-parallels medians)
- **Search finds every card** by any of: player, cardNumber, parallel name, print run
- **Recent-sales endpoint** returns the exact card's comps, not siblings

Post-full-rollout across the modern baseball corpus (~150 releases):

- Catalog size drops from ~1M synthesized rows to ~200K canonical rows
- Pricing engine sibling rescue rarely fires (real pool always available)
- Ingest cost per sale drops (no LLM identity resolution per row when checklist matches)

## Guardrails from memory (must apply)

- `feedback_secrets_never_to_stdout` — checklist ingest never logs API keys / raw HTML with tokens
- `feedback_verify_before_commit` — every catalog write batch commits with a summary log line
- `feedback_live_config_changes_halt_for_confirm` — checklist ingest to prod Cosmos requires explicit approval per release (already the shell of the ingest CLI's `Approve? [y/N]` step)
- `feedback_tsc_strict_pre_push` — full `tsc --noEmit` before any push touching ingest or matcher
- Slug rules from `project_market_language_normalization`, `project_product_family_ladder`, `reference_cardsight_pristine_ten_conflation` are LOAD-BEARING and re-implementing them is a bug

## What ships this session

`checklistIngest.service.ts` + `catalogMatcher.service.ts` + `ingest-checklist.script.ts` — a working Tier 2 that Drew can run against one release end-to-end tonight (2024 Bowman Chrome recommended as the pilot since it lit up so many mispricing bugs today).

Next session: run the pilot ingest on 2-3 releases, verify pricing improves for the mispriced holdings, extend to the priority backlog.
