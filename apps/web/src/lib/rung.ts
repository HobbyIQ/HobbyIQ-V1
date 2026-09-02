// D20 — the web says what the engine says (2026-08-30).
//
// Mirror of the CLOSED rung vocabulary in
// backend/src/services/compiq/fmvRung.ts. Every price the backend serves
// carries the name of the RUNG that produced it — which pool the number
// came from, and how it was read. D16/D17 put that name on every route
// (`rungLabel`, price-by-id's `source`, each grade-curve entry's
// `rungLabel`) and on the persisted holding (`pricingSourceMeta.method`,
// `method.ladderRung`). Until D20 the web typed those fields and rendered
// none of them, so a legacy-engine or sibling number looked exactly like
// an observed one.
//
// This module turns a label into human words. It is pure (no DOM, no
// fetch) so it can be pinned by vitest. Rules:
//   - `exact-pool-*` rungs read the exact (identity, grade) pool: OBSERVED.
//   - every other named rung is a fallback — a neighbouring parallel, a
//     family baseline, another grade, a model: an ESTIMATE, and it says so.
//   - `no-basis` is the engine declining to price: UNPRICED.
//   - a label we do not know is NEVER hidden — it renders as
//     `unknown rung "<label>"`; a missing label renders as "rung not
//     reported". A consumer with no label does not get to assume the best
//     case (fmvRung.ts's isExactPoolRung rule).
//
// Adding a rung means adding it in fmvRung.ts first, then here.

/** Rungs that read the exact (identity, grade) pool, by aggregation. */
export const EXACT_POOL_RUNGS = [
  "exact-pool-projection",
  "exact-pool-last-sale",
  "exact-pool-leading-edge",
  "exact-pool-weighted-median",
  "exact-pool-median",
  "exact-pool-trajectory",
] as const;

/** Every fallback rung any engine can name (fmvRung.ts FmvRungLabel minus
 *  the exact-pool rungs and `no-basis`). */
