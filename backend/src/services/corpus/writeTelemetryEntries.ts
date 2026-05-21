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
