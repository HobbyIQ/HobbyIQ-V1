// CF-SUB-RAW-INVERSION-SCAN (Drew, 2026-07-19). Batch scanner that
// walks recent sold_comps grouped by cardId and emits a
// sub_raw_inversion_observed telemetry event for each SKU where a
// Raw sale exceeds the median graded sale in the window. Prospect-
// breakout indicator.
//
// The event `sub_raw_inversion_observed` already feeds the S1 KQL that
// powers DailyIQ hot-prospects (project_sub_raw_telemetry_is_dailyiq_pipe).
// This scanner extends that signal from "detected per-request" to
// "detected nightly across the whole corpus."
//
// Sport-scoped so we can stagger baseball vs football scans and cap
// query cost.

import { CosmosClient, type Container } from "@azure/cosmos";
import { logSubRawInversionObserved } from "../compiq/marketRead.service.js";

let sharedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
    sharedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedContainer;
  } catch { return null; }
}

interface CompRow {
  cardId: string;
  playerName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  cardYear?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
}

export interface SubRawInversionScanOptions {
  sport: string;
  windowDays?: number;     // default 30
  minRawSales?: number;    // default 2 (must observe at least 2 raw sales for confidence)
  minGradedSales?: number; // default 3 (need decent graded pool to be the median comparison)
  minMarginPct?: number;   // default 5 (5%+ inversion required)
  dryRun?: boolean;        // when true, don't emit telemetry
}

export interface SubRawInversionScanSummary {
  sport: string;
  windowDays: number;
  skusScanned: number;
  skusWithBothRawAndGraded: number;
  inversionsDetected: number;
  telemetryEmitted: number;
  dryRun: boolean;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

export async function runSubRawInversionScan(
  opts: SubRawInversionScanOptions,
): Promise<SubRawInversionScanSummary> {
  const windowDays = opts.windowDays ?? 30;
  const minRawSales = opts.minRawSales ?? 2;
  const minGradedSales = opts.minGradedSales ?? 3;
  const minMarginPct = opts.minMarginPct ?? 5;
  const dryRun = opts.dryRun === true;

  const summary: SubRawInversionScanSummary = {
    sport: opts.sport,
    windowDays,
    skusScanned: 0,
    skusWithBothRawAndGraded: 0,
    inversionsDetected: 0,
    telemetryEmitted: 0,
    dryRun,
  };

  const container = await getContainer();
  if (!container) return summary;

  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Uses the (sport, soldAt) composite index for cheap read.
  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.playerName, c.parallel, c.cardNumber, c.cardYear,
                   c.gradeCompany, c.gradeValue, c.price, c.soldAt
            FROM c
            WHERE c.sport = @sport
              AND c.soldAt >= @from
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [
      { name: "@sport", value: opts.sport },
      { name: "@from", value: windowStart },
    ],
  });

  const rows: CompRow[] = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }

  // Group by (cardId, parallel) — inversion is a SKU-level property.
  // Base + parallels for the same cardId are meaningfully different
  // markets, so we don't fold them together.
  const groups = new Map<string, {
    cardId: string;
    playerName: string | null;
    parallel: string | null;
    rawPrices: number[];
    gradedByGrader: Map<string, number[]>;
  }>();
  for (const r of rows) {
    const key = `${r.cardId}::${r.parallel ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        cardId: r.cardId,
        playerName: r.playerName ?? null,
        parallel: r.parallel ?? null,
        rawPrices: [],
        gradedByGrader: new Map(),
      };
      groups.set(key, g);
    }
    if (!r.gradeCompany || String(r.gradeCompany).trim().length === 0) {
      g.rawPrices.push(r.price);
    } else {
      const grader = `${r.gradeCompany} ${r.gradeValue ?? ""}`.trim();
      const arr = g.gradedByGrader.get(grader) ?? [];
      arr.push(r.price);
      g.gradedByGrader.set(grader, arr);
    }
  }

  summary.skusScanned = groups.size;

  for (const [, g] of groups) {
    if (g.rawPrices.length < minRawSales) continue;
    if (g.gradedByGrader.size === 0) continue;
    summary.skusWithBothRawAndGraded++;

    const rawSorted = g.rawPrices.slice().sort((a, b) => a - b);
    const rawMedian = median(rawSorted);
    const rawMax = rawSorted[rawSorted.length - 1];

    for (const [grader, prices] of g.gradedByGrader) {
      if (prices.length < minGradedSales) continue;
      const gradedSorted = prices.slice().sort((a, b) => a - b);
      const gradedMedian = median(gradedSorted);
      // Inversion condition: raw MAX exceeds graded MEDIAN — the strong
      // form of the signal. Raw median exceeding graded median is
      // interesting too but noisier; we require the peak-signal form
      // here to keep telemetry noise low.
      const marginUSD = rawMax - gradedMedian;
      const marginPct = gradedMedian > 0 ? (marginUSD / gradedMedian) * 100 : 0;
      if (marginPct < minMarginPct) continue;

      summary.inversionsDetected++;

      if (!dryRun) {
        const [company, valueStr] = grader.split(" ");
        logSubRawInversionObserved({
          source: "subRawInversionScan",
          player: g.playerName,
          cardId: g.cardId,
          event: {
            grader: company,
            grade: valueStr ?? "",
            gradeMedian: Math.round(gradedMedian * 100) / 100,
            gradeCount: prices.length,
            rawMedian: Math.round(rawMedian * 100) / 100,
            marginPct: Math.round(marginPct * 10) / 10,
            marginUSD: Math.round(marginUSD * 100) / 100,
          },
        });
        summary.telemetryEmitted++;
      }
    }
  }

  console.log(JSON.stringify({
    event: "sub_raw_inversion_scan.job_complete",
    source: "subRawInversionScan.service",
    ...summary,
  }));

  return summary;
}
