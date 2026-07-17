// CF-GRADER-OUTCOMES (Drew, 2026-07-17). Cosmos R/W on
// `grader_outcome_distributions`. Partition /familyKey,
// doc id = "familyKey::grader".

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import type { GraderOutcomeRow } from "../../types/graderOutcome.types.js";

const CONTAINER_ID = process.env.COSMOS_GRADER_OUTCOMES_CONTAINER ?? "grader_outcome_distributions";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

let sharedContainer: Container | null = null;

async function getContainer(): Promise<Container> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — graderOutcomeStore cannot query");
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

export interface StoredGraderOutcome extends GraderOutcomeRow {
  id: string;
}

export function outcomeId(familyKey: string, grader: string): string {
  return `${familyKey}::${grader}`;
}

export async function upsertOutcomes(rows: GraderOutcomeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const container = await getContainer();
  let n = 0;
  for (const row of rows) {
    const doc: StoredGraderOutcome = { ...row, id: outcomeId(row.familyKey, row.grader) };
    await container.items.upsert(doc);
    n++;
  }
  return n;
}

export async function readOutcome(familyKey: string, grader: string): Promise<StoredGraderOutcome | null> {
  const container = await getContainer();
  try {
    const { resource } = await container.item(outcomeId(familyKey, grader), familyKey).read<StoredGraderOutcome>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

export async function readFamilyOutcomes(familyKey: string): Promise<StoredGraderOutcome[]> {
  const container = await getContainer();
  const iter = container.items.query<StoredGraderOutcome>({
    query: "SELECT * FROM c WHERE c.familyKey = @k",
    parameters: [{ name: "@k", value: familyKey }],
  }, { partitionKey: familyKey, maxItemCount: 20 });
  const out: StoredGraderOutcome[] = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) out.push(...page.resources);
  }
  return out;
}
