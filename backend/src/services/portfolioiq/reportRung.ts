// CF-VALUATION-REPORT (Drew, 2026-09-02): rung → human words, server-side.
//
// The exported report is generated on the server, so it needs the same
// rung→words mapping the web renders in its provenance chip. That mapping
// already exists in apps/web/src/lib/rung.ts, and it is a MIRROR of the
// closed vocabulary in compiq/fmvRung.ts — the web cannot import from
// backend/src and the backend cannot import from apps/web, so a third
// copy would be a third chance to drift.
//
// The drift is handled the way the web handles it: reportRung.test.ts
// reads fmvRung.ts (and this file, and the web's rung.ts) from source and
// fails when the three vocabularies disagree. A rung added to the engine
// without being added here is a red test, not a silent `unknown rung` in
// a document a collector hands to an insurer.
//
// The WORDS are deliberately identical to the web's. A holding described
// as "estimate from the grade curve" in the app must not become "grade
// curve estimate" in the PDF of the same portfolio.

/** Rungs that read the exact (identity, grade) pool, by aggregation. */
export const EXACT_POOL_RUNGS = [
  "exact-pool-projection",
  "exact-pool-last-sale",
  "exact-pool-leading-edge",
  "exact-pool-weighted-median",
  "exact-pool-median",
  "exact-pool-trajectory",
] as const;

/** Every fallback rung any engine can name. */
export const FALLBACK_RUNGS = [
  "cross-grade-fallback",
  "grade-curve-estimate",
  "graded-pool-inverse",
  "player-index-projection",
  "sibling-estimate",
  // canonical-fmv ladder (direct-comp IS the exact pool, so it is absent)
  "cross-parallel",
  "neighbor-parallel",
  "sibling-parallel",
  "hot-raw-same-card-anchor",
  "family-baseline",
  "product-tier",
  "tiered-momentum-card",
  "tiered-momentum-player",
  // hobbyIqFmv ladder (direct-slug IS the exact pool, so it is absent)
  "cross-setkey",
  "cross-printrun",
  "same-printrun-cross-parallel",
  "printrun-discovery",
  "grade-cross-raw",
  "composite-neighbor",
  "rare-card-anchor",
] as const;

export const NO_BASIS_RUNG = "no-basis";

export type RungKind = "observed" | "estimate" | "unpriced" | "unknown";

export interface RungDescription {
  kind: RungKind;
  /** The rung in human words. */
  text: string;
  /** The label exactly as the wire carried it (null when it carried none). */
  label: string | null;
}

const EXACT_POOL_PREFIX = "exact-pool-";

export function isExactPoolRung(label: unknown): boolean {
  return typeof label === "string" && label.startsWith(EXACT_POOL_PREFIX);
}

export function isKnownRung(label: unknown): boolean {
  return (
    typeof label === "string"
    && ((EXACT_POOL_RUNGS as readonly string[]).includes(label)
      || (FALLBACK_RUNGS as readonly string[]).includes(label)
      || label === NO_BASIS_RUNG)
  );
}

function salesPhrase(n: number | null | undefined): string {
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    return `${n} sale${n === 1 ? "" : "s"}`;
  }
  return "sales";
}

/** The words for a label. Identical to apps/web/src/lib/rung.ts. */
export function describeRung(
  label: string | null | undefined,
  opts: { compsUsed?: number | null } = {},
): RungDescription {
  const n = opts.compsUsed ?? null;
  if (label == null || label === "") {
    return { kind: "unknown", text: "rung not reported", label: null };
  }
  switch (label) {
    // ── exact pool: observed ──────────────────────────────────────────────
    case "exact-pool-projection":
      return { kind: "observed", text: `projected from ${salesPhrase(n)} of this card`, label };
    case "exact-pool-last-sale":
      return { kind: "observed", text: "from the last sale of this card, trend-adjusted", label };
    case "exact-pool-leading-edge":
      return { kind: "observed", text: `from the newest of ${salesPhrase(n)} of this card`, label };
    case "exact-pool-weighted-median":
      return { kind: "observed", text: `from ${salesPhrase(n)} of this card (thin pool)`, label };
    case "exact-pool-median":
      return { kind: "observed", text: `from ${salesPhrase(n)} of this card (median)`, label };
    case "exact-pool-trajectory":
      return { kind: "observed", text: `from ${salesPhrase(n)} of this card, carried by player momentum`, label };
    // ── fallbacks: estimates ──────────────────────────────────────────────
    case "cross-grade-fallback":
      return { kind: "estimate", text: "estimate from another grade of this card", label };
    case "grade-curve-estimate":
      return { kind: "estimate", text: "estimate from the grade curve", label };
    case "graded-pool-inverse":
      return { kind: "estimate", text: "estimate from this card's own graded sales", label };
    case "player-index-projection":
      return {
        kind: "estimate",
        text: "estimate from this card's last sale x the player's market trend",
        label,
      };
    case "sibling-estimate":
      return { kind: "estimate", text: "estimate from a sibling card x parallel premium", label };
    case "cross-parallel":
    case "neighbor-parallel":
    case "sibling-parallel":
    case "same-printrun-cross-parallel":
      return { kind: "estimate", text: "estimate from sibling parallels", label };
    case "cross-setkey":
      return { kind: "estimate", text: "estimate from this card in a sister product", label };
    case "cross-printrun":
      return { kind: "estimate", text: "estimate from this card at other print runs", label };
    case "printrun-discovery":
      return { kind: "estimate", text: "estimate from this card's dominant print run", label };
    case "family-baseline":
      return { kind: "estimate", text: "estimate from the card family", label };
    case "hot-raw-same-card-anchor":
      return { kind: "estimate", text: "estimate from this card's raw sales", label };
    case "grade-cross-raw":
      return { kind: "estimate", text: "estimate from raw sales x a grade multiplier", label };
    case "composite-neighbor":
      return { kind: "estimate", text: "estimate from composite neighbors", label };
    case "rare-card-anchor":
      return { kind: "estimate", text: "estimate from this card's last sale, drift-adjusted", label };
    case "product-tier":
      return { kind: "estimate", text: "estimate from the product tier", label };
    case "tiered-momentum-card":
      return { kind: "estimate", text: "estimate from card momentum", label };
    case "tiered-momentum-player":
      return { kind: "estimate", text: "estimate from player momentum", label };
    // ── declined ──────────────────────────────────────────────────────────
    case NO_BASIS_RUNG:
      return { kind: "unpriced", text: "no price basis", label };
    default:
      return { kind: "unknown", text: `unknown rung "${label}"`, label };
  }
}
