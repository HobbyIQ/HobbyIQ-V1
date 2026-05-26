# CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — Investigation Findings

**Date:** 2026-05-25 PM (continued into evening for Phase 1-4 execution)
**Workstream type:** Diagnostic investigation. No code changes shipped from
this workstream (recommendations only).
**Status:** Phase 1 (ablation), Phase 2 (segment analysis), Phase 3
(hypotheses), Phase 4 (recommendations) sequential — committed
incrementally per phase.

**Why this exists:** S4 backtest (`567d55c`) returned verdict
`stable_signals_hurt` — the signal pipeline consistently makes
predictions worse than no-signal baseline. Three downstream workstreams
are blocked behind understanding *why*: CF-EBAY-LISTING-SIGNAL-REWORK
implementation, CF-ODDS-API-REWORK methodology decision, and Phase 4c
ML training kickoff. This doc establishes the empirical grounding for
those next decisions.

---

## 1. Baseline understanding (S4 read-through)

### S4 run artifacts

- **Run dir:** `docs/phase0/backtest_runs/20260525-225825-deterministic-creds-restored/`
- **Multi-run summary:** `multirun_summary.md` (verdict + per-run +
  per-card tables)
- **Per-run JSON:** `run_{1..5}/results.json` (full prediction-level
  records: input window, ground-truth window, per-card predictions
  both arms, signal payload used in on-arm)
- **Aggregate JSON:** `results.json` (cross-run summary)

### S4 backtest methodology

- **Cohort:** `v1-seed`, 15 cards
- **Repeats:** 5
- **Window split:** prediction-input `[now-60d, now-14d)` /
  ground-truth `[now-14d, now]` — disjoint, prediction-input can't
  contain ground-truth comps by construction
- **Deterministic config:** `OPENAI_DETERMINISTIC_CONFIG` (`temperature=0`,
  `seed=42`) per CF-BACKTEST-DETERMINISTIC (commit `5a5b1b7`)
- **OpenAI deployment:** `gpt-4o-mini` via compiq-mcp's Azure OpenAI
- **Signal-on arm:** live `fetchSignals(player)` payload, passed as
  `signalsOverride`
- **Signal-off arm:** `NEUTRAL_SIGNAL` constant (multiplier=1.0, no
  flags)
- **Metric:** MAPE delta = `mape_signal_on - mape_signal_off` (negative
  = signal-on worse than signal-off)

### Headline numbers

| Metric | Mean (across 5 runs) | Stdev | Sign stability |
| --- | ---: | ---: | ---: |
| MAPE delta 72h | **-3.74** | 3.38 | 1.0 |
| MAPE delta 7d | **-9.37** | 3.81 | 1.0 |
| Direction-acc delta | **-11.43** | 8.15 | — |

Sign-stability 1.0 → determinism lock from CF-BACKTEST-DETERMINISTIC
collapsed the variance that masked the negative signal effect in
yesterday's pre-lock run (where MAPE 7d mean was +4.97, but with
sign-stability 0.4 — i.e., noise).

### 4-helper vs 9-hurter detail

From `results.json` `per_card_consistency` (15 cards minus 1 with
no_actuals = 14 scored):

**4 stable helpers** (signal-on wins ≥70% of runs):

| Card | win-rate | mean on err% | mean off err% | improvement |
| --- | ---: | ---: | ---: | ---: |
| Aaron Judge 2017 Topps Update US87 raw | 0.80 | 5.03 | 11.02 | -5.99 pp ✅ |
| Cody Bellinger 2017 Topps Update US159 raw | 1.00 | 33.78 | 50.50 | -16.72 pp ✅ |
| Shohei Ohtani 2018 Topps Update US1 PSA 10 | 1.00 | 6.16 | 10.40 | -4.24 pp ✅ |
| Ronald Acuna Jr 2018 Topps Update US250 raw | 1.00 | 4.66 | 12.53 | -7.87 pp ✅ |

**9 stable hurters** (signal-on wins ≤30% of runs):

