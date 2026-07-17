# Drew's Action Items — Index

Single source of truth for everything currently blocked on Drew's personal action. Each item links to its full runbook; this page is the "what do I need to do?" surface.

**Last updated:** 2026-07-17 (session close)
**Convention:** items get struck through + moved to the archive when closed.

## Blocking iOS launch

None. Every P0 backend gap the iOS session flagged is closed on the wire; iOS shipped every P0/P1 item per the git log (`7ac466b`, `6adff99`, `904e81f`, `eedc3dc`, `f0130fc`, `c7df351`, `36bc792`, `8f039c2`, `c7df351`).

## Push notifications (unblocks verdict-flip alerts)

- **[ ] Provision the APNs `.p8` auth key** in the Apple Developer console.
- **[ ] Set 4 App Service settings** (`APNS_AUTH_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`) via `az`.
- **[ ] Say the word** — I un-stub the send call in `backend/scripts/verdict-flip-push-fanout.cjs`.

Full runbook: [`apns-provisioning.md`](./apns-provisioning.md). Est. effort: ~30 min for the Apple key + `az` mutation; ~5 min of engineering on the un-stub afterward.

## Real-time delta-poll (deferred pending CH support)

- **[ ] Email CH support** asking what `client_id` value HobbyIQ should use for `/cards/subscribe-price-updates`. Tried `drew@justtheboysandcards.com` and `HobbyIQ` — both surface `"CardHedge API returned 400"` from their inner tracking service. Ask them: what's the actual provisioned client_id, or is delta-poll not enabled on our tier?
- **[ ] When they respond**: set `CARD_HEDGE_CLIENT_ID=<value>` + `CH_DELTA_POLL_ENABLED=true` in HobbyIQ3 App Service. I re-run the back-catalog subscribe migration.

Notes:
- CH is deprecating this endpoint; their own docs recommend `/cards/watchlist-updates` for new integrations.
- PR #502 (daily-bulk ingest) already covers every day-scoped use case, so delta-poll is nice-to-have real-time, not necessary.
- If CH support says "use watchlist-updates", we retire the delta-poll code entirely and build against the new endpoint. That's a follow-up PR.

## Data-collection tasks (small effort, unlocks features)

### CH Black Label title-preservation probe

- **[ ] Run the CH probe** to check whether CH preserves "Black Label" / "Pristine" / "BL" text in sale titles. Answers whether the ingest path safely captures the sub-tier at CH's edge, or whether we need CH-side taxonomy escalation.

Full runbook: [`../investigations/ch-black-label-title-probe-runbook.md`](../investigations/ch-black-label-title-probe-runbook.md). Est. effort: **~2 minutes**. Env-guarded PowerShell/bash forms + interpretation thresholds included.

### BGS / SGC / CGC slab-scan validation

- **[ ] Scan every non-PSA slab you own once** under default iOS lighting, log to CSV per the protocol.
- **[ ] Aggregate per grader**: match rate at ≥0.7 confidence, false-positive count at ≥0.8.

Per-grader ship gate: ≥85% match at ≥0.7 conf AND zero false-positives at ≥0.8 conf. Graders clearing the gate unlock silent-navigate on scan; graders below stay in the "Verify grade" confirmation fallback (already shipped, no code change needed either way).

Full runbook: [`../investigations/slab-scan-validation-protocol.md`](../investigations/slab-scan-validation-protocol.md). Est. effort: **~10-15 min per grader** depending on slab count.

## PR triage backlog

Both are engine-fix PRs from before the current session; may already be superseded by later work.

- **[ ] PR #275** — trend-adjust stale grade comps by player momentum (12+ days stale as of 2026-07-16). Possibly superseded by PR #234 matched-cohort or later trendIQ work. Skim to decide merge/close.
- **[ ] PR #238** — base-auto mercy fallback for Jared Jones catalog-miss (16+ days stale). Possibly handled by the Cardsight-fallback revival (PR #452) or the CardHedge structured bridge (PR #466). Same.

Est. effort: ~5 min per PR to decide.

## Infrastructure follow-ups (not personal, but you're the decider)

- **[ ] Tier 1 harness GitHub Secret** — one-time write of `TIER1_HARNESS_SESSION_ID` turns the chronic-red harness green. Full runbook: [`./tier1-harness-session.md`](./tier1-harness-session.md). Est. effort: ~5 min.
- **[ ] KQL calibration refresh job** — the grader-premium table drifts over time as the graded market moves; runbook scaffolds the monthly App Insights → table refresh flow, but the timer trigger isn't deployed. Wait until we see actual drift (>60 days post-launch) before building. Full runbook: [`./grader-premium-calibration-refresh.md`](./grader-premium-calibration-refresh.md).

## Future architecture projects (parked, not urgent)

Items we've explicitly acknowledged as real work that we're intentionally deferring. Kept here so a future session doesn't rediscover them and treat them as blockers.

- **[ ] CH ingest data normalization (Phase 6+)** — `ch_daily_sales` is well-organized for the pricing use case (partition by `card_id`, sub-100ms comp reads) but under-organized for cross-cutting analytics.

  **The gap:**
  - No global secondary indexes → cross-partition queries (e.g. "all PSA 10 sales in the last week") are expensive scans.
  - No normalization → `Mike Trout` is a string on every row, no canonical `player_id`. Case/spacing inconsistencies split the same player across buckets.
  - `variant` is free-text (`"Base"`, `"Refractor"`, `"Gold /50"`) — not enum.
  - `card_set` and `card_set_type` overlap inconsistently.
  - No pre-computed rollups → "top movers this week" needs a full scan.

  **What "normalized" would look like:**
  - Dedicated `ch_cards` container — one row per unique `card_id` with canonical player/set/variant/year fields.
  - Dedicated `ch_players` container — one row per canonical player, back-referencing card_ids.
  - Pre-computed rollup containers for top-N queries (players by volume, cards by 7d move, sets by activity).

  **When to actually build:**
  - After Phase 1-5 of the attribution-quality pipeline lands.
  - Before shipping product features that need cross-cutting analytics (top movers surface, trending players signal, per-player alerts across all their cards).
  - **Not blocked on anything today.** Ship the current work first.

  **Est. effort:** 1-2 weeks of real engineering. Design doc first, then phased migration to keep the pricing hot-path uninterrupted.

## Archive (closed)

*(none yet — items move here when done, so we don't lose the history of what shipped)*
