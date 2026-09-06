// CF-CARDID-SUGGESTER (2026-07-12).
//
// Lightweight card-id suggester for pending-review holdings. Uses the
// CardHedge search endpoint with the Browse-enriched structured fields
// (playerName, cardYear, setName, parallel, cardNumber, isAuto) to
// propose a canonical cardId. NEVER commits — the suggestion lands on
// the pending-review holding as `suggestedCardId` + `suggestionConfidence`
// + `suggestionCandidate`. iOS shows it in the review sheet with
// [Accept] / [Different card] buttons. Accept sends `cardId` in the
// confirm edits body; the review-queue confirm endpoint already handles it.
//
// Deliberately NOT authoritative — the whole point of the review queue is
// that the user is ground truth. Auto-locking a suggested cardId reintroduces
// the "silently wrong pricing" failure mode PR #386 shipped to avoid.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { searchCards, isAutoCardNumber, type CardHedgeCard } from "../compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../compiq/cardsightUuidSource.js";
import type { CardIdentity } from "../../types/cardIdentity.js";
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";
import { inferPrintRunFromReferenceCatalog } from "../compiq/referenceCatalogLookup.js";
// CF-SUGGESTER-CATALOG-FIRST (Drew, 2026-08-12): match against OUR catalog
// before any vendor. See catalogHitToCommon() for the full rationale.
import { canonicalCardSearch, type CanonicalSearchHit } from "./canonicalCardSearch.service.js";

/**
 * CF-CARDID-SUGGESTER-CATALOG-BOOST (Drew, 2026-07-14): confidence bump
 * applied when the reference-catalog resolves the candidate's SKU.
 * Additive to the field-alignment score. Boost sized per catalog tier:
 *
 *   Verified → +0.10  (cross-source-checked; strongest signal)
 *   High     → +0.05  (workbook-confident but unverified externally)
 *   Medium   → +0.02  (workbook-flagged uncertain; small boost only)
 *
 * Cap at 0.98 to preserve the semantic ceiling for user-verified
 * (1.0) confirmations. A borderline-medium (0.75) suggestion that
 * verifies against a "Verified" catalog row lands at 0.85 → high tier
 * — which is the intended UX outcome (fewer manual verifications).
 */
function catalogConfidenceBoost(
  catalog: CardIdSuggestion["catalogVerified"],
): number {
  if (!catalog) return 0;
  switch (catalog.confidence) {
    case "Verified": return 0.10;
    case "High":     return 0.05;
    case "Medium":   return 0.02;
    default:         return 0;
  }
}

function applyCatalogBoost(baseConfidence: number, boost: number): number {
  if (boost === 0) return baseConfidence;
  const boosted = Math.min(0.98, baseConfidence + boost);
  return Math.round(boosted * 100) / 100;
}

/**
 * CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14): thin wrapper
 * around inferPrintRunFromReferenceCatalog that returns the shape the
 * suggestion carries onto the wire. Fires only when we have all three
 * (year, setName, parallel) — else there's nothing to look up.
 * Fire-and-swallow: catalog lookup must never fail a suggestion.
 */
async function catalogVerifyCandidate(
  cardYear: number | null | undefined,
  setName: string | null | undefined,
  parallel: string | null | undefined,
  isAuto: boolean | null | undefined,
): Promise<CardIdSuggestion["catalogVerified"]> {
  if (!cardYear || !setName || !parallel) return null;
  try {
    const hit = await inferPrintRunFromReferenceCatalog(
      setName, cardYear, parallel, { isAuto: isAuto ?? undefined },
    );
    if (!hit) return null;
    return {
      confidence: hit.confidence as "Verified" | "High" | "Medium",
      printRun: hit.printRun,
      canonicalProduct: hit.product,
      canonicalCardSet: hit.cardSet,
      canonicalParallel: hit.parallel,
    };
  } catch {
    return null;
  }
}

/**
 * CF-CARDID-SUGGESTER-CONFIDENCE-TIERING (2026-07-12): buckets iOS keys on
 * for the progressive-review UX. "high" → bulk auto-approve tier;
 * "medium" → quick individual review; "low" → manual catalog search.
 * Backend owns the thresholds so iOS stays semantic.
 */
export type SuggestionConfidenceTier = "high" | "medium" | "low";

/** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a, 2026-08-29). What kind of id
 *  the winning candidate carried. "hiq" — our canonical slug, and `cardId`
 *  is set. "vendor" — a CardHedge / Cardsight id; `cardId` is ABSENT and the
 *  vendor id is context on `candidate.vendorCardId` only. */
export type SuggestionIdKind = "hiq" | "vendor";

export interface CardIdSuggestion {
  /** The canonical hiq: slug to suggest. ABSENT when the winning candidate
   *  carried a vendor id — a suggestion that is not our identity is not a
   *  suggestion the holding may adopt (see idKind). Every consumer that
   *  writes suggestedCardId / cardId from this field is therefore
   *  hiq-only by construction. */
  cardId?: string;
  idKind: SuggestionIdKind;
  confidence: number;   // 0.0 - 1.0
  confidenceTier: SuggestionConfidenceTier;
  /** CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): which catalog
   *  the suggestion came from. iOS can badge or route accordingly.
   *  "cardhedge"       — CH search hit (bubble.io id)
   *  "cardsight-uuid"  — CS-native UUID hit (compound {parent}::{parallel})
   *  "hobbyiq-catalog" — OUR card_catalog (canonical hiq: slug).
   *                      CF-SUGGESTER-CATALOG-FIRST (Drew, 2026-08-12):
   *                      preferred source. iOS can badge these differently
   *                      — a catalog hit is our own identity, not a vendor's
   *                      guess, and its cardId is already the canonical slug
   *                      so accepting it needs no translation.
   */
  candidateSource: "cardhedge" | "cardsight-uuid" | "hobbyiq-catalog";
  /** Per-field alignment score breakdown — surfaces to iOS as a
   *  transparency layer ("we matched 4 of 5 fields"). */
  matchBreakdown: {
    fieldsChecked: number;
    fieldsMatched: number;
    mismatchedFields: string[];
  };
  candidate: {
    title?: string;
    set?: string;
    year?: number | string;
    number?: string;
    variant?: string;
    image?: string;
    /** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a): the vendor's own id for
     *  this candidate when idKind is "vendor". Context for the review sheet
     *  (link out, badge); never an identity the holding adopts. */
    vendorCardId?: string;
  };
  /** CF-CARDID-SUGGESTER-TOP-N (Drew, 2026-07-14): when the primary
   *  suggestion isn't in the "high" tier, up to 2 alternative candidates
   *  the review sheet can present as "or one of these" — user picks in
   *  one tap instead of full-catalog search. Empty for high-tier picks
   *  (the primary is confident enough). Ranked by score descending.
   *
   *  Alternatives never contain the primary itself (deduped by cardId
   *  and by (year, cardNumber, parallel) so cross-vendor collisions
   *  don't surface twice).
   */
  alternatives?: Array<Omit<CardIdSuggestion, "alternatives">>;
  /** CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14): when the
   *  (year, setName, parallel) combo resolves against the Cosmos
   *  reference-catalog (Phase 4 data), this candidate is confirmed to
   *  be a REAL catalogued SKU — not a vendor mis-match. iOS can badge
   *  it "catalog verified"; downstream can weight it higher in scoring.
   *
   *  Populated for both primary and alternatives. `null` when the
   *  catalog has no matching entry OR when the env flag
   *  COMPIQ_REFERENCE_CATALOG_ENABLED is off (rollback lever).
   */
  catalogVerified?: {
    confidence: "Verified" | "High" | "Medium";
    printRun: number | null;
    canonicalProduct: string;
    canonicalCardSet: string;
    canonicalParallel: string;
  } | null;
}

