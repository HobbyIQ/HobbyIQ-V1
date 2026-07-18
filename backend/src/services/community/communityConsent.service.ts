// CF-COMMUNITY-INTELLIGENCE (Drew, 2026-07-17). Consent store for
// community signal contribution. Read side (consuming aggregates) is
// available to all authenticated users; write side (contributing your
// own portfolio/sales/estimates to the aggregation pool) requires
// explicit consent recorded here.
//
// Container: `community_consent`, partition /userId, doc id = userId.
// Small doc, one per user.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_ID = process.env.COSMOS_COMMUNITY_CONSENT_CONTAINER ?? "community_consent";

export interface CommunityConsent {
  id: string;                        // = userId
  userId: string;
  /** MASTER opt-in. When false, none of the sub-flags apply. */
  contributeSignal: boolean;
  /** Fine-grained: share which of your data types? All default true
   *  when master flag is true; users can toggle each independently. */
  shareHoldings: boolean;
  shareSales: boolean;
  shareEngineEstimates: boolean;
  consentedAt: string | null;
  updatedAt: string;
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
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_ID,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      return container;
    } catch {
      return null;
    }
  })();
  return _initPromise;
}

export function _setContainerForTesting(c: Container | null): void {
  _container = c;
  _initPromise = null;
}

/** Default consent (never opt-in without user action). */
export function defaultConsent(userId: string): CommunityConsent {
  return {
    id: userId,
    userId,
    contributeSignal: false,
    shareHoldings: false,
    shareSales: false,
    shareEngineEstimates: false,
    consentedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function readConsent(userId: string): Promise<CommunityConsent> {
  const c = await getContainer();
  if (!c) return defaultConsent(userId);
  try {
    const { resource } = await c.item(userId, userId).read<CommunityConsent>();
    return resource ?? defaultConsent(userId);
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return defaultConsent(userId);
    console.warn(JSON.stringify({
      event: "community_consent_read_error",
      userId,
      error: (err as Error)?.message ?? String(err),
    }));
    return defaultConsent(userId);
  }
}

export async function upsertConsent(
  userId: string,
  patch: Partial<Pick<CommunityConsent,
    "contributeSignal" | "shareHoldings" | "shareSales" | "shareEngineEstimates">>,
): Promise<CommunityConsent> {
  const existing = await readConsent(userId);
  const now = new Date().toISOString();
  const next: CommunityConsent = {
    ...existing,
    ...patch,
    userId,
    id: userId,
    consentedAt:
      patch.contributeSignal === true && !existing.contributeSignal
        ? now
        : patch.contributeSignal === false
          ? null
          : existing.consentedAt,
    updatedAt: now,
  };
  const c = await getContainer();
  if (!c) return next;   // best-effort — no-op when container unavailable
  try {
    await c.items.upsert(next);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "community_consent_upsert_error",
      userId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
  return next;
}

/** Count users who have opted in to contributing signal AND enabled
 *  a specific data type. Cheap read on a small doc. */
export async function countContributorsBy(
  dataType: "shareHoldings" | "shareSales" | "shareEngineEstimates",
): Promise<number> {
  const c = await getContainer();
  if (!c) return 0;
  try {
    const iter = c.items.query<{ n: number }>({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.contributeSignal = true AND c.${dataType} = true`,
    }, { maxItemCount: 1 });
    const page = await iter.fetchNext();
    return (page.resources?.[0] as unknown as number) ?? 0;
  } catch {
    return 0;
  }
}
