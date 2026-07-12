// CF-PHASE-5-COLLECTION-VALUE (2026-06-17): portfolio total value over time.
//
// Daily snapshot of {observedValue, estimatedValue, rangeLow, rangeHigh, counts}
// per user, written by piggybacking on the 6h portfolioReprice job (4 idempotent
// writes/day, last-write-wins). Read path serves the history series + a
// HISTORICAL (not forecast) 30d change for the iOS collection-value card.
//
// Banding rule (per holding):
//   - observed: contribute fairMarketValue × qty to BOTH rangeLow and rangeHigh
//                (point estimate — no band on observed side)
//   - estimated: contribute estimateLow × qty to rangeLow, estimateHigh × qty
//                to rangeHigh
//   - pending: excluded from value totals AND range; counted only via
//                pendingCount
//
// displayableTotal = observedValue + estimatedValue (matches summarizeHoldings'
// CF-HEADLINE-HONEST-TOTAL contract). NO direction/forecast/momentum fields
// anywhere — backtest established direction is at chance and signals are
// unmeasurable at current density.
//
// Hardening DEFERRED (post-launch, by design): vendor flap that spikes
// estimatedValue will write the spiked total into the history line; anomaly
// rejection is post-launch hardening per the build CF.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { readUserDoc } from "./portfolioStore.service.js";

// EXCLUDED_STATUS mirrors summarizeHoldings' (portfolioStore.service.ts:1647).
// Kept inline so a future split doesn't accidentally drift.
const EXCLUDED_STATUS = new Set([
  "sold",
  "archived",
  "watchlist",
  "tradepending",
  "trade pending",
  "pending-review",   // CF-EBAY-REVIEW-QUEUE (2026-07-12)
]);

export interface PortfolioValueSnapshot {
  id: string;                 // `${userId}:${YYYY-MM-DD}` (UTC day) — idempotency key
  userId: string;
  date: string;               // YYYY-MM-DD (UTC)
  asOf: string;               // ISO timestamp the snapshot was written
  displayableTotal: number;   // observedValue + estimatedValue
  observedValue: number;
  estimatedValue: number;
  rangeLow: number;
  rangeHigh: number;
  observedCount: number;
  estimatedCount: number;
  pendingCount: number;
  holdingCount: number;       // active holdings (excludes EXCLUDED_STATUS)
}

interface PortfolioValueSnapshotDoc extends PortfolioValueSnapshot {
  // No extra envelope — id+userId are the partition key + idempotency key.
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId =
        process.env.COSMOS_VALUE_HISTORY_CONTAINER ?? "portfolio_value_history";

      if (!endpoint && !connStr) {
        console.warn(
          "[portfolioValueHistory] No Cosmos config — service will no-op",
        );
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }

      const { database } = await client.databases.createIfNotExists({
        id: dbName,
      });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/userId"] },
      });

      _container = container;
      console.log("[portfolioValueHistory] Cosmos connected");
      return container;
    } catch (err: any) {
      console.error(
        "[cosmos][portfolioValueHistory] init failed:",
        err?.message ?? String(err),
      );
      return null;
    }
  })();

  return _initPromise;
}

// Test seam — exposed so the vitest suite can inject a mock container without
// hitting Cosmos and so __resetForTests can clear init state between cases.
export const __portfolioValueHistoryInternals = {
  setContainerForTests(c: Container | null): void {
    _container = c;
    _initPromise = c ? Promise.resolve(c) : null;
  },
  resetForTests(): void {
    _container = null;
    _initPromise = null;
  },
};

