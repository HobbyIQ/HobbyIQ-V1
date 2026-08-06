/**
 * CF-WAITLIST (Drew, 2026-08-06).
 *
 * Cosmos-backed waitlist queue. Holds pre-launch signups so we can email
 * everyone at once when we flip the switch. Deduped by lowercased email.
 *
 * Container: `waitlist` in the hobbyiq DB. Partition key `/email` (natural
 * dedup + cheap per-email upserts). Created on first access via
 * createIfNotExists — no portal / infra change required.
 *
 * Doc shape:
 *   {
 *     id: <lower-email>,          // also the partition key value
 *     email: <lower-email>,
 *     rawEmail: <original casing>,
 *     source: "homepage" | ...,
 *     referer: string | null,
 *     userAgent: string | null,
 *     createdAt: ISO string,
 *     notifiedAt: ISO string | null,   // set when the launch blast fires
 *   }
 */

import { CosmosClient, Container } from "@azure/cosmos";

const DB = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER = "waitlist";

let _container: Container | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const db = new CosmosClient(conn).database(DB);
  // Programmatic create — indexing policy is default. Safe (empty container
  // + fresh partition key) and idempotent, so it doesn't count as a live
  // config change on an in-flight container.
  const { container } = await db.containers.createIfNotExists({
    id: CONTAINER,
    partitionKey: { paths: ["/email"] },
  });
  _container = container;
  return _container;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  rawEmail: string;
  source: string;
  referer: string | null;
  userAgent: string | null;
  createdAt: string;
  notifiedAt: string | null;
}

export interface JoinResult {
  ok: boolean;
  alreadyOnList: boolean;
  entry: WaitlistEntry | null;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s || !EMAIL_RE.test(s)) return null;
  return s.toLowerCase();
}

export async function joinWaitlist(input: {
  email: string;
  source?: string;
  referer?: string | null;
  userAgent?: string | null;
}): Promise<JoinResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, alreadyOnList: false, entry: null, error: "invalid-email" };

  const container = await getContainer();
  if (!container) return { ok: false, alreadyOnList: false, entry: null, error: "storage-unavailable" };

  // Check for existing — a point read on (id=email, pk=email) is single-digit
  // RU, way cheaper than a query.
  try {
    const { resource } = await container.item(email, email).read<WaitlistEntry>();
    if (resource) return { ok: true, alreadyOnList: true, entry: resource };
  } catch (err: unknown) {
    // 404 is the expected "no entry yet" path — anything else is a real error.
    const code = (err as { code?: number })?.code;
    if (code !== 404) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[waitlist] read failed:", msg);
      return { ok: false, alreadyOnList: false, entry: null, error: "read-failed" };
    }
  }

  const entry: WaitlistEntry = {
    id: email,
    email,
    rawEmail: String(input.email).trim(),
    source: input.source ?? "homepage",
    referer: input.referer ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: new Date().toISOString(),
    notifiedAt: null,
  };

  try {
    await container.items.create(entry);
    return { ok: true, alreadyOnList: false, entry };
  } catch (err: unknown) {
    // 409 = race with another insert on the same email → treat as already-on-list.
    const code = (err as { code?: number })?.code;
    if (code === 409) return { ok: true, alreadyOnList: true, entry };
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[waitlist] create failed:", msg);
    return { ok: false, alreadyOnList: false, entry: null, error: "create-failed" };
  }
}

/** For the launch broadcast script — page through all entries yet to be
 *  notified. Cross-partition, but the pool is small (< 100K plausibly). */
export async function* iterateUnnotified(): AsyncGenerator<WaitlistEntry> {
  const container = await getContainer();
  if (!container) return;
  const it = container.items.query<WaitlistEntry>({
    query: "SELECT * FROM c WHERE c.notifiedAt = null OR NOT IS_DEFINED(c.notifiedAt) ORDER BY c.createdAt ASC",
  }, { maxItemCount: 200 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) yield r;
  }
}

export async function markNotified(email: string, at: string = new Date().toISOString()): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  try {
    await container.item(email, email).patch({
      operations: [{ op: "set", path: "/notifiedAt", value: at }],
    } as never);
  } catch (err) {
    console.error(`[waitlist] markNotified ${email} failed:`, (err as Error).message);
  }
}

export async function countTotal(): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  const { resources } = await container.items.query<number>({
    query: "SELECT VALUE COUNT(1) FROM c",
  }).fetchAll();
  return resources[0] ?? 0;
}
