/**
 * Beckett Card Dedup
 * ---------------------------------------------------------------------------
 * Beckett checklists list the same card on multiple sheets (e.g. a Prospect
 * Auto appears on `Prospects-Autos` AND on `Teams` AND on `Master`). The
 * Phase A parser returns every occurrence — Phase A.2 collapses them.
 *
 * Dedup key:
 *   `${set}::${cardNumber}::${playerName}::${isAutograph ? 'AU' : 'BASE'}`
 *
 * cardNumber missing (e.g. Buyback Auto subjects with no card number column)
 * falls back to:
 *   `${set}::__no_num__::${playerName}::${isAutograph ? 'AU' : 'BASE'}`
 *
 * Merge strategy:
 *   - Primary sheets (Base / Prospects / Autographs / Inserts) WIN over
 *     informational sheets (Teams / Master). Primary representation is
 *     preserved verbatim — `team`, `section`, `sheet`, `isRookie`,
 *     `isFirstBowman`, `extraMarkers` come from the primary occurrence.
 *   - For two same-priority occurrences, the earlier (lower `rowIndex` on
 *     the lower sheet index) wins. This makes the merge deterministic.
 *   - Merged-from occurrences are recorded under `mergedFrom` for audit.
 *
 * NOTE: parallel is NOT part of the dedup key here. In Beckett checklists,
 * each card row represents the base card; the parallels are listed once at
 * the section level and apply to every card in the section. The Phase B
 * expansion of `{card × parallel}` is intentionally OUT of scope for A.2.
 */

import type {
  BeckettChecklistParsed,
  ParsedCard,
} from "./beckettChecklistParser.js";

export interface DedupedCard {
  /** Stable dedup key (see header). */
  key: string;
  /** Set label injected by the orchestrator (e.g. "2022 Bowman Baseball"). */
  set: string;
  /** Card number as printed, or `null` (buyback). */
  cardNumber: string | null;
  /** Player or subject. */
  player: string | null;
  /** Team / affiliation (from primary occurrence). */
  team: string | null;
  isRookie: boolean;
  isFirstBowman: boolean;
  isAutograph: boolean;
  isRelic: boolean;
  inlinePrintRun: number | null;
  extraMarkers: string[];
  /** Section header from the primary occurrence. */
  section: string | null;
  /** Sheet name from the primary occurrence. */
  primarySheet: string;
  primaryRowIndex: number;
  /** Every (sheet, rowIndex) that resolved to this dedup key. */
  occurrences: Array<{ sheet: string; rowIndex: number; priority: number }>;
}

export interface DedupSummary {
  inputCardCount: number;
  outputCardCount: number;
  mergedCount: number;
  /** Set label injected at dedup time. */
  set: string;
}

export interface DedupResult {
  cards: DedupedCard[];
  summary: DedupSummary;
}

export interface DedupOptions {
  /** Set label stamped onto each output card (e.g. "2022 Bowman Baseball"). */
  set: string;
}

/**
 * Priority rank for a sheet — LOWER is more authoritative. Primary sheets
 * (Base, Prospects, Autographs, Inserts, Relics) outrank Teams/Master.
 *
 * The classifier is deliberately heuristic. Beckett's sheet names vary
 * widely; when in doubt we treat the sheet as primary (rank 1) so we never
 * drop a unique card.
 */
function sheetPriority(sheet: string): number {
  const s = sheet.toLowerCase();
  if (s.includes("master")) return 10;
  if (s === "teams" || s.endsWith(" teams") || s.includes("teams sets")) return 9;
  // Everything else is primary
  return 1;
}

function dedupKey(card: ParsedCard, set: string): string {
  const num = card.cardNumber?.trim() || "__no_num__";
  const player = (card.player ?? "").trim().toLowerCase();
  const auFlag = card.isAutograph ? "AU" : "BASE";
  return `${set}::${num}::${player}::${auFlag}`;
}

export function dedupCards(
  parsed: BeckettChecklistParsed,
  options: DedupOptions,
): DedupResult {
  const set = options.set;
  // Pre-sort input cards by (sheetPriority asc, sheetName, rowIndex) for
  // determinism so that ties always resolve the same way.
  const sorted = [...parsed.cards].sort((a, b) => {
    const pa = sheetPriority(a.sheet);
    const pb = sheetPriority(b.sheet);
    if (pa !== pb) return pa - pb;
    if (a.sheet !== b.sheet) return a.sheet.localeCompare(b.sheet);
    return a.rowIndex - b.rowIndex;
  });

  const buckets = new Map<string, DedupedCard>();

  for (const card of sorted) {
    // Skip rows that have neither a card number nor a player name. These
    // are diagnostics-only and would create spurious "__no_num__::" keys.
    if (!card.cardNumber && !card.player) continue;

    const key = dedupKey(card, set);
    const priority = sheetPriority(card.sheet);
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, {
        key,
        set,
        cardNumber: card.cardNumber,
        player: card.player,
        team: card.team,
        isRookie: card.isRookie,
        isFirstBowman: card.isFirstBowman,
        isAutograph: card.isAutograph,
        isRelic: card.isRelic,
        inlinePrintRun: card.inlinePrintRun,
        extraMarkers: [...card.extraMarkers],
        section: card.section,
        primarySheet: card.sheet,
        primaryRowIndex: card.rowIndex,
        occurrences: [
          { sheet: card.sheet, rowIndex: card.rowIndex, priority },
        ],
      });
      continue;
    }

    // Merge into existing entry
    existing.occurrences.push({ sheet: card.sheet, rowIndex: card.rowIndex, priority });

    // OR-merge boolean signals (Master sheet sometimes carries an RC flag
    // that a primary sheet missed, and vice-versa).
    if (card.isRookie) existing.isRookie = true;
    if (card.isFirstBowman) existing.isFirstBowman = true;
    // isAutograph / isRelic are part of the dedup key, can't drift
    // Team: prefer non-null
    if (!existing.team && card.team) existing.team = card.team;
    // inlinePrintRun: prefer non-null
    if (existing.inlinePrintRun == null && card.inlinePrintRun != null) {
      existing.inlinePrintRun = card.inlinePrintRun;
    }
    // extraMarkers: union
    for (const m of card.extraMarkers) {
      if (!existing.extraMarkers.includes(m)) existing.extraMarkers.push(m);
    }
    // primary fields (section / sheet / rowIndex) stay from the first
    // (lowest-priority-rank) occurrence — already correct because we
    // pre-sorted by priority asc.
  }

  // Stable output sort: primarySheet, primaryRowIndex.
  const cards = Array.from(buckets.values()).sort((a, b) => {
    if (a.primarySheet !== b.primarySheet) {
      return a.primarySheet.localeCompare(b.primarySheet);
    }
    return a.primaryRowIndex - b.primaryRowIndex;
  });

  return {
    cards,
    summary: {
      inputCardCount: parsed.cards.length,
      outputCardCount: cards.length,
      mergedCount: parsed.cards.length - cards.length,
      set,
    },
  };
}
