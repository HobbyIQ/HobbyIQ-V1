// CF-QUARANTINE-VIEW (Drew, 2026-08-01). Read-only surface for the
// admin "quarantine" tab. Aggregates rows flagged by any of the four
// contamination signals into a browsable list, sorted by "worst first"
// (multi-flag rows surface at the top).

import { CosmosClient, type Container } from "@azure/cosmos";

export interface QuarantineRow {
  id: string;
  cardId: string;
  playerName: string | null;
  cardYear: number | null;
  cardNumber: string | null;
  parallel: string | null;
  price: number;
  source: string;
  soldAt: string | null;
  title: string | null;
  imageUrl: string | null;
  hobbyiqCardId: string | null;
  flags: {
    priceOutlier: boolean;
    priceOutlierBand?: string | null;
    priceOutlierPoolMedian?: number | null;
    cardsightUnverified: boolean;
    userFlagQuarantine: boolean;
    userFlagCount: number;
    badActorSeller: boolean;
  };
  flagCount: number;
}

export interface QuarantineResponse {
  items: QuarantineRow[];
  totalReturned: number;
  hasMore: boolean;
  filter: string;
}

let cachedSc: Container | null = null;
function getSc(): Container | null {
  if (cachedSc) return cachedSc;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedSc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedSc;
}

export async function listQuarantined(opts: {
  filter?: "any" | "price-outlier" | "cardsight-unverified" | "user-flagged" | "bad-actor";
  limit?: number;
}): Promise<QuarantineResponse | null> {
  const sc = getSc();
  if (!sc) return null;
  const filter = opts.filter ?? "any";
  const limit = Math.min(200, Math.max(10, opts.limit ?? 50));

  let whereClause: string;
  switch (filter) {
    case "price-outlier":
      whereClause = "c.__priceOutlier = true"; break;
    case "cardsight-unverified":
      whereClause = "c.__cardsightUnverified = true"; break;
    case "user-flagged":
      whereClause = "c.__userFlagQuarantine = true"; break;
    case "bad-actor":
      whereClause = "c.__badActorSeller = true"; break;
    default:
      whereClause = "c.__priceOutlier = true OR c.__userFlagQuarantine = true OR c.__badActorSeller = true";
  }

  const { resources } = await sc.items.query({
    query: `SELECT TOP ${limit + 1} * FROM c WHERE ${whereClause} ORDER BY c._ts DESC`
  }, { maxItemCount: limit + 1 }).fetchAll();

  const items: QuarantineRow[] = resources.slice(0, limit).map((r) => {
    const row = r as Record<string, unknown>;
    const flags = {
      priceOutlier: row.__priceOutlier === true,
      priceOutlierBand: (row.__priceOutlierBand as string | null | undefined) ?? null,
      priceOutlierPoolMedian: (row.__priceOutlierPoolMedian as number | null | undefined) ?? null,
      cardsightUnverified: row.__cardsightUnverified === true,
      userFlagQuarantine: row.__userFlagQuarantine === true,
      userFlagCount: Array.isArray(row.__userFlags) ? (row.__userFlags as unknown[]).length : 0,
      badActorSeller: row.__badActorSeller === true,
    };
    const flagCount = (flags.priceOutlier ? 1 : 0) + (flags.cardsightUnverified ? 1 : 0)
                    + (flags.userFlagQuarantine ? 1 : 0) + (flags.badActorSeller ? 1 : 0);
    return {
      id: String(row.id ?? ""),
      cardId: String(row.cardId ?? ""),
      playerName: (row.playerName as string | null) ?? null,
      cardYear: (row.cardYear as number | null) ?? null,
      cardNumber: (row.cardNumber as string | null) ?? null,
      parallel: (row.parallel as string | null) ?? null,
      price: Number(row.price ?? 0),
      source: String(row.source ?? ""),
      soldAt: (row.soldAt as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      imageUrl: (row.imageUrl as string | null) ?? null,
      hobbyiqCardId: (row.hobbyiqCardId as string | null) ?? null,
      flags,
      flagCount,
    };
  }).sort((a, b) => b.flagCount - a.flagCount);

  return {
    items,
    totalReturned: items.length,
    hasMore: resources.length > limit,
    filter,
  };
}

export async function markRowClean(cardId: string, rowId: string): Promise<{ success: boolean }> {
  const sc = getSc();
  if (!sc) return { success: false };
  try {
    const { resource } = await sc.item(rowId, cardId).read();
    if (!resource) return { success: false };
    const doc = resource as Record<string, unknown>;
    // Clear all contamination flags. Preserve the row itself.
    delete doc.__priceOutlier;
    delete doc.__priceOutlierAt;
    delete doc.__priceOutlierBand;
    delete doc.__priceOutlierPoolMedian;
    delete doc.__priceOutlierReason;
    delete doc.__cardsightUnverified;
    delete doc.__userFlagQuarantine;
    delete doc.__userFlagQuarantineAt;
    delete doc.__badActorSeller;
    doc.__adminCleared = true;
    doc.__adminClearedAt = new Date().toISOString();
    await sc.items.upsert(doc);
    return { success: true };
  } catch { return { success: false }; }
}

export async function markRowQuarantined(cardId: string, rowId: string, reasonNote: string): Promise<{ success: boolean }> {
  const sc = getSc();
  if (!sc) return { success: false };
  try {
    const { resource } = await sc.item(rowId, cardId).read();
    if (!resource) return { success: false };
    const doc = resource as Record<string, unknown>;
    doc.__userFlagQuarantine = true;
    doc.__userFlagQuarantineAt = new Date().toISOString();
    doc.__adminForceQuarantine = true;
    doc.__adminForceQuarantineReason = reasonNote;
    await sc.items.upsert(doc);
    return { success: true };
  } catch { return { success: false }; }
}