| Card | win-rate | mean on err% | mean off err% | regression |
| --- | ---: | ---: | ---: | ---: |
| Mike Trout 2011 Topps Update US175 raw | 0.00 | 13.31 | 0.85 | +12.46 pp ❌ |
| Aaron Judge 2017 Topps Update US87 PSA 10 | 0.00 | 29.37 | 19.58 | +9.79 pp ❌ |
| Shohei Ohtani 2018 Topps Update US1 raw | 0.00 | 22.51 | 8.29 | +14.22 pp ❌ |
| Ronald Acuna Jr 2018 Topps Update US250 PSA 10 | 0.20 | 46.15 | 46.15 | 0.0 pp (tied) |
| Juan Soto 2018 Topps Update US300 raw | 0.00 | **203.95** | 106.69 | +97.26 pp ❌❌ |
| Bobby Witt Jr 2022 Topps Chrome Update USC10 raw | 0.00 | 50.38 | 50.38 | 0.0 pp (tied) |
| Paul Skenes 2024 Topps Chrome Update USC53 raw | 0.20 | 69.67 | 47.79 | +21.88 pp ❌ |
| Paul Skenes 2024 Topps Chrome Update USC53 PSA 10 | 0.00 | 13.51 | 8.11 | +5.40 pp ❌ |
| Caleb Bonemer 2024 Bowman Draft Chrome CPA-CBO raw | 0.00 | 9.35 | 1.87 | +7.48 pp ❌ |

**1 mixed/flipping** (Mike Trout 2011 PSA 10, win-rate 0.60).
**1 no_actuals** (Gleyber Torres 2018 raw — skipped from cohort
scoring; ground-truth window had no comps).

### Preliminary segment patterns visible in the cohort

| Segment | Cards | Helpers | Hurters | Mixed/no-data |
| --- | --- | ---: | ---: | ---: |
| **Year 2011** | Trout raw, Trout PSA10 | 0 | 1 | 1 mixed |
| **Year 2017** | Judge raw, Judge PSA10, Bellinger raw | 2 | 1 | 0 |
| **Year 2018** | Ohtani raw, Ohtani PSA10, Acuna raw, Acuna PSA10, Soto raw, Torres raw | 2 | 3 | 1 no-data |
| **Year 2022** | Witt raw | 0 | 1 (tied) | 0 |
| **Year 2024** | Skenes raw, Skenes PSA10, Bonemer raw | 0 | 3 | 0 |
| **Set: Topps Update** | 11 cards | 4 | 5 | 2 |
| **Set: Topps Chrome Update** | 3 cards | 0 | 3 | 0 |
| **Set: Bowman Draft Chrome** | 1 card | 0 | 1 | 0 |
| **Grade: raw** | 9 cards (excl. no-data) | 3 | 6 | 0 |
| **Grade: PSA 10** | 5 cards | 1 | 3 | 1 mixed |

**First-pass observations (to be validated in Phase 2):**

- **Year/recency pattern strong.** 0/4 cards from 2022+ help; 4/9
  cards pre-2020 help. Suggests signals add noise for newer (sparser-
  comp?) cards.
- **Brand/set pattern overlaps with year.** All Chrome-family cards
  (Topps Chrome Update + Bowman Draft Chrome) hurt; only Topps Update
  has any helpers. May be confounded with year.
- **Grade pattern weak directionally.** Both grades show majority-hurt,
  but PSA 10 has a slightly less-bad helper:hurter ratio (1:3) than
  raw (3:6). Not a clean signal.
- **Single catastrophic outlier:** Juan Soto 2018 raw at +97.26 pp
  regression. Signal-on prediction is nearly 2× worse than signal-off.
  Drags aggregate MAPE meaningfully — investigate what the signal-on
  arm produced for this card (Phase 2 will pull from per-run JSON).

### What this section CONFIRMS

- The S4 verdict is real, not a one-off noise event. 5 of 5 runs
  agree in sign on MAPE delta 7d (sign-stability 1.0). The harm is
  consistent.
- 9 cards stably hurt across all 5 runs; 4 stably help. Not just
  noise around break-even.
