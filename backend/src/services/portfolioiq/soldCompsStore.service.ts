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
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { createHash } from "crypto";

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
  | "cardsight"             // pulled from CS pricing API
  | "ebay-browse-ended";    // eBay Browse listing whose endDate is in the past (auction winning bid or ended BIN) — confirmed sale, not asking price

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
  // CF-SOLD-COMPS-SPORT (Drew, 2026-07-19): sport tag for cross-sport
  // filtering + sport-scoped analytics. Baseball / football / basketball /
  // hockey / soccer / other. Null on legacy docs; readers should treat
  // null as sport-unknown (fall back to card_set text matching).
  // Populated by inferSportFromContext() at every write site.
  sport?: string | null;
  // CF-USER-COMPS-GRADE (Drew, 2026-07-18): grade tier fields for
  // pool-side filtering. gradeCompany null = raw. Present-but-null on
  // legacy docs written before this migration; readers must treat
  // null as raw. Populated by the confirm/rematch/suggester/backfill
  // emit paths from PortfolioHolding.gradeCompany / gradeValue.
  gradeCompany?: string | null;
  gradeValue?: number | null;

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

  // CF-CONTENT-HASH (Drew, 2026-07-20). Cross-source dedup key.
  // sha1 of (cardId, normalizedParallel, isAuto, gradeCompany,
  // gradeValue, priceCents, soldDay). Same underlying sale from
  // different sources (eBay user + CH tracking the same transaction)
  // gets the same hash → recordSoldComp dedups at write time before
  // both rows land. Null on legacy docs written before this migration.
  contentHash?: string | null;

  // CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706 Phase 1b). HobbyIQ's
  // own canonical identifier — deterministic, vendor-independent slug
  // like "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50".
  // Populated on every new write. Null on legacy docs written before
  // this migration; the Phase 1c backfill script will populate them.
  // See hobbyIqCardId.service.ts for the format spec.
  hobbyiqCardId?: string | null;

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
  /** Sport tag ("baseball" / "football" / "basketball" / "hockey" /
   *  "soccer" / null). When absent, inferSportFromContext() derives from
   *  setName + title. */
  sport?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
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

/** CF-SOLD-COMPS-SPORT-INFER (Drew, 2026-07-19). Best-effort sport
 *  detection from setName + title. Explicit "baseball"/"football"/etc.
 *  substrings win. Product-family heuristics (Bowman → baseball, Prizm
 *  is ambiguous) are a fallback. Returns null when unknown so the row
 *  is queryable but excluded from sport-filtered analytics rather than
 *  wrongly bucketed. */
