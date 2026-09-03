# HobbyIQ Pricing Audit — 2026-09-03

**Audited sha:** `4fce24f` (live prod, `GET /api/health` at 12:23 UTC, deployed 12:18:59Z)
**Method:** six independent dimensions, each audited then re-verified by a second agent against a
separate fresh clone. Live prod Cosmos read-only. No writes, no fixes, no dispatches.

**Read this first:** prod moved three times during this audit (`8935130` → `a30eeb8` → `4fce24f`).
Verification caught **four findings that were already fixed** before anyone read them, and **one
CRITICAL the original audit missed entirely**. Every number below is re-confirmed at `4fce24f`.

---

## 1. Scorecard

| Dimension | Verdict | What it means |
|---|---|---|
| **Indexes** | 🔴 **CRITICAL** | Hockey index is printing **4577.46** right now. It should read ~100. |
| **End-to-end** | 🔴 **CRITICAL** | Nothing reprices holdings on a schedule. Stored prices drift forever. |
| **Curves** | 🔴 **CRITICAL** | 47% of the grade-calibration table is unreachable. Pokémon priced with baseball math. |
| **Persistence** | 🔴 **CRITICAL** | One card stores $270 against a pool whose median is $10.10. |
| **Pools** | 🟡 **ISSUES** | Cross-product pool merging on 3 of 4 code paths. Biggest leak fixed 09-03. |
| **Doctrine** | 🟡 **ISSUES** | Two live money jobs still on the second engine; two routes never unified. |

**7 CRITICAL · 13 HIGH · 14 MEDIUM · 7 LOW**
**4 findings were fixed in-flight before verification read them. 8 are genuinely new.**

---

## 2. Findings

### 🔴 CRITICAL

#### C-1 — The hockey index is printing a 36x fabricated number, live, today
**New. Missed by the original audit.** `insights/marketIndexCompute.service.ts:135`

The nightly index job creates `const carryForward = new Map()` fresh on every run and seeds it
from only a 14-day lead-in. Basket members with no sale in those 14 days get no value and drop
out. Then `marketIndex.service.ts:309` divides by `usedWeight` — the surviving weight — which
hands the survivors 100% of the influence.

**The 6% max-weight cap does not bound a card's effect on the level.** Proven in isolation: 100
members at 1% weight, one doubles → level 101.00 (correct). Same doubling with the other 99
unvalued → level **200.00**.

Live prod, `2026-09-03`, queried read-only during this audit:

| Sport | Level | Fresh members | Basket |
|---|---|---|---|
| baseball | 109.59 | 94 | 100 |
| basketball | 90.20 | 82 | 100 |
| football | 102.64 | 67 | 100 |
| **hockey** | **4577.46** | **1** | **43** |
| pokemon | 73.01 | 10 | 100 |

Hockey's entire index is one $65 sale on a card whose base value is $1.42 and whose basket weight
is 0.056%. Reproduced to the cent by simulating the shipped nightly path.

Why it shipped: `tests/marketIndexes.test.ts:160` pins the mix-shift invariant using a
**fully-populated** carry map, so `usedWeight` is always 1.0 and the collapse is unreachable in
test. The 180-day backfill path is also immune — it accumulates carry-forward as it walks. The bug
exists **only on the nightly append**, which is every point written since the backfill.

> **Blast radius:** every sport tile, every night. Backfilled and nightly points are computed by
> materially different methods, so the stored series is not internally comparable — re-running with
> `--backfill` would silently rewrite recent history to different values.
> **Display-only** — confirmed no pricing path imports the index.
> **Owner:** Drew ruling — needs a persisted carry-forward *and* a `usedWeight` floor below which
> the point refuses to publish.

#### C-2 — Nothing reprices holdings on a schedule
`daily-refresh.yml` — no reprice step exists. `grep -rln reprice .github/workflows/` returns only
`backfill-runner.yml` (manual dispatch only) and `pricing-invariant-audit.yml` (report-only).

The persisted value a collector sees is whatever it was when last written, and drifts from the pool
forever. **20 of 118 live holdings are more than 7 days stale, max 18.2 days. 28 of 118 sit on a
pool that has grown since the value was written.**

Worse, `pricing-invariant-audit.yml:36-39` says in its own cron comment: *"06:20 UTC — after the
5AM ET daily refresh has repriced, so the audit judges the numbers the portfolio will actually
serve today."* The refresh does not reprice. The detector is sound; there is no repair lane.

> **Owner:** Drew ruling — cadence and RU cost is a product decision.

#### C-3 — A card stores $270 against a pool whose median is $10.10
Holding `9f082213`, Victor Figueroa Red Ink SSP. Re-queried live during this audit:
**51 rows, median $10.10, min $5, max $270.** Exactly **one** row matches the Red Ink card — the
$270, and it is the **oldest** row in the pool (2026-06-11). The other 50 are base CPA-VF autos.

