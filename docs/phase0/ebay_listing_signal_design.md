# CF-EBAY-LISTING-SIGNAL-REWORK — Design Doc

**Date:** 2026-05-25
**Workstream type:** Design lock for a follow-up implementation. No code
changes in this commit.
**Status:** Phase 2 (design) complete. Implementation **BLOCKED on
CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS** (see §6). Estimated post-unblock
implementation scope: ~4-6h.

**Headline:** Refocus `fn-ebay-signals` on active-listing data only.
The function already partially uses listing data (BIN price, active
inventory count). The rework removes the broken sold-data dependencies
(`soldDateRange` filter ignored at API level; `watchCount` field
gated by separate App Check approval) and introduces listing-only
methodology. Recommended primary signal: **supply velocity** —
active listing count delta over recent-vs-prior windows.

---

## 1. Strategic context

### Why this CF exists

User surfaced 2026-05-25 that eBay has not approved sold-data API access
for HobbyIQ. The original `fn-ebay-signals` design assumed two data
streams: (a) active-listing data (BIN prices, watcher counts, inventory)
and (b) sold-data velocity (`get_sold_count` calls using the
`soldDateRange` filter). Stream (b) is permanently blocked without
approval.

But: **eBay Browse API listing data is broadly available** without
sold-data approval. Listing data measures something different — and
arguably more useful for a forward-looking pricing engine. Sold-comps
tell you what *just happened*. Listings tell you what's happening
*right now* — supply pressure, asking-price sentiment, time-on-market
under the current demand curve.

For a predictive pricing engine focused on "where is this card going in
the next 7 days," the *now* signal is plausibly the stronger predictor
than the *past* signal. CardHedge's `compsMomentum` already covers the
past-sold-price-momentum question; the eBay slot can carve out a
distinct, complementary signal shape.

### Caveat from S4 backtest (2026-05-25)

CF-PHASE4B-BACKTEST.1 with deterministic config + 5/7 signals returned
`stable_signals_hurt` — the existing signal pipeline consistently makes
predictions worse, not better (MAPE delta 7d mean **-9.37**, all 5 runs
negative). Adding any new signal before diagnosing why current signals
hurt is risky. This design lock is ready-for-implementation but
implementation deferral is mandatory (see §6).

---

## 2. Current state of fn-ebay-signals

### What it does today

[`compiq-functions/fn-ebay-signals/function.py`](../../compiq-functions/fn-ebay-signals/function.py)
runs every 4 hours and emits three sub-signals into one ebay.json blob:

