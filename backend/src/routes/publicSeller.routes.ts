// CF-PUBLIC-SELLER-STOREFRONT (Drew, 2026-07-27). Public-facing (no
// auth required) route for a Pro Seller's inventory storefront. Renders
// at hobby-iq.com/u/<username>. Response shape is deliberately narrow —
// NEVER exposes cost basis, purchase price, gain/loss, notes, or any
// personal data. Only what a buyer needs to shop.
//
// Gating rules:
//   1. User must exist and have a username set.
//   2. User must have publicShareEnabled === true.
//   3. Effective plan (after Owner override) must be pro_seller.
//   4. User's email must be verified (CF-EMAIL-VERIFICATION-GATE,
//      2026-07-27) — prevents impersonation-storefronts from unverified
//      throwaway accounts.
//   Any miss → 404 (deliberately, not 403 — don't leak whether an
//   account exists at all).

import { Router, type Request, type Response } from "express";
import { findUserRecordByUsername } from "../services/authService.js";
import { effectivePlanFor } from "../config/entitlements.js";
import { readUserDoc } from "../services/portfolioiq/portfolioStore.service.js";

const router = Router();

router.get("/seller/:username", async (req: Request, res: Response) => {
  const usernameRaw = String(req.params.username ?? "").trim();
  if (!usernameRaw || usernameRaw.length > 40) {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  const record = await findUserRecordByUsername(usernameRaw);
  if (!record) return res.status(404).json({ success: false, error: "Not found" });

  const effectivePlan = effectivePlanFor({
    plan: record.plan,
    entitlementOverride: record.entitlementOverride,
  });
  if (effectivePlan !== "pro_seller") {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  if (record.publicShareEnabled !== true) {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  // CF-EMAIL-VERIFICATION-GATE: hide storefronts whose owner hasn't
  // verified their email. Owner sees "Verify to enable" prompt on
  // Settings so this isn't a silent trap.
  if (!record.emailVerification?.verifiedAt) {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  // Load portfolio + build the safe view. Skip holdings with no image
  // or no title — a buyer-facing surface shouldn't have empty cards.
  const doc = await readUserDoc(record.userId).catch(() => null);
  const holdings = doc?.holdings ? Object.values(doc.holdings) : [];

  interface StorefrontCard {
    holdingId: string;
    cardTitle: string;
    playerName: string | null;
    imageUrl: string | null;
    grade: string | null;
    fmv: number | null;
    parallel: string | null;
    year: number | null;
  }

  const cards: StorefrontCard[] = holdings
    .filter((h) => {
      const anyH = h as {
        photos?: unknown;
        playerName?: unknown;
        cardTitle?: unknown;
        hideFromStorefront?: unknown;
      };
      // CF-STOREFRONT-HIDE (Drew, 2026-07-27): owner-set per-card opt-out
      // wins over every other display gate.
      if (anyH.hideFromStorefront === true) return false;
      const hasPhoto = Array.isArray(anyH.photos) && anyH.photos.length > 0;
      const hasIdentity = typeof anyH.playerName === "string" || typeof anyH.cardTitle === "string";
      return hasPhoto && hasIdentity;
    })
    .map((h): StorefrontCard => {
      const anyH = h as unknown as Record<string, unknown>;
      const photos = Array.isArray(anyH.photos) ? (anyH.photos as string[]) : [];
      const gradeCompany = typeof anyH.gradeCompany === "string" ? anyH.gradeCompany : null;
      const gradeValue = typeof anyH.gradeValue === "number" ? anyH.gradeValue : null;
      const grade = gradeCompany && gradeValue != null ? `${gradeCompany} ${gradeValue}` : null;
      const fmv =
        typeof anyH.fairMarketValue === "number" && anyH.fairMarketValue > 0
          ? anyH.fairMarketValue
          : typeof anyH.estimatedValue === "number" && anyH.estimatedValue > 0
            ? anyH.estimatedValue
            : null;
      const productOrTitle =
        (typeof anyH.cardTitle === "string" && anyH.cardTitle) ||
        [anyH.cardYear, anyH.product ?? anyH.setName, anyH.parallel, anyH.playerName]
          .filter((x) => typeof x === "string" || typeof x === "number")
          .join(" ")
          .trim();
      return {
        holdingId: String(anyH.id ?? ""),
        cardTitle: productOrTitle,
        playerName: typeof anyH.playerName === "string" ? anyH.playerName : null,
        imageUrl: photos[0] ?? null,
        grade,
        fmv,
        parallel: typeof anyH.parallel === "string" ? anyH.parallel : null,
        year: typeof anyH.cardYear === "number" ? anyH.cardYear : null,
      };
    })
    // Sort highest-value first so the shop leads with premium inventory.
    .sort((a, b) => (b.fmv ?? 0) - (a.fmv ?? 0));

  // Sport breakdown — helpful "what does this seller specialize in?"
  const sportCounts = new Map<string, number>();
  for (const h of holdings) {
    const s = (h as { sport?: unknown }).sport;
    if (typeof s === "string" && s.trim()) {
      const norm = s.trim().toLowerCase();
      sportCounts.set(norm, (sportCounts.get(norm) ?? 0) + 1);
    }
  }
  const sports = Array.from(sportCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sport, count]) => ({ sport, count }));

  return res.json({
    success: true,
    seller: {
      // CF-MESSAGING (2026-07-27): expose userId so an authed buyer can
      // open a thread. Not sensitive — userId is already the canonical
      // partition key across public API surfaces.
      userId: record.userId,
      username: record.aliases?.[0] ?? usernameRaw,
      joinedAt: record.createdAt,
    },
    portfolio: {
      cardCount: cards.length,
      sports,
    },
    cards: cards.slice(0, 200), // hard cap to keep the wire response bounded
  });
});

export default router;