- Newer-cards-hurt-more pattern is visible at cohort level and
  warrants per-segment depth analysis (Phase 2).

### What this section DOES NOT establish

- *Which* signals contribute the harm (Phase 1 ablation answers).
- *Why* newer cards consistently hurt (Phase 2 segment analysis +
  Phase 3 hypotheses).
- Whether the harm comes from signal content, signal blending, or
  prompt-design (Phase 3 hypotheses + recommendation).

---

## 2. Per-signal ablation (Phase 1)

### Ablation methodology

For each of 6 signal sources (`compsMomentum`, `stats`, `news`, `trends`,
`reddit`, `youtube`), ran a N=15 × 5-repeat backtest with the source
neutralized:

- Set `components[source] = 1.0`
- Strip flags emitted by that source (`isFlagFromSource` filter in
  harness — covers compsMomentum_*, player_slump, milestone:*,
  negative_news, injury_risk, search_spike, reddit_buzz,
  ebay_demand_high, bin_dropping:*, low_sell_through:*,
  award_contender, youtube_*)
- Recompute `final_multiplier` under aggregator's WEIGHTS contract +
  show/pack/playoff/career_arc overlays
- Clamp to [0.70, 1.50]

Harness modification: added `--ablate-signal X` CLI flag and the
`ablateSignalPayload` helper to `mcp-server/scripts/backtest_signal_value.ts`.
See commit attached to this Phase 1 close.

### Three channels of attribution — what ablation measures and misses

| Channel | What ablation measures | Captured? |
| --- | --- | --- |
| **Channel 1** — multiplier math | Per-source weight contribution to `final_multiplier` | ✅ Yes |
| **Channel 2** — source-tied flag narrative | Per-source flag removal from prompt (e.g., `injury_risk` when news ablated) | ✅ Yes |
| **Channel 3** — overlay narrative | `show_phase`, `release_phase`, `playoff_*`, `career_arc_*` pass-through fields | ❌ No — these persist across all ablations |

**Channel 3 caveat is load-bearing.** Overlay fields appear in the LLM
prompt for every ablation variant. They cannot be isolated by current
methodology. Phase 4 recommendations defer overlay-attribution to a
separate workstream (CF-PHASE4B-CHANNEL3-ATTRIBUTION).

### v1 results (drift-confounded, qualitative only)

Six ablations ran sequentially over ~14 hours across two day-boundaries:

| # | Signal | Run start UTC | mape7d | sign-stab | verdict |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | compsMomentum | 2026-05-26 00:05 | -1.28 | 0.6 | unstable_high_variance |
| 2 | stats | 2026-05-26 00:23 | -9.52 | 1.0 | stable_signals_hurt |
| 3 | news | 2026-05-26 00:41 | -12.78 | 1.0 | stable_signals_hurt |
| 4 | trends | 2026-05-26 01:42 | -0.39 | 0.4 | unstable_high_variance |
| 5 | reddit | 2026-05-26 02:01 | -2.60 | 1.0 | stable_signals_hurt |
| 6 | youtube | 2026-05-26 12:21 | -21.36 | 1.0 | stable_signals_hurt |

S4 baseline reference (run 2026-05-25 22:58 UTC): mape7d = -9.37.

### The drift-floor finding

The reddit ablation is empirical evidence of methodology drift between
S4 baseline (22:58 UTC May 25) and the ablation runs (00:05 UTC May 26
onwards). Reddit was at multiplier=1.0 / signal=`auth_failed` across
every player in the cohort throughout the test window, so ablating
reddit was a TRUE input-level no-op (component already 1.0; no
reddit_buzz flags ever emitted to strip). Yet reddit's mape7d came in
at **-2.60 vs S4 baseline -9.37 — a +6.77 pp shift purely from drift**.

Three concurrent drift factors identified by comparing same-card
records between S4 baseline and reddit-ablation:

1. **Wall-clock advanced ~3h** between S4 and the first ablations;
   `days_to_show` in the `pre_show` overlay decremented from 12 to 11
