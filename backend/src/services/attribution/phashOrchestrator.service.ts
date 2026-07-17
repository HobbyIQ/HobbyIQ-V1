// CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Orchestrator.
//
// Reads new sales from ch_daily_sales (via the existing store),
// computes dHashes for images not yet hashed, upserts to
// ch_sale_phashes, then re-clusters each touched card_id and updates
// ch_card_attribution_stats.
//
// Runs from .github/workflows/ch-sale-phashes.yml (daily 06:00 UTC,
// 45 min after the ingest cron). Also supports backfill mode for
// re-processing existing days.

import type { CHSalePhashDoc, CHCardAttributionStats } from "../../types/chSalePhash.types.js";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";
import { computeDhashFromUrl, HASH_ALGO } from "./phashCompute.service.js";
import { clusterByHamming, summarizeAttribution, DEFAULT_HAMMING_THRESHOLD } from "./phashCluster.service.js";
import {
  upsertPhashBatch,
  getPhashesForCard,
  upsertAttributionStats,
  listHashedPriceHistoryIds,
} from "./phashStore.service.js";
import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface RunOptions {
  /** How many days of ch_daily_sales to read (from today-1 backward). */
  daysBack?: number;
  /** Max sales to process this run (safety cap). */
  saleLimit?: number;
  /** Per-batch upsert to ch_sale_phashes. */
  batchSize?: number;
  /** Concurrent image downloads. */
  downloadConcurrency?: number;
  /** Hamming distance threshold for clustering. */
  hammingThreshold?: number;
  /** Skip images already hashed on a prior run. Default true. */
  skipAlreadyHashed?: boolean;
}

export interface RunResult {
  daysScanned: number;
  salesConsidered: number;
  salesSkippedAlreadyHashed: number;
  salesHashed: number;
  salesFailedDownload: number;
  cardsClustered: number;
  cardsSuspect: number;
  bytesDownloaded: number;
  elapsedMs: number;
  firstError: string | null;
}

/** Read raw sales from ch_daily_sales for a date range. Cross-partition;
 *  runs at N days × avg-sales-per-day scale. */
async function readRecentSales(daysBack: number): Promise<CHDailySaleRow[]> {
  const container = await getChDailySalesContainer();
  if (!container) return [];
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10);
  try {
    const { resources } = await container.items
      .query<CHDailySaleRow>({
        query: "SELECT c.price_history_id, c.card_id, c.sale_date, c.image_url FROM c WHERE c.sale_date >= @cutoff",
        parameters: [{ name: "@cutoff", value: cutoff }],
      })
      .fetchAll();
    return (resources ?? []) as CHDailySaleRow[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ch_daily_sales_read_error",
      source: "phashOrchestrator.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

let _dailySalesContainer: Container | null = null;
async function getChDailySalesContainer(): Promise<Container | null> {
  if (_dailySalesContainer) return _dailySalesContainer;
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
  const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
  if (!endpoint && !connStr) return null;
  let client: CosmosClient;
  if (connStr) client = new CosmosClient(connStr);
  else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
  else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ["/card_id"] },
  });
  _dailySalesContainer = container;
  return container;
}

