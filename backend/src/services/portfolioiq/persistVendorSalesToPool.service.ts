// CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722). Every
// external vendor query grows sold_comps. Wraps a batch of vendor
// pricing results, parses each title via parseTitleIdentity, computes
// hobbyiqCardId, and upserts into sold_comps with contentHash dedup.
//
// Fire-and-forget by design — this service NEVER fails the caller.
// A persistence error becomes a warning log. The vendor's response
// still returns to whoever called it.
//
// Feature-flagged: PERSIST_VENDOR_LOOKUPS_ENABLED (default OFF at
// launch — flip after verification). When OFF, this is a no-op.
//
// This is the runtime instance of Drew's "we set the market" moat:
// user traffic itself grows the data pool without any explicit ingest
// scripts.

import { createHash } from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "./parseTitleIdentity.service.js";
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { parseGradeLabel } from "./gradeParser.js";

export interface VendorSaleRow {
  title: string | null;
  price: number | null | undefined;
  soldAt: string | null | undefined;       // ISO date
  url?: string | null;
  externalId?: string | null;              // vendor's ID if available; falls back to hash of url/title/price
  // CF-IMAGE-VERIFY-INGEST (Drew, 2026-07-28). Image URL from the
  // vendor's sale record. When present alongside a catalog reference
  // phash, ingest hashes and compares — mismatch routes to verify.
  imageUrl?: string | null;
}

export interface VendorPersistIdentityHint {
  playerName?: string | null;
  cardYear?: number | null;
  sport?: string | null;
  cardNumberRe?: RegExp;
  /** CF-CH-CARDID-PRESERVE (Drew, 2026-07-23). When CH provides a real
   *  cardId for the query, pass it here so persisted rows use the CH
   *  cardId as their partition key. This makes future readCompsByCardId
   *  lookups against the same CH id find these rows too — belt and
   *  suspenders alongside the hobbyiqCardId slug lookup. */
  vendorCardId?: string | null;
  /** CF-TCA-STRUCTURED-HINT (Drew, 2026-08-02). When the vendor pre-
   *  populates identity fields (TCA does on ~17% of rows via its own
   *  eBay-title matcher), pass them here so we skip the fragile
   *  parseListingIdentity title-guess step. Massively raises pass rate
   *  on TCA webhook batches — otherwise TCA titles like
   *  "2025 Bowman Chrome Junior Caminero Pulsar Refractor #/399 Rays"
   *  parse to cardNumber=null even though TCA gave us card_number=BCP-XX
   *  directly. */
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  setName?: string | null;
}

export interface VendorPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;                          // rows that couldn't be parsed to identity
}