2. **CF-CARDHEDGE-SIGNAL-RENAME deployed mid-arc** (commit `33a6800`):
   flag string `cardhedge_comps_rising` renamed to `compsMomentum_rising`
   in the signal_flags array; blob path changed from `{slug}/cardhedge.json`
   to `{slug}/compsMomentum.json`
3. **compsMomentum multiplier drift**: Ohtani's value moved 1.085 → 1.194
   (~10%) between S4 and reddit-ablation runs (separate aggregator
   cycles updated the underlying comps)

**Empirical drift floor: ~2.6 mape units over ~3 hours**, or roughly
~0.87 pp/hour if drift accumulates linearly. The youtube v1 run at
12:21 UTC was 13.5 hours after S4 baseline — at ~0.87 pp/hour that's
~11.7 pp of drift baked into the -21.36 result, leaving an inferred
~9-10 pp of actual youtube-ablation effect. **But "drift is linear" is
an unverified assumption** — drift could be event-driven (aggregator
cycles, manual triggers, blob refreshes) rather than time-linear.

### What v1 can and can't tell us

**Can:**

- News at 7d is a robust net-positive signal (-12.78 with sign-stab 1.0
  is far from drift floor; conclusion holds under linear drift assumption)
- Stats at 7d is at or near baseline (effectively inert); difference
  from baseline is within drift-floor range
- Reddit at 7d is genuinely no-op at input level (the -2.60 IS the drift
  floor; reddit signal has nothing to ablate today)
- The ablation infrastructure works end-to-end (5 of 6 completed; 1
  bug in `ABLATION_WEIGHTS` validation caught + fixed)

**Cannot:**

- Distinguish compsMomentum effect (-1.28 vs S4 baseline = +8.09 vs
  baseline, but drift floor is +6.77 over 3h → actual compsMomentum
  effect ~+1.32 pp at most) from drift noise. Inconclusive.
- Distinguish trends effect (-0.39 vs S4 = +8.98) from drift +
  unmeasured cascade-tier signal mechanics. Inconclusive.
- Provide clean per-signal ranking for Phase 4 retirement decisions.

### Drift-floor classification (the cleanest reading of v1)

The drift-floor finding above (~2.6 mape units / ~3h) provides a
threshold for distinguishing real signal effects from drift noise. The
ablation `|mape7d|` value tells us how far the ablated arm sits from
the no-signal arm:

**Exceeds drift floor → interpretable directly:**

| Signal | mape7d | abs(val) / drift floor | Interpretation |
| --- | ---: | ---: | --- |
| news | -12.78 | **4.9×** | Likely **net-positive** signal. Ablating news leaves the arm 12.78 pp worse than no-signal — i.e., news was helping. |
| stats | -9.52 | **3.6×** | Likely **inert**. Ablating stats leaves the arm ~baseline (-9.37) — stats was contributing nothing. |
| youtube | -21.36 | **8.2×** | Confounded by 13.5h of drift accumulation between S4 baseline and the run. Inconclusive — likely net-positive but magnitude unknown. |

**Within drift floor → attribution unclear, requires clean-methodology re-run:**

| Signal | mape7d | abs(val) / drift floor | Interpretation |
| --- | ---: | ---: | --- |
| compsMomentum | -1.28 | 0.49× | Ablated arm is closer to no-signal than the drift noise. Could mean compsMomentum was a major harm source (and ablating fixed it) OR could mean drift carried baseline forward. Inconclusive. |
| trends | -0.39 | 0.15× | Same logic. Inconclusive. |
| reddit | -2.60 | 1.0× | True input-level no-op (reddit was 1.0 / auth_failed throughout). The -2.60 IS the drift floor — empirical reference, not signal effect. |

### v2 attempt — snapshot methodology blocked

Attempted clean re-run with a frozen signal-state fixture
(`SIGNALS_FIXTURE_DIR=C:\tmp\phase4b_v2_signal_fixture` snapshotting
all 10 tracked-player `aggregated.json` blobs at 12:31 UTC May 26).
Harness extended with snapshot-mode read path (env var gated; no
change to production paths). Fixture verified populated correctly.