The live engine computes **$9.74** for this identity. The stored $270 survives only because the
cost-basis floor rejects the $9.74 as under 15% of the $278.60 basis. **The floor — a sanity
guard — is the only thing standing between pool contamination and a 96%-wrong number reaching the
user.** It fires silently and leaves the stale value in place with no operator signal.

The code comment at `unifiedPricing.service.ts:218` justifies the self-comp rule using this exact
card: *"1 self-comp @ $278.60, 0 other comps."* That premise is now false — the pool has 51 rows.
The true anchor is window-filtered out for being 84 days old while 50 wrong-card sales supply a
false quorum. **The rule is weakest precisely where it was designed to be strongest.**

> **Owner:** split-identity census + Drew ruling on window policy for thin SSP pools. The ~$10 base
> autos must **move** to the base row, not be deleted.

#### C-4 — 47% of the grade calibration table is unreachable
`scripts/grade-calibrate.mjs:217` writes sport keys as `["Football","Basketball","Pokemon"]`.
`gradeCalibrationConfig.ts:119` lowercases before lookup. They never match.

Shipped keys are `['Basketball','Football','Pokemon','baseball']` — only `baseball` resolves, and
only because it is a lowercase literal default, not a member of `SPORTS`. **306 of 649 tier cells
stranded (47.1%).** Confirmed live: `ch_daily_sales` writes Capitalized, `sold_comps` writes
lowercase.

**2,374,172 graded rows — 60.1% of the graded pool — lose their sport calibration.**

The coverage script that should catch this (`grade-calibration-coverage.cjs:133`) enumerates
`Object.keys` and never simulates a lookup, so it scores all 306 stranded cells as healthy.

#### C-5 — Pokémon cards are priced with baseball grade math
The `CF-POKEMON-ENGINE-WIRING` refusal at `gradeCalibrationConfig.ts:203` and `:249` says a wrong
number is worse than null. But `lookupValueBandMultiplier` has **no Pokémon guard** and runs
**first** in `getGraderPremium` (`compiqEstimate.service.ts:1427`, above the guarded lookup at
`:1432`).

Simulated against shipped data, Pokémon PSA 10:

| Raw anchor | What fires | What is correct |
|---|---|---|
| $30 | 4.18x (baseline) | 7.45x (pokemon byTier, n=1512) |
| $150 | 2.66x | 7.45x |
| $300 | 2.30x | 7.45x |

**968,155 graded Pokémon rows understated 1.8x–3.2x.** The refusal was chosen over substitution;
substitution happens anyway at a higher-priority rung.

#### C-6 — Base identities collapse different cards into one pool
`hiq:basketball:2024:panini-prizm:17:base:no-auto` — live, filtered exactly as the engine filters:
**205 rows, 6 different products, 6 different players, 73.2% contamination.**

Price range **$0.22 to $13,000 — a 59,091x spread in one pool.** A `$0.22 Panini Prizm Draft Picks
base` and a `$13,000 PSA 10 LeBron Color Blast` are the same identity.

#### C-7 — 49% of holdings carry no rung label, from at least two legacy writers
58 of 118 holdings cannot be classified by any rung gate: 5 with `fmvRung` explicitly null
(`portfolioStore.service.ts:4467`), **53 with no `fmvRung` key at all** — a second, older writer
the one-path PR does not currently scope. `valueSource` is absent on all 118.

Holding `60a7cfcc` stores **$3.49** against its own basis prose reading *"Last sold $1000 …
Projected: $1176"* — a **337x** self-contradiction. Both its identities return zero pool rows.

---

### 🟡 HIGH

