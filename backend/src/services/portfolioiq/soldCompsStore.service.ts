// CF-SOLD-COMPS-FOUNDATION (Drew, 2026-07-14): the data-organization
// foundation. Every user-verified sale/purchase becomes a comp record
// in `sold_comps`. Feeds:
//   - compiq pricing engine (as a supplemental comp source alongside CH + CS)
//   - iOS Verify Card sheet (show "N other users have this SKU")
//   - Learning signals (which suggestions get confirmed vs rejected)
//   - Cross-user aggregation (fair-market signals from real transactions)
//
// Container: `sold_comps`, partition `/cardId`. One doc per
// (source, sourceExternalId) tuple — idempotent upsert; re-emitting the
// same eBay itemId won't duplicate.
//
// TRUST BOUNDARY: this store ONLY accepts comps for user-CONFIRMED
// cardIds. Pending-review holdings do NOT emit. Rejected holdings do
// NOT emit. Wrong-cardId pollution poisons other users' prices — the
// gate is upstream, in the emission call sites (confirmHoldingReview,
// sale-recording flow). The store itself is a passive writer; callers
// carry the trust responsibility.
//
// Guards enforced at write time:
//   - cardId required (partition key must exist)
//   - price > 0 (defensive; sellers can enter $0 by mistake)
//   - source must be from the enum (typo-proof)
//   - observedAt server-stamped (auditable via _ts too)
//
// Hygiene: 365-day TTL. Older comps aren't useful for current pricing
// and shouldn't drift the median forever; historical analysis re-hydrates
// from event log if we ever need it. TTL runs container-side; we set
// -1 default and per-doc ttl.
//
// CF-SEASONALITY-EXTENDED-TTL (Drew, 2026-07-15): bumped default from
// 365d to 5 years to retain historical price series for seasonality
// analysis (YoY comparisons, seasonal price waves on prospect/rookie
// cards, buying/selling signal detection). Engine's own recency filter
// (applyRecencyFilter, 21d default) still trims stale comps out of FMV
// aggregation — this TTL just controls how far back we RETAIN records
// for chart/signal purposes.
//
// Env-configurable via SOLD_COMPS_TTL_YEARS (default 5). Set to "-1"
// for no-expiry (permanent retention). Cost implication is small at
// today's write volume (~KB per doc, thousands of docs).

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

function computeTtlSec(): number {
  const raw = process.env.SOLD_COMPS_TTL_YEARS;
  if (raw === "-1") return -1;  // no expiry — permanent retention
  const years = raw ? parseInt(raw, 10) : NaN;
  const effectiveYears = Number.isFinite(years) && years > 0 ? years : 5;
  return effectiveYears * 365 * 24 * 3600;
}
const TTL_SEC = computeTtlSec();

export type SoldCompSource =
  | "ebay-user-purchase"    // user bought this card on eBay (verified via confirm)
  | "ebay-user-sale"        // user sold this card on eBay (recorded via sale flow)
  | "manual-user-entry"     // user added holding manually with purchase price
  | "cardhedge"             // pulled from CH sold-comps API (aggregated vendor data)
  | "cardsight";            // pulled from CS pricing API

export interface SoldCompDoc {
  /** Composite id: `{source}::{sourceExternalId}` — collision-safe. */
  id: string;
  /** Partition — the canonical cardId this sale is attested to. */
  cardId: string;

  // Denormalized identity — search patterns hit these fields directly,
  // so cross-vendor aggregation doesn't need a join to the catalog.
  playerName: string;
  cardYear: number | null;
  setName: string | null;
  parallel: string | null;
  cardNumber: string | null;
  isAuto: boolean;

  // The sale itself
  price: number;
  soldAt: string;              // ISO — when the sale occurred (per source)
  observedAt: string;          // ISO — when WE wrote the record

