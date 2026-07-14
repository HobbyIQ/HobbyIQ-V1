// CF-CARDSIGHT-UUID-IMAGE (Drew, 2026-07-13, PR #414): shared imageUrl
// patcher for search responses. Cardsight-native candidates (both the
// bare parent form from PR #412 and the exploded per-parallel form from
// PR #413) carry `imageUrl: null` at the vendor plugin. This helper
// rewrites their imageUrl to route through our /api/compiq/card-image
// proxy so iOS renders thumbnails.
//
// Applied at each route (search.routes.ts + compiq.routes.ts) rather
// than inside the dispatcher because it needs the Request context to
// build absolute URLs — the dispatcher is request-agnostic by design.

import type { Request } from "express";
import { absoluteApiUrl } from "../services/compiq/cardImageResolver.js";

const CARDSIGHT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Iterate a candidates array and populate `imageUrl` for Cardsight-
 * native rows. Two candidateId shapes handled (both proxy the PARENT's
 * cardId because per Cardsight's API design parallels don't have their
 * own images):
 *
 *   1. Bare parent: `cardsight:{parentUuid}` — legacy shape from PR #412
 *   2. Compound: `cardsight:{parentUuid}::{parallelUuid}` — exploded
 *      per-parallel shape from PR #413
 *
 * CardHedge candidates whose imageUrl is already an http(s) CDN URL
 * are left untouched. CardHedge routes its own images and the /cardsearch
 * handler has a separate CH-URL proxy that runs after this helper — this
 * helper only fills nulls on Cardsight rows.
 *
 * Mutates the array in place.
 */
export function patchCardsightImageUrls(
  req: Request,
  candidates: any[],
): void {
  for (const c of candidates) {
    // CF-CARDSIGHT-COMPLETE-COMPS (PR #416): the dispatcher populates a
    // `cardsight-parent:{uuid}` marker on Cardsight-native rows so the
    // cross-vendor dedup can graft the same-marker string onto a CH
    // survivor. Rewrite the marker to an absolute proxy URL here — the
    // marker never reaches iOS.
    if (typeof c?.imageUrl === "string") {
      const markerMatch = c.imageUrl.match(
        /^cardsight-parent:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
      );
      if (markerMatch) {
        c.imageUrl = absoluteApiUrl(req, `/api/compiq/card-image/${markerMatch[1]}`);
        continue;
      }
      // Never overwrite an existing http(s) imageUrl.
      if (/^https?:\/\//i.test(c.imageUrl)) continue;
    }

    const cid: string | undefined =
      typeof c?.candidateId === "string" ? c.candidateId : undefined;
    if (!cid) continue;

    // Compound shape first — the `::` separator is unambiguous.
    const compoundMatch = cid.match(
      /^cardsight:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    if (compoundMatch) {
      c.imageUrl = absoluteApiUrl(req, `/api/compiq/card-image/${compoundMatch[1]}`);
      continue;
    }

    // Bare-parent shape or legacy bubble.io id — both hex+hyphens.
    const bareMatch = cid.match(/^cardsight:([0-9a-fx-]+)$/i);
    const csId = bareMatch?.[1];
    if (csId && CARDSIGHT_UUID_RE.test(csId)) {
      c.imageUrl = absoluteApiUrl(req, `/api/compiq/card-image/${csId}`);
    }
  }
}
