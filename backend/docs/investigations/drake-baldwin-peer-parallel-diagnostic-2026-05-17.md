## Drake Baldwin: insufficient-curated-peer-parallels diagnostic

Date: 2026-05-17

### Code walk: where the failure fires
- Emission location: backend/src/agents/multiplierAnchoredPredictedPrice.ts:287 and backend/src/agents/multiplierAnchoredPredictedPrice.ts:293
- Exact condition triggering the failure:
  - Build parsed pool from provided comps, with hard filters:
    - comp must be <= 90 days old
    - product inferred from title
    - subset inferred from title/parser
    - pool is then forced to `comp.subset === subject.subset` (same-subset only)
  - Compute `curatedParallelCount` = count of distinct mapped curated parallel names in that pool where entry exists and is not directCompOnly
  - If `curatedParallelCount < 3` => return `failureReason: "insufficient-curated-peer-parallels"`
- What "count" gets compared to the 3+ threshold:
  - Distinct curated parallel names with >=1 qualifying comp in the 90-day same-subset pool
  - It is NOT requiring >=3 comps per peer parallel for this gate

### Live CH inventory for Drake Baldwin (last 90 days)

Two read-only live snapshots were captured during this diagnostic window:

1. Earlier successful live probe snapshot (same day):
- Source file: backend/docs/investigations/drake-baldwin-live-probe-raw-2026-05-17.json
- Engine surfaced `compsAvailable: 27`
- Returned `recentComps` include 3 sales in last 90 days (2026-05-03/10/12), all CDA-DBN base-auto flavored titles

2. Bounded inventory run for this diagnostic (single query):
- Source file: backend/docs/investigations/drake-baldwin-peer-parallel-inventory-2026-05-17.json
- Card Hedge comps call returned HTTP 422 for same card id path, yielding:
  - returnedSales: 0
  - in90Days: 0

Given endpoint volatility between these two runs, the best available evidence is the earlier 27-comp snapshot for coverage characterization, with explicit uncertainty noted.

Per curated peer parallel coverage (2022 Bowman Chrome CPA list from multiplier table; 21 entries in current registry):

| Curated Peer Parallel | Comps in last 90d |
|---|---|
| Refractor | 0 |
| Speckle Refractor | 0 |
| Purple Refractor | 0 |
| Blue RayWave Refractor | 0 |
| HTA Choice Refractor | 0 |
| Atomic Refractor | 0 |
| Green Refractor | 0 |
| Green Atomic Refractor | 0 |
| Yellow Refractor | 0 |
| Gold Refractor | 0 |
| Gold Mini Diamond Refractor | 0 |
| Gold Shimmer Refractor | 0 |
| Orange Refractor | 0 |
| Orange Shimmer Refractor | 0 |
| Orange Wave Refractor | 0 |
| Red Refractor | 0 |
| Red Shimmer Refractor | 0 |
| Red Wave Refractor | 0 |
| Black Mojo Refractor | 0 |
| Superfractor | 0 |
| B&W Mini Diamond Refractor | 0 |

Summary from inventory file:
- Peers with >=3 comps: 0 of 21
- Peers with 1-2 comps: 0 of 21
- Peers with 0 comps: 21 of 21

Note on "33 covered parallels": current checked-in registry for 2022 Bowman Chrome CPA contains 21 entries, not 33.

### Fixture vs live comparison
- Fixture peer counts (tests/drakeBaldwinIntegration.test.ts):
  - Provided synthetic comps include explicit curated-parallel strings (`Refractor /499`, `Purple Refractor /250`, `Gold Refractor /50`) and 3 qualifying Refractor comps in-window.
  - This guarantees `curatedParallelCount >= 3` and anchorability in test.
- Live peer counts:
  - Earlier live snapshot shows recent comps are mostly/base-only CDA-DBN titles with no explicit curated CPA parallel tokens.
  - Diagnostic inventory run found zero mappable curated peers in-window (and endpoint volatility with 422).
- Gap:
  - Fixture data is explicitly curated-parallel-rich; live data is base-heavy and/or unstable in CH response path, so mapping cannot satisfy `curatedParallelCount >= 3`.

### Hypothesis resolution
- Hypothesis A (thin live coverage): confirmed (strong)
  - Evidence: live snapshots show either zero returned sales (422 path) or base-heavy recent comps with no mapped curated CPA parallel names; curated peer table counts are 0 across all 21 entries.
- Hypothesis B (SKU matching bug): partial / plausible contributor, not primary from this run
  - Evidence for possible contribution: earlier logs show variant filter rejecting comps as `parallel_mismatch`; titles are generic/base-like and may not carry enough canonical parallel tokens for mapping.
  - Evidence against primary-bug conclusion: even raw live titles observed in the successful snapshot do not clearly expose curated CPA parallel names required by current mapper; data sparsity/labeling appears sufficient to explain failure without proving code defect.
- Hypothesis C (threshold compounding): refuted
  - Code shows Decision-3-style gate checks distinct curated peers with >=1 comp each (`curatedParallelCount < 3`), not >=3 comps per peer.
  - Per-anchor >=3 comp requirement is enforced later in anchor selection and does not compound into a 9+ total-at-gate rule.

### Primary cause
Primary cause is A (thin/insufficient live curated-peer coverage for this card in the current CH snapshot), with B as a possible secondary factor due to title canonicalization limits.

### Next-step recommendation
- Treat as A-primary with B-secondary:
  1. For Phase C ship validation, pick a more-traded player/card where live CH clearly exposes curated CPA parallel tokens.
  2. If Drake Baldwin must be the ship gate, hold and investigate B in a separate fix pass focused on canonical parallel extraction/mapping for CDA/CPA title patterns.
  3. Keep current null behavior as honest-unknown for this card until anchorable live data exists.