export function isPersistVendorLookupsEnabled(): boolean {
  return process.env.PERSIST_VENDOR_LOOKUPS_ENABLED === "true";
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedContainer = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

/** Persist a batch of vendor pricing rows into sold_comps with
 *  hobbyiqCardId + contentHash dedup. Never throws — errors become
 *  warning logs and the function returns partial results. */
export async function persistVendorSalesToPool(
  source: "cardsight" | "cardhedge" | "tca-ebay",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): Promise<VendorPersistResult> {
  const result: VendorPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistVendorLookupsEnabled()) return result;
  if (!Array.isArray(rows) || rows.length === 0) return result;
  const container = await getSoldCompsContainer();
  if (!container) return result;

  for (const row of rows) {
    const title = String(row.title ?? "").trim();
    const price = Number(row.price);
    const soldAt = String(row.soldAt ?? "").trim();
    if (!title || !Number.isFinite(price) || price <= 0 || !soldAt) {
      result.skipped++;
      continue;
    }
    // CF-TCA-STRUCTURED-HINT (Drew, 2026-08-02): identity hint fields
    // (cardNumber / parallel / isAuto / printRun / setName) take priority
    // over the title-guess fallback. When the vendor pre-populated
    // structured identity (TCA gives us these on ~17% of rows), we skip
    // the fragile parseListingIdentity call for the corresponding field.
    const parsed = parseListingIdentity(title, identity.cardNumberRe);
    const cardNumber = identity.cardNumber ?? parsed.cardNumber;
    if (!cardNumber) { result.skipped++; continue; }
    // Rebind parsed so downstream code uses the hint values.
    parsed.cardNumber = cardNumber;
    if (identity.parallel !== undefined && identity.parallel !== null) parsed.parallel = identity.parallel;
    if (identity.isAuto !== undefined && identity.isAuto !== null) parsed.isAuto = identity.isAuto;
    if (identity.printRun !== undefined && identity.printRun !== null) parsed.printRun = identity.printRun;
    const cardYear = identity.cardYear ?? guessCardYearFromTitle(title);
    if (!cardYear) { result.skipped++; continue; }
    const playerName = identity.playerName ?? guessPlayerFromTitle(title);
    if (!playerName) { result.skipped++; continue; }
    const setKey = identity.setName ?? inferSetKeyFromTitle(title);
    const sport = identity.sport ?? inferSportFromTitle(title);
    let slug: string;
    try {
      slug = computeHobbyIqCardId({
        sport,
        year: cardYear,
        setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
      });
    } catch {
      result.skipped++;
      continue;
    }
    const contentHash = createHash("sha256").update(
      `${slug}|${price.toFixed(2)}|${soldAt.slice(0, 10)}|${source}|${row.url ?? ""}`,
    ).digest("hex").slice(0, 32);

    // CF-COMPS-STAGING-SHIM-EARLY (Drew, 2026-07-28). Staging is the
    // immutable landing zone — it must receive EVERY vendor record
    // we're offered, including ones that dedup against sold_comps.
    // Placed before the sold_comps dedup check so provenance is
    // preserved regardless of downstream state.
    //
    // Fire-and-forget: never blocks the pool write or delays it.
    // Gated on COMPS_STAGING_SHIM_ENABLED so the code is dormant
    // during initial rollout.
    if (process.env.COMPS_STAGING_SHIM_ENABLED === "true") {
      void (async () => {
        try {
          const { stageIngestedComp, computeStagingContentHash } = await import("./compsStaging.service.js");
          let mirroredImage;
          if (row.imageUrl && process.env.COMPS_STAGING_MIRROR_ENABLED === "true") {
            try {
              const { mirrorVendorImage } = await import("./imageMirror.service.js");
              const mirror = await mirrorVendorImage(String(row.imageUrl), `${slug.slice(4)}-${contentHash.slice(0, 8)}`);
              mirroredImage = mirror.ok ? {
                blobUrl: mirror.image.blobUrl,
                contentHash: mirror.image.contentHash,
                size: mirror.image.size,
                contentType: mirror.image.contentType,
                mirroredAt: mirror.image.mirroredAt,
              } : {
                blobUrl: "",
                contentHash: "",
                size: 0,
                contentType: "",
                mirroredAt: new Date().toISOString(),
                mirrorError: { reason: mirror.reason, detail: mirror.detail },
              };
            } catch { /* mirror is optional */ }
          }
          const stagingContentHash = computeStagingContentHash({
            cardYear,
            cardNumber: parsed.cardNumber,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto,
            price,
            soldAt: new Date(soldAt).toISOString(),
          });
          await stageIngestedComp({
            hobbyiqCardId: slug,
            raw: {
              vendor: source,
              vendorRawId: row.externalId ?? identity.vendorCardId ?? null,
              vendorPayload: {
                title,
                price,
                soldAt: new Date(soldAt).toISOString(),
                url: row.url ?? null,
                imageUrl: row.imageUrl ?? null,
                externalId: row.externalId ?? null,
              },
              identityHint: {
                playerName,
                cardYear,
                sport,
                vendorCardId: identity.vendorCardId ?? null,
              },
              fetchedAt: new Date().toISOString(),
              contentHash: stagingContentHash,
            },
            mirroredImage,
          });
        } catch { /* staging shim never blocks the pool write */ }
      })();
    }

    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch",
        parameters: [{ name: "@hiq", value: slug }, { name: "@ch", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }

      // CF-VERIFY-PARSER-LOW-CONFIDENCE (Drew, 2026-07-28). See
      // parserSuspicionDetector for the rule + rationale.
      const { isParserProbablyWrong } = await import("./parserSuspicionDetector.js");
      if (isParserProbablyWrong({ parsedParallel: parsed.parallel, title })) {
        try {
          const { enqueueForVerify } = await import("./verifyQueue.service.js");
          await enqueueForVerify({
            reason: "parser-low-confidence",
            saleInput: {
              cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
              playerName,
              cardYear,
              setName: setKey,
              parallel: parsed.parallel,
              cardNumber: parsed.cardNumber,
              isAuto: parsed.isAuto,
              gradeCompany: null,
              gradeValue: null,
              price,
              soldAt: new Date(soldAt).toISOString(),
              source,
              sourceExternalId: row.externalId ?? null,
              title,
              imageUrl: null,
              sellerHandle: null,
              sport,
              verifiedByUser: false,
              confidence: 0.3,
            },
            signal: {
              parserConfidence: 0.4,
              note: `parser tagged Base but title carries a color word + parallel-adjacent context — probable miss`,
            },
          });
          result.skipped++;
          continue;
        } catch {
          // Non-fatal — fall through and persist as Base.
        }
      }

      // CF-VERIFY-SAMPLE-AUDIT (Drew, 2026-07-28). Random 0.5%
      // (env-tunable) of ingests get enqueued regardless of any signal
      // so Drew can spot-check the base rate of ingest quality —
      // the number he calls when he says "we're 99.9% accurate."
      // Sampling is bounded so the queue never becomes noise.
      const sampleRate = Number(process.env.VERIFY_SAMPLE_AUDIT_RATE ?? "0.005");
      if (Number.isFinite(sampleRate) && sampleRate > 0 && Math.random() < sampleRate) {
        try {
          const { enqueueForVerify } = await import("./verifyQueue.service.js");
          await enqueueForVerify({
            reason: "sample-audit",
            saleInput: {
              cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
              playerName,
              cardYear,
              setName: setKey,
              parallel: parsed.parallel,
              cardNumber: parsed.cardNumber,
              isAuto: parsed.isAuto,
              gradeCompany: null,
              gradeValue: null,
              price,
              soldAt: new Date(soldAt).toISOString(),
              source,
              sourceExternalId: row.externalId ?? null,
              title,
              imageUrl: null,
              sellerHandle: null,
              sport,
              verifiedByUser: false,
              confidence: 0.7,
            },
            signal: { note: `random ${(sampleRate * 100).toFixed(2)}% sample for statistical accuracy audit` },
          });
          // Fall through — sample-audit does NOT block the persist.
          // The sample sits in verify_queue for review AND the row
          // still lands in sold_comps so the pool stays complete.
        } catch {
          // Non-fatal
        }
      }

      // CF-VERIFY-QUEUE-PRICE-OUTLIER (Drew, 2026-07-28). Before we
      // commit this sale to the pool, sanity-check against the
      // rolling 30d median for the same slug. If we're >3× median or
      // <1/3× median AND the slug already has ≥5 comps for context,
      // divert to verify_queue instead of poisoning the pool. Cheap:
      // single indexed query on hobbyiqCardId.
      try {
        const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { resources: rollingRows } = await container.items.query<{ price: number }>({
          query: "SELECT c.price FROM c WHERE c.hobbyiqCardId = @hiq AND c.soldAt >= @cutoff",
          parameters: [{ name: "@hiq", value: slug }, { name: "@cutoff", value: rollingCutoff }],
        }).fetchAll();
        if (rollingRows.length >= 5) {
          const prices = rollingRows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
          if (prices.length >= 5) {
            const rollingMedian = prices[Math.floor(prices.length / 2)];
            const ratio = price / rollingMedian;
            if (ratio > 3 || ratio < (1 / 3)) {
              const { enqueueForVerify } = await import("./verifyQueue.service.js");
              await enqueueForVerify({
                reason: "price-outlier",
                saleInput: {
                  cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
                  playerName,
                  cardYear,
                  setName: setKey,
                  parallel: parsed.parallel,
                  cardNumber: parsed.cardNumber,
                  isAuto: parsed.isAuto,
                  gradeCompany: null,
                  gradeValue: null,
                  price,
                  soldAt: new Date(soldAt).toISOString(),
                  source,
                  sourceExternalId: row.externalId ?? null,
                  title,
                  imageUrl: null,
                  sellerHandle: null,
                  sport,
                  verifiedByUser: false,
                  confidence: 0.3,
                },
                signal: { rollingMedian, ratio, note: `${ratio > 3 ? "high" : "low"}-outlier vs 30d median ($${rollingMedian.toFixed(2)}, n=${prices.length})` },
              });
              result.skipped++;
              continue;
            }
          }
        }
      } catch {
        // Detector failure is non-fatal — fall through and persist.
      }

      // CF-IMAGE-VERIFY-INGEST (Drew, 2026-07-28). If we have both an
      // ingest image URL AND a catalog reference with a pHash, compare
      // — mismatch (Hamming distance > threshold) routes to
      // verify_queue with reason="cross-source-mismatch". The comp
      // still persists — user gets the pricing signal AND the queue
      // gets a triage row so the ingest classification can be audited.
      // Feature-flagged: IMAGE_VERIFY_ENABLED (off by default until
      // catalog phash coverage lands).
      if (process.env.IMAGE_VERIFY_ENABLED === "true" && row.url && row.imageUrl) {
        try {
          const { getCatalogEntry } = await import("./cardCatalog.service.js");
          const catalogEntry = await getCatalogEntry(slug);
          const refPhash = catalogEntry?.referenceImage?.phash;
          if (refPhash) {
            const { computeImageHash, classifyImageMatch } = await import("./imageVerify.service.js");
            const ingestPhash = await computeImageHash(String(row.imageUrl));
            if (ingestPhash) {
              const classification = classifyImageMatch(refPhash, ingestPhash);
              if (classification.verdict === "mismatch") {
                const { enqueueForVerify } = await import("./verifyQueue.service.js");
                await enqueueForVerify({
                  reason: "image-mismatch",
                  saleInput: {
                    cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
                    playerName,
                    cardYear,
                    setName: setKey,
                    parallel: parsed.parallel,
                    cardNumber: parsed.cardNumber,
                    isAuto: parsed.isAuto,
                    gradeCompany: null,
                    gradeValue: null,
                    price,
                    soldAt: new Date(soldAt).toISOString(),
                    source,
                    sourceExternalId: row.externalId ?? null,
                    title,
                    imageUrl: String(row.imageUrl),
                    sellerHandle: null,
                    sport,
                    verifiedByUser: false,
                    confidence: 0.3,
                  },
                  signal: {
                    note: `image mismatch vs catalog reference (distance=${classification.distance}, similarity=${classification.similarity?.toFixed(3)}) — probable classification error`,
                  },
                });
              }
            }
          }
        } catch {
          // Image-verify failures never block the persist path.
        }
      }

      const sourceExternalId = row.externalId
        ?? (row.url ? createHash("sha256").update(source + ":" + row.url).digest("hex").slice(0, 24)
                    : createHash("sha256").update(source + ":" + title + price + soldAt).digest("hex").slice(0, 24));
      // CF-GRADE-QUALIFIER (Drew, 2026-07-23, issue #713 phase 2):
      // opportunistically extract grade + qualifier from the title.
      // parseGradeLabel returns null on unparseable titles, which we
      // treat as "raw / grade unknown" — the sold_comps schema tolerates
      // null gradeCompany.
      const gradeParsed = parseGradeLabel(title);
      const doc = {
        id: `${source}::${sourceExternalId}`,
        // Prefer the vendor's real cardId when known (CH path) so the
        // vendor-cardId lookup finds these rows too. Fall back to the
        // hobbyiqCardId-derived pseudo-cardId (Cardsight-search path
        // where no stable cardId exists).
        cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
        hobbyiqCardId: slug,
        contentHash,
        playerName,
        cardYear,
        setName: setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
        autoStyle: parsed.autoStyle,
        gradeCompany: gradeParsed?.gradeCompany ?? null,
        gradeValue: gradeParsed?.gradeValue ?? null,
        gradeQualifier: gradeParsed?.qualifier ?? null,
        price,
        soldAt: new Date(soldAt).toISOString(),
        source,
        sourceExternalId,
        title,
        url: row.url ?? null,
        observedAt: new Date().toISOString(),
        sport,
      };
      // CF-STAGING-CUTOVER (Drew, 2026-07-28). When cutover is on,
      // vendor ingest ONLY writes to comps_staging (the shim above
      // fires unconditionally). sold_comps writes come from the
      // promotion job that reads staging + applies verification
      // lineage. Legacy pool stays untouched — every new comp earns
      // its way in.
      //
      // Flag-gated so the cutover can be flipped without a redeploy
      // if the promotion job falls behind or a bug surfaces.
      if (process.env.COMPS_STAGING_CUTOVER_ENABLED === "true") {
        // Skip the direct sold_comps write. Staging shim already
        // fired above the dedup check, so the record is captured.
        result.skipped++;
        continue;
      }

      await container.items.upsert(doc);
      result.inserted++;
      // Staging shim runs earlier (above the dedup check) so it fires
      // regardless of whether sold_comps dedups the write. See
      // CF-COMPS-STAGING-SHIM-EARLY.
    } catch (err) {
      console.warn(JSON.stringify({
        event: "persist_vendor_sales_error",
        source: "persistVendorSalesToPool",
        vendorSource: source,
        slug,
        error: (err as Error)?.message ?? String(err),
      }));
      result.skipped++;
    }
  }
  if (result.inserted > 0 || result.deduped > 0) {
    console.log(JSON.stringify({
      event: "persist_vendor_sales",
      source: "persistVendorSalesToPool",
      vendorSource: source,
      inserted: result.inserted,
      deduped: result.deduped,
      skipped: result.skipped,
    }));
  }
  return result;
}

