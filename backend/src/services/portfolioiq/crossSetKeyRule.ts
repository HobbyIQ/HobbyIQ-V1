/**
 * CF-CROSS-SETKEY-STAYS-HOME (D4 PR 5, 2026-08-29).
 *
 * The pure rule behind hobbyIqFmv's `cross-setkey` rung. The rung exists
 * for ingest fragmentation — one physical card stored under two product
 * slugs ("bowman-chrome" vs "bowman-chrome-prospects") — and it used to
 * accept ANY setKey with the same (year, cardNumber, isAuto, sport,
 * parallel). That is how the wrong card got in:
 *
 *   - card numbers are initials, so CPA-MG is one player in Bowman Chrome
 *     and a different player in the next product
 *     (project_beckett_initials_card_numbers_collide);
 *   - Bowman paper and Bowman Chrome share a checklist and are different
 *     cards at different prices (project_bowman_setkey_taxonomy — Drew:
 *     never merge them; sapphire is its own checklist);
 *   - a /75 is not a /50.
 *
 * So a comp may cross a setKey only when ALL of these hold:
 *   1. its slug parses and names the same sport / year / cardNumber /
 *      isAuto (slug segments, never row fields);
 *   2. its setKey is in the target's PRODUCT FAMILY (productFamily.service:
 *      bowman-chrome-* <-> bowman-chrome; bowman <-> bowman-chrome refused;
 *      sapphire never crosses);
 *   3. its parallel slug equals the target's;
 *   4. its print run does not contradict the target's (a comp with no
 *      print run is unknown, not contradicting);
 *   5. its player (folded) equals the target's player (folded).
 * And when the target's player is not known at all, the rung is REFUSED —
 * a cross-product comp cannot be verified, so it is not used.
 */

import { normalizePlayerName } from "../compiq/parallelTokenizer.js";
import { parseHobbyIqCardId, sameCardNumber } from "./hobbyIqCardId.service.js";
import { productFamilyKey, sameProductFamily } from "./productFamily.service.js";

const GENERATIONAL_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Fold a player name for equality: vendor tokens stripped
 * (normalizePlayerName), diacritics removed, lower-cased, punctuation
 * dropped ("Marconi German," -> "marconi german"), whitespace collapsed,
 * a trailing generational suffix removed. Empty string when nothing is
 * left.
 */
export function foldPlayerName(name: string | null | undefined): string {
  const cleaned = normalizePlayerName(name ?? "");
  if (!cleaned) return "";
  const tokens = cleaned
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

export interface CrossSetKeyRow {
  hobbyiqCardId?: string | null;
  parallel?: string | null;
  printRun?: number | null;
  playerName?: string | null;
}

/** The most common folded player name among rows, or null when none of
 *  them names a player. Used to learn the target's player from its own
 *  exact-slug pool when the caller did not say. */
export function majorityPlayerFold(rows: ReadonlyArray<CrossSetKeyRow>): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const f = foldPlayerName(r.playerName);
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [f, n] of counts) {
    if (n > bestN) { best = f; bestN = n; }
  }
  return best;
}

export interface CrossSetKeyTarget {
  sport: string;
  year: number;
  setKey: string;
  cardNumber: string;
  isAuto: boolean;
  /** Parallel as a slug fragment (parsed.parallel). */
  parallel: string;
  printRun: number | null;
  /** foldPlayerName(...) of the target's player; null/empty = unknown. */
  playerFold: string | null;
}

export interface CrossSetKeyExclusions {
  noSlug: number;
  otherIdentity: number;
  otherFamily: number;
  otherParallel: number;
  otherPrintRun: number;
  otherPlayer: number;
}

export interface CrossSetKeyVerdict<R extends CrossSetKeyRow> {
  kept: R[];
  /** Non-null when the rung may not run at all. */
  refused: "no-player" | null;
  excluded: CrossSetKeyExclusions;
}

/**
 * Keep only the comps the cross-setkey rung may price from. Pure; the
 * caller applies the grade filter afterwards, as every rung does.
 */
export function filterCrossSetKeyComps<R extends CrossSetKeyRow>(
  target: CrossSetKeyTarget,
  rows: ReadonlyArray<R>,
): CrossSetKeyVerdict<R> {
  const excluded: CrossSetKeyExclusions = {
    noSlug: 0, otherIdentity: 0, otherFamily: 0, otherParallel: 0, otherPrintRun: 0, otherPlayer: 0,
  };
  const playerFold = target.playerFold ? target.playerFold : null;
  if (!playerFold) {
    return { kept: [], refused: "no-player", excluded };
  }
  const kept: R[] = [];
  for (const r of rows) {
    const comp = typeof r.hobbyiqCardId === "string" ? parseHobbyIqCardId(r.hobbyiqCardId) : null;
    if (!comp) { excluded.noSlug++; continue; }
    // Card numbers compare hyphen- and case-insensitively (D23, ruling d):
    // a bccp bd152 comp is the checklist's BD-152 card.
    if (
      comp.sport !== target.sport
      || comp.year !== target.year
      || !sameCardNumber(comp.cardNumber, target.cardNumber)
      || comp.isAuto !== target.isAuto
    ) { excluded.otherIdentity++; continue; }
    if (!sameProductFamily(target.setKey, comp.setKey)) { excluded.otherFamily++; continue; }
    // The SLUG's parallel, not the row's field — rows disagree with
    // themselves often enough that a field match is meaningless.
    if (comp.parallel !== target.parallel) { excluded.otherParallel++; continue; }
    const compPrintRun = comp.printRun ?? (typeof r.printRun === "number" && Number.isFinite(r.printRun) ? r.printRun : null);
    if (target.printRun !== null && compPrintRun !== null && compPrintRun !== target.printRun) {
      excluded.otherPrintRun++; continue;
    }
    if (foldPlayerName(r.playerName) !== playerFold) { excluded.otherPlayer++; continue; }
    kept.push(r);
  }
  return { kept, refused: null, excluded };
}

/**
 * The rung's basis note: which comps, from which setKeys, for which
 * player, and what was turned away. Prose for the holding; the label is
 * the rung name.
 */
export function describeCrossSetKeyPool(
  target: Pick<CrossSetKeyTarget, "setKey" | "playerFold">,
  kept: ReadonlyArray<CrossSetKeyRow>,
  excluded: CrossSetKeyExclusions,
): string {
  const bySetKey = new Map<string, number>();
  for (const r of kept) {
    const comp = typeof r.hobbyiqCardId === "string" ? parseHobbyIqCardId(r.hobbyiqCardId) : null;
    const k = comp?.setKey ?? "?";
    bySetKey.set(k, (bySetKey.get(k) ?? 0) + 1);
  }
  const setKeys = [...bySetKey.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ×${n}`)
    .join(", ");
  const turnedAway = (Object.entries(excluded) as Array<[keyof CrossSetKeyExclusions, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/^other/, "other-").toLowerCase()}`)
    .join(", ");
  const n = kept.length;
  return `Estimated from ${n} sale${n === 1 ? "" : "s"} of this exact card within the ${productFamilyKey(target.setKey)} family (${setKeys}; player ${target.playerFold ?? "?"})`
    + (turnedAway ? `; excluded ${turnedAway}` : "");
}