// CF-CARDID-SUGGESTER-CONFIDENCE-TIERING thresholds. iOS reads
// `confidenceTier` — never depend on raw confidence numbers.
const TIER_HIGH_THRESHOLD = 0.85;
const TIER_MEDIUM_THRESHOLD = 0.6;

export function tierForConfidence(confidence: number): SuggestionConfidenceTier {
  if (confidence >= TIER_HIGH_THRESHOLD) return "high";
  if (confidence >= TIER_MEDIUM_THRESHOLD) return "medium";
  return "low";
}

/**
 * Build a CH search query from ALREADY-NORMALIZED holding fields.
 * Caller must run `normalizeHoldingFields()` first — this helper does
 * NOT re-normalize. Emits year + set + player + parallel + #number in
 * that order. Deliberately omits noisy tokens ("PSA 10", "GEM MINT")
 * that CH doesn't index — those are grader/grade filters, not search
 * terms.
 */
function buildQueryFromNormalized(
  fields: ReturnType<typeof normalizeHoldingFields>["fields"],
): string {
  const parts: string[] = [];
  if (fields.cardYear) parts.push(String(fields.cardYear));
  if (fields.setName) parts.push(fields.setName);
  if (fields.playerName) parts.push(fields.playerName);
  if (fields.parallel) parts.push(fields.parallel);
  // CF-CARDID-SUGGESTER-DROP-HASH (Drew, 2026-07-14): emit card number
  // as a bare token, NOT prefixed with `#`. The prefix tanks CH's
  // relevance scoring — 2026-07-14 diagnostic: "Eric Hartman #CPA-EH"
  // returned 0 hits while "Eric Hartman CPA-EH" returned 12 including
  // the correct CPA-EHA base card. CH's tokenizer treats the `#` as a
  // signal boundary, not as decoration.
  if (fields.cardNumber) parts.push(String(fields.cardNumber));
  return parts.join(" ");
}

/**
 * CF-CARDID-SUGGESTER-CONFIDENCE-TIERING (2026-07-12): field-alignment
 * scorer produces a NORMALIZED confidence (0.0-1.0) by dividing matched
 * weight by the total weight of fields we could actually check (fields
 * present on the holding). A holding without cardYear can still reach
 * confidence 1.0 by matching everything else — the denominator adapts.
 *
 * Weights sum to 100 when every field is present:
 *   year          — 20
 *   card number   — 25
 *   set           — 20
 *   parallel      — 10
 *   player        — 15
 *   auto/rookie   — 10 (aligned = holding.isAuto matches candidate signals)
 */
interface FieldMatchResult {
  /** Total weight of fields present on holding (denominator for score). */
  weightChecked: number;
  /** Total weight of matched fields (numerator). */
  weightMatched: number;
  /** Count of distinct fields we tried to match (present on holding). */
  fieldsChecked: number;
  /** Count of distinct fields that matched. */
  fieldsMatched: number;
  /** Normalized alignment score = weightMatched / weightChecked. */
  score: number;
  /** Human-readable list of fields that WERE checked but didn't match. */
  mismatched: string[];
}

/**
 * CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): normalized candidate
 * shape covering both CH bubble.io hits and CS-native UUID candidates.
 * Both vendors share the same scorer against a PortfolioHolding; the
 * source flag propagates to the caller for wire attribution.
 */
interface CommonCandidate {
  /** The candidate's id — CH's bubble.io id, CS's compound
   *  "{parent}::{parallel}", or (catalog-first) our canonical hiq: slug.
   *  Only an hiq: id reaches the wire as `cardId`; see idKind. */
  cardId: string;
  /** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a). */
  idKind: SuggestionIdKind;
  source: "cardhedge" | "cardsight-uuid" | "hobbyiq-catalog";
  title: string | null;
  name: string | null;
  set: string | null;
  year: number | string | null;
  number: string | null;
  variant: string | null;
  image: string | null;
  /** CF-SUGGEST-CANONICAL-ONLY: true when cardId is our own hiq: slug rather
   *  than a vendor id. Ranked above vendor candidates so the picker offers the
   *  catalog card, not a vendor's copy of it. */
  canonical?: boolean;
}

function chToCommon(c: CardHedgeCard): CommonCandidate | null {
  if (!c.card_id) return null;
  return {
    cardId: c.card_id,
    idKind: "vendor",
    source: "cardhedge",
    title: c.title ?? null,
    name: c.name ?? null,
    set: c.set ?? null,
    year: c.year ?? null,
    number: c.number ?? null,
    variant: c.variant ?? null,
    image: c.image ?? null,
  };
}

/**
 * Convert a CS-native CardIdentity into the common candidate shape. The
 * CardIdentity's `candidateId` is `cardsight:{parent}::{parallel}` — strip
 * the `cardsight:` prefix to get the wire cardId iOS sends back to
 * /price-by-id (the compound {parent}::{parallel} form the route parses).
 */
