# Backtest Re-Baseline — Deterministic Config + 5 of 7 Signals (2026-05-25 PM)

**Run:** 20260525-225825-deterministic-creds-restored
**Cohort:** v1-seed (N=15 cards × 5 repeats)
**Windows:** prediction-input [now-60d, now-14d) | ground-truth [now-14d, now]
**Total predictions:** 150 (15 cards × 5 repeats × 2 arms)
**Run time:** ~18 min (22:58:57 → 23:16:54 UTC)

## Verdict — `stable_signals_hurt`

**Headline:** The determinism lock collapsed run-to-run variance ~4-5×.
Signal-on now stably loses to signal-off across all 5 runs. **Phase 4c
kickoff is NOT ready** — methodology iteration required to diagnose
which signals contribute negative lift before training a model on
signal-driven inputs.

Harness recommendation: **CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS** — investigate
which signals contribute negatively before any signal-driven model
training.

---

## 1. Configuration

### Signals active (5 of 7)

| Signal | State | Last refresh (per Ohtani aggregated.json @ 22:50 UTC) |
|---|---|---|
| cardhedge | ✅ Working | multiplier=1.085 signal=rising |
| trends | ✅ Working | multiplier=0.9 signal=stable |
| stats | ✅ Working | multiplier=1.051 signal=unknown |
| news | ✅ Working | multiplier=1.15 signal=neutral |
| youtube | ✅ Working (restored today) | multiplier=0.95 signal=softening |
| reddit | ❌ Degraded (deferred by user) | multiplier=1.0 signal=auth_failed |
| ebay | ❌ Degraded (cert renewal pending) | multiplier=1.0 signal=auth_failed |
| odds | ❌ Wrong-provider (key unstaged) | multiplier=1.0 signal=no_api_key |

Note: yesterday's run was **3 of 7 active** (only cardhedge + trends +
news + stats). YouTube restored today via `a6e3143`. Reddit + odds + eBay
remain degraded.

### OpenAI configuration

- Model: `gpt-4o-mini` (Azure OpenAI deployment via compiq-mcp)
- Temperature: **0** (locked via `OPENAI_DETERMINISTIC_CONFIG`)
- Seed: **42** (locked)
- Lock shipped in commit `5a5b1b7`

### Cost

~$0.15 against Azure OpenAI gpt-4o-mini (well under the $0.75 authorization).

---

## 2. Aggregate prediction-vs-outcome metrics

### Per-run aggregates

| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | per-run verdict |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 14 | -2.25 | -9.90 | 0.432767 | 0.0 | insufficient_data |
| 2 | 14 | -2.06 | -8.27 | 0.582919 | -7.14 | insufficient_data |
| 3 | 14 | -9.68 | -13.19 | 0.182315 | -14.29 | insufficient_data |
| 4 | 14 | -1.45 | -3.46 | 0.286003 | -21.43 | insufficient_data |
| 5 | 14 | -3.26 | -12.04 | 0.157939 | -14.29 | insufficient_data |

(Negative MAPE delta = signal-on error WORSE than signal-off.)

### Cross-run stats

| Metric | mean | stdev | sign stability |
|---|---:|---:|---:|
| MAPE delta 72h | **-3.74** | 3.38 | **1.0** |
| MAPE delta 7d | **-9.37** | 3.81 | **1.0** |
| Direction-acc delta | **-11.43** | 8.15 | — |

### Per-card consistency

- **Stable signal-helpers** (signal-on wins ≥70% of runs): **4**
- **Stable signal-hurters** (signal-on wins ≤30% of runs): **9**
- **Mixed/flipping**: 1

**Cards where signals help:**

| Card | win-rate | mean on err% | mean off err% |
|---|---:|---:|---:|
| Aaron Judge 2017 Topps Update US87 raw | 0.8 | 5.03 | 11.02 |
| Cody Bellinger 2017 Topps Update US159 raw | 1.0 | 33.78 | 50.50 |
| Shohei Ohtani 2018 Topps Update US1 PSA 10 | 1.0 | 6.16 | 10.40 |
| Ronald Acuna Jr 2018 Topps Update US250 raw | 1.0 | 4.66 | 12.53 |

**Cards where signals hurt (selected high-impact):**

| Card | win-rate | mean on err% | mean off err% | spread |
|---|---:|---:|---:|---:|
| Juan Soto 2018 Topps Update US300 raw | 0.0 | 203.95 | 106.69 | +97 pp |
| Paul Skenes 2024 Topps Chrome Update USC53 raw | 0.2 | 69.67 | 47.79 | +22 pp |
| Bobby Witt Jr 2022 Topps Chrome Update USC10 raw | 0.0 | 50.38 | 50.38 | 0 pp |
| Mike Trout 2011 Topps Update US175 raw | 0.0 | 13.31 | 0.85 | +12 pp |
| Aaron Judge 2017 Topps Update US87 PSA 10 | 0.0 | 29.37 | 19.58 | +10 pp |
| Caleb Bonemer 2024 Bowman Draft Chrome CPA-CBO raw | 0.0 | 9.35 | 1.87 | +7 pp |

---

## 3. Comparison to yesterday's run

Direct comparison to `20260524-224322-n15-r5/multirun_summary.md` (same
cohort, same N=15×5, default temperature, 3 of 7 signals active):

### Variance reduction (determinism lock effect)

| Metric | Yesterday (default temp) | Today (temp=0 + seed=42) | Improvement |
|---|---:|---:|---:|
| MAPE 72h stdev | 12.50 | **3.38** | **3.7× tighter** |
| MAPE 7d stdev | 20.03 | **3.81** | **5.3× tighter** |
| Dir-acc stdev | 15.69 | **8.15** | 1.9× tighter |
| Sign stability 72h | 0.6 | **1.0** | perfect |
| Sign stability 7d | 0.4 | **1.0** | perfect |

