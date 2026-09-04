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
import { computeHobbyIqCardId, resolveSetKeyForSlug, sameCardNumber } from "./hobbyIqCardId.service.js";
import { guardSlugInputs, normalizeSportStrict, type SlugGuardResult } from "./slugGuard.service.js";
import { playerTheTitleAllows } from "./playerTheTitleAllows.js";
import { canonicalizeParallel } from "./parallelCanonicalizer.service.js";
import { parseParallelComposite } from "./parseParallelComposite.service.js";
import { enrichCompositeV3 } from "./enrichCompositeV3.service.js";
import { poolReadIdsFor, resolveIdentityToCatalogRow, type CatalogRowResolution } from "../catalog/catalogIdentityResolver.js";
import { createHash } from "crypto";
// Type-only: erased at compile time, so this adds no runtime edge back to
// ebayAutoHolding (which imports THIS module dynamically).
import type { SalePriceBasis } from "./ebayAutoHolding.service.js";

// CF-COMPOSITE-EMIT (Drew, 2026-07-30). Compute the 6-axis composite
// from the incoming attributes. Silent-safe — returns null on any
// error so the write path never fails on parser bugs.
function computeCompositeForRow(input: {
  title?: string | null;
  cardNumber?: string | null;
  sport?: string | null;
  setName?: string | null;
  // CF-COMPOSITE-V3 (Drew, 2026-07-31). year + productLine flow through
  // from the parent write path so we can emit the v3 fields inline.
  cardYear?: number | null;
  productLine?: string | null;
}): {
  edition: string | null;
  insertSet: string | null;
  colorFamily: string | null;
  finishModifier: string | null;
  isRefractor: boolean;
  confidence: "high" | "medium" | "low";
  // v3
  era: string | null;
  ladderVerdict: string | null;
  ladderTierColor: string | null;
  ladderTierRun: number | null;
  paniniColorEquivalent: string | null;
} | null {
  try {
    const c = parseParallelComposite(input.title ?? "", input.cardNumber ?? null, {
      sport: input.sport ?? null,
      setName: input.setName ?? null,
    });
    const v3 = enrichCompositeV3({
      cardYear: input.cardYear,
      productLine: input.productLine,
      colorFamily: c.colorFamily,
      serialRun: c.serialRun,
    });
    return {
      edition: c.edition,
      insertSet: c.insertSet,
      colorFamily: c.colorFamily,
      finishModifier: c.finishModifier,
      isRefractor: c.isRefractor,
      confidence: c.confidence,
      era: v3.era,
      ladderVerdict: v3.ladderVerdict,
      ladderTierColor: v3.ladderTierColor,
      ladderTierRun: v3.ladderTierRun,
      paniniColorEquivalent: v3.paniniColorEquivalent,
    };
  } catch {
    return null;
  }
}

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
  // D26 (CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE, Drew 2026-08-30). The hourly
  // eBay ACCOUNT sync: a sold order line on the user's connected eBay account
  // that was never listed through HobbyIQ, resolved to a card from its listing
  // title. Same standing as `ebay-user-sale` -- it is the user's own realized
  // sale -- but a distinct provenance, because nothing in the app created the
  // listing. It NEVER seeds a catalog row (the matcher is asked as
  // `ebay-title`, which is in neither TRUSTED_SOURCES nor
  // USER_SEED_ALLOWED_SOURCES): a sale does not mint a card.
  | "ebay-account"
  | "manual-user-entry"     // user added holding manually with purchase price
  | "cardhedge"             // pulled from CH sold-comps API (aggregated vendor data)
  | "cardsight"             // pulled from CS pricing API
  | "ebay-browse-ended"     // eBay Browse listing whose endDate is in the past (auction winning bid or ended BIN) — confirmed sale, not asking price
  | "tca-ebay";             // thecardapi.com /sales firehose (eBay + auction houses + TCGplayer). See tca-firehose-ingest-architecture.md.

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
  /** CF-PARALLEL-CANONICAL (Drew, 2026-08-06). Slug form of `parallel`
   *  ("blue-refractor" for "Blue Refractor"). Written by the
   *  canonicalizer alongside `parallel`. Filter code should prefer this
   *  over `parallel` since it survives display-form drift. Absent on
   *  legacy docs; readers must derive from `parallel` when null. */
  parallelSlug?: string | null;
  cardNumber: string | null;
  isAuto: boolean;
  /** CF-SOLD-COMPS-PRINTRUN (Drew, 2026-07-23). Extracted from title on
   *  write via extractPrintRunFromTitle. Number for numbered parallels
   *  (/150, /50, /5), null for unnumbered. Used by pool-filter code to
   *  strictly separate /150 auto from /50 auto — same cardId can bucket
   *  multiple print runs together. Absent on some legacy docs; readers
   *  treat absent as null (unnumbered). */
  printRun?: number | null;
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
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  /** CF-GRADE-QUALIFIER (Drew, 2026-07-23, issue #713 phase 2). PSA
   *  qualifier flag on the sale — "OC" (off-center), "MK" (marks),
   *  "ST" (stain), "PD" (print defect), "MC" (miscut), "OF" (out of
   *  focus). Null when the sale is unqualified. Absent on pre-#713
   *  docs; readers treat absent as null. Populated by parseGradeLabel
   *  at emission sites (persistVendorSalesToPool, confirm, sell). The
   *  FMV pipeline eventually applies a per-qualifier discount when
   *  comparing qualified vs unqualified same-tier rows — that math is
   *  the follow-up PR once calibration data lands. */
  gradeQualifier?: string | null;
  /** CF-AUTO-STYLE (Drew, 2026-07-23, issue #712 option B). Autograph
   *  style attached at the SALE level rather than the identity level.
   *  "on-card" (~15-30% premium), "sticker", or null when the vendor
   *  title didn't hint at style. Absent on pre-#712 docs. Populated
   *  from parseListingIdentity at persistVendorSalesToPool.
   *  Follow-up: FMV pipeline applies per-style multiplier when
   *  comparing on-card vs sticker comps in the same slug pool. */
  autoStyle?: "on-card" | "sticker" | null;

  // The sale itself
  price: number;
  /** CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38, 2026-08-30). How `price`
   *  was derived on a purchase-sourced row: "subtotal" (the item price -- what
   *  the market paid) or "all-in" (item + shipping + tax, the buyer's basis,
   *  used only when the components are unknowable). Persisted so a LATER
   *  upsert on the same doc id can tell an upgrade from a regression; the doc
   *  id is price-independent, so without this the store cannot. Absent on
   *  vendor rows and on rows written before D38. */
  priceBasis?: SalePriceBasis | null;
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

  // CF-ONE-IDENTITY-IN-THE-POOL (D12a, 2026-08-29). The vendor id the source
  // holding carried (CardHedge bubble.io id, Cardsight compound id) when a
  // USER sale is filed under its hiq: slug. Metadata for provenance and for
  // the vendor-id -> slug bridge; it never keys a row.
  vendorCardId?: string | null;

  // CF-COMPOSITE-IDENTITY (Drew, 2026-07-30). 6-axis composite parallel
  // identity per parallel-vocabulary framework. Each axis is queryable
  // independently, enabling neighbor-multiplier lookups, ladder walking
  // for thin-market FMV, faceted search, and impossible-serial fraud
  // flagging. Populated on new writes via parseParallelComposite;
  // backfill populates historic rows.
  //   edition        — SAPPHIRE / MEGA_BOX / FIRST_EDITION / SONIC / etc.
  //   insertSet      — scouts-top-100 / home-run-challenge / etc.
  //   colorFamily    — BLUE / GOLD / REFRACTOR / SPECKLE / etc.
  //   finishModifier — WAVE / SHIMMER / VINYL / etc.
  //   isRefractor    — bool (separate from color)
  //   compositeConfidence — self-assessed parser confidence
  // isAuto/autoStyle/serialRun already exist above as separate fields.
  composite?: {
    edition: string | null;
    insertSet: string | null;
    colorFamily: string | null;
    finishModifier: string | null;
    isRefractor: boolean;
    confidence: "high" | "medium" | "low";
  } | null;

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
  /** CF-ONE-IMPORT-ONE-IDENTITY (D9). The print run the caller RESOLVED — a
   *  checklist row, a pinned holding. Preferred over the title regex, so a
   *  re-emit carrying a rebuilt title can never drop the :num-N segment and
   *  file the sale under an un-numbered twin. */
  printRun?: number | null;
  /** Sport tag ("baseball" / "football" / "basketball" / "hockey" /
   *  "soccer" / null). When absent, inferSportFromContext() derives from
   *  setName + title. */
  sport?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  price: number;
  /** D38: the derivation of `price`. Emit paths that key a purchase through
   *  purchaseSaleIdentity pass its `priceBasis` straight through. Omitted by
   *  every vendor caller, which changes nothing for them. */
  priceBasis?: SalePriceBasis | null;
  /**
   * CF-ONE-IDENTITY-ONE-DERIVATION (D38, Drew 2026-08-30). The identity the
   * CALLER already resolved -- a holding's pinned `hobbyiqCardId`, ruled onto
   * a checklist row by the matcher or by Drew's own confirm.
   *
   * When present AND the id resolves to a checklist-backed catalog row, it is
   * the identity: the store does not re-derive one from setName/cardNumber/
   * parallel and does not refuse the sale for failing to match its own
   * recomputation. Anything else -- absent, unverifiable, a derived-source row,
   * a read failure -- falls through to exactly today's behaviour.
   *
   * Set ONLY by callers that hold a ruled identity. A vendor feed's cardId is
   * not one, which is why this is a separate field and not `input.cardId`.
   */
  pinnedHobbyIqCardId?: string | null;
  soldAt: string;
  source: SoldCompSource;
  sourceExternalId?: string | null;
  contributorUserId?: string | null;
  title?: string | null;
  imageUrl?: string | null;
  /** Original vendor listing URL (eBay item, CH card page, etc.).
   *  Kept on the record so the admin triage UI can link back to the
   *  original context when a comp lands in verify_queue. Not written
   *  to sold_comps; only threaded through so the enqueue can carry
   *  the pointer. */
  url?: string | null;
  /** CF-ONE-IDENTITY-IN-THE-POOL (D12a). The source holding's vendor cardId,
   *  carried as metadata when a user sale is filed under its hiq: slug. */
  vendorCardId?: string | null;
  sellerHandle?: string | null;
  verifiedByUser?: boolean;
  confidence?: number;
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

// CF-CARDSIGHT-STAGING-CONTAINER (Drew, 2026-08-01). Feature-flagged
// route: when CARDSIGHT_TO_STAGING_ENABLED=true, Cardsight-source
// rows go to a separate `cardsight_staging` container instead of
// sold_comps. Keeps sold_comps as confirmed-sold only. Off by default
// until the historical Cardsight rows have been migrated.
let _cardsightStaging: Container | null = null;
async function getCardsightStagingContainer(): Promise<Container | null> {
  if (_cardsightStaging) return _cardsightStaging;
  try {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return null;
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({
      id: process.env.COSMOS_DATABASE ?? "hobbyiq",
    });
    const { container } = await database.containers.createIfNotExists({
      id: process.env.COSMOS_CARDSIGHT_STAGING_CONTAINER ?? "cardsight_staging",
      partitionKey: { paths: ["/cardId"] },
      defaultTtl: -1,
    });
    _cardsightStaging = container;
    return _cardsightStaging;
  } catch { return null; }
}

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

// CF-INFERSPORT-VINTAGE-P1 (Drew, 2026-07-26). Vintage era: each flagship
// brand had a distinct year before it extended into another sport, so we
// key the fallback per brand — a bare "Topps" from 1985 or earlier, a
// bare "Fleer" from 1985 or earlier, etc. is overwhelmingly baseball.
// Pre-fix, those rows returned null and downstream sport-filtered analytics
// silently skipped them. Post-fix, we default to baseball when the year is
// within the brand's vintage window AND the text carries no other-sport
// signal (explicit sport substrings are checked first and win).
//
// Ceilings sourced from brand licensing history:
//   - Topps: basketball came back 1981 → cap at 1980
//   - Fleer: basketball inaugural 1986 → cap at 1985
//   - Donruss: basketball inaugural 1988 → cap at 1987
//   - Upper Deck: 1989 inaugural (baseball-only), basketball 1991 → cap at 1990
//
// Year is optional: pre-existing call sites can keep passing (setName, title)
// and get today's behaviour. Call sites that already carry cardYear now pass
// it as the 3rd arg.
const VINTAGE_BASEBALL_BRAND_CEILINGS: ReadonlyArray<{ pattern: RegExp; ceiling: number }> = [
  { pattern: /\btopps\b/,           ceiling: 1980 },
  { pattern: /\bfleer\b/,           ceiling: 1985 },
  { pattern: /\bdonruss\b/,         ceiling: 1987 },
  { pattern: /\bupper\s+deck\b/,    ceiling: 1990 },
];

/**
 * CF-CARDNUMBER-TITLE-FALLBACK (Drew, 2026-08-05).
 * Extract a card number from an eBay-style title as a last-resort
 * when vendor feeds (CardHedge, Cardsight) leave cardNumber blank.
 * Two patterns tried in order:
 *   1. Prefixed:  "#CPA-EHA", "#136", "#BDC28", "No. 100"
 *   2. Bare code: "CPA-EHA" (2-5 letters + dash + alphanumerics)
 *                 or "BDC28" (2-5 letters + 2-5 digits)
 * Matches the same regex the eBay title parser uses. Returns
 * uppercase, or null if no plausible code is present.
 */
