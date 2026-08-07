// CF-CATALOG-REVIEW (Drew, 2026-08-08). Admin surface for the two
// pending-review buckets created by the match-only + user-seed rules:
//
//   (a) card_catalog docs with verificationStatus='pending-review' —
//       user-seeded entries from add-card / eBay import that need admin
//       confirmation against a product checklist.
//
//   (b) comps_staging rows with status='catalog-unmatched' —
//       vendor ingest that couldn't find a catalog match. These are
//       grouped by their computed slug so admin can add-to-catalog OR
//       reject-and-drop the underlying sales.
//
// Unified queue with a `type` field so the web UI can show both under
// one page; actions differ per type but the shape mostly aligns.

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";

let _catalog: Container | null = null;
let _staging: Container | null = null;

function getCatalog(): Container | null {
  if (_catalog) return _catalog;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _catalog = new CosmosClient(conn).database(COSMOS_DATABASE).container("card_catalog");
    return _catalog;
  } catch { return null; }
}

function getStaging(): Container | null {
  if (_staging) return _staging;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _staging = new CosmosClient(conn).database(COSMOS_DATABASE).container("comps_staging");
    return _staging;
  } catch { return null; }
}

export interface ReviewQueueItem {
  type: "user-seeded" | "vendor-unmatched";
  slug: string;
  cardYear: number | null;
  sport: string | null;
  setName: string | null;
  setKey: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  playerName: string | null;
  source: string;
  confidence: number | null;
  sampleTitles: string[];
  stagedCompCount: number;
  observedAt: string | null;
}

export interface ReviewQueueResult {
  items: ReviewQueueItem[];
  counts: { userSeeded: number; vendorUnmatched: number; total: number };
}

export async function listReviewQueue(opts: {
  limit?: number;
  type?: "user-seeded" | "vendor-unmatched" | "all";
} = {}): Promise<ReviewQueueResult | null> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const type = opts.type ?? "all";
  const cat = getCatalog();
  const stg = getStaging();
  if (!cat || !stg) return null;

  const items: ReviewQueueItem[] = [];
  let userSeededCount = 0;
  let vendorUnmatchedCount = 0;

  if (type === "user-seeded" || type === "all") {
    // Catalog entries flagged pending-review by canonicalize's user-seed
    // path. Sorted newest-observed-first so admin sees the freshest first.
    const { resources: seeded } = await cat.items.query<{
      id: string; sport: string; year?: number; cardYear?: number;
      setName?: string; setKey?: string; cardNumber?: string; number?: string;
      parallel?: string; isAuto?: boolean; playerName?: string; player?: string;
      source?: string; confidence?: number; observedAt?: string;
    }>({
      query: `SELECT TOP @lim c.id, c.sport, c.year, c.cardYear, c.setName, c.setKey,
                     c.cardNumber, c["number"] AS number, c.parallel, c.isAuto,
                     c.playerName, c.player, c.source, c.confidence, c.observedAt
              FROM c
              WHERE c.verificationStatus = 'pending-review'
              ORDER BY c.observedAt DESC`,
      parameters: [{ name: "@lim", value: limit }],
    }).fetchAll();

    userSeededCount = seeded.length;
    for (const s of seeded) {
      items.push({
        type: "user-seeded",
        slug: s.id,
        cardYear: s.cardYear ?? s.year ?? null,
        sport: s.sport ?? null,
        setName: s.setName ?? null,
        setKey: s.setKey ?? null,
        cardNumber: s.cardNumber ?? s.number ?? null,
        parallel: s.parallel ?? null,
        isAuto: !!s.isAuto,
        playerName: s.playerName ?? s.player ?? null,
        source: s.source ?? "unknown",
        confidence: s.confidence ?? null,
        sampleTitles: [],
        stagedCompCount: 0,
        observedAt: s.observedAt ?? null,
      });
    }
  }

  if (type === "vendor-unmatched" || type === "all") {
    // Group staging rows by slug so we can show one row per unmatched
    // card rather than one row per sale. Also count the pending sales
    // per slug so admin knows how many comps will attach on approve.
    const { resources: grouped } = await stg.items.query<{
      slug: string; n: number; sampleTitle?: string; firstObservedAt?: string;
    }>({
      query: `SELECT TOP @lim c.hobbyiqCardId AS slug, COUNT(1) AS n,
                     MIN(c.raw.vendorPayload.title) AS sampleTitle,
                     MIN(c.raw.fetchedAt) AS firstObservedAt
              FROM c
              WHERE c.status = 'catalog-unmatched'
                AND IS_DEFINED(c.hobbyiqCardId)
                AND c.hobbyiqCardId != null
                AND c.hobbyiqCardId != ''
              GROUP BY c.hobbyiqCardId`,
      parameters: [{ name: "@lim", value: limit * 3 }],
    }).fetchAll();

    vendorUnmatchedCount = grouped.length;
    const groupedTopN = grouped.sort((a, b) => b.n - a.n).slice(0, limit);
    for (const g of groupedTopN) {
      // Fetch one row per group for the identity hint fields
      const { resources: sample } = await stg.items.query<{
        raw: {
          vendor?: string;
          vendorPayload?: { title?: string };
          identityHint?: { playerName?: string; cardYear?: number; sport?: string };
        };
      }>({
        query: "SELECT TOP 1 c.raw FROM c WHERE c.hobbyiqCardId = @s AND c.status = 'catalog-unmatched'",
        parameters: [{ name: "@s", value: g.slug }],
      }).fetchAll();
      const hint = sample[0]?.raw?.identityHint ?? {};
      const slugParts = g.slug.split(":"); // hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
      items.push({
        type: "vendor-unmatched",
        slug: g.slug,
        cardYear: hint.cardYear ?? (slugParts[2] ? Number(slugParts[2]) : null),
        sport: hint.sport ?? slugParts[1] ?? null,
        setName: null,
        setKey: slugParts[3] ?? null,
        cardNumber: slugParts[4] ?? null,
        parallel: slugParts[5] ?? null,
        isAuto: slugParts[6] === "auto",
        playerName: hint.playerName ?? null,
        source: sample[0]?.raw?.vendor ?? "unknown",
        confidence: null,
        sampleTitles: g.sampleTitle ? [String(g.sampleTitle)] : [],
        stagedCompCount: Number(g.n) || 0,
        observedAt: g.firstObservedAt ?? null,
      });
    }
  }

  return {
    items,
    counts: { userSeeded: userSeededCount, vendorUnmatched: vendorUnmatchedCount, total: userSeededCount + vendorUnmatchedCount },
  };
}

