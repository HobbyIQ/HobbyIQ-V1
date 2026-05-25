# CF-CARDHEDGE-SIGNAL-RENAME — Design Doc

**Date:** 2026-05-25
**Workstream type:** Design lock for a follow-up implementation. No code changes in this commit.
**Status:** Phase 2 (design) complete. Implementation deferred to a separate
authorized workstream (~2-4h, depending on aggregator-test surface).

**Headline:** Rename the aggregator's `cardhedge` signal source to
`compsMomentum`. In-place coordinated deploy. Flag strings rename in
lockstep. Source Azure Function file name (`fn-cardhedge-comps`) stays —
that's the data-source brand, which remains factually accurate.

---

## 1. Why renaming

The aggregator's `cardhedge` signal source is named after its data vendor
(CardHedge), not after what it measures. This creates two problems:

1. **Vendor-name leakage into the signal-output vocabulary.** TrendIQ
   Layer 1 surfaces `playerMomentum.componentSignals.cardhedge` to the
   detail-view, exposing a brand that is (a) deprecated as a comp source
   for the pricing pipeline and (b) semantically unrelated to what the
   signal actually measures.
2. **Coupling between data-source identity and signal-output identity.**
   If we ever change the underlying comp-source provider (or blend
   multiple sources into the same signal), the field name would mislead.

The rename decouples the signal-output name from the data-source brand
without touching the data-source layer itself.

## 2. What the signal actually measures

