// CF-EBAY-AUTO-HOLDING (2026-07-12, Drew — scope 3 followup).
//
// Bridge from parsed eBay listing title → real PortfolioHolding row on the
// user doc. Pure mutator: caller (import route OR backfill route) passes
// the user doc + a purchase entry, we parse the purchase.notes (which the
// import service stored as the listing title), and if parseConfidence
// ≥ 0.70 we mutate the doc:
//   1. Create a new PortfolioHolding row
//   2. Append the holding's id to the parent purchase's holdingIds[]
//
// The caller is responsible for writeUserDoc() after batching. Never
// creates a holding if the purchase already has holdingIds populated
// (idempotent — safe to re-run after a partial write).
//
// The generated holding carries:
//   source: "ebay-auto"          (distinguishes from manual holdings)
//   sourcePurchaseId: purchase.id (back-reference for cost-basis audit)
//   parseConfidence: number      (0.70-1.00; iOS renders a badge for <0.90)
//   needsReview: boolean         (true when confidence < 0.90)
//
// All three fields are ADDITIVE — existing consumers see them via
// (h as any).sourcePurchaseId etc. and don't need type changes to
// keep working.

import { randomUUID } from "node:crypto";
import type {
  PortfolioHolding,
} from "../../types/portfolioiq.types.js";
import {
  parseListingTitle,
  type ParsedListingTitle,
} from "./ebayTitleParser.service.js";
import type {
  PortfolioPurchaseEntry,
} from "./portfolioStore.service.js";
import type { EbayItemDetails } from "../ebay/ebayItemDetails.service.js";
// CF-ASPECT-IS-NOT-A-PARALLEL: the normalizer is the single place that knows
// which strings are real parallels, so the aspect is vetted through it rather
// than against a second, drifting list here.
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";

/**
 * Threshold at which we auto-create a holding from a purchase.
 * Confidence must be ≥ this value; below it we either flag needsAttribution
 * (0.40-0.69) or skip entirely (<0.40).
 */
export const AUTO_CREATE_CONFIDENCE_THRESHOLD = 0.7;
/** Below this the parse is too uncertain to even flag. */
export const NEEDS_ATTRIBUTION_MIN = 0.4;
/** Confidence below this on an auto-created holding triggers iOS's "review" badge. */
export const NEEDS_REVIEW_MAX = 0.9;

export type AutoHoldingResult =
  | { status: "created"; holding: PortfolioHolding; parsed: ParsedListingTitle; enriched: boolean }
  | { status: "needs-attribution"; parsed: ParsedListingTitle }
  | { status: "skipped-low-confidence"; parsed: ParsedListingTitle }
  | { status: "skipped-already-linked"; parsed: ParsedListingTitle }
  | { status: "skipped-sealed-or-break"; parsed: ParsedListingTitle };

/** Object with a mutable holdings map + purchases array. Kept loose so this
 *  service doesn't depend on the private UserDoc type in portfolioStore. */
export interface AutoHoldingDocShape {
  holdings: Record<string, PortfolioHolding>;
  purchases?: PortfolioPurchaseEntry[];
}

/**
 * Try to auto-create a holding for a single purchase. Mutates `doc` in place
 * when it does (or when it links to an existing holding). NEVER writes to
 * Cosmos itself — caller batches and writes once.
 *
 * When `details` is provided (from a Browse API prefetch), Browse-side data
 * is merged AUTHORITATIVELY over the title-parse for grader/grade/aspects/
 * images. Absent `details` → title-parse only (current-day behavior).
 */
