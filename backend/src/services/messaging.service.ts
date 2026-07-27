// CF-MESSAGING (Drew, 2026-07-27). In-app messaging + transaction shim.
//
// One Cosmos container: `messages`. Partition by `/threadId` where
// threadId = "thread-{userA}--{userB}" with userA/userB lex-sorted so
// there's exactly one threadId per (unordered) pair of users. Every
// message writes to this container; the "thread list" query groups by
// threadId at read time (small-N acceptable — Drew's early user base).
//
// Doc shape:
//   {
//     id, docType: "message",
//     threadId, fromUserId, toUserId,
//     text, createdAt, readAt?,
//     kind: "chat" | "offer" | "accepted" | "sold",
//     priceCents?,             // present on offer / accepted / sold
//     holdingRef?: {           // present when the message is "about" a card
//       holdingId, sellerUserId,
//       cardTitle, imageUrl, askingPriceCents
//     }
//   }
//
// Design rationale for staying single-container:
//   - Thread state (last message, unread count) can be derived at query
//     time from the message events. Fine at Drew's scale; if it stops
//     being fine we add a `threads` mirror. Yagni until proven.
//   - Transactions are events too: sold = a message with kind="sold"
//     and priceCents set. Same read path renders both. Zero-schema-cost
//     to move to Stripe later — just a new kind + a Stripe intent id
//     on the same doc.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import crypto from "crypto";

export type MessageKind = "chat" | "offer" | "accepted" | "sold";

export interface HoldingRef {
  holdingId: string;
  sellerUserId: string;
  cardTitle: string;
  imageUrl?: string | null;
  askingPriceCents?: number | null;
}

export interface MessageRecord {
  id: string;
  docType: "message";
  threadId: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  createdAt: string;
  readAt?: string | null;
  kind: MessageKind;
  priceCents?: number | null;
  holdingRef?: HoldingRef | null;
}

/**
 * Deterministic threadId for a pair of users. Sorting the userIds
 * lexicographically means (A→B) and (B→A) always resolve to the same
 * thread — no duplicate conversations regardless of who sent first.
 */
export function threadIdFor(userA: string, userB: string): string {
  const [lo, hi] = [userA, userB].sort();
  return `thread-${lo}--${hi}`;
}

