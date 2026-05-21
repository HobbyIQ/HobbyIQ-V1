/**
 * Adapter from the CompIQ pricing route's response shape to a
 * {@link CompLogEntry}. Lives alongside the comp_logs writer so route
 * files can stay thin: each call site captures the raw inputs once and
 * the shared telemetry helper (services/corpus/writeTelemetryEntries.ts)
 * dispatches both adapters.
 *
 * Field-mapping rules (one source of truth for the route → comp_log
 * transformation):
 *
 *   args.player                   → entry.player           (default "unknown")
 *   args.cardId                   → entry.cardId
 *   args.query                    → entry.query
 *   args.cardIdSource             → entry.cardIdSource
 *   args.endpoint                 → entry.endpoint
 *   args.durationMs               → entry.latency_ms
 *   args.parallel                 → entry.parallel
 *   args.grade                    → entry.grade
 *   args.isAuto                   → entry.isAuto
 *   args.result.fairMarketValueLive → entry.predictedPrice
 *   args.result.confidence        → entry.confidence
 *   args.result.source            → entry.sourceDetail (raw)
 *                                 → entry.source       (mapped 2-value)
 *                                 → entry.outcome      (mapped category)
 *   args.result.engineVersion     → entry.engineVersion
 *   args.result.recentComps[]     → entry.comps (max 20, price + soldDate)
 *                                 → entry.w7Count / w14Count / w30Count
 *                                 → entry.w7Avg / w14Avg / w30Avg
 *
 * @design D2 — schema is the W3 spec minimum plus the cohort-slicing
 *   fields (parallel, grade, isAuto, w7/14/30 count + avg).
 *
 * @design D4 — `source` is the spec's two-value field. `sourceDetail`
 *   is the raw computeEstimate() source so soak analysis can drill into
 *   the specific fallback reason without losing the partition.
 *
 * @design w7/14/30 stats are computed inline here (NOT pulled from the
 *   pricing engine) because the engine partitions comps as 14d-recent
 *   and 15-45d-older, not as 7/14/30. Inline computation keeps the
 *   comp_logs schema independent of the engine's internal windows.
 */

import {
  type CompLogEntry,
  type CompLogOutcome,
  type CompLogSource,
  type CompLogCardIdSource,
  type CompLogComp,
} from "../../models/compLogEntry.js";

const MAX_COMPS_PER_ENTRY = 20;
const MS_PER_DAY = 24 * 3600 * 1000;

interface PricingRouteResultShape {
  fairMarketValueLive?: number | null;
  confidence?: number | null;
  source?: string | null;
  engineVersion?: string | null;
  recentComps?: unknown;
}

export interface CompLogEntryFromPricingResultArgs {
  /** Lowercase player name slug, or null/empty (mapped to "unknown"). */
  player: string | null | undefined;
  /** Resolved Card Hedge / Cardsight card id, or null. */
  cardId: string | null | undefined;
  /**
   * Free-text query OR pinned card_id depending on the route. Stored
   * verbatim in entry.query (no querySource discriminator on
   * comp_logs — operational cohort table doesn't need it).
   */
  query: string;
  cardIdSource: CompLogCardIdSource | null | undefined;
  endpoint: string;
  durationMs: number;
  parallel: string | null | undefined;
  grade: string | null | undefined;
  isAuto: boolean;
  /**
   * Human-readable player name (original casing). Optional / backward
   * compatible — callers that don't supply it get a null on the entry.
   */
  playerName?: string | null | undefined;
  /**
   * Card release year. Optional / backward compatible. Accepts a number
   * or numeric string; coerced to a finite 4-digit number or null.
   */
  cardYear?: number | string | null | undefined;
  /** Route's JSON response object (post-cache). */
  result: PricingRouteResultShape | null | undefined;
}

/**
 * Map computeEstimate()'s raw `source` value to the W3 spec's
 * two-value source field.
 */
function mapSource(raw: string | null | undefined): CompLogSource {
  if (raw === "live" || raw === "cardsight") return "cardsight";
  return "fallback";
}

/**
 * Map computeEstimate()'s raw `source` value to the comp_logs
 * categorical outcome field.
 */
function mapOutcome(raw: string | null | undefined): CompLogOutcome {
  switch (raw) {
    case "live":
    case "cardsight":
    case "fallback":
      return "ok";
    case "no-recent-comps":
    case "no_recent_comps":
      return "no_recent_comps";
    case "neighbor-synthesis":
    case "neighbor_synthesis":
      return "neighbor_synthesis";
    case "unsupported_sport":
      return "unsupported_sport";
    case "variant-mismatch":
    case "variant_mismatch":
      return "variant_mismatch";
    case "error":
      return "error";
    default:
      return raw && raw.length === 0 ? "empty" : "ok";
  }
}

