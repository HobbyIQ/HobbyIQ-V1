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
 * Build a CH search query from the holding's structured fields. Deliberately
 * omits noisy tokens ("PSA 10", "GEM MINT") that CH doesn't index — those
 * are grader/grade filters, not search terms.
 */
function buildQuery(holding: PortfolioHolding): string {
  const parts: string[] = [];
  if (holding.cardYear) parts.push(String(holding.cardYear));
  if (holding.setName) parts.push(holding.setName);
  if (holding.playerName) parts.push(holding.playerName);
  if (holding.parallel) parts.push(holding.parallel);
  if (holding.cardNumber) parts.push(`#${holding.cardNumber}`);
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

function scoreCandidate(candidate: CardHedgeCard, holding: PortfolioHolding): FieldMatchResult {
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

  // parallel/variant
  const parallelMatch = (() => {
    if (!holding.parallel || !candidate.variant) return false;
    const a = String(holding.parallel).toLowerCase();
    const b = String(candidate.variant).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
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
export async function suggestCardIdForHolding(
  holding: PortfolioHolding,
): Promise<CardIdSuggestion | null> {
  if (!holding.playerName) return null;
  const query = buildQuery(holding);
  if (!query.trim()) return null;

  const filters = {
    player: holding.playerName,
    set: holding.setName,
    rookie: (holding as any).isRookie ? "Rookie" : undefined,
  };

  let candidates: CardHedgeCard[];
  try {
    // Hard timeout so a slow / stuck CH call can never hang the batch. 8s
    // matches the batch-wall-time budget for 36 holdings @ concurrency 3.
    candidates = await Promise.race([
      searchCards(query, 5, filters),
      new Promise<CardHedgeCard[]>((_, reject) =>
        setTimeout(() => reject(new Error("suggester timeout")), 8_000),
      ),
    ]);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "card_id_suggester_error",
        source: "cardIdSuggester.service",
        holdingId: holding.id,
        error: (err as Error)?.message ?? String(err),
      }),
    );
    return null;
  }
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({ candidate: c, match: scoreCandidate(c, holding) }))
    .sort((a, b) => b.match.score - a.match.score);

  const top = scored[0];
  if (!top.candidate.card_id) return null;

  const confidence = Math.round(top.match.score * 100) / 100;
  return {
    cardId: top.candidate.card_id,
    confidence,
    confidenceTier: tierForConfidence(confidence),
    matchBreakdown: {
      fieldsChecked: top.match.fieldsChecked,
      fieldsMatched: top.match.fieldsMatched,
      mismatchedFields: top.match.mismatched,
    },
    candidate: {
      title: top.candidate.title ?? top.candidate.name,
      set: top.candidate.set,
      year: top.candidate.year,
      number: top.candidate.number,
      variant: top.candidate.variant,
      image: top.candidate.image,
    },
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
