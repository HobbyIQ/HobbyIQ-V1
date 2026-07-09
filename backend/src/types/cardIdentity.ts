/**
 * Canonical CardIdentity type — unified identity shape for cards
 * resolved via cert lookup (any grader) OR Cardsight free-text
 * catalog search.
 *
 * Per CF-UNIFIED-SEARCH-AND-CERT Phase 3 design (23038d7) §3.
 *
 * SUPERSEDES the JSDoc-only @typedef CardIdentity at
 * backend/src/modules/compiq/models/identity.types.ts, which is
 * advisory-only (module.exports = {}, no runtime export) and uses
 * a different shape from earlier planning. That file is harmless
 * but stale; this is the source of truth.
 */

/**
 * Catalog parallel descriptor. Relocated inline (Phase 3 Wave 3) out of the
 * now-deleted cardsight.client.ts. The legacy `CardsightParallel` name is kept
 * as a deprecated alias so existing consumers keep compiling.
 */
export interface CardParallel {
  id: string;
  name: string;
  numberedTo?: number;
}

/** @deprecated use CardParallel — alias retained for back-compat. */
export type CardsightParallel = CardParallel;

export type CardIdentitySource =
  | "psa-cert"
  | "catalog"
  | "cardsight-catalog"   // DEPRECATED — retained for wire back-compat with older iOS clients
  | "bgs-cert"
  | "sgc-cert"
  | "cgc-cert";

/**
 * CF-CH-MATCH-CARD-BOOST (2026-06-28): "ai-matched" added for candidates
 * resolved by CardHedge's /v1/cards/card-match semantic matcher (confidence
 * gate >=0.80). Carries confidence 1.0 like "authoritative" but is
 * distinct so consumers can attribute the source if needed (telemetry,
 * future debug overlay). The match is high-confidence but NOT a cert
 * confirmation — it's a semantic resolution of intent.
 */
export type CardIdentityAttribution = "authoritative" | "ranked" | "ai-matched";

export interface CardIdentity {
  /** Stable per-candidate id, e.g. "psa:76556858" or "cardsight:b9d2b2b1..." */
  candidateId: string;
  source: CardIdentitySource;

  /**
   * Names what `confidence` MEANS for this candidate. Per Drew's Addition 1
   * (Phase 2 review): the confidence field is semantically overloaded
   * (cert hits are authoritative=1.0; catalog hits are relevance-ranked
   * 0..1). Rather than leave consumers to check `source` to interpret
   * the number, attribution makes the meaning explicit on the type
   * itself.
   *
   *   "authoritative": cert grader confirmed identity. confidence === 1.0.
   *                    Consumers can rely on the identity fields as ground truth.
   *   "ranked":        catalog/free-text hit. confidence is a relevance score
   *                    in [0, 1] from rank scoring. Identity fields are best-guess.
   */
  attribution: CardIdentityAttribution;
  /** 0..1; authoritative ⇒ 1.0 */
  confidence: number;

  // Identity (subset populated by source)
  player: string | null;
  year: number | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  variation: string | null;
  isAuto: boolean;
  serialNumber: string | null;

  // Grade context (cert only — null for catalog candidates)
  grade: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  certNumber: string | null;
  totalPopulation: number | null;
  populationHigher: number | null;

  // Display
  title: string;
  imageUrl: string | null;

  /**
   * Per CF-UNIFIED-SEARCH-AND-CERT W5-Windows (2026-05-29) — detail-
   * enriched fields populated by the Cardsight catalog adapter when
   * the dispatcher fans out per-hit `getCardDetail` fetches. Cert-
   * source candidates (PSA / future graders) leave these undefined.
   *
   * `parallels` carries the empirically-verified
   * Array<{ id, name, numberedTo? }> shape from the Cardsight detail
   * endpoint — used by the iOS picker (W5-iOS) to distinguish near-
   * identical rows (Refractor / Blue / Gold / Red / Superfractor).
   *
   * `attributes` carries free-form tags from Cardsight (e.g.
   * "MLB-KCR", "RC"). Empty-array when the upstream response omits
   * them; absent when detail enrichment was not attempted (cert path).
   *
   * Both fields are OPTIONAL. Absent on cert-source candidates;
   * present-but-empty on Cardsight catalog candidates where the
   * upstream response carried no parallels / attributes; present-and-
   * populated on the common case.
   */
  parallels?: CardsightParallel[];
  attributes?: string[];

  /** Vendor body for debug / future use. */
  raw?: unknown;
}