// CF-SUGGESTER-CATALOG-FIRST (Drew, 2026-08-12). This suggester was written
// 2026-07-12 against the CardHedge search endpoint, three weeks before
// catalog-first search shipped (2026-08-01) — and it never got migrated. So
// eBay-imported holdings were being matched against vendor APIs instead of
// our own 25M-row card_catalog.
//
// That is broken twice over in prod today:
//   CH_RUNTIME_DISABLED=true  — the PRIMARY source is switched off, so the
//                               strict+relaxed CH paths return nothing
//   Cardsight                 — deprecated per README, alive only on fallback
//                               flags, and the source of the vendor-id-keyed
//                               rows the cleanliness canary flags
//
// Net effect: eBay imports arrived with no suggestion at all and every card
// had to be matched by hand. Meanwhile the catalog that actually contains
// those cards was never consulted — the exact inversion of "catalog IS the
// moat, not vendor APIs".
//
// Catalog hits are searched WITH provisional rows included: for MATCHING we
// want the stub cards too (a stub means we hold real sales for that card but
// have no checklist yet — precisely the ones a user is most likely importing
// and least likely to find). Search-facing surfaces still exclude them.
//
// This does NOT change the commit semantics. The suggestion still lands as
// `suggestedCardId` + confidence for the review queue to accept or reject —
// auto-locking a wrong cardId is the "silently wrong pricing" failure mode
// PR #386 exists to prevent.
function catalogHitToCommon(h: CanonicalSearchHit): CommonCandidate | null {
  // CF-SUGGEST-CANONICAL-ONLY (Drew, 2026-08-13: "maybe we make them select the
  // options that it could be and select the right one?").
  //
  // The picker this feeds is the right idea and already built — but it was
  // proposing VENDOR ids. hobbyiqCardId is null on vendor-sourced catalog rows,
  // so this fell back to h.cardId, a CardHedge bubble.io id:
  //
  //   primary: 1606922959335x293409091214639100
  //   alt:     1675907814837x786442928083165000
  //
  // Accepting one of those pins the holding to a vendor's COPY of the card
  // rather than the card. Downstream then prices from that vendor row instead
  // of the canonical pool — the same failure removed from search
  // (CF-SEARCH-CHECKLIST-IS-THE-INDEX) and from the matcher's fuzzy-parallel
  // step today.
  //
  // CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a, 2026-08-29). "A vendor id is
  // still better than nothing" was the fallback here, and it was persisted as
  // suggestedCardId and auto-applied as cardId at >= 0.55 by the confirm and
  // rescue passes. A vendor id on a vendor-sourced catalog row is still a
  // vendor's copy of the card. The row stays a candidate — its fields still
  // score, still verify, still show in the sheet — but only an hiq: slug is
  // ever offered as the id to adopt.
  const wireCardId = h.hobbyiqCardId ?? h.cardId;
  if (!wireCardId) return null;
  const isCanonical = typeof wireCardId === "string" && wireCardId.startsWith("hiq:");
  return {
    cardId: wireCardId,
    idKind: isCanonical ? "hiq" : "vendor",
    canonical: isCanonical,
    source: "hobbyiq-catalog",
    title: null,
    name: h.player ?? null,
    set: h.releaseName ?? null,
    year: h.cardYear ?? null,
    number: h.cardNumber ?? null,
    // Suggester scoring compares a single variant string; catalog hits carry
    // a parallels[] array, so take the first (rows are already exploded
    // per-parallel, so length is 1 for variant rows).
    variant: h.parallels?.[0]?.name ?? null,
    image: h.imageUrl ?? null,
  };
}

function csIdentityToCommon(c: CardIdentity): CommonCandidate | null {
  if (!c.candidateId) return null;
  const wireCardId = c.candidateId.startsWith("cardsight:")
    ? c.candidateId.slice("cardsight:".length)
    : c.candidateId;
  return {
    cardId: wireCardId,
    idKind: "vendor",
    source: "cardsight-uuid",
    title: c.title ?? null,
    name: c.player ?? null,
    set: c.setName ?? null,
    year: c.year ?? null,
    number: c.cardNumber ?? null,
    variant: c.parallel ?? null,
    image: c.imageUrl ?? null,
  };
}