**v2 baseline + v2 compsMomentum both TIMED OUT at the 30-min
threshold** despite being identical workloads to v1. The v1 ablations
completed in 17-19 min each; v2 fixture-mode runs took >30 min each.

### Step 2 lightweight slowdown investigation (10-15 min, no fix attempt)

Captured for the follow-up CF, not used to attempt a fix this session:

**a. Azure OpenAI metrics (inconclusive)** — `rg-hobbyiq-dev` contains
4 cognitive-services accounts (`aoai-hobbyiq-prod`, `aoai-hobbyiq-dev`,
`hobbyiq-openai`, `hobbyiq-dev`). Visible deployments on `aoai-hobbyiq-
dev` (`gpt-oss-120b`, `text-embedding-3-small`) don't include
`gpt-4o-mini`; `aoai-hobbyiq-prod` deployment list came back empty
under our credentials. Couldn't enumerate the gpt-4o-mini deployment
in the 10-15 min budget to query rate-limit metrics directly.
ClientErrors metric returned no data — inconclusive for the
rate-limit-theory.

**b. Payload comparison (suggestive)** — fixture-mode signal payloads
at 12:31 UTC snapshot time have **significantly more signal_flags per
player** than v1-era live-mode payloads:

| Flag pattern | v1 baseline era (22:58 UTC May 25) | Fixture snapshot era (12:31 UTC May 26) |
| --- | --- | --- |
| `injury_risk` | ~all players | 10/10 |
| `pre_show: ...` | all players | 10/10 |
| `compsMomentum_rising/falling` | rare (e.g. Ohtani had `cardhedge_comps_rising`) | 7/10 (`falling` 3, `rising` 4) |
| `youtube_rising/fading` | absent | 5/10 (`rising` 2, `fading` 3) |
| `search_spike` | absent | 4/10 |
| Total flags per Ohtani payload | 3 | 3 |
| Total flags per Witt payload | 0 visible | 5 |

Plausible mechanism for slowdown: more flag content per prompt →
longer LLM response chains explaining each flag → +3-5s/call → +8-13
min over 150 calls per backtest run. Not definitively confirmed.

**c. Fixture content sanity (clean)** — all 10 fixture files are
well-formed JSON matching expected aggregator output shape. Values
in reasonable ranges (compsMomentum 0.85-1.20, multipliers stable,
overlay fields present). No structural anomalies. The
slowdown isn't a fixture corruption issue.

**Two leading hypotheses captured** (neither tested or fixed this
session):
1. Azure OpenAI TPM rate-limiting accumulated across the day
2. Increased flag density at snapshot time → longer prompts/responses
   → higher per-call latency

### v2 abandoned this session

Rather than burn remaining authorized budget on continued timeouts
under unknown root cause, v2 methodology **deferred to follow-up CF**.

**NEW CF: CF-PHASE4B-CLEAN-ATTRIBUTION-RERUN (HIGH, ~3-4h)**

Required before any retirement/reweight decisions on within-drift-floor
signals (compsMomentum, trends, reddit). Scope:

- Capacity-check Azure OpenAI quotas/limits before launch (rate-limit
  headers; deployment-level TPM cap)
- Wait for natural quota reset window OR provision a fresh deployment
- Longer per-ablation timeout (60+ min) to absorb residual slowdown
- Use the snapshot-based fixture methodology (already implemented in
  harness, env-gated)
- If payload-bloat hypothesis confirmed, consider trimming flag
  emission at aggregator level before fixture snapshot, OR adjusting
  prompt template to limit per-flag LLM reasoning depth
- Multi-day staggering acceptable if single-session quota exhaustion
  is confirmed root cause

### Implications captured here for Phase 3 / Phase 4

- **Cascade-class signal classification (per memory):** attention-class
  signals (trends, reddit, youtube) have 3-10 week lag profiles to
  price; 7d backtest measures inside that lag. v1 results for these
  signals are not interpretable as "signal failure" — they're
  horizon-mismatch artifacts. See [project-information-cascade-signal-
  model](../../../../../memory/...) and Section 4.