From [compiq-functions/shared/cardhedge.py:171-221](../../compiq-functions/shared/cardhedge.py#L171-L221):

- Inputs: 25 most recent sold comps for the player's top-ranked card
  (per CardHedge `/cards/card-search` top hit), in newest-first order
- Computation: `recent_avg = mean(prices[0:7])`, `prior_avg = mean(prices[7:14])`,
  `ratio = recent_avg / prior_avg`, clamped to `[0.85, 1.20]`
- Signal classification: `rising` if `multiplier > 1.08`, `falling` if
  `< 0.93`, else `stable`. `no_data` when prices array is empty.

Semantically: **short-term comp price momentum on the player's top card.**
"Momentum" in the trading sense — recent-vs-prior price ratio. Not a
trajectory or trend in the Layer-2 sense (which operates over weeks on a
specific card), but a velocity reading over the most recent ~14 sales.

## 3. Locked name: `compsMomentum`

**Reasoning (per Phase 2.1 lock):**

- **Most accurate semantic match** — recent-vs-prior comp price ratio
  is "momentum" in standard trading vocabulary. The 0.85–1.20 clamp +
  rising/falling/stable classification is a velocity reading, which is
  exactly what momentum means.
- **Nests logically under TrendIQ Layer 1.** Layer 1 = `playerMomentum`.
  One of its component signal inputs is `compsMomentum` — short-term
  price momentum from sold comps. The hierarchy reads clean:
  `response.trendIQ.components.playerMomentum.componentSignals.compsMomentum`.
- **Avoids collision with TrendIQ product name.** `response.trendIQ` is
  the product surface; `compsMomentum` lives a couple of levels deep
  inside it — no ambiguity.
- **Avoids collision with Layer 2's `cardTrajectory`.** Layer 2's
  "trajectory" is a multi-week trend on a specific card; `momentum` at
  Layer 1 is a short-window velocity on the player's top card. Different
  layers, different semantics, different names.
- **Brand-neutral.** If the underlying data source ever changes
  (Cardsight, eBay, custom), the name stays accurate. The signal is what
  it computes, not who provides the input data.

Candidates considered and rejected in Phase 2.1: `compsRising`,
`marketActivity`, `tradingMomentum`, `compsTrend`. `compsMomentum` won on
semantic accuracy + hierarchical fit.

## 4. Locked migration strategy: Strategy 1 (in-place rename)

**Strategy** — a single coordinated change: aggregator emits new key
name and new flag strings; type definitions update in same PR (no change
needed, but explicit ack); tests update fixtures; deploy aggregator and
backend together. Old `aggregated.json` blobs degrade gracefully until
next cycle rewrites them.

### Why Strategy 1 (rather than dual-write or versioned)

Three strategies were evaluated in Phase 2.2 analysis:

| Strategy | End state | Cost in D-clean | Risk reduction |
|---|---|---|---|
| **1. In-place rename** | Single coordinated deploy. Clean end state from day one. | Low — one PR, one deploy. | N/A — D-clean controls all readers. |
| **2. Dual-write transition** | Aggregator writes both keys + both flag-string variants temporarily. Second deploy removes old. | Higher — two deploys, dual-key surface, risk of "temporary" code outliving its purpose. | Designed for uncontrolled readers. There are none. |
| **3. Versioned field** | New field added, old deprecated, removed after grace period. | Strictly higher than dual-write (dual-write + version metadata). | Designed for external API contracts. This is internal. |

**The D-clean context inverts the usual risk-cost equation.** Dual-write's
*value* is preserving uncontrolled readers during migration. In a
sole-user pre-launch product where every consumer lives in the same
monorepo (and iOS rebuilds are free), the uncontrolled-reader population
is zero. Strategy 2's transitional dual-key complexity is pure cost without
delivering its intended value.

The yesterday's "D1 strict preservation was over-applied" lesson
(see picker-migration design doc, e2115cb) applies directly: production-
safety patterns designed for multi-tenant migrations inflate complexity
in single-user pre-launch contexts. Strategy 1 is the D-clean answer.

## 5. Locked flag string transition

Three flag strings change in lockstep with the key rename:

| Old | New |
|---|---|
| `cardhedge_comps_rising` | `compsMomentum_rising` |
| `cardhedge_comps_falling` | `compsMomentum_falling` |
| `cardhedge_no_data` | `compsMomentum_no_data` |

**Consumer surface verified safe.** A repo-wide grep for the literal
strings `cardhedge_comps_rising` / `cardhedge_comps_falling` /
`cardhedge_no_data` returned:

- Aggregator emits them (the rename target)
- Historical backtest result JSON files contain them (frozen artifacts,
  no rewrite needed — they reflect a state in time)
- **No code pattern-matches them as literals.** No iOS source matches.
  No backend code matches. No mcp-server code matches.

The flag strings flow through `playerMomentum.flags[]` and into the
TrendIQ explainer as opaque descriptive strings. No literal-matching
consumer means the rename has no coordinated-update surface beyond the
aggregator itself.

## 6. Locked scope: signal output name + flag strings

In scope:

- Aggregator output key: `cardhedge` → `compsMomentum`
- Aggregator flag strings: `cardhedge_comps_*` → `compsMomentum_*`
- Aggregator tests (compiq-functions side) — fixtures + assertions

**Explicitly deferred (out of scope for this workstream):**

- `fn-cardhedge-comps` Azure Function file name. Renaming the deployed
  function affects routing, URL paths, infra-as-code, and possibly
  upstream callers — significantly larger blast radius than the output-
  field rename. The function name reflects "we fetch comps from
  CardHedge as the data source," which remains factually accurate; the
  rename here decouples the *signal output name* from the data-source
  brand, which is the actual semantic goal. Function file name can be
  revisited if/when the data source itself changes.
- `shared/cardhedge.py` Python module name and its functions
  (`build_comps_payload`, `get_card_sales`, etc.) — also data-source
  module, not signal-output module. Stays.
- `mcp-server/cardhedge.ts` — data-source client. Stays.
- `backend/src/services/compiq/cardhedge.client.ts` — data-source
  client. Stays.

## 7. Locked blob handling: graceful degradation, no backfill

Existing `compiq-signals/{slug}/cardhedge.json` blobs (written by
`fn-cardhedge-comps` before the rename deploy) carry the old field
shape. After the aggregator rename deploys, these blobs are no longer
read by the new aggregator (it now looks for `{slug}/compsMomentum.json`
— see scope inventory item 8.1 below).

**Behavior with no backfill:**

- Old `cardhedge.json` blobs remain in storage (no cleanup needed; not
  load-bearing).
- New aggregator reads `compsMomentum.json`. Until the next cycle of
  `fn-cardhedge-comps` writes that file, the aggregator gets a `None`
  for the `compsMomentum` signal and uses `multiplier=1.0` default.
- One aggregator cycle later (nightly), the source function writes
  `compsMomentum.json` and the signal returns to live.

**Trade-off accepted:** ~one aggregation cycle of `compsMomentum`-defaulted-
to-1.0 for tracked players. Acceptable in D-clean: no user-visible
breakage (default multiplier is neutral), and the cycle gap is on the
order of hours.

**Alternative considered:** force-regenerate via manual aggregator sweep
after deploy. Adds operational step without meaningful benefit when
graceful degradation already covers it.

## 8. Scope inventory — every file touched

### 8.1 Aggregator (Python, Azure Functions)

- `compiq-functions/fn-signal-aggregator/function.py`
  - [Line 18-26](../../compiq-functions/fn-signal-aggregator/function.py#L18-L26): `WEIGHTS` dict key rename
    `"cardhedge": 0.20` → `"compsMomentum": 0.20`
  - [Line 71-77](../../compiq-functions/fn-signal-aggregator/function.py#L71-L77): the cardhedge flag-emit block:
    `ch = signals.get("cardhedge", {})` → `cm = signals.get("compsMomentum", {})`,
    with the three flag strings updated as Section 5.
  - The `components` dict (line 149-152) and `component_signals` dict
    (line 153-162) are built from `WEIGHTS`, so they update automatically
    once the WEIGHTS key changes — no separate edit needed.
- `compiq-functions/fn-cardhedge-comps/function.py`
  - The function itself stays (deferred per Section 6). But the *signal
    type label* it writes under — currently `save_signal(player_name,
    "cardhedge", ...)` if the call site uses that key — needs to change
    to `"compsMomentum"` so the aggregator's `load_signal(player_name,
    "compsMomentum")` finds it.
  - **Verification step before implementation:** trace `save_signal`
    call sites in `fn-cardhedge-comps` and in the timer-trigger that
    invokes `get_cardhedge_signal`. The label string is the field name
    aggregator reads.

### 8.2 Backend TS

- `backend/src/services/signals/signals.types.ts` — `SignalPayload.components`
  type currently lists `ebay/reddit/trends/odds/stats/news/youtube` but
  **not** `cardhedge`. No type change strictly required; optional cleanup
  is to add `compsMomentum?: number` for explicitness. Recommend the
  optional cleanup for documentation value.
- `mcp-server/pricing.ts` — port-with-provenance copy of `SignalPayload`.
  Same call as above; recommend the optional cleanup in lockstep.
- `backend/src/services/compiq/trendIQ.compute.ts` — reads
  `componentSignals` as `Record<string, number>` ([line 310](../../backend/src/services/compiq/trendIQ.compute.ts#L310)).
  No literal-key access. No change required.

### 8.3 Aggregator tests (Python)

- Test fixtures in `compiq-functions/tests/` (verification step before
  implementation: confirm location and surface) that emit a `cardhedge`
  signal fixture into the aggregator's input must rename to
  `compsMomentum`. Assertion strings referencing
  `cardhedge_comps_rising` etc. update to the new flag strings.

### 8.4 iOS

- **Verified zero impact.** Repo-wide grep for the three flag literals
  returned no `.swift` matches. Layer 1 component signal field is
  rendered via the opaque `componentSignals: Record<string, number>`
  shape — no literal-key access.

### 8.5 Storage (Azure Blob)

- Existing `compiq-signals/{slug}/cardhedge.json` blobs: no action
  (Section 7 — graceful degradation).

### 8.6 Documentation + handoff

- `docs/SESSION_HANDOFF.md` — append rename-shipped entry.
- This design doc as the canonical reference.
- Historical backtest result JSONs in `docs/phase0/backtest_runs/` —
  no change (frozen artifacts; the flag strings there reflect the
  state at the time the backtest ran).

### 8.7 App Insights / Kusto queries

- Any saved KQL queries referencing `cardhedge_comps_*` literals or
  the `cardhedge` component field need manual update. **Not in code
  — flagged as operator follow-up.** Recommend snapshotting any pinned
  queries before deploy.

## 9. Implementation scope estimate

**~2-4 hours**, broken down:

- Aggregator rename + flag strings + verification: ~45 min
- Source function (`fn-cardhedge-comps`) signal-label change: ~30 min
- Aggregator tests update: ~30-60 min (depends on test surface)
- Type def documentation cleanup (optional): ~15 min
- Deploy aggregator + verify next-cycle blob writes new path: ~30 min
- Production smoke (one tracked player) + handoff update: ~30 min

Risk additions:

- If `fn-cardhedge-comps` test surface is larger than expected (~+30 min)
- If aggregator deploy chains into a wider Azure Functions deploy due to
  shared module imports (~+30 min coordination)

## 10. Cross-references

- [picker_migration_design.md](./picker_migration_design.md) — sister
  workstream that locked the D-clean methodology this rename inherits.
- `aff2245` — CardHedge scope correction commit that surfaced the
  signal-rename as a follow-up distinct from CardHedge backend removal.
- `e2115cb` — picker migration design lock; D-clean precedent.
- `843b210` — TrendIQ Phase 1 methodology lock; defines the
  `playerMomentum` hierarchy that `compsMomentum` nests under.
- [SESSION_HANDOFF.md §CF-CARDHEDGE-SIGNAL-RENAME](../SESSION_HANDOFF.md)
  — Phase 1 originating note and Phase 2.1 candidate inventory.