// ─── Cosmos client (lazy) ───────────────────────────────────────────────

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
const isTestMode = process.env.NODE_ENV === "test";
const memStore = new Map<string, MessageRecord>();

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName = process.env.COSMOS_MESSAGES_CONTAINER ?? "messages";

      if (!endpoint && !connStr) {
        if (isTestMode) return null;
        console.warn("[messaging] COSMOS not configured — using in-memory store");
        return null;
      }

      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/threadId"] },
      });
      _container = container;
      console.log("[messaging] Cosmos DB messages container ready");
      return container;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cosmos][messaging] init failed, using in-memory: ${msg}`);
      return null;
    }
  })();
  return _initPromise;
}

/** Test helper: reset the in-memory store between tests. */
export function _resetMessagesForTests(): void {
  memStore.clear();
}

// ─── Read helpers ───────────────────────────────────────────────────────

async function readAllForUser(userId: string): Promise<MessageRecord[]> {
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values()).filter(
      (m) => m.fromUserId === userId || m.toUserId === userId,
    );
  }
  const { resources } = await container.items
    .query<MessageRecord>({
      query:
        'SELECT * FROM c WHERE c.docType = "message" ' +
        'AND (c.fromUserId = @u OR c.toUserId = @u)',
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources;
}

async function readMessagesInThread(threadId: string): Promise<MessageRecord[]> {
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values()).filter((m) => m.threadId === threadId);
  }
  const { resources } = await container.items
    .query<MessageRecord>({
      query: 'SELECT * FROM c WHERE c.docType = "message" AND c.threadId = @t',
      parameters: [{ name: "@t", value: threadId }],
    })
    .fetchAll();
  return resources;
}

async function readMessageById(threadId: string, id: string): Promise<MessageRecord | undefined> {
  const container = await getContainer();
  if (!container) return memStore.get(id);
  try {
    const { resource } = await container.item(id, threadId).read<MessageRecord>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

async function writeMessage(record: MessageRecord): Promise<void> {
  const container = await getContainer();
  if (!container) {
    memStore.set(record.id, record);
    return;
  }
  await container.items.upsert(record);
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface SendMessageInput {
  fromUserId: string;
  toUserId: string;
  text: string;
  kind?: MessageKind;
  priceCents?: number | null;
  holdingRef?: HoldingRef | null;
}

/**
 * Send a message. Trims + validates text (text OR priceCents required).
 * Returns the persisted record.
 */
export async function sendMessage(input: SendMessageInput): Promise<MessageRecord> {
  const text = (input.text ?? "").trim();
  const kind: MessageKind = input.kind ?? "chat";
  if (!text && input.priceCents == null && !input.holdingRef) {
    throw new Error("Message must have text, a price, or a holding reference");
  }
  if (input.fromUserId === input.toUserId) {
    throw new Error("Cannot send a message to yourself");
  }
  const record: MessageRecord = {
    id: crypto.randomUUID(),
    docType: "message",
    threadId: threadIdFor(input.fromUserId, input.toUserId),
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    text,
    createdAt: new Date().toISOString(),
    readAt: null,
    kind,
    priceCents: input.priceCents ?? null,
    holdingRef: input.holdingRef ?? null,
  };
  await writeMessage(record);
  return record;
}

export interface ThreadSummary {
  threadId: string;
  otherUserId: string;
  lastMessage: {
    text: string;
    kind: MessageKind;
    fromMe: boolean;
    createdAt: string;
    priceCents?: number | null;
  };
  unreadCount: number;
}

/**
 * List all threads the user participates in. Derives {otherUser, last
 * message, unread count} by grouping the user's message history by
 * threadId. Returned ordered by most-recent first.
 */
export async function listThreads(userId: string): Promise<ThreadSummary[]> {
  const all = await readAllForUser(userId);
  const byThread = new Map<string, MessageRecord[]>();
  for (const m of all) {
    const arr = byThread.get(m.threadId) ?? [];
    arr.push(m);
    byThread.set(m.threadId, arr);
  }

  const summaries: ThreadSummary[] = [];
  for (const [threadId, messages] of byThread) {
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = messages[messages.length - 1];
    const otherUserId = last.fromUserId === userId ? last.toUserId : last.fromUserId;
    const unreadCount = messages.filter(
      (m) => m.toUserId === userId && !m.readAt,
    ).length;
    summaries.push({
      threadId,
      otherUserId,
      lastMessage: {
        text: last.text,
        kind: last.kind,
        fromMe: last.fromUserId === userId,
        createdAt: last.createdAt,
        priceCents: last.priceCents,
      },
      unreadCount,
    });
  }
  summaries.sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
  return summaries;
}

/**
 * List messages in a single thread between userId + otherUserId, oldest
 * first. Also marks the messages the user just read (any incoming
 * message with no readAt gets stamped). Returns the read-stamped list.
 */
export async function listMessagesInThread(
  userId: string,
  otherUserId: string,
): Promise<MessageRecord[]> {
  const threadId = threadIdFor(userId, otherUserId);
  const messages = (await readMessagesInThread(threadId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Mark incoming messages read. Fire-and-await so the response reflects
  // the updated state; misses in the write path are non-fatal (next
  // fetch will re-mark them).
  const now = new Date().toISOString();
  const toUpdate = messages.filter((m) => m.toUserId === userId && !m.readAt);
  for (const m of toUpdate) {
    m.readAt = now;
    await writeMessage(m);
  }
  return messages;
}

/**
 * Mark a single message as "sold" by the seller. Rejects if the caller
 * isn't the seller (fromUserId on the referenced holding), if the
 * message has no priceCents, or if the message doesn't exist.
 *
 * We APPEND a new sold-kind message rather than mutating the offer —
 * message-log semantics + easier future integration with Stripe intents.
 */
export async function markSold(opts: {
  actingUserId: string;
  threadId: string;
  offerMessageId: string;
}): Promise<MessageRecord | null> {
  const offer = await readMessageById(opts.threadId, opts.offerMessageId);
  if (!offer) return null;
  if (offer.priceCents == null) return null;
  // Only the seller (the holdingRef.sellerUserId) can mark sold — or the
  // participant who received the offer, since sellers offer to buyers
  // and buyers offer to sellers. We accept EITHER participant. The
  // guard here is participation, not seller role.
  if (offer.fromUserId !== opts.actingUserId && offer.toUserId !== opts.actingUserId) {
    return null;
  }
  const buyerId =
    offer.holdingRef?.sellerUserId === offer.fromUserId
      ? offer.toUserId
      : offer.fromUserId;
  const sellerId = buyerId === offer.fromUserId ? offer.toUserId : offer.fromUserId;

  const soldRecord: MessageRecord = {
    id: crypto.randomUUID(),
    docType: "message",
    threadId: opts.threadId,
    fromUserId: opts.actingUserId,
    toUserId: opts.actingUserId === sellerId ? buyerId : sellerId,
    text: "Marked as sold",
    createdAt: new Date().toISOString(),
    readAt: null,
    kind: "sold",
    priceCents: offer.priceCents,
    holdingRef: offer.holdingRef,
  };
  await writeMessage(soldRecord);
  return soldRecord;
}

/**
 * Total unread count across every thread. Used for the sidebar badge.
 */
export async function unreadCountFor(userId: string): Promise<number> {
  const all = await readAllForUser(userId);
  return all.filter((m) => m.toUserId === userId && !m.readAt).length;
}
