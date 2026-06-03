// CF-ML-MOAT-OUTCOMES (2026-06-03): scheduled prediction-outcome capture.
//
// Mirrors the dailyiq.job pattern: in-process setTimeout to next 05:45 PT,
// then setInterval(24h). Configurable via env:
//   PREDICTION_OUTCOMES_JOB_HOUR        (default 5)
//   PREDICTION_OUTCOMES_JOB_MINUTE      (default 45)
//   PREDICTION_OUTCOMES_JOB_TIMEZONE    (default America/Los_Angeles)
//   PREDICTION_OUTCOMES_DISABLE_SCHEDULER=true to disable
//
// Other knobs:
//   PREDICTION_OUTCOMES_HORIZON_DAYS       (default 7)
//   PREDICTION_OUTCOMES_INGESTION_BUFFER_DAYS (default 2)
//   CARDSIGHT_OUTCOME_CALLS_PER_RUN_MAX   (default 50)
//
// Per-run log shape (greppable):
//   [predictionOutcomesCapture] done candidates=N processed=M
//     captured.graded=X captured.raw=Y captured.no_sales=Z
//     captured.not_found=A captured.upstream_error=B
//     tuples_now_complete=T cardsight_calls_used=C deferred_by_cap=D
//     duration_ms=...

import {
  captureOutcome,
  findCandidates,
  type CaptureResult,
  type OutcomeSource,
} from "../services/outcomes/predictionOutcomes.service.js";
import { randomUUID } from "crypto";

const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_INGESTION_BUFFER_DAYS = 2;
const DEFAULT_CALLS_PER_RUN_MAX = 50;

interface RunSummary {
  candidatesScanned: number;
  processed: number;
  capturedBySource: Record<OutcomeSource, number>;
  tuplesNowComplete: number;
  cardsightCallsUsed: number;
  deferredByCap: number;
  durationMs: number;
  runId: string;
}

function emptySourceCounts(): Record<OutcomeSource, number> {
  return {
    cardsight_graded_window: 0,
    cardsight_raw_window: 0,
    no_sales_in_window: 0,
    not_found: 0,
    upstream_error: 0,
  };
}

function msUntilNextRun(hour: number, minute: number, tz: string): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const localNowMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const tzOffsetMs = localNowMs - now.getTime();
  let targetLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    0,
  );
  if (targetLocal <= localNowMs) {
    targetLocal += 24 * 60 * 60 * 1000;
  }
  return targetLocal - tzOffsetMs - now.getTime();
}