- **News at 7d net-positive holds.** This is the cleanest v1 finding
  that survives drift caveat. News is the only confirmed in-horizon
  contributor in the current portfolio.
- **compsMomentum harm at 7d is inconclusive from v1 alone.** Drift
  noise dominates the signal. The cohort-segment analysis in Section
  3 + the Soto outlier finding suggest the LLM's *narrative reaction*
  to flags (not the multiplier math) is part of the harm vector
  regardless of compsMomentum's specific contribution.
- **Per-signal retirement decisions deferred.** Phase 4 will frame
  recommendations around methodology fixes (not retirement) given v1
  insufficient evidence + cascade-class horizon mismatch + Channel 3
  attribution gap.

---

## 3. Per-card-segment analysis (Phase 2)

### Segment analysis methodology

Used existing S4 per-run JSON artifacts (no new runs). For each card,
cross-referenced cohort metadata (year / set / grade / player) with
S4 per-card consistency metrics (`mean_pct_error_on_7d`,
`mean_pct_error_off_7d`, `signal_on_wins_7d_rate`,
`stable_arm_winner_7d`) and the input→actual direction derived from
`inputMedian` and `actualMedian`.

Direction classifier uses the same threshold as the harness
(`inferActualDirection`): >5% rising, <-5% falling, otherwise stable.

### Input→actual direction by card

| Card | inputMed | actualMed | %Δ | direction | helper/hurter |
| --- | ---: | ---: | ---: | --- | --- |
| Trout 2011 raw | 350 | 353 | +0.9% | stable | hurter |
| Trout 2011 PSA10 | 1249.99 | 1199 | -4.1% | stable | mixed |
| Judge 2017 raw | 37 | 39.99 | +8.1% | rising | **helper** ✓ |
| Judge 2017 PSA10 | 225 | 286 | +27.1% | rising | hurter |
| Bellinger 2017 raw | 3.6 | 2.99 | -16.9% | falling | **helper** ✓ |
| Ohtani 2018 raw | 139.99 | 147.75 | +5.5% | rising | hurter |
| Ohtani 2018 PSA10 | 463 | 471 | +1.7% | stable | **helper** ✓ |
| Acuna 2018 raw | 6.50 | 8.92 | +37.2% | rising | **helper** ✓ |
| Acuna 2018 PSA10 | 46 | 44.48 | -3.3% | stable | hurter (tied) |
| Soto 2018 raw | 7.26 | 6.58 | -9.4% | falling | hurter (+97 pp) |
| Torres 2018 raw | 3.12 | null | — | no_data | skipped |
| Witt 2022 raw | 12 | 11.97 | -0.3% | stable | hurter (tied) |
| Skenes 2024 raw | 22.5 | 18.27 | -18.8% | falling | hurter |
| Skenes 2024 PSA10 | 185 | 185 | 0% | stable | hurter |
| Bonemer 2024 raw | 65 | 107.01 | +64.6% | rising | hurter (large under-shoot) |

### Segment 1 — by release year

| Year bucket | n | Helpers | Hurters | Mean delta (pp) | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 2011 | 2 | 0 | 1 + 1 mixed | +5.0 | Trout: signal-on predicted up, both moves were stable |
| 2017 | 3 | 2 | 1 | -4.3 | Best-performing year. 2/3 helpers. |
| 2018 | 6 (5 scored) | 2 | 3 + 1 no-data | +19.9 (Soto-dominated) | Without Soto: +0.5 (~neutral) |
| 2022 | 1 | 0 | 1 (tied) | 0.0 | Single card — Witt no-effect |
| 2024 | 3 | 0 | 3 | +11.6 | **All 2024 cards hurt** |

**Pattern: newer cards stably hurt. 4/9 pre-2020 cards helped; 0/4
post-2020 cards helped.** The 2022 single-card tie + the 3/3 hurt 2024
cards form a consistent "newer = worse" pattern, though small N.