  source: SoldCompSource;
  /** External id from the source system (eBay itemId, CH comp id, CS record id).
   *  Enables idempotent re-ingest. Null for manual entries. */
  sourceExternalId: string | null;
  /** Which of our users contributed this comp. Null for vendor pulls. */
  contributorUserId: string | null;

  // Original listing/comp context — kept for provenance + search
  title: string | null;
  imageUrl: string | null;
  sellerHandle: string | null;

  // Learning signal — did a real user attest to this cardId?
  verifiedByUser: boolean;
  /** 0.0-1.0. User-verified comps are 1.0. Vendor-pulled comps carry
   *  the vendor's own confidence signal (CH trustReason etc.). */
  confidence: number;

  // CF-USER-COMPS-SOFT-DELETE (Drew, 2026-07-15): moderation flag.
  // When true, engine reader (augmentCompsWithUserPool) skips the row
  // during FMV aggregation. Provenance kept — the doc stays queryable
  // for audit / reputation calculations, but doesn't skew prices.
  // Wrong-attestation recovery UX writes this via flagCompAsWrong().
  flaggedWrong?: boolean;
  flaggedByUserId?: string | null;
  flaggedAt?: string | null;
  /** Free-text reason from the flagger (optional). Kept short for storage
   *  hygiene; iOS UI enforces max length. */
  flaggedReason?: string | null;

  ttl: number;
}