/** Approve a user-seeded catalog entry — flip verificationStatus to
 *  'verified' + optionally stamp a verifier note. */
export async function approveUserSeeded(slug: string, verifierNote?: string): Promise<{ ok: boolean; error?: string }> {
  const cat = getCatalog();
  if (!cat) return { ok: false, error: "cosmos-unavailable" };
  try {
    // Point-read + upsert (partition key = slug when doc was seeded via canonicalize)
    const { resource } = await cat.item(slug, slug).read();
    if (!resource) return { ok: false, error: "not-found" };
    resource.verificationStatus = "verified";
    resource.verifiedAt = new Date().toISOString();
    if (verifierNote) resource.verifierNote = String(verifierNote).slice(0, 500);
    await cat.item(slug, slug).replace(resource);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/** Reject a user-seeded catalog entry — delete the doc. Any sold_comps
 *  under that slug become orphaned but stay in the pool for now (their
 *  hobbyiqCardId still points at the dead slug). Admin can follow up
 *  with a targeted cleanup if needed. */
export async function rejectUserSeeded(slug: string): Promise<{ ok: boolean; error?: string }> {
  const cat = getCatalog();
  if (!cat) return { ok: false, error: "cosmos-unavailable" };
  try {
    await cat.item(slug, slug).delete();
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return { ok: true }; // idempotent
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/** For a vendor-unmatched slug: create a catalog entry from the slug's
 *  parsed components + the staged rows' identity hints. Then flip the
 *  staged rows' status from 'catalog-unmatched' back to 'pending' so
 *  the promoter can re-process them (they'll now match). */
export async function approveVendorUnmatched(slug: string): Promise<{ ok: boolean; error?: string; staged?: number }> {
  const cat = getCatalog();
  const stg = getStaging();
  if (!cat || !stg) return { ok: false, error: "cosmos-unavailable" };
  try {
    const parts = slug.split(":"); // hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
    if (parts.length < 7 || parts[0] !== "hiq") return { ok: false, error: "invalid-slug" };
    // Read a sample staging row to pull identity hints for the catalog entry
    const { resources: sample } = await stg.items.query<{
      raw: { identityHint?: { playerName?: string; cardYear?: number; sport?: string } };
    }>({
      query: "SELECT TOP 1 c.raw FROM c WHERE c.hobbyiqCardId = @s AND c.status = 'catalog-unmatched'",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    const hint = sample[0]?.raw?.identityHint ?? {};
    const now = new Date().toISOString();
    await cat.items.upsert({
      id: slug,
      cardId: slug,
      hobbyiqCardId: slug,
      sport: parts[1],
      year: Number(parts[2]),
      cardYear: Number(parts[2]),
      setKey: parts[3],
      cardNumber: parts[4]?.toUpperCase(),
      parallel: parts[5],
      isAuto: parts[6] === "auto",
      playerName: hint.playerName ?? null,
      source: "admin-approved",
      confidence: 0.9,
      verificationStatus: "verified",
      verifiedAt: now,
      observedAt: now,
      lastSeenAt: now,
    });
    // Flip staged rows back to pending so the promoter re-processes.
    const { resources: staged } = await stg.items.query<{ id: string }>({
      query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @s AND c.status = 'catalog-unmatched'",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    let flipped = 0;
    for (const row of staged) {
      try {
        await stg.item(row.id, row.id).patch([
          { op: "replace", path: "/status", value: "pending" },
          { op: "add", path: "/statusUpdatedAt", value: now },
        ]);
        flipped++;
      } catch { /* soft */ }
    }
    return { ok: true, staged: flipped };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/** For a vendor-unmatched slug: mark the staged rows 'rejected' so
 *  they never re-promote. No catalog entry created. */
export async function rejectVendorUnmatched(slug: string): Promise<{ ok: boolean; error?: string; staged?: number }> {
  const stg = getStaging();
  if (!stg) return { ok: false, error: "cosmos-unavailable" };
  try {
    const now = new Date().toISOString();
    const { resources: staged } = await stg.items.query<{ id: string }>({
      query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @s AND c.status = 'catalog-unmatched'",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    let flipped = 0;
    for (const row of staged) {
      try {
        await stg.item(row.id, row.id).patch([
          { op: "replace", path: "/status", value: "rejected" },
          { op: "add", path: "/rejectedAt", value: now },
        ]);
        flipped++;
      } catch { /* soft */ }
    }
    return { ok: true, staged: flipped };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}
