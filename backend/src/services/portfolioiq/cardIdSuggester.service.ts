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
import { searchCards, type CardHedgeCard } from "../compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../compiq/cardsightUuidSource.js";
import type { CardIdentity } from "../../types/cardIdentity.js";
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";

/**
 * CF-CARDID-SUGGESTER-CONFIDENCE-TIERING (2026-07-12): buckets iOS keys on
 * for the progressive-review UX. "high" → bulk auto-approve tier;
 * "medium" → quick individual review; "low" → manual catalog search.
 * Backend owns the thresholds so iOS stays semantic.
 */
export type SuggestionConfidenceTier = "high" | "medium" | "low";

export interface CardIdSuggestion {
  cardId: string;
  confidence: number;   // 0.0 - 1.0
  confidenceTier: SuggestionConfidenceTier;
  /** CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): which catalog
   *  the suggestion came from. iOS can badge or route accordingly.
   *  "cardhedge"       — CH search hit (bubble.io id)
   *  "cardsight-uuid"  — CS-native UUID hit (compound {parent}::{parallel})
   */
  candidateSource: "cardhedge" | "cardsight-uuid";
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
  if (fields.cardNumber) parts.push(`#${fields.cardNumber}`);
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
  /** Wire cardId — either CH's bubble.io id or CS's compound "{parent}::{parallel}". */
  cardId: string;
  source: "cardhedge" | "cardsight-uuid";
  title: string | null;
  name: string | null;
  set: string | null;
  year: number | string | null;
  number: string | null;
  variant: string | null;
  image: string | null;
}

function chToCommon(c: CardHedgeCard): CommonCandidate | null {
  if (!c.card_id) return null;
  return {
    cardId: c.card_id,
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
function csIdentityToCommon(c: CardIdentity): CommonCandidate | null {
  if (!c.candidateId) return null;
  const wireCardId = c.candidateId.startsWith("cardsight:")
    ? c.candidateId.slice("cardsight:".length)
    : c.candidateId;
  return {
    cardId: wireCardId,
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

  const check = (
    fieldName: string,
    weight: number,
    isPresent: boolean,
    isMatch: boolean,
  ) => {
    if (!isPresent) return;
    weightChecked += weight;
    fieldsChecked += 1;
    if (isMatch) {
      weightMatched += weight;
      fieldsMatched += 1;
    } else {
      mismatched.push(fieldName);
    }
  };

  // year
  const cYear = Number(candidate.year);
  check("cardYear", weights.year, !!holding.cardYear,
    !!holding.cardYear && Number.isFinite(cYear) && cYear === holding.cardYear);

  // cardNumber
  const cardNumberMatch = (() => {
    if (!holding.cardNumber || !candidate.number) return false;
    const a = String(holding.cardNumber).toLowerCase();
    const b = String(candidate.number).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  })();
  check("cardNumber", weights.cardNumber, !!holding.cardNumber, cardNumberMatch);

  // set
  const setMatch = (() => {
    if (!holding.setName || !candidate.set) return false;
    const a = String(holding.setName).toLowerCase();
    const b = String(candidate.set).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  })();
  check("setName", weights.setName, !!holding.setName, setMatch);

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
  check("parallel", weights.parallel, !!holding.parallel, parallelMatch);

  // player
  const playerMatch = (() => {
    if (!holding.playerName) return false;
    const candidateText = String(candidate.name ?? candidate.title ?? "").toLowerCase();
    return candidateText.includes(String(holding.playerName).toLowerCase());
  })();
  check("playerName", weights.playerName, !!holding.playerName, playerMatch);

  // isAuto — infer from candidate title/variant when CH shape doesn't
  // carry a dedicated flag. Title/variant contains "Auto"/"Autograph" →
  // candidate is an auto.
  const autoMatch = (() => {
    if (typeof holding.isAuto !== "boolean") return false;
    const candidateText = String(candidate.variant ?? candidate.title ?? "").toLowerCase();
    const candidateIsAuto = /\b(auto|autograph)\b/.test(candidateText);
    return candidateIsAuto === holding.isAuto;
  })();
  check("isAuto", weights.autoFlag, typeof holding.isAuto === "boolean", autoMatch);

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

const CS_SUGGESTER_ENABLED = true;
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
    const chPromise = Promise.race([
      searchCards(query, 5, strictFilters).catch(() => [] as CardHedgeCard[]),
      new Promise<CardHedgeCard[]>((_, reject) =>
        setTimeout(() => reject(new Error("ch suggester timeout")), SUGGESTER_TIMEOUT_MS),
      ),
    ]).catch(() => [] as CardHedgeCard[]);
    const csPromise: Promise<CardIdentity[]> = CS_SUGGESTER_ENABLED
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

  let { chRaw, csRaw } = await runStrict();
  let usedFilterMode: "strict" | "relaxed_retry" = "strict";

  // Opportunistic retry: if both vendors returned nothing AND we had a
  // set filter that could be dropped, try again without it. Cardsight
  // never uses `filters` (its fetch is free-text only) so this only
  // helps the CH path — but that's exactly where the set-format
  // mismatch bites.
  if (chRaw.length === 0 && csRaw.length === 0 && strictFilters.set) {
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
  const merged = [...chCommon, ...csCommon];

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
  const holdingForScoring: PortfolioHolding = {
    ...holding,
    playerName: cleanFields.playerName ?? holding.playerName,
    cardYear: cleanFields.cardYear ?? holding.cardYear,
    setName: cleanFields.setName ?? holding.setName,
    parallel: cleanFields.parallel ?? holding.parallel,
    cardNumber: cleanFields.cardNumber ?? holding.cardNumber,
    isAuto: cleanFields.isAuto ?? holding.isAuto,
  };
  const scored = merged
    .map((c) => ({ candidate: c, match: scoreCandidate(c, holdingForScoring) }))
    .sort((a, b) => b.match.score - a.match.score);

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
        cardId: s.candidate.cardId,
        confidence: altConfidence,
        confidenceTier: tierForConfidence(altConfidence),
        candidateSource: s.candidate.source,
        matchBreakdown: {
          fieldsChecked: s.match.fieldsChecked,
          fieldsMatched: s.match.fieldsMatched,
          mismatchedFields: s.match.mismatched,
        },
        candidate: {
          title: s.candidate.title ?? s.candidate.name ?? undefined,
          set: s.candidate.set ?? undefined,
          year: s.candidate.year ?? undefined,
          number: s.candidate.number ?? undefined,
          variant: s.candidate.variant ?? undefined,
          image: s.candidate.image ?? undefined,
        },
      });
    }
  }

  return {
    cardId: top.candidate.cardId,
    confidence,
    confidenceTier: tier,
    candidateSource: top.candidate.source,
    matchBreakdown: {
      fieldsChecked: top.match.fieldsChecked,
      fieldsMatched: top.match.fieldsMatched,
      mismatchedFields: top.match.mismatched,
    },
    candidate: {
      title: top.candidate.title ?? top.candidate.name ?? undefined,
      set: top.candidate.set ?? undefined,
      year: top.candidate.year ?? undefined,
      number: top.candidate.number ?? undefined,
      variant: top.candidate.variant ?? undefined,
      image: top.candidate.image ?? undefined,
    },
    ...(alternatives.length > 0 ? { alternatives } : {}),
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
  };
  const holdings = Object.values(doc.holdings ?? {});
  const targets = holdings.filter(
    (h) =>
      (h as any).cardStatus === "pending-review" &&
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
        (h as any).suggestedCardId = suggestion.cardId;
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
  }
  return summary;
}