// Async since CF-EBAY-MATCH-CATALOG-AT-INGEST: the catalog match is a Cosmos
// read, so matching at import time makes this awaitable. Sole caller is
// ebayBuyerHistory.service, already inside an async loop.
export async function autoCreateHoldingForPurchase(
  doc: AutoHoldingDocShape,
  purchase: PortfolioPurchaseEntry,
  details?: EbayItemDetails | null,
): Promise<AutoHoldingResult> {
  if (purchase.holdingIds.length > 0) {
    return {
      status: "skipped-already-linked",
      parsed: parseListingTitle(purchase.notes ?? ""),
    };
  }
  // CF-DEDUP-SOURCE-PURCHASE (Drew, 2026-08-03). Belt-and-suspenders
  // against duplicate holdings: even if purchase.holdingIds is empty,
  // scan doc.holdings for one already tagged sourcePurchaseId ===
  // purchase.id. That case happens when a prior batch created the
  // holding but the purchase.holdingIds write was lost to a partial
  // update. Re-linking the existing holding is idempotent; creating a
  // second one would double-book cost.
  for (const h of Object.values(doc.holdings ?? {})) {
    if ((h as { sourcePurchaseId?: string }).sourcePurchaseId === purchase.id) {
      purchase.holdingIds = [...new Set([...purchase.holdingIds, (h as { id: string }).id])];
      return {
        status: "skipped-already-linked",
        parsed: parseListingTitle(purchase.notes ?? ""),
      };
    }
  }
  const parsed = parseListingTitle(purchase.notes ?? "");

  // CF-CARDS-ONLY-FILTER (Drew, 2026-08-03). Portfolio holdings are
  // CARDS only — reject sealed products, box breaks, memorabilia,
  // apparel, and supplies. Two-part filter:
  //   1. No playerName parsed → not a card (breaks and sealed boxes)
  //   2. Title matches a non-card word list → apparel/supplies/memorabilia
  //      (even if a player name got parsed, e.g. "Aaron Judge signed hat")
  // User still has the purchase record for cost tracking; nothing lands
  // in inventory. Extend the regex when we see a new non-card pattern
  // slip through — cheaper to be aggressive here than to clean up
  // orphan holdings later.
  const title = String(purchase.notes ?? "").toLowerCase();
  const isSealedOrBreak =
    /\bbreak\b|\brandom\s+(team|div|hit|slot|player)|\bteam\s+(spot|slot|break)|\bhobby\s+box|\bjumbo\s+box|\bmega\s+box|\bblaster|\bhanger\s+box|\bretail\s+box|\bpyt\b|\bpick\s+your\s+team|\bteam\s+random|\(b\d+\)|\bbox\s+break|\bcase\s+break|\bpersonal\s+break|\bhobby\s+case|\bfactory\s+sealed\s+box|\bwax\s+box|\bcello\s+pack|\bfat\s+pack|\bvalue\s+pack/i.test(title);
  const isMemorabiliaOrSupply =
    /\b(hat|cap|jersey|jerseys|t\s?-?\s?shirt|hoodie|sweatshirt|sweater|pants|shorts|shoe|shoes|sneaker|sneakers|helmet|glove|gloves|bat|ball(?!\s+(rookie|card))|puck|photo\s+print|poster|banner|flag|mug|cup|coin|patch|pin\b|button|bobblehead|figure|figurine|statue|replica|ring|chain|necklace|pendant|watch|bag|backpack|wallet|mask|towel|blanket|pillow|magnet(?!ic)|sticker|decal|keychain|keyring|lanyard|autographed\s+(jersey|hat|cap|bat|ball|helmet|photo|poster|puck))\b/i.test(title);
  const isSupply =
    /\b(top\s?-?loader|toploader|penny\s+sleeve|penny\s+sleeves|team\s+bag|team\s+bags|semi\s?-?rigid|semirigid|magnetic\s+(holder|case)|one\s?-?touch|screwdown|screw\s+down|card\s+saver|card\s+savers|binder|album|storage\s+box|monster\s+box|card\s+sleeve|card\s+sleeves|ultra\s+pro|ultrapro|display\s+case|display\s+stand|graded\s+slab\s+case|grading\s+kit|deck\s+box)\b/i.test(title);
  if (!parsed.playerName || isSealedOrBreak || isMemorabiliaOrSupply || isSupply) {
    return { status: "skipped-sealed-or-break", parsed };
  }

  // CF-EBAY-IMPORT-FORCE-REVIEW (Drew, 2026-08-03). "We need to do
  // matches before going into inventory" — when
  // EBAY_IMPORT_FORCE_REVIEW=true, every purchase with confidence
  // >= NEEDS_ATTRIBUTION_MIN gets a holding CREATED with
  // cardStatus="pending-review" (the existing review-queue lane).
  // The user confirms via POST /erp/holdings/:id/confirm before it
  // becomes active. The AUTO_CREATE_CONFIDENCE_THRESHOLD gate is
  // bypassed so lower-confidence-but-parseable rows also become
  // pending-review holdings for the user to correct.
  const forceReview = process.env.EBAY_IMPORT_FORCE_REVIEW === "true";
  const effectiveThreshold = forceReview
    ? NEEDS_ATTRIBUTION_MIN
    : AUTO_CREATE_CONFIDENCE_THRESHOLD;
  if (parsed.parseConfidence < effectiveThreshold) {
    if (parsed.parseConfidence >= NEEDS_ATTRIBUTION_MIN) {
      return { status: "needs-attribution", parsed };
    }
    return { status: "skipped-low-confidence", parsed };
  }

  const holding = buildHoldingFromParse(purchase, parsed);
  if (details) applyBrowseEnrichment(holding, details);

  // CF-EBAY-MATCH-CATALOG-AT-INGEST (Drew, 2026-08-13: "I want ebay to match to
  // the card catalog immediately... and we can approve it once ingested in the
  // ebay tab").
  //
  // This path built a holding from the parsed title and seeded a NEW catalog
  // row from eBay's aspects, but never asked whether we ALREADY hold that card
  // in the checklist. Nothing looked, so every imported holding rendered
  // "MISSING / VALUE —" with a Fix-identity link, even for cards whose
  // checklist row and comps we have.
  //
  // Match against the catalog here, at ingest. The holding still lands as
  // pending-review under EBAY_IMPORT_FORCE_REVIEW — the match is a PROPOSAL
  // the user approves in the eBay tab, not an auto-commit. That distinction
  // matters: title parsing is lossy, and a loose match is confidently wrong in
  // a way the user cannot see. Probed against prod on 2026-08-13, free-text
  // matching returned "2018 Topps Chrome Update Ohtani" as topps-HERITAGE #20
  // and "2017 Bowman ROYF-9 Judge" as bowman #1 — right player, wrong card.
  //
  // canonicalize() is the strict matcher (exact identity → 0.98, degrading to
  // 0.3 for speculative), so the confidence it returns is what the review UI
  // should sort and colour by. Only a strong match pins cardId; a weak one is
  // recorded for the reviewer without steering pricing.
  try {
    const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
    const h = holding as Record<string, unknown>;
    const match = await canonicalize({
      sport: String(h.sport ?? "baseball"),
      year: typeof h.cardYear === "number" ? h.cardYear : null,
      setName: String(h.setName ?? h.product ?? ""),
      cardNumber: String(h.cardNumber ?? ""),
      parallel: String(h.parallel ?? "") || null,
      isAuto: Boolean(h.isAuto),
      playerName: String(h.playerName ?? ""),
      // CF-THE-USER-SEED-EXEMPTION-WAS-NEVER-REACHED (Drew, 2026-08-25: "when
      // we buy from ebay and they aren't in our existing sold comps. It needs
      // to create the sold comp. It is truly a comp DIRECTLY from ebay").
      //
      // This passed "ebay-title", which is a VENDOR source. Under
      // CATALOG_MATCH_ONLY_ENABLED the matcher returns early for vendor
      // sources with found:false, confidence:0.3 -- so a card the user
      // physically owns could never seed a catalog row, and the whole chain
      // downstream of it died:
      //
      //   no catalog row  ->  confidence 0.3 never clears the 0.9 pin bar
      //                   ->  holding.cardId never set
      //                   ->  "We could not identify this card"
      //                   ->  confirmHoldingReview gates its comp emit on
      //                       cardId, so NO COMP WAS EVER EMITTED
      //
      // USER_SEED_ALLOWED_SOURCES and TRUSTED_SOURCES both already name
      // "ebay-user-purchase", the sold-comp source enum already has it, and
      // soldCompsStore was built for precisely this. Every piece was in place
      // and unreachable because the caller announced itself as a vendor.
      //
      // The user owns the physical card; that is the whole basis of the
      // exemption. Seeds land confidence 0.6 / verificationStatus
      // pending-review, below the 0.9 pin bar, so this creates the row without
      // steering pricing -- then confirm re-matches as "user-verified", finds
      // the now-existing row exactly, pins it, and the comp emits.
      source: "ebay-user-purchase",
    } as never);

    if (match) {
      h.catalogMatchConfidence = match.confidence;
      h.catalogMatchedBy = match.matchedBy ?? null;
      h.catalogMatchSlug = match.slug ?? null;
      // Pin the identity only when the matcher is confident. Below that the
      // slug is a suggestion for the reviewer — pinning it would send pricing
      // to the wrong card while still showing a value, which reads as correct.
      if (match.found && match.slug && match.confidence >= 0.9) {
        h.cardId = match.slug;
      }

      // CF-EBAY-MISS-SEEDS-CHECKLIST (Drew, 2026-08-13: "we should get those
      // checklists if we are missing them").
      //
      // A miss on a card the user demonstrably owns is the strongest possible
      // signal that a checklist is worth building — they paid for it. Record it
      // so the gap becomes a work order instead of a permanently unmatched
      // holding. Deduped per release by checklistSeedQueue, so a 200-card
      // import files one order per set, not 200.
      //
      // Real misses this fires on, from Drew's own portfolio: 2017 Topps Gold
      // Label, 2020 Bowman Draft (BD152), 2022 Topps Chrome image variations.
      if (!match.found) {
        const { requestChecklistSeed } = await import("../catalog/checklistSeedQueue.service.js");
        const { normalizeSetKey } = await import("./hobbyIqCardId.service.js");
        const setNameForSeed = String(h.setName ?? h.product ?? "").trim();
        if (setNameForSeed && typeof h.cardYear === "number") {
          await requestChecklistSeed({
            sport: String(h.sport ?? "baseball"),
            year: h.cardYear,
            setName: setNameForSeed,
            setKey: normalizeSetKey(setNameForSeed),
            reason: "ebay-import-unmatched",
            missingPlayer: String(h.playerName ?? "") || undefined,
            missingCardNumber: String(h.cardNumber ?? "") || undefined,
          });
        }
      }
    }
  } catch (err) {
    // Never block an import on the matcher — the holding still lands for
    // review, exactly as before.
    console.warn(JSON.stringify({
      event: "ebay_import_catalog_match_failed",
      source: "ebayAutoHolding.service",
      error: (err as Error)?.message ?? String(err),
    }));
  }

  // CF-A-REAL-SALE-IS-IN-THE-POOL-ONCE (Drew, 2026-08-29, checklist D7a):
  // "these are real sales, so we need to treat them as such but ensure there
  // aren't duplicates in the system." The eBay ids travel onto the holding
  // (they used to live only on the purchase entry, so every later comp path
  // fell back to a holding:: key and could never dedupe by eBay id), and the
  // purchase is written to the pool NOW through the one writer -- keyed by
  // the eBay order line item id (else the item id), filed under the same
  // checklist slug the holding was just pinned to. recordSoldComp dedupes on
  // id and on content hash and returns the row's id; the holding links to it.
  {
    const h = holding as Record<string, unknown>;
    if (purchase.ebayItemId) h.ebayItemId = purchase.ebayItemId;
    if (purchase.ebayOrderId) h.ebayOrderId = purchase.ebayOrderId;
    const slug = typeof h.cardId === "string" && h.cardId.startsWith("hiq:") ? h.cardId : null;
    const price = typeof h.purchasePrice === "number" ? h.purchasePrice : Number(h.purchasePrice ?? 0);
    const soldAt = String(h.purchaseDate ?? purchase.purchaseDate ?? "");
    if (slug && price > 0 && soldAt && String(h.playerName ?? "").trim()) {
      try {
        const { recordSoldComp } = await import("./soldCompsStore.service.js");
        const res = await recordSoldComp({
          cardId: slug,
          playerName: String(h.playerName),
          cardYear: typeof h.cardYear === "number" ? h.cardYear : null,
          setName: (h.setName as string | null) ?? null,
          parallel: (h.parallel as string | null) ?? null,
          cardNumber: (h.cardNumber as string | null) ?? null,
          isAuto: h.isAuto === true,
          gradeCompany: (h.gradeCompany as string | null) ?? null,
          gradeValue: (h.gradeValue as number | null) ?? null,
          sport: (h.sport as string | null) ?? null,
          price,
          soldAt,
          source: "ebay-user-purchase",
          sourceExternalId: purchase.ebayOrderId ?? purchase.ebayItemId ?? null,
          contributorUserId: ((doc as { userId?: string }).userId ?? null) as string | null,
          title: String(purchase.notes ?? "") || null,
          imageUrl: (h.ebayImageUrl as string | null) ?? null,
          sellerHandle: null,
          verifiedByUser: false,
          confidence: Number(h.parseConfidence ?? 0.7),
        } as never);
        if (res?.written) {
          h.soldCompId = res.id ?? null;
          h.soldCompDeduped = res.deduped === true;
          if (res.hobbyiqCardId) h.soldCompSlug = res.hobbyiqCardId;
        }
        console.log(JSON.stringify({
          event: "ebay_import_sale_recorded",
          source: "ebayAutoHolding.service",
          holdingId: holding.id,
          slug,
          sourceExternalId: purchase.ebayOrderId ?? purchase.ebayItemId ?? null,
          written: res?.written ?? false,
          deduped: res?.deduped ?? false,
          reason: res?.reason ?? null,
        }));
      } catch (err) {
        console.warn(JSON.stringify({
          event: "ebay_import_sale_record_failed",
          source: "ebayAutoHolding.service",
          holdingId: holding.id,
          error: (err as Error)?.message ?? String(err),
        }));
      }
    }
  }

  doc.holdings[holding.id] = holding;
  // Idempotent Set-union merge, symmetric with PATCH /link-holdings.
  const merged = new Set([...purchase.holdingIds, holding.id]);
  purchase.holdingIds = [...merged];

  // CF-EBAY-BROWSE-CATALOG-SEED (Drew, 2026-08-03). When eBay Browse
  // returned item-specifics for this purchase, upsert a catalog row
  // with source='ebay-browse'. eBay's official aspects (Year, Set,
  // Player, Card Number, Grade, Parallel) are high-signal because
  // sellers explicitly tagged them at listing time. Grows the owned
  // catalog with every user purchase we import. Deterministic id per
  // (player, year, set, cardNumber, parallel, isAuto) tuple.
  if (details) {
    void (async () => {
      try {
        const { createHash } = await import("crypto");
        const holdingAny = holding as Record<string, unknown>;
        const player = String(holdingAny.playerName ?? "").trim();
        const year = typeof holdingAny.cardYear === "number" ? holdingAny.cardYear : null;
        const setName = String(holdingAny.setName ?? holdingAny.product ?? "").trim();
        const cardNumber = String(holdingAny.cardNumber ?? "").trim();
        const parallel = String(holdingAny.parallel ?? "base").toLowerCase().trim();
        const isAuto = Boolean(holdingAny.isAuto);
        const sport = String(holdingAny.sport ?? "").toLowerCase().trim() || "baseball";
        if (!player || !year || !setName || !cardNumber) return;
        const SPORT_WORDS_RX = /\s+(baseball|basketball|football|hockey|soccer|golf)(\s|$)/gi;
        const YEAR_PREFIX_RX = /^(19|20)\d{2}(-\d{2})?\s+/;
        const normalizeSetKeyFn = (raw: string) => {
          let s = String(raw ?? "").toLowerCase().trim();
          if (!s) return "";
          s = s.replace(YEAR_PREFIX_RX, "").trim();
          s = s.replace(SPORT_WORDS_RX, " ").trim();
          return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
        };
        const tupleKey = [sport, year, normalizeSetKeyFn(setName), cardNumber.toLowerCase(), parallel, isAuto ? "auto" : "no-auto", player.toLowerCase()].join("|");
        const catId = "ebay-browse:" + createHash("sha256").update(tupleKey).digest("hex").slice(0, 20);
        const { CosmosClient } = await import("@azure/cosmos");
        const conn = process.env.COSMOS_CONNECTION_STRING;
        if (!conn) return;
        const cat = new CosmosClient(conn)
          .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
          .container("card_catalog");
        await cat.items.upsert({
          id: catId,
          player, year, number: cardNumber,
          setKey: normalizeSetKeyFn(setName),
          setName,
          sport,
          parallel,
          parallels: parallel && parallel !== "base" ? [{ name: parallel }] : [],
          isAuto,
          source: "ebay-browse",
          confidence: 0.92, // eBay official item-specifics — high signal
          ebayItemId: (holdingAny.ebayItemId as string) ?? null,
          seededAt: new Date().toISOString(),
        });
      } catch { /* soft — catalog seeding is nice-to-have */ }
    })();
  }

  return { status: "created", holding, parsed, enriched: !!details };
}

