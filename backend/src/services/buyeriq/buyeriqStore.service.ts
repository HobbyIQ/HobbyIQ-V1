// CF-BUYERIQ (Drew, 2026-07-31). Backend for the BuyerIQ iOS feature —
// image-first buying checklist for card shows. Users create named lists
// (e.g. "National 2026", "Chicago show 8/15") and add card targets to
// each list. Target = a card the user wants to acquire, with optional
// max-price cap, notes, and priority.
//
// Storage: two Cosmos containers
//   buyeriq_lists    partition /userId  — user's named lists
//   buyeriq_targets  partition /userId  — targets across all lists
//                                          (server-side filter by listId)
//
// Both partitioned on /userId so a user's data lives in one logical
// partition — cheap point-reads on typical usage, no cross-partition
// scans required for the app's read paths.

import { Container, CosmosClient } from "@azure/cosmos";

export interface BuyerIqList {
  id: string;                          // uuid, doc id
  userId: string;                      // partition key
  docType: "list";
  name: string;                        // "National 2026" — user-editable
  description?: string | null;
  showDate?: string | null;            // ISO date the show happens; null for open lists
  showLocation?: string | null;        // "Chicago, IL" — freeform
  archived: boolean;                   // hide from active-lists filter without deleting
  createdAt: string;                   // ISO
  updatedAt: string;                   // ISO
}

export interface BuyerIqTarget {
  id: string;                          // uuid, doc id
  userId: string;                      // partition key
  docType: "target";
  listId: string;                      // parent list; filter server-side by this
  // Card identity — mirrors PortfolioHolding for reuse of pricing rails
  hobbyiqCardId?: string | null;       // canonical slug when known
  playerName: string;
  cardYear?: number | null;
  cardNumber?: string | null;
  setName?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  imageUrl?: string | null;
  // Buying intent
  maxPrice?: number | null;            // user's ceiling; null = no cap
  priority: "high" | "medium" | "low"; // shown as chip on target cell
  notes?: string | null;               // freeform user notes
  status: "wanted" | "acquired" | "passed"; // wanted = still hunting; acquired/passed = closed
  acquiredAt?: string | null;          // set when status flips to acquired
  acquiredPrice?: number | null;
  createdAt: string;                   // ISO
  updatedAt: string;                   // ISO
}

// ─── Container helpers ────────────────────────────────────────────────

let _listsContainer: Container | null = null;
let _targetsContainer: Container | null = null;

async function getListsContainer(): Promise<Container | null> {
  if (_listsContainer) return _listsContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    // CF-BUYERIQ-AUTO-PROVISION: create the container on first read/write
    // so a deploy doesn't need a manual portal step. Idempotent — noop
    // on subsequent calls once it exists.
    const { container } = await db.containers.createIfNotExists({
      id: "buyeriq_lists",
      partitionKey: { paths: ["/userId"] },
    });
    _listsContainer = container;
    return _listsContainer;
  } catch { return null; }
}

async function getTargetsContainer(): Promise<Container | null> {
  if (_targetsContainer) return _targetsContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const { container } = await db.containers.createIfNotExists({
      id: "buyeriq_targets",
      partitionKey: { paths: ["/userId"] },
    });
    _targetsContainer = container;
    return _targetsContainer;
  } catch { return null; }
}

// ─── List CRUD ────────────────────────────────────────────────────────

export async function listLists(userId: string): Promise<BuyerIqList[]> {
  const c = await getListsContainer();
  if (!c) return [];
  const { resources } = await c.items
    .query<BuyerIqList>({
      query: "SELECT * FROM c WHERE c.userId = @u AND c.docType = 'list' ORDER BY c.updatedAt DESC",
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources;
}

export async function upsertList(list: BuyerIqList): Promise<BuyerIqList | null> {
  const c = await getListsContainer();
  if (!c) return null;
  const now = new Date().toISOString();
  const doc: BuyerIqList = {
    ...list,
    docType: "list",
    updatedAt: now,
    createdAt: list.createdAt || now,
  };
  await c.items.upsert(doc);
  return doc;
}

export async function deleteList(userId: string, listId: string): Promise<boolean> {
  const c = await getListsContainer();
  if (!c) return false;
  try {
    await c.item(listId, userId).delete();
    // Also cascade-delete targets on this list
    const t = await getTargetsContainer();
    if (t) {
      const { resources } = await t.items
        .query<{ id: string }>({
          query: "SELECT c.id FROM c WHERE c.userId = @u AND c.listId = @l",
          parameters: [
            { name: "@u", value: userId },
            { name: "@l", value: listId },
          ],
        })
        .fetchAll();
      await Promise.all(
        resources.map((r) => t.item(r.id, userId).delete().catch(() => null)),
      );
    }
    return true;
  } catch { return false; }
}

// ─── Target CRUD ──────────────────────────────────────────────────────

export async function listTargets(userId: string, listId?: string): Promise<BuyerIqTarget[]> {
  const c = await getTargetsContainer();
  if (!c) return [];
  const params: Array<{ name: string; value: string }> = [{ name: "@u", value: userId }];
  let where = "c.userId = @u AND c.docType = 'target'";
  if (listId) {
    where += " AND c.listId = @l";
    params.push({ name: "@l", value: listId });
  }
  const { resources } = await c.items
    .query<BuyerIqTarget>({
      query: `SELECT * FROM c WHERE ${where} ORDER BY c.updatedAt DESC`,
      parameters: params,
    })
    .fetchAll();
  return resources;
}

export async function upsertTarget(target: BuyerIqTarget): Promise<BuyerIqTarget | null> {
  const c = await getTargetsContainer();
  if (!c) return null;
  const now = new Date().toISOString();
  const doc: BuyerIqTarget = {
    ...target,
    docType: "target",
    updatedAt: now,
    createdAt: target.createdAt || now,
  };
  await c.items.upsert(doc);
  return doc;
}

export async function deleteTarget(userId: string, targetId: string): Promise<boolean> {
  const c = await getTargetsContainer();
  if (!c) return false;
  try {
    await c.item(targetId, userId).delete();
    return true;
  } catch { return false; }
}

// Test-only reset for containers (idempotence on parallel test runs).
export function __resetBuyerIqContainersForTests(): void {
  _listsContainer = null;
  _targetsContainer = null;
}
