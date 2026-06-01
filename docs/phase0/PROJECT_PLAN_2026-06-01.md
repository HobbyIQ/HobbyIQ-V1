# Project plan — 2026-06-01

Three parallel tracks. Each has explicit gates; nothing speculative runs past an unmet gate. Ratified 2026-06-01 with four amendments to the chat draft, captured inline below.

This plan is the operational layer ON TOP of [`HOBBYIQ_ROADMAP_2026Q2_Q3.md`](../HOBBYIQ_ROADMAP_2026Q2_Q3.md). The roadmap describes phases; this plan describes execution sequencing across them. Where the roadmap's original timing has been overtaken by reality, this plan reflects reality.

## Background — what this plan reconciles with

Roadmap Phase 0 / 1 / 2 / 3 are all complete or structurally folded. The original "silent prediction regression" (roadmap Problem #1) is **VERIFIED RESOLVED 2026-06-01**: warn `primary_mode_cardhedge_namespace_only` count is 0 over both 7d and 30d windows; warn-emit code is grep-zero in `backend/src/`; killed by [CF-CARDHEDGE-HARD-CUTOVER `10ad39d` (2026-05-29)](../../backend/src/services/compiq/cardsight.router.ts#L313-L336) + the antecedent CF-PRICE-BY-ID-MIGRATION (`5640084`). No mapper work needed.

Phases 4a-4e (MCP cache → signal → ML training → serving → moat) are NOT-STARTED. Phase 5 (Pricing × Portfolio) is PARTIAL — movement signals + predictedPrice persistence shipped; cross-card recommendations not. Phase 6 (PR E reconciliation UX) backend is partial; iOS is blocked on Mac sessions. Phase 6.5 (iOS end-to-end product finalization) was parked at `bd0c790` (2026-06-01).

A large body of work landed this session that the original roadmap did not anticipate: CF-PREDICTION-CORPUS arc, CF-CORPUS-ACCURACY-INSTRUMENT, CF-RESOLVER-COVERAGE-GAP, CF-DEPLOY-STAMP-HARDENING, CF-PORTFOLIO-HOLDING-IDENTITY arc. These were structurally required prereqs for Phase 4c (training data) + Phase 5 (resolver) + Phase 6 (clean P&L).

---

## Track 1 — eBay vertical (highest user-facing impact; Drew-paced)

**Why first:** four queued CF directives sit blocked on the same gate; the structural P&L inflation bug shipping to first users is the largest landmine in the current code; closing this unblocks the Phase 6 iOS surface.

| # | Action | Gate / owner |
|---|---|---|
| **1.1** | Drew checks eBay developer console (Step 1 of EBAY-LOOP-VERIFICATION runbook). Confirms production keyset subscription state for `ITEM_SOLD` topic, destination URL, verification token. | Drew, manual |
| **1.2** | If `ITEM_SOLD` not subscribed: Drew subscribes. (Agent does NOT touch console.) | Drew, gated |
| **1.3** | **Real production small-dollar sale.** List a fully-identified holding at $1-3 with real ship-or-pickup. Wait for a genuine cheap real-buyer sale rather than self-buying through a controlled second account. **AMENDMENT (ratified 2026-06-01):** self-buy via a second account is against eBay policy and risks the production seller account that the entire integration depends on. Accept the async slip — the real loop verification is worth waiting for. Capture the raw envelope from `webhook_events` when the sale lands. | Drew, async (days–weeks) |
| **1.4** | **EBAY-FINANCES-SLICE-A:** entitlement check → append `sell.finances` to `REQUIRED_SCOPES` (1-line code change) → deploy (first real exercise of `zip.js` hardening AND the [0/5] build-info pre-check together) → re-consent test account (path B — one-off disconnect) → pull `/sell/finances/v1/transaction?filter=orderId:{real id}` → save raw response → **diff against design's mapping → produce corrected mapping table**. | Agent, after 1.3 |
| **1.5** | **EBAY-FINANCES-SLICE-B:** Finances client (uses corrected mapping) + server-only `applyFinancesEnrichment` helper + on-demand `POST /api/portfolio/ledger/:id/reconcile-from-ebay` route + tests + prove on real order (before/after of the real ledger row). | Agent, after 1.4 |
| **1.6** | **EBAY-FINANCES-SLICE-C:** scheduled sweep (6h cadence; constant-tunable; skip payout fetch for sales <24h old) + observability log + dry-run + tests. | Agent, after 1.5 |
| **1.7** | **iOS Phase 6 reconciliation rendering** (Mac-session gated): render real fees, real `needsReconciliation` state, real P&L on the test account's ledger entry. | Drew Mac-side |
| **1.8** | **Phase 6.5 finalization run:** single device end-to-end — add holding → list → sell → reconcile (auto sweep OR on-demand button) → ledger reflects real fees → P&L renders correctly. Capture: demo recording + raw ITEM_SOLD envelope + raw Finances response + ledger before/after. This is the launch-readiness signature. | Drew + agent, after 1.7 |

**Track 1 success criterion:** the demo recording + 4 captured artifacts in `docs/phase0/`. Until 1.8 completes, the loop is theoretical.

---

## Track 2 — Phase 4a MCP cache layer (engineering parallel; runs while Drew completes 1.1-1.3)

**Why parallel:** doesn't depend on the eBay arc; doesn't depend on accuracy windows; addresses Risk #2 (Cardsight outage = full prediction outage today). Original roadmap timing (Jun 19-Jul 2) — startable now since Phase 3 prereqs landed two weeks ago.

**AMENDMENT (ratified 2026-06-01):** if starting Phase 4a now, **start at 2.1 (the in-process-vs-service decision HALT)**, not at 2.2 implementation. The decision changes downstream scope materially and is the right first gate. Note the solo-Drew context-switch risk: Track 1's manual critical path (1.1-1.3) and Track 2's engineering work compete for the same human; aggressive 2.2 build-out before 1.3 lands could starve the eBay arc of attention exactly when the buyer-arrival window opens.

| # | Action |
|---|---|
| **2.1** | **HALT — decide MCP-as-separate-service vs in-process cache layer.** Lean per roadmap §129: in-process unless a usable MCP repo emerges. Surface the decision-tree explicitly: latency budget impact, deployment surface impact, telemetry-design implications, rollback path. Halt for sign-off before any build. |
| **2.2** | Build the cache layer (decision from 2.1). TTL + invalidation + fallback-to-direct-Cardsight on miss + structured cache-hit telemetry (resolves Phase 1 carry-over per §62: add `cache_hit: boolean` to `comp_logs` schema rather than moving the writer). |
| **2.3** | Soak test: confirm p95 prediction latency drops > 50% vs Day-10 baseline (Phase 4a success criterion §139). |
| **2.4** | Sign off Phase 4a complete. Decision point for Phase 4b kickoff (signal integration) lands naturally after this. |

**Track 2 success criterion:** p95 latency > 50% drop + clean cache-hit telemetry. Risk #2 mitigation lands.

---

## Track 3 — Accuracy validation (passive; date-gated)

**Why now:** the instrument shipped this session (`c23b3ae`). Cost is one `python` invocation per window. Output is the first measured prediction accuracy number — load-bearing for whether Phase 4c (ML training) is worth starting on schedule.

| # | Action | Gate |
|---|---|---|
| **3.1** | **2026-06-07** (first 7d windows close): re-run `docs/phase0/accuracy_analysis.py` against the live corpus + ledger. Capture: per-source MAPE, 3-class hit-rate, 3×3 confusion, coverage. Expect low N (few sales in first week). | Date |
| **3.2** | **2026-06-30** (first 30d windows close + ~1 month of corpus): re-run instrument. Compare against §4.5 minimum-N criteria (1000 matched pairs portfolio-wide; 100 per-segment). | Date |
| **3.3** | **Decision point — 2026-06-30 — COMMIT-OR-SLIP for the mid-September moat target.** **AMENDMENT (ratified 2026-06-01):** this is the explicit commit-or-slip date for the moat target, not an open-ended assessment. Three branches: (a) data sufficient → commit to mid-Sep, start Phase 4c on the original Jul 10-23 schedule; (b) sufficient for prototype but not production → commit but extend Phase 4c with explicit decision gate per roadmap §169 (mid-Sep at risk); (c) insufficient → SLIP explicitly to mid-October or later, document the slip rationale, prioritize Phase 4b (signal integration) + traffic-growth or backfill-source planning. **The decision IS the output; agent will not let this date pass silently.** | Date |

**Track 3 success criterion:** decision point landed by Jun 30 with explicit branch chosen.

---

## Cross-track sequencing

```
Today (2026-06-01)
├─ Track 2.1 starts (Phase 4a decision HALT — Drew + agent, BEFORE building)
├─ Track 1.1 awaits Drew's eBay console check
└─ Track 3.1 awaits Jun 7
       │
2026-06-07 ─ Track 3.1 (first 7d accuracy run, passive)
       │
[Track 1.3 lands whenever the real buyer purchases — async, days to ~weeks]
       │
[Track 1.4-1.6 run agent-side immediately after 1.3 — ~1-2 days of CFs]
       │
2026-06-30 ─ Track 3.2 (first 30d accuracy run) + Track 3.3 COMMIT-OR-SLIP decision
       │
[Track 2 ideally completes by ~mid-Jun; Phase 4b can follow]
       │
[Track 1.7 + 1.8 require Drew Mac session — gated]
       │
Phase 4b → 4c → 4d → 4e arc continues per roadmap, slippage trigger if 3.3 = (c)
```

**Critical-path item:** Track 1.3 (the real ITEM_SOLD ledger row). This single event unblocks 4 queued CFs + Phase 6 iOS + Phase 6.5 finalization. Track 2 runs to keep engineering moving while this lands.

---

## What this plan does NOT include (and why)

| Item | Reason |
|---|---|
| Phase 4b signal integration | Sequenced after Phase 4a — no parallel start because the blender needs the cache layer to be the canonical Cardsight access path |
| Phase 4d ML serving | Sequenced after Phase 4c — depends on a trained model. Won't be discussed until Track 3.3 decision lands. |
| Phase 4e ML moat | Same as 4d. Risk register flagged this as stretch target. |
| Orphan-purge apply (the 2-doc Justin Herbert delete + 14 UUID cruft) | Inert; the safety net skips them; recovery cost ~zero; not blocking anything |
| Phase 1 silent prediction regression — mapper / cardhedge-namespace → Cardsight resolution | **VERIFIED RESOLVED 2026-06-01** (warn 0/7d & 0/30d; warn-emit code removed; killed by 10ad39d + 5640084). Building the originally-planned mapper today would be solving a problem that no longer exists. |
| Phase 5 cross-card recommendations | Phase 6 + Phase 6.5 absorb the user-facing iOS work; cross-card recs can land after the vertical proves |
| CF-PREDICTION-CORPUS-JOINABLE-DROP (queue item from earlier session) | Cleanup of `joinable` shim now that `routedFromHolding` is first-class. Low risk, low value. Park. |

---

## Risk register updates (against roadmap §269)

- **Risk #9 (Phase 4c data accumulation rate):** Track 3.3 is the explicit commit-or-slip decision gate, **dated 2026-06-30**. Agent will not silently miss the deadline. Plan trips into 4-week branch if data insufficient at that date.
- **Risk #6 (iOS workstream stalls if solo):** Track 2 amendment explicitly recognizes the solo-Drew context-switch risk against Track 1's manual critical path. Track 2 stays at 2.1 HALT (lightweight decision) rather than full 2.2 build until 1.3 status is clearer.
- **NEW risk (this session) — eBay manual-gate slippage:** Track 1.3 has a manual dependency that no engineering velocity can compress. If the real-buyer sale slips past 2-3 weeks, Phase 6.5 (launch-readiness signature) slips proportionally. Mitigation per amendment: do NOT self-buy via second account (eBay policy violation + production seller account risk); accept the async slip.

---

## Mid-September moat target — honest assessment

Held nominally per original roadmap §6: *"Mid-September 2026 (ML moat realized — stretch, contingent on Phase 4c data sufficiency)"*.

**AMENDMENT (ratified 2026-06-01):** the mid-September target stays on the books, but the **2026-06-30 Track 3.3 decision is the EXPLICIT commit-or-slip date**. Three discrete outcomes:

- **Branch (a) — COMMIT to mid-Sep.** Data sufficient at Jun 30; Phase 4c starts on the original Jul 10-23 schedule; moat target intact.
- **Branch (b) — COMMIT with elevated risk.** Data sufficient for prototype but not production-scale; Phase 4c extends with internal decision gate per roadmap §169; mid-Sep moat at risk; will land or slip 2-3 weeks late.
- **Branch (c) — SLIP explicitly.** Data insufficient; mid-Sep moat retired in favor of mid-October or later; rationale documented in the handoff; Phase 4b signal integration takes priority in the meantime.

This plan keeps the target alive by:
1. Starting Track 2 at 2.1 NOW (Phase 4a decision HALT — recovers some of the Jun 19-Jul 2 implementation slippage that would otherwise compound)
2. Track 3 hard-gating the Phase 4c kickoff on Jun 30 (no silent overrun)
3. Track 1 runs Drew-paced and async; does not consume the Phase 4 engineering critical path

Better to commit to one of the three branches at Jun 30 than to drift.
