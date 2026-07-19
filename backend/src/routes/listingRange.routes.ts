// CF-LISTING-RANGE (Drew, 2026-07-18). "Currently listing on eBay" —
// the IQR (25th-75th percentile) range of active listings for a
// specific (cardId, parallel, grade). Card Detail page renders this
// directly under the FMV headline so users see "what people think it's
// worth" vs "what people are asking right now."
//
// Route: GET /api/compiq/cards/:cardId/listing-range
// Auth:  requireSession
//
// Query params:
//   parallel        — "Blue Refractor" etc.
//   gradeCompany    — "PSA" | "BGS" | "SGC" | absent for raw
//   gradeValue      — numeric grade; absent for raw
//   cardYear        — 2026 etc.
//   product         — "2026 Bowman Chrome"
//   player          — "Eric Hartman"
//   cardNumber      — "CPA-EHA"
//
// Response:
//   {
//     count: number,
//     range: { p25, p75 } | null,           // null when count < 4
//     median: number | null,
//     min: number,
//     max: number,
//     delta: {                              // vs canonical FMV
//       vsFmv: number,                      // median - fmv
//       vsFmvPct: number,                   // % diff
//       direction: "up" | "down" | "flat",  // > 15% divergence flags direction
//     } | null,
//     listings: [                           // top 12 for tap-through
//       { price, endsAt, sellerHandle, itemWebUrl, imageUrl, title }
//     ]
//   }
//
// For grade-split display, iOS calls twice with different gradeCompany/
// gradeValue params.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { fetchCardActiveListings } from "../services/ebay/ebayListingSearch.service.js";
import { computeCanonicalFmv } from "../services/compiq/canonicalFmv.service.js";

const router = Router();

/** Percentile of a sorted numeric array. p = 0.25 → 25th percentile. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

router.get("/cards/:cardId/listing-range", requireSession, async (req: Request, res: Response, next) => {
  try {
    const cardId = String(req.params.cardId ?? "").trim();
    if (!cardId) {
      res.status(400).json({ error: "cardId required" });
      return;
    }
    const parallel = typeof req.query.parallel === "string" && req.query.parallel.trim().length > 0
      ? req.query.parallel.trim()
      : undefined;
    const gradeCompany = typeof req.query.gradeCompany === "string" && req.query.gradeCompany.trim().length > 0
      ? req.query.gradeCompany.trim()
      : undefined;
    const gradeValue = typeof req.query.gradeValue === "string" && req.query.gradeValue.trim().length > 0
      ? req.query.gradeValue.trim()
      : undefined;
    const cardYearRaw = typeof req.query.cardYear === "string" ? req.query.cardYear.trim() : "";
    const cardYear = cardYearRaw ? Number(cardYearRaw) : undefined;
    const product = typeof req.query.product === "string" && req.query.product.trim().length > 0
      ? req.query.product.trim()
      : undefined;
    const player = typeof req.query.player === "string" && req.query.player.trim().length > 0
      ? req.query.player.trim()
      : undefined;
    const cardNumber = typeof req.query.cardNumber === "string" && req.query.cardNumber.trim().length > 0
      ? req.query.cardNumber.trim()
      : undefined;

    if (!player) {
      res.status(400).json({ error: "player query param required" });
      return;
    }

    // Kick both fetches in parallel — the endpoint composes active-
    // listings (Browse API) with canonical FMV (our pool) so the delta
    // signal renders in one round-trip from iOS.
    const [listingsResult, fmvResult] = await Promise.all([
      fetchCardActiveListings({
        year: cardYear,
        set: product,
        player,
        cardNumber,
        parallel,
        gradeCompany,
        gradeValue,
      }),
      computeCanonicalFmv({
        cardId,
        parallel: parallel ?? null,
        gradeCompany: gradeCompany ?? null,
        gradeValue: gradeValue !== undefined ? Number(gradeValue) : null,
        cardYear: cardYear ?? null,
        product: product ?? null,
        player,
        cardNumber: cardNumber ?? null,
      }),
    ]);

    if (!listingsResult || listingsResult.listings.length === 0) {
      res.json({
        count: 0,
        range: null,
        median: null,
        min: null,
        max: null,
        delta: null,
        listings: [],
      });
      return;
    }

    // CF-LISTING-RANGE-TITLE-VERIFY (Drew, 2026-07-18). eBay Browse's
    // fuzzy search bleeds base cards into "Blue Refractor" queries.
    // Post-fetch title verification enforces:
    //   1. cardNumber (CPA-EHA etc.) must appear in the listing title
    //   2. distinctive parallel tokens in the target (Shimmer / Speckle
    //      / X-Fractor / Wave / etc.) must appear in the title
    //   3. dominant color word (Blue / Gold / etc.) must appear in the
    //      title when the target has one
    //   4. distinctive tokens NOT in the target must NOT appear
    //      (a Blue Refractor query rejects Blue X-Fractor listings)
    const verifiedListings = listingsResult.listings.filter((l) =>
      titleMatchesParallel(l.title ?? "", parallel ?? null, cardNumber ?? null),
    );

    const prices = verifiedListings
      .map((l) => l.price)
      .filter((p) => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);
    if (prices.length === 0) {
      res.json({
        count: 0,
        range: null,
        median: null,
        min: null,
        max: null,
        delta: null,
        listings: [],
      });
      return;
    }

    const p25 = percentile(prices, 0.25);
    const p50 = percentile(prices, 0.5);
    const p75 = percentile(prices, 0.75);
    const range = prices.length >= 4 && p25 !== null && p75 !== null
      ? { p25: Math.round(p25 * 100) / 100, p75: Math.round(p75 * 100) / 100 }
      : null;

    let delta: null | { vsFmv: number; vsFmvPct: number; direction: "up" | "down" | "flat" } = null;
    if (fmvResult.fmv !== null && fmvResult.fmv > 0 && p50 !== null) {
      const vsFmv = Math.round((p50 - fmvResult.fmv) * 100) / 100;
      const vsFmvPct = Math.round((vsFmv / fmvResult.fmv) * 1000) / 10;   // 1 dp
      // Direction chip fires when median-vs-FMV divergence exceeds 15%.
      // 15% chosen because listing asks typically sit 5-10% above realized
      // sales (seller optimism); a 15%+ gap signals real market drift.
      const DIVERGENCE_PCT = 15;
      const direction: "up" | "down" | "flat" =
        vsFmvPct > DIVERGENCE_PCT ? "up"
        : vsFmvPct < -DIVERGENCE_PCT ? "down"
        : "flat";
      delta = { vsFmv, vsFmvPct, direction };
    }

    // Top 12 listings (by price ascending) for the tap-through sheet.
    // iOS renders these as individual rows the user can click into for
    // deeper eBay research.
    const topListings = verifiedListings
      .slice()
      .sort((a, b) => a.price - b.price)
      .slice(0, 12)
      .map((l) => ({
        price: l.price,
        endsAt: l.endsAt,
        sellerHandle: l.seller.username,
        itemWebUrl: l.itemWebUrl,
        imageUrl: l.imageUrl,
        title: l.title,
      }));

    res.json({
      count: prices.length,
      range,
      median: p50 !== null ? Math.round(p50 * 100) / 100 : null,
      min: prices.length > 0 ? Math.round(prices[0] * 100) / 100 : null,
      max: prices.length > 0 ? Math.round(prices[prices.length - 1] * 100) / 100 : null,
      delta,
      listings: topListings,
      // Debug field for ops — shows how many raw Browse hits were
      // filtered out by title verification. Not part of the iOS
      // contract; safe to strip if noisy.
      __filteredRaw: listingsResult.listings.length,
      __filteredVerified: verifiedListings.length,
    });
  } catch (err) { next(err); }
});

/** Distinctive parallel keywords that must appear in the listing
 *  title if they appear in the target parallel. Mirrors the list in
 *  ebayImportRematch.service.ts DISTINCTIVE_SUBS so search matching
 *  and pool-side matching agree. */