1. **Watcher/velocity** ([function.py:184-211](../../compiq-functions/fn-ebay-signals/function.py#L184-L211))
   — Active AUCTION listings, sum watchers, compare 7-day sold-count
   recent vs prior. Velocity ratio + watcher score → multiplier 0.80-1.25.
2. **BIN price drop** ([function.py:73-137](../../compiq-functions/fn-ebay-signals/function.py#L73-L137))
   — Today's avg BIN price vs 14-day rolling avg stored in
   `compiq-signals/{slug}/bin_history.json`. Drops < -5% / -10% trigger
   `sellers_dropping` / `sellers_dropping_fast` flags.
3. **Sell-through rate** ([function.py:140-170](../../compiq-functions/fn-ebay-signals/function.py#L140-L170))
   — `sold_7d / (sold_7d + active_listings)`. < 35% = `weak_demand`.

Blend: 60% watchers/velocity, 25% BIN trend, 15% sell-through. Final
multiplier clamped 0.80-1.25.

### What's broken today

Three independent failure modes:

| Mode | Where | Effect |
|---|---|---|
| OAuth auth | `shared.ebay_auth.get_ebay_token()` | Throws → signal=`auth_failed`, multiplier=1.0 |
| `soldDateRange` filter | Browse API server-side | Filter ignored per community reports; returns wrong/empty totals |
| `watchCount` field | Browse API field-level approval gate | Field omitted from responses unless App Check ticket approved |

The first failure is masking the other two: with `auth_failed` firing on
every cycle, we never reach the call sites that would surface (2) and
(3). If OAuth were fixed today, the function would emit a non-NEUTRAL
multiplier but with degraded inputs:

- `get_sold_count` would return zeros or arbitrary totals (filter ignored)
- `velocity_ratio` would be a meaningless number (uses sold count)
- `sell_through_rate` would be wrong (uses sold count)
- `watcher_score` would always equal 1.0 (`watchCount` field always 0)
- Only `bin_price_drop` would work as designed (active BIN price across
  current listings, no restricted fields)

So in practice today, the signal would compute on ~25% real data and
~75% degenerate inputs even with OAuth restored.

### Listing data IS already partially architected

The current code's BIN price drop signal proves the architecture
supports listing-data-only signals. The rework expands that surface
rather than introducing it.

---

## 3. Signal candidates evaluated (Q1)

### Candidate A — Supply velocity (RECOMMENDED PRIMARY)

**What it measures:** Count of active listings for player matching
keyword query, recent vs prior window. Rising listings = supply growth.
Falling = supply contraction.

**API call:** Single `GET /buy/browse/v1/item_summary/search` call with
`q="<player> baseball card"`, `category_ids=212`, time-bucketed via
client-side bucketing of `itemCreationDate` from the response. Need to
store a per-player listing-count history blob (analogous to existing
`bin_history.json`) for rolling-window comparison.

**Computational cost:** 1 API call per player per cycle for current
listings + small blob read/write. ≤2,000 calls/day across all current
players × 6 cycles/day — well under the 5,000/day Browse API daily
rate limit.

**Signal stability:** Listing inventory changes over days, not hours.
A 6-hour cadence (vs current 4-hour) is plenty. Daily cadence would also
work and would halve the rate-limit footprint.

**False signal risks:**
- **Single big seller dumping inventory** — one seller listing 50 copies
  of a card in one day spikes the supply count without reflecting market
  truth. **Mitigation:** group by `seller.username` before counting;
  cap per-seller contribution at 3-5 listings (or count distinct sellers
  with active listings rather than raw listing count).
- **Re-listing churn** — same card relisted by same seller after
  expiry. Often happens for "Best Offer" cards that don't sell. **Mitigation:**
  track listings by `itemId` (eBay's stable item identifier) and don't
  double-count repeat IDs across windows.
- **Seasonality** — pre-show weeks and post-show weeks have systematic
  inventory swings. **Mitigation:** keep the recent/prior window short
  (e.g., 7d vs 7d prior) so seasonal slow drift doesn't appear as signal,
  AND the existing `show_calendar` overlay already accounts for this at
  the aggregator level.

### Candidate B — Listing price trend

**What it measures:** Median asking price across active listings, recent
vs prior. Sellers raising asks = bullish sentiment. Lowering = bearish.

**API call:** Same single search call; client-side compute median.

**Computational cost:** Same as A. Same rate-limit footprint.

**Signal stability:** Price-trend on listings moves faster than supply
counts (sellers reprice within hours). Worth a more frequent cadence
than A, but still daily granularity captures most signal.

**False signal risks:**
- **High-variance sample** — listings span /1 base, /99, /25 parallel,
  PSA 10, raw, etc. A median across the whole population mixes apples
  and oranges. **Mitigation:** filter to a narrower card-identity match
  (e.g., specific year + set in the query string), but this requires
  per-card iteration rather than per-player — significantly increases
  rate-limit footprint.
- **Outlier asks** — one delusional seller listing at 10× market drags
  the median up. **Mitigation:** trim top/bottom 10% before median.
- **Already exists** — the current code's `bin_price_drop_signal` IS
  this candidate. The rework would mostly preserve it, perhaps with
  tighter outlier handling.

### Candidate C — Time-on-market

**What it measures:** Average days-listed across active listings (`now -
itemCreationDate` per item). Short time-on-market = high demand. Long
= low demand or overpriced supply.

**API call:** Same single search call; client-side compute from
`itemCreationDate` field.

**Computational cost:** Same as A/B.

**Signal stability:** Cleanly forward-looking. Time-on-market is a
direct demand signal — items that don't sell accumulate days, items
that sell quickly get pulled.

**False signal risks:**
- **Survivorship bias** — only un-sold listings appear; sold ones don't.
  So the "average time-on-market" includes only the items that haven't
  sold yet, which biases the metric upward. **Mitigation:** this isn't
  a *flaw* in the metric — it's the metric definition. The "average
  days-listed among current unsold" is itself a valid demand-side
  signal.
- **Listing duration limits** — eBay caps GTC listings to 30 days
  before renewal. Time-on-market saturates at 30d for unsold items;
  re-listed items reset to 0. This adds noise.
- **Less direct** than A — supply growth/contraction is the more
  immediately interpretable signal.

### Candidate D — Listing-to-sold ratio

**Blocked.** Requires sold-data access. Out of scope for this rework.

### Candidate E — Composite of A+B(+C)

**What it measures:** Blended supply (A) + price-trend (B) + optionally
time-on-market (C).

**Computational cost:** Same — all three are derivable from the same
single search call.

**Methodology complexity:** Higher. Requires choosing sub-weights and
managing three failure modes simultaneously.

**Risk:** Composite signals are harder to diagnose when they hurt
predictions. Given the S4 finding that the current ebay COMPOSITE
(watcher/velocity 60% + BIN 25% + STR 15%) likely contributes to
`stable_signals_hurt`, opening with another composite may inherit the
same diagnosis problem.

### Recommendation — Candidate A (supply velocity) as primary

**Why:**

- Direct semantic clarity ("more sellers listing → bearish; fewer →
  bullish"). Easy to reason about when post-deploy data shows it
  hurts.
- Single-input methodology aligns with the CF-PHASE4B-SIGNAL-HARM-
  DIAGNOSIS workstream's likely ablation-test framing. Composite
  signals are harder to ablate.
- Lowest false-signal-risk profile *if* seller-dedup mitigation is
  built in from the start.
- Computational cost identical to other candidates — no penalty for
  choosing simplest.

**Secondary recommendation:** preserve the existing `bin_price_drop`
sub-signal (Candidate B) as a separate flag-emitter, not part of the
multiplier. It surfaces in the aggregator's `bin_signal` /
`bin_drop_pct` pass-through that the MCP prompt consumes. That data
flow is already plumbed and useful as soft context for the LLM, even
if not part of the multiplier math.

**Drop entirely:** `watcher_score`, `sell_through_rate`, `velocity_ratio`
(based on sold count). All depend on either restricted (`watchCount`)
or broken (`soldDateRange`) inputs.

---

## 4. Locked methodology recommendation (Q2)

For Candidate A (supply velocity):

### Window definition

- **Recent window:** count of distinct active listings observed in last
  **7 days** (`itemCreationDate >= now - 7d`).
- **Prior window:** count of distinct active listings observed in
  **prior 7 days** (`itemCreationDate >= now - 14d AND
  itemCreationDate < now - 7d`).

Why 7d/7d rather than other windows: matches the cadence the rest of
the pipeline uses (compsMomentum is recent-7-sales vs prior-7-sales).
Symmetric windows simplify interpretation.

### Aggregation method

Per-player per-cycle:

1. Single search call returns up to 200 active listings sorted by
   `newlyListed` (eBay default).
2. Group by `seller.username`; cap each seller's contribution at 3
   listings (anti-dumping mitigation per §3 Candidate A).
3. Bucket by `itemCreationDate` into recent (≤7d) and prior (8-14d)
   buckets.
4. `recent_count = sum(capped contributions, recent bucket)`.
5. `prior_count = sum(capped contributions, prior bucket)`.

### Multiplier formula

```
if prior_count <= 0:
    ratio = 1.0
else:
    ratio = recent_count / prior_count

# Inverted: rising supply = bearish (multiplier < 1.0).
# Inversion: multiplier = 2.0 - ratio, then clamped.
multiplier = clamp(0.85, 1.20, 2.0 - ratio)
```

The inversion captures the supply-demand semantic: ratio > 1 (rising
supply) → multiplier < 1 (bearish). Ratio < 1 (contracting supply) →
multiplier > 1 (bullish). Symmetric clamp matches compsMomentum's range.

### Categorical state thresholds

| Multiplier | Signal |
|---|---|
| > 1.08 | `supply_contracting` (bullish) |
| 0.93 - 1.08 | `supply_stable` |
| < 0.93 | `supply_growing` (bearish) |

### Edge cases

- **Zero listings (recent and prior):** rare for tracked-player query
  scope. Emit `signal: no_listings, multiplier: 1.0`.
- **Single listing in prior window:** ratio extremely sensitive. Add
  floor: if `prior_count < 3`, emit `signal: insufficient_history,
  multiplier: 1.0`. Don't compute on noisy small N.
- **All listings from one seller:** anti-dump cap (§4 step 2) already
  handles. If after capping `recent_count == 0`, emit
  `signal: dump_filtered, multiplier: 1.0`.
- **Listings concentrated in time (e.g., 50 listings in one day):**
  bucket boundaries handle this naturally; one big day in recent window
  shows up as rising supply, which is the correct semantic.

### Different from compsMomentum methodology

compsMomentum is **count-of-sales-by-time-bucket → ratio → multiplier**
on sold prices. This is **count-of-listings-by-time-bucket → ratio →
INVERTED multiplier** on active inventory. Same mathematical shape,
opposite semantic interpretation (rising sales = bullish; rising
listings = bearish). Documented here so the inversion isn't ambiguous
at implementation time.

---

## 5. Weight allocation recommendation (Q3)

### Current Layer 1 weights (post-rename, post-odds-closure)

```text
compsMomentum  : 0.20
ebay           : 0.20  (currently emits multiplier=1.0 due to auth_failed)
reddit         : 0.15  (in social blend; currently auth_failed)
trends         : 0.15  (in social blend; working)
odds           : 0.15  (now permanently neutral; key unstaged per CF-ODDS-API-REWORK)
stats          : 0.10
news           : 0.05
[youtube]      : 0.10  (blended into social slice; working)
```

### Recommendation: Option A — replace ebay slot at same 0.20 weight

After implementation, the renamed signal `ebayListingPressure` (or
similar — naming locked at implementation time, see §9 open question)
takes the existing 0.20 slot.

**Why option A:**

- Preserves current weight balance which has been working empirically
  (yes, S4 showed signal-on hurts predictions, but reweighting is a
  separate methodology question that belongs to CF-PHASE4B-SIGNAL-
  HARM-DIAGNOSIS, not to this rework).
- One-axis change is cleaner than multi-axis (slot rename + weight
  shift simultaneously).
- The odds slot is now permanently degraded; redistributing odds's
  0.15 is a separate decision that can ride alongside this CF's
  implementation OR ride with CF-ODDS-API-REWORK's outcome. Don't
  couple it here.

### Rejected: Option B (reweight with redistribution)

Couples too many decisions. The weight tuning question belongs with
the harm-diagnosis workstream, which has the empirical data to inform
it.

### Rejected: Option C (two ebay signals at 0.10 each)

There's no second eBay signal forthcoming (sold-data approval is the
permanent blocker, not a temporal one). Allocating a slot for a hoped-
for future signal is premature.

---

## 6. CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS dependency caveat (Q4)

**Implementation BLOCKED on CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS.**

S4's `stable_signals_hurt` verdict reveals the current signal pipeline
*hurts* predictions. Three possible diagnosis outcomes shape this CF's
implementation scope:

### Outcome 1 — Some signals net positive, others net negative

Per-signal ablation identifies which signals contribute negative lift.
If eBay's current signal is net-positive (one of the 4 stable helpers),
this rework should preserve methodology characteristics that work and
fix what's broken. If eBay's current signal is net-negative (one of the
9 stable hurters), this rework should redesign methodology to avoid
sharing characteristics with other negative signals.

**Implementation scope adjustment:** unchanged, but methodology choices
inform.

### Outcome 2 — All current signals net negative

The signal pipeline as a whole hurts. Adding more signals doesn't fix
the fundamental problem. Possible root causes: prompt design causes the
LLM to overweight signals; weight allocation is wrong; signals operate
at the wrong time-horizon for 72h/7d predictions.

**Implementation scope adjustment:** PAUSE this CF entirely until the
root-cause redesign is locked. The listing-signal rework may not be
worth shipping if the architecture above it is being rebuilt.

### Outcome 3 — Methodology, not signal content, causes harm

If the diagnosis surfaces that the prompt structure or per-card
calibration is the harm vector (and the underlying signals themselves
are informative), fix methodology first. The listing signal can then
ship into a corrected pipeline.

**Implementation scope adjustment:** ships unchanged but after
methodology fix lands.

### Decision: don't pre-commit to a scope adjustment now

The design is locked under each outcome's implications. The
implementation scope adjusts based on what diagnosis finds. Premature
commitment to one outcome's scope path would force re-design later.

---

## 7. eBay API requirements (Q5)

Verified via eBay developer documentation + community sources (see
§10 cross-references).

### Auth

- **Flow:** Client credentials OAuth (no user authorization required).
  Application token sufficient for active-listing search.
- **Endpoint:** `POST https://api.ebay.com/identity/v1/oauth2/token`
- **Scope:** `https://api.ebay.com/oauth/api_scope`
- **Token TTL:** 2 hours. Token caching with refresh-on-expiry
  recommended (current `shared.ebay_auth.get_ebay_token()` fetches a
  new token per call — works but wastes cycles; consider caching).
- **Credentials:** `EBAY_APP_ID` (App ID/Client ID) +
  `EBAY_CERT_ID` (Cert ID/Client Secret). Both currently present in
  `fn-compiq` app settings but eBay's OAuth endpoint is rejecting them
  (separate blocker — see §2 "What's broken today").

### Rate limits

- **Browse API daily limit:** 5,000 calls/day at application level.
- **Application Growth Check** available to request higher limits (free
  service from eBay Developer Program).
- **HobbyIQ usage projection (Candidate A, recommended):**
  10 tracked players × 1 call/cycle × 6 cycles/day = **60 calls/day**.
  Trivially within the limit even at 10× scale-up.

### Endpoints

Primary endpoint for the rework:

```text
GET https://api.ebay.com/buy/browse/v1/item_summary/search
  ?q=<player> baseball card
  &category_ids=212
  &filter=buyingOptions:{FIXED_PRICE|AUCTION}
  &sort=newlyListed
  &limit=200
Authorization: Bearer <app_token>
```

Response includes `itemSummaries[]` with per-item fields:
- `itemId` — stable identifier (for cross-window dedup)
- `seller.username` — for anti-dumping seller cap
- `itemCreationDate` — for window bucketing
- `price.value` — for backup price-trend signal (Candidate B)
- `buyingOptions[]` — to distinguish auction vs BIN

### Restricted fields (avoid)

- **`watchCount`** — requires App Check ticket approval. Field omitted
  from response when not approved. The current code reads it and gets
  0/null, which is why the `watcher_score` always evaluates to 1.0.
  Drop this dependency entirely in the rework.

### Broken filters (avoid)

- **`soldDateRange`** — per eBay community reports, this filter is
  silently ignored by the Browse API server. Drop all `get_sold_count`-
  style calls. Use of this filter explains why `velocity_ratio` and
  `sell_through_rate` in the current code emit garbage even when OAuth
  works.

### Approval requirements summary

- **No approval needed** for standard Browse API active-listing search.
- **No approval needed** for `category_ids=212` (sports cards).
- **App Check ticket needed** for `watchCount` (not part of rework
  scope).
- **Buy API production contracts** mentioned in eBay docs — applies to
  certain Buy API capabilities but not basic Browse search per
  community discussion. Confirm at implementation time if any rate-
  limit / production-tier gate surfaces.

### Separate operational blocker (not in design scope)

`get_ebay_token()` currently throws against the live OAuth endpoint
despite present credentials. Hypothesis: eBay developer app needs
cert renewal or re-attestation. **CF-RESTORE-SIGNAL-CREDS eBay portion**
(still open) must resolve before this rework's implementation can be
verified. The OAuth fix is a prerequisite for ANY eBay signal —
listing-based or otherwise — to function.

---

## 8. Scope inventory + implementation estimate (Q6)

### Files that change in implementation

| File | Change |
|---|---|
| `compiq-functions/fn-ebay-signals/function.py` | Major rewrite. Remove `get_sold_count`, watcher-score logic, sell-through-rate function. Add supply-velocity computation per §4. Preserve BIN price-drop as separate flag emitter. |
| `compiq-functions/fn-ebay-signals/__init__.py` | Maybe rename signal label (if §9 open question resolves to renaming). |
| `compiq-functions/fn-signal-aggregator/function.py` | Update `signals.get("ebay", {})` references to new key if renamed. Update flag-emit block for new signal states (`supply_contracting`, `supply_growing` etc.). Possibly drop `sell_through_rate` pass-through (no longer computed). Possibly drop `ebay_demand_high` flag (depends on hot/cold semantic which is going away). |
| `backend/src/services/signals/signals.types.ts` | `SignalPayload` — drop `sell_through_rate`, `str_signal` fields (gone). Optional: add new fields if any surface beyond `bin_*`. Maybe rename `components.ebay` to new key for explicitness. |
| `mcp-server/pricing.ts` | Port-with-provenance copy of `SignalPayload` updates. Update prompt rendering (line 514-516 currently references `sell_through_rate` and `str_signal` — drop those lines or rewrite). |
| `compiq-functions/fn-ebay-signals/tests/` | Doesn't exist today. Add test fixtures + assertions if test scaffolding gets built. |
| iOS | None expected. Verified earlier (CF-CARDHEDGE-SIGNAL-RENAME) that iOS doesn't pattern-match on `signal_flags` literals. Verify with same grep pattern at implementation time. |

### Implementation scope estimate

**~4-6 hours focused work**, broken down:

- Supply-velocity computation + seller-dedup + window bucketing: ~1.5h
- BIN price-drop preservation as separate sub-signal: ~30 min (mostly
  refactor, code exists)
- Aggregator flag-emit updates + pass-through field changes: ~45 min
- TS type updates (signals.types.ts + pricing.ts) + prompt rewrite to
  drop `sell_through_rate` / `str_signal`: ~45 min
- Manual smoke (deploy fn-compiq, manually invoke fn-ebay-signals,
  verify blob shape): ~30 min
- Coordinated commit + push + handoff update: ~30 min

Risk additions:

- If eBay OAuth fix (CF-RESTORE-SIGNAL-CREDS eBay) requires cert
  renewal / re-attestation, +1-3h operational
- If supply-velocity methodology needs tuning post-deploy (e.g.,
  seller-cap value), +30-60 min iteration

---

## 9. Open questions for implementation phase

1. **Signal-name rename?** Current key is `ebay` (generic). Candidates
   for renamed key:
   - `ebayListingPressure` — semantic, brand-coupled
   - `listingSupplyPressure` — semantic, brand-neutral (in case data
     source ever expands beyond eBay)
   - `ebayInventoryFlow` — alternate semantic
   - Keep `ebay` and don't rename (lowest-disruption)

   Defer naming lock to implementation phase, after CF-PHASE4B-SIGNAL-
   HARM-DIAGNOSIS findings inform whether the slot lives or dies.

2. **Token caching?** Current `get_ebay_token()` fetches a new token
   per call. With 2h TTL and 6 cycles/day, cache-in-blob would reduce
   OAuth calls by ~85%. Worth doing — but small scope, can ride with
   this CF or stand alone as a hygiene improvement.

3. **Per-card vs per-player query?** Current code queries
   `"<player> baseball card"`. More specific queries (e.g.,
   `"<player> <year> <set> <number>"`) would give cleaner signals
   per-card but multiply API calls by N cards/player. Tradeoff between
   precision and rate-limit budget. Recommend per-player at start,
   per-card as a follow-up if signal-harm diagnosis says per-card
   precision is needed.

4. **Schedule cadence?** Current is every 4 hours. Listing data
   doesn't move faster than that. Could reduce to every 6 hours
   (matches YouTube's) or even daily without losing signal quality.
   Rate-limit margin says it doesn't matter much; pick at impl time.

5. **`bin_price_drop` sub-signal preservation in what form?** Two
   options:
   - Keep as part of the ebay multiplier blend (matches current
     architecture)
   - Extract to standalone signal source (`binPriceDrop` slot at
     lower weight)

   Option 1 is simpler; option 2 enables per-signal ablation testing
   in CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS. Decide based on what diagnosis
   workstream prefers.

---

## 10. Cross-references

### Related CFs

- **CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS (HIGH, blocking)** — must resolve
  before this CF's implementation. Surfaced via S4 backtest verdict
  `stable_signals_hurt` (commit `567d55c`).
- **CF-RESTORE-SIGNAL-CREDS eBay portion (open)** — OAuth credential
  blocker, must resolve before any eBay signal works (listing or
  otherwise).
- **CF-ODDS-API-REWORK (MEDIUM)** — parallel pattern of "credential
  provisioning revealed broken signal architecture." Same lesson
  applies: verify API surface against code expectations before
  recommending purchase / re-subscription.

### Design-phase pattern precedents

- [cardhedge_signal_rename_design.md](./cardhedge_signal_rename_design.md)
  — design lock pattern (`80e9971`). Same in-place D-clean strategy
  expected for this rework.
- [picker_migration_design.md](./picker_migration_design.md) — design
  lock pattern (`e2115cb`). Same scope-inventory + locked-decisions
  structure.

### Investigation findings

- [fn_compiq_investigations.md](./fn_compiq_investigations.md) §2 —
  original eBay degraded-signal finding (commit `aee64a4`); identified
  OAuth as the auth_failed cause and noted EBAY_APP_ID + EBAY_CERT_ID
  present but rejected by eBay's identity endpoint.
- S4 backtest [multirun_summary.md](./backtest_runs/20260525-225825-deterministic-creds-restored/multirun_summary.md)
  — `stable_signals_hurt` verdict that gates this CF's implementation.

### eBay developer documentation (research sources)

- [Browse API Overview](https://developer.ebay.com/api-docs/buy/browse/overview.html)
- [search method](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search)
- [OAuth scopes](https://developer.ebay.com/api-docs/static/oauth-scopes.html)
- [API call limits](https://developer.ebay.com/develop/get-started/api-call-limits)
- [ItemSummary type (watchCount restriction)](https://developer.ebay.com/api-docs/buy/browse/types/gct:ItemSummary)
- [Community: soldDateRange filter ignored](https://community.ebay.com/t5/RESTful-Buy-APIs-Browse/Filter-Browse-API-by-lastSoldDate/td-p/34291585)