The determinism lock did exactly what `CF-BACKTEST-DETERMINISTIC` was
designed to do. Run-to-run noise collapsed.

### Signal lift (true direction emerged)

| Metric | Yesterday | Today | Interpretation |
|---|---:|---:|---|
| MAPE 72h mean | +6.09 | **-3.74** | Yesterday's positive mean was noise; today's negative mean reflects real signal effect |
| MAPE 7d mean | +4.97 | **-9.37** | Same pattern, larger negative effect at 7d horizon |
| Dir-acc mean | -2.97 | **-11.43** | Direction accuracy also worse with signals on |
| Stable helpers | 0 | 4 | Some real signal value visible per-card |
| Stable hurters | 6 | 9 | More cards genuinely hurt than yesterday's noisy run showed |
| Flipping | 8 | 1 | Almost no remaining run-to-run flips after determinism lock |

**Key insight:** yesterday's `unstable_high_variance` verdict was honest
— the variance was real and dominated the signal. But underneath the
noise, the actual signal effect was **NEGATIVE**, not the slightly-
positive impression the aggregate mean suggested. The determinism lock
revealed this clearly.

### Verdict transition

- Yesterday: `unstable_high_variance` (couldn't measure due to noise)
- Today: `stable_signals_hurt` (measured; result is bad)

This is methodology progress: we moved from "can't tell" to "can tell,
and the answer is concerning."

---

## 4. Recommendations

### Phase 4c kickoff readiness: **NOT READY**

Phase 4c requires training a model on signal-driven inputs. If the
signals consistently push predictions in the wrong direction (today's
finding), then a model trained on those inputs will inherit and amplify
that harm. Training data must be cleaned first — either by removing
harmful signal sources or by establishing which sub-set of signals
actually contribute positive lift.

### Next workstream — CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS (NEW)

Per harness recommendation. Investigate WHICH signals contribute the
harm. Hypotheses to test:

1. **Per-signal ablation:** run backtest with each signal individually
   disabled (e.g., `cardhedge=1.0` forced, all else live; then `trends=
   1.0` forced; etc.). Compare MAPE delta with each signal vs without.
   The signal that, when disabled, MOST IMPROVES the aggregate is the
   most-harmful.
2. **Per-card-segment analysis:** the 4 helpers vs 9 hurters split
   suggests signals work for some card categories and not others. Look
   for patterns:
   - Newer cards (2022, 2024) all in the hurter list — possible signal
     overfitting to high-activity tracked players causes inflated
     predictions for sparse-comp newer cards
   - Same player different grade: Judge raw helps, Judge PSA10 hurts;
     Ohtani PSA10 helps, Ohtani raw hurts; Acuna raw helps, Acuna PSA10
     hurts. The signal effect direction may interact with grade in a
     way the model doesn't capture.
3. **Catastrophic outliers:** Juan Soto raw signal-on 203.95% MAPE vs
   off 106.69%. What did the signal-on prediction produce? Is there a
   single component (e.g., cardhedge contributing 1.085× × something
   else) that compounds into a 2× overshoot?
4. **Aggregator weight tuning:** current weights are designed for "all
   signals roughly equally informative." If 2-3 sources are harmful,
   their 0.45-0.55 combined weight is dragging the others. Weighted
   ablation may surface a viable subset.

### Don't expand cohort yet

Yesterday's CF-PHASE4B-BACKTEST.2 (N=100 expansion) was rejected on
noise grounds. Today's run resolves the noise but reveals a worse
underlying problem. **Expanding to N=100 now would just confirm the
harm at higher statistical power, not fix it.** Diagnose first, then
expand.

### Cohort-quality follow-ups (lower priority but worth noting)

- Bobby Witt Jr raw: signal-on and signal-off produce IDENTICAL errors
  (both 50.38%). Either both arms are converging on the same anchor or
  the prediction-input window is sparse for this card. Worth flagging
  as a cohort-quality data point — what's the underlying anchor?
- Mike Trout 2011 raw: signal-off 0.85% error is suspiciously perfect.
  Either a happy coincidence or the prediction-input median is anchored
  near the ground-truth median.

---

## 5. Open carry-forward items

### New CFs surfaced

- **CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS (HIGH)** — Phase 4c blocker.
  Per-signal ablation + per-card-segment analysis. Estimated 3-5h.
- **CF-ODDS-API-REWORK (MEDIUM)** — surfaced separately during S3;
  blocks odds signal from contributing anything.

### Updated CFs

- **CF-BACKTEST-DETERMINISTIC**: SHIPPED today (`5a5b1b7`). Effect
  empirically confirmed: variance collapse ~4-5×, sign stability 1.0.
- **CF-RESTORE-SIGNAL-CREDS**:
  - YouTube ✅ restored (`a6e3143`)
  - Reddit ⏸ deferred by user
  - Odds ❌ closed as wrong-provider (`3b622e1`)
  - eBay ⏸ pending cert renewal

### Closed items

- CF-BACKTEST-DETERMINISTIC: closed (shipped + verified empirically)
- Yesterday's CF-PHASE4B-BACKTEST.2 (N=100 expansion): superseded by
  CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS (no point expanding while signal
  effect is negative)

---

## 6. Cross-references

- Yesterday's run: [20260524-224322-n15-r5/multirun_summary.md](../20260524-224322-n15-r5/multirun_summary.md)
- Auto-generated harness report: [./report.md](./report.md)
- Determinism lock: commit `5a5b1b7`
- YouTube credential restore: commit `a6e3143`
- Odds closure: commit `3b622e1`
- fn-compiq investigations: [../../fn_compiq_investigations.md](../../fn_compiq_investigations.md)