const DISTINCTIVE_TOKENS = [
  "x-fractor", "xfractor", "shimmer", "speckle", "wave", "reptilian",
  "lazer", "sapphire", "aqua", "ice", "mojo", "sepia", "true",
  "border", "sky", "pattern", "geometric", "logofractor", "logo",
  "prizm", "hyper", "silver", "cracked",
];

const BARE_COLORS = ["blue", "orange", "red", "green", "gold", "purple", "black", "pink", "yellow", "sepia"];

/** Post-fetch title verification. Enforces cardNumber presence,
 *  parallel keyword presence, color presence, and exclusion of
 *  competing distinctive tokens. Returns true when the listing's
 *  title is plausibly for the target parallel. */
function titleMatchesParallel(
  title: string,
  targetParallel: string | null,
  targetCardNumber: string | null,
): boolean {
  const t = title.toLowerCase();
  const parallel = (targetParallel ?? "").toLowerCase().trim();

  // 1. cardNumber (if specified) MUST appear in the title
  if (targetCardNumber && targetCardNumber.trim().length > 0) {
    const cn = targetCardNumber.trim().toLowerCase();
    // Match with optional # prefix and word boundary
    const cnRe = new RegExp(`#?\\b${cn.replace(/[-.]/g, "\\$&")}\\b`);
    if (!cnRe.test(t)) return false;
  }

  // No parallel specified → passes (base cards etc.)
  if (!parallel) return true;

  // 2. Every distinctive token in the target parallel MUST appear in the title.
  const targetDistinctive = DISTINCTIVE_TOKENS.filter((tok) => parallel.includes(tok));
  for (const tok of targetDistinctive) {
    const stripped = tok.replace("-", "");
    if (!t.includes(tok) && !t.includes(stripped)) return false;
  }

  // 3. Dominant color in the target MUST appear in the title.
  const targetColor = BARE_COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(parallel));
  if (targetColor && !new RegExp(`\\b${targetColor}\\b`).test(t)) return false;

  // 4. Distinctive tokens NOT in the target MUST NOT appear in the title.
  // Prevents a "Blue Refractor" query from matching "Blue X-Fractor" listings.
  const targetNoDistinctive = DISTINCTIVE_TOKENS.filter((tok) => !parallel.includes(tok));
  for (const tok of targetNoDistinctive) {
    if (t.includes(tok)) return false;
  }

  return true;
}

export default router;
