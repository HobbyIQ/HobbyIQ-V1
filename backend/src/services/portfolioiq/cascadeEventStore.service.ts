// CF-CASCADE-ALERTS (Drew, 2026-07-17). Cosmos R/W on
// `cascade_events`. Partition /playerSlug, doc id = <playerSlug>::<detectedAt>.
//
// Nightly detection upserts every fired event; iOS reads recent
// unread events for players the user owns.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import type { CascadeEvent } from "../../types/cascadeAlert.types.js";

const CONTAINER_ID = process.env.COSMOS_CASCADE_EVENTS_CONTAINER ?? "cascade_events";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

let sharedContainer: Container | null = null;

async function getContainer(): Promise<Container> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — cascadeEventStore cannot query");
  const client = new CosmosClient(cs);
  const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ["/playerSlug"] },
  });
  sharedContainer = container;
  return container;
}

export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
}

export interface StoredCascadeEvent extends CascadeEvent {
  id: string;
}

export function cascadeEventId(playerSlug: string, detectedAt: string): string {
  return `${playerSlug}::${detectedAt}`;
}

export async function upsertCascadeEvents(events: CascadeEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const container = await getContainer();
  let n = 0;
  for (const ev of events) {
    const doc: StoredCascadeEvent = { ...ev, id: cascadeEventId(ev.playerSlug, ev.detectedAt) };
    await container.items.upsert(doc);
    n++;
  }
  return n;
}

/** Read recent events for a set of player slugs, ordered by detectedAt DESC. */
export async function readRecentEventsForPlayers(
  playerSlugs: string[],
  sinceIso: string,
): Promise<StoredCascadeEvent[]> {
  if (playerSlugs.length === 0) return [];
  const container = await getContainer();
  // Cross-partition query — the set of user-owned players is bounded,
  // typically ≤50. Filter inline.
  const iter = container.items.query<StoredCascadeEvent>({
    query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@slugs, c.playerSlug) AND c.detectedAt >= @since",
    parameters: [
      { name: "@slugs", value: playerSlugs },
      { name: "@since", value: sinceIso },
    ],
  }, { maxItemCount: 200 });
  const out: StoredCascadeEvent[] = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) out.push(...page.resources);
  }
  return out.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}