export interface RecordSoldCompInput {
  cardId: string;
  playerName: string;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean;
  price: number;
  soldAt: string;
  source: SoldCompSource;
  sourceExternalId?: string | null;
  contributorUserId?: string | null;
  title?: string | null;
  imageUrl?: string | null;
  sellerHandle?: string | null;
  verifiedByUser?: boolean;
  confidence?: number;
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
      const containerId = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/cardId"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "sold_comps_init_failed",
        source: "soldCompsStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

function makeId(source: SoldCompSource, externalId: string | null, cardId: string, soldAt: string): string {
  // Prefer external id when the source provides one; fall back to a
  // deterministic hash of (cardId, source, soldAt) so manual entries
  // still get stable ids.
  if (externalId && externalId.trim().length > 0) {
    return `${source}::${externalId.trim()}`;
  }
  return `${source}::${cardId}::${soldAt}`;
}

/**
 * Idempotent upsert of a sold comp. Caller is responsible for the
 * trust decision — this store never fabricates the cardId.
 * Silent no-op on missing cardId, non-positive price, or Cosmos absence.
 */
export async function recordSoldComp(input: RecordSoldCompInput): Promise<void> {
  if (!input.cardId || !input.cardId.trim()) return;
  if (!input.playerName || !input.playerName.trim()) return;
  if (typeof input.price !== "number" || input.price <= 0) return;
  if (!input.soldAt) return;

  const c = await getContainer();
  if (!c) return;

  const doc: SoldCompDoc = {
    id: makeId(input.source, input.sourceExternalId ?? null, input.cardId, input.soldAt),
    cardId: input.cardId.trim(),
    playerName: input.playerName.trim(),
    cardYear: input.cardYear ?? null,
    setName: input.setName ?? null,
    parallel: input.parallel ?? null,
    cardNumber: input.cardNumber ?? null,
    isAuto: input.isAuto ?? false,
    price: input.price,
    soldAt: input.soldAt,
    observedAt: new Date().toISOString(),
    source: input.source,
    sourceExternalId: input.sourceExternalId ?? null,
    contributorUserId: input.contributorUserId ?? null,
    title: input.title ?? null,
    imageUrl: input.imageUrl ?? null,
    sellerHandle: input.sellerHandle ?? null,
    verifiedByUser: input.verifiedByUser ?? false,
    confidence: input.confidence ?? (input.verifiedByUser ? 1.0 : 0.5),
    ttl: TTL_SEC,
  };

  try {
    await c.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_upsert_error",
      source: "soldCompsStore.service",
      cardId: input.cardId,
      compSource: input.source,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/**
 * CF-USER-COMPS-SOFT-DELETE (Drew, 2026-07-15): flag a specific comp
 * doc as wrong. Read-modify-write with idempotent flip — same call
 * multiple times = same end-state. Silent no-op on missing doc or
 * Cosmos absence.
 *
 * The engine's `augmentCompsWithUserPool` skips flaggedWrong rows
 * during FMV aggregation, so this is effectively a soft-delete for
 * pricing purposes while preserving the provenance record for audit.
 *
 * Auth check happens upstream (route enforces the flagger is either
 * the contributor or an ops-role); this function trusts the caller.
 */
export async function flagCompAsWrong(input: {
  cardId: string;
  compId: string;
  flaggedByUserId: string;
  reason?: string;
}): Promise<{ status: "flagged" | "not-found" | "no-store" | "error"; error?: string }> {
  if (!input.cardId?.trim() || !input.compId?.trim()) {
    return { status: "error", error: "missing cardId or compId" };
  }
  const c = await getContainer();
  if (!c) return { status: "no-store" };
  try {
    const { resource: existing } = await c.item(input.compId, input.cardId).read<SoldCompDoc>();
    if (!existing) return { status: "not-found" };
    const updated: SoldCompDoc = {
      ...existing,
      flaggedWrong: true,
      flaggedByUserId: input.flaggedByUserId,
      flaggedAt: new Date().toISOString(),
      flaggedReason: input.reason?.trim().slice(0, 500) ?? null,
    };
    await c.items.upsert(updated as any);
    return { status: "flagged" };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.warn(JSON.stringify({
      event: "sold_comps_flag_error",
      source: "soldCompsStore.service",
      cardId: input.cardId,
      compId: input.compId,
      error: msg,
    }));
    // Cosmos 404 → not found (read may throw)
    if (msg.includes("NotFound") || msg.includes("404")) return { status: "not-found" };
    return { status: "error", error: msg };
  }
}

/**
 * Read comps for a specific cardId — engine hot path. Partition-hit,
 * sub-10ms. Ordered by soldAt DESC (newest first).
 */
export async function readCompsByCardId(input: {
  cardId: string;
  fromDate?: string;         // ISO; defaults to 180d ago
  maxDate?: string;          // ISO; defaults to now
  sources?: SoldCompSource[]; // filter to specific sources
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const to = input.maxDate ?? now.toISOString();

  const q = {
    query:
      "SELECT * FROM c WHERE c.cardId = @cid AND c.soldAt >= @from AND c.soldAt <= @to ORDER BY c.soldAt DESC",
    parameters: [
      { name: "@cid", value: input.cardId },
      { name: "@from", value: from },
      { name: "@to", value: to },
    ],
  };
  try {
    const { resources } = await c.items.query(q, { partitionKey: input.cardId }).fetchAll();
    const all = resources as SoldCompDoc[];
    if (input.sources && input.sources.length > 0) {
      const set = new Set(input.sources);
      return all.filter((d) => set.has(d.source));
    }
    return all;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_read_error",
      source: "soldCompsStore.service",
      cardId: input.cardId,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

/**
 * Cross-partition query by player. iOS Verify Card sheet uses this to
 * show "our user base has purchased this player's cards N times" as a
 * relevance signal. Cross-partition — expensive at scale, but fine at
 * <1M records.
 */
export async function readCompsByPlayer(input: {
  playerName: string;
  fromDate?: string;
  limit?: number;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));

  const q = {
    query:
      "SELECT TOP @lim * FROM c WHERE LOWER(c.playerName) = LOWER(@player) AND c.soldAt >= @from ORDER BY c.soldAt DESC",
    parameters: [
      { name: "@lim", value: limit },
      { name: "@player", value: input.playerName },
      { name: "@from", value: from },
    ],
  };
  try {
    const { resources } = await c.items.query(q).fetchAll();
    return resources as SoldCompDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_read_by_player_error",
      source: "soldCompsStore.service",
      playerName: input.playerName,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
