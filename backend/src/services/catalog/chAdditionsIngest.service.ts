// CF-CH-ADDITIONS-INGEST (Drew, 2026-07-17). Orchestrator that pulls
// CH's catalog-additions summaries since our checkpoint and upserts
// them into ch_catalog_additions. Idempotent — same-window re-runs
// produce zero new rows (upsert by (category, set, subset, date)).
//
// "Only pulls non-duplicates" — checkpoint tracks the last endDate we
// successfully ingested. Next run starts from that date. Same-day
// re-run works too (the pageSize walker + upsert dedup handle it).
//
// Runs via the ch-catalog-additions-ingest scheduled workflow OR
// via a one-off admin trigger. Never throws — returns a summary
// object so the caller (workflow / trigger) can log and move on.

import { getAdditionsSummary, type CardHedgeAdditionRow } from "../compiq/cardhedge.client.js";
import { upsertAdditions, readCheckpoint, upsertCheckpoint } from "./chAdditionsStore.service.js";

const DEFAULT_PAGE_SIZE = 200;   // CH's max; check dashboard if changes
const DEFAULT_LOOKBACK_DAYS = 14;   // first-run backfill window

export interface IngestOptions {
  /** YYYY-MM-DD. Defaults to (last checkpoint end + 1 day), or
   *  (today − DEFAULT_LOOKBACK_DAYS) on cold start. */
  startDate?: string;
  /** YYYY-MM-DD. Defaults to yesterday UTC (CH updates catalog
   *  daily; we let one day settle before pulling). */
  endDate?: string;
  /** Optional narrow scope. When absent, all categories ingest. */
  category?: string;
}

export interface IngestSummary {
  startDate: string;
  endDate: string;
  category: string | null;
  pagesFetched: number;
  rowsSeen: number;
  rowsUpserted: number;
  firstError: string | null;
  elapsedMs: number;
}

function yesterdayUTC(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function addDay(iso: string, days = 1): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function ingestCatalogAdditions(opts: IngestOptions = {}): Promise<IngestSummary> {
  const t0 = Date.now();
  const runStart = new Date().toISOString();
  const endDate = opts.endDate ?? yesterdayUTC();
  const category = opts.category ?? null;

  let startDate = opts.startDate;
  if (!startDate) {
    const cp = await readCheckpoint();
    startDate = cp
      ? addDay(cp.lastEndDate, 1)
      : addDay(endDate, -DEFAULT_LOOKBACK_DAYS);
  }

  const summary: IngestSummary = {
    startDate,
    endDate,
    category,
    pagesFetched: 0,
    rowsSeen: 0,
    rowsUpserted: 0,
    firstError: null,
    elapsedMs: 0,
  };

  if (startDate > endDate) {
    // Already up-to-date — nothing to do
    summary.elapsedMs = Date.now() - t0;
    return summary;
  }

  let page = 1;
  let highestSeenDate = startDate;
  while (true) {
    let resp;
    try {
      resp = await getAdditionsSummary({
        startDate,
        endDate,
        category: category ?? undefined,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
      });
    } catch (err) {
      summary.firstError = (err as Error)?.message ?? String(err);
      break;
    }
    if (!resp) break;
    summary.pagesFetched++;
    const rows: CardHedgeAdditionRow[] = resp.data ?? [];
    summary.rowsSeen += rows.length;
    if (rows.length === 0) break;

    try {
      const n = await upsertAdditions(rows);
      summary.rowsUpserted += n;
      for (const r of rows) {
        if (r.added_date && r.added_date > highestSeenDate) highestSeenDate = r.added_date;
      }
    } catch (err) {
      if (!summary.firstError) summary.firstError = (err as Error)?.message ?? String(err);
    }

    // Stop when we've consumed a partial page — CH returned fewer rows
    // than page_size, so we're at the end.
    if (rows.length < DEFAULT_PAGE_SIZE) break;
    page++;
    // Safety cap: 50 pages × 200 = 10k additions per run. Realistic
    // daily volume is far smaller; this prevents a runaway loop.
    if (page > 50) {
      summary.firstError = summary.firstError ?? "page cap hit (50) — check page size";
      break;
    }
  }

  await upsertCheckpoint({
    lastRunStart: runStart,
    lastRunEnd: new Date().toISOString(),
    lastEndDate: highestSeenDate,
    rowsUpserted: summary.rowsUpserted,
  });

  summary.elapsedMs = Date.now() - t0;
  return summary;
}