export async function runPredictionOutcomesCaptureJob(opts?: {
  horizonDays?: number;
  ingestionBufferDays?: number;
  callsPerRunMax?: number;
  now?: Date;
}): Promise<RunSummary> {
  const start = Date.now();
  const runId = randomUUID();
  const horizonDays =
    opts?.horizonDays ??
    Number(process.env.PREDICTION_OUTCOMES_HORIZON_DAYS ?? DEFAULT_HORIZON_DAYS);
  const ingestionBufferDays =
    opts?.ingestionBufferDays ??
    Number(
      process.env.PREDICTION_OUTCOMES_INGESTION_BUFFER_DAYS ??
        DEFAULT_INGESTION_BUFFER_DAYS,
    );
  const callsPerRunMax =
    opts?.callsPerRunMax ??
    Number(
      process.env.CARDSIGHT_OUTCOME_CALLS_PER_RUN_MAX ?? DEFAULT_CALLS_PER_RUN_MAX,
    );
  const engineVersion = process.env.GIT_SHA_SHORT ?? process.env.GIT_SHA ?? "unknown";
  const now = opts?.now ?? new Date();

  console.log(
    `[predictionOutcomesCapture] start runId=${runId} horizonDays=${horizonDays} ` +
      `ingestionBufferDays=${ingestionBufferDays} callsPerRunMax=${callsPerRunMax}`,
  );

  let candidates;
  try {
    candidates = await findCandidates({
      horizonDays,
      ingestionBufferDays,
      now,
    });
  } catch (err: any) {
    console.error(
      "[predictionOutcomesCapture] findCandidates threw:",
      err?.message ?? err,
    );
    return {
      candidatesScanned: 0,
      processed: 0,
      capturedBySource: emptySourceCounts(),
      tuplesNowComplete: 0,
      cardsightCallsUsed: 0,
      deferredByCap: 0,
      durationMs: Date.now() - start,
      runId,
    };
  }

  const capturedBySource = emptySourceCounts();
  let processed = 0;
  let cardsightCallsUsed = 0;
  let deferredByCap = 0;

  for (const prediction of candidates) {
    if (cardsightCallsUsed >= callsPerRunMax) {
      deferredByCap = candidates.length - processed;
      console.log(
        `[predictionOutcomesCapture] per-run cap reached at calls=${cardsightCallsUsed}; ` +
          `${deferredByCap} candidates deferred to next run`,
      );
      break;
    }
    let result: CaptureResult;
    try {
      result = await captureOutcome(prediction, {
        horizonDays,
        runId,
        engineVersion,
        now,
      });
    } catch (err: any) {
      console.error(
        `[predictionOutcomesCapture] captureOutcome threw for predictionId=${prediction.id}:`,
        err?.message ?? err,
      );
      processed++;
      continue;
    }
    processed++;
    cardsightCallsUsed += result.cardsightCallsUsed;
    capturedBySource[result.outcomeSource] += 1;
  }

  const tuplesNowComplete =
    capturedBySource.cardsight_graded_window + capturedBySource.cardsight_raw_window;
  const durationMs = Date.now() - start;

  console.log(
    `[predictionOutcomesCapture] done candidates=${candidates.length} processed=${processed} ` +
      `captured.graded=${capturedBySource.cardsight_graded_window} ` +
      `captured.raw=${capturedBySource.cardsight_raw_window} ` +
      `captured.no_sales=${capturedBySource.no_sales_in_window} ` +
      `captured.not_found=${capturedBySource.not_found} ` +
      `captured.upstream_error=${capturedBySource.upstream_error} ` +
      `tuples_now_complete=${tuplesNowComplete} ` +
      `cardsight_calls_used=${cardsightCallsUsed} ` +
      `deferred_by_cap=${deferredByCap} ` +
      `duration_ms=${durationMs}`,
  );

  return {
    candidatesScanned: candidates.length,
    processed,
    capturedBySource,
    tuplesNowComplete,
    cardsightCallsUsed,
    deferredByCap,
    durationMs,
    runId,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let _scheduleTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export function startPredictionOutcomesCaptureJob(): void {
  if (process.env.PREDICTION_OUTCOMES_DISABLE_SCHEDULER === "true") {
    console.log("[predictionOutcomesCapture] scheduler disabled via env");
    return;
  }
  if (_scheduleTimer || _intervalTimer) {
    console.warn(
      "[predictionOutcomesCapture] scheduler already running; ignoring duplicate start",
    );
    return;
  }
  const hour = Number(process.env.PREDICTION_OUTCOMES_JOB_HOUR ?? "5");
  const minute = Number(process.env.PREDICTION_OUTCOMES_JOB_MINUTE ?? "45");
  const tz = process.env.PREDICTION_OUTCOMES_JOB_TIMEZONE ?? "America/Los_Angeles";
  const delay = msUntilNextRun(hour, minute, tz);
  console.log(
    `[predictionOutcomesCapture] scheduling first run in ${Math.round(
      delay / 1000 / 60,
    )} min (target ${hour}:${String(minute).padStart(2, "0")} ${tz})`,
  );
  _scheduleTimer = setTimeout(() => {
    runPredictionOutcomesCaptureJob().catch((err) => {
      console.error(
        "[predictionOutcomesCapture] runPredictionOutcomesCaptureJob threw:",
        err?.message ?? err,
      );
    });
    _intervalTimer = setInterval(() => {
      runPredictionOutcomesCaptureJob().catch((err) => {
        console.error(
          "[predictionOutcomesCapture] runPredictionOutcomesCaptureJob threw:",
          err?.message ?? err,
        );
      });
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

export function stopPredictionOutcomesCaptureJob(): void {
  if (_scheduleTimer) {
    clearTimeout(_scheduleTimer);
    _scheduleTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}
