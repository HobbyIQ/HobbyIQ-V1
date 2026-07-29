// CF-IMAGE-VERIFY-JOB (Drew, 2026-07-28).
//
// Reads staging rows in `anomaly` state that have a mirrored image
// available, runs a two-tier verification, and flips status to
// `verified` (Tier 1 or Tier 2 confirmed identity) or
// `pending-manual` (both tiers inconclusive → Drew triages).
//
// Per no-reject rule: nothing gets rejected. Tier 1 pHash match →
// promotion-eligible. Tier 2 Vision OCR agreement → promotion-eligible.
// Everything else → pending-manual, sitting in verify_queue for
// human review.
//
// Tier 1: pHash our mirrored image vs the catalog entry's reference
// image (if one exists). Match = high confidence, no Vision cost.
// Distance > threshold OR no catalog reference = fall through to Tier 2.
//
// Tier 2: Azure Vision OCR. For graded slabs → check the label
// (grader / grade / cert number) matches what the record claims.
// For raw cards → check player/year/cardNumber/parallel tokens
// appear in the OCR text.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeImageHash, classifyImageMatch } from "./imageVerify.service.js";
import { getCatalogEntry } from "./cardCatalog.service.js";
import { ocrImageUrl, checkTokensAgainstOcr } from "./azureVisionOcr.service.js";
import type { StagingDoc, StagingVerification } from "./compsStaging.service.js";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

let _cached: Container | null = null;
async function getStagingContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");
    return _cached;
  } catch {
    return null;
  }
}

export interface ImageVerifyResult {
  scanned: number;
  verifiedByPhash: number;
  verifiedByVision: number;
  routedToManual: number;
  errors: number;
  visionCalls: number;
}

/**
 * Process a bounded batch of `anomaly` staging rows. Returns counts
 * including Vision API call count for cost tracking. Silent-safe.
 */
export async function runImageVerifyBatch(opts: { limit?: number } = {}): Promise<ImageVerifyResult> {
  const staging = await getStagingContainer();
  const result: ImageVerifyResult = {
    scanned: 0,
    verifiedByPhash: 0,
    verifiedByVision: 0,
    routedToManual: 0,
    errors: 0,
    visionCalls: 0,
  };
  if (!staging) return result;

  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const { resources: anomalies } = await staging.items.query<StagingDoc>({
    query: "SELECT TOP @n * FROM c WHERE c.status = 'anomaly' ORDER BY c.observedAt ASC",
    parameters: [{ name: "@n", value: limit }],
  }).fetchAll();

  for (const row of anomalies) {
    result.scanned += 1;
    try {
      const verification = await verifyRow(row);
      if (verification.method === "vision-slab-label" || verification.method === "vision-tokens") {
        result.visionCalls += 1;
      }
      row.verification = verification;
      if (verification.matched) {
        row.status = "verified";
        if (verification.method === "phash-match") result.verifiedByPhash += 1;
        else result.verifiedByVision += 1;
      } else {
        row.status = "pending-manual";
        result.routedToManual += 1;
        // Also enqueue to verify_queue so Drew sees this row in the
        // /app/admin/verify UI. Best-effort — status stays pending-manual
        // even if the enqueue fails.
        try {
          const { enqueueForVerify } = await import("./verifyQueue.service.js");
          // CF-CATALOG-REF-IMAGE-FALLBACK (Drew, 2026-07-28). When
          // the vendor didn't record an image URL (~46% of
          // Cardsight-source legacy rows), fall back to the catalog
          // entry's reference image. Drew still gets to SEE what the
          // card should look like — even if the specific listing had
          // no photo, the canonical CH catalog image is a valid proxy.
          const { getCatalogEntry } = await import("./cardCatalog.service.js");
          const catalogRefImage = (await getCatalogEntry(row.hobbyiqCardId).catch(() => null))?.referenceImage?.url ?? null;
          const primaryImage = row.mirroredImage?.blobUrl
            || String(row.raw.vendorPayload.imageUrl ?? "")
            || catalogRefImage
            || "";
          await enqueueForVerify({
            reason: "image-mismatch",
            saleInput: {
              cardId: row.hobbyiqCardId,
              playerName: row.raw.identityHint.playerName ?? "(unknown)",
              cardYear: row.raw.identityHint.cardYear ?? null,
              setName: row.clean?.setName ?? null,
              parallel: row.clean?.parallel ?? row.raw.vendorPayload.title,
              cardNumber: row.clean?.cardNumber ?? null,
              isAuto: row.clean?.isAuto ?? false,
              // Defensive fallback: legacy staging rows classified
              // before data-clean extracted grade will have null here.
              // Re-parse the title so the triage UI sees PSA 7 / BGS 9.5
              // when it's in the title text.
              gradeCompany: row.clean?.gradeCompany
                ?? (await import("./gradeParser.js")).parseGradeLabel(String(row.raw.vendorPayload.title ?? ""))?.gradeCompany
                ?? null,
              gradeValue: row.clean?.gradeValue
                ?? (await import("./gradeParser.js")).parseGradeLabel(String(row.raw.vendorPayload.title ?? ""))?.gradeValue
                ?? null,
              price: row.clean?.price ?? Number(row.raw.vendorPayload.price ?? 0),
              soldAt: row.clean?.soldAt ?? String(row.raw.vendorPayload.soldAt ?? new Date().toISOString()),
              source: row.raw.vendor,
              sourceExternalId: row.raw.vendorRawId,
              title: String(row.raw.vendorPayload.title ?? ""),
              imageUrl: primaryImage,
              url: row.raw.vendorPayload.url ?? null,
              sellerHandle: null,
              sport: row.raw.identityHint.sport ?? "baseball",
              verifiedByUser: false,
              confidence: 0.3,
            },
            signal: {
              note: catalogRefImage && !row.raw.vendorPayload.imageUrl
                ? `image-verify inconclusive (method=${verification.method}) — showing catalog reference image (vendor had none)`
                : `image-verify inconclusive (method=${verification.method}) — awaiting manual review`,
            },
          });
        } catch { /* enqueue is best-effort */ }
      }
      await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);
    } catch {
      result.errors += 1;
    }
  }
  console.log(JSON.stringify({
    event: "image_verify_batch_complete",
    source: "imageVerifyJob.service",
    ...result,
  }));
  return result;
}

