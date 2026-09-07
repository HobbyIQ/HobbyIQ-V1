# ADR: verify_queue is telemetry with a retention policy, not a work queue

**Status:** Accepted (August 17, 2026 — Drew)

---

## Context

`verify_queue` was built as "the human-in-the-loop residue" (CF-VERIFY-QUEUE, 2026-07-28):
ingest diverts a comp it cannot confidently classify, and Drew or a trusted admin
approves / rejects / fixes it through the `/verify` surface.

The container carries `defaultTtl: 5184000` (60 days), so an entry nobody actions
disappears. That TTL has been read as a bug — "2.3M entries expiring unreviewed" —
and the implied fix was to extend or remove it so the backlog could be worked.

## Measurements (2026-08-17, live `verify_queue`)

| | rows |
|---|---:|
| `pending` | **2,426,514** |
| `fixed` | 1,867 |
| `approved` | 848 |
| `rejected` | 33 |
| **ever actioned** | **2,748 — 0.11%** |

Composition of `pending`:

| reason | rows | share |
|---|---:|---:|
| `price-outlier` | 1,582,157 | 65.2% |
| `parser-low-confidence` | 778,789 | 32.1% |
| `image-mismatch` | 48,709 | 2.0% |
| `sample-audit` | 16,176 | 0.7% |
| `catalog-gap` | 682 | <0.1% |
| `user-flagged` | 1 | <0.1% |

Inflow after the same-day price-band fix (CF-ONE-OUTLIER-RULE, deployed 18:16Z):

| window | `price-outlier` rows | rate |
|---|---:|---:|
| 16:16–18:16Z (before) | 75,607 | ~37,800/h |
| 18:16Z→19:50Z (after) | 5,740 | ~3,650/h |

The band rule cut price-outlier inflow **90.3%**. Even so, total inflow across all
reasons runs ~9,550/h — roughly **229,000 rows/day**.

## Decision

**Treat `verify_queue` as telemetry and sampling infrastructure with a 60-day
retention policy. The TTL stays.**

Human review has actioned 2,748 rows across the queue's lifetime, against ~229,000
arriving per day. The TTL is not dropping sales that would otherwise have been
reviewed — it is the only thing bounding a store that human review has never
meaningfully consumed. Extending or removing it grows an unread backlog; it does
not recover value.

This is a decision about what the container *is*, not a defect being deferred.

## Consequences

- **Do not plan human-review workflows against `verify_queue` volume.** A feature
  that assumes the queue gets drained by people is assuming a throughput that has
  never existed (0.11%).
- **The `/verify` approve/reject/fix surface stays.** It works, and it is the right
  tool for the small, high-value slice someone actually looks at (`user-flagged`,
  `catalog-gap`). Nothing here removes it.
- **Diverted comps are still withheld from `sold_comps`.** That is the load-bearing
  behaviour and is unaffected: a suspect row never reaches a reprice or FMV compute
  regardless of whether anyone reviews it.
- **Reducing inflow is more valuable than increasing review capacity.** The
  price-band fix removed ~90% of the dominant reason in one change. Detector
  precision is the lever, not queue throughput.
- **If the queue is ever to be drained, it must be by automation.** Note that
  `autoTriageJob` reads **`comps_staging`**, not this container — its
  `pending-manual` query targets staging, and `verify_queue` has no `pending-manual`
  status at all (only pending/fixed/approved/rejected). Pointing triage at
  `verify_queue` is a new integration against a different container, not a
  parameter change to an existing scan.

## Revisit when

- A reason's precision improves enough that its pending volume falls to a scale a
  person could plausibly work (order 10³, not 10⁶).
- Automated triage is pointed at `verify_queue` deliberately, with its own
  guardrails — at which point retention should be reconsidered against how fast
  that automation actually drains.