function utcDateKey(d: Date): string {
  // YYYY-MM-DD in UTC. Two snapshots on the same UTC day collapse to one row.
  return d.toISOString().slice(0, 10);
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function qtyOf(h: PortfolioHolding | undefined | null): number {
  const raw = (h as any)?.quantity;
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
  return Math.max(1, n);
}

function isExcluded(h: PortfolioHolding): boolean {
  const status = String((h as any).cardStatus ?? (h as any).statusCategory ?? "")
    .trim()
    .toLowerCase();
  return EXCLUDED_STATUS.has(status);
}

export interface SnapshotComputeResult {
  displayableTotal: number;
  observedValue: number;
  estimatedValue: number;
  rangeLow: number;
  rangeHigh: number;
  observedCount: number;
  estimatedCount: number;
  pendingCount: number;
  holdingCount: number;
}

/**
 * Pure aggregator — given a list of holdings, compute the snapshot bucket.
 * Exported for the test suite; the production snapshot path reads the user
 * doc separately and feeds the holdings here.
 */
export function computeSnapshotFromHoldings(
  items: PortfolioHolding[],
): SnapshotComputeResult {
  let observedValue = 0;
  let estimatedValue = 0;
  let rangeLow = 0;
  let rangeHigh = 0;
  let observedCount = 0;
  let estimatedCount = 0;
  let pendingCount = 0;
  let holdingCount = 0;

  for (const h of items) {
    if (isExcluded(h)) continue;
    holdingCount += 1;
    const qty = qtyOf(h);
    const vs = (h as { valuationStatus?: string }).valuationStatus;

    if (vs === "estimated") {
      const ev = (h as { estimatedValue?: number | null }).estimatedValue;
      const lo = (h as { estimateLow?: number | null }).estimateLow;
      const hi = (h as { estimateHigh?: number | null }).estimateHigh;
      const evValid = typeof ev === "number" && Number.isFinite(ev) && ev > 0;
      const loValid = typeof lo === "number" && Number.isFinite(lo) && lo > 0;
      const hiValid = typeof hi === "number" && Number.isFinite(hi) && hi > 0;
      if (evValid) {
        estimatedValue += ev * qty;
      }
      // Range contributions use estimateLow/High when present; if either is
      // missing fall back to the point estimate so the band is consistent
      // (some legacy rows have estimatedValue but no range bounds).
      if (loValid) rangeLow += lo * qty;
      else if (evValid) rangeLow += ev * qty;
      if (hiValid) rangeHigh += hi * qty;
      else if (evValid) rangeHigh += ev * qty;
      estimatedCount += 1;
    } else if (vs === "pending") {
      // Pending: excluded from value AND range. Counted only.
      pendingCount += 1;
    } else {
      // "observed" or undefined/null (pre-Step-1 holdings) — observed bucket.
      const fmv = (h as { fairMarketValue?: number | null }).fairMarketValue;
      const fmvValid = typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0;
      if (fmvValid) {
        const total = fmv * qty;
        observedValue += total;
        // Observed = point estimate. Contribute to BOTH bounds.
        rangeLow += total;
        rangeHigh += total;
        observedCount += 1;
      } else {
        // Observed with no FMV → effectively pending (cardless / never priced).
        // Count under pendingCount so the four-bucket arithmetic stays clean
        // (observed+estimated+pending = holdingCount).
        pendingCount += 1;
      }
    }
  }

  const displayableTotal = observedValue + estimatedValue;
  return {
    displayableTotal: r2(displayableTotal),
    observedValue: r2(observedValue),
    estimatedValue: r2(estimatedValue),
    rangeLow: r2(rangeLow),
    rangeHigh: r2(rangeHigh),
    observedCount,
    estimatedCount,
    pendingCount,
    holdingCount,
  };
}

/**
 * Compute today's snapshot for a user and idempotent-upsert it to Cosmos.
 * Same-day re-runs land in the same id slot (last-write-wins; the 6h reprice
 * cadence triggers 4 writes/day with identical id).
 *
 * Returns the snapshot doc (or null if Cosmos isn't configured / userDoc
 * read failed).
 */
export async function snapshotPortfolioValueForUser(
  userId: string,
): Promise<PortfolioValueSnapshot | null> {
  const container = await getContainer();
  if (!container) return null;

  let items: PortfolioHolding[];
  try {
    const doc = await readUserDoc(userId);
    items = Object.values(doc.holdings ?? {}) as PortfolioHolding[];
  } catch (err: any) {
    console.warn(
      `[portfolioValueHistory] readUserDoc(${userId}) failed: ${err?.message ?? err}`,
    );
    return null;
  }

  const now = new Date();
  const date = utcDateKey(now);
  const computed = computeSnapshotFromHoldings(items);

  const snap: PortfolioValueSnapshot = {
    id: `${userId}:${date}`,
    userId,
    date,
    asOf: now.toISOString(),
    ...computed,
  };

  try {
    await container.items.upsert<PortfolioValueSnapshotDoc>(snap);
  } catch (err: any) {
    console.warn(
      `[portfolioValueHistory] upsert failed for ${snap.id}: ${err?.message ?? err}`,
    );
    return null;
  }
  return snap;
}

export interface ReadValueHistoryOptions {
  fromDate?: string;   // YYYY-MM-DD inclusive
  toDate?: string;     // YYYY-MM-DD inclusive
}

/**
 * Read history rows for a user, optionally bounded by a date range.
 * Returns rows sorted by date ASCENDING. Empty array on Cosmos miss / no rows.
 */
export async function readValueHistory(
  userId: string,
  opts: ReadValueHistoryOptions = {},
): Promise<PortfolioValueSnapshot[]> {
  const container = await getContainer();
  if (!container) return [];

  const clauses: string[] = ["c.userId = @userId"];
  const parameters: Array<{ name: string; value: string }> = [
    { name: "@userId", value: userId },
  ];
  if (opts.fromDate) {
    clauses.push("c.date >= @from");
    parameters.push({ name: "@from", value: opts.fromDate });
  }
  if (opts.toDate) {
    clauses.push("c.date <= @to");
    parameters.push({ name: "@to", value: opts.toDate });
  }
  const query = `SELECT * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.date ASC`;

  try {
    const { resources } = await container.items
      .query<PortfolioValueSnapshot>(
        { query, parameters },
        { partitionKey: userId },
      )
      .fetchAll();
    return resources ?? [];
  } catch (err: any) {
    console.warn(
      `[portfolioValueHistory] readValueHistory(${userId}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

export interface Change30dResult {
  absolute: number;
  percent: number | null;   // null when baseline is 0 (avoid synthetic 0% on no-data)
  asOfDate: string;         // the OLDEST date used as the baseline
  rangeWeak: boolean;       // true when history is shorter than 30 days
}

/**
 * Historical (NOT forecast) change in displayableTotal between the most-recent
 * snapshot and the closest snapshot ≥ 30 days older. When history is shorter
 * than 30 days, falls back to the oldest available snapshot and flags
 * rangeWeak=true so iOS can render "since {date}" instead of "30d".
 *
 * Returns null if the history array is empty (caller renders "—").
 */
export function computeChange30d(
  history: PortfolioValueSnapshot[],
  asOfDate: Date = new Date(),
): Change30dResult | null {
  if (!history.length) return null;
  // Defensive: history is supposed to be ASC sorted; sort to be safe.
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const targetMs = asOfDate.getTime() - 30 * 86400000;
  const targetDate = new Date(targetMs).toISOString().slice(0, 10);

  // Baseline selection:
  //   - If any snapshot has date ≤ targetDate, baseline is the LATEST of those
  //     (most recent snapshot from before the 30-day window).
  //   - Otherwise history doesn't reach back 30 days; baseline = oldest and
  //     rangeWeak=true so iOS renders "since {date}" instead of "30d".
  let baseline: PortfolioValueSnapshot | undefined;
  for (const s of sorted) {
    if (s.date <= targetDate) baseline = s;
    else break;
  }
  let rangeWeak = false;
  if (!baseline) {
    baseline = sorted[0];
    rangeWeak = true;
  }
  // Edge: only one row in history → baseline == latest. Force rangeWeak so
  // iOS doesn't render a 0% delta as if it were a real measurement.
  if (baseline.date === latest.date) {
    rangeWeak = true;
  }

  const absolute = r2(latest.displayableTotal - baseline.displayableTotal);
  const percent =
    baseline.displayableTotal > 0
      ? r2(((latest.displayableTotal - baseline.displayableTotal) / baseline.displayableTotal) * 100)
      : null;

  return {
    absolute,
    percent,
    asOfDate: baseline.date,
    rangeWeak,
  };
}

export interface TopHoldingEntry {
  holdingId: string;
  name: string;
  estValue: number;
  source: "observed" | "estimated";
}

/**
 * Top N holdings by displayable per-holding value (FMV×qty for observed,
 * estimatedValue×qty for estimated). Pending holdings excluded — no number
 * to rank. Source flag surfaces which lens each row was measured in.
 */
export function computeTopHoldings(
  items: PortfolioHolding[],
  n: number,
): TopHoldingEntry[] {
  const ranked: Array<{ entry: TopHoldingEntry; value: number }> = [];
  for (const h of items) {
    if (isExcluded(h)) continue;
    const qty = qtyOf(h);
    const vs = (h as { valuationStatus?: string }).valuationStatus;
    let value = 0;
    let source: "observed" | "estimated";

    if (vs === "estimated") {
      const ev = (h as { estimatedValue?: number | null }).estimatedValue;
      if (!(typeof ev === "number" && Number.isFinite(ev) && ev > 0)) continue;
      value = ev * qty;
      source = "estimated";
    } else if (vs === "pending") {
      continue;
    } else {
      const fmv = (h as { fairMarketValue?: number | null }).fairMarketValue;
      if (!(typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0)) continue;
      value = fmv * qty;
      source = "observed";
    }

    const playerName = String((h as any).playerName ?? "").trim();
    const cardTitle = String((h as any).cardTitle ?? "").trim();
    const name = [playerName, cardTitle].filter(Boolean).join(" · ") || "Card";

    ranked.push({
      entry: {
        holdingId: String((h as any).id ?? ""),
        name,
        estValue: r2(value),
        source,
      },
      value,
    });
  }
  ranked.sort((a, b) => b.value - a.value);
  return ranked.slice(0, n).map((r) => r.entry);
}
