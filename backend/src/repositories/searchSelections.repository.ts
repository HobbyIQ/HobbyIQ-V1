// CF-SEARCH-SELECTION-LOG (2026-07-08, Drew):
// Append-only Cosmos log of user selections after a search. Feeds two
// downstream jobs:
//   1. Nightly aggregation → promotes high-confidence (query, cardId)
//      pairs to learned aliases (searchAliases repository).
//   2. Selection-weighted ranking on /suggest-corrections and similar
//      surfaces — recent popular corrections rank first.
//
// Container: search_selections, partition key /queryNormalized.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";

export type SearchSelectionSource =
  | "suggest-corrections"
  | "search-results"
  | "card-panel-siblings"
  | "manual-identity"
  | "typeahead";

export interface SearchSelectionEntry {
  query: string;
  queryNormalized: string;
  selectedCardId: string;
  resolvedPlayer?: string;
  resolvedVariant?: string;
  resolvedSet?: string;
  resolvedYear?: number;
  source: SearchSelectionSource;
  userId?: string;
  timestamp: string;
}

interface SearchSelectionDocument extends SearchSelectionEntry {
  id: string;   // random UUID — append-only, no coalescing
  docType: "search_selection";
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
      const containerName = process.env.COSMOS_SEARCH_SELECTIONS_CONTAINER ?? "search_selections";

      if (!endpoint && !connStr) {
        console.warn("[searchSelections.repository] COSMOS not configured — repository disabled");
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/queryNormalized"] },
      });
      _container = container;
      console.log(`[searchSelections.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[searchSelections.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Normalize a raw query the same way we do at query time — lowercase,
 * collapse whitespace, strip common non-player tokens. Kept in sync
 * with the /suggest-corrections filter so partition keys align.
 */
export function normalizeSearchQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Append a single selection event. Fire-and-forget; caller does not
 *  await this in the hot path. Silent no-throw. */
export async function logSelection(entry: Omit<SearchSelectionEntry, "queryNormalized" | "timestamp">): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  try {
    const doc: SearchSelectionDocument = {
      id: randomUUID(),
      docType: "search_selection",
      query: entry.query,
      queryNormalized: normalizeSearchQuery(entry.query),
      selectedCardId: entry.selectedCardId,
      resolvedPlayer: entry.resolvedPlayer,
      resolvedVariant: entry.resolvedVariant,
      resolvedSet: entry.resolvedSet,
      resolvedYear: entry.resolvedYear,
      source: entry.source,
      userId: entry.userId,
      timestamp: new Date().toISOString(),
    };
    await container.items.create(doc);
  } catch (err: any) {
    console.warn("[searchSelections.repository] logSelection failed:", err?.message ?? err);
  }
}

/**
 * Aggregate selections for a given (queryNormalized, resolvedPlayer)
 * over the last `lookbackDays`. Used by:
 *   - Nightly aggregation to promote learned aliases (needs distinct
 *     user count, so callers filter on min-users after).
 *   - /suggest-corrections ranking to boost previously-selected
 *     corrections.
 */
export async function getSelectionCountsForQuery(
  queryNormalized: string,
  lookbackDays = 90,
): Promise<Array<{ resolvedPlayer: string; selections: number; distinctUsers: number }>> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const query = `
      SELECT c.resolvedPlayer, c.userId
      FROM c
      WHERE c.queryNormalized = @q
        AND c.timestamp >= @since
        AND IS_DEFINED(c.resolvedPlayer)
    `;
    const { resources } = await container.items
      .query<{ resolvedPlayer: string; userId?: string }>({
        query,
        parameters: [
          { name: "@q", value: queryNormalized },
          { name: "@since", value: since },
        ],
      })
      .fetchAll();

    const byPlayer = new Map<string, { count: number; users: Set<string> }>();
    for (const r of resources) {
      const stat = byPlayer.get(r.resolvedPlayer) ?? { count: 0, users: new Set<string>() };
      stat.count++;
      if (r.userId) stat.users.add(r.userId);
      byPlayer.set(r.resolvedPlayer, stat);
    }
    return Array.from(byPlayer.entries())
      .map(([resolvedPlayer, stat]) => ({
        resolvedPlayer,
        selections: stat.count,
        distinctUsers: stat.users.size,
      }))
      .sort((a, b) => b.selections - a.selections);
  } catch (err: any) {
    console.warn("[searchSelections.repository] getSelectionCountsForQuery failed:", err?.message ?? err);
    return [];
  }
}

/**
 * Cross-query aggregation for the nightly job — finds
 * (queryNormalized → resolvedPlayer) pairs with strong support
 * (distinct users >= minDistinctUsers) for auto-promotion to
 * learned aliases.
 */
export async function findPromotableQueryPairs(
  minDistinctUsers = 10,
  lookbackDays = 90,
): Promise<Array<{ query: string; resolvedPlayer: string; distinctUsers: number; selections: number }>> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    // Cosmos SQL doesn't support DISTINCT COUNT nested in aggregation
    // over user_id per (query, player) tuple cleanly. Materialize the
    // rows and aggregate in-memory.
    const query = `
      SELECT c.queryNormalized, c.resolvedPlayer, c.userId
      FROM c
      WHERE c.timestamp >= @since
        AND IS_DEFINED(c.resolvedPlayer)
    `;
    const { resources } = await container.items
      .query<{ queryNormalized: string; resolvedPlayer: string; userId?: string }>({
        query,
        parameters: [{ name: "@since", value: since }],
      })
      .fetchAll();

    const agg = new Map<string, { query: string; resolvedPlayer: string; count: number; users: Set<string> }>();
    for (const r of resources) {
      const key = `${r.queryNormalized}||${r.resolvedPlayer}`;
      const stat = agg.get(key) ?? {
        query: r.queryNormalized,
        resolvedPlayer: r.resolvedPlayer,
        count: 0,
        users: new Set<string>(),
      };
      stat.count++;
      if (r.userId) stat.users.add(r.userId);
      agg.set(key, stat);
    }
    return Array.from(agg.values())
      .filter((s) => s.users.size >= minDistinctUsers)
      .map((s) => ({
        query: s.query,
        resolvedPlayer: s.resolvedPlayer,
        distinctUsers: s.users.size,
        selections: s.count,
      }))
      .sort((a, b) => b.distinctUsers - a.distinctUsers);
  } catch (err: any) {
    console.warn("[searchSelections.repository] findPromotableQueryPairs failed:", err?.message ?? err);
    return [];
  }
}

/** Test hook. */
export function _resetSearchSelectionsRepositoryForTesting(): void {
  _container = null;
  _initPromise = null;
}