| ID | Finding | Evidence | Owner |
|---|---|---|---|
| **H-1** | Two live money jobs run the second engine | `sellSideNotifyJob:147`, `buyerIqDealScanner:136` call `computeCanonicalFmv`, never `valueIdentity`. Scanner is wired live in `server.ts:11`. Also reachable by HTTP at `ebayImportRematch.routes.ts:797`. | existing PR |
| **H-2** | Deal scanner mints slugs with hardcoded sport | `buyerIqDealScanner:137` — `hiq:baseball:${year ?? 2024}:${set ?? "unknown"}:${num ?? "unknown"}:base:no-auto`. Prices whatever pool that collides with, then **fires a deal alert on it.** No user typed anything; no confidence gate. | new round |
| **H-3** | `/search` and `/price` never unified | `compiq.routes.ts:2226` → `computeEstimate`, no one-path gate. `/price` at `:2811` mints a slug with `sportGuess = "baseball"` and `parallel \|\| "Base"` behind only a 0.5 confidence check. | new round |
| **H-4** | Cross-product union guard called from 1 of 4 sites | `mayUnionIdentities` enforced only at `exactPoolSupremacy.ts:386`. `observedGradeCurve.service.ts:1649` `resolveUnionSlug` returns the slug with **no comparison**. Live: holding `c37ead87` union median **$76.75** vs its own side **$20.50** — 3.7x, matching neither half. | new round |
| **H-5** | Player-index basket has no self-comp handling | `contributorUserId` is not even SELECTed in `playerIndexRead.ts:78`. Live: 134 self-comp rows across **67 players**; basket minimum is 5, so one user's own cards can constitute a basket — and **confidence rises with contamination** because breadth counts them. | own-comps PR |
| **H-6** | Unbounded adjacent-band rescue | `gradeCalibrationConfig.ts:134` gates sample size but **not band distance**. Live today on baseball: `panini-contenders` PSA 10 at $10,000+ borrows the **"Under $25"** ratio of **20.88x** at distance 9. **602 rescues live now; 1,199 once C-4 is fixed.** | **must ship with C-4** |
| **H-7** | Hardcoded multiplier matrix still live | `canonicalFmv.service.ts:2244` — PSA 10 = 4x, BGS 10 = 5x, SGC 10 = 3x. **24 classifier families reach it** (bowman-draft, topps-gold-label, panini-national-treasures…). Three call sites. This is the class `CF-EMPIRICAL-ONLY` removed from `observedGradeCurve`. | Drew ruling |
| **H-8** | Provenance label is a guess, not a report | `observedGradeCurve.service.ts:1585` sets the value from rung A, then labels it by **separately re-querying** whether rung B *would* have been available. Four rungs outrank the one it names. The confidence band (`:699`, 0.15 = tightest) is keyed off that false label. | new round |
| **H-9** | 249 orphaned price trails; one doc at 93.2% of the Cosmos ceiling | `user-199fcbc9` = **1,955,529 bytes of 2,097,152**. 16,071 of 24,000 stored points belong to **deleted holdings** (67%). The doc grew during the audit. At the ceiling, every reprice and every holding edit for that user fails. | **new round, near-term** |
| **H-10** | Baseball and hockey have **zero** sport calibration | `GRADE_CALIBRATION_BY_SPORT.baseball` and `.hockey` ship completely empty — the generator's `SPORTS` array omits them. Baseball is 40% of the graded pool. Masked because baseline is ~68% baseball-weighted; hockey silently gets baseball math. | new round |
| **H-11** | Backfill values the whole series against a basket picked from the end date | `marketIndexCompute.service.ts:121` — **64% of every rendered series (116 of 181 points)** is valued on a basket selected using its own future. | new round |
| **H-12** | `freshMembers` is stored but never read back | `marketIndexRead.service.ts:56` drops it from the SELECT. A level computed from 1 member renders identically to one computed from 94. This is why C-1 was invisible. | new round |
| **H-13** | Sell-window header claims machinery it does not use | `sellWindow.service.ts:25` claims the `#1644/#1647` basket. It has **one import** and consumes `playerInSetMomentum` — a clamped median-of-medians. Two doctrine violations: a median as the answer, and a hard clamp. | Drew ruling |

---

### 🟢 Already fixed in-flight — do not re-triage

