// CF-OBSERVED-MULTIPLIERS (Drew, 2026-07-17). Cosmos read/write on
// `observed_grader_multipliers`. One row per (familyKey, graderTier);
// nightly overwrite.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import type { FamilyMultiplierRow } from "../../types/observedMultipliers.types.js";

const CONTAINER_ID = process.env.COSMOS_OBSERVED_MULTIPLIERS_CONTAINER ?? "observed_grader_multipliers";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

let sharedContainer: Container | null = null;

async function getContainer(): Promise<Container> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — observedMultipliersStore cannot query");
  const client = new CosmosClient(cs);
  const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ["/familyKey"] },
  });
  sharedContainer = container;
  return container;
}

export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
}

/** Stored shape adds id (family::tier). */
export interface StoredMultiplier extends FamilyMultiplierRow {
  id: string;
}

export function multiplierId(familyKey: string, graderTier: string): string {
  return `${familyKey}::${graderTier}`;
}

export async function upsertMultipliers(rows: FamilyMultiplierRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const container = await getContainer();
  let n = 0;
  for (const row of rows) {
    const doc: StoredMultiplier = { ...row, id: multiplierId(row.familyKey, row.graderTier) };
    await container.items.upsert(doc);
    n++;
  }
  return n;
}

/** Read one multiplier by (family, tier). */
export async function readMultiplier(
  familyKey: string,
  graderTier: string,
): Promise<StoredMultiplier | null> {
  const container = await getContainer();
  try {
    const { resource } = await container.item(multiplierId(familyKey, graderTier), familyKey).read<StoredMultiplier>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

/** Read every tier for a family (single-partition query). */
export async function readFamilyMultipliers(familyKey: string): Promise<StoredMultiplier[]> {
  const container = await getContainer();
  const iter = container.items.query<StoredMultiplier>({
    query: "SELECT * FROM c WHERE c.familyKey = @k",
    parameters: [{ name: "@k", value: familyKey }],
  }, { partitionKey: familyKey, maxItemCount: 100 });
  const out: StoredMultiplier[] = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) out.push(...page.resources);
  }
  return out.sort((a, b) => b.multiplier - a.multiplier);
}