// ─── Holding construction ──────────────────────────────────────────────────

function buildHoldingFromParse(
  purchase: PortfolioPurchaseEntry,
  parsed: ParsedListingTitle,
): PortfolioHolding & Record<string, unknown> {
  // Per-item cost: split the full totalCost across the eBay Quantity. For
  // single-item transactions (most eBay purchases of individual cards),
  // quantity = 1 and this collapses to purchase.totalCost.
  //
  // We don't preserve tax/shipping breakdown on the holding — the source
  // purchase already carries those, and the auto-created holding's
  // totalCostBasis is the all-in per-unit cost for realized-P&L math.
  const perItemAllIn = purchase.totalCost;

  const cardTitle = buildCardTitle(parsed);
  const gradeValue = parsed.grade ? extractGradeValue(parsed.grade) : undefined;

  // We build with `as any` for the ebay-auto specific fields since the
  // PortfolioHolding interface doesn't declare them yet — additive
  // schema, existing readers unaffected.
  const holding: PortfolioHolding & Record<string, unknown> = {
    id: randomUUID(),
    quantity: 1,
    purchasePrice: perItemAllIn,
    totalCostBasis: perItemAllIn,
    purchaseDate: purchase.purchaseDate,
    lastUpdated: new Date().toISOString(),
    notes: `Auto-imported from eBay purchase (confidence ${parsed.parseConfidence.toFixed(2)})`,
    // Vendor becomes purchaseSource so downstream "where did this come
    // from" reads work without a join.
    purchaseSource: `ebay:${purchase.vendor ?? "unknown"}`,
    // Additive fields NOT declared on the PortfolioHolding interface —
    // written via the Record<string, unknown> escape hatch so we don't
    // need a type migration to ship the ebay-auto marker set.
    addedAt: purchase.purchaseDate,
    // CF-EBAY-REVIEW-QUEUE (2026-07-12): auto-imports land in the review
    // queue, not live inventory. The user confirms each row (with any
    // corrections) via POST /erp/holdings/:id/confirm before it becomes
    // active. This is the trust boundary: parser + Browse are best-effort,
    // the user is ground truth. Corrections train the backend.
    cardStatus: "pending-review",
    source: "ebay-auto",
    sourcePurchaseId: purchase.id,
    parseConfidence: parsed.parseConfidence,
    needsReview: parsed.parseConfidence < NEEDS_REVIEW_MAX,
  };

  // Populate parsed fields when present. Every parsed field can legitimately
  // be absent — writer converts each to undefined so the response shape
  // stays additive.
  if (parsed.year !== null) holding.cardYear = parsed.year;
  if (parsed.playerName) holding.playerName = parsed.playerName;
  if (parsed.setName) {
    holding.setName = parsed.setName;
    holding.product = parsed.setName;   // dual-populate for downstream readers
  }
  if (parsed.parallel) holding.parallel = parsed.parallel;
  if (parsed.cardNumber) holding.cardNumber = parsed.cardNumber;
  if (parsed.gradeCompany) {
    holding.gradeCompany = parsed.gradeCompany;
    holding.gradingCompany = parsed.gradeCompany;   // legacy field alias
  }
  if (gradeValue !== undefined) holding.gradeValue = gradeValue;
  if (cardTitle) holding.cardTitle = cardTitle;
  // CF-EBAY-AUTO-DETECTION (2026-07-12): isAuto is a declared field on
  // PortfolioHolding — populated when the parser flagged the title as
  // an autograph. Rookie signal preserved on notes (no dedicated boolean).
  if (parsed.isAuto) holding.isAuto = true;
  if (parsed.isRookie) {
    holding.notes = `${holding.notes} · rookie`;
  }

  return holding;
}

