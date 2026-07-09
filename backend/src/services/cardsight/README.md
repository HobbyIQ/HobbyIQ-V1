# services/cardsight/ — DEPRECATED (2026-07-08)

Cardsight was decommissioned when the platform migrated to CardHedge as
the source of truth for card identity, search, and comps. The modules
in this directory remain as **frozen legacy** for wire back-compat and
optional taxonomy metadata; **none of them are on the hot path for
search or pricing today**.

## What lives here

- **`cardsightGradesTaxonomy.ts`** — resolves an optional
  `gradeCompany + gradeValue + isAuto → gradeId` UUID via
  `api.cardsight.ai/v1/grades`. The FK is a nice-to-have on
  `PortfolioHolding` for downstream marketplace/population queries
  that HobbyIQ **doesn't run today**.

  As of 2026-07-08 the resolver is **gated behind
  `CARDSIGHT_TAXONOMY_ENABLED=true`** (default OFF). With the flag
  unset, every call short-circuits to `null` — the same result the
  code path already produced on any upstream failure — with zero
  outbound HTTP.

  To re-enable if the Cardsight endpoint returns and you want the
  FK populated on new holdings, set the flag in App Service
  application settings.

## What does NOT live here

- Search (fully on CardHedge via `services/unifiedSearch/dispatcher.ts`
  and `services/compiq/cardhedge.client.ts`)
- Pricing / CompIQ (CardHedge)
- Card identity resolution (CardHedge)

## Wire contracts that keep the "cardsight" name

These are intentional — renaming them would break iOS decoders shipped
in production. Do NOT touch:

- `candidateId: "cardsight:<id>"` prefix (iOS strips before
  `/price-by-id`)
- `PortfolioHolding.cardsightGradeId` legacy field (older iOS builds
  still read this via back-compat)

Everything else in this dir is safe to delete once we're confident no
downstream consumer references it. That audit is a separate task.