// CF-HOBBYIQ-CARDID-PRINTRUN (Drew, 2026-07-23, issue #706 Phase 1b).
// Extract a print run number from a title. Handles common patterns:
//   "/50", "#/50", "d/50", "/25 Braves", "/999"
// Rejects "1/1" (which means "one of one", not print run 1 of 1 in the
// sold_comps sense — those should be stored via a separate field if we
// need to distinguish). Returns null when no match.
export function extractPrintRunFromTitle(title: string | null | undefined): number | null {
  if (typeof title !== "string" || title.length === 0) return null;
  // Look for "/N" preceded by a non-digit boundary and followed by a
  // non-digit boundary. Reject "1/1" which is a distinct concept.
  const match = title.match(/(?:^|[^0-9\/])\/(\d{1,5})(?:[^0-9]|$)/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return n;
}

export function inferSportFromContext(
  setName: string | null | undefined,
  title: string | null | undefined,
): string | null {
  const text = `${setName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  // Explicit sport substring wins
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (text.includes("soccer") || text.includes("mls") || text.includes("premier league")) return "soccer";
  // Product-family heuristics (unambiguous single-sport lines)
  if (/\bbowman\b/.test(text)) return "baseball";      // Bowman = baseball only
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  // Any other product line → sport-unknown (return null so downstream
  // sport-filtered analytics skip it rather than mis-bucket).
  return null;
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

/** CF-CONTENT-HASH (Drew, 2026-07-20). Canonical hash of the SALE
 *  content — cross-source dedup key. Same underlying sale from any
 *  source (eBay user + CH + eBay browse) produces the same hash. */
function computeContentHash(input: {
  cardId: string;
  parallel?: string | null;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
}): string {
  const normalizeParallel = (s: string | null | undefined): string => {
    return (s ?? "").trim().toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/ refractors?$/, "");    // match stripRefr in canonicalFmv
  };
  const parts = [
    input.cardId.trim(),
    normalizeParallel(input.parallel),
    input.isAuto === true ? "1" : "0",
    (input.gradeCompany ?? "raw").toUpperCase(),
    String(input.gradeValue ?? 0),
    String(Math.round(input.price * 100)),         // priceCents
    (input.soldAt ?? "").slice(0, 10),             // soldDay only — ignore hour/minute noise
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Score a doc for pickCanonical — higher = keep. Mirror the scoring
 *  in scripts/apply-sold-comps-dedup.cjs so pre-write dedup + nightly
 *  cleanup agree on which row wins. */
function scoreForCanonical(row: {
  verifiedByUser?: boolean;
  sourceExternalId?: string | null;
  parallel?: string | null;
  observedAt?: string;
}): number {
  const prefix = row.sourceExternalId ?? "";
  const prefixScore = prefix.startsWith("holding::") ? 50
    : prefix.startsWith("ch-daily::") ? 50
    : 0;
  return (
    (row.verifiedByUser === true ? 100 : 0) +
    prefixScore +
    (row.parallel ? String(row.parallel).length : 0) +
    (row.observedAt ? new Date(row.observedAt).getTime() / 1e11 : 0)
  );
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

  const contentHash = computeContentHash({
    cardId: input.cardId,
    parallel: input.parallel,
    isAuto: input.isAuto,
    gradeCompany: input.gradeCompany,
    gradeValue: input.gradeValue,
    price: input.price,
    soldAt: input.soldAt,
  });

  // CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706 Phase 1b). Compute
  // the canonical hobbyiqCardId from the input attributes. Populated on
  // every new write so downstream consumers can migrate to it as the
  // primary identifier over time. Print run is extracted from the title
  // when a "/N" fragment is present (e.g. "Gold Refractor /50 Braves");
  // otherwise omitted from the slug.
  const sportForSlug = input.sport ?? inferSportFromContext(input.setName, input.title);
  const hobbyiqCardId = (input.cardYear !== null && input.cardYear !== undefined && sportForSlug !== null)
    ? computeHobbyIqCardId({
        sport: sportForSlug,
        year: input.cardYear,
        setKey: input.setName ?? "",
        cardNumber: input.cardNumber ?? "",
        parallel: input.parallel ?? "Base",
        isAuto: input.isAuto ?? false,
        printRun: extractPrintRunFromTitle(input.title),
      })
    : null;

  const doc: SoldCompDoc = {
    id: makeId(input.source, input.sourceExternalId ?? null, input.cardId, input.soldAt),
    cardId: input.cardId.trim(),
    playerName: input.playerName.trim(),
    cardYear: input.cardYear ?? null,
    setName: input.setName ?? null,
    parallel: input.parallel ?? null,
    cardNumber: input.cardNumber ?? null,
    isAuto: input.isAuto ?? false,
    sport: input.sport ?? inferSportFromContext(input.setName, input.title),
    gradeCompany: input.gradeCompany ?? null,
    gradeValue: input.gradeValue ?? null,
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
    contentHash,
    hobbyiqCardId,
    ttl: TTL_SEC,
  };

  // CF-CONTENT-HASH-PREWRITE-DEDUP (Drew, 2026-07-20). Cross-source
  // dedup at the write boundary. Query for any existing row in this
  // cardId partition with the same contentHash. If one exists, apply
  // pickCanonical scoring — the incoming write only lands if it beats
  // every existing dup; otherwise skip. Prevents future duplicates
  // regardless of which emit path fires (eBay user + CH tracking same
  // sale + browse-ended finding same listing all collapse to one row).
  //
  // CF-CONTENT-HASH-CROSS-SOURCE-ONLY (Drew, 2026-07-21). Only apply
  // dedup when at least one existing row is from a DIFFERENT source
  // than the incoming. Same-source-different-externalId is genuinely
  // two distinct sales (two sellers with same asking price on same
  // day) — the source's own external id is the authority, not our
  // content hash.
  try {
    const { resources: existing } = await c.items.query<SoldCompDoc>({
      query: "SELECT * FROM c WHERE c.contentHash = @h",
      parameters: [{ name: "@h", value: contentHash }],
    }, { partitionKey: doc.cardId }).fetchAll();

    const crossSourceExisting = existing.filter(e => e.source !== doc.source);

    if (crossSourceExisting.length > 0) {
      const incomingScore = scoreForCanonical(doc);
      const bestExistingScore = Math.max(...crossSourceExisting.map(scoreForCanonical));
      if (incomingScore <= bestExistingScore) {
        // Existing row is canonical → skip. Log at 1% sample so we can
        // measure the dedup hit rate in App Insights.
        if (Math.random() < 0.01) {
          console.log(JSON.stringify({
            event: "sold_comps_prewrite_dedup_skipped",
            source: "soldCompsStore.recordSoldComp",
            cardId: doc.cardId,
            contentHash,
            incomingSource: doc.source,
            existingCount: existing.length,
            sampled: true,
          }));
        }
        return;
      }
      // Incoming wins → delete cross-source existing rows before
      // writing so we don't leave stale-canonical rows behind. Same-
      // source rows are left in place (they're independent sales).
      for (const e of crossSourceExisting) {
        try { await c.item(e.id, doc.cardId).delete(); } catch { /* best effort */ }
      }
      console.log(JSON.stringify({
        event: "sold_comps_prewrite_dedup_replaced",
        source: "soldCompsStore.recordSoldComp",
        cardId: doc.cardId,
        contentHash,
        replacedCount: crossSourceExisting.length,
        incomingSource: doc.source,
      }));
    }
  } catch (err) {
    // Dedup-query failure is non-fatal; fall through to the upsert.
    // Idempotent upsert on the (source, sourceExternalId) id still
    // prevents same-path dups.
    if (Math.random() < 0.01) {
      console.warn(JSON.stringify({
        event: "sold_comps_prewrite_dedup_query_failed",
        source: "soldCompsStore.recordSoldComp",
        cardId: doc.cardId,
        error: (err as Error)?.message ?? String(err),
        sampled: true,
      }));
    }
  }

  try {
    await c.items.upsert(doc as any);
    // CF-CANONICAL-FMV-INVALIDATION (Drew, 2026-07-18): kick the
    // Redis cache for this (cardId, parallel, grade) so the next FMV
    // read across any surface picks up the new sale. Fire-and-forget;
    // failure to invalidate never blocks the write.
    void (async () => {
      try {
        const { invalidateCanonicalFmvCache } = await import(
          "../compiq/canonicalFmv.service.js"
        );
        await invalidateCanonicalFmvCache({
          cardId: doc.cardId,
          parallel: doc.parallel,
          gradeCompany: doc.gradeCompany ?? null,
          gradeValue: doc.gradeValue ?? null,
        });
      } catch (err) {
        // CF-FMV-CACHE-INVALIDATE-TELEMETRY (Drew, 2026-07-19).
        // Silent swallow lets a broken dynamic import go undetected
        // for weeks — every write leaves stale FMV cached. Log at
        // warn so App Insights can chart the event; rate-limited via
        // downsampling to avoid spamming when the cache module is
        // globally unhealthy.
        if (Math.random() < 0.01) {
          console.warn(JSON.stringify({
            event: "sold_comps_fmv_invalidate_failed",
            source: "soldCompsStore.service",
            cardId: doc.cardId,
            error: (err as Error)?.message ?? String(err),
            sampled: true,
          }));
        }
      }
    })();
  } catch (err) {
    // CF-EMIT-FAILURE-COUNTER (Drew, 2026-07-19). Every caller of
    // recordSoldComp wraps in try/catch that swallows silently —
    // meaning a broken emit path (Cosmos throttle, schema drift,
    // container missing) is invisible unless you already know to
    // look here. Increment a monotonic counter so App Insights can
    // chart sold_comps_emit_failure rate and alert on spikes. Also
    // keep the per-event warn for triage.
    _emitFailureCounter++;
    console.warn(JSON.stringify({
      event: "sold_comps_upsert_error",
      source: "soldCompsStore.service",
      cardId: input.cardId,
      compSource: input.source,
      error: (err as Error)?.message ?? String(err),
      cumulativeEmitFailures: _emitFailureCounter,
    }));
  }
}

/** Monotonic counter of upsert failures across the process lifetime.
 *  Exposed via getEmitFailureCount() for health-check endpoints. */
let _emitFailureCounter = 0;
export function getEmitFailureCount(): number { return _emitFailureCounter; }

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
  // CF-USER-COMPS-PARALLEL-FILTER (Drew, 2026-07-18): when set,
  // returns only comps whose parallel matches (case-insensitive,
  // trimmed). CH's card-search often returns the same cardId for
  // all parallels sharing a cardNumber (e.g. every #CPA-EHA variant
  // shares one Bowman Chrome cardId), so pool queries without this
  // filter dilute a "True Blue" holding's FMV across Blue X-Fractor,
  // Green Shimmer, etc. Applied in-code after fetch to avoid brittle
  // SQL string-normalization; the extra RUs are trivial vs the
  // correctness win.
  parallel?: string | null;
  // CF-USER-COMPS-GRADE-FILTER (Drew, 2026-07-18): when set, returns
  // only comps whose grade tier matches. A Raw comp and a PSA 10
  // comp trade at very different prices for the same cardId; mixing
  // them in the FMV pool dilutes each grade's anchor. gradeCompany
  // format matches SoldCompDoc.gradeCompany ("PSA", "BGS", "SGC",
  // null = raw); gradeValue is the numeric grade (10, 9.5, etc; null
  // for raw). Case-insensitive on company.
  gradeCompany?: string | null;
  gradeValue?: number | null;
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
    let all = resources as SoldCompDoc[];
    if (input.sources && input.sources.length > 0) {
      const set = new Set(input.sources);
      all = all.filter((d) => set.has(d.source));
    }
    if (typeof input.parallel === "string") {
      const wanted = normalizeParallelForFilter(input.parallel);
      // Empty string as filter = "no-parallel / base holdings only" —
      // match against docs whose parallel is null / "" / "Base" / "[Base]".
      const BASE_ALIASES = new Set(["", "base", "[base]", "none", "no parallel"]);
      // CF-TITLE-PARALLEL-FALLBACK (Drew, 2026-07-23). Cardsight + eBay
      // sources store lossy parallel labels — Cardsight normalizes many
      // gold/blue/green/etc. variants down to just "Refractor" or "Blue
      // Refractor" and pushes the specific variant into the title text.
      // When exact-match on the parallel field would exclude a row, fall
      // back to a title-contains check with the FULL (un-stripped) wanted
      // parallel string. Only fires when the wanted parallel has ≥2
      // tokens — single-token "Refractor" queries stay strict to avoid
      // over-matching. Fixes cases like Hartman Gold Refractor /50 where
      // Cardsight rows at $2,275-$2,500 were dropped by the exact filter.
      const wantedFull = String(input.parallel).trim().toLowerCase().replace(/\s+/g, " ");
      const wantedTokens = wantedFull.split(" ").filter(Boolean);
      const enableTitleFallback = wantedTokens.length >= 2 && !BASE_ALIASES.has(wanted);
      all = all.filter((d) => {
        const docP = normalizeParallelForFilter(d.parallel);
        if (wanted === "" || BASE_ALIASES.has(wanted)) {
          return BASE_ALIASES.has(docP);
        }
        if (docP === wanted) return true;
        if (enableTitleFallback) {
          const docTitleLower = String(d.title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
          if (docTitleLower && docTitleLower.includes(wantedFull)) return true;
        }
        return false;
      });
    }
    // CF-USER-COMPS-GRADE-FILTER (Drew, 2026-07-18): filter to the
    // requested grade tier. Raw request (gradeCompany null/undefined
    // AND gradeValue null/undefined) matches docs with null grade
    // fields. Otherwise both company + value must match exactly
    // (company case-insensitive, value strict-equal).
    if (input.gradeCompany !== undefined || input.gradeValue !== undefined) {
      const wantedCompany = typeof input.gradeCompany === "string"
        ? input.gradeCompany.trim().toUpperCase()
        : "";
      const wantedValue = typeof input.gradeValue === "number" && Number.isFinite(input.gradeValue)
        ? input.gradeValue
        : null;
      const wantRaw = wantedCompany === "" && wantedValue === null;
      all = all.filter((d) => {
        const docCompany = typeof d.gradeCompany === "string" ? d.gradeCompany.trim().toUpperCase() : "";
        const docValue = typeof d.gradeValue === "number" ? d.gradeValue : null;
        const docIsRaw = docCompany === "" && docValue === null;
        if (wantRaw) return docIsRaw;
        return docCompany === wantedCompany && docValue === wantedValue;
      });
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

/** Lowercase-trim-collapse for parallel string equality. Handles the
 *  common ways users/vendors format parallels ("Blue Refractor" vs
 *  "blue  refractor" vs " Blue Refractor ").
 *
 *  CF-PARALLEL-REFRACTOR-ALIAS (Drew, 2026-07-18): also strips a
 *  trailing " refractor" / " refractors" so "Blue" and "Blue Refractor"
 *  normalize to the same key. Rationale: CH's catalog and sellers omit
 *  or include the "Refractor" suffix inconsistently for Bowman Chrome
 *  autos (which are on refractor stock by design). This alias produces
 *  correct matches for the common case AND doesn't collapse specific
 *  sub-parallels (Blue X-Fractor, Green Shimmer Refractor, Speckle
 *  Refractor) because each has its own distinctive token that survives
 *  the strip. */
function normalizeParallelForFilter(p: string | null | undefined): string {
  if (p === null || p === undefined) return "";
  const norm = String(p).trim().toLowerCase().replace(/\s+/g, " ");
  return norm.replace(/ refractors?$/, "");
}

/**
 * CF-COMPS-EXPORT (Drew, 2026-07-20). Read every comp a user
 * contributed. Cross-partition scan — Cosmos-expensive at scale but
 * fine at today's per-user volumes (typically <500 rows per user).
 * Powers GET /api/portfolio/comps/export.
 */
export async function readCompsByContributor(input: {
  contributorUserId: string;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const q = {
    query: "SELECT * FROM c WHERE c.contributorUserId = @uid ORDER BY c.soldAt DESC",
    parameters: [{ name: "@uid", value: input.contributorUserId }],
  };
  try {
    const { resources } = await c.items.query(q).fetchAll();
    return resources as SoldCompDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_read_by_contributor_error",
      source: "soldCompsStore.service",
      contributorUserId: input.contributorUserId,
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

/**
 * CF-CROSS-CARDID-IDENTITY (Drew, 2026-07-23). Cross-cardId fallback
 * for cases where sold_comps rows for a card are stranded under
 * different cardIds — most commonly Cardsight "backstop:" synthetic
 * cardIds that never got linked to a real CH catalog cardId.
 *
 * Cardsight generates identifiers like `backstop:eric hartman|2026||refractor`
 * when it can't resolve a card to a specific CH cardId. Those rows
 * have real market data (e.g. Hartman Gold Refractor /50 sold $2,275-$2,500)
 * but are invisible to `readCompsByCardId` which filters by exact
 * cardId. This helper matches by (playerName, cardYear, cardNumber,
 * parallel) with title-contains fallback for lossy parallels.
 *
 * Cross-partition query. Only call this as a fallback when
 * readCompsByCardId returns thin — never for the primary path.
 * Callers should union the returned rows with their direct-cardId
 * pool, deduplicating by contentHash.
 */
/**
 * CF-HOBBYIQ-CARDID-READ (Drew, 2026-07-23, issue #706 Phase 2a). Read
 * sold_comps by canonical hobbyiqCardId. Unifies rows for the same
 * physical card regardless of which vendor cardId they were originally
 * stored under (CH's bubble.io ID, Cardsight backstop synthetic ID,
 * eBay item ID — all resolve to the same hobbyiqCardId).
 *
 * Cross-partition query — the container is still partitioned on cardId
 * (vendor). Once every row has hobbyiqCardId populated (post-backfill),
 * this becomes the primary canonical read path; the legacy
 * readCompsByCardId + readCompsByIdentity paths become fallbacks for
 * rows that haven't been backfilled yet.
 *
 * Only rows with hobbyiqCardId set are returned — legacy rows (pre-
 * migration or missing identity data) are silently excluded. Callers
 * that need full coverage should still call the legacy read paths
 * alongside.
 */
export async function readCompsByHobbyIqCardId(input: {
  hobbyiqCardId: string;
  fromDate?: string;
  sources?: SoldCompSource[];
  gradeCompany?: string | null;
  gradeValue?: number | null;
  limit?: number;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const hiqId = String(input.hobbyiqCardId ?? "").trim();
  if (!hiqId || !hiqId.startsWith("hiq:")) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));

  const params: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@hiq", value: hiqId },
    { name: "@from", value: from },
  ];
  const query = `SELECT TOP @lim * FROM c
                 WHERE c.hobbyiqCardId = @hiq
                   AND c.soldAt >= @from
                 ORDER BY c.soldAt DESC`;

  let rows: SoldCompDoc[] = [];
  try {
    const { resources } = await c.items.query({ query, parameters: params }).fetchAll();
    rows = resources as SoldCompDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_read_by_hobbyiq_cardid_error",
      source: "soldCompsStore.service",
      hobbyiqCardId: hiqId,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }

  if (input.sources && input.sources.length > 0) {
    const set = new Set(input.sources);
    rows = rows.filter((d) => set.has(d.source));
  }
  if (input.gradeCompany !== undefined || input.gradeValue !== undefined) {
    const wantedCompany = typeof input.gradeCompany === "string" ? input.gradeCompany.trim().toUpperCase() : "";
    const wantedValue = typeof input.gradeValue === "number" && Number.isFinite(input.gradeValue) ? input.gradeValue : null;
    const isRawRequest = wantedCompany === "" && wantedValue === null;
    rows = rows.filter((d) => {
      const docCompany = typeof d.gradeCompany === "string" ? d.gradeCompany.trim().toUpperCase() : "";
      const docValue = typeof d.gradeValue === "number" && Number.isFinite(d.gradeValue) ? d.gradeValue : null;
      const docIsRaw = docCompany === "" && docValue === null;
      if (isRawRequest) return docIsRaw;
      return docCompany === wantedCompany && docValue === wantedValue;
    });
  }
  return rows;
}

export async function readCompsByIdentity(input: {
  playerName: string;
  cardYear?: number | null;
  cardNumber?: string | null;
  parallel?: string | null;
  fromDate?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  limit?: number;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const player = String(input.playerName ?? "").trim();
  if (!player) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));

  // Base query: player + soldAt window. Add year + cardNumber filters
  // when provided — these are the strongest identity signals.
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@player", value: player },
    { name: "@from", value: from },
  ];
  let query = "SELECT TOP @lim * FROM c WHERE LOWER(c.playerName) = LOWER(@player) AND c.soldAt >= @from";
  if (typeof input.cardYear === "number" && Number.isFinite(input.cardYear)) {
    params.push({ name: "@year", value: input.cardYear });
    query += " AND c.cardYear = @year";
  }
  // CF-CROSS-CARDID-PARALLEL-NARROW (Drew, 2026-07-23). Push the parallel
  // match into SQL so the TOP-limit doesn't cap us out on the newest 100
  // Hartman sales before we ever see the target rows. Match either exact
  // parallel field OR title-contains (for lossy Cardsight/eBay parallels).
  const wantedParallelFull = typeof input.parallel === "string"
    ? input.parallel.trim().toLowerCase()
    : "";
  if (wantedParallelFull.length > 0) {
    params.push({ name: "@par", value: wantedParallelFull });
    query += ' AND (LOWER(c.parallel) = @par OR CONTAINS(LOWER(c.title ?? ""), @par))';
  }
  query += " ORDER BY c.soldAt DESC";
  // cardNumber filter is applied JS-side (lenient — null cardNumber OK).
  const wantedCn = typeof input.cardNumber === "string" && input.cardNumber.trim().length > 0
    ? input.cardNumber.trim().toLowerCase()
    : null;

  let rows: SoldCompDoc[] = [];
  try {
    const { resources } = await c.items.query({ query, parameters: params }).fetchAll();
    rows = resources as SoldCompDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "sold_comps_read_by_identity_error",
      source: "soldCompsStore.service",
      playerName: player,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }

  // Lenient cardNumber filter: rows with cardNumber = wanted match
  // strictly; rows with cardNumber null/undefined match if the title-
  // fallback catches them via parallel-in-title. That way Cardsight
  // backstop rows with no cardNumber but a Gold Refractor title still
  // count for a Hartman CPA-EHA Gold Refractor identity lookup.
  if (wantedCn !== null) {
    rows = rows.filter((d) => {
      const docCn = typeof d.cardNumber === "string" ? d.cardNumber.trim().toLowerCase() : null;
      return docCn === null || docCn === wantedCn;
    });
  }

  // Apply the same parallel + grade filters as readCompsByCardId, in-JS
  // (with the title-fallback for lossy Cardsight/eBay parallels).
  if (typeof input.parallel === "string") {
    const wanted = normalizeParallelForFilter(input.parallel);
    const BASE_ALIASES = new Set(["", "base", "[base]", "none", "no parallel"]);
    const wantedFull = String(input.parallel).trim().toLowerCase().replace(/\s+/g, " ");
    const wantedTokens = wantedFull.split(" ").filter(Boolean);
    const enableTitleFallback = wantedTokens.length >= 2 && !BASE_ALIASES.has(wanted);
    rows = rows.filter((d) => {
      const docP = normalizeParallelForFilter(d.parallel);
      if (wanted === "" || BASE_ALIASES.has(wanted)) return BASE_ALIASES.has(docP);
      if (docP === wanted) return true;
      if (enableTitleFallback) {
        const docTitleLower = String(d.title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        if (docTitleLower && docTitleLower.includes(wantedFull)) return true;
      }
      return false;
    });
  }
  if (input.gradeCompany !== undefined || input.gradeValue !== undefined) {
    const wantedCompany = typeof input.gradeCompany === "string" ? input.gradeCompany.trim().toUpperCase() : "";
    const wantedValue = typeof input.gradeValue === "number" && Number.isFinite(input.gradeValue) ? input.gradeValue : null;
    const isRawRequest = wantedCompany === "" && wantedValue === null;
    rows = rows.filter((d) => {
      const docCompany = typeof d.gradeCompany === "string" ? d.gradeCompany.trim().toUpperCase() : "";
      const docValue = typeof d.gradeValue === "number" && Number.isFinite(d.gradeValue) ? d.gradeValue : null;
      const docIsRaw = docCompany === "" && docValue === null;
      if (isRawRequest) return docIsRaw;
      return docCompany === wantedCompany && docValue === wantedValue;
    });
  }
  return rows;
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
