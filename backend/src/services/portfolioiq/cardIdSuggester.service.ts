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

export interface CardIdSuggestion {
  cardId: string;
  confidence: number;   // 0.0 - 1.0
  candidate: {
    title?: string;
    set?: string;
    year?: number | string;
    number?: string;
    variant?: string;
    image?: string;
  };
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
 * Score a CH candidate against the holding. Higher = better match. Used to
 * derive a confidence when CH returns multiple hits.
 *
 * Fields weighted:
 *   year match       — 30
 *   card # match     — 30
 *   parallel/variant — 10
 *   set substring    — 20
 *   player substring — 10
 */
function scoreCandidate(candidate: CardHedgeCard, holding: PortfolioHolding): number {
  let score = 0;
  const cYear = Number(candidate.year);
  if (holding.cardYear && Number.isFinite(cYear) && cYear === holding.cardYear) {
    score += 30;
  }
  if (holding.cardNumber && candidate.number) {
    const a = String(holding.cardNumber).toLowerCase();
    const b = String(candidate.number).toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) score += 30;
  }
  if (holding.parallel && candidate.variant) {
    const a = String(holding.parallel).toLowerCase();
    const b = String(candidate.variant).toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) score += 10;
  }
  if (holding.setName && candidate.set) {
    const a = String(holding.setName).toLowerCase();
    const b = String(candidate.set).toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) score += 20;
  }
  if (holding.playerName && (candidate.name || candidate.title)) {
    const a = String(holding.playerName).toLowerCase();
    const b = String(candidate.name ?? candidate.title ?? "").toLowerCase();
    if (b.includes(a)) score += 10;
  }
  return score;
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
    .map((c) => ({ candidate: c, score: scoreCandidate(c, holding) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top.candidate.card_id) return null;

  let confidence: number;
  if (scored.length === 1) {
    confidence = top.score >= 50 ? 0.9 : 0.6;
  } else {
    const raw = top.score / 100;
    confidence = Math.min(0.95, Math.max(0.4, raw));
  }

  return {
    cardId: top.candidate.card_id,
    confidence: Math.round(confidence * 100) / 100,
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
