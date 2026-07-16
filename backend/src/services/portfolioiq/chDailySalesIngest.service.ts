// CF-CH-DAILY-EXPORT-INGEST (Drew, 2026-07-16). Orchestrator that
// downloads the CH daily CSV, parses row-by-row, and batch-upserts to
// the ch_daily_sales container. Idempotent by price_history_id →
// safe to re-run any date any number of times.
//
// Called from:
//   1. backend/scripts/ingest-ch-daily-sales.cjs (the GitHub Actions
//      workflow runner). Standalone; no server dependency.
//   2. Future: an in-app POST /api/admin/ch-daily-sales/ingest that
//      lets Drew force a re-run of a specific date from the app.
//      Not built in this PR — the workflow is the primary path.

import {
  downloadDailyPriceExport,
  parseDailyExportStream,
} from "../compiq/cardhedgeDailyExport.client.js";
import {
  upsertDailySalesBatch,
  writeIngestCheckpoint,
  readIngestCheckpoint,
} from "./chDailySalesStore.service.js";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";

export interface IngestOptions {
  /** YYYY-MM-DD; defaults to yesterday UTC (CH publishes files after midnight). */
  fileDate?: string;
  /** Overrides CARD_HEDGE_API_KEY. */
  apiKey?: string;
  /** Rows per Cosmos batch. Default 500 balances RU pressure vs pipeline stall. */
  batchSize?: number;
  /** Skip if a completed checkpoint already exists for the date. Default true. */
  skipIfCompleted?: boolean;
  /** Cap total rows processed (smoke-test). Default null = unlimited. */
  rowLimit?: number | null;
}

export interface IngestResult {
  fileDate: string;
  skipped: boolean;
  skipReason?: string;
  httpStatus?: number;
  csvSizeBytes: number | null;
  rowsSeen: number;
  rowsUpserted: number;
  rowsFailed: number;
  firstError: string | null;
  elapsedMs: number;
}

/** Yesterday UTC in YYYY-MM-DD. Used as the default target date. */
function defaultFileDate(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

export async function runDailySalesIngest(opts: IngestOptions = {}): Promise<IngestResult> {
  const fileDate = opts.fileDate ?? defaultFileDate();
  const batchSize = Math.max(1, Math.min(2000, opts.batchSize ?? 500));
  const skipIfCompleted = opts.skipIfCompleted !== false;
  const rowLimit = opts.rowLimit ?? null;
  const t0 = Date.now();

  console.log(JSON.stringify({
    event: "ch_daily_sales_ingest_start",
    source: "chDailySalesIngest.service",
    fileDate,
    batchSize,
    skipIfCompleted,
    rowLimit,
  }));

  if (skipIfCompleted) {
    const prior = await readIngestCheckpoint(fileDate);
    if (prior && prior.rowsUpserted > 0 && !prior.firstError) {
      console.log(JSON.stringify({
        event: "ch_daily_sales_ingest_skipped",
        source: "chDailySalesIngest.service",
        fileDate,
        reason: "checkpoint_exists",
        priorUpserted: prior.rowsUpserted,
        priorCompletedAt: prior.completedAt,
      }));
      return {
        fileDate,
        skipped: true,
        skipReason: "checkpoint_exists",
        csvSizeBytes: prior.csvSizeBytes,
        rowsSeen: 0,
        rowsUpserted: 0,
        rowsFailed: 0,
        firstError: null,
        elapsedMs: Date.now() - t0,
      };
    }
  }

  const dl = await downloadDailyPriceExport(fileDate, {
    apiKey: opts.apiKey,
    // Longer timeout tolerates cold CH edge on a 40 MB file.
    timeoutMs: 120_000,
  });

  if (dl.status !== 200 || !dl.bodyStream) {
    console.warn(JSON.stringify({
      event: "ch_daily_sales_ingest_download_failed",
      source: "chDailySalesIngest.service",
      fileDate,
      httpStatus: dl.status,
    }));
    return {
      fileDate,
      skipped: true,
      skipReason: `http_${dl.status}`,
      httpStatus: dl.status,
      csvSizeBytes: null,
      rowsSeen: 0,
      rowsUpserted: 0,
      rowsFailed: 0,
      firstError: `download returned HTTP ${dl.status}`,
      elapsedMs: Date.now() - t0,
    };
  }

  // Accumulate rows in a bounded buffer; flush on threshold. Streaming
  // upserts smooth Cosmos RU pressure vs one giant Promise.all(78k).
  let rowsSeen = 0;
  let rowsUpserted = 0;
  let rowsFailed = 0;
  let firstError: string | null = null;
  let buffer: CHDailySaleRow[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const res = await upsertDailySalesBatch(batch);
    rowsUpserted += res.upserted;
    rowsFailed += res.failed;
    if (!firstError && res.firstError) firstError = res.firstError;
  };

  const parseRes = await parseDailyExportStream(dl.bodyStream, async (row) => {
    if (rowLimit && rowsSeen >= rowLimit) return;
    rowsSeen++;
    buffer.push(row);
    if (buffer.length >= batchSize) await flush();
  });
  await flush();

  if (parseRes.firstError && !firstError) firstError = parseRes.firstError;

  await writeIngestCheckpoint({
    fileDate,
    rowsUpserted,
    rowsFailed,
    csvSizeBytes: dl.contentLength,
    firstError,
  });

  const result: IngestResult = {
    fileDate,
    skipped: false,
    httpStatus: 200,
    csvSizeBytes: dl.contentLength,
    rowsSeen,
    rowsUpserted,
    rowsFailed,
    firstError,
    elapsedMs: Date.now() - t0,
  };

  console.log(JSON.stringify({
    event: "ch_daily_sales_ingest_complete",
    source: "chDailySalesIngest.service",
    ...result,
  }));

  return result;
}