export function extractCardNumberFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const raw = title.trim();
  if (!raw) return null;
  const PREFIXED_RE = /(?:#|\bno\.\s*)([a-z]{0,4}-?\d{1,4}[a-z]?-?[a-z0-9]{0,6})/i;
  const CODED_RE = /\b([A-Z]{2,5}(?:\d{2,5}|-[A-Z0-9]{1,10}))\b/i;
  const prefixed = raw.match(PREFIXED_RE);
  if (prefixed) return prefixed[1].toUpperCase();
  const coded = raw.match(CODED_RE);
  if (coded) return coded[1].toUpperCase();
  return null;
}

export function inferSportFromContext(
  setName: string | null | undefined,
  title: string | null | undefined,
  year?: number | null,
): string | null {
  const text = `${setName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  // Explicit sport substring wins — do this FIRST so a "1985 Topps
  // Football" gets football, not the vintage-baseball fallback.
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (text.includes("soccer") || text.includes("mls") || text.includes("premier league")) return "soccer";
  // CF-POKEMON-INFER-SPORT (Drew, 2026-07-26). Pokemon TCG detection.
  // Ingest pipe already writes CH-daily Pokemon rows into ch_daily_sales
  // (58k/week) and a past manual backfill tagged 38k rows in sold_comps
  // with sport="pokemon". Runtime paths (warmPoolFromChDailySales et al.)
  // now auto-tag new pokemon rows without a manual --sport flag.
  // "Pokémon" with é (U+00E9) is captured by lowercasing (é stays é;
  // pattern uses both forms).
  if (text.includes("pokemon") || text.includes("pokémon")) return "pokemon";
  // CF-TCG-VERTICAL-VOCABULARY (Drew, 2026-08-17). The other TCG verticals.
  // Without these the sport stays null, slugGuard refuses on sport-uncanonical,
  // and the row never reaches its set table however good that table is — the
  // two fixes only work together. Measured: 57,760 Yu-Gi-Oh, 16,837 Magic and
  // 9,619 One Piece sales sat unkeyed with NO sport at all.
  //
  // Each maps to a tag already in CANONICAL_SPORTS, so nothing new enters the
  // slug namespace.
  if (/\byu-?gi-?oh/.test(text)) return "yugioh";
  if (/\bmagic:?\s*the\s+gathering\b/.test(text) || /\bmtg\b/.test(text)) return "tcg-other";
  if (/\bone piece\b/.test(text)) return "anime-tcg";
  // CF-ALL-CANONICAL-VERTICALS (Drew, 2026-08-17: "find it and find it ALL").
  //
  // CANONICAL_SPORTS already contained golf, racing, wrestling, mma, boxing,
  // tennis, multi-sport and non-sport — the namespace was never the problem.
  // Nothing DETECTED them, so the sport stayed null, slugGuard refused on
  // sport-uncanonical, and the row never got a slug however good its setKey
  // vocabulary was.
  //
  // Measured over the 45,288 rows still unkeyed after the TCG verticals
  // shipped, these tokens classify 87.5%:
  //
  //     non-sport   20,938      mma          1,918
  //     golf         4,615      tennis       1,116
  //     wrestling    4,099      boxing         437
  //     racing       3,511      multi-sport  3,008
  //
  // Most of these products ALREADY have setKey vocabulary — "2020 Topps
  // Chrome F1 Racing" resolves to topps-chrome perfectly well. The sport tag
  // was the only thing missing, which is why this is a large win for a small
  // change.
  //
  // Ordered most-specific first: a league acronym beats a generic word, and
  // non-sport is LAST so "Marvel" cannot outrank a real sport that happens to
  // mention a character.
  if (/\bufc\b|\bmma\b|mixed martial|\bpride fc\b/.test(text)) return "mma";
  if (/\bwwe\b|\bwwf\b|\baew\b|\bwcw\b|\bnwa\b|wrestling/.test(text)) return "wrestling";
  if (/\bf1\b|formula\s*1|\bnascar\b|\bindycar\b|\bmoto\s?gp\b|racing/.test(text)) return "racing";
  if (/\bgolf\b|\bpga\b/.test(text)) return "golf";
  if (/\btennis\b|\batp\b|\bwta\b/.test(text)) return "tennis";
  if (/\bboxing\b|\bboxer\b/.test(text)) return "boxing";
  if (/multi-?sport|olympic|four sport|all[- ]sport|sports illustrated|metal universe champions|goodwin champions/.test(text)) return "multi-sport";
  if (/garbage pail|\bmarvel\b|star wars|spider-?man|superman|batman|dc comics|masterpieces|\bimpel\b|fortnite|playboy|wacky|jurassic/.test(text)) return "non-sport";
  // Product-family heuristics (unambiguous single-sport lines)
  if (/\bbowman\b/.test(text)) return "baseball";      // Bowman = baseball only
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  // CF-INFERSPORT-VINTAGE-P1 vintage-flagship rule. Only fires when we
  // have a year AND the setName matches a vintage-baseball flagship AND
  // the year is at or below that brand's per-brand ceiling. Explicit
  // other-sport substrings are checked above and short-circuit, so a
  // "1985 Topps Football" gets football, not baseball here.
  if (typeof year === "number" && year > 0) {
    for (const { pattern, ceiling } of VINTAGE_BASEBALL_BRAND_CEILINGS) {
      if (year <= ceiling && pattern.test(text)) return "baseball";
    }
  }
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
export type ContentHashInput = {
  cardId: string;
  parallel?: string | null;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  price: number;
  soldAt: string;
};

/** The parallel as the hash reads it. Whitespace and case are noise; the
 *  WORDS are not. */
function normalizeParallelForHash(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * THE LEGACY normalization: it stripped a trailing " Refractor".
 *
 * D31 RETRACTED the rule that made that safe. There is no colour-equals-
 * refractor vocabulary rule any more -- the catalog resolver decides per card,
 * and Topps Finest #197 lists `Uncommon` AND `Uncommon Refractor` as two real
 * cards. So the strip makes a $40 `Blue` sale and a $900 `Blue Refractor` sale
 * hash IDENTICALLY inside one cardId partition, and the pre-write dedup below
 * treats "same contentHash in this partition" as "the same sale". The loser of
 * that comparison is not written -- a genuine future sale swallowed at ingest,
 * and the FMV of both cards wrong.
 *
 * Kept ONLY to recognise rows already stored under it. Never used for a new
 * hash. See `contentHashesForLookup`.
 */
function legacyNormalizeParallelForHash(s: string | null | undefined): string {
  return normalizeParallelForHash(s).replace(/ refractors?$/, "");
}

function hashParts(input: ContentHashInput, parallel: string): string {
  const parts = [
    input.cardId.trim(),
    parallel,
    input.isAuto === true ? "1" : "0",
    (input.gradeCompany ?? "raw").toUpperCase(),
    String(input.gradeValue ?? 0),
    String(Math.round(input.price * 100)),         // priceCents
    (input.soldAt ?? "").slice(0, 10),             // soldDay only — ignore hour/minute noise
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** CF-CONTENT-HASH (Drew, 2026-07-20). Canonical hash of the SALE
 *  content — cross-source dedup key. Same underlying sale from any
 *  source (eBay user + CH + eBay browse) produces the same hash.
 *
 *  D31: the parallel is hashed WHOLE. A colour and its colour-refractor
 *  sibling are two cards unless the checklist says otherwise, and the hash is
 *  not the place that decides. */
export function computeContentHash(input: ContentHashInput): string {
  return hashParts(input, normalizeParallelForHash(input.parallel));
}

/** The legacy hash for the SAME sale, as rows written before the D31 fix
 *  carry it. Identical to the new hash whenever the parallel does not end in
 *  "refractor"/"refractors", which is the overwhelming majority of the pool. */
export function legacyContentHash(input: ContentHashInput): string {
  return hashParts(input, legacyNormalizeParallelForHash(input.parallel));
}

/**
 * EVERY hash a stored row for this sale could be carrying — the new form
 * first, then the legacy form when it differs.
 *
 * TRANSITION SAFETY. Stored rows carry hashes computed WITH the strip. If the
 * pre-write dedup looked up only the new hash, then on the day this ships
 * every re-emit of an already-stored `Blue Refractor` sale would miss its own
 * stored row and be written again — the fix would RESURRECT the duplicates it
 * exists to prevent. So the lookup asks for both forms while the pool is
 * mixed; the WRITE only ever stores the new one, so the legacy form drains as
 * rows are rewritten and this can be dropped once the pool is re-hashed.
 *
 * The two forms differ ONLY for a parallel ending in "refractor"/"refractors",
 * so for almost every sale this is the same single-hash lookup it was before.
 */
export function contentHashesForLookup(input: ContentHashInput): string[] {
  const fresh = computeContentHash(input);
  const legacy = legacyContentHash(input);
  return legacy === fresh ? [fresh] : [fresh, legacy];
}

/** Score a doc for pickCanonical — higher = keep. Mirror the scoring
 *  in scripts/apply-sold-comps-dedup.cjs so pre-write dedup + nightly
 *  cleanup agree on which row wins. */
export function scoreForCanonical(row: {
  verifiedByUser?: boolean;
  sourceExternalId?: string | null;
  parallel?: string | null;
  observedAt?: string;
  flaggedWrong?: boolean;
}): number {
  // CF-A-FLAGGED-ROW-LOSES-TO-EVERY-LIVE-ROW (2026-09-01). Defense in
  // depth for the ingest dedup gap fixed at the query above: a row we have
  // ruled WRONG must never out-rank a live one, whatever its id shape,
  // parallel length or recency say. Measured before this: a flagged row on
  // a real eBay id scored 95.855424 against a genuine incoming
  // `ch-daily::` sale at 85.882208, and the real sale was dropped.
  //
  // The penalty is a floor-clearing constant, not a tweak to the weights:
  // the live scale is bounded well under 1000 (verifiedByUser 100 + prefix
  // 60 + parallel length + a sub-1 recency term), so subtracting 1000
  // puts EVERY flagged row below EVERY live row while preserving the exact
  // relative order WITHIN each group. Ranking among flagged rows still
  // matters -- when a flagged doc dedups against its flagged twins (the
  // deliberate asymmetry at the dedup query), the richest flagged row must
  // still win.
  const flaggedPenalty = row.flaggedWrong === true ? -1000 : 0;
  const prefix = row.sourceExternalId ?? "";
  // CF-A-REAL-ID-OUTRANKS-A-SYNTHETIC-ONE (2026-08-29, checklist D7b). A row
  // keyed by the eBay item / order id IS the transaction; a "holding::" key is
  // our own stand-in for it. The old scoring (holding:: +50, real id 0) let a
  // re-emit under the stand-in key DELETE the row that carried the real id.
  // Mirrored in scripts/apply-sold-comps-dedup.cjs.
  const prefixScore = prefix.startsWith("holding::") ? 25
    : prefix.startsWith("ch-daily::") ? 50
    : prefix ? 60
    : 0;
  return (
    flaggedPenalty +
    (row.verifiedByUser === true ? 100 : 0) +
    prefixScore +
    (row.parallel ? String(row.parallel).length : 0) +
    (row.observedAt ? new Date(row.observedAt).getTime() / 1e11 : 0)
  );
}

/**
 * CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38, Drew 2026-08-30).
 *
 * THE FLIP. A purchase's pool row is keyed by `makeId(source, externalId, ...)`
 * -- the eBay order line item id. Nothing in that id depends on the price, so
 * every re-emit of the same transaction upserts the SAME document, and
 * `items.upsert` takes whatever price the latest writer computed. Three
 * writers reach it (import, ReviewQueue confirm, rematch), and two of them
 * call `sourcePurchaseFor(doc, holding)` first. When that returns null -- the
 * holding lost its `sourcePurchaseId`, or the doc's `purchases` array was
 * trimmed -- `purchaseSaleIdentity` falls back to `holding.purchasePrice`,
 * which is ALL-IN. Drew's Gold Max Williams: 295.95 (the market's price for
 * the card) silently becomes 301.43 (his shipping and tax), on a row that
 * still looks perfectly well-formed.
 *
 * The content-hash dedup does not catch it: price is INSIDE the hash, so a
 * flipped price is a different hash, matches no existing row, and goes
 * straight to the price-blind upsert. `scoreForCanonical` does not catch it
 * either -- it never reads price.
 *
 * So the store refuses this one direction. An incoming all-in price does not
 * overwrite a stored subtotal price; everything else upserts as before:
 *
 *   - subtotal over all-in         UPGRADE, take it (the fix landing later)
 *   - subtotal over subtotal       a real correction, take it
 *   - all-in over all-in           no better answer exists, take it
 *   - anything over an unknown     pre-D38 rows carry no basis, take it
 *   - all-in over subtotal         REGRESSION, keep what is stored
 *
 * Deliberately NOT solved by removing the fallback: an all-in price is the
 * only price a manually-added holding ever has, and dropping it would withhold
 * real sales from the pool. The basis is recorded instead, so the price is
 * usable AND cannot masquerade as a better one.
 */
export function keepsExistingPrice(
  existing: { price?: unknown; priceBasis?: unknown } | null | undefined,
  incoming: { price?: unknown; priceBasis?: unknown },
): boolean {
  if (!existing) return false;
  if (String(incoming.priceBasis ?? "") !== "all-in") return false;
  if (String(existing.priceBasis ?? "") !== "subtotal") return false;
  const stored = Number(existing.price);
  if (!Number.isFinite(stored) || stored <= 0) return false;
  return Number(incoming.price) !== stored;
}

/** CF-ONE-SALE-ONE-ROW (2026-08-29, D7c). When a rematch moves a holding to a
 *  different checklist slug, the pool row written under the old slug is
 *  superseded: the partition key (cardId) cannot be patched, so the old row is
 *  deleted before the sale is re-written under the new slug. Never throws. */
export async function deleteSoldCompById(id: string, cardId: string): Promise<boolean> {
  const c = await getContainer();
  if (!c) return false;
  try { await c.item(id, cardId).delete(); return true; }
  catch (err) { if ((err as { code?: number })?.code === 404) return false; console.warn(JSON.stringify({ event: "sold_comp_supersede_delete_failed", id, cardId, error: (err as Error)?.message ?? String(err) })); return false; }
}

/** The row pickCanonical would keep: highest scoreForCanonical. */
function bestOf<T extends { id?: string; verifiedByUser?: boolean; sourceExternalId?: string | null; parallel?: string | null; observedAt?: string }>(rows: T[]): T | undefined {
  return rows.slice().sort((a, b) => scoreForCanonical(b) - scoreForCanonical(a))[0];
}

/**
 * Idempotent upsert of a sold comp. Caller is responsible for the
 * trust decision — this store never fabricates the cardId.
 * Silent no-op on missing cardId, non-positive price, or Cosmos absence.
 */
/**
 * CF-RECORDCOMP-REPORTS-SKIP (Drew, 2026-08-13). recordSoldComp returned void
 * and skipped silently, so callers could not tell a write from a drop.
 *
 * That silence broke the loop-back. promotionJob awaited this and then
 * unconditionally set status="promoted" — so a staging row whose card had no
 * checklist yet was marked done forever and never retried, and the audit record
 * claimed a promotion that never happened. Once the checklist landed, nothing
 * went back for it.
 *
 * `written: false` with a reason lets the caller keep the row retryable.
 * Additive: the 46 existing callers ignore the return and are unaffected.
 */
/** CF-SALES-DO-NOT-MINT-CARDS (#1353) / CF-A-USER-SALE-IS-ALWAYS-RECONCILED
 *  (D7d). The only sources that may seed a catalog row, and the sources whose
 *  sales are reconciled against the catalog regardless of env. User-owned
 *  cards; never a vendor feed.
 *
 *  D26 deliberately leaves `ebay-account` OUT. The eBay account sync reaches
 *  this function with an identity the matcher already resolved at >= 0.9, and
 *  membership here would hand it `ensureCatalogRow` (line ~1461) -- which is
 *  exactly "a sale mints a card", the one thing Drew ruled out for this flow.
 *  An account sale that resolves to no catalog row PARKS for the user's
 *  confirm; it never creates the card it could not find. Asserted in
 *  ebayAccountSaleIdentity.test.ts. */
const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);

export interface RecordSoldCompResult {
  written: boolean;
  /** CF-THE-SALE-HAS-AN-ID (2026-08-29, checklist D7a). The pool row's id
   *  when the sale is in the pool -- the row just written, or the row that
   *  already held this sale (deduped: true). A holding can now link to its
   *  sale, and a caller can tell "matched an existing sale" from "wrote". */
  id?: string | null;
  deduped?: boolean;
  hobbyiqCardId?: string | null;
  /** Present when written is false. "catalog-unmatched" is the retryable one —
   *  the sale is real, we just have no checklist for its card yet. */
  reason?: "catalog-unmatched" | "invalid-input" | "error";
}

export interface DerivedSlug {
  /** The slug, or null when the guard refused. NEVER a guessed value. */
  slug: string | null;
  guard: SlugGuardResult;
  sportForSlug: string | null;
  cardNumberFinal: string | null;
  printRunFinal: number | null;
  /** setKey the guard actually judged — what segment 3 of the slug carries. */
  resolvedSetKey: string;
  /** The player the slug was allowed to use, after the title/vendor
   *  reconciliation. Null when they named two different people. */
  playerForSlug?: string | null;
  /** The vendor's attributed player and the title's named a different person.
   *  The row's identity is UNDERIVABLE and `slug` is null. */
  playerIrreconcilable?: boolean;
}

/**
 * CF-ONE-SLUG-DERIVATION (Drew, 2026-08-17). THE derivation of a
 * hobbyiqCardId from a comp's attributes: title fallbacks, the sport-aware
 * setKey resolution, the guard, and the computation.
 *
 * Exported because the repair pass for already-unkeyed rows must derive slugs
 * the SAME way ingest does. A backfill that re-implements this — even
 * carefully — is a second implementation that drifts, and the drift is
 * invisible: it writes well-formed slugs that simply disagree with the ones
 * ingest would have written. That is exactly how the guard came to reject
 * 615,140 rows the computation would have keyed (CF-ONE-SETKEY-RESOLVER), and
 * how the price-outlier diverter came to disagree with dataCleanJob
 * (CF-ONE-OUTLIER-RULE). One rule, one implementation.
 *
 * CF-CARDNUMBER-TITLE-FALLBACK: vendor feeds sometimes omit cardNumber for
 * modern autos even when the title carries the code ("CPA-EHA"); without it
 * the slug gets a malformed "::" segment and every lookup misses.
 *
 * CF-SLUG-REFUSE-FALLBACKS: when the inputs don't hold up we return NO slug
 * rather than a confident wrong one. computeHobbyIqCardId is total and will
 * happily return `hiq:hockey:197:bowman:8:base:no-auto` for a 1978 Kellogg's
 * baseball card — syntactically perfect, completely meaningless, and
 * indistinguishable from a real slug downstream. An unkeyed row is visibly
 * incomplete and can be re-derived later; a wrong slug silently corrupts a
 * comp pool and looks healthy.
 */
/** The title's own reading of who is on the card. Lazily required so this
 *  module keeps its import graph — the query parser reaches into compiq/.
 *  A parse failure returns null, which makes the reconciliation a no-op and
 *  leaves the vendor's player exactly as it was. */
function playerFromTitleForSlug(title: string | null | undefined): string | null {
  const t = String(title ?? "").trim();
  if (!t) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parseCardQuery } = require("../compiq/cardQueryParser.js");
    const p = parseCardQuery(t)?.playerName;
    return typeof p === "string" && p.trim().length > 0 ? p.trim() : null;
  } catch {
    return null;
  }
}

export function deriveHobbyIqSlug(input: Pick<RecordSoldCompInput,
  "sport" | "setName" | "title" | "cardYear" | "cardNumber" | "parallel" | "isAuto"
  // CF-PLAYER-IS-THE-NUMBER: genuinely unnumbered cards (T206, Magic Alpha,
  // Signature Series) are identified by their player, so the player has to
  // reach BOTH the guard and the computation — a guard that judged one
  // identity while the computation emitted another is the parity bug this
  // file was already fixed for once.
  | "playerName" | "printRun"> & {
    /** CF-UNPARSED-IS-NOT-UNNUMBERED: a checklist ingest asserting this card
     *  genuinely carries no number, so a blank cardNumber is an answer. */
    unnumberedByChecklist?: boolean;
    /** CF-THE-CHECKLIST-SPELLS-THE-NUMBER: the width this Pokemon set's
     *  checklist spells positions in, from `pokemonChecklistNumberWidth`.
     *  This function stays SYNCHRONOUS -- the width is a per-SET fact its
     *  async callers look up once and hand down, never a per-row read from
     *  inside a derivation. Absent means "no checklist to ask", and the card
     *  number is then left exactly as stated. */
    pokemonChecklistNumberWidth?: number | null;
  }): DerivedSlug {
  const sportForSlug = input.sport ?? inferSportFromContext(input.setName, input.title, input.cardYear);
  const cardNumberFinal = (input.cardNumber && input.cardNumber.trim())
    ? input.cardNumber.trim()
    : extractCardNumberFromTitle(input.title);
  // A print run the caller resolved outranks one sniffed from the title: the
  // title may be a rebuilt one that no longer states it.
  const printRunFinal = typeof input.printRun === "number" && Number.isInteger(input.printRun) && input.printRun > 0
    ? input.printRun
    : extractPrintRunFromTitle(input.title);

  // Resolve the setKey the way computeHobbyIqCardId will, THEN guard it.
  // sportForSlug is normalized first because the resolver's Pokemon branch is
  // gated on the canonical tag.
  const guardSport = normalizeSportStrict(sportForSlug);
  const resolvedSetKey = resolveSetKeyForSlug(
    guardSport ?? "",
    input.setName ?? "",
    typeof input.cardYear === "number" ? input.cardYear : 0,
  );
  // CF-THE-TITLE-OUTRANKS-THE-VENDOR-PLAYER (Drew, 2026-09-04). The player is
  // load-bearing on exactly one path -- the unnumbered card, where it BECOMES
  // the cardNumber segment -- so a wrong player there is a wrong card. The
  // stored playerName is a vendor's attribution; the title is the seller's own
  // words. When they name two different people the row has no player we can
  // stand behind, and the guard below refuses on that basis rather than
  // minting `player-<the-wrong-one>`.
  const playerDecision = playerTheTitleAllows(
    input.playerName ?? null,
    playerFromTitleForSlug(input.title),
  );
  const playerForSlug = playerDecision.player;

  const guard = guardSlugInputs({
    sport: sportForSlug,
    year: input.cardYear,
    normalizedSetKey: resolvedSetKey,
    cardNumber: cardNumberFinal ?? "",
    playerName: playerForSlug,
    unnumberedByChecklist: input.unnumberedByChecklist === true,
  });

  // CF-UNPARSED-IS-NOT-UNNUMBERED. computeHobbyIqCardId now THROWS on an
  // unparsed cardNumber rather than reaching for the player pseudo-number, and
  // on an unnumbered card with no player it stands behind. The guard should
  // have caught both already — this catch is the belt to that braces, and it
  // returns the same "no slug" the guard's own refusal returns rather than
  // taking down an ingest batch.
  let slug: string | null = null;
  if (guard.ok) {
    try {
      slug = computeHobbyIqCardId({
        // guard.sport is the canonicalized form ("ice hockey" → "hockey"),
        // so the slug namespace stays in the controlled vocabulary.
        sport: guard.sport as string,
        year: input.cardYear as number,
        setKey: input.setName ?? "",
        cardNumber: cardNumberFinal ?? "",
        parallel: input.parallel ?? "Base",
        isAuto: input.isAuto ?? false,
        printRun: printRunFinal,
        playerName: playerForSlug,
        unnumberedByChecklist: input.unnumberedByChecklist === true,
        pokemonChecklistNumberWidth: input.pokemonChecklistNumberWidth ?? null,
      });
    } catch {
      slug = null;
    }
  }

  return {
    slug, guard, sportForSlug, cardNumberFinal, printRunFinal, resolvedSetKey,
    playerForSlug, playerIrreconcilable: playerDecision.outcome === "irreconcilable",
  };
}

export async function recordSoldComp(input: RecordSoldCompInput): Promise<RecordSoldCompResult> {
  // CF-PRE-INGEST-CLEAN (Drew, 2026-08-01). ALWAYS run vendor-specific
  // pre-ingest cleaning as the FIRST step. This is Pass 1 of the
  // two-pass ingest cleaning. Any of the 46 callers of this function
  // automatically get vendor-appropriate validation + title-parse
  // refinement without touching call-site code.
  const { preIngestClean } = await import("./preIngestClean.service.js");
  const preClean = preIngestClean(input);
  if (preClean.rejected) {
    // Log rejection sparingly (sampled) so downstream can trend
    if (Math.random() < 0.01) {
      console.warn(JSON.stringify({
        event: "recordSoldComp_pre_ingest_rejected",
        source: input.source,
        reason: preClean.rejected.reason,
        category: preClean.rejected.category,
        cardId: input.cardId,
        sampled: true,
      }));
    }
    return { written: false, reason: "invalid-input" };
  }
  if (preClean.input) input = preClean.input;

  if (!input.cardId || !input.cardId.trim()) return { written: false, reason: "invalid-input" };
  if (!input.playerName || !input.playerName.trim()) return { written: false, reason: "invalid-input" };
  if (typeof input.price !== "number" || input.price <= 0) return { written: false, reason: "invalid-input" };
  if (!input.soldAt) return { written: false, reason: "invalid-input" };

  // CF-GRADE-VALUE-NULL-REJECT (Drew, 2026-08-06). Reject rows where
  // gradeCompany is set but gradeValue is null/undefined. These
  // "PSA null" rows produced 1,235 ghost grade nodes in card_catalog
  // that rendered as duplicate "PSA 10 with no data" tiles in the UI.
  // If we don't know the numeric grade, treat as raw — safer than
  // creating a phantom grade tier.
  // CF-GRADE-VALUE-STRING (Drew, 2026-08-15: "fix those"). gradeValue is
  // typed number|null, but callers reach this through untyped vendor payloads
  // and 68,410 rows landed with a STRING — 68,284 of them from cardsight.
  //
  // Cosmos does not coerce, so `WHERE c.gradeValue = 10` never matches "10".
  // 24,444 PSA 10 sales were therefore invisible to the PSA 10 comp pool
  // while 514,015 numeric ones were visible: a silent, uneven hole in the
  // tier rather than an obvious failure.
  //
  // Coerced HERE because this is the single write boundary every source
  // funnels through, so one guard covers cardsight, tca-ebay and anything
  // added later.
  //
  // "AU" / "A" / "Authentic" are not grades — they are the authentication
  // designation, and they route to the Authentic bucket (gradeValue 0) so a
  // slab that was never numerically graded is not silently discarded.
  if (typeof (input.gradeValue as unknown) === "string") {
    const rawGrade = String(input.gradeValue).trim();
    if (/^(?:au|a|authentic)$/i.test(rawGrade)) {
      input = { ...input, gradeValue: 0, isAuthentic: true } as typeof input;
    } else {
      const asNumber = Number(rawGrade);
      input = {
        ...input,
        gradeValue: Number.isFinite(asNumber) && asNumber > 0 && asNumber <= 10 ? asNumber : null,
      };
    }
  }

  if (input.gradeCompany && (input.gradeValue === null || input.gradeValue === undefined)) {
    input = { ...input, gradeCompany: null, gradeValue: null };
  }

  // CF-GRADE-FROM-TITLE-SANITY (Drew, 2026-08-06). If the row is being
  // ingested as raw (gradeCompany null) but the title clearly says
  // "PSA 10" / "BGS 9.5" / "SGC 10" etc., the row is a mislabeled slab
  // sale — CardHedge sometimes emits graded sales with gradeCompany
  // unset. Found 5 sales at $20-192K in the raw Ohtani Bowman #1 pool
  // (raw median $2.4K) that were slabbed grades bleeding the raw
  // FMV up 10-80x. Extract the grade from the title so the row lands
  // in the correct pool.
  if (!input.gradeCompany && input.title) {
    const t = String(input.title).toUpperCase();
    // Match "PSA 10", "BGS 9.5", "SGC 10", "CGC 9.5", etc.
    const m = t.match(/\b(PSA|BGS|SGC|CGC|CSG|HGA)\s+(10(?:\.0)?|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/);
    if (m) {
      const company = m[1];
      const value = Number(m[2]);
      if (Number.isFinite(value) && value > 0 && value <= 10) {
        input = { ...input, gradeCompany: company, gradeValue: value };
        console.log(JSON.stringify({
          event: "grade_extracted_from_title",
          source: "soldCompsStore.recordSoldComp",
          cardId: input.cardId,
          extractedCompany: company,
          extractedValue: value,
          titleSnippet: String(input.title).slice(0, 100),
        }));
      }
    }
  }

  // CF-CARDSIGHT-STAGING-ROUTING (Drew, 2026-08-01). When feature flag
  // is on, route Cardsight-source writes to cardsight_staging container.
  // Sold_comps stays confirmed-sold only. Off by default.
  const stagingRouteEnabled = process.env.CARDSIGHT_TO_STAGING_ENABLED === "true";
  const shouldRouteToStaging = stagingRouteEnabled && input.source === "cardsight";
  const c = shouldRouteToStaging ? await getCardsightStagingContainer() : await getContainer();
  if (!c) return { written: false, reason: "error" };

  const contentHashInput = {
    cardId: input.cardId,
    parallel: input.parallel,
    isAuto: input.isAuto,
    gradeCompany: input.gradeCompany,
    gradeValue: input.gradeValue,
    isAuthentic: input.isAuthentic ?? null,
    price: input.price,
    soldAt: input.soldAt,
  };
  const contentHash = computeContentHash(contentHashInput);
  // D31 transition: a row stored before the " Refractor" strip was removed
  // carries the legacy hash, so the dedup LOOKUP asks for both forms. The
  // WRITE stores only `contentHash` (the new form).
  const contentHashLookup = contentHashesForLookup(contentHashInput);

  // CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706 Phase 1b). Compute
  // the canonical hobbyiqCardId from the input attributes. Populated on
  // every new write so downstream consumers can migrate to it as the
  // primary identifier over time. Print run is extracted from the title
  // when a "/N" fragment is present (e.g. "Gold Refractor /50 Braves");
  // otherwise omitted from the slug.
  //
  // CF-CARDNUMBER-TITLE-FALLBACK (Drew, 2026-08-05). Vendor feeds
  // (CardHedge, Cardsight) sometimes don't populate cardNumber for
  // modern Bowman Chrome autos even when the title clearly contains
  // the code (e.g. "CPA-EHA"). Without cardNumber the slug ends up
  // malformed ("::" segment) and every downstream lookup misses. If
  // input.cardNumber is empty, sniff the title for a known auto-code
  // pattern and use it. Safe fallback: the same code appears in
  // BCCP checklists, so the recovered slug lines up cleanly.
  // CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04). A Pokemon sale
  // states POS/TOTAL and the checklist stores the position alone, in its own
  // spelling. The width is a per-SET fact, so it is read here (async, cached
  // per set for the process) and handed to the synchronous derivation rather
  // than looked up per row. A non-pokemon row never issues the query, and a
  // set with no checklist yields null -- the number is then left as stated and
  // the guard reports it, because padding on a guess mints an identity no
  // checklist published.
  let pokemonWidth: number | null = null;
  {
    const preSport = input.sport ?? inferSportFromContext(input.setName, input.title, input.cardYear);
    if (String(preSport ?? "").toLowerCase() === "pokemon") {
      const preSetKey = resolveSetKeyForSlug(
        "pokemon", input.setName ?? "",
        typeof input.cardYear === "number" ? input.cardYear : 0,
      );
      if (preSetKey && preSetKey !== "unknown") {
        const { pokemonChecklistNumberWidth } = await import("../catalog/pokemonCardNumber.js");
        pokemonWidth = await pokemonChecklistNumberWidth(input.cardYear ?? null, preSetKey);
      }
    }
  }
  const derived = deriveHobbyIqSlug({ ...input, pokemonChecklistNumberWidth: pokemonWidth });
  const { sportForSlug, cardNumberFinal, printRunFinal, guard } = derived;
  if (!guard.ok) {
    // Sampled — this fires on a meaningful slice of vendor rows and must
    // not drown the log. The counts are what tell us which defect leads.
    if (Math.random() < 0.01) {
      console.warn(JSON.stringify({
        event: "slug_refused",
        source: "soldCompsStore.recordSoldComp",
        reasons: guard.reasons,
        compSource: input.source,
        sport: sportForSlug,
        cardYear: input.cardYear,
        setName: input.setName,
        cardNumber: cardNumberFinal,
        titleSnippet: String(input.title ?? "").slice(0, 100),
        sampled: true,
      }));
    }
  }
  let hobbyiqCardId = derived.slug;

  // ── CF-ONE-IDENTITY-ONE-DERIVATION (D38, Drew 2026-08-30) ─────────────────
  //
  // THE cpa-jg SKIP. During the D37 backfill APPLY, an emit carrying the
  // holding's PINNED identity was REFUSED by this function -- because this
  // function threw that identity away and recomputed one from the holding's
  // fields, then rejected the sale for not matching what it had just computed:
  //
  //     ruled holding    hiq:baseball:2026:bowman:cpa-jg:...:num-499
  //     computedSlug     hiq:baseball:2026:bowman-chrome:cpa-jg:...
  //     outcome          recordcomp_catalog_unmatched_skip -- the sale dropped
  //
  // The recomputation is not wrong in general; it is the ONLY derivation a
  // vendor row has. But when the caller already holds an identity that a
  // CHECKLIST ruled on, re-deriving from free text ("Bowman Chrome" in a
  // setName) and then refusing the sale on the disagreement is the store
  // overruling the checklist with a string parse. One identity, one
  // derivation: the ruled one wins (CF-USE-NORMALIZED-FOR-LOOKUPS class).
  //
  // The trust is NOT taken on the caller's word. The pin must resolve, by
  // READ, to a checklist-backed catalog row -- through the twin rule, so a pin
  // on `<stem>` verifies against its `<stem>:num-499` row. A derived-source
  // row (`sold-comps-stub`, `ingest-auto-seed`) does not qualify: that would
  // be the catalog confirming a sale that seeded it. Anything short of a
  // positive confirmation falls through to the recompute + reconcile below,
  // unchanged.
  let pinnedIsAuthoritative = false;
  const pinnedCandidate = String(input.pinnedHobbyIqCardId ?? "").trim();
  if (pinnedCandidate.startsWith("hiq:")) {
    try {
      const { checklistBackedCatalogRow } = await import("../catalog/catalogIdentityResolver.js");
      const backed = await checklistBackedCatalogRow(pinnedCandidate, { printRun: printRunFinal });
      if (backed) {
        pinnedIsAuthoritative = true;
        if (backed.id !== hobbyiqCardId) {
          console.log(JSON.stringify({
            event: "recordcomp_pinned_identity_honored",
            source: "soldCompsStore.recordSoldComp",
            vendorSource: input.source,
            pinnedSlug: pinnedCandidate,
            catalogRow: backed.id,
            catalogSource: backed.source,
            computedSlug: hobbyiqCardId,
            detail: "the caller's checklist-ruled identity supersedes the recomputed slug",
          }));
        }
        hobbyiqCardId = backed.id;
      } else {
        console.log(JSON.stringify({
          event: "recordcomp_pinned_identity_unverified",
          source: "soldCompsStore.recordSoldComp",
          vendorSource: input.source,
          pinnedSlug: pinnedCandidate,
          detail: "pin did not resolve to a checklist-backed catalog row; deriving as usual",
        }));
      }
    } catch (err) {
      // Fail closed onto today's behaviour, never onto a trusted pin.
      console.warn(JSON.stringify({
        event: "recordcomp_pinned_identity_check_failed",
        source: "soldCompsStore.recordSoldComp",
        pinnedSlug: pinnedCandidate,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }

  // CF-CATALOG-RESOLVE-IN-RECORDCOMP (Drew, 2026-08-08). Route through the
  // catalog matcher so the sale lands under the CATALOG's canonical slug —
  // not a computed slug that may drift from user-typed setName. For user-
  // flavored sources (ebay-user-purchase, ebay-user-sale, manual-user-entry),
  // canonicalize is allowed to SEED the catalog when no match — the user
  // owns the physical card, that's real coverage. Vendor sources still gate
  // on match. See Drew's 2026-08-08 directive: "when we let them ingest
  // from ebay, that is REAL comp data" + "every search and add goes
  // THROUGH the catalog".
  //
  // Only fires when CATALOG_MATCH_ONLY_ENABLED=true — otherwise the pre-
  // existing behavior stays (compute slug, write directly). Tests default
  // OFF so mock containers don't need to also mock card_catalog.
  // CF-A-USER-SALE-IS-ALWAYS-RECONCILED (2026-08-29, checklist D7d). The
  // import resolves the holding through the catalog unconditionally; the
  // sale it writes must be resolved the same way, or one transaction carries
  // two identities depending on an env var with no default in the repo.
  // Vendor feeds keep the flag; user-owned sales reconcile regardless.
  //
  // D38: an authoritative pin has ALREADY been reconciled -- against the
  // catalog, by read, to a checklist-backed row. Re-running the matcher over
  // the free-text fields here could only rebind it onto something the
  // checklist did not rule, or refuse it as unmatched; both are the cpa-jg
  // bug. The pin is the reconciliation, so this whole block is skipped.
  const reconcile = process.env.CATALOG_MATCH_ONLY_ENABLED === "true" || USER_SEED_SOURCES.has(String(input.source));
  if (!pinnedIsAuthoritative && reconcile && hobbyiqCardId && input.cardYear && sportForSlug) {
    try {
      const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
      const userSourceMap: Record<string, "user-verified" | "ebay-user-purchase" | "ebay-user-sale" | "manual-user-entry" | "cardhedge" | "cardsight" | "tca" | "ebay-title"> = {
        "user-verified": "user-verified",
        "ebay-user-purchase": "ebay-user-purchase",
        "ebay-user-sale": "ebay-user-sale",
        "manual-user-entry": "manual-user-entry",
        cardhedge: "cardhedge",
        cardsight: "cardsight",
        "tca-ebay": "tca",
      };
      const matcherSource = userSourceMap[input.source] ?? "ebay-title";
      const resolved = await canonicalize({
        sport: sportForSlug,
        year: input.cardYear,
        setName: input.setName ?? "",
        cardNumber: cardNumberFinal ?? "",
        parallel: input.parallel ?? null,
        isAuto: input.isAuto ?? false,
        printRun: printRunFinal,
        player: input.playerName,
        source: matcherSource,
      });
      // CF-CONFIDENCE-MUST-BE-HONOURED (Drew, 2026-08-14). This used to rebind
      // on `resolved.found` alone, ignoring the confidence canonicalize had
      // just computed — so a 0.55 family-fallback guess rewrote identity as
      // authoritatively as a 0.98 exact match. adoptResolvedSlug is now the
      // single place that decision is made, shared with
      // persistVendorSalesToPool so the two cannot drift apart again.
      const { adoptResolvedSlug } = await import("../catalog/catalogMatcher.service.js");
      const adoption = adoptResolvedSlug(hobbyiqCardId, resolved);
      if (adoption.rebound) {
        console.log(JSON.stringify({
          event: "catalog_resolve_rebind_in_recordcomp",
          source: "soldCompsStore.recordSoldComp",
          vendorSource: input.source,
          computedSlug: hobbyiqCardId,
          resolvedSlug: adoption.slug,
          matchedBy: resolved.matchedBy,
          confidence: resolved.confidence,
        }));
        hobbyiqCardId = adoption.slug;
      } else if (adoption.refusedReason) {
        // Kept the computed slug. The sale is still recorded — it just is not
        // moved onto a card we are not confident it is.
        console.log(JSON.stringify({
          event: "catalog_resolve_rebind_refused",
          source: "soldCompsStore.recordSoldComp",
          vendorSource: input.source,
          computedSlug: hobbyiqCardId,
          candidateSlug: resolved.slug,
          reason: adoption.refusedReason,
        }));
      } else if (!resolved.found && reconcile) {
        // Vendor source + no catalog match under match-only rule = skip write.
        // User sources will have hit the seed branch and returned found:true
        // from canonicalize, so they never reach this line.
        //
        // CF-UNMATCHED-SALE-SEEDS-CHECKLIST (Drew, 2026-08-13: "this is where
        // sold data pushes us to get more checklists to create catalogs").
        //
        // A real sale we cannot match is the market telling us a card exists
        // that our catalog does not know. Dropping it silently discarded BOTH
        // the sale and the signal — the set never got a checklist, so the next
        // sale of the same card was dropped too, forever. Record the gap as a
        // work order first; the queue counts demand per release, so the sets
        // the market actually trades rise to the top on their own.
        //
        // Deduped per release by checklistSeedQueue, so a firehose of unmatched
        // sales files one order per set rather than one per sale. Best-effort:
        // a seed failure must never change the skip behaviour.
        try {
          const { requestChecklistSeed } = await import("../catalog/checklistSeedQueue.service.js");
          const { normalizeSetKey } = await import("./hobbyIqCardId.service.js");
          const seedSetName = String(input.setName ?? "").trim();
          if (seedSetName && input.cardYear && sportForSlug) {
            await requestChecklistSeed({
              sport: sportForSlug,
              year: Number(input.cardYear),
              setName: seedSetName,
              setKey: normalizeSetKey(seedSetName),
              reason: "unmatched-sale",
              missingPlayer: String(input.playerName ?? "") || undefined,
              missingCardNumber: String(input.cardNumber ?? "") || undefined,
            });
          }
        } catch { /* never block the skip path on the queue */ }

        console.log(JSON.stringify({
          event: "recordcomp_catalog_unmatched_skip",
          source: "soldCompsStore.recordSoldComp",
          vendorSource: input.source,
          computedSlug: hobbyiqCardId,
        }));
        // Retryable: the sale is real, we simply have no checklist for its card
        // yet. The seed above asks for one; the caller keeps the row so the
        // loop-back can promote it once that checklist lands.
        return { written: false, reason: "catalog-unmatched" };
      }
    } catch (err) {
      // Fail-open: keep computed slug if resolve errors, don't drop the comp.
      console.warn(JSON.stringify({
        event: "recordcomp_catalog_resolve_error",
        source: "soldCompsStore.recordSoldComp",
        vendorSource: input.source,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }

  // CF-PARALLEL-CANONICAL (Drew, 2026-08-06). Canonicalize the display
  // form BEFORE persist so we stop fragmenting the pool across "Blue
  // Refractor" vs "blue-refractor" vs "[Base]" vs "base". Aliases
  // (RayWave/Xfractor/Mojo/Mega) flow through the underlying slug
  // normalizer so display + slug + hobbyiqCardId all agree.
  const canonicalParallel = canonicalizeParallel(input.parallel);

  const doc: SoldCompDoc = {
    id: makeId(input.source, input.sourceExternalId ?? null, input.cardId, input.soldAt),
    cardId: input.cardId.trim(),
    playerName: input.playerName.trim(),
    cardYear: input.cardYear ?? null,
    setName: input.setName ?? null,
    parallel: canonicalParallel?.display ?? null,
    parallelSlug: canonicalParallel?.slug ?? null,
    cardNumber: cardNumberFinal ?? null,
    isAuto: input.isAuto ?? false,
    sport: input.sport ?? inferSportFromContext(input.setName, input.title, input.cardYear),
    gradeCompany: input.gradeCompany ?? null,
    gradeValue: input.gradeValue ?? null,
    price: input.price,
    // CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38), defense in depth. Both
    // guard layers gate on the INCOMING basis, so a purchase-derived writer
    // that forgets to pass one slips an all-in price past them and overwrites a
    // stored subtotal. A user's eBay PURCHASE never has a better basis than
    // all-in unless a caller says "subtotal" -- the purchase record is the only
    // thing that knows, and a caller holding one passes it. Absent that, assume
    // the buyer's basis: worst case the row is marked all-in over another
    // all-in, which upserts exactly as before.
    priceBasis: input.priceBasis ?? (input.source === "ebay-user-purchase" ? "all-in" : null),
    soldAt: input.soldAt,
    observedAt: new Date().toISOString(),
    source: input.source,
    sourceExternalId: input.sourceExternalId ?? null,
    contributorUserId: input.contributorUserId ?? null,
    title: input.title ?? null,
    imageUrl: input.imageUrl ?? null,
    sellerHandle: input.sellerHandle ?? null,
    verifiedByUser: input.verifiedByUser ?? false,
    vendorCardId: input.vendorCardId ?? null,
    composite: computeCompositeForRow({
      title: input.title,
      cardNumber: input.cardNumber,
      sport: input.sport,
      setName: input.setName,
      cardYear: input.cardYear,
      // Pull the canonical productLine from the computed slug's segment
      // 3 so composite's ladder lookup uses the same normalized key the
      // rest of the pipeline anchors on (never the raw setName).
      productLine: hobbyiqCardId ? hobbyiqCardId.split(":")[3] ?? null : null,
    }),
    confidence: input.confidence ?? (input.verifiedByUser ? 1.0 : 0.5),
    contentHash,
    hobbyiqCardId,
    ttl: TTL_SEC,
    // CF-CARDSIGHT-UNVERIFIED-FLAG (Drew, 2026-08-01). Cardsight aggregates
    // both real sold sales and active listings; its response doesn't
    // reliably distinguish. Tag every Cardsight-source row with a
    // persistent flag so downstream views (recent-sales, comp detail,
    // storefront) can filter out unverified marketplace noise without
    // deleting the underlying rows. FMV pool query already excludes
    // Cardsight — this flag protects the OTHER surfaces.
    ...(input.source === "cardsight" ? { __cardsightUnverified: true } : {}),
    // CF-SUB-CHANNEL (Drew, 2026-08-01). Retail channel vocabulary
    // (Mega Box, Blaster, HTA, etc.) — pools unify at slug level but
    // language stays for search/filter/display.
    ...((input as RecordSoldCompInput & { __subChannel?: string }).__subChannel
      ? { __subChannel: (input as RecordSoldCompInput & { __subChannel?: string }).__subChannel }
      : {}),
  } as SoldCompDoc;

  // CF-CARDSIGHT-099-INGEST-GUARD (Drew, 2026-08-05). Prevention pair
  // to the 39,129-row historical backfill: any incoming cardsight row
  // at exactly $0.99 is opening-bid / sentinel pollution, not a real
  // sale. Immediately soft-exclude at write so it never anchors FMV.
  if (input.source === "cardsight" && input.price === 0.99) {
    (doc as SoldCompDoc & Record<string, unknown>).flaggedWrong = true;
    (doc as SoldCompDoc & Record<string, unknown>).excludedFromFmv = true;
    (doc as SoldCompDoc & Record<string, unknown>).flaggedReason = "cardsight_price_099_pollution";
    (doc as SoldCompDoc & Record<string, unknown>).excludedAt = new Date().toISOString();
  }

  // CF-PRICE-SANITY-INGEST-GATE (Drew, 2026-08-01). Before write, check
  // if incoming price is a wild outlier vs the target pool's median
  // (from confirmed-sold rows only). If yes, tag __priceOutlier=true
  // at write. Prevents new pool contamination the same way the Stage 3
  // backfill catches historical contamination. Cache-first — 15 min
  // per-slug TTL, so this adds ~0-2ms to the write path on cache hit.
  try {
    const { checkPriceSanity } = await import("./priceSanityGate.service.js");
    const sanity = await checkPriceSanity(c, doc.hobbyiqCardId, doc.price);
    if (sanity.isOutlier) {
      (doc as SoldCompDoc & Record<string, unknown>).__priceOutlier = true;
      (doc as SoldCompDoc & Record<string, unknown>).__priceOutlierAt = new Date().toISOString();
      (doc as SoldCompDoc & Record<string, unknown>).__priceOutlierBand = sanity.band ?? null;
      (doc as SoldCompDoc & Record<string, unknown>).__priceOutlierPoolMedian = sanity.poolMedian ?? null;
      (doc as SoldCompDoc & Record<string, unknown>).__priceOutlierReason = sanity.reason;
      // CF-CARDSIGHT-CONSENSUS-GUARD (Drew, 2026-08-05). Existing sanity
      // gate tags __priceOutlier for every source; for cardsight
      // specifically we treat that as a hard exclude — cardsight has
      // been proven unreliable and outliers there are almost always
      // pollution rather than a real steal/rip. Other sources (tca,
      // cardhedge) still get the softer __priceOutlier label so real
      // cheap sales don't get dropped.
      if (input.source === "cardsight") {
        (doc as SoldCompDoc & Record<string, unknown>).flaggedWrong = true;
        (doc as SoldCompDoc & Record<string, unknown>).excludedFromFmv = true;
        (doc as SoldCompDoc & Record<string, unknown>).flaggedReason = "cardsight_price_outlier_vs_consensus";
        (doc as SoldCompDoc & Record<string, unknown>).excludedAt = new Date().toISOString();
      }
    }
  } catch {
    // Sanity gate is a soft check — never fail the write on gate errors.
  }

  // CF-BAD-ACTOR-INGEST-CHECK (Drew, 2026-08-01). If the sellerHandle
  // is on the banned bad-actor list (≥50% historical contamination
  // across ≥10 rows), auto-tag this new row so downstream views can
  // filter it. Cached lookup — 30 min TTL, cheap.
  let sellerBadActorScore = 0;
  if (input.sellerHandle) {
    try {
      const { isBannedSeller } = await import("./badActorDetection.service.js");
      if (await isBannedSeller(input.sellerHandle)) {
        (doc as SoldCompDoc & Record<string, unknown>).__badActorSeller = true;
        (doc as SoldCompDoc & Record<string, unknown>).__badActorSellerAt = new Date().toISOString();
        sellerBadActorScore = 1;
      }
    } catch { /* soft check */ }
  }

  // CF-CONFIDENCE-SCORE-INGEST (Drew, 2026-08-01). Compute a 0-1
  // confidence score for this row and persist it. Downstream views
  // and analytics can filter by band. Learned weights (once corpus is
  // large enough) will make this dramatically more accurate; the API
  // is unchanged when we swap rule-based → ML.
  try {
    const { scoreRow } = await import("./confidenceScore.service.js");
    // Reuse pool median if the price sanity gate computed it above.
    const pmVal = (doc as SoldCompDoc & { __priceOutlierPoolMedian?: number }).__priceOutlierPoolMedian;
    const poolMedian = typeof pmVal === "number" && pmVal > 0 ? pmVal : null;
    const conf = await scoreRow({
      row: input,
      poolMedian,
      poolSampleCount: poolMedian ? 5 : 0,
      catalogHasCanonicalForCardnumberYear: false,   // TODO: cache lookup
      catalogAgreesOnSet: false,
      sellerBadActorScore,
    });
    (doc as SoldCompDoc & Record<string, unknown>).__confidenceScore = conf.score;
    (doc as SoldCompDoc & Record<string, unknown>).__confidenceBand = conf.band;
    (doc as SoldCompDoc & Record<string, unknown>).__confidenceExplain = conf.explain;
    // Auto-reject at very low confidence — near-certain contamination
    if (conf.band === "reject") {
      if (Math.random() < 0.01) {
        console.warn(JSON.stringify({
          event: "recordSoldComp_confidence_reject",
          score: conf.score,
          reason: conf.explain,
          source: input.source,
          sampled: true,
        }));
      }
      // CF-INGEST-LEARNING (Drew, 2026-08-01). Every ingest decision
      // trains the confidence scorer. Sampled at 5% for reject band
      // (relatively rare, worth capturing more of).
      if (Math.random() < 0.05) {
        try {
          const { logLearningEvent } = await import("./learningEvents.service.js");
          logLearningEvent({
            eventType: "ingest-reject",
            actor: "auto-system",
            subjectType: "sold_comp",
            subjectId: doc.id,
            decision: { action: "reject", confidence: conf.score, reason: conf.explain },
            features: { source: input.source, price: input.price, band: conf.band },
          });
        } catch { /* soft */ }
      }
      return { written: false, reason: "invalid-input" };
    }
    // Quarantine band: still persist but flag it
    if (conf.band === "quarantine") {
      (doc as SoldCompDoc & Record<string, unknown>).__userFlagQuarantine = true;
      (doc as SoldCompDoc & Record<string, unknown>).__userFlagQuarantineAt = new Date().toISOString();
      (doc as SoldCompDoc & Record<string, unknown>).__autoQuarantineFromConfidence = true;
      // Log at 10% sample — these are borderline cases the scorer needs feedback on
      if (Math.random() < 0.10) {
        try {
          const { logLearningEvent } = await import("./learningEvents.service.js");
          logLearningEvent({
            eventType: "ingest-quarantine",
            actor: "auto-system",
            subjectType: "sold_comp",
            subjectId: doc.id,
            decision: { action: "quarantine", confidence: conf.score, reason: conf.explain },
            features: { source: input.source, price: input.price, band: conf.band },
          });
        } catch { /* soft */ }
      }
    } else if (conf.band === "auto-trust" && Math.random() < 0.001) {
      // Sample auto-trust at 0.1% — high volume, but useful baseline
      try {
        const { logLearningEvent } = await import("./learningEvents.service.js");
        logLearningEvent({
          eventType: "ingest-accept",
          actor: "auto-system",
          subjectType: "sold_comp",
          subjectId: doc.id,
          decision: { action: "accept", confidence: conf.score },
          features: { source: input.source, price: input.price, band: conf.band },
        });
      } catch { /* soft */ }
    }
  } catch { /* soft */ }

  // CF-CONTENT-HASH-PREWRITE-DEDUP (Drew, 2026-07-20). Cross-source
  // dedup at the write boundary. Query for any existing row in this
  // cardId partition with the same contentHash. If one exists, apply
  // pickCanonical scoring — the incoming write only lands if it beats
  // every existing dup; otherwise skip. Prevents future duplicates
  // regardless of which emit path fires (eBay user + CH tracking same
  // sale + browse-ended finding same listing all collapse to one row).
  //
  // CF-CONTENT-HASH-DEDUP (Drew, 2026-07-21, extended 2026-08-06).
  // Prior comment said "same-source-different-externalId is genuinely
  // two distinct sales." That's wrong for CardHedge specifically —
  // CH emits the same eBay listing under two different sourceExternalId
  // shapes ("<cardId>x<listing>" AND "ch-daily::<listing>"), producing
  // dupe rows that fool the pool. contentHash is (cardId, parallel,
  // isAuto, grade, price, soldAt) — two sellers listing the same card
  // at the same price at the same *second* is lottery-tier; treat any
  // same-contentHash-within-partition as the same sale regardless of
  // source. TCA + Cardsight rarely trip this because their externalId
  // is the eBay item id directly (already dedup-safe on id).
  //
  // CF-A-FLAGGED-ROW-IS-NOT-A-DEDUP-PARTNER (2026-09-01). A row we have
  // already ruled WRONG must not decide the fate of an incoming genuine
  // sale. Until now this query selected every same-hash row in the
  // partition, flagged or not, and both outcomes were wrong:
  //
  //   - the flagged row OUTSCORES the incoming sale (measured against
  //     dist/: a flagged row on a real eBay id scores 95.855424, a genuine
  //     incoming `ch-daily::` sale 85.882208) -> the REAL sale is dropped
  //     at the `incomingScore <= bestExistingScore` return below, and the
  //     pool silently loses it.
  //   - the incoming sale outscores it -> the delete loop below HARD
  //     DELETES the flagged row, destroying the `dedupSupersededBy`
  //     provenance trail the triage lane exists to write. The pool is
  //     sacred: flag, never delete.
  //
  // Every FMV read path already filters `flaggedWrong`
  // (canonicalFmv.service.ts:1073,:1292; marketMovers, playerDetail,
  // priceSeries, setDetail, verifyQueue; cohortBacktest). The ingest-time
  // dedup was the one comparison that did not, and it is the only one that
  // can DESTROY data rather than merely hide it.
  //
  // ASYMMETRY, deliberate: when the INCOMING doc is itself flagged (the
  // cardsight $0.99 / outlier guards above mint that at :1334/:1363), the
  // stored flagged twin is still its dedup partner — excluding it there
  // would resurrect exactly the duplicate rows those guards suppress. So a
  // flagged write dedups against flagged rows, and a live write dedups
  // only against live rows. Neither can reach across the line.
  const incomingIsFlagged =
    (doc as SoldCompDoc & Record<string, unknown>).flaggedWrong === true;
  try {
    const { resources: existing } = await c.items.query<SoldCompDoc>({
      query: incomingIsFlagged
        ? "SELECT * FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash)"
        : "SELECT * FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash) AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)",
      parameters: [{ name: "@h", value: contentHashLookup }],
    }, { partitionKey: doc.cardId }).fetchAll();

    if (existing.length > 0) {
      const incomingScore = scoreForCanonical(doc);
      const bestExistingScore = Math.max(...existing.map(scoreForCanonical));
      const sameSourceDupCount = existing.filter(e => e.source === doc.source).length;
      if (incomingScore <= bestExistingScore) {
        // Existing row is canonical → skip. Sample-log so we can
        // measure the dedup hit rate + specifically catch CH internal
        // multi-path dupes (existingCount from same source).
        if (Math.random() < 0.01) {
          console.log(JSON.stringify({
            event: "sold_comps_prewrite_dedup_skipped",
            source: "soldCompsStore.recordSoldComp",
            cardId: doc.cardId,
            contentHash,
            incomingSource: doc.source,
            existingCount: existing.length,
            sameSourceDupCount,
            sampled: true,
          }));
        }
        return { written: true, deduped: true, id: bestOf(existing)?.id ?? null, hobbyiqCardId: doc.hobbyiqCardId ?? null };
      }
      // Incoming wins → delete existing dupes (cross- AND same-source)
      // before writing. Anything with the same contentHash in the
      // partition is by construction the same sale.
      for (const e of existing) {
        try { await c.item(e.id, doc.cardId).delete(); } catch { /* best effort */ }
      }
      console.log(JSON.stringify({
        event: "sold_comps_prewrite_dedup_replaced",
        source: "soldCompsStore.recordSoldComp",
        cardId: doc.cardId,
        contentHash,
        replacedCount: existing.length,
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

  // CF-SOLDCOMPS-CROSS-PARTITION-USER-DEDUP (Drew, 2026-07-28). The
  // contentHash pre-write dedup above is partition-scoped (same cardId).
  // But a single physical eBay purchase can land under DIFFERENT cardIds
  // when the ReviewQueue confirm path picks one cardId and the periodic
  // cardIdSuggester later picks a different one (real repro: Hartshorn
  // Blue Auto emitted both `1769294032882x511083935394397250` from
  // reviewQueue and `1769288647225x684303281054543500` from suggester —
  // same sale, same user, same $608.30, 4 days apart, contentHash
  // includes cardId so it didn't collide).
  //
  // Cross-partition preflight for user-scoped sources only (ebay-user-
  // purchase, ebay-user-sale, manual-user-entry) when hobbyiqCardId +
  // contributorUserId are both known. Query on the well-indexed slug
  // field so cross-partition cost stays low. Same scoreForCanonical
  // arbitration as the partition-scoped path — verifiedByUser=true
  // beats false, longer parallel beats shorter, newer observedAt breaks
  // ties.
  //
  // CF-A-FLAGGED-ROW-IS-NOT-A-DEDUP-PARTNER, cross-partition arm
  // (2026-09-01, follow-up to #1633). This is the THIRD unguarded dedup
  // path and the last one in `backend/src` that can destroy a row. #1633
  // closed the partition-scoped contentHash query and the vendor-pool
  // query; this one selected every cross-partition twin, flagged or not,
  // and then HARD DELETES the losers at the loop below.
  //
  // #1633 also gave scoreForCanonical a floor-clearing -1000 penalty for
  // a flagged row. That makes the damage here DETERMINISTIC rather than
  // occasional: a flagged cross-partition twin now ALWAYS scores below
  // the incoming live sale, so `incomingScore <= bestExistingScore` is
  // always false and control always reaches the delete loop. Every
  // flagged cross-partition twin would be hard-deleted on the next
  // user-scoped write of the same sale, destroying the
  // `dedupSupersededBy` provenance the triage lane exists to write.
  //
  // Same predicate, same asymmetry as #1633: a live write compares only
  // against live rows, a flagged write keeps its flagged twins as dedup
  // partners so the guards that mint the flag are not defeated by
  // resurrection. The pool is sacred: flag, never delete.
  //
  // HONEST SCOPE of the asymmetry HERE: today it is unreachable. Both ingest
  // flag mints (:1351 cardsight $0.99, :1381 cardsight outlier) are
  // cardsight-only, and cardsight is not user-scoped, so no flagged doc
  // currently reaches this branch — a mutant making the predicate
  // unconditional does NOT go red, and no test pretends otherwise. It is
  // written this way so the two dedup paths cannot drift: if a guard ever
  // mints a flag on a user-scoped source, this path already behaves like the
  // contentHash one instead of silently resurrecting duplicates. The
  // behaviour itself IS pinned, on the reachable path, in
  // ingestFlaggedDedupBehavior.test.ts.
  const isUserScoped = doc.source === "ebay-user-purchase"
    || doc.source === "ebay-user-sale"
    || doc.source === "manual-user-entry";
  if (isUserScoped && hobbyiqCardId && doc.contributorUserId && doc.soldAt) {
    try {
      const soldDay = doc.soldAt.slice(0, 10);
      const { resources: crossPartitionExisting } = await c.items.query<SoldCompDoc>({
        query: `SELECT * FROM c
                WHERE c.hobbyiqCardId = @slug
                  AND c.source = @src
                  AND c.contributorUserId = @u
                  AND c.price = @p
                  AND STARTSWITH(c.soldAt, @day)
                  AND c.cardId != @cardId${incomingIsFlagged ? "" : `
                  AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)`}`,
        parameters: [
          { name: "@slug", value: hobbyiqCardId },
          { name: "@src", value: doc.source },
          { name: "@u", value: doc.contributorUserId },
          { name: "@p", value: doc.price },
          { name: "@day", value: soldDay },
          { name: "@cardId", value: doc.cardId },
        ],
      }).fetchAll();

      if (crossPartitionExisting.length > 0) {
        const incomingScore = scoreForCanonical(doc);
        const bestExistingScore = Math.max(...crossPartitionExisting.map(scoreForCanonical));
        if (incomingScore <= bestExistingScore) {
          // Existing row wins — skip the write entirely so we don't
          // create a second doc under a different cardId partition.
          console.log(JSON.stringify({
            event: "sold_comps_cross_partition_user_dedup_skipped",
            source: "soldCompsStore.recordSoldComp",
            slug: hobbyiqCardId,
            incomingCardId: doc.cardId,
            incomingSource: doc.source,
            incomingScore,
            existingCardIds: crossPartitionExisting.map(e => e.cardId),
            bestExistingScore,
          }));
          return { written: true, deduped: true, id: bestOf(crossPartitionExisting)?.id ?? null, hobbyiqCardId: hobbyiqCardId ?? null };
        }
        // Incoming beats existing — delete the losers so we don't leave
        // stale duplicates under the other cardId partitions.
        for (const e of crossPartitionExisting) {
          try { await c.item(e.id, e.cardId).delete(); } catch { /* best effort */ }
        }
        console.log(JSON.stringify({
          event: "sold_comps_cross_partition_user_dedup_replaced",
          source: "soldCompsStore.recordSoldComp",
          slug: hobbyiqCardId,
          incomingCardId: doc.cardId,
          replacedCount: crossPartitionExisting.length,
          replacedCardIds: crossPartitionExisting.map(e => e.cardId),
        }));
      }
    } catch (err) {
      // Non-fatal — fall through to upsert.
      if (Math.random() < 0.01) {
        console.warn(JSON.stringify({
          event: "sold_comps_cross_partition_user_dedup_query_failed",
          source: "soldCompsStore.recordSoldComp",
          slug: hobbyiqCardId,
          error: (err as Error)?.message ?? String(err),
          sampled: true,
        }));
      }
    }
  }

  // CF-ONE-TRANSACTION-ONE-ROW (Drew, 2026-08-29, checklist D9). For a
  // user-owned sale the id IS the transaction: `ebay-user-purchase::<order>`.
  // But /cardId is the partition key, so the same id under a different slug
  // is a DIFFERENT document to Cosmos -- the upsert below cannot see it, the
  // contentHash probe is partition-scoped, and the cross-partition probe
  // above keys on the slug that just changed. That is how Drew's purchase sat
  // under the un-numbered twin while a re-file landed beside it. One
  // transaction, one row: a copy of this id filed under another card is
  // superseded before this write lands.
  if (isUserScoped && input.sourceExternalId && String(input.sourceExternalId).trim()) {
    try {
      const { resources: sameId } = await c.items.query<{ id: string; cardId: string }>({
        query: "SELECT c.id, c.cardId FROM c WHERE c.id = @id AND c.cardId != @cardId",
        parameters: [
          { name: "@id", value: doc.id },
          { name: "@cardId", value: doc.cardId },
        ],
      }).fetchAll();
      // Re-checked in code: only ever this id, only ever another partition.
      const stale = (sameId ?? []).filter((e) => e?.id === doc.id && typeof e.cardId === "string" && e.cardId !== doc.cardId);
      for (const e of stale) {
        try { await c.item(e.id, e.cardId).delete(); } catch { /* best effort */ }
      }
      if (stale.length > 0) {
        console.log(JSON.stringify({
          event: "sold_comp_same_id_rehomed",
          source: "soldCompsStore.recordSoldComp",
          id: doc.id,
          fromCardIds: stale.map((e) => e.cardId),
          toCardId: doc.cardId,
        }));
      }
    } catch { /* non-fatal — fall through to upsert */ }
  }

  // CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38). The doc id is
  // price-independent, so this upsert is the moment a later writer without the
  // purchase record would overwrite the market's price with the buyer's basis.
  // Point-read the row this write is about to replace and refuse that ONE
  // direction. Best-effort: a failed read falls through and upserts, which is
  // exactly today's behaviour.
  if (doc.priceBasis === "all-in") {
    try {
      const { resource: prior } = await c.item(doc.id, doc.cardId).read<SoldCompDoc>();
      if (keepsExistingPrice(prior, doc)) {
        console.log(JSON.stringify({
          event: "sold_comp_price_regression_refused",
          source: "soldCompsStore.recordSoldComp",
          id: doc.id,
          cardId: doc.cardId,
          keptPrice: prior?.price,
          keptBasis: prior?.priceBasis,
          incomingPrice: doc.price,
          incomingBasis: doc.priceBasis,
          detail: "an all-in price (item + shipping + tax) does not overwrite a stored subtotal",
        }));
        // The sale IS in the pool, at the better price. Report it the way the
        // content-hash dedup reports the same outcome.
        return { written: true, deduped: true, id: prior?.id ?? doc.id, hobbyiqCardId: prior?.hobbyiqCardId ?? doc.hobbyiqCardId ?? null };
      }
    } catch { /* 404 or read failure — nothing stored to protect */ }
  }

  try {
    await c.items.upsert(doc as any);
    // CF-INGEST-CATALOG-AUTO-SEED (Drew, 2026-08-05). Fire-and-forget:
    // make sure a card_catalog row exists at this canonical slug so
    // every incoming comp immediately "tracks to the catalog." Cached
    // in-process — the first comp for a slug this run does one Cosmos
    // read + (if missing) one upsert; subsequent comps are free.
    // CF-SALES-DO-NOT-MINT-CARDS (Drew, 2026-08-28: "want to make sure the
    // card catalog is not writing from sales index"). This auto-seed is how
    // 2.5M sales-derived catalog rows came to exist: a sale that matched
    // nothing minted a row at its own parser slug, and that row then
    // confirmed the sale. The checklist is the spine; a VENDOR sale that the
    // catalog cannot place stays unplaced — catalogMatched=false, counted by
    // catalog_resolve_not_found, re-resolved by the rematch when its
    // checklist lands. It never becomes a card.
    //
    // USER sources still seed, by Drew's 2026-08-08 directive: a card the
    // user physically owns is real coverage even before its checklist is
    // acquired. That is the one place a sale is evidence of a card.
    // USER_SEED_SOURCES is module-level (shared with the D7d reconcile gate).
    if (doc.hobbyiqCardId && doc.cardYear && doc.sport && USER_SEED_SOURCES.has(String(input.source))) {
      void (async () => {
        try {
          const { ensureCatalogRow } = await import("../catalog/ensureCatalogRow.service.js");
          await ensureCatalogRow({
            slug: doc.hobbyiqCardId!,
            sport: doc.sport!,
            year: doc.cardYear!,
            setName: doc.setName,
            cardNumber: doc.cardNumber,
            parallel: doc.parallel,
            isAuto: doc.isAuto,
            // The print run the slug was derived with -- never a second
            // reading of the title that could disagree with it.
            printRun: printRunFinal,
            playerName: doc.playerName,
          });
        } catch { /* silent — never blocks ingest */ }
      })();
    }
    // CF-FMV-ACCURACY-CAPTURE (Drew, 2026-08-01). For user-verified
    // sales (ebay-user-purchase, ebay-user-sale, manual-user-entry),
    // capture predicted-vs-actual by looking up the pool median from
    // BEFORE this write landed. The delta is the trust-in-cleanliness
    // metric. Skips if pool too thin (no reliable prediction to
    // compare against).
    if (["ebay-user-purchase", "ebay-user-sale", "ebay-account", "manual-user-entry"].includes(input.source)
        && input.contributorUserId && doc.hobbyiqCardId) {
      void (async () => {
        try {
          const { checkPriceSanity } = await import("./priceSanityGate.service.js");
          const { logFmvAccuracy } = await import("./fmvAccuracy.service.js");
          // Reuse the pool-median cache from the sanity gate — it's the
          // "what the model predicted" number for this slug.
          const sanity = await checkPriceSanity(c, doc.hobbyiqCardId, input.price);
          const predictedFmv = sanity.poolMedian ?? null;
          if (predictedFmv && predictedFmv > 0 && doc.hobbyiqCardId && input.contributorUserId) {
            logFmvAccuracy({
              slug: doc.hobbyiqCardId,
              userId: input.contributorUserId,
              cardId: doc.cardId,
              soldAt: doc.soldAt,
              predictedFmv,
              actualPrice: input.price,
            });
          }
        } catch { /* soft */ }
      })();
    }

    // CF-IMAGE-PHASH (Drew, 2026-08-01). Fire-and-forget: fetch image,
    // compute dHash, store on row, check for pHash duplicates in the
    // same slug. Within-slug matches → __phashDuplicate. Different pHash
    // between two rows claiming same physical card = mis-tag signal.
    if (doc.imageUrl && doc.hobbyiqCardId) {
      void (async () => {
        try {
          const { computeImageDHash, findPhashDuplicatesInSlug } = await import("./imagePhash.service.js");
          const hash = await computeImageDHash(doc.imageUrl!);
          if (!hash) return;
          // Persist hash on the just-written row
          const { resource } = await c.item(doc.id, doc.cardId).read();
          if (resource) {
            (resource as Record<string, unknown>).__imagePhash = hash;
            (resource as Record<string, unknown>).__imagePhashAt = new Date().toISOString();
            const dups = await findPhashDuplicatesInSlug(c, doc.hobbyiqCardId!, hash, doc.id);
            if (dups.length > 0) {
              (resource as Record<string, unknown>).__phashDuplicate = true;
              (resource as Record<string, unknown>).__phashDuplicateIds = dups.slice(0, 5);
            }
            await c.items.upsert(resource);
          }
        } catch { /* soft */ }
      })();
    }

    // CF-CROSS-SOURCE-CONSENSUS (Drew, 2026-08-01). Fire-and-forget
    // post-write check: does this sale match another sale from a
    // DIFFERENT source (matching title + price)? If yes, both rows
    // get __consensusVerified=true — high-trust ground truth for
    // downstream ML training + trust-tier fast-track.
    void (async () => {
      try {
        const { checkCrossSourceConsensus } = await import("./crossSourceConsensus.service.js");
        const result = await checkCrossSourceConsensus(c, {
          id: doc.id,
          hobbyiqCardId: doc.hobbyiqCardId ?? null,
          price: doc.price,
          source: doc.source,
          title: doc.title,
          soldAt: doc.soldAt,
        });
        if (result.verified) {
          // Tag this row + all matched rows
          const now = new Date().toISOString();
          const toUpdate = [doc.id, ...result.matchedRows];
          for (const id of toUpdate) {
            try {
              const { resource } = await c.item(id, doc.cardId).read();
              if (resource) {
                (resource as Record<string, unknown>).__consensusVerified = true;
                (resource as Record<string, unknown>).__consensusVerifiedAt = now;
                (resource as Record<string, unknown>).__consensusSampleCount = result.consensusCount;
                await c.items.upsert(resource);
              }
            } catch { /* skip individual failures */ }
          }
        }
      } catch { /* soft */ }
    })();
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

  // Reached only after the upsert succeeded — the sale is in the pool.
  return { written: true, deduped: false, id: doc.id, hobbyiqCardId: doc.hobbyiqCardId ?? null };
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
// CF-COMP-FLAG-THRESHOLD (Drew, 2026-07-26, prod-readiness audit P0.2).
// Prior version set flaggedWrong=true on the FIRST user flag — one
// bad-faith user could drop any comp from FMV instantly. Now tracks
// flaggedByUsers[] deduped per user and only flips flaggedWrong=true
// once distinct-user count meets threshold (LEGACY_FLAG_THRESHOLD env
// var, default 3). Idempotent per (userId, compId). Full audit trail
// via flaggedByUsers + flaggedHistory arrays.
//
// Paired with enforceUserFlagRateLimit middleware (20 flags per user
// per day) at the route level, this closes the abuse vector.
const LEGACY_FLAG_THRESHOLD_DEFAULT = 3;
const LEGACY_MAX_NOTE_LEN = 500;
function legacyFlagThreshold(): number {
  const raw = process.env.LEGACY_FLAG_THRESHOLD;
  const n = raw ? parseInt(raw, 10) : LEGACY_FLAG_THRESHOLD_DEFAULT;
  return Number.isFinite(n) && n > 0 ? n : LEGACY_FLAG_THRESHOLD_DEFAULT;
}

export async function flagCompAsWrong(input: {
  cardId: string;
  compId: string;
  flaggedByUserId: string;
  reason?: string;
}): Promise<{ status: "flagged" | "recorded" | "already-flagged-by-you" | "not-found" | "no-store" | "error"; error?: string; totalFlags?: number; thresholdApplied?: boolean }> {
  if (!input.cardId?.trim() || !input.compId?.trim()) {
    return { status: "error", error: "missing cardId or compId" };
  }
  const c = await getContainer();
  if (!c) return { status: "no-store" };
  try {
    const { resource: existing } = await c.item(input.compId, input.cardId).read<SoldCompDoc & {
      flaggedByUsers?: string[];
      flaggedHistory?: Array<{ userId: string; reason?: string; at: string }>;
    }>();
    if (!existing) return { status: "not-found" };

    const flaggedByUsers = Array.isArray(existing.flaggedByUsers) ? [...existing.flaggedByUsers] : [];
    const flaggedHistory = Array.isArray(existing.flaggedHistory) ? [...existing.flaggedHistory] : [];

    if (flaggedByUsers.includes(input.flaggedByUserId)) {
      return {
        status: "already-flagged-by-you",
        totalFlags: flaggedByUsers.length,
        thresholdApplied: existing.flaggedWrong === true,
      };
    }

    flaggedByUsers.push(input.flaggedByUserId);
    flaggedHistory.push({
      userId: input.flaggedByUserId,
      reason: input.reason?.trim().slice(0, LEGACY_MAX_NOTE_LEN),
      at: new Date().toISOString(),
    });

    const threshold = legacyFlagThreshold();
    const shouldFlipFlag = flaggedByUsers.length >= threshold;

    const updated = {
      ...existing,
      flaggedByUsers,
      flaggedHistory,
      // Legacy fields kept for back-compat readers; flipped only at threshold.
      flaggedWrong: shouldFlipFlag ? true : (existing.flaggedWrong ?? false),
      flaggedByUserId: input.flaggedByUserId,       // most-recent flagger
      flaggedAt: new Date().toISOString(),
      flaggedReason: input.reason?.trim().slice(0, LEGACY_MAX_NOTE_LEN) ?? null,
    };
    await c.items.upsert(updated as any);
    return {
      status: shouldFlipFlag ? "flagged" : "recorded",
      totalFlags: flaggedByUsers.length,
      thresholdApplied: shouldFlipFlag,
    };
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
/**
 * CF-ROUTE-SLUGS (D4 "one valuation path", PR 3 — 2026-08-29). The canonical
 * hiq slug for a VENDOR cardId, read off the sold_comps rows that carry both
 * ids (hobbyiqCardId is backfilled on 2.4M rows). /cardId is the partition
 * key, so this is a single-partition point read — cheap enough for a route.
 *
 * Returns the id itself when it is already a slug; null when no row maps the
 * id or Cosmos is unavailable. Never throws: a missing slug degrades one
 * rung, it must never cost the price.
 */
export async function lookupHobbyIqCardIdForVendorCardId(cardId: string): Promise<string | null> {
  const id = String(cardId ?? "").trim();
  if (!id) return null;
  if (id.startsWith("hiq:")) return id;
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resources } = await container.items.query<{ hobbyiqCardId?: string | null }>({
      query: "SELECT TOP 1 c.hobbyiqCardId FROM c WHERE c.cardId = @id AND IS_DEFINED(c.hobbyiqCardId) AND STARTSWITH(c.hobbyiqCardId, \"hiq:\")",
      parameters: [{ name: "@id", value: id }],
    }, { partitionKey: id, maxItemCount: 1 }).fetchAll();
    const slug = resources[0]?.hobbyiqCardId;
    return typeof slug === "string" && slug.startsWith("hiq:") ? slug : null;
  } catch {
    return null;
  }
}

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
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  // CF-USER-COMPS-AUTO-FILTER (Drew, 2026-07-23). Strict isAuto equality.
  // CH cardIds routinely bucket the base rookie + autograph variants under
  // one id (e.g. Owen Carey Blue Refractor /150 Auto shares a cardId with
  // 145 non-auto rookie cards at ~$2). Without this filter, holdings for
  // autographed cards get diluted to near-zero by the base-rookie pool.
  // When `undefined`, no filter (legacy behavior); when true or false,
  // strict equality required.
  isAuto?: boolean;
  // CF-USER-COMPS-PRINTRUN-FILTER (Drew, 2026-07-23). Strict printRun
  // equality. Under one cardId, /150 and /50 numbered parallels trade at
  // very different prices; mixing them dilutes both. When `undefined`,
  // no filter. When a number, strict-equal to that print run. When null,
  // matches only unnumbered rows (printRun === null / undefined).
  printRun?: number | null;
  // CF-EXCLUDE-SELF-COMPS (Drew, 2026-08-04). When set, filters out
  // rows contributed by THIS user. A user's own eBay purchase gets
  // persisted as source="ebay-user-purchase" — surfacing it back as
  // a "comp" for that user's own holding pollutes their pricing
  // (median = purchase price = worthless self-reflection) and forces
  // the estimator to fall through to Raw when observed-grade sample
  // count drops to zero after the pool excludes vendor data.
  // Symmetric rule: user-contributed data doesn't feed the contributor's
  // OWN pricing but remains market signal for everyone else.
  excludeContributorUserId?: string | null;
  /** CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): a caller that already
   *  resolved an hiq slug to its catalog row (recent-sales, to report
   *  resolvedCardId) passes it here so the read does not resolve twice. */
  resolvedIdentity?: CatalogRowResolution | null;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const to = input.maxDate ?? now.toISOString();

  // CF-RECENT-SALES-HIQ-SLUG (Drew, 2026-08-04). Match by cardId OR
  // hobbyiqCardId so recent-sales works for holdings that never got
  // a vendor cardId assigned (1991 Score Griffey #396: no cardId, slug
  // hiq:baseball:1991:1991-score-baseball:396:base:no-auto has 1 comp
  // — inventory showed "no comps" because query filtered by cardId
  // only). Cross-partition since we can't scope to a partition when
  // matching on non-partition-key field. Costs a few extra RUs but
  // consistent with the pool query in unifiedPricing.service.ts.
  // CF-RECENT-SALES-DROP-THE-OR (Drew, 2026-08-14: card page "Request timed
  // out after 30s" on a holding whose comps demonstrably exist).
  //
  // The OR is what times out. One side is the partition key and the other is
  // not, so Cosmos can target a partition for NEITHER and fans out across all
  // of them, dragging whole documents (SELECT *) back from each and then
  // sorting 5.6M rows. Measured separately, the same lookup by hobbyiqCardId
  // alone is 631ms / 22 RU — it is the OR that is expensive, not the data.
  //
  // The OR was never needed, because the two cases are disjoint by input:
  //   a "hiq:" slug   -> match hobbyiqCardId. Rows already migrated so
  //                      cardId === the slug carry the SAME value in
  //                      hobbyiqCardId, so this still finds them.
  //   a vendor cardId -> match cardId, partition-scoped. No row carries a
  //                      vendor id in hobbyiqCardId, so the other side could
  //                      never have contributed anything.
  //
  // Branching keeps this to a SINGLE query, which also matters for the
  // existing tests: they stub one items.query call, and a two-query version
  // broke 7 of them by consuming a mock that only answers once.
  // CF-RECENT-SALES-SORT-IN-MEMORY (2026-08-22). DROP-THE-OR above removed the
  // fan-out; the ORDER BY is what is left, and on a high-volume card it is the
  // whole cost.
  //
  // Matching a "hiq:" slug cannot be partition-scoped — sold_comps is
  // partitioned by /cardId — so the query is cross-partition, and a
  // cross-partition ORDER BY makes Cosmos merge-sort every partition's result
  // before returning a row. Measured on Shohei Ohtani 2018 Bowman Chrome #1
  // (1,236 comps in 180d, the card behind a reported site timeout):
  //
  //   with ORDER BY, cross-partition   6.85s warm  (6.0 / 6.9 / 7.1)
  //
  // The rows are all fetched anyway — fetchAll(), then several in-memory
  // filters below — so the sort costs nothing here. Sorting ~1,200 objects in
  // JS is sub-millisecond against seconds of merge-sort in Cosmos.
  //
  // Partition-scoped lookups (a vendor cardId) KEEP the ORDER BY: within one
  // partition it is index-backed and free, and leaving that path untouched
  // keeps the change to the branch that is actually slow.
  //
  // Ordering of the returned array is unchanged either way — soldAt DESC is
  // re-applied below.
  const looksLikeHiqSlug = typeof input.cardId === "string" && input.cardId.startsWith("hiq:");
  const matchField = looksLikeHiqSlug ? "c.hobbyiqCardId" : "c.cardId";
  const orderClause = looksLikeHiqSlug ? "" : " ORDER BY c.soldAt DESC";
  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): an hiq slug is read
  // under the id AND the one numbered twin the resolver names — see
  // catalogIdentityResolver.poolReadIdsFor (the pool is keyed both ways until
  // the D29 fleet re-keys it). Two equalities on the indexed field in one
  // query, never a STARTSWITH. A caller's printRun lets the resolver settle
  // the twin with a 1-RU point read instead of the stem query.
  const resolvedIdentity = looksLikeHiqSlug
    ? (input.resolvedIdentity ?? await resolveIdentityToCatalogRow(input.cardId, {
      printRun: typeof input.printRun === "number" ? input.printRun : null,
    }))
    : null;
  const readIds = looksLikeHiqSlug ? poolReadIdsFor(input.cardId, resolvedIdentity) : [input.cardId];
  if (readIds.length > 1) {
    console.log(JSON.stringify({
      event: "sold_comps_read_unions_numbered_twin",
      source: "soldCompsStore.readCompsByCardId",
      requestedCardId: input.cardId,
      readCardIds: readIds,
    }));
  }
  const idClause = readIds.length > 1
    ? `(${matchField} = @cid OR ${matchField} = @cid1)`
    : `${matchField} = @cid`;
  const q = {
    query:
      `SELECT * FROM c WHERE ${idClause} AND c.soldAt >= @from AND c.soldAt <= @to${orderClause}`,
    parameters: [
      { name: "@cid", value: readIds[0] },
      ...(readIds.length > 1 ? [{ name: "@cid1", value: readIds[1] }] : []),
      { name: "@from", value: from },
      { name: "@to", value: to },
    ],
  };
  try {
    // CF-RECENT-SALES-HIQ-SLUG: when input.cardId is a hobbyiqCardId
    // slug (starts with "hiq:"), we need cross-partition since the pool
    // stores rows partitioned by the vendor cardId. When it looks like
    // a vendor id, partition-scope for speed.
    const looksLikeSlug = typeof input.cardId === "string" && input.cardId.startsWith("hiq:");
    const queryOpts = looksLikeSlug
      ? {}
      : { partitionKey: input.cardId };
    const { resources } = await c.items.query(q, queryOpts).fetchAll();
    let all = resources as SoldCompDoc[];
    // Re-apply the ordering the cross-partition branch no longer asks Cosmos
    // for. Callers and tests rely on soldAt DESC.
    if (looksLikeHiqSlug) {
      // Sort by PARSED time, not by string. soldAt is not stored in one
      // format — this card alone carries both "2026-08-21T11:01:00+00:00" and
      // "2026-02-24T11:56:42.000Z" — so an ordinal string sort interleaves the
      // two shapes, and localeCompare is worse still because it is
      // locale-aware about "+" and "Z". Parsing gives true newest-first
      // regardless of shape. Unparseable values sort last rather than
      // poisoning the comparison.
      const ts = (v: unknown): number => {
        const t = Date.parse(String(v ?? ""));
        return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
      };
      all = [...all].sort((a, b) => ts(b.soldAt) - ts(a.soldAt));
    }
    if (input.sources && input.sources.length > 0) {
      const set = new Set(input.sources);
      all = all.filter((d) => set.has(d.source));
    }
    // CF-SLUG-IS-THE-IDENTITY (2026-08-23). A hobbyiqCardId slug already names
    // the parallel and the auto — the query above matched it EXACTLY, so every
    // row here is that card by construction. Re-filtering on a parallel string
    // cannot narrow a set that is already one card; it can only wrongly empty
    // it, and it did.
    //
    // The card page sends `parallel={initialParallel ?? ""}` on every request,
    // so a page opened without a parallel in hand sends "" — which this filter
    // reads as "base only" via BASE_ALIASES. For
    // hiq:...:cpa-tg:blue-refractor:auto:num-150 that discards the card's only
    // real comp, the $729 auto, and the panel goes empty on a card we price
    // correctly.
    //
    // Grade filtering below still applies: the canonical slug does not encode a
    // grade, so Raw vs PSA 10 remains a real distinction the caller may want.
    const slugIsIdentity = looksLikeHiqSlug;
    if (slugIsIdentity && typeof input.parallel === "string") {
      console.log(JSON.stringify({
        event: "recent_comps_parallel_filter_skipped_for_slug",
        cardId: input.cardId,
        requestedParallel: input.parallel,
      }));
    }
    if (!slugIsIdentity && typeof input.parallel === "string") {
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
    // CF-USER-COMPS-AUTO-FILTER (Drew, 2026-07-23): strict auto match.
    // Undefined caller → no filter. Boolean → require exact equality.
    // Critical: CH cardIds mix base rookies + auto variants under one
    // id, so without this filter autographed holdings get diluted to
    // near-zero by the base-rookie pool.
    // Same reasoning as the parallel filter: the slug already says :auto: or
    // :no-auto:, so an exact hobbyiqCardId match is already auto-correct. A
    // caller's isAuto here can only contradict the identity it just asked for.
    if (input.isAuto !== undefined && !looksLikeHiqSlug) {
      const wantAuto = input.isAuto === true;
      all = all.filter((d) => d.isAuto === wantAuto);
    }
    // CF-USER-COMPS-PRINTRUN-FILTER (Drew, 2026-07-23): strict printRun
    // match. Undefined → no filter. Number → equal. Null → unnumbered
    // only (docs where printRun is null/undefined).
    if (input.printRun !== undefined) {
      if (input.printRun === null) {
        all = all.filter((d) => d.printRun == null);
      } else {
        const wantedRun = input.printRun;
        all = all.filter((d) => d.printRun === wantedRun);
      }
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
    if (typeof input.excludeContributorUserId === "string" && input.excludeContributorUserId.length > 0) {
      // CF-SELF-COMP-THIN-POOL (Drew, 2026-08-04). Keep self-comps when
      // the surviving other-pool is thin (< 3 samples) — for rare parallels
      // the user's OWN purchase IS the market signal. Only strip them
      // when the pool has enough independent samples to stand alone.
      const excludeId = input.excludeContributorUserId;
      const others = all.filter((d) => (d as { contributorUserId?: string }).contributorUserId !== excludeId);
      if (others.length >= 3) all = others;
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

  // CF-LOWER-QUERY-ANTI-PATTERNS (Drew, 2026-07-26). Pre-lowercase
  // the parameter at the client so Cosmos doesn't LOWER(@X) per row —
  // the param is constant per query, so lowering it once here is free.
  // Still LOWER(c.playerName) per row (can't be avoided without a
  // denormalized c.playerNameLower field + backfill; deferred).
  const q = {
    query:
      "SELECT TOP @lim * FROM c WHERE LOWER(c.playerName) = @player AND c.soldAt >= @from ORDER BY c.soldAt DESC",
    parameters: [
      { name: "@lim", value: limit },
      { name: "@player", value: (input.playerName ?? "").toLowerCase() },
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
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  limit?: number;
  // CF-USER-COMPS-AUTO-FILTER + CF-USER-COMPS-PRINTRUN-FILTER (Drew,
  // 2026-07-23). Even though the slug already encodes both, callers
  // reading by slug FRAGMENTS (e.g. legacy compat paths that computed
  // the slug without printRun) can strict-narrow via these. Same
  // semantics as readCompsByCardId.
  isAuto?: boolean;
  printRun?: number | null;
  /** CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: see readCompsByCardId. */
  resolvedIdentity?: CatalogRowResolution | null;
}): Promise<SoldCompDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const hiqId = String(input.hobbyiqCardId ?? "").trim();
  if (!hiqId || !hiqId.startsWith("hiq:")) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));

  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): read under the id AND
  // the one numbered twin the resolver names — see readCompsByCardId and
  // catalogIdentityResolver.poolReadIdsFor.
  const readIds = poolReadIdsFor(hiqId, input.resolvedIdentity ?? await resolveIdentityToCatalogRow(hiqId, {
    printRun: typeof input.printRun === "number" ? input.printRun : null,
  }));
  if (readIds.length > 1) {
    console.log(JSON.stringify({
      event: "sold_comps_read_unions_numbered_twin",
      source: "soldCompsStore.readCompsByHobbyIqCardId",
      requestedCardId: hiqId,
      readCardIds: readIds,
    }));
  }
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@hiq", value: readIds[0] },
    ...(readIds.length > 1 ? [{ name: "@hiq1", value: readIds[1] }] : []),
    { name: "@from", value: from },
  ];
  const idClause = readIds.length > 1
    ? "(c.hobbyiqCardId = @hiq OR c.hobbyiqCardId = @hiq1)"
    : "c.hobbyiqCardId = @hiq";
  const query = `SELECT TOP @lim * FROM c
                 WHERE ${idClause}
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
  // CF-USER-COMPS-AUTO-FILTER + CF-USER-COMPS-PRINTRUN-FILTER (Drew,
  // 2026-07-23). Strict auto + print-run match — same rationale as the
  // primary pool query: CH cardIds mix auto + non-auto and multiple
  // print runs; without these filters, autograph FMVs get diluted by
  // base-rookie sales sharing the same cardId.
  if (input.isAuto !== undefined) {
    const wantAuto = input.isAuto === true;
    rows = rows.filter((d) => d.isAuto === wantAuto);
  }
  if (input.printRun !== undefined) {
    if (input.printRun === null) {
      rows = rows.filter((d) => d.printRun == null);
    } else {
      const wantedRun = input.printRun;
      rows = rows.filter((d) => d.printRun === wantedRun);
    }
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
  /** CF-AUTHENTIC-BUCKET: authenticated slab, no numeric grade. */
  isAuthentic?: boolean | null;
  limit?: number;
  // CF-USER-COMPS-AUTO-FILTER + CF-USER-COMPS-PRINTRUN-FILTER (Drew,
  // 2026-07-23). Same rationale as readCompsByCardId — identity fallback
  // shouldn't mix auto + non-auto or /150 + /50. Applied JS-side after
  // fetch (same shape as parallel/grade filters here).
  isAuto?: boolean;
  printRun?: number | null;
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
  //
  // CF-LOWER-QUERY-ANTI-PATTERNS (Drew, 2026-07-26). Pre-lowercase
  // @player at the client — one LOWER() call at bind time instead of
  // per-row LOWER(@player). Still LOWER(c.playerName) per row —
  // denormalizing playerName_lower is a separate PR.
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@player", value: player.toLowerCase() },
    { name: "@from", value: from },
  ];
  let query = "SELECT TOP @lim * FROM c WHERE LOWER(c.playerName) = @player AND c.soldAt >= @from";
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
    // CF-LOWER-QUERY-ANTI-PATTERNS (Drew, 2026-07-26). Cosmos SQL doesn't
    // support the JS ?? operator; the previous `LOWER(c.title ?? "")`
    // was being sent as-is and either erroring or coercing to undefined
    // (making the CONTAINS half of the OR silently dead). Cosmos LOWER
    // returns undefined for null/absent fields, which CONTAINS treats
    // as false — same semantic as `?? ""` without the syntax abuse.
    query += ' AND (LOWER(c.parallel) = @par OR CONTAINS(LOWER(c.title), @par))';
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
      // D23 ruling d: hyphen-insensitive (bd152 ≡ bd-152).
      return docCn === null || sameCardNumber(docCn, wantedCn);
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
  // CF-USER-COMPS-AUTO-FILTER + CF-USER-COMPS-PRINTRUN-FILTER (Drew,
  // 2026-07-23). Strict auto + print-run match — same rationale as the
  // primary pool query: CH cardIds mix auto + non-auto and multiple
  // print runs; without these filters, autograph FMVs get diluted by
  // base-rookie sales sharing the same cardId.
  if (input.isAuto !== undefined) {
    const wantAuto = input.isAuto === true;
    rows = rows.filter((d) => d.isAuto === wantAuto);
  }
  if (input.printRun !== undefined) {
    if (input.printRun === null) {
      rows = rows.filter((d) => d.printRun == null);
    } else {
      const wantedRun = input.printRun;
      rows = rows.filter((d) => d.printRun === wantedRun);
    }
  }
  return rows;
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
