// CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14). Walk CardHedge's
// per-day CSV export from the retention cutoff forward to today,
// streaming each day straight into sold_comps via recordSoldComp.
//
// Retention cutoff, measured 2026-08-14 by binary search on HTTP status
// (13 status-only probes, bodies cancelled):
//
//     2024-12-29  500      2025-01-01  200   <- earliest available
//     2024-12-30  500      2025-01-02  200
//     2024-12-31  500      2025-01-03  200
//
// The boundary is monotonic (verified 3 days each side) and lands
// exactly on a calendar-year line, which reads as a retention POLICY
// rather than a data gap. If the policy is "current + prior calendar
// year", the 2025 window ages out on 2027-01-01. Treat the 2025 pull as
// time-boxed, not evergreen.
//
// Why straight to sold_comps and not through ch_daily_sales: that
// container carries a 365-day TTL, so rows older than a year cannot
// survive there. sold_comps is the durable pool.
//
// Why recordSoldComp per row rather than a bulk upsert: it is the only
// path that runs preIngestClean, catalog matching, hobbyiqCardId slug
// computation, and contentHash dedup. Writing a second bulk path would
// reintroduce exactly the unscreened-row problem the pool already has.
//
// RESUMABILITY is the point of this service. The prior tooling
// (bulk-import-ch-daily-to-sold-comps.cjs) advertised a checkpoint in
// its header comment but never persisted one — it printed a "next start
// date" for an operator to re-pass by hand, which does not survive an
// unattended scheduled run. Here the cursor is a Cosmos doc updated
// after each fully-completed day, so a killed run resumes on the next
// day boundary and never re-walks completed days.

import {
  downloadDailyPriceExport,
  parseDailyExportStream,
} from "../compiq/cardhedgeDailyExport.client.js";
import { recordSoldComp, type RecordSoldCompInput } from "./soldCompsStore.service.js";
import { mapChRowToSoldComp, type MapSkipReason } from "./chRowToSoldComp.js";
import {
  readBackfillCursor,
  writeBackfillCursor,
  type BackfillCursor,
} from "./chHistoricalBackfillStore.service.js";

/** Earliest file_date CH serves. Measured, not assumed — see header. */
export const CH_RETENTION_CUTOFF = "2025-01-01";

/** Ceiling on the per-day buffer built in phase 1. Largest day observed
 *  is ~80k rows; 400k leaves headroom for CH growth while still failing
 *  loudly instead of exhausting memory on a runaway file. */
const MAX_BUFFERED_ROWS = 400_000;

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "chHistoricalBackfill.service", ...fields }));
};

export interface DayResult {
  fileDate: string;
  httpStatus: number;
  rowsParsed: number;
  rowsWritten: number;
  rowsSkipped: number;
  rowsUnmatched: number;
  rowsFailed: number;
  skipBreakdown: Partial<Record<MapSkipReason, number>>;
  elapsedMs: number;
  /** True when the day completed end-to-end and the cursor may advance. */
  complete: boolean;
  error: string | null;
}

export interface BackfillOptions {
  /** First date to process. Defaults to the persisted cursor, else the cutoff. */
  startDate?: string;
  /** Last date to process (inclusive). Defaults to yesterday UTC. */
  endDate?: string;
  /** Max days to process this run. The quota resets midnight UTC, so a
   *  scheduled run takes a bite rather than trying to drain in one go. */
  maxDays?: number;
  /** Canonical sport tags to keep. null = all sports. */
  sportFilter?: string[] | null;
  /** Parallel recordSoldComp calls within a day. */
  concurrency?: number;
  /** When false, parse and map but never write. Default false (dry-run). */
  apply?: boolean;
  /** Overrides CARD_HEDGE_API_KEY. */
  apiKey?: string;
  /** Stop the run after this many wall-clock ms. 0 = no limit. */
  timeBudgetMs?: number;
  /** Ignore the persisted cursor (use startDate as given). */
  ignoreCursor?: boolean;
}

