// CF-ERP-EXPANSION-#4 (2026-06-03): per-user tax-filing records for the
// 1099-K reconciliation surface. Container `tax_filings`, partition /userId.
// One doc per (userId, taxYear).

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export type TaxFilingRail = "ebay" | "paypal" | "venmo";

export const TAX_FILING_RAILS: ReadonlyArray<TaxFilingRail> = ["ebay", "paypal", "venmo"];

export interface TaxFilingRailEntry {
  reportedGross1099K: number;
  note?: string;
}

export interface TaxFiling {
  userId: string;
  taxYear: number;
  rails: Partial<Record<TaxFilingRail, TaxFilingRailEntry>>;
  updatedAt: string;
}

interface TaxFilingDocument extends TaxFiling {
  id: string;             // `${userId}:${taxYear}`
  docType: "tax_filing";
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
      const containerName = process.env.COSMOS_TAX_FILINGS_CONTAINER ?? "tax_filings";

      if (!endpoint && !connStr) {
        console.warn("[taxFilings.repository] COSMOS not configured — repository disabled");
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
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log(`[taxFilings.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[taxFilings.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

function docId(userId: string, taxYear: number): string {
  return `${userId}:${taxYear}`;
}

export async function getTaxFiling(userId: string, taxYear: number): Promise<TaxFiling | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(docId(userId, taxYear), userId).read<TaxFilingDocument>();
    if (!resource) return null;
    return {
      userId: resource.userId,
      taxYear: resource.taxYear,
      rails: resource.rails ?? {},
      updatedAt: resource.updatedAt,
    };
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error("[taxFilings.repository] getTaxFiling failed:", err?.message ?? err);
    return null;
  }
}

export async function upsertTaxFiling(
  userId: string,
  taxYear: number,
  rails: Partial<Record<TaxFilingRail, TaxFilingRailEntry>>,
): Promise<TaxFiling | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date().toISOString();
  // Merge with existing so partial PUTs don't wipe sibling rails.
  let existing: TaxFiling | null = null;
  try {
    const { resource } = await container.item(docId(userId, taxYear), userId).read<TaxFilingDocument>();
    if (resource) {
      existing = {
        userId: resource.userId,
        taxYear: resource.taxYear,
        rails: resource.rails ?? {},
        updatedAt: resource.updatedAt,
      };
    }
  } catch (err: any) {
    if (err?.code !== 404) {
      console.error("[taxFilings.repository] read-before-upsert failed:", err?.message ?? err);
    }
  }
  const merged: Partial<Record<TaxFilingRail, TaxFilingRailEntry>> = { ...(existing?.rails ?? {}) };
  for (const [rail, entry] of Object.entries(rails) as Array<[TaxFilingRail, TaxFilingRailEntry]>) {
    merged[rail] = entry;
  }
  const doc: TaxFilingDocument = {
    id: docId(userId, taxYear),
    docType: "tax_filing",
    userId,
    taxYear,
    rails: merged,
    updatedAt: now,
  };
  try {
    const { resource } = await container.items.upsert<TaxFilingDocument>(doc);
    if (!resource) return doc;
    return {
      userId: resource.userId,
      taxYear: resource.taxYear,
      rails: resource.rails ?? {},
      updatedAt: resource.updatedAt,
    };
  } catch (err: any) {
    console.error("[taxFilings.repository] upsertTaxFiling failed:", err?.message ?? err);
    return null;
  }
}

/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge all tax_filings docs for a user.
 * Single-partition query+delete loop.
 */
export async function deleteAllTaxFilingsForUser(userId: string): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  let deleted = 0;
  try {
    const { resources } = await container.items
      .query<TaxFilingDocument>(
        {
          query: "SELECT c.id, c.taxYear FROM c WHERE c.docType = 'tax_filing' AND c.userId = @uid",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    for (const row of resources) {
      try {
        await container.item(row.id, userId).delete();
        deleted += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[taxFilings.repository] deleteAllTaxFilingsForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[taxFilings.repository] deleteAllTaxFilingsForUser failed:", err?.message ?? err);
  }
  return deleted;
}