/** Fire-and-forget wrapper. Use this from vendor client wrappers so
 *  callers don't have to await persistence. Silences errors internally. */
export function persistVendorSalesInBackground(
  source: "cardsight" | "cardhedge" | "tca-ebay",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): void {
  persistVendorSalesToPool(source, rows, identity).catch((err) => {
    console.warn(JSON.stringify({
      event: "persist_vendor_sales_background_error",
      source: "persistVendorSalesInBackground",
      error: (err as Error)?.message ?? String(err),
    }));
  });
}

/** Best-effort year extraction from a title. Recognizes leading 4-digit
 *  year (2015-2027 range). Returns null when nothing plausible found. */
function guessCardYearFromTitle(title: string): number | null {
  const m = title.match(/\b(20\d{2})\b/);
  if (m) {
    const y = Number(m[1]);
    if (y >= 2000 && y <= 2030) return y;
  }
  return null;
}

/** Best-effort player-name guess: strip year, set words, common noise,
 *  return the first sequence that looks like a name. Returns null when
 *  no confident match. Callers should prefer passing playerName in the
 *  identity hint. */
function guessPlayerFromTitle(_title: string): string | null {
  // Defensive default — the ingest paths that use this will always pass
  // playerName via identity hint (they're driven by known player queries).
  // Free-form guessing is out of scope for this PR; return null so we
  // skip the row rather than write bad identity.
  return null;
}
