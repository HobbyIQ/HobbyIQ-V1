// CF-NO-NULL-PRICING PR 3 (2026-07-11, Drew — Tier 7 wire-up helper).
//
// Called by every "about to emit fmvMechanism='unavailable'" site in
// compiqEstimate.service.ts. If Tier 7 can produce a baseline estimate
// (we can identify year + product, env flag is on, and the setdoc
// lookup succeeds), returns a fully-formed response. Otherwise returns
// null and the caller falls through to its existing unavailable emit.
//
// This DRYs up the 5 unavailable sites — each just needs one line:
//
//   const t7 = await maybeTier7Fallback({ ... });
//   if (t7) { emit + return t7; }
//   // existing unavailable emit + return
//
// See docs/design/no-null-pricing-architecture.md for the full tier
// chain and per-tier confidence.

import { applyGradeToSetDocBaseline } from "./setDocTypeBaseline.js";
import { getSetDocForProductYear } from "../../repositories/setDocLookup.repository.js";

// ─── Public input / output shapes ────────────────────────────────────────

export interface Tier7Input {
  /** Free-form product name from queryContext.product. */
  product: string | null | undefined;
  /** Free-form year from queryContext.cardYear. */
  year: number | null | undefined;
  /**
   * Grade multiplier applied to the era-typed baseline. If null / not
   * provided, defaults to 1 (treat as raw). Caller should pass the same
   * grade-multiplier it uses elsewhere in the pipeline.
   */
  gradeMultiplier?: number | null;
}

export interface Tier7Result {
  /** Structural floor: baseline × grade multiplier. */
  floor: number;
  /** Wide range around the floor (baseline range × grade). */
  range: { low: number; high: number };
  /** The raw era-typed baseline (before grade adjust). */
  baseline: number;
  /** Which era bucket the lookup used. */
  era: string;
  /** Normalized setType key from the SetDoc match. */
  setTypeKey: string;
  /** The SetDoc's display setName for attribution. */
  setName: string;
  /** Manufacturer for attribution. */
  manufacturer: string;
  /** Verdict copy to surface to the user. */
  verdict: string;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Tier 7 fallback — era-typed SetDoc baseline. Never throws.
 *
 * Returns null when:
 *   * env flag COMPIQ_SETDOC_BASELINE_ENABLED is off
 *   * inputs are incomplete (need at least year + product)
 *   * no SetDoc found for (product, year)
 *   * era baseline lookup returns null (pre-1988 or unrecognized setType)
 */
export async function maybeTier7Fallback(
  input: Tier7Input,
): Promise<Tier7Result | null> {
  if (process.env.COMPIQ_SETDOC_BASELINE_ENABLED !== "true") return null;
  if (!input.product || typeof input.product !== "string" || !input.product.trim()) {
    return null;
  }
  if (!input.year || !Number.isFinite(input.year)) return null;

  let setDoc;
  try {
    setDoc = await getSetDocForProductYear(input.product, input.year);
  } catch (err) {
    console.warn(
      `[tier7SetDocFallback] SetDoc lookup failed:`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
  if (!setDoc) return null;

  const graded = applyGradeToSetDocBaseline(
    setDoc.setType,
    input.year,
    input.gradeMultiplier ?? 1,
  );
  if (!graded) return null;

  const verdict = `Era baseline — no comps found for this card. Structural minimum from ${setDoc.setName} × ${graded.era} baseline.`;

  return {
    floor: graded.floor,
    range: graded.floorRange,
    baseline: graded.baseline,
    era: graded.era,
    setTypeKey: graded.setTypeKey,
    setName: setDoc.setName,
    manufacturer: setDoc.manufacturer,
    verdict,
  };
}
