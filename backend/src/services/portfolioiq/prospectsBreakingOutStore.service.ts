// CF-PROSPECTS-BREAKING-OUT-MATERIALIZE (Drew, 2026-07-26). Persisted
// daily rollup of the sub-raw inversion prospect feed. The user-facing
// /api/dailyiq/prospects/breaking-out route was re-computing the
// cross-partition sold_comps scan on every request — fine at prototype
// scale, but the compute takes several seconds and hits Cosmos RU per
// user tap. Pre-materialize the ranked prospects into a dedicated
// container once per night, then serve reads via a single point-read.
//
// Container: `prospects_breaking_out_daily`, partition `/sport`. Doc
// id = `${sport}::${computedDate}`, e.g. `baseball::2026-07-26`. One
// doc per (sport, day). TTL 14 days — we only serve today's or
// yesterday's snapshot.
//
// Contract:
//   - writePrepared(sport, prospects, meta) called by the nightly
//     scan after it computes inversions
//   - readLatest(sport) called by the route to serve reads
//   - readLatest falls back to null when the container / doc is
//     absent; the route then falls back to live compute (backward
//     compat with historical requests + cold-start safety)

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { SubRawInversion } from "../signals/subRawInversionScan.service.js";

export interface ProspectsBreakingOutDoc {
  id: string;                    // `${sport}::${computedDate}`
  sport: string;                 // partition key
  computedDate: string;          // ISO date (YYYY-MM-DD) when the compute ran
  computedAt: string;            // full ISO timestamp
  windowDays: number;
  minMarginPct: number;
  prospects: SubRawInversion[];  // already-ranked (by marginUSD desc) at write time
  totalDetected: number;         // rank-cap-independent count
  ttl: number;
}

const CONTAINER_ID_DEFAULT = "prospects_breaking_out_daily";
const DEFAULT_TTL_SEC = 14 * 24 * 3600;   // 14 days

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
let _testContainer: Container | null = null;

/** Test seam. Pass null to reset. */
export function _setContainerForTests(c: Container | null): void {
  _testContainer = c;
  _container = null;
  _initPromise = null;
}

async function getContainer(): Promise<Container | null> {
  if (_testContainer) return _testContainer;
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_PROSPECTS_BREAKING_OUT_CONTAINER ?? CONTAINER_ID_DEFAULT;
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/sport"] },
        defaultTtl: DEFAULT_TTL_SEC,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "prospects_breaking_out_init_failed",
        source: "prospectsBreakingOutStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Persist the ranked prospects for a sport. Called by the nightly
 *  scan after it computes inversions. Best-effort — a failure logs and
 *  swallows so the scan's telemetry step still completes. */
export async function writeProspectsRollup(input: {
  sport: string;
  windowDays: number;
  minMarginPct: number;
  prospects: SubRawInversion[];
  totalDetected: number;
  computedDate?: string;
}): Promise<boolean> {
  if (!input.sport) return false;
  const container = await getContainer();
  if (!container) return false;
  const computedDate = input.computedDate ?? todayIsoDate();
  const doc: ProspectsBreakingOutDoc = {
    id: `${input.sport}::${computedDate}`,
    sport: input.sport,
    computedDate,
    computedAt: new Date().toISOString(),
    windowDays: input.windowDays,
    minMarginPct: input.minMarginPct,
    prospects: input.prospects,
    totalDetected: input.totalDetected,
    ttl: DEFAULT_TTL_SEC,
  };
  try {
    await container.items.upsert(doc);
    return true;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "prospects_breaking_out_write_failed",
      source: "prospectsBreakingOutStore.service",
      sport: input.sport,
      error: (err as Error)?.message ?? String(err),
    }));
    return false;
  }
}

/** Read the latest rollup for a sport. Falls back through
 *  today → yesterday → null. Returns null on any error so the caller
 *  can fall through to live compute. */
export async function readLatestProspectsRollup(sport: string): Promise<ProspectsBreakingOutDoc | null> {
  if (!sport) return null;
  const container = await getContainer();
  if (!container) return null;
  const today = todayIsoDate();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  for (const date of [today, yesterday]) {
    try {
      const { resource } = await container.item(`${sport}::${date}`, sport).read<ProspectsBreakingOutDoc>();
      if (resource) return resource;
    } catch (err: any) {
      if (err?.code === 404 || err?.statusCode === 404) continue;
      console.warn(JSON.stringify({
        event: "prospects_breaking_out_read_failed",
        source: "prospectsBreakingOutStore.service",
        sport,
        date,
        error: err?.message ?? String(err),
      }));
      return null;
    }
  }
  return null;
}