### Segment 2 — by brand/set family

| Set family | n | Helpers | Hurters | Mean delta (pp) |
| --- | ---: | ---: | ---: | ---: |
| Topps Update (paper, non-Chrome) | 10 (9 scored) | 4 | 5 | +0.5 (excl Soto: -9.2) |
| Topps Chrome Update | 3 | 0 | 3 (1 tied) | +9.1 |
| Bowman Draft Chrome | 1 | 0 | 1 | +7.5 |

**Pattern: All 4 Chrome-family cards hurt. All helpers are Topps
Update (paper).** This is the strongest single-segment signal in the
cohort: the Chrome subset is uniformly bad for signal-on.

**Confound:** Chrome family in this cohort is entirely 2022+ (Witt,
Skenes×2, Bonemer). Can't distinguish "Chrome-specific harm" from
"newer-card harm" with the current cohort. Both segments perfectly
correlate.

### Segment 3 — by grade

| Grade | n scored | Helpers | Hurters | Mean delta (pp) |
| --- | ---: | ---: | ---: | ---: |
| raw | 9 | 3 | 6 | +13.6 (excl Soto: +3.2) |
| PSA 10 | 5 | 1 | 3 + 1 mixed | +1.7 |

**Pattern: raw cards hurt more on aggregate, but driven by Soto outlier.
Excluding Soto, both grades are roughly neutral but slightly bad.**

### Segment 4 — by player tier (rookies/prospects vs established)

| Tier | n scored | Helpers | Hurters | Mean delta (pp) |
| --- | ---: | ---: | ---: | ---: |
| Established stars (Trout, Judge, Ohtani, Acuna, Bellinger, Soto) | 10 | 4 | 5 + 1 mixed | +9.6 (Soto-dominated) |
| Rookies/Prospects (Witt, Skenes, Bonemer) | 4 | 0 | 4 | +8.7 |

**Pattern: rookies/prospects uniformly hurt. Established stars are
mixed (4 help, 5 hurt + Trout mixed).** Without Soto, established stars
delta = -0.8 pp (neutral).

### Segment 5 — by input→actual direction

| Actual direction | n scored | Helpers | Hurters |
| --- | ---: | ---: | ---: |
| Rising (>5%) | 5 | 2 (Judge raw, Acuna raw) | 3 (Judge PSA10, Ohtani raw, Bonemer) |
| Falling (<-5%) | 3 | 1 (Bellinger raw) | 2 (Soto raw, Skenes raw) |
| Stable (±5%) | 6 | 1 (Ohtani PSA10) | 5 (Trout raw, Acuna PSA10, Witt raw, Skenes PSA10, Trout PSA10 mixed) |

**Pattern: signals don't systematically push in one direction.** If
they did, falling cards would be uniformly hurt (predicted up, actual
down) — only partially true (2/3 fell hurt). The strongest "hurt"
segment is **stable actuals**: 5/6 stable cards hurt. Signals push
the prediction off-center on cards whose actuals didn't move.

### Catastrophic outlier — Juan Soto 2018 raw

`pct_error_on_7d = 203.95%` vs `pct_error_off_7d = 82.37%`. Largest
single-card regression in the cohort.

**Diagnostic from per-run JSON:**

- Card: $7-range player base RC (low-value card)
- Input median: $7.26; actual median: $6.58 (falling -9.4%)
- Signal-on prediction: 72h=$18.57, 7d=$20 — **predicted ~3× the actual**
- Signal-off prediction: 72h=$15, 7d=$12 — also wrong but closer
- **`final_multiplier`: 1.006 (essentially neutral)** — signal-on
  multiplier itself isn't pushing the price up

The harm is NOT from the multiplier (1.006 is neutral). It's from the
LLM reading `signal_flags = ["injury_risk", "pre_show: ..."]` in the
prompt and reasoning: *"injury risk + pre-show catalyst = bullish
sentiment"*. Off-arm sees no flags and produces a smaller (still wrong)
prediction without the flag-driven amplification.

