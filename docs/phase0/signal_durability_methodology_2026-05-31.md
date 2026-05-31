# HobbyIQ Signal-Durability & Forward-Pricing Methodology

**Drafted:** 2026-05-31
**Status:** Design methodology — forward/signal layer, NOT yet implemented. Canonical reference for when the predictive layer is built. All parameters are SEED PRIORS pending corpus calibration: starting points to be replaced by fitted values, not measured truth.
**Owner:** Drew
**Related:** docs/phase0/prediction_credibility_methodology_2026-05-30.md (accuracy measurement); CF-PREDICTION-CORPUS-EMISSION-COVERAGE and CF-PREDICTION-CORPUS-CALL-CONTEXT (the corpus that recalibrates these constants)

## 1. Purpose
Defines how HobbyIQ converts (a) a player's overall card-market trend and (b) discrete catalysts (performance, social/news, odds, injuries) into a forward price adjustment, such that durable signals move price and persist while transient spurts produce small, fast-decaying bumps. This is the predictive layer sitting between comp-based fair-market value and the surfaced predictedPrice. Canonical; parameters are seed priors recalibrated by the corpus.

## 2. Foundation — the factor model
A specific card is the bottom of a hierarchy; its movement is driven by the player's market plus its own residual:

    expectedMove(card) = beta(card) * playerTrend + alpha(card)
    predictedPrice     = fairMarketValue * (1 + expectedMove * horizonScaling)

- playerTrend: the player's whole-market direction over the horizon, built as a composition-controlled index (repeat-sales / same-card percent change, volume-weighted), NOT a naive average of the period's sales (which is dominated by sales mix, not appreciation).
- beta(card): the card's sensitivity to playerTrend. Defaults by parallel/grade tier when own-data is thin (chase parallels high-beta, base low-beta); estimated from the card's repeat sales when data exists.
- alpha(card): card-specific drift not explained by the player; shrinks to 0 as own-data thins.
- Shrinkage: trust own beta/alpha in proportion to own-sale volume; otherwise lean on tier-default beta and playerTrend.

Degrades gracefully: a thin card with zero usable comps still gets a real, trend-driven prediction via tierBeta * playerTrend.

## 3. Durability — the decaying-impulse mechanism
Each signal event is an impulse that bumps the forward expectation and decays:

    forwardBump(t) = magnitude * exp(-t / tau)

- magnitude: initial size of the push.
- tau: decay half-life. THIS IS DURABILITY. Small tau = fades in days (spurt); large tau = persists for weeks (regime).
- Total price impact ~= magnitude * tau, so a transient signal is capped in cumulative effect even when its headline pop is large.

Self-correction: sustained catalysts re-inject impulses and raise cross-timescale consistency, growing the bump and lengthening tau (spurt -> trend). A one-off decays away (mean-reverts). The system catches a confirmed surge without chasing every spurt.

## 4. Durability inputs
What sets tau for a given event:
1. Cross-timescale consistency — is the 30-day window elevated too, or only the 2-day? (slow-window confirmation = durable)
2. Baseline consistency / surprise — the MORE an event exceeds the player's established level, the LESS durable (extreme short-term performance regresses to true talent). In line with an elite baseline = durable; surprising off a low baseline = transient.
3. Cross-source corroboration — stats + social + odds + news agreeing = durable; social-only = hype.
4. Catalyst type — structural/forward-looking (contract, role change, milestone chase, return-to-health) = durable; single-series performance = transient.
5. Player / archetype reversion history — jumpy markets revert fast; sticky markets hold.

## 5. Archetype taxonomy — seed parameters
Per archetype: tau0 (baseline half-life, days), kappa (signal gain — approx percent forward move per unit fully-corroborated signal on a beta=1 card), s (surprise-trust, 0-1 — how much an above-baseline surprise is believed vs regressed).

| Archetype | tau0 (days) | kappa (gain) | s (surprise-trust) | Dominant signal / behavior |
|---|---|---|---|---|
| Established legend / inner-circle | 50 | 0.30 | 0.20 | Health/availability, milestones; sticky, surprises regressed |
| Elite young breakout, confirmed | 30 | 0.60 | 0.45 | Sustained performance vs a high floor; cold starts ignored |
| Streaky / chronic whipsaw | 8 | 0.70 | 0.35 | Anchor on multi-year baseline; surface streaks decay fast |
| Star in a down-year / question-mark | 6 | 0.45 | 0.20 | Require slow-window confirmation; structural bear overhang |
| Rookie / no-baseline hype | 4 | 1.00 | 0.85 | Social/news + cohort borrowing; most signal-driven |
| Retired / nostalgia | 75 | 0.20 | 0.05 (perf) | Hobby sentiment/anniversaries; performance-insensitive |

Archetype assignment is itself a modeling choice; players transition (a confirmed breakout graduates from rookie-hype to elite-young; an aging star drifts to legend or to question-mark). Reassess on a cadence.

## 6. Composition
    bump0(pct)     = kappa * rawSignal * corroboration * [ s + (1 - s) * baselineConsistency ] * beta(card)
    tau_eff        = tau0 * confirmationMult
    forwardMove(t) = bump0 * exp(-t / tau_eff) - injuryDiscount(t)