/**
 * Coerce one entry of the route's `recentComps` array to a slim
 * comp_log shape. Tolerant of missing fields so partial / malformed
 * comps don't break the writer.
 */
function coerceComp(raw: unknown): CompLogComp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const priceRaw = r.price ?? r.salePrice ?? r.amount;
  const price =
    typeof priceRaw === "number" && Number.isFinite(priceRaw)
      ? priceRaw
      : typeof priceRaw === "string" && priceRaw.trim() !== "" && Number.isFinite(Number(priceRaw))
        ? Number(priceRaw)
        : null;
  if (price === null) return null;
  const soldRaw = r.soldDate ?? r.saleDate ?? r.date ?? null;
  const soldDate = typeof soldRaw === "string" ? soldRaw : null;
  return { price, soldDate };
}

interface WindowStats {
  count: number | null;
  avg: number | null;
}

function statsForWindow(comps: CompLogComp[], days: number, now: number): WindowStats {
  const cutoff = now - days * MS_PER_DAY;
  let count = 0;
  let sum = 0;
  for (const c of comps) {
    if (!c.soldDate) continue;
    const t = Date.parse(c.soldDate);
    if (!Number.isFinite(t)) continue;
    if (t >= cutoff) {
      count += 1;
      sum += c.price;
    }
  }
  if (count === 0) return { count: 0, avg: null };
  return { count, avg: sum / count };
}

/**
 * Build a {@link CompLogEntry} from the inputs available at a CompIQ
 * route handler's response site.
 */
export function compLogEntryFromPricingResult(
  args: CompLogEntryFromPricingResultArgs,
  now: number = Date.now(),
): CompLogEntry {
  const result = args.result ?? {};

  // Coerce recentComps once; reuse for both the slim `comps` field and
  // the rolling-window stats.
  const recentRaw = Array.isArray(result.recentComps) ? result.recentComps : [];
  const allComps: CompLogComp[] = [];
  for (const r of recentRaw) {
    const c = coerceComp(r);
    if (c) allComps.push(c);
  }
  const comps = allComps.slice(0, MAX_COMPS_PER_ENTRY);

  const w7 = statsForWindow(allComps, 7, now);
  const w14 = statsForWindow(allComps, 14, now);
  const w30 = statsForWindow(allComps, 30, now);

  const sourceRaw = typeof result.source === "string" ? result.source : null;
  const playerRaw = typeof args.player === "string" ? args.player.trim() : "";

  // playerName: verbatim human-readable, trimmed; null when missing/empty.
  const playerNameRaw =
    typeof args.playerName === "string" ? args.playerName.trim() : "";
  const playerName = playerNameRaw === "" ? null : playerNameRaw;

  // cardYear: coerce number-or-string to a finite 4-digit number; null
  // when missing/unparseable/out-of-range.
  let cardYear: number | null = null;
  if (typeof args.cardYear === "number" && Number.isFinite(args.cardYear)) {
    cardYear = Math.trunc(args.cardYear);
  } else if (typeof args.cardYear === "string" && args.cardYear.trim() !== "") {
    const n = Number(args.cardYear);
    if (Number.isFinite(n)) cardYear = Math.trunc(n);
  }
  if (cardYear !== null && (cardYear < 1900 || cardYear > 2100)) cardYear = null;

  return {
    compLogSchemaVersion: 1,
    player: playerRaw === "" ? "unknown" : playerRaw.toLowerCase(),
    timestamp: now,
    latency_ms: args.durationMs,
    endpoint: args.endpoint,
    cardId: args.cardId ?? null,
    query: args.query,
    cardIdSource: args.cardIdSource ?? null,
    predictedPrice:
      typeof result.fairMarketValueLive === "number" && Number.isFinite(result.fairMarketValueLive)
        ? result.fairMarketValueLive
        : null,
    comps,
    confidence:
      typeof result.confidence === "number" && Number.isFinite(result.confidence)
        ? result.confidence
        : null,
    source: mapSource(sourceRaw),
    sourceDetail: sourceRaw,
    outcome: mapOutcome(sourceRaw),
    engineVersion:
      typeof result.engineVersion === "string" && result.engineVersion.length > 0
        ? result.engineVersion
        : "unknown",
    parallel: args.parallel ?? null,
    grade: args.grade ?? null,
    isAuto: args.isAuto,
    playerName,
    cardYear,
    w7Count: w7.count,
    w14Count: w14.count,
    w30Count: w30.count,
    w7Avg: w7.avg,
    w14Avg: w14.avg,
    w30Avg: w30.avg,
  };
}