/**
 * CF-CH-BACKFILL-POISON-PILL (2026-08-22). Consecutive runs a single date may
 * block the walk before it is quarantined and stepped over.
 *
 * 3 is chosen against the schedule, not arbitrarily: this job runs twice a
 * day, so three consecutive failures means the date has been unavailable for
 * roughly a day and a half. That is far past any deploy blip or rate-limit
 * window, and comfortably short of the three days of total stall the previous
 * unbounded hold actually produced.
 */
const MAX_BLOCKED_ATTEMPTS = Number(process.env.CH_BACKFILL_MAX_BLOCKED_ATTEMPTS ?? 3) || 3;
export interface BackfillRunResult {
  startDate: string;
  endDate: string;
  daysAttempted: number;
  daysCompleted: number;
  totalRowsParsed: number;
  totalRowsWritten: number;
  totalRowsSkipped: number;
  totalRowsUnmatched: number;
  totalRowsFailed: number;
  perDay: DayResult[];
  cursorBefore: string | null;
  cursorAfter: string | null;
  stoppedReason: "range-exhausted" | "max-days" | "time-budget" | "hard-error";
  /** CF-CH-BACKFILL-POISON-PILL: dates stepped over this run, with the hole recorded. */
  quarantinedThisRun?: string[];
  apply: boolean;
  elapsedMs: number;
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function yesterdayUtc(nowMs: number = Date.now()): string {
  return new Date(nowMs - 86400_000).toISOString().slice(0, 10);
}

/**
 * Process a single file_date. Never throws for row-level problems —
 * only a download/parse failure marks the day incomplete, and an
 * incomplete day must NOT advance the cursor.
 */
export async function backfillOneDay(
  fileDate: string,
  opts: { sportFilter?: string[] | null; concurrency?: number; apply?: boolean; apiKey?: string } = {},
): Promise<DayResult> {
  const t0 = Date.now();
  const sportFilter = opts.sportFilter ?? null;
  const concurrency = Math.max(1, Math.min(32, opts.concurrency ?? 8));
  const apply = opts.apply === true;

  const base: DayResult = {
    fileDate,
    httpStatus: 0,
    rowsParsed: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    rowsUnmatched: 0,
    rowsFailed: 0,
    skipBreakdown: {},
    elapsedMs: 0,
    complete: false,
    error: null,
  };

  let dl;
  try {
    dl = await downloadDailyPriceExport(fileDate, {
      apiKey: opts.apiKey,
      timeoutMs: 120_000,
    });
  } catch (err) {
    return { ...base, elapsedMs: Date.now() - t0, error: `download: ${(err as Error)?.message ?? String(err)}` };
  }

  if (dl.status !== 200 || !dl.bodyStream) {
    // A non-200 is NOT proof the day has no data — it may be a transient
    // CH error. The day stays incomplete so the cursor holds and the
    // next run retries it.
    return {
      ...base,
      httpStatus: dl.status,
      elapsedMs: Date.now() - t0,
      error: `download returned HTTP ${dl.status}`,
    };
  }

  const skipBreakdown: Partial<Record<MapSkipReason, number>> = {};
  let rowsParsed = 0;
  let rowsWritten = 0;
  let rowsSkipped = 0;
  let rowsUnmatched = 0;
  let rowsFailed = 0;

  // ── Phase 1: drain the CSV. No I/O in the row callback. ──────────────
  //
  // This is deliberately NOT interleaved with the writes. Doing a Cosmos
  // write per row while the response stream is still open backpressures
  // all the way to the origin socket, and CH closes the connection
  // (observed 2026-08-14: UND_ERR_SOCKET ~2.7 MB into the file). Parsing
  // a full day takes ~6s; writing it takes minutes. Those cannot share a
  // socket, so we buffer the mapped inputs and write after the stream is
  // closed.
  //
  // Cost of buffering: a mapped input is a few hundred bytes, so a 78k-
  // row day is roughly 30-40 MB. Bounded by MAX_BUFFERED_ROWS below.
  const pending: RecordSoldCompInput[] = [];

  try {
    await parseDailyExportStream(dl.bodyStream, (row) => {
      rowsParsed++;
      const mapped = mapChRowToSoldComp(row, { sportFilter });
      if (!mapped.ok) {
        rowsSkipped++;
        skipBreakdown[mapped.skip] = (skipBreakdown[mapped.skip] ?? 0) + 1;
        return;
      }
      if (pending.length >= MAX_BUFFERED_ROWS) {
        throw new Error(
          `day exceeded MAX_BUFFERED_ROWS (${MAX_BUFFERED_ROWS}) — refusing to buffer further`,
        );
      }
      pending.push(mapped.input);
    });
  } catch (err) {
    return {
      ...base,
      httpStatus: 200,
      rowsParsed,
      rowsSkipped,
      skipBreakdown,
      elapsedMs: Date.now() - t0,
      error: `parse: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  if (!apply) {
    return {
      fileDate,
      httpStatus: 200,
      rowsParsed,
      rowsWritten: pending.length,
      rowsSkipped,
      rowsUnmatched: 0,
      rowsFailed: 0,
      skipBreakdown,
      elapsedMs: Date.now() - t0,
      complete: true,
      error: null,
    };
  }

  // ── Phase 2: write. The response stream is closed by now. ────────────
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (next < pending.length) {
        const item = pending[next++];
        try {
          const res = await recordSoldComp(item);
          if (res.written) rowsWritten++;
          else if (res.reason === "catalog-unmatched") rowsUnmatched++;
          else rowsFailed++;
        } catch {
          rowsFailed++;
        }
      }
    }),
  );

  return {
    fileDate,
    httpStatus: 200,
    rowsParsed,
    rowsWritten,
    rowsSkipped,
    rowsUnmatched,
    rowsFailed,
    skipBreakdown,
    elapsedMs: Date.now() - t0,
    complete: true,
    error: null,
  };
}

/**
 * Walk days forward from the cursor (or startDate), stopping on
 * maxDays / time budget / range end. The cursor advances only after a
 * day completes end-to-end, so an interrupted run resumes cleanly.
 */
export async function runHistoricalBackfill(opts: BackfillOptions = {}): Promise<BackfillRunResult> {
  const t0 = Date.now();
  const apply = opts.apply === true;
  const maxDays = Math.max(1, opts.maxDays ?? 7);
  const timeBudgetMs = opts.timeBudgetMs ?? 0;
  const endDate = opts.endDate ?? yesterdayUtc();

  const cursor: BackfillCursor | null = opts.ignoreCursor ? null : await readBackfillCursor();
  const cursorBefore = cursor?.lastCompletedDate ?? null;

  // Resume the day AFTER the last completed one.
  let startDate = opts.startDate
    ?? (cursorBefore ? addDays(cursorBefore, 1) : CH_RETENTION_CUTOFF);
  if (startDate < CH_RETENTION_CUTOFF) startDate = CH_RETENTION_CUTOFF;

  log("ch_historical_backfill.start", {
    startDate, endDate, maxDays, apply,
    sportFilter: opts.sportFilter ?? null,
    cursorBefore,
  });

  const perDay: DayResult[] = [];
  const quarantinedThisRun: string[] = [];
  let cursorAfter = cursorBefore;
  let stoppedReason: BackfillRunResult["stoppedReason"] = "range-exhausted";
  let current = startDate;

  while (current <= endDate) {
    if (perDay.length >= maxDays) { stoppedReason = "max-days"; break; }
    if (timeBudgetMs > 0 && Date.now() - t0 >= timeBudgetMs) { stoppedReason = "time-budget"; break; }

    const day = await backfillOneDay(current, {
      sportFilter: opts.sportFilter,
      concurrency: opts.concurrency,
      apply,
      apiKey: opts.apiKey,
    });
    perDay.push(day);
    log("ch_historical_backfill.day", { ...day, skipBreakdown: undefined });

    if (!day.complete) {
      // Holding the cursor is right for a TRANSIENT failure: skipping would
      // leave a hole nothing goes back for. It is wrong forever.
      //
      // CF-CH-BACKFILL-POISON-PILL (2026-08-22). CardHedge returned HTTP 500
      // for 2025-10-08. The run died in 0.9s holding the cursor, and did that
      // on EVERY scheduled run from 2026-08-19 on — three days of zero rows
      // because one upstream date is permanently unavailable. A retry policy
      // with no give-up condition is a deadlock, not a safety property.
      //
      // So: hold for MAX_BLOCKED_ATTEMPTS consecutive runs, which covers any
      // real transient. Past that, record the date in quarantinedDates and
      // step over it. That list is what "goes back for it" — a known,
      // reported hole, which is the opposite of silently skipping.
      const sameAsBefore = cursor?.blockedDate === current;
      const attempts = (sameAsBefore ? (cursor?.blockedAttempts ?? 0) : 0) + 1;
      const dayError = day.error ?? `day incomplete (http=${day.httpStatus})`;

      if (attempts < MAX_BLOCKED_ATTEMPTS) {
        if (apply) {
          await writeBackfillCursor({
            // cursorAfter is null before any day has ever completed; the hold
            // is only recording the block, so keep whatever was there.
            lastCompletedDate: cursorAfter ?? cursorBefore ?? current,
            rowsWritten: 0,
            rowsParsed: 0,
            blockedDate: current,
            blockedAttempts: attempts,
            blockedFirstSeenAt: sameAsBefore
              ? (cursor?.blockedFirstSeenAt ?? new Date().toISOString())
              : new Date().toISOString(),
            blockedLastError: String(dayError).slice(0, 300),
          });
        }
        log("ch_historical_backfill.blocked", {
          date: current, attempts, maxAttempts: MAX_BLOCKED_ATTEMPTS, error: String(dayError).slice(0, 300),
        });
        stoppedReason = "hard-error";
        break;
      }

      // Give up on this date and keep going.
      quarantinedThisRun.push(current);
      const allQuarantined = [...(cursor?.quarantinedDates ?? []), current]
        .filter((d, i, a) => a.indexOf(d) === i)
        .sort();
      console.warn(
        `::warning::[ch-backfill] QUARANTINED ${current} after ${attempts} failed runs ` +
        `(${String(dayError).slice(0, 160)}). Stepping over it — this date is a KNOWN HOLE ` +
        `and is recorded in the cursor. ${allQuarantined.length} quarantined total.`,
      );
      log("ch_historical_backfill.quarantined", { date: current, attempts, totalQuarantined: allQuarantined.length });
      if (apply) {
        await writeBackfillCursor({
          lastCompletedDate: current,   // step past it
          rowsWritten: day.rowsWritten,
          rowsParsed: day.rowsParsed,
          blockedDate: null,
          blockedAttempts: 0,
          blockedFirstSeenAt: null,
          blockedLastError: null,
          quarantinedDates: allQuarantined,
        });
      }
      cursorAfter = current;
      current = addDays(current, 1);
      continue;
    }

    // A day that completed clears any block record for it.
    if (cursor?.blockedDate === current && apply) {
      await writeBackfillCursor({
        lastCompletedDate: current,
        rowsWritten: 0,
        rowsParsed: 0,
        blockedDate: null,
        blockedAttempts: 0,
        blockedFirstSeenAt: null,
        blockedLastError: null,
      });
    }

    if (apply) {
      await writeBackfillCursor({
        lastCompletedDate: current,
        rowsWritten: day.rowsWritten,
        rowsParsed: day.rowsParsed,
      });
    }
    cursorAfter = current;
    current = addDays(current, 1);
  }

  const sum = (f: (d: DayResult) => number): number => perDay.reduce((a, d) => a + f(d), 0);

  const result: BackfillRunResult = {
    startDate,
    endDate,
    daysAttempted: perDay.length,
    daysCompleted: perDay.filter((d) => d.complete).length,
    totalRowsParsed: sum((d) => d.rowsParsed),
    totalRowsWritten: sum((d) => d.rowsWritten),
    totalRowsSkipped: sum((d) => d.rowsSkipped),
    totalRowsUnmatched: sum((d) => d.rowsUnmatched),
    totalRowsFailed: sum((d) => d.rowsFailed),
    perDay,
    cursorBefore,
    cursorAfter,
    stoppedReason,
    quarantinedThisRun,
    apply,
    elapsedMs: Date.now() - t0,
  };

  log("ch_historical_backfill.complete", { ...result, perDay: undefined });
  return result;
}
