Open question surfaced during issue #9 investigation. When `fetched.comps.length === 0` and `effectiveIsAuto` is true with a variant-warning token, the engine returns `source="variant-mismatch"`. When `fetched.comps.length === 0` on the pinned path (`body.cardHedgeCardId` set, parser skipped), the engine returns `source="no-recent-comps"`. Both outcomes are functionally identical (null FMV, zero comps) but use different labels.

For harness/observability/UX consistency, consider: when `fetched.comps.length === 0` AND `body.cardHedgeCardId` is present (i.e., pinned-path identity is authoritative), prefer `source="no-recent-comps"` over `source="variant-mismatch"` since variant ambiguity is impossible when comps were fetched by exact card_id.

This is purely cosmetic and labeling — no behavior change. Defer until after issue #6 is fixed, since variant-mismatch emissions should be rarer post-fix.

Tracked separately from #9 because it's a cleanup item, not a correctness bug.
