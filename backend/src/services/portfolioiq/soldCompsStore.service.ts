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
    ttl: TTL_SEC,
  };

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
      all = all.filter((d) => {
        const docP = normalizeParallelForFilter(d.parallel);
        if (wanted === "" || BASE_ALIASES.has(wanted)) {
          return BASE_ALIASES.has(docP);
        }
        return docP === wanted;
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
