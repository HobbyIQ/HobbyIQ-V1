// ---------------------------------------------------------------------------
// Tier Multipliers — Issue #25 Phase 3
//
// Owner-curated lookup table that maps `tierWithinSet` (the primary scarcity
// input on parallel_attributes — see backend/docs/parallels-reference-schema.md
// §6.3 and §2.3) to a scalar value-vs-base multiplier used by the
// tier-anchored predicted-range fallback (predictedRangeTierAnchored.ts).
//
// The table is intentionally fixed and source-controlled:
//   • Values were derived by the owner from observed Bowman Chrome family
//     market data (2024 Bowman Chrome Baseball, 2024 Bowman Draft Chrome,
//     etc.) and locked alongside the Phase 3 prompt 2026-05-17.
//   • The engine does NOT auto-derive these from print-run ratios. The
//     decoupling is intentional and permanent (see schema §2.3.5).
//   • Any change to these values is a Phase 4 design decision and requires
//     a `schemaVersion` bump on dependent collections.
//
// Tiering convention (matches schema §6):
//   T1  = Base / unnumbered Refractor (set's anchor parallel)
//   T2  = Refractor (unnumbered or large-run colored)
//   T3  = Mid-scarcity numbered color parallels (e.g., /250–/499)
//   T4  = Notable colored parallels (e.g., Blue /150)
//   T5  = High-scarcity colored parallels (e.g., Aqua /99, Purple /75)
//   T6  = Premium colored parallels (e.g., Gold /50)
//   T7  = Top-tier rarity (e.g., Red /5, Orange /25)
//   T8  = 1/1 / SuperFractor
//
// These are MULTIPLIERS over the implied tier-1 baseline, not absolute prices.
// ---------------------------------------------------------------------------

/**
 * Owner-curated tier → multiplier table. Keys are positive integers ≥ 1;
 * values are scalars ≥ 1.0. Tier 1 is the unit anchor (1.0) by definition.
 *
 * Exposed as a const map so tests can assert exact values and downstream
 * tooling (UI debug panels, admin scripts) can render them.
 */
export const TIER_MULTIPLIERS: Readonly<Record<number, number>> = Object.freeze({
  1: 1.0,
  2: 1.5,
  3: 2.5,
  4: 4.0,
  5: 7.0,
  6: 12.0,
  7: 25.0,
  8: 80.0,
});

/**
 * Resolve a `tierWithinSet` value to its multiplier.
 *
 * Returns `null` for any input that is not a positive integer present in
 * `TIER_MULTIPLIERS`. Callers MUST treat `null` as "no multiplier available"
 * and fall through to a non-tier-anchored code path; this function never
 * throws.
 *
 * Contract:
 *   tierMultiplier(1)    === 1.0
 *   tierMultiplier(8)    === 80.0
 *   tierMultiplier(0)    === null
 *   tierMultiplier(9)    === null     // out of curated range
 *   tierMultiplier(null) === null
 *   tierMultiplier(NaN)  === null
 *   tierMultiplier(2.5)  === null     // non-integer
 */
export function tierMultiplier(tier: number | null | undefined): number | null {
  if (tier === null || tier === undefined) return null;
  if (typeof tier !== "number") return null;
  if (!Number.isFinite(tier)) return null;
  if (!Number.isInteger(tier)) return null;
  if (tier < 1) return null;
  const m = TIER_MULTIPLIERS[tier];
  return typeof m === "number" ? m : null;
}

/**
 * Highest tier currently defined in the table. Useful for diagnostics and
 * for callers that want to surface "unknown tier" warnings when curators
 * record a value beyond the curated ceiling.
 */
export const MAX_DEFINED_TIER: number = Math.max(
  ...Object.keys(TIER_MULTIPLIERS).map((k) => Number(k)),
);