function scoreCandidate(candidate: CommonCandidate, holding: PortfolioHolding): FieldMatchResult {
  const weights = {
    year: 20,
    cardNumber: 25,
    setName: 20,
    parallel: 10,
    playerName: 15,
    autoFlag: 10,
  } as const;

  let weightChecked = 0;
  let weightMatched = 0;
  let fieldsChecked = 0;
  let fieldsMatched = 0;
  const mismatched: string[] = [];

  // CF-CARDID-SUGGESTER-FAIR-SCORING (Drew, 2026-07-14): the check
  // signature now takes BOTH sides' presence flags. Prior implementation
  // gated only on the holding side — so when CH returned a candidate
  // with a null `name` field the playerName check fired a false
  // "mismatch" (empty candidate string can't contain holding.playerName).
  // Fair semantics: if either side lacks signal, skip the field entirely
  // (no credit, no penalty). You can't call something a mismatch when
  // you have no data to compare.
  const check = (
    fieldName: string,
    weight: number,
    holdingHasSignal: boolean,
    candidateHasSignal: boolean,
    isMatch: boolean,
  ) => {
    if (!holdingHasSignal || !candidateHasSignal) return;
    weightChecked += weight;
    fieldsChecked += 1;
    if (isMatch) {
      weightMatched += weight;
      fieldsMatched += 1;
    } else {
      mismatched.push(fieldName);
    }
  };

  // year — CF-CARDID-SUGGESTER-YEAR-FROM-SET (Drew, 2026-07-14): CH's
  // `card.year` is often null; the year lives baked into the `set`
  // string ("2026 Bowman Baseball"). Fall back to extracting a 4-digit
  // year from set text before deciding the year mismatched. Also
  // accepts the CS candidate.year when it's stored as a string.
  const cYearFromField = (() => {
    // Guard against Number(null) = 0 and Number("") = 0 — both would
    // pass Number.isFinite but aren't valid years. Only trust the field
    // when it's a non-empty numeric string OR a real number ≥ 1900.
    if (candidate.year == null || candidate.year === "") return NaN;
    const n = Number(candidate.year);
    return Number.isFinite(n) && n >= 1900 ? n : NaN;
  })();
  const cYearFromSet = (() => {
    const m = String(candidate.set ?? candidate.title ?? "").match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : NaN;
  })();
  const cYear = Number.isFinite(cYearFromField) ? cYearFromField : cYearFromSet;
  check("cardYear", weights.year,
    !!holding.cardYear,
    Number.isFinite(cYear),
    !!holding.cardYear && Number.isFinite(cYear) && cYear === holding.cardYear);

  // cardNumber
  const cardNumberMatch = (() => {
    if (!holding.cardNumber || !candidate.number) return false;
    const a = String(holding.cardNumber).toLowerCase();
    const b = String(candidate.number).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  })();
  check("cardNumber", weights.cardNumber,
    !!holding.cardNumber,
    !!candidate.number,
    cardNumberMatch);

  // set — CF-CARDID-SUGGESTER-SET-TOKEN-OVERLAP (Drew, 2026-07-14): the
  // set-string is the LEAST-canonical field across vendors:
  //   holding.setName    = "Bowman Chrome"       (user's mental model)
  //   CH.card.set        = "2026 Bowman Baseball" (CH's catalog naming
  //                          — CPA-EHA autos are catalogued under the
  //                          flagship set, not Chrome)
  //   CS.detail.setName  = "Chrome Prospects"    (CS's own naming)
  // Strict includes-check drops honest matches to a hard 0 at 20 weight.
  // Fuzzy match: normalize both, split into significant tokens (year
  // digits + "baseball"/"basketball"/etc. category noise stripped),
  // count intersection. Full match on all tokens = 1.0; partial = 0.5;
  // no shared tokens = 0.
  const setMatchScore = (() => {
    if (!holding.setName || !candidate.set) return 0;
    const CATEGORY_NOISE = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
    const tokenize = (s: string) => new Set(
      s.toLowerCase()
        .replace(/[-_/]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !/^\d{4}$/.test(t) && !CATEGORY_NOISE.has(t)),
    );
    const a = tokenize(String(holding.setName));
    const b = tokenize(String(candidate.set));
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    if (shared === 0) return 0;
    return shared === a.size && shared === b.size ? 1.0 : 0.5;
  })();
  // Full-credit when both sides tokenize to the same set; half-credit
  // on any overlap. Passed as isMatch=true/false via the >= 1.0 gate
  // (below), and the partial score is folded into weightMatched via
  // the special-case addition to preserve tiering behavior.
  const setMatch = setMatchScore >= 1.0;
  const setPartial = setMatchScore >= 0.5 && setMatchScore < 1.0;
  if (holding.setName && candidate.set) {
    weightChecked += weights.setName;
    fieldsChecked += 1;
    if (setMatch) {
      weightMatched += weights.setName;
      fieldsMatched += 1;
    } else if (setPartial) {
      // Partial credit: half the weight, but still counts as "matched"
      // for the fields tally so the user sees "4/5 fields match" rather
      // than a red mismatch.
      weightMatched += weights.setName * 0.5;
      fieldsMatched += 1;
    } else {
      mismatched.push("setName");
    }
  }

  // parallel/variant — CF-CARDID-SUGGESTER-STRICT-PARALLEL (Drew,
  // 2026-07-14): require normalized-equality, NOT substring. Prior
  // .includes() check let "Blue Refractor" (holding) collide with
  // "Refractor" (candidate) via `a.includes(b)` — different SKUs, wrong
  // sub-market, exact same class of bug as the CH bridge guard (PR-B).
  // Normalization strips hyphens/underscores/slashes and collapses
  // whitespace so "Blue-Refractor" still collides with "Blue Refractor".
  const parallelMatch = (() => {
    if (!holding.parallel || !candidate.variant) return false;
    const norm = (s: string) => s
      .toLowerCase()
      .replace(/[-_/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return norm(String(holding.parallel)) === norm(String(candidate.variant));
  })();
  check("parallel", weights.parallel,
    !!holding.parallel,
    !!candidate.variant,
    parallelMatch);

  // player — CF-CARDID-SUGGESTER-PLAYER-TRUST-FILTER (Drew, 2026-07-14):
  // when candidate has NO name/title text (common on CH's search shape
  // — many rows are set+number+variant only), skip the check. The
  // player filter passed to CH's search already narrowed the pool to
  // matching-player rows, so treating a text-less candidate as a player
  // mismatch is a false negative.
  const candidatePlayerText = String(candidate.name ?? candidate.title ?? "").toLowerCase().trim();
  const playerMatch = candidatePlayerText.length > 0
    && candidatePlayerText.includes(String(holding.playerName ?? "").toLowerCase());
  check("playerName", weights.playerName,
    !!holding.playerName,
    candidatePlayerText.length > 0,
    playerMatch);

  // isAuto — CF-CARDID-SUGGESTER-AUTO-INFERENCE (Drew, 2026-07-14):
  // check title/variant text FIRST (Bowman "Refractor Auto" style
  // labels), then fall back to card-number prefix (CH's autograph SKUs
  // encode auto-ness in CPA-/BCPA-/CRA-/etc. — reuses isAutoCardNumber
  // from cardhedge.client). Prior text-only check missed every CH
  // autograph pick, always firing a false "isAuto mismatch" that
  // dropped Hartman/Owen Carey CPA autos out of medium tier.
  const candidateAutoText = String(candidate.variant ?? candidate.title ?? "").toLowerCase();
  const candidateHasAutoSignal =
    candidateAutoText.length > 0 || !!candidate.number;
  const candidateIsAuto =
    /\b(auto|autograph)\b/.test(candidateAutoText) || isAutoCardNumber(candidate.number);
  check("isAuto", weights.autoFlag,
    typeof holding.isAuto === "boolean",
    candidateHasAutoSignal,
    candidateIsAuto === holding.isAuto);

  const score = weightChecked === 0 ? 0 : weightMatched / weightChecked;
  return {
    weightChecked,
    weightMatched,
    fieldsChecked,
    fieldsMatched,
    score,
    mismatched,
  };
}

/**
 * Suggest a canonical cardId for one pending-review holding. Returns null
 * when the search yields no viable candidates. Never throws.
 *
 * Confidence semantics:
 *   Single candidate scoring ≥50/100 → 0.90 (high confidence single hit)
 *   Single candidate scoring <50    → 0.60 (weak single hit)
 *   Multiple candidates             → top score / 100, clamped to [0.4, 0.95]
 *   No candidates                   → null suggestion
 */
/**
 * Dedup key across vendors: (year, cardNumber, normalized-parallel).
 * Same physical SKU from CH and CS collides here — CH survives when
 * both are present (higher score wins the primary, dup is dropped from
 * alternatives). Deliberately doesn't include player because the holding
 * already filters by player at the source query.
 */
function crossVendorDedupKey(c: CommonCandidate): string {
  const yr = String(c.year ?? "").trim();
  const num = String(c.number ?? "").toLowerCase().trim();
  const par = String(c.variant ?? "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${yr}::${num}::${par}`;
}

// CF-SUGGESTER-CATALOG-ONLY (Drew, 2026-08-12). "i dont want matching with
// cardhedge, all i want is sold data that is matched to our catalog."
//
// Vendor candidate pools are OFF by default. The catalog is the matcher; CH
// and CS are no longer consulted for identity. Reasons this is right rather
// than merely requested:
//   - CH_RUNTIME_DISABLED=true in prod, so the CH pool returns [] anyway and
//     every call is latency we pay for nothing.
//   - Cardsight is deprecated per its README and is the origin of the
//     vendor-id-keyed rows the cleanliness canary flags — matching against it
//     reintroduces identities our own slug space cannot address.
//   - A vendor match yields a vendor cardId that then has to be translated;
//     a catalog match yields the canonical hiq: slug directly.
//
// Flags left in place so a single env var restores either pool if the
// catalog ever regresses — deleting the code would make that a redeploy.
// Read at CALL time, not module load. Module-level consts made these
// untestable (a test cannot set the env before ESM import hoisting runs) and
// meant flipping the env var in prod needed a restart to take effect.
const chSuggesterEnabled = () => process.env.SUGGESTER_CARDHEDGE_ENABLED === "true";
// CF-CARDSIGHT-RETIRED (Drew, 2026-08-16). The suggester no longer consults
// Cardsight for card-id candidates; catalog-first search is the matching path.
const csSuggesterEnabled = () => false;
const ALTERNATIVE_MIN_SCORE = 0.4;
const ALTERNATIVE_MAX_COUNT = 2;
const SUGGESTER_TIMEOUT_MS = 8_000;

export async function suggestCardIdForHolding(
  holding: PortfolioHolding,
): Promise<CardIdSuggestion | null> {
  if (!holding.playerName) return null;

  // CF-HOLDING-FIELD-NORMALIZER (Drew, 2026-07-14): scrub messy eBay-
  // imported fields before building the query — year-doubling, subset
  // words leaked into parallel/player, casing variance. Historical
  // holdings imported before we normalize-at-import benefit here
  // defensively without a data backfill. Also lands cleaner scoring
  // downstream because the field-alignment check runs on normalized
  // strings.
  const normalized = normalizeHoldingFields({
    playerName: holding.playerName,
    cardYear: holding.cardYear,
    setName: holding.setName,
    parallel: holding.parallel,
    cardNumber: holding.cardNumber,
    isAuto: holding.isAuto,
  });
  const cleanFields = normalized.fields;
  if (!cleanFields.playerName) return null;

  const query = buildQueryFromNormalized(cleanFields);
  if (!query.trim()) return null;

  // Two filter variants: WITH set (strict — CH's canonical set format
  // required) and WITHOUT set (relaxed — player-only narrowing). We try
  // strict first; if either vendor returns hits, use them. If BOTH come
  // back empty AND we had a set filter, retry without. This handles
  // holdings whose setName doesn't exactly match CH's canonical form
  // (e.g. "Bowman" vs CH's "Bowman Baseball") without loosening the
  // filter for holdings that DO match.
  const strictFilters = {
    player: cleanFields.playerName,
    set: cleanFields.setName ?? undefined,
    rookie: (holding as any).isRookie ? "Rookie" : undefined,
  };
  const relaxedFilters = {
    player: cleanFields.playerName,
    rookie: (holding as any).isRookie ? "Rookie" : undefined,
  };

  // CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): fire CH search
  // AND CS-native fetch in parallel, so a SKU missing from CH's catalog
  // (e.g. Hartman CPA-EHA Blue Refractor Auto, 2026-07-14 incident) still
  // gets a suggestion from CS. Both wrapped in the SAME 8s hard timeout
  // so a slow vendor can never hang the batch. Vendor errors resolve to
  // empty pools — never fatal to the batch.
  const runStrict = async (): Promise<{ chRaw: CardHedgeCard[]; csRaw: CardIdentity[] }> => {
    const chPromise: Promise<CardHedgeCard[]> = chSuggesterEnabled()
      ? Promise.race([
      searchCards(query, 5, strictFilters).catch(() => [] as CardHedgeCard[]),
      new Promise<CardHedgeCard[]>((_, reject) =>
        setTimeout(() => reject(new Error("ch suggester timeout")), SUGGESTER_TIMEOUT_MS),
      ),
    ]).catch(() => [] as CardHedgeCard[])
      : Promise.resolve([] as CardHedgeCard[]);
    const csPromise: Promise<CardIdentity[]> = csSuggesterEnabled()
      ? Promise.race([
          fetchCardsightUuidNativeCandidates(query).catch(() => [] as CardIdentity[]),
          new Promise<CardIdentity[]>((_, reject) =>
            setTimeout(() => reject(new Error("cs suggester timeout")), SUGGESTER_TIMEOUT_MS),
          ),
        ]).catch(() => [] as CardIdentity[])
      : Promise.resolve([]);
    const [chRaw, csRaw] = await Promise.all([chPromise, csPromise]);
    return { chRaw, csRaw };
  };

  // CF-SUGGESTER-CATALOG-FIRST (Drew, 2026-08-12). Ask OUR catalog before
  // any vendor. Runs on the same hard timeout and degrades to an empty pool,
  // so a slow or unavailable catalog can never hang or fail the batch — the
  // vendor paths below still run exactly as before.
  const catalogRaw: CanonicalSearchHit[] = await Promise.race([
    canonicalCardSearch({
      q: query,
      sport: ((holding as any).sport ?? undefined) as string | undefined,
      limit: 10,
      skipEnrichment: true,   // identity only — no FMV round-trips
      includeProvisional: true, // matching wants stubs; search surfaces don't
    })
      .then((r) => r.hits ?? [])
      .catch(() => [] as CanonicalSearchHit[]),
    new Promise<CanonicalSearchHit[]>((resolve) =>
      setTimeout(() => resolve([] as CanonicalSearchHit[]), SUGGESTER_TIMEOUT_MS),
    ),
  ]).catch(() => [] as CanonicalSearchHit[]);

  let { chRaw, csRaw } = await runStrict();
  let usedFilterMode: "strict" | "relaxed_retry" = "strict";

  // Opportunistic retry: if both vendors returned nothing AND we had a
  // set filter that could be dropped, try again without it. Cardsight
  // never uses `filters` (its fetch is free-text only) so this only
  // helps the CH path — but that's exactly where the set-format
  // mismatch bites.
  if (chSuggesterEnabled() && chRaw.length === 0 && csRaw.length === 0 && strictFilters.set) {
    const chRelaxed = await Promise.race([
      searchCards(query, 5, relaxedFilters).catch(() => [] as CardHedgeCard[]),
      new Promise<CardHedgeCard[]>((_, reject) =>
        setTimeout(() => reject(new Error("ch suggester timeout")), SUGGESTER_TIMEOUT_MS),
      ),
    ]).catch(() => [] as CardHedgeCard[]);
    if (chRelaxed.length > 0) {
      chRaw = chRelaxed;
      usedFilterMode = "relaxed_retry";
    }
  }

  const chCommon = chRaw.map(chToCommon).filter((c): c is CommonCandidate => c !== null);
  const csCommon = csRaw.map(csIdentityToCommon).filter((c): c is CommonCandidate => c !== null);
  // CF-SUGGESTER-CATALOG-FIRST: catalog candidates lead the pool. Order is
  // not scoring — scoreCandidate still decides the winner on field
  // alignment — but it makes the catalog the default answer on ties, and
  // crossVendorDedupKey collapses the same physical card across sources.
  const catalogCommon = catalogRaw
    .map(catalogHitToCommon)
    .filter((c): c is CommonCandidate => c !== null);
  const merged = [...catalogCommon, ...chCommon, ...csCommon];

  // CF-CARDID-SUGGESTER-QUERY-LOGGING (Drew, 2026-07-14): emit the
  // resolved query per holding so KQL can chart no-hit patterns and
  // surface which fields were normalized. Load-bearing for iterating
  // on the normalizer rule set — you can't fix what you can't see.
  console.log(JSON.stringify({
    event: "card_id_suggester_query",
    source: "cardIdSuggester.service",
    holdingId: holding.id,
    query,
    filterMode: usedFilterMode,
    normalizerChanges: normalized.changes.length,
    changesSummary: normalized.changes.map((c) => `${c.rule}:${c.field}`),
    chHits: chRaw.length,
    csHits: csRaw.length,
    // CF-SUGGESTER-CATALOG-FIRST: logged separately so KQL can show the
    // catalog carrying the suggester while CH_RUNTIME_DISABLED=true, and
    // catch a regression where catalogHits silently drops to 0.
    catalogHits: catalogRaw.length,
    totalCandidates: merged.length,
  }));

  if (merged.length === 0) {
    console.warn(JSON.stringify({
      event: "card_id_suggester_no_candidates",
      source: "cardIdSuggester.service",
      holdingId: holding.id,
      chHits: chRaw.length,
      csHits: csRaw.length,
    }));
    return null;
  }

  // Score against NORMALIZED fields — otherwise the messy original
  // (e.g. parallel="Chrome Refractor") mismatches a clean vendor variant
  // ("Refractor") and downgrades the score of the correct match.
  //
  // CF-CARDID-SUGGESTER-SCORING-NORMALIZED (Drew, 2026-07-14): use the
  // normalized values DIRECTLY (no `??` fallback). Prior code fell back
  // to holding.parallel when normalizer nulled it — undoing R3's
  // subset-strip for scoring purposes. If normalizer decided parallel
  // was noise, the scorer needs to see null too.
  const holdingForScoring: PortfolioHolding = {
    ...holding,
    playerName: cleanFields.playerName as any,
    cardYear: cleanFields.cardYear as any,
    setName: cleanFields.setName as any,
    parallel: cleanFields.parallel as any,
    cardNumber: cleanFields.cardNumber as any,
    isAuto: cleanFields.isAuto as any,
  };
  // CF-SUGGESTER-YEAR-GUARD (Drew, 2026-07-20). Reject candidates whose
  // year is more than 3 off from the holding's year. Real bug: a 1991
  // Andy Van Slyke card in Drew's holdings matched a 2026 Topps
  // candidate because cardNumber overlapped ("91A-AVS"). Year is
  // authoritative when BOTH sides have it — a 35-year gap is never a
  // signal to trust. When either side lacks year, don't reject
  // (compat with older cards where year is missing in one source).
  const holdingYear = typeof holdingForScoring.cardYear === "number" && holdingForScoring.cardYear >= 1900
    ? holdingForScoring.cardYear
    : null;
  const filteredByYear = holdingYear
    ? merged.filter((c) => {
        const cYear = (() => {
          if (c.year != null && c.year !== "") {
            const n = Number(c.year);
            if (Number.isFinite(n) && n >= 1900) return n;
          }
          const m = String(c.set ?? c.title ?? "").match(/\b(19|20)\d{2}\b/);
          return m ? Number(m[0]) : null;
        })();
        if (cYear === null) return true;   // candidate lacks year signal → keep
        return Math.abs(cYear - holdingYear) <= 3;
      })
    : merged;

  const scored = filteredByYear
    .map((c) => ({ candidate: c, match: scoreCandidate(c, holdingForScoring) }))
    // CF-SUGGEST-CANONICAL-ONLY: a canonical hiq: slug outranks a vendor id at
    // equal-or-lower score, so the option the user taps pins the catalog card.
    .sort((a, b) => {
      const canon = (x: { candidate?: { canonical?: boolean } }) => (x.candidate?.canonical ? 0 : 1);
      return canon(a) - canon(b) || b.match.score - a.match.score;
    });
  if (scored.length === 0) return null;    // year guard eliminated all candidates

  const top = scored[0];
  const confidence = Math.round(top.match.score * 100) / 100;
  const tier = tierForConfidence(confidence);

  // CF-CARDID-SUGGESTER-TOP-N (Drew, 2026-07-14): when the primary
  // suggestion isn't "high" tier, offer up to 2 alternatives so the user
  // resolves in one tap instead of falling to full-catalog search. Dedup
  // across vendors on the (year, number, parallel) key so a card that
  // both CH and CS surface only appears once. Also filter out alternatives
  // whose score is trivially low — they'd just clutter the sheet.
  const alternatives: Array<Omit<CardIdSuggestion, "alternatives">> = [];
  if (tier !== "high") {
    const primaryKey = crossVendorDedupKey(top.candidate);
    const primaryCardId = top.candidate.cardId;
    const seenAltKeys = new Set<string>([primaryKey]);
    for (let i = 1; i < scored.length && alternatives.length < ALTERNATIVE_MAX_COUNT; i++) {
      const s = scored[i];
      if (s.match.score < ALTERNATIVE_MIN_SCORE) break;
      if (s.candidate.cardId === primaryCardId) continue;
      const key = crossVendorDedupKey(s.candidate);
      if (seenAltKeys.has(key)) continue;
      seenAltKeys.add(key);
      const altConfidence = Math.round(s.match.score * 100) / 100;
      alternatives.push({
        ...wireIdOf(s.candidate),
        confidence: altConfidence,
        confidenceTier: tierForConfidence(altConfidence),
        candidateSource: s.candidate.source,
        matchBreakdown: {
          fieldsChecked: s.match.fieldsChecked,
          fieldsMatched: s.match.fieldsMatched,
          mismatchedFields: s.match.mismatched,
        },
        candidate: candidateContextOf(s.candidate),
      });
    }
  }

  // CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14): resolve
  // primary + alternatives against the Cosmos reference-catalog. Fires
  // in parallel; each lookup is process-cached after first hit so
  // repeated suggestions for the same (product, year) bucket are ~free.
  // Never blocks and never fails a suggestion — nulls flow through.
  //
  // CF-CATALOG-LOOKUP-USE-NORMALIZED (Drew, 2026-07-14): use the
  // NORMALIZED holding fields for the lookup, NOT the vendor's raw
  // strings. Vendor `candidate.set` is verbatim their internal name
  // ("2026 Bowman Baseball") including year prefix — slug never matches
  // the catalog's clean keys ("bowman"). Normalized fields have
  // year/subset noise stripped by R1/R3 and match the catalog's
  // canonical form. Vendor fields still fill in for parallel/year when
  // the normalizer didn't touch them.
  const primaryCatalogPromise = catalogVerifyCandidate(
    cleanFields.cardYear ?? (top.candidate.year != null ? Number(top.candidate.year) : undefined),
    cleanFields.setName ?? top.candidate.set,
    top.candidate.variant ?? cleanFields.parallel,
    holding.isAuto,
  );
  const altCatalogPromises = alternatives.map((a) =>
    catalogVerifyCandidate(
      cleanFields.cardYear ?? (a.candidate.year != null ? Number(a.candidate.year) : undefined),
      cleanFields.setName ?? a.candidate.set,
      a.candidate.variant ?? cleanFields.parallel,
      holding.isAuto,
    ),
  );
  const [primaryCatalog, ...altCatalogs] = await Promise.all([
    primaryCatalogPromise, ...altCatalogPromises,
  ]);
  // CF-CARDID-SUGGESTER-CATALOG-BOOST (Drew, 2026-07-14): apply boost
  // per catalog tier + recompute confidenceTier from the boosted value.
  // Alternatives boosted independently so a verified alt with a middling
  // field score can outrank a non-verified alt.
  for (let i = 0; i < alternatives.length; i++) {
    const cat = altCatalogs[i] ?? null;
    alternatives[i].catalogVerified = cat;
    const boostedAlt = applyCatalogBoost(alternatives[i].confidence, catalogConfidenceBoost(cat));
    if (boostedAlt !== alternatives[i].confidence) {
      alternatives[i].confidence = boostedAlt;
      alternatives[i].confidenceTier = tierForConfidence(boostedAlt);
    }
  }
  const boostedConfidence = applyCatalogBoost(confidence, catalogConfidenceBoost(primaryCatalog));
  // CF-SUGGESTER-PARALLEL-PENALTY (Drew, 2026-07-20). When the top
  // candidate has PARALLEL as a mismatched field, it means the picked
  // SKU is not the same parallel the user's title said — a very
  // strong wrong-attribution signal. Drop the tier down by one level
  // so iOS surfaces it as a review candidate instead of auto-applying.
  // Applies to the top pick only; alternatives keep their scored tier.
  const parallelMismatched = top.match.mismatched.includes("parallel");
  const rawTier = tierForConfidence(boostedConfidence);
  const boostedTier: SuggestionConfidenceTier = parallelMismatched
    ? (rawTier === "high" ? "medium" : rawTier === "medium" ? "low" : "low")
    : rawTier;

  return {
    ...wireIdOf(top.candidate),
    confidence: boostedConfidence,
    confidenceTier: boostedTier,
    candidateSource: top.candidate.source,
    matchBreakdown: {
      fieldsChecked: top.match.fieldsChecked,
      fieldsMatched: top.match.fieldsMatched,
      mismatchedFields: top.match.mismatched,
    },
    candidate: candidateContextOf(top.candidate),
    catalogVerified: primaryCatalog ?? null,
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
}

/** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a): the id half of the wire.
 *  `cardId` is present only for an hiq: slug; a vendor id is left off. */
function wireIdOf(c: CommonCandidate): { cardId?: string; idKind: SuggestionIdKind } {
  return c.idKind === "hiq" ? { cardId: c.cardId, idKind: "hiq" } : { idKind: "vendor" };
}

/** The candidate's descriptive context for the review sheet. A vendor id
 *  rides here as `vendorCardId` — context, never an identity. */
function candidateContextOf(c: CommonCandidate): CardIdSuggestion["candidate"] {
  return {
    title: c.title ?? c.name ?? undefined,
    set: c.set ?? undefined,
    year: c.year ?? undefined,
    number: c.number ?? undefined,
    variant: c.variant ?? undefined,
    image: c.image ?? undefined,
    ...(c.idKind === "vendor" ? { vendorCardId: c.cardId } : {}),
  };
}

// ─── Batch service ────────────────────────────────────────────────────────

import { readUserDoc, writeUserDoc } from "./portfolioStore.service.js";

export interface SuggestBatchSummary {
  processed: number;
  suggested: number;
  noCandidates: number;
  skipped: number;
  errors: number;
  /** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a): winners that carried only
   *  a vendor id. Counted in `suggested` (their context landed on the
   *  holding) but NO suggestedCardId was written for them. */
  vendorIdDropped: number;
}

/**
 * Whether the import already resolved and PINNED this holding's identity.
 *
 * The one bar, read from what `resolveImportIdentity` actually stamps when
 * `clearsIdentityBar` passes: the catalog verified the slug, and the slug is
 * there. A holding in that state has one identity and does not need a rival.
 */
function identityAlreadyPinned(h: unknown): boolean {
  const r = h as Record<string, unknown>;
  return r.catalogVerified === true
    && typeof r.catalogVerifiedSlug === "string"
    && (r.catalogVerifiedSlug as string).startsWith("hiq:");
}

/**
 * Iterate every pending-review holding under `userId` and apply a
 * suggestCardIdForHolding call to each. Skips holdings that already carry
 * a suggestedCardId (idempotent). Serializes the CH calls (concurrency
 * limited) so we don't fan out on rate limits.
 *
 * NEVER sets cardId — only suggestedCardId / suggestionConfidence / suggestionCandidate.
 */
export async function generateCardIdSuggestions(
  userId: string,
  opts: { force?: boolean; concurrency?: number } = {},
): Promise<SuggestBatchSummary> {
  const doc = await readUserDoc(userId);
  const summary: SuggestBatchSummary = {
    processed: 0,
    suggested: 0,
    noCandidates: 0,
    skipped: 0,
    errors: 0,
    vendorIdDropped: 0,
  };
  const holdings = Object.values(doc.holdings ?? {});
  const targets = holdings.filter(
    (h) =>
      (h as any).cardStatus === "pending-review" &&
      // CF-ONE-IMPORT-ONE-IDENTITY-STAYS-ONE (Drew, 2026-09-06, #1869). A
      // holding whose identity the import already RESOLVED and PINNED is not
      // a holding in want of a suggestion. Suggesting for it is what produced
      // the second identity #1869 was asked to remove.
      //
      // Measured read-only 2026-09-06, 5 of the 53 pending-review rows carry a
      // `suggestedCardId` that DISAGREES with their own `catalogVerifiedSlug`,
      // and every one disagrees the same way — the suggestion drops the
      // parallel and the print run:
      //
      //   verified  …:cpa-jwh:refractor:auto:num-499   suggested  …:cpa-jwh:base:auto
      //   verified  …:cpa-dt:blue-refractor:auto:num-150  suggested  …:cpa-dt:base:auto
      //   verified  …:cpa-tg:refractor:auto:num-499   suggested  …:cpa-tg:base:auto
      //
      // That is not a harmless second opinion. `confirmHoldingInDoc` auto-applies
      // a suggestion at confidence >= 0.55 when `cardId` is absent, and these
      // land at 1.0 — so a user pressing Confirm could move a /499 Refractor onto
      // the un-numbered Base identity, which is a DIFFERENT CARD with a different
      // pool. One import writes one identity (CF-ONE-IMPORT-ONE-IDENTITY, D9);
      // the suggester exists for the rows where that derivation could NOT reach
      // an answer, and those are exactly the rows it now runs on.
      //
      // The bar is the import's own pin gate, not a new one: `catalogVerified`
      // with a `catalogVerifiedSlug` is what `resolveImportIdentity` stamps when
      // `clearsIdentityBar` passes. `force` still overrides, so the repair lane
      // and an explicit re-suggest are unaffected.
      !identityAlreadyPinned(h) &&
      (opts.force || !(h as any).suggestedCardId),
  );
  summary.processed = targets.length;

  const cap = Math.max(1, Math.min(4, opts.concurrency ?? 3));
  const queue = [...targets];
  const workers: Promise<void>[] = [];
  const runWorker = async () => {
    while (queue.length > 0) {
      const h = queue.shift();
      if (!h) return;
      try {
        const suggestion = await suggestCardIdForHolding(h as PortfolioHolding);
        if (!suggestion) {
          summary.noCandidates += 1;
          continue;
        }
        // CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a): suggestedCardId is an
        // hiq: slug or absent. A vendor-id winner still lands its context
        // (suggestionCandidate.vendorCardId, candidateSource) for the sheet.
        if (suggestion.cardId) {
          (h as any).suggestedCardId = suggestion.cardId;
        } else {
          delete (h as any).suggestedCardId;
          summary.vendorIdDropped += 1;
        }
        (h as any).suggestionIdKind = suggestion.idKind;
        (h as any).suggestionConfidence = suggestion.confidence;
        (h as any).suggestionCandidate = suggestion.candidate;
        (h as any).suggestionConfidenceTier = suggestion.confidenceTier;
        (h as any).suggestionMatchBreakdown = suggestion.matchBreakdown;
        // CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): persist
        // which vendor sourced the primary suggestion + any alternatives
        // so the iOS review sheet can badge and offer one-tap picks.
        (h as any).suggestionCandidateSource = suggestion.candidateSource;
        if (suggestion.alternatives && suggestion.alternatives.length > 0) {
          (h as any).suggestionAlternatives = suggestion.alternatives;
        } else {
          // Clear any stale alternatives from a prior high-tier flip.
          delete (h as any).suggestionAlternatives;
        }
        // CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14)
        if (suggestion.catalogVerified) {
          (h as any).suggestionCatalogVerified = suggestion.catalogVerified;
        } else {
          delete (h as any).suggestionCatalogVerified;
        }
        (h as any).suggestionUpdatedAt = new Date().toISOString();
        (h as any).lastUpdated = new Date().toISOString();
        summary.suggested += 1;
      } catch {
        summary.errors += 1;
      }
    }
  };
  for (let i = 0; i < cap; i++) workers.push(runWorker());
  await Promise.all(workers);

  if (summary.suggested > 0) {
    await writeUserDoc(userId, doc);

    // CF-EBAY-PURCHASE-COMP-AUTO (Drew, 2026-07-18): emit
    // ebay-user-purchase sold_comps for the suggestions we just
    // persisted, gated on high/verified confidence tier so the pool
    // isn't polluted with speculative matches. Every user's eBay
    // purchases with a strong SKU signal now flow into the shared
    // pool automatically — no manual review required to seed data.
    // Mirrors the emit shape from ebayReviewQueue.service.ts:267-293
    // and ebayImportRematch.routes.ts. Fire-and-forget.
    // CF-A-SUGGESTION-IS-NOT-A-SALE (2026-08-29, checklist D7c). This used to
    // write a pool row under the CardHedge candidate id for every verified/high
    // suggestion -- a vendor-keyed comp for a purchase the import had already
    // written under its checklist slug. A suggestion lands on the holding for
    // the user to accept; the sale is written once, at import, by the one
    // writer.
    void targets;

  }
  return summary;
}
