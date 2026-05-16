# Parallels Reference — Path Z Curation Workflow

Issue #33 Phase 2b-iv-a. This document describes the agent-assisted curation
workflow for expanding the parallels reference catalog (the
`parallel_attributes` Cosmos container) from public hobby-community sources.

See also:
- [`backend/docs/parallels-reference-schema.md`](./parallels-reference-schema.md) — authoritative schema (still the source of truth)
- [`backend/docs/parallels-reference-cosmos-setup.md`](./parallels-reference-cosmos-setup.md) — Cosmos container layout
- [`backend/src/services/parallelsReference/curationHarness.ts`](../src/services/parallelsReference/curationHarness.ts) — implementation
- [`backend/scripts/parallels-curate-from-article.ts`](../scripts/parallels-curate-from-article.ts) — runnable CLI

## Why Path Z

Phase 2b-iii-a (50-page Bowman Chrome 2024 paginate harness) surfaced a
handful of unmatched parallel variants (Aqua Raywave, Fuchsia, Green) that
the seed `parallel_attributes` records did not cover. The original plan
called for cross-referencing the Beckett Online Price Guide (OPG) to expand
the alias index, but Beckett's Terms of Service and the broader scraping
exposure made that approach unsafe.

Path Z is the alternative we settled on:

> An agent fetches a **public** hobby-community article (primarily
> [cardboardconnection.com](https://www.cardboardconnection.com)), extracts a
> structured proposal of the article's parallel coverage, surfaces the
> proposal to the owner for cold review, and only writes to Cosmos after the
> owner explicitly confirms.

Cardboard Connection, Checklist Insider, and manufacturer release-sheet PDFs
are all public, free, and clearly intended for collector reference; reading
one article at a time, with attribution, falls comfortably within fair use.
The harness is rate-limit-friendly (single fetch per run, identifying
User-Agent header) and never re-publishes the article's content.

## Acceptable sources

| Source | Notes |
| --- | --- |
| `cardboardconnection.com` | Primary. Long-form set previews include explicit `/N` print-run lists per parallel. |
| `checklistinsider.com` | Secondary. Newer; coverage gaps. |
| Topps / Panini / Bowman release sheets | When manufacturer publishes a PDF. Highest fidelity. |

DO NOT use Beckett OPG, eBay listing scrapes, or any login-walled / paid
source. The harness validates that the citation type is `web-research` and
the URL is `http(s)`; nothing else is accepted.

## The harness end-to-end

```
┌────────────────────┐      ┌───────────────────────────┐
│  Owner runs CLI    │ ───▶ │ extractProposalFromArticle │ ─┐
│ (article-url, set) │      │  • node fetch              │  │
└────────────────────┘      │  • htmlToText              │  │
                            │  • regex /N + 1/1 matchers │  │
                            │  • color / auto inference  │  │
                            └───────────────────────────┘  │
                                          │                │
                                          ▼                │
                            ┌───────────────────────────┐  │
                            │ renderProposalMarkdown    │  │ ← printed to stdout
                            │   (markdown table)        │  │
                            └───────────────────────────┘  │
                                          │                │
                                          ▼                │
                            ┌───────────────────────────┐  │
                            │ validateProposal           │  │
                            │  • schema rules            │  │
                            │  • tierWithinSet ≠ null    │  │
                            │  • no duplicate ids        │  │
                            └───────────────────────────┘  │
                                          │                │
                       ┌──────────────────┴──────────┐     │
                       ▼                             ▼     │
                ┌───────────────┐         ┌─────────────────┐
                │ --dry-run set │         │ owner types 'y' │
                │  STOP HERE    │         │ at the prompt   │
                │  no writes    │         └─────────────────┘
                └───────────────┘                   │
                                                    ▼
                                       ┌──────────────────────┐
                                       │ commitProposal        │
                                       │  • upsert per entry   │
                                       │  • composite id       │
                                       │  • IDEMPOTENT         │
                                       └──────────────────────┘
```

## Operational rules

1. **Owner explicitly confirms each commit.** The CLI prompts before any
   write. `--dry-run` skips even the prompt and the Cosmos client entirely.
2. **`tierWithinSet` is always owner-curated.** The extractor leaves it
   `null` and emits a warning. Validation rejects any entry with
   `tierWithinSet === null`, so the owner must edit the proposal (or update
   the CLI to take a tier override) before committing.
3. **Composite id is `{set}|{parallelName}|{auto|base}`.** This is computed
   by `parallelAttributesId()` in `ingestion.ts`. Repeated runs of the same
   proposal are no-ops at the database level — that's the harness's
   idempotency guarantee (covered by the `idempotent: running twice` test).
4. **`sourceCitation.type` MUST be `web-research`** for everything this
   harness produces, with the article URL captured verbatim.
5. **No raw HTML or article text is stored in Cosmos.** Only the
   structured fields. `matchedText` lives only on the in-memory proposal so
   the owner can spot-check; it never reaches the database.

## CLI usage

```pwsh
# Environment
$env:COSMOS_KEY = az cosmosdb keys list --name hobbyiq-comps `
  --resource-group rg-hobbyiq-dev --query primaryMasterKey -o tsv

# Step 1: ALWAYS dry-run first.
npx --yes tsx backend/scripts/parallels-curate-from-article.ts `
  "https://www.cardboardconnection.com/2024-bowman-chrome-baseball-cards" `
  "2024 Bowman Chrome Baseball" `
  --dry-run

# Step 2: review the printed proposal. If `tierWithinSet` is **REQUIRED** for
# any row, the proposal cannot commit as-is. Either:
#   - Edit the script to inject a tier per parallel, OR
#   - Apply the tier mapping manually in a follow-up upsert.

# Step 3: commit (this prompts y/n before writing).
npx --yes tsx backend/scripts/parallels-curate-from-article.ts `
  "https://www.cardboardconnection.com/2024-bowman-chrome-baseball-cards" `
  "2024 Bowman Chrome Baseball" `
  --reviewed-by="owner"
```

## What's intentionally NOT in the harness

- **No production runs in PR #39 (Phase 2b-iv-a).** This PR ships the
  harness, unit tests, and this doc only. Phase 2b-iv-b validates the
  harness against the real 2024 Bowman Chrome article and decides whether
  to scale to other Bowman family products.
- **No automatic tier assignment.** Tier is owner judgement.
- **No alias generation.** Aliases land later via `variantAliases[]` after
  the curator observes which raw CH variant strings collapse to the same
  parallel.
- **No `ch_card_index` writes.** This harness only writes to
  `parallel_attributes`.

## Phase 2b-iv-b — what to validate

When the owner is ready to run the harness against the real article:

1. `--dry-run` first. Confirm the extractor recognises every parallel the
   article lists. Spot-check 2-3 entries against the article.
2. Look for `parentVariant` warnings. Currently the extractor never sets it.
   If the article repeatedly groups colors under a clear parent (e.g.,
   "Lava parallels include Aqua Lava (/199), Red Lava (/50)"), the owner
   should set `parentVariant = "Lava"` on those entries pre-commit.
3. Cross-check the resulting `parallel_attributes` rows against the 10
   unmatched-variant rows from Phase 2b-iii-a (Aqua Raywave / Fuchsia /
   Green). Anything still unmatched after this run blocks Phase 2b-iii-b.