- rawSignal: normalized event strength (0-1); a grand slam > a single.
- corroboration: channel-agreement multiplier — 1 channel x0.5-0.7, 3-4 aligned x1.0-1.2.
- baselineConsistency (0-1): how in line the event is with the player's established level. The bracket -> 1 when consistent (believe it regardless of archetype); -> s when surprising off a weak base (only high-s archetypes react). This term is why Tatis's bomb stays small and Kurtz's streak goes large.
- confirmationMult: x1 if only the short window is elevated; x~1.8 if the 30-day window is also elevated (promotes spurt -> trend).
- beta(card): from section 2; amplifies on chase parallels, damps on base.

## 7. Injury overlay
A negative impulse layered on the player's archetype. Discount on a beta=1 card, before beta amplification:

| Severity | Discount (beta=1) |
|---|---|
| Day-to-day | -2 to -4% |
| Minor IL (Grade 1, ~2-3 wk) | -6 to -10% |
| Multi-week / significant | -12 to -20% |
| Season-ending / structural (ACL, TJ) | -25 to -40% + permanent tau extension |

Position-wear multiplier: pitcher x1.5, catcher x1.3, position player x1.0.

Asymmetry (critical): applied immediately on the news; held FLAT while out (no self-decay); on return, decays out over ~14-21 days ONLY if production resumes (a return-to-form signal cancels it). A cold return sustains or deepens it. Never auto-restore the pre-injury level — wait for confirmation, same logic as a down-year hitter.

## 8. Bounds and safety
- The forwardMove output must respect the existing combined-multiplier cap from the signal-blend rule (confirm the current value against code; the roadmap referenced approximately 0.70-1.50). This durability layer governs how each signal is trusted and decays; it sits on top of the signal-weight blend, not in place of it.
- Surprise-discount floor: tau_eff and the bracket are bounded below so a signal can never be zeroed entirely (partial > none).
- Hard guards: no $0 or absurd-high predictions; bounded-range enforcement; per-signal fallback to neutral on read failure.

## 9. Calibration (the moat)
Seed priors are replaced by fitted values from the corpus (prediction vs actual sale):
- Per archetype, measure realized decay of signal-driven bumps -> fit tau0.
- Measure realized price response per unit signal -> fit kappa.
- Measure how often above-baseline surprises persisted vs regressed -> fit s.
- "tau too long" = chased noise (predicted continuation that reverted); "tau too short" = under-reacted to a real move.
- Dependencies: this calibration REQUIRES CF-PREDICTION-CORPUS-EMISSION-COVERAGE (the down-year and streaky archetypes live disproportionately in the fallback paths the corpus does not yet capture) and CF-PREDICTION-CORPUS-CALL-CONTEXT (provenance to stratify). Until both land, calibration is limited to the happy-path subset.
- Accuracy framing per prediction_credibility_methodology: surfaced-price MAPE across all rows, and forward-direction hit-rate on the forward-prediction subset.

## 10. Worked examples (illustrative, seed params)
- Tatis (down-year, s=0.20, tau0=6): a drought-ending 451-ft bomb is a big rawSignal but low baselineConsistency -> bracket ~= 0.20 -> small bump; structural-bear narrative caps the upside -> roughly +1-2% on a beta=1 card, fading within a week unless the 30-day window confirms. Does not chase the bomb.
- Kurtz (elite-young, tau0=30, kappa=0.60, s=0.45): a 48-game on-base streak -> baselineConsistency ~= 1, high corroboration, 30-day elevated -> tau_eff ~= 50 -> large durable bump (roughly +10-15% on a beta=1 card, amplified on chase parallels); the streak ending barely dents it.
- Baldwin (elite-young + injury overlay): Grade 1 oblique (-6 to -10%) x 1.3 catcher ~= -10%; held flat while out; conditional recovery on resumed form. A pause, not a reversal.
- Ben Rice (elite-young baseline, streaky surface): an April spike and a May slump both decay toward a strong underlying baseline; neither moves the level much; the model rides the re-surge without whipsawing.

## 11. Non-claims and honest limits
- These parameters are PRIORS, not measured; the doc's value is the structure, not the specific constants.
- Mean-reversion is the dominant failure mode; the decay mechanism and surprise discount control it, they do not eliminate it.
- The forward edge comes from signals leading sales; playerTrend alone is trailing. Full-market trend fixes data sparsity and gives a measured trend; the signals provide the lookahead.
- Thin-player markets have an index noise floor below which playerTrend is untrustworthy; fall back to a wider cohort or suppress the forward bump.
- Archetype assignment is a modeling choice and a source of error; mis-bucketing a genuine regime change as a spurt (or vice versa) is a real risk.

## 12. Status and evolution
Design methodology for the forward/signal layer; not yet implemented. Canonical. Updates committed as diffs to this file. When the layer is built, link the implementing CF here. When the corpus recalibrates a parameter, update the table with the fitted value and date.

End of methodology.