Signal-on key_drivers reflect this: *"Recent sales volatility indicates
potential for price increase"*, *"Upcoming Chicagoland Sports Card Expo
could boost demand"*, *"Current market signals show stable interest
despite recent injury risk"* — all flag-derived reasoning.

**Crucial finding: the LLM may be reacting to descriptive flag content
even when the underlying multiplier is neutral.** Flags create an
upward narrative bias that disconnects from the actual multiplier math.

### Helper exemplar — Ronald Acuna Jr 2018 raw

For contrast, the strongest helper:

- Card: $7 player base RC
- Input median: $6.50; actual median: $8.92 (rising +37%)
- Signal-on prediction: 72h=$7, 7d=$8.5 — close to actual
- Signal-off prediction: would have been more neutral around input
- Same `pre_show` + `injury_risk` flags as Soto
- final_multiplier: 1.037 (slight bullish)

Both Soto and Acuna had `pre_show` and `injury_risk` flags. Both got
bullish signal-on predictions. **Acuna's actual rose, Soto's fell.**
The flags create a bullish bias that helps cards which rise and hurts
cards which don't. In a cohort with mixed directions, this averages
to negative net effect because the bias amplifies error symmetrically:
when wrong on direction, you're wrong by MORE.

### Confound summary

The clean signals from the cohort:

1. **All Chrome-family cards hurt.** Strong evidence; small N (4).
2. **All 2024 cards hurt.** Strong evidence; small N (3).
3. **All rookies/prospects hurt.** Strong evidence; small N (4).
4. **Stable-actual cards mostly hurt** (5/6). Strongest "shape" pattern.

The above are **perfectly correlated** within this cohort — every
Chrome card is also a rookie's recent card, every 2024 card is Chrome,
every rookie/prospect except Bellinger is post-2020. Can't disentangle
without an expanded cohort that decouples these axes.

**For Phase 3 hypothesis generation: treat (Chrome-family, 2024,
rookies/prospects, stable-actuals) as one entangled segment until a
larger cohort can decouple them.**

### Sub-finding: stable-actual cards are where signals hurt MOST

| Card | direction | helper/hurter | mean on err% | mean off err% |
| --- | --- | --- | ---: | ---: |
| Trout raw 2011 | stable | hurter | 13.31 | 0.85 |
| Acuna PSA10 2018 | stable | tied-hurter | 46.15 | 46.15 |
| Witt raw 2022 | stable | tied-hurter | 50.38 | 50.38 |
| Skenes PSA10 2024 | stable | hurter | 13.51 | 8.11 |
| Ohtani PSA10 2018 | stable | helper | 6.16 | 10.40 |
| Trout PSA10 2011 | stable | mixed | 12.59 | 15.06 |

5 of 6 stable-actual cards hurt or tied. Signal-off baseline for stable
actuals is to predict roughly input-median ± small adjustment (which is
correct, since actuals didn't move). Signal-on adds flag-driven bias
that pushes predictions off the correct neutral. This is the cleanest
single-pattern finding: **signals harm stability detection.**

### What Phase 2 establishes

1. Newer/Chrome/prospect cards consistently hurt (entangled segment).
2. Signal-on's harm magnitude correlates with how far the signal-driven
   prediction deviates from a "do nothing" baseline. On stable actuals,
   any deviation = error.
3. The Juan Soto outlier shows the LLM responding to FLAG CONTENT, not
   just multiplier value. This is significant: ablating the multiplier
   while keeping flags may not cleanly attribute harm.
4. Both helpers and hurters often see the same flags (`injury_risk`,
   `pre_show`). The flags' helpfulness depends on whether the actual
   moves in the direction the flags imply.

### What Phase 2 does NOT establish

- Which specific flag is the culprit (Phase 1 ablation isolates by
  source signal; ablation drops flags + multiplier together so will
  reveal source-level harm but not flag-vs-multiplier attribution).
- Whether signal-flag prompt content is the harm vector vs the
  multiplier blending math (Phase 3 hypothesis territory).