export const FALLBACK_RUNGS = [
  "cross-grade-fallback",
  "grade-curve-estimate",
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

export type ExactPoolRungLabel = (typeof EXACT_POOL_RUNGS)[number];
export type FallbackRungLabel = (typeof FALLBACK_RUNGS)[number];
export type KnownRungLabel = ExactPoolRungLabel | FallbackRungLabel | typeof NO_BASIS_RUNG;

export type RungKind = "observed" | "estimate" | "unpriced" | "unknown";

export interface RungDescription {
  kind: RungKind;
  /** The rung in human words: "from 5 sales of this card",
   *  "estimate from sibling parallels", "estimate from the grade curve". */
  text: string;
  /** The label exactly as the wire carried it (null when it carried none). */
  label: string | null;
}

const EXACT_POOL_PREFIX = "exact-pool-";

/** True iff the label names a rung that read the exact (identity, grade)
 *  pool. Unknown / missing labels are NOT exact-pool. */
export function isExactPoolRung(label: unknown): label is ExactPoolRungLabel {
  return typeof label === "string" && label.startsWith(EXACT_POOL_PREFIX);
}

export function isKnownRung(label: unknown): label is KnownRungLabel {
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

/** The words for a label. `compsUsed` is the size of the pool the rung
 *  read (the tier's pool, not the whole curve's) and only decorates the
 *  exact-pool phrases — a fallback rung's pool is another card's. */
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

// ─── The persisted holding ──────────────────────────────────────────────

/** The fields of a holding the provenance read touches. Structural so the
 *  helper stays pure and the test fixtures stay small. */
export interface HoldingProvenanceSource {
  fmvRung?: string | null;
  pricing?: {
    headline?: { valueSource?: string | null } | null;
    method?: { ladderRung?: string | null; compsUsed?: number | null; kind?: string | null } | null;
    provenance?: {
      pricingSource?: string | null;
      pricingSourceMeta?: { method?: string | null; compsUsed?: number | null } | null;
    } | null;
  } | null;
}

export interface HoldingProvenance extends RungDescription {
  /** `pricingSource` — which pipeline wrote the number. */
  source: string | null;
  compsUsed: number | null;
}

/** The rung a persisted holding's price came from. The label is read from
 *  the envelope first (`method.ladderRung`, then the unified writer's
 *  `pricingSourceMeta.method` — holdingValuation.ts stamps the rung there
 *  and the envelope builder does not yet lift it into `ladderRung`), then
 *  the flat `fmvRung`. Nothing is inferred from prose: a holding whose
 *  writer named no rung says "rung not reported". */
export function holdingProvenance(h: HoldingProvenanceSource): HoldingProvenance {
  const p = h.pricing ?? null;
  const label =
    p?.method?.ladderRung
    ?? p?.provenance?.pricingSourceMeta?.method
    ?? h.fmvRung
    ?? null;
  const compsUsed =
    p?.method?.compsUsed
    ?? p?.provenance?.pricingSourceMeta?.compsUsed
    ?? null;
  const source = p?.provenance?.pricingSource ?? null;
  const base = describeRung(label, { compsUsed });
  if (base.kind === "unknown" && base.label == null && source === "legacy-engine") {
    // The legacy engine does not name its rung; say which engine it was so
    // the number is visibly not an exact-pool read.
    return { ...base, text: "legacy engine, rung not reported", source, compsUsed };
  }
  return { ...base, source, compsUsed };
}

// ─── Speculation pricing: a stale comp is not the price ─────────────────
//
// Drew, 2026-09-02: "the last comps from 2 months ago aren't a fair price.
// It is priced based on speculation and today's market."
//
// The rung says WHICH POOL the number came from. It does not say HOW OLD
// that pool is, and those are different facts: `exact-pool-projection`
// off five sales from June reads exactly like one off five sales from
// last week. A collector looking at the chip sees "projected from 5 sales
// of this card" and reasonably assumes the sales are recent — so on a
// thin, cold card the honest number looks like a stale one.
//
// The fix is additive on purpose. `describeRung` is pinned by rung.test.ts
// (every fallback's words begin with "estimate", every exact-pool rung
// says "this card") and those pins are doctrine, not incidental — so the
// age is a SECOND, separate line beside the rung, never a rewrite of it.
//
// The age comes from `daysSinceNewestComp`, which price-by-id already
// serves (compiqEstimate.service.ts: "daysSinceNewestComp + lastSale
// derive from the SAME record in the unwindowed post-(grade + parallel)
// pool"). Nothing is added to the envelope and no engine code moves.

/** Days past which the newest direct comp is too old to BE the price.
 *
 *  45 days — inside Drew's ~30-60d band and chosen off the shape of the
 *  data rather than the middle of the range: a card that trades monthly
 *  has a comp inside 30 days on a normal week, so a 30d line would fire
 *  on ordinary cards between sales and the copy would stop meaning
 *  anything. Past ~6 weeks the pool has genuinely stopped tracking the
 *  market, which is the case Drew is describing. */
export const STALE_COMP_DAYS = 45;

export interface StalenessNote {
  /** Whole weeks since the newest direct comp (>= 1 when stale). */
  weeks: number;
  daysSinceNewestComp: number;
  /** The chip line: short, sits beside the rung. */
  short: string;
  /** The long form for a tooltip / detail row. */
  long: string;
}

/** The speculation line for a value whose newest direct comp has gone
 *  cold, or null when it has not.
 *
 *  Null — no line at all — for every case that is not provably stale:
 *  a missing / non-finite / negative age, and an age inside the
 *  threshold. A value we cannot date does NOT get told it is old (the
 *  same rule the rung vocabulary follows for a missing label: never
 *  invent the fact, and never assume the bad case in the copy). */
export function describeStaleness(
  daysSinceNewestComp: number | null | undefined,
  opts: { thresholdDays?: number } = {},
): StalenessNote | null {
  const threshold = opts.thresholdDays ?? STALE_COMP_DAYS;
  const d = daysSinceNewestComp;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) return null;
  if (d <= threshold) return null;
  const weeks = Math.max(1, Math.round(d / 7));
  return {
    weeks,
    daysSinceNewestComp: d,
    short: `last sale ${weeks} weeks ago — priced to today's market`,
    long:
      `Last direct sale was ${weeks} weeks ago — old prints aren't fair value today. `
      + `This price projects today's market from the card's trend.`,
  };
}
