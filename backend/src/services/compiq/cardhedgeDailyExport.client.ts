// CF-CH-DAILY-EXPORT-INGEST (Drew, 2026-07-16). Focused client for
// CardHedge's /v1/download/daily-price-export/{file_date} endpoint.
// Kept in its own file (not in the sprawling cardhedge.client.ts) so
// the bulk-ingest surface can evolve independently of the request/
// response wrappers CH exposes for per-card calls.
//
// Elite/Enterprise tier only — a 403 here means the caller's key is
// on a lower tier. Reported clearly by the fetch wrapper so the
// ingest job can log-and-exit-clean rather than retry-loop.
//
// The response is a CSV (~40 MB, ~78k rows at current scale). We
// stream it directly to the parser instead of buffering — Node has
// no problem with 40 MB but the streaming pattern matters if CH
// grows the file 10x, and the parser wants a stream anyway.

import { parse } from "csv-parse";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";
import { CH_DAILY_SALES_HEADER } from "../../types/chDailySales.types.js";

const BASE_URL = "https://api.cardhedger.com/v1";

export interface DownloadResult {
  status: number;
  bodyStream: NodeJS.ReadableStream | null;
  contentType: string | null;
  contentLength: number | null;
  contentEncoding: string | null;
}

/**
 * Streams the daily-price-export CSV for a given date. Caller is
 * responsible for consuming (or discarding) the stream.
 *
 * @param fileDate  YYYY-MM-DD; CH publishes the file shortly after
 *                  midnight UTC for the prior day.
 * @param opts.apiKey  overrides `process.env.CARD_HEDGE_API_KEY`.
 * @param opts.timeoutMs  aborts the download if the connection stalls
 *                        (default 60s — first-byte target, not full
 *                        download; the read-side has its own budget).
 */
export async function downloadDailyPriceExport(
  fileDate: string,
  opts: { apiKey?: string; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
    throw new Error(`downloadDailyPriceExport: fileDate must be YYYY-MM-DD, got "${fileDate}"`);
  }
  const key = opts.apiKey ?? process.env.CARD_HEDGE_API_KEY;
  if (!key) {
    throw new Error("downloadDailyPriceExport: CARD_HEDGE_API_KEY not set");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const url = `${BASE_URL}/download/daily-price-export/${fileDate}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": key },
      signal: controller.signal,
    });
    console.log(JSON.stringify({
      event: "ch_call",
      source: "cardhedgeDailyExport.client",
      path: `/download/daily-price-export/${fileDate}`,
      status: res.status,
      took_ms: Date.now() - t0,
      ok: res.ok,
    }));
    if (!res.ok) {
      return {
        status: res.status,
        bodyStream: null,
        contentType: res.headers.get("content-type"),
        contentLength: null,
        contentEncoding: null,
      };
    }
    const contentLength = Number(res.headers.get("content-length"));
    return {
      status: res.status,
      // Node 18+ Response.body is a ReadableStream; wrap for stream-based
      // consumption in the parser (which expects a Node Readable).
      bodyStream: res.body ? webToNodeStream(res.body) : null,
      contentType: res.headers.get("content-type"),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      contentEncoding: res.headers.get("content-encoding"),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convert a WHATWG ReadableStream to a Node Readable. */
function webToNodeStream(stream: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  // Use Node's built-in adapter; available since Node 17.
  // Isolated to a helper so a future switch to a Node-native download
  // pathway (undici stream()) is one edit.
  const { Readable } = require("stream") as typeof import("stream");
  return Readable.fromWeb(stream as any);
}

export interface ParseResult {
  rows: number;
  errors: number;
  firstError: string | null;
}

/**
 * Parses the daily-export CSV stream row-by-row and hands each parsed
 * row to `onRow`. Row-level errors are counted but do not abort the
 * stream — a malformed row shouldn't kill an ingest of 78k good ones.
 * The first error message is preserved on the result for triage.
 *
 * Header validation runs on the first record: if CH changes column
 * order or names, the parser throws immediately (before onRow fires
 * for any row) so downstream never sees mis-mapped fields.
 */
export async function parseDailyExportStream(
  stream: NodeJS.ReadableStream,
  onRow: (row: CHDailySaleRow) => Promise<void> | void,
): Promise<ParseResult> {
  const parser = parse({
    columns: (header: string[]) => {
      assertHeaderMatches(header);
      return header;
    },
    skip_empty_lines: true,
    trim: false,
    relax_column_count: true,
  });

  let rows = 0;
  let errors = 0;
  let firstError: string | null = null;

  stream.pipe(parser);

  // Consuming the parser as an async iterable naturally handles
  // backpressure — awaiting onRow inside the loop pauses csv-parse
  // between records without needing manual pause/resume choreography.
  try {
    for await (const record of parser as unknown as AsyncIterable<Record<string, string>>) {
      try {
        const row = coerceRow(record);
        rows++;
        await onRow(row);
      } catch (err) {
        errors++;
        if (!firstError) firstError = (err as Error)?.message ?? String(err);
      }
    }
  } catch (err) {
    // Header-guard throws + genuinely-bad CSV shape surface here.
    throw err;
  }

  return { rows, errors, firstError };
}

function assertHeaderMatches(header: string[]): void {
  if (header.length !== CH_DAILY_SALES_HEADER.length) {
    throw new Error(
      `CH daily-export header mismatch: expected ${CH_DAILY_SALES_HEADER.length} columns, got ${header.length}`,
    );
  }
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== CH_DAILY_SALES_HEADER[i]) {
      throw new Error(
        `CH daily-export header mismatch at column ${i}: expected "${CH_DAILY_SALES_HEADER[i]}", got "${header[i]}"`,
      );
    }
  }
}

/**
 * Coerce a raw string-only record from csv-parse into the typed
 * CHDailySaleRow. Numeric fields fall through to 0 on unparseable
 * input rather than throwing — one bad `price` shouldn't torch the
 * ingest.
 */
export function coerceRow(record: Record<string, string>): CHDailySaleRow {
  const priceHistoryId = String(record.price_history_id ?? "").trim();
  if (!priceHistoryId) {
    throw new Error("CH daily-export row missing price_history_id");
  }
  const cardId = String(record.card_id ?? "").trim();
  if (!cardId) {
    throw new Error(`CH daily-export row ${priceHistoryId} missing card_id`);
  }
  return {
    price_history_id: priceHistoryId,
    source: String(record.source ?? "").trim(),
    description: String(record.description ?? ""),
    price: toNumber(record.price),
    listing_url: String(record.listing_url ?? "").trim(),
    image_url: String(record.image_url ?? "").trim(),
    pop: toInt(record.pop),
    sale_date: String(record.sale_date ?? "").trim(),
    sale_type: String(record.sale_type ?? "").trim(),
    card_id: cardId,
    card_description: String(record.card_description ?? ""),
    number: String(record.number ?? "").trim(),
    player: String(record.player ?? "").trim(),
    grade: String(record.grade ?? "").trim(),
    grader: String(record.grader ?? "").trim(),
    group: String(record.group ?? "").trim(),
    card_set: String(record.card_set ?? "").trim(),
    card_set_type: String(record.card_set_type ?? "").trim(),
    variant: String(record.variant ?? "").trim(),
    year: toInt(record.year),
    created_at: String(record.created_at ?? "").trim(),
    updated_at: String(record.updated_at ?? "").trim(),
  };
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