/**
 * Two-tier verification of a single staging row. Never throws —
 * always returns a StagingVerification.
 */
async function verifyRow(row: StagingDoc): Promise<StagingVerification> {
  const now = new Date().toISOString();
  // Prefer our mirrored blob; fall back to the vendor's original URL
  // for legacy-migrated rows that haven't been mirrored yet. Vision +
  // pHash both accept a public URL, so this works either way — the
  // mirror is a permanence bonus, not a hard requirement for
  // verification.
  const imageUrl = row.mirroredImage?.blobUrl
    ?? row.raw.vendorPayload.imageUrl
    ?? null;
  if (!imageUrl || row.mirroredImage?.mirrorError && !row.raw.vendorPayload.imageUrl) {
    return {
      verifiedAt: now,
      method: "no-image-available",
      matched: false,
      detail: row.mirroredImage?.mirrorError
        ? `mirror failed AND no vendor URL fallback: ${row.mirroredImage.mirrorError.reason}`
        : "no image URL available (vendor omitted + no mirror)",
    };
  }
  const mirroredUrl = String(imageUrl);

  // Tier 1: pHash vs catalog reference.
  const catalogEntry = await getCatalogEntry(row.hobbyiqCardId);
  const referenceHash = catalogEntry?.referenceImage?.phash;
  const ingestHash = await computeImageHash(mirroredUrl);
  if (!ingestHash) {
    return {
      verifiedAt: now,
      method: "no-image-available",
      matched: false,
      detail: "computeImageHash returned null on our mirrored image",
    };
  }

  if (referenceHash) {
    const classification = classifyImageMatch(referenceHash, ingestHash);
    if (classification.verdict === "match") {
      return {
        verifiedAt: now,
        method: "phash-match",
        matched: true,
        phash: {
          ingestHash,
          referenceHash,
          distance: classification.distance ?? 0,
          similarity: classification.similarity ?? 1,
        },
      };
    }
    // pHash mismatch → try Tier 2 for tie-break.
  }

  // Tier 2: Azure Vision OCR + token check.
  const ocr = await ocrImageUrl(mirroredUrl);
  if (!ocr.ok) {
    return {
      verifiedAt: now,
      method: "no-catalog-reference",
      matched: false,
      detail: referenceHash ? `pHash mismatched (distance high) AND OCR failed: ${ocr.error}` : `no catalog reference AND OCR failed: ${ocr.error}`,
    };
  }

  const parsed = parseHobbyIqCardId(row.hobbyiqCardId);
  const tokens = checkTokensAgainstOcr(ocr.rawText, {
    playerName: row.raw.identityHint.playerName ?? null,
    cardNumber: parsed?.cardNumber ?? null,
    cardYear: parsed?.year ?? row.raw.identityHint.cardYear ?? null,
    parallel: null,   // parallel is often not in slab label; skip for now
  });
  // Consider verified if at least 2 of {player, cardNumber, year}
  // appear in the OCR text.
  const matched = tokens.matchedTokens.length >= 2;
  return {
    verifiedAt: now,
    method: "vision-tokens",
    matched,
    detail: `matched=[${tokens.matchedTokens.join(",")}] missing=[${tokens.missingTokens.join(",")}]`,
    vision: {
      rawText: ocr.rawText.slice(0, 500),
      extractedTokens: tokens.matchedTokens,
      confidence: ocr.confidence,
    },
  };
}
