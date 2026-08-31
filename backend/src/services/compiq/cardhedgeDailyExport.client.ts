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

  // CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14). A mid-download failure
  // emits 'error' on the SOURCE stream, and pipe() does not forward that
  // to the destination. Without this listener the event is unhandled and
  // takes the whole process down rather than surfacing to the caller.
  //
  // Observed live: holding this stream open while doing per-row Cosmos
  // writes slows the read enough that CH closes the connection
  // (UND_ERR_SOCKET "other side closed") ~2.7 MB into the file. Callers
  // doing slow per-row work MUST drain the parse first and write after —
  // see backfillOneDay's two-phase structure. Destroying the parser here
  // makes the async iterator below reject, so the failure is catchable.
  stream.on("error", (err) => {
    parser.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  stream.pipe(parser);

  // Consuming the parser as an async iterable handles backpressure
  // between csv-parse and this loop. Note this does NOT make it safe to
  // do slow I/O inside onRow — that backpressure reaches all the way to
  // the origin socket. Keep onRow cheap.
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
    year: reconcileYear(toInt(record.year), String(record.card_set ?? "")),
    created_at: String(record.created_at ?? "").trim(),
    updated_at: String(record.updated_at ?? "").trim(),
  };
}

/**
 * CF-A-THREE-DIGIT-YEAR-IS-A-TRUNCATED-ONE (2026-08-31).
 *
 * 2,980 sold_comps rows (and the 1,040 ch_daily_sales rows behind them) carry
 * a THREE-DIGIT cardYear: 201, 197, 198, 202, 199, 200. Every one is the real
 * year with its last digit gone -- "2016 Panini Donruss Football" filed under
 * year 201, "1978 Kellogg's 3-D Super Stars Baseball" under 197.
 *
 * WHERE IT COMES FROM, and where it does not. The obvious suspect was this
 * file: a shifted CSV column, or toInt eating a digit. It is neither. toInt is
 * faithful (parseInt("2016") is 2016), and on every affected row EVERY OTHER
 * FIELD is intact -- player, number, card_set, grade, grader, group, the
 * timestamps -- which is not what a column shift looks like. The truncated
 * value arrives that way from the vendor, consistently per card_id: measured
 * 2026-08-31, 146 distinct card_ids, and not one of them has both a truncated
 * and a full-year row. So this is an upstream defect we cannot fix at source
 * and must not silently import.
 *
 * WHY card_set IS THE AUTHORITY. The set name is a STRING the vendor does not
 * mangle, and it names the year: on all 1,040 affected rows the stored year is
 * exactly a prefix of the year card_set states, with zero disagreements. That
 * makes the repair a reconciliation against evidence rather than a guess.
 *
 * WHAT IT REFUSES TO DO. It corrects ONLY the exact signature of this defect:
 * a 3-digit year that is a strict prefix of a 4-digit year the set name
 * states. A 4-digit year is returned untouched even when card_set disagrees --
 * that is a DIFFERENT question (which of two sources is right) and answering
 * it here would let a set-name typo overwrite good data. A year with no
 * recoverable evidence stays as it is and is visible to the audit rather than
 * being defaulted to something plausible.
 */
export function reconcileYear(year: number, cardSet: string): number {
  // Only the truncation signature. Anything else is left exactly as found.
  if (!Number.isFinite(year) || year < 100 || year > 999) return year;
  const stated = cardSet.match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (!stated) return year;
  const trueYear = Number(stated[1]);
  // The stored value must be the STATED year with its last digit dropped.
  // Without this the guard would rewrite any 3-digit year to whatever the set
  // name happened to mention.
  return String(trueYear).startsWith(String(year)) ? trueYear : year;
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
