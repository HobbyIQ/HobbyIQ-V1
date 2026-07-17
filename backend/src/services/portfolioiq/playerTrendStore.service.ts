// CF-PLAYER-TREND (Drew, 2026-07-17). Cosmos read/write on the
// `player_trends` container. Nightly batch computes matched-cohort
// trends for top-N players; API endpoint reads through.
//
// Container: `player_trends`, partition `/player`, doc id = slug(player).
// One row per player. Overwritten on each nightly recompute.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import type {
  PlayerTrendResult,
  StratifiedPlayerTrendResult,
} from "../../types/playerTrend.types.js";

const CONTAINER_ID = process.env.COSMOS_PLAYER_TRENDS_CONTAINER ?? "player_trends";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

let sharedContainer: Container | null = null;

async function getContainer(): Promise<Container> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — playerTrendStore cannot query");
  const client = new CosmosClient(cs);
  const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ["/player"] },
  });
  sharedContainer = container;
  return container;
}

/** Test seam — inject a mock container. */
export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
}

/** Stored shape — mirrors PlayerTrendResult with a Cosmos `id` field.
 *  The `id` is the player name lowercased with non-alphanum → underscore,
 *  chosen for URL-safety on the read endpoint.
 *
 *  CF-STRATIFIED-TRENDS (Drew, 2026-07-17): stratified `raw` and
 *  `graded` sub-trends added at version 2. The top-level momentum /
 *  direction / velocityPerWeek fields still reflect the `all` variant
 *  for back-compat with v1 clients. */
export interface StoredPlayerTrend extends PlayerTrendResult {
  id: string;
  version: number;
  raw?: PlayerTrendResult;
  graded?: PlayerTrendResult;
}

const CURRENT_VERSION = 2;

/** URL-safe stable id from a player name. `slugPlayer("Ken Griffey Jr.") === "ken_griffey_jr"`. */
export function slugPlayer(player: string): string {
  return player
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function upsertPlayerTrend(trend: PlayerTrendResult): Promise<StoredPlayerTrend> {
  const container = await getContainer();
  const doc: StoredPlayerTrend = {
    ...trend,
    id: slugPlayer(trend.player),
    version: CURRENT_VERSION,
  };
  const { resource } = await container.items.upsert(doc);
  return (resource as unknown as StoredPlayerTrend) ?? doc;
}

/** Persist stratified variant (all / raw / graded). Top-level fields
 *  mirror `all` for v1-client back-compat; `raw` and `graded` live in
 *  their sub-fields. */
export async function upsertStratifiedPlayerTrend(
  stratified: StratifiedPlayerTrendResult,
): Promise<StoredPlayerTrend> {
  const container = await getContainer();
  const doc: StoredPlayerTrend = {
    ...stratified.all,
    computedAt: stratified.computedAt,
    id: slugPlayer(stratified.player),
    version: CURRENT_VERSION,
    raw: stratified.raw,
    graded: stratified.graded,
  };
  const { resource } = await container.items.upsert(doc);
  return (resource as unknown as StoredPlayerTrend) ?? doc;
}

export async function readPlayerTrend(player: string): Promise<StoredPlayerTrend | null> {
  const container = await getContainer();
  try {
    const { resource } = await container.item(slugPlayer(player), player).read<StoredPlayerTrend>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

/** Diagnostic — count stored trends. */
export async function countStoredTrends(): Promise<number> {
  const container = await getContainer();
  const iter = container.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }, { maxItemCount: 1 });
  const page = await iter.fetchNext();
  return page.resources?.[0] ?? 0;
}
