/**
 * Shared CompIQ telemetry helper.
 *
 * Drives BOTH the corpus writer (compiq_corpus, ML training table) and
 * the comp_logs writer (operational/cohort table) from a single capture
 * shape, so the 5 prediction-route call sites only need to carry one
 * import and one fire-and-forget call:
 *
 *   void writeTelemetryEntries({
 *     query, querySource, endpoint, durationMs, result,
 *     player, cardId, cardIdSource, parallel, grade, isAuto,
 *   });
 *
 * Each writer applies its own gating internally (independent
 * COMPIQ_CORPUS_* and COMPIQ_COMP_LOGS_* env vars per design decision
 * D3). When both writers are gated off, the only wasted work is two
 * cheap entry-builder calls — neither writer touches Cosmos.
 *
 * Locality choice: this helper lives under services/corpus/ so the
 * existing PR #102 corpus surface stays the canonical entry point;
 * services/compLogs/ exposes only the writer + adapter, and this
 * helper imports both adapters. Reviewers diffing against PR #102 see
 * the corpus surface unchanged plus this one new file.
 */

import { writeCorpusEntry } from "./writeCorpusEntry.js";
import {
  corpusEntryFromPricingResult,
  type CorpusEntryFromPricingResultArgs,
} from "./corpusMapping.js";
import { writeCompLog } from "../compLogs/writeCompLog.js";
import {
  compLogEntryFromPricingResult,
  type CompLogEntryFromPricingResultArgs,
} from "../compLogs/compLogMapping.js";
import type { CompLogCardIdSource } from "../../models/compLogEntry.js";

/**
 * Extract the comp_log cohort fields (player, cardId, cardIdSource,
 * parallel, grade, isAuto) from a pricing route's response object.
 * Centralizes the read paths so call sites only have to import one
 * helper and one extractor.
 *
 * Read paths:
 *   - /search and /price: result.parsedQuery.{playerName,parallel,
 *     isAuto,grade,gradingCompany} present.
 *   - /price-by-id and /bulk: parsedQuery is NOT in the response.
 *     player is read from result.cardIdentity.player; cohort fields
 *     are best-effort (null/false).
 *
 * The fallbackQuery is used when neither parsedQuery nor cardIdentity
 * yield a player — e.g. a bulk query string the engine couldn't parse.
 *
 * @param result the route's JSON response object (post-cacheWrap)
 * @param fallbackQuery the user-facing query string for player fallback
 * @param cardIdSourceHint forces the cardIdSource discriminator. Use
 *   "cardhedge" for /price-by-id (request is pinned to a Card Hedge
 *   card_id). Default behaviour: "cardhedge" when a cardId is present,
 *   null otherwise.
 */
export function extractTelemetryCohortFromResult(
  result: unknown,
  fallbackQuery: string,
  cardIdSourceHint?: CompLogCardIdSource,
): Pick<
  CompLogEntryFromPricingResultArgs,
  "player" | "cardId" | "cardIdSource" | "parallel" | "grade" | "isAuto"
> {
  const r = (result ?? {}) as Record<string, unknown>;
  const parsed = (r.parsedQuery ?? {}) as Record<string, unknown>;
  const identity = (r.cardIdentity ?? {}) as Record<string, unknown>;

  const playerFromParsed =
    typeof parsed.playerName === "string" ? parsed.playerName : null;
  const playerFromIdentity =
    typeof identity.player === "string" ? identity.player : null;
  const player =
    (playerFromParsed && playerFromParsed.trim()) ||
    (playerFromIdentity && playerFromIdentity.trim()) ||
    fallbackQuery ||
    null;

  const cardId =
    typeof identity.cardId === "string" && identity.cardId.length > 0
      ? identity.cardId
      : null;

  const gradeFromParsed =
    typeof parsed.grade === "string" && parsed.grade.length > 0
      ? parsed.grade
      : null;
  const gradingCompany =
    typeof parsed.gradingCompany === "string" ? parsed.gradingCompany : null;
  const grade =
    gradeFromParsed && gradingCompany
      ? `${gradingCompany} ${gradeFromParsed}`
      : (gradeFromParsed ?? null);

  const parallel =
    typeof parsed.parallel === "string" && parsed.parallel.length > 0
      ? parsed.parallel
      : null;

  const isAuto = parsed.isAuto === true;

  const cardIdSource: CompLogCardIdSource | null =
    cardIdSourceHint ?? (cardId ? "cardhedge" : null);

  return { player, cardId, cardIdSource, parallel, grade, isAuto };
}

/**
 * Union of the corpus + comp_log adapter inputs. Callers carry one
 * struct through the route handler and pass it here.
 */
export interface TelemetryCaptureArgs
  extends CorpusEntryFromPricingResultArgs,
    Pick<
      CompLogEntryFromPricingResultArgs,
      "player" | "cardId" | "cardIdSource" | "parallel" | "grade" | "isAuto"
    > {}

/**
 * Build both telemetry rows and dispatch to both writers. Returns
 * synchronously. Errors inside either writer are absorbed by that
 * writer's own throttled error log.
 */
export function writeTelemetryEntries(args: TelemetryCaptureArgs): void {
  // Build entries first; both builders are pure and cheap. Each writer
  // then runs its own gate (disabled-flag, sample rate) before any
  // Cosmos work.
  const corpusEntry = corpusEntryFromPricingResult({
    query: args.query,
    querySource: args.querySource,
    endpoint: args.endpoint,
    durationMs: args.durationMs,
    result: args.result,
  });

  const compLogEntry = compLogEntryFromPricingResult({
    query: args.query,
    endpoint: args.endpoint,
    durationMs: args.durationMs,
    result: args.result,
    player: args.player,
    cardId: args.cardId,
    cardIdSource: args.cardIdSource,
    parallel: args.parallel,
    grade: args.grade,
    isAuto: args.isAuto,
  });

  writeCorpusEntry(corpusEntry);
  writeCompLog(compLogEntry);
}