| Was filed as | Status |
|---|---|
| Grade-arb multiplies one anchor across ~35 tiers, reports fabricated n=5 | **FIXED** by `f8590df` (#1654) before the audit was read. Now gated on `valueSource === "observed"` and `n >= 3`. |
| `recentSales` excludes own comps with no threshold | **REFUTED.** The auditor stopped at the call site. `soldCompsStore.service.ts:2384` applies the identical 3-sample rule. |
| Adjudicated rows (`flaggedWrong`, `excludedFromFmv`) not filtered from the live pool | **FIXED** by `73a4fe2` (#1666) on 09-03. Residual: `qualityFlags` still unfiltered on the unified path. |
| Self-comp thin-pool reprieve measured across the whole card | **FIXED** by `da64088` (#1662) at 08:10 today — now measured per tier. This was the Verlander $96.34-vs-$251 gap. |
| Window cascade ignores the requested tier | **REFUTED.** `unifiedPricing.service.ts:571` does narrow when a tier is requested. |
| Telemetry invisible / swing alarm never fired | **REFUTED.** Both queryable. The alarm fired 2026-09-03T11:05:03Z with a full payload. |

---

## 3. Divergence numbers

**Persisted vs live** — 40 holdings re-driven through `valueIdentity()`:

| Bucket | Count |
|---|---|
| Exact match | 13 (33%) |
| Within 1% | 5 |
| 1–10% | 2 |
| 10–50% | 7 |
| **Over 50%** | **11 (28%)** |
| Live returns null, value stored anyway | 2 |

**Half of all holdings diverge by more than 10%. Rung labels disagree on 19 of 40 (48%).**

Worst cases: Figueroa `$270 → $9.74` (−96.4%) · Aaron Judge `$159.33 → $26.25` (−83.5%) ·
Mike Trout `$940 → $290.50` (−69.1%) · Bobby Witt Jr `$130 → $320` (+146.2%).

**Shadow vs engine:** the nightly invariant auditor re-derives every holding and flags anything
outside 25%. It audits **persisted holdings only** — routes and the two notify jobs (H-1) are
outside its coverage by construction, so the highest-severity live divergence sits in its blind
spot twice over.

**Rung divergence:** `canonicalFmv`'s ladder never consults per-tier data. **71 of 124 cells (57%)
differ by more than 1.5x** from the byTier value the other path uses. Worst: `bowman-chrome` PSA 8
ladder **0.63** vs byTier **1.83** on n=113.

**The rung label is not evidence of freshness.** The two worst stale holdings both carry
*exact-pool* rungs — a gate keyed on `isExactPoolRung` would pass both.

---

## 4. What a collector sees today

**Their hockey index tile reads 4577.46.** Card values are flat-to-down, and the app says the
hockey market is up 4,477%. It is one $65 sale on a $1.42 card.

**Their portfolio total is wrong by more than 10% on half their cards** — and it does not
self-correct, because nothing reprices on a schedule. A card bought in June still shows June's
number in September.

**One card reads $270. The market says $10.10.** They would list it, get no offers, and not
understand why. The only reason it doesn't read $9.74 instead is a safety guard catching it.

**A Pokémon collector's graded cards are undervalued by roughly 2x to 3x** — priced with baseball
math because a capitalization mismatch strands the Pokémon table.

**A $0.22 common and a $13,000 LeBron are the same card** to the engine, if they share a number.

**Half their holdings can't explain where their number came from** — no rung label at all. One
stores $3.49 while its own explanation text says $1,176.

**What is genuinely good:** refusals are honest and typed. Medians label themselves. Observed grade
tiers are never clamped to force monotonicity. Own purchases are kept when they are the only
signal. The dedupe algorithm is empirically swept and removes ~20% duplicate ingest. The four
unified routes really are one path.

---

## 5. Top 5 actions, in order

**1. Stop the hockey index printing 4577.46.** (C-1) Two changes: persist carry-forward across
runs, and refuse to publish a point when `usedWeight` falls below a floor. A wrong number on the
flagship market tile is worse than a missing one. *Same-day.*

**2. Rule on reprice cadence.** (C-2) Every other pricing fix is invisible until something writes
new values on a schedule. The sanctioned lane already exists (`reprice-user-holdings` via the
backfill runner) — it needs a cron and an RU budget. *Drew ruling, then one workflow file.*

**3. Ship the calibration casing fix and the band-distance bound together.** (C-4 + H-6) One
`toLowerCase()` unstrands 47% of the table — and simultaneously activates ~597 more unbounded
adjacent-band rescues. **Shipping C-4 alone makes pricing worse.** Add the test that loads the real
data module; the current suite is 34 green tests over a broken table.

**4. Relieve `user-199fcbc9` before it hits 2 MB.** (H-9) At 93.2% and growing, with 67% of the
bytes belonging to deleted holdings. When it crosses, that user's portfolio stops working entirely.
Reap `priceHistoryByHolding` on delete. *Near-term, mechanical.*

**5. Finish the one-path unification — with the scope corrections this audit found.** Three
additions to the existing PR: the second key-absent legacy writer (C-7, 53 holdings), the two
notify jobs and the HTTP entry point (H-1), and the untruncated identity into rung 4. Then the
split-identity census on the Figueroa class (C-3) and base-identity contamination (C-6).

---

## Method

Six dimensions, each independently audited then re-verified by a second agent working from its own
fresh clone under `C:/tmp` — never the OneDrive checkout. Verification re-read every cited line at
the deployed sha rather than trusting citations, which caught two wrong directory paths, one
inverted mechanism claim, four already-fixed findings, and one CRITICAL the original pass missed.

Live prod Cosmos read-only throughout: connection string piped from `az webapp config appsettings
list` straight into process env, never echoed, never written to disk, every query a SELECT.
Holdings walked as a map, not joined. Pool queries by partition key to avoid cross-partition
fan-out. Where an aggregate over the 8M-row container exceeded runtime budget, existence probes
were substituted and the unverified numbers are marked as such.

Session-gated POSTs were **not** called and no session was forged — persisted-vs-live divergence is
established by driving `valueIdentity()` directly from a built `dist/`, not by hitting the wire.

**No writes, no fixes, no workflow dispatches.**

Prod moved from `8935130` → `a30eeb8` → `4fce24f` during the audit. Every finding above was
re-confirmed against `4fce24f`, the live sha at time of writing.
