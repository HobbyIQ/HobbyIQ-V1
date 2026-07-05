/**
 * CF-CARD-IMAGE-RESOLVER (2026-07-05):
 * Vendor-neutral resolver that turns a Cardsight cardId into the
 * publicly-hittable HTTPS image URL iOS renders in the comp-card hero,
 * inventory rows, portfolio Top Movers, and holding grid tiles.
 *
 * Two-step contract, matching what /api/compiq/price-by-id already
 * emits on `response.cardImageUrl` (see compiq.routes.ts:3544-3554):
 *
 *   1. Read the CDN URL from card meta (getCardMetaById cache).
 *   2. If the URL is a CardHedge bubble.io CDN (off-spec 754×1028 =
 *      aspect 0.7335), route it through /api/compiq/card-image-proxy
 *      so it's cropped to the physical 2.5×3.5 aspect (0.7143)
 *      before iOS renders. If it's some other host (future eBay
 *      Browse migration), pass through raw.
 *
 * Returns null on a cold meta cache miss — callers must fall back to
 * their placeholder gracefully. Never throws.
 *
 * The regex + proxy path live here (not compiq.routes.ts) so any
 * consumer — including the portfolio wire (CF-INVENTORY-CATALOG-IMAGE
 * 2026-07-05) — can produce an identical URL to what the comp card
 * uses, without route-scoped helpers reaching into each other's
 * module state.
 */

import type { Request } from "express";
import { getCardMetaById } from "./cardsight.router.js";

/** CH CDN host — cropped through card-image-proxy for aspect correction. */
const CARDHEDGE_CDN_HOST_RE = /^https:\/\/[a-z0-9]+\.cdn\.bubble\.io\//i;
/** Legacy CH CDN host (pre-2026 payloads). */
const CARDHEDGE_CDN_HOST_RE_LEGACY = /^https:\/\/[a-z0-9]+\.cdnh\.bubble\.io\//i;

export function isCardHedgeCdnUrl(u: string): boolean {
  if (typeof u !== "string" || u.length === 0 || u.length > 512) return false;
  return CARDHEDGE_CDN_HOST_RE.test(u) || CARDHEDGE_CDN_HOST_RE_LEGACY.test(u);
}

/**
 * Build a request-absolute URL honoring Azure App Service's
 * x-forwarded-* headers so the proxy URL we emit is publicly hittable.
 * Mirrors the same absoluteApiUrl helper compiq.routes.ts uses; kept
 * here so this module has no coupling to route-scoped helpers.
 */
export function absoluteApiUrl(req: Request, path: string): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers.host as string | undefined) ??
    "";
  return `${proto}://${host}${path}`;
}

/**
 * Resolve a cardId to the exact catalog image URL iOS renders on the
 * comp card hero. Byte-identical to what /api/compiq/price-by-id
 * emits on `response.cardImageUrl` — so the inventory row and the
 * price-detail view show the SAME cropped image for the SAME card.
 *
 * Returns null when card meta is uncached or missing an image field.
 * Callers should treat null as "no catalog image" and fall back to
 * their placeholder.
 */
export async function resolveCatalogImageUrl(
  req: Request,
  cardId: string,
): Promise<string | null> {
  if (!cardId || typeof cardId !== "string") return null;
  const meta = await getCardMetaById(cardId).catch(() => null);
  const rawImageUrl = meta?.imageUrl ?? null;
  if (!rawImageUrl) return null;
  if (isCardHedgeCdnUrl(rawImageUrl)) {
    return absoluteApiUrl(
      req,
      `/api/compiq/card-image-proxy?u=${encodeURIComponent(rawImageUrl)}`,
    );
  }
  return rawImageUrl;
}