function buildCardTitle(parsed: ParsedListingTitle): string | undefined {
  const parts: string[] = [];
  if (parsed.year !== null) parts.push(String(parsed.year));
  if (parsed.setName) parts.push(parsed.setName);
  if (parsed.parallel) parts.push(parsed.parallel);
  if (parsed.playerName) parts.push(parsed.playerName);
  if (parsed.cardNumber) parts.push(`#${parsed.cardNumber}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractGradeValue(grade: string): number | undefined {
  const m = grade.match(/([\d.]+)$/);
  return m ? Number(m[1]) : undefined;
}

// ─── CF-EBAY-BROWSE-ENRICHMENT (2026-07-12) ────────────────────────────────
//
// Merge Browse API item detail data into a title-parsed holding. Browse data
// is AUTHORITATIVE for grader / grade / autograph flag / condition (structured
// item specifics beat title-string parsing). Aspects the parser couldn't get
// are backfilled here. Images + description are added for iOS render + future
// eBay-relisting flow.

const NORMALIZED_GRADER_MAP: Record<string, "PSA" | "BGS" | "SGC" | "CGC"> = {
  psa: "PSA",
  "professional sports authenticator (psa)": "PSA",
  "professional sports authenticator": "PSA",
  bgs: "BGS",
  "beckett grading services (bgs)": "BGS",
  "beckett grading services": "BGS",
  beckett: "BGS",
  sgc: "SGC",
  "sports guaranty company": "SGC",
  "sports guaranty co (sgc)": "SGC",
  cgc: "CGC",
  "certified guaranty company (cgc)": "CGC",
};

function normalizeGraderCompany(s: string | null): "PSA" | "BGS" | "SGC" | "CGC" | null {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  return NORMALIZED_GRADER_MAP[lower] ?? null;
}

function parseGradeValueLoose(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

export function applyBrowseEnrichment(
  holding: PortfolioHolding & Record<string, unknown>,
  details: EbayItemDetails,
): void {
  const aspects = details.aspects ?? {};

  // ── Grader + grade: authoritative from Browse if present ──────────
  const grader = normalizeGraderCompany(details.grader) ?? normalizeGraderCompany(aspects["Professional Grader"] ?? null);
  const graded = grader !== null || (details.condition ?? "").toLowerCase() === "graded";
  if (grader) {
    holding.gradeCompany = grader;
    holding.gradingCompany = grader;   // legacy alias
  }
  const gradeVal = parseGradeValueLoose(details.grade) ?? parseGradeValueLoose(aspects["Grade"] ?? null);
  if (gradeVal !== undefined) {
    holding.gradeValue = gradeVal;
  }
  // CF-CERT-CAPTURE (Drew, 2026-07-20). Promote the seller-typed
  // certification number into a structured holding field so re-listing
  // that same graded card doesn't force the user to type it in again.
  // eBay uses several field names for this depending on category —
  // check the common ones.
  const certRaw =
    aspects["Certification Number"] ??
    aspects["Cert Number"] ??
    aspects["Certification"] ??
    null;
  if (certRaw && typeof certRaw === "string") {
    const cert = certRaw.trim();
    if (cert.length > 0 && cert.length <= 32) {
      (holding as Record<string, unknown>).certNumber = cert;
    }
  }
  // If Browse says Ungraded explicitly, clear a title-parsed grade so we
  // don't lie about it. Title regex sometimes picks up spurious "PSA 10"
  // in seller marketing copy that isn't a real slab.
  if (!graded && details.condition && details.condition.toLowerCase().includes("ungraded")) {
    holding.gradeCompany = undefined;
    holding.gradingCompany = undefined;
    holding.gradeValue = undefined;
    (holding as Record<string, unknown>).certNumber = undefined;
  }

  // ── Autograph: Browse aspect authoritative ────────────────────────
  const autoAspect = aspects["Autographed"] ?? aspects["Autograph"];
  if (autoAspect !== undefined) {
    const yes = /^(y|yes|true)$/i.test(autoAspect);
    holding.isAuto = yes;
  }

  // ── Structured aspects: Browse is AUTHORITATIVE, not backfill ──────
  //
  // The title parser scrapes free-text ("2020 Panini Prizm Mookie Betts
  // #275") and gets things like "Baseball Owen Carey" or "Ernie Banks
  // Chicago Cubs" — team names, sport names, and vertical markers leak
  // into playerName because the title's word order is unpredictable.
  // Browse's structured Player aspect is what the SELLER typed into the
  // eBay item-specifics form: it's clean.
  //
  // Policy: when Browse has the structured field, override the title-
  // parsed value. Title parse is the FALLBACK, not the truth.
  //
  // Undecorated exception: cardNumber. Browse "Card Number" is often
  // just the base number (e.g., "14") when the parallel-specific code
  // ("BCP-14") is what the title carries — preserve title's when present.
  if (aspects["Player"]) holding.playerName = aspects["Player"];
  else if (aspects["Player/Athlete"]) holding.playerName = aspects["Player/Athlete"];
  if (aspects["Team"]) (holding as any).team = aspects["Team"];
  if (aspects["Sport"]) (holding as any).sport = aspects["Sport"];
  if (aspects["Season"]) {
    const y = Number(aspects["Season"]);
    if (Number.isFinite(y) && y >= 1900) holding.cardYear = y;
  }
  if (aspects["Set"]) {
    holding.setName = aspects["Set"];
    holding.product = aspects["Set"];
  }
  if (aspects["Manufacturer"]) {
    (holding as any).manufacturer = aspects["Manufacturer"];
  }
  // CF-ASPECT-IS-NOT-A-PARALLEL (Drew, 2026-08-18: "i am seeing a lot of
  // refractors turned into base cards ... the name itself is not matching
  // from ebay").
  //
  // eBay's Parallel/Variety aspect is SELLER-TYPED, and sellers routinely put
  // the PRODUCT there. This blindly overwrote the title parse — which had
  // already got it right on line ~353 — and the real parallel was discarded:
  //
  //   "2025 Bowman Chrome Refractor Max Williams"    aspect "Chrome"  (was Refractor)
  //   "2026 Topps Chrome Yellow Parallel K. Griffin" aspect "Chrome"  (was Yellow)
  //   "2026 Bowman Blue Blaine Bullard Logo Pattern" aspect "Chrome"  (was Blue)
  //   "2026 Bowman Sapphire Numbered Owen Carey"     aspect "Numbered"
  //
  // Downstream, holdingFieldNormalizer correctly rejects "Chrome" as not a
  // parallel and nulls it — and a null parallel renders as `base`. So a
  // Refractor arrives already amputated and gets priced against base comps.
  // Six of Drew's holdings were in this state.
  //
  // The aspect is still USEFUL — it is the only structured signal when a title
  // omits the parallel. So keep it, but only when it survives normalization as
  // a real parallel. If the normalizer would discard it, the title parse is
  // the better source and must not be clobbered.
  const rawAspectParallel = aspects["Parallel/Variety"];
  if (rawAspectParallel) {
    const { fields: probe } = normalizeHoldingFields({
      playerName: holding.playerName ?? null,
      cardYear: holding.cardYear ?? null,
      setName: holding.setName ?? null,
      parallel: rawAspectParallel,
      cardNumber: holding.cardNumber ?? null,
      isAuto: holding.isAuto ?? null,
      product: holding.product ?? null,
    });
    const survives = typeof probe.parallel === "string" && probe.parallel.trim() !== "";
    if (survives) {
      holding.parallel = probe.parallel as string;
    } else if (!holding.parallel) {
      // Nothing from the title either — leave it unset rather than storing a
      // product word that will silently become `base`.
      console.log(JSON.stringify({
        event: "ebay_aspect_parallel_rejected",
        source: "ebayAutoHolding",
        aspect: rawAspectParallel,
        title: holding.cardTitle ?? null,
        note: "aspect is not a parallel; kept title-parsed value",
      }));
    }
  }
  // CF-NORMALISE-FINAL-PARALLEL (2026-08-22). The block above normalises the
  // eBay ASPECT only. A title-parsed parallel never went through
  // holdingFieldNormalizer at all, so raw scraped strings reached Cosmos and
  // could never match a catalog row:
  //
  //   "ChromeProspectAutographsBlueRefractor"   "ChromeProspectAutographRefractor"
  //   "Chrome Prospects Mojo Black Refractor"   "[Base]"   "NONE"   "Logofractor"
  //   "Gold Prizm Missing Serial Number"
  //
  // One of them was baked into a slug:
  //   hiq:baseball:2025:draft:cpa-dc:chromeprospectautographgoldrefractor:auto
  //
  // holdingFieldNormalizer is THE cleaning standard; applying it to one branch
  // instead of to the value we actually store is the same scope error that
  // produced the Kurtz and Caglianone bugs. Normalise the FINAL value here.
  //
  // Note this can only IMPROVE or clear the parallel. If normalisation rejects
  // the string outright we keep it rather than silently dropping to base —
  // a wrong-but-present parallel is reviewable, an amputated one is invisible
  // (that amputation is exactly what PR #1141 fixed for the aspect path).
  if (typeof holding.parallel === "string" && holding.parallel.trim() !== "") {
    const before = holding.parallel;
    const { fields: cleaned } = normalizeHoldingFields({
      playerName: holding.playerName ?? null,
      cardYear: holding.cardYear ?? null,
      setName: holding.setName ?? null,
      parallel: before,
      cardNumber: holding.cardNumber ?? null,
      isAuto: holding.isAuto ?? null,
      product: holding.product ?? null,
    });
    const cleanedParallel = typeof cleaned.parallel === "string" ? cleaned.parallel.trim() : "";
    if (cleanedParallel !== "" && cleanedParallel !== before) {
      console.log(JSON.stringify({
        event: "ebay_final_parallel_normalised",
        source: "ebayAutoHolding",
        before,
        after: cleanedParallel,
        title: holding.cardTitle ?? null,
      }));
      holding.parallel = cleanedParallel;
    } else if (cleanedParallel === "") {
      console.log(JSON.stringify({
        event: "ebay_final_parallel_unrecognised",
        source: "ebayAutoHolding",
        parallel: before,
        title: holding.cardTitle ?? null,
        note: "normalizer did not recognise it; KEPT as-is so it stays reviewable rather than becoming base",
      }));
    }
  }

  if (aspects["Card Number"] && !holding.cardNumber) {
    holding.cardNumber = aspects["Card Number"];
  }

  // ── Images: primary + additionals into holding.photos[] ───────────
  const imageUrls = [details.images.primary, ...details.images.additional].filter(
    (u): u is string => !!u,
  );
  if (imageUrls.length > 0) {
    // Backend already treats `photos` as the canonical image list.
    (holding as any).photos = imageUrls;
    (holding as any).ebayImageUrl = imageUrls[0];
  }

  // ── Description + item specifics for iOS + eBay relisting flow ────
  if (details.shortDescription) {
    (holding as any).ebayShortDescription = details.shortDescription;
  }
  if (Object.keys(aspects).length > 0) {
    (holding as any).ebayItemAspects = aspects;
  }
  if (details.categoryPath) {
    (holding as any).ebayCategoryPath = details.categoryPath;
  }
  if (details.seller) {
    (holding as any).ebaySeller = details.seller;
  }

  // ── Bump the parse confidence + drop needs-review when Browse data ──
  // provided the grader/grade/aspects the title couldn't. Confidence 0.95
  // is the "eBay confirmed" tier — the browse data is structured, not
  // parsed — so iOS's needs-review prompt drops away.
  const gotStructuredData = Object.keys(aspects).length > 0 || grader !== null || gradeVal !== undefined;
  if (gotStructuredData) {
    const priorConf = (holding as any).parseConfidence as number | undefined;
    (holding as any).parseConfidence = Math.max(priorConf ?? 0, 0.95);
    (holding as any).needsReview = false;
    (holding as any).enrichedFromEbay = true;
  }

  holding.lastUpdated = new Date().toISOString();
}