export async function runPhashPipeline(opts: RunOptions = {}): Promise<RunResult> {
  const daysBack = opts.daysBack ?? 1;
  const saleLimit = opts.saleLimit ?? null;
  const batchSize = opts.batchSize ?? 500;
  const downloadConcurrency = Math.max(1, Math.min(64, opts.downloadConcurrency ?? 32));
  const hammingThreshold = opts.hammingThreshold ?? DEFAULT_HAMMING_THRESHOLD;
  const skipAlreadyHashed = opts.skipAlreadyHashed !== false;

  const t0 = Date.now();
  const result: RunResult = {
    daysScanned: daysBack,
    salesConsidered: 0,
    salesSkippedAlreadyHashed: 0,
    salesHashed: 0,
    salesFailedDownload: 0,
    cardsClustered: 0,
    cardsSuspect: 0,
    bytesDownloaded: 0,
    elapsedMs: 0,
    firstError: null,
  };

  console.log(JSON.stringify({
    event: "phash_pipeline_start",
    source: "phashOrchestrator.service",
    daysBack, saleLimit, batchSize, downloadConcurrency, hammingThreshold,
  }));

  const sales = await readRecentSales(daysBack);
  result.salesConsidered = sales.length;
  if (sales.length === 0) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  const alreadyHashed = skipAlreadyHashed ? await listHashedPriceHistoryIds() : new Set<string>();
  const toHash = sales.filter((s) => !alreadyHashed.has(s.price_history_id) && s.image_url);
  result.salesSkippedAlreadyHashed = sales.length - toHash.length;
  const capped = saleLimit ? toHash.slice(0, saleLimit) : toHash;

  console.log(JSON.stringify({
    event: "phash_pipeline_hash_start",
    salesToHash: capped.length,
    salesSkipped: result.salesSkippedAlreadyHashed,
  }));

  // Hash new sales — concurrent image downloads.
  const touchedCards = new Set<string>();
  let buffer: CHSalePhashDoc[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const res = await upsertPhashBatch(batch);
    result.salesHashed += res.upserted;
    if (!result.firstError && res.firstError) result.firstError = res.firstError;
  };

  for (let i = 0; i < capped.length; i += downloadConcurrency) {
    const slice = capped.slice(i, i + downloadConcurrency);
    const outs = await Promise.all(slice.map(async (sale) => {
      const url = String(sale.image_url ?? "").trim();
      if (!url) return null;
      const res = await computeDhashFromUrl(url);
      result.bytesDownloaded += res.downloadBytes;
      if (!res.hash) {
        result.salesFailedDownload++;
        if (!result.firstError && "error" in res) result.firstError = res.error;
        return null;
      }
      const doc: CHSalePhashDoc = {
        id: sale.price_history_id,
        card_id: sale.card_id,
        sale_date: sale.sale_date,
        image_url: url,
        hash: res.hash,
        hash_algo: HASH_ALGO,
        cluster_id: -1,
        computed_at: new Date().toISOString(),
        download_bytes: res.downloadBytes,
        download_ms: res.downloadMs,
      };
      touchedCards.add(sale.card_id);
      return doc;
    }));
    for (const doc of outs) {
      if (!doc) continue;
      buffer.push(doc);
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  console.log(JSON.stringify({
    event: "phash_pipeline_cluster_start",
    cardsToCluster: touchedCards.size,
  }));

  // Re-cluster each touched card + update its attribution stats.
  for (const cardId of touchedCards) {
    const rows = await getPhashesForCard(cardId);
    if (rows.length === 0) continue;
    const clusterInput = rows.map((r) => ({ price_history_id: r.id, hash: r.hash }));
    const clusters = clusterByHamming(clusterInput, hammingThreshold);

    // Persist cluster_id updates back to the phash rows.
    const clusterUpdates: CHSalePhashDoc[] = rows.map((r, i) => ({
      ...r,
      cluster_id: clusters.assignments[i],
    }));
    await upsertPhashBatch(clusterUpdates);

    // Persist stats.
    const summary = summarizeAttribution(clusters);
    const stats: CHCardAttributionStats = {
      id: cardId,
      card_id: cardId,
      total_hashed_sales: summary.total_hashed_sales,
      cluster_count: summary.cluster_count,
      largest_cluster_size: summary.largest_cluster_size,
      smallest_cluster_size: summary.smallest_cluster_size,
      suspect: summary.suspect,
      last_updated: new Date().toISOString(),
    };
    await upsertAttributionStats(stats);
    result.cardsClustered++;
    if (summary.suspect) result.cardsSuspect++;
  }

  result.elapsedMs = Date.now() - t0;
  console.log(JSON.stringify({
    event: "phash_pipeline_complete",
    source: "phashOrchestrator.service",
    ...result,
  }));
  return result;
}
