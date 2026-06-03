// CF-CARDSIGHT-IDENTIFY-INTEGRATION
//
// Image-based card + grade identification via Cardsight identify endpoint.
// Wraps the two-step pattern: (1) iOS PUTs image to Azure Blob via existing
// SAS flow, (2) backend downloads the blob and forwards bytes to Cardsight.
//
// The route layer (POST /api/portfolio/identify) calls this service with a
// blob URL produced by the existing /api/uploads/card-photo SAS issuer.
//
// Per Phase 1 design decisions:
//   - blob lifecycle: persist (matches existing photoStorage pattern;
//     enables "attach to holding" + audit trail for accuracy tuning)
//   - image to Cardsight: bytes via server-side blob download (NOT URL
//     passthrough -- avoids exposing SAS URL to Cardsight, matches Node
//     SDK signature convention)
//   - response shape: pass-through verbatim from Cardsight (don't filter
//     messages[], don't conflate success: false with error)

import {
  identify as cardsightIdentify,
  CardsightApiError,
  CardsightTimeoutError,
  CardsightValidationError,
  type CardsightIdentifyResponse,
} from "../compiq/cardsight.client.js";
import { downloadBlobByUrl } from "../photoStorage/photoStorage.service.js";
import { extractTextFromImage } from "../azureVision/visionOcr.client.js";
import {
  extractCertCandidate,
  type CertCandidate,
} from "../azureVision/certExtractor.js";

// Re-export error types so the route handler can map them to HTTP status
// codes without depending directly on cardsight.client.
export {
  CardsightApiError,
  CardsightTimeoutError,
  CardsightValidationError,
};
export type { CardsightIdentifyResponse };

// Distinct error type for blob download failures so the route can map
// them to a different status (502 upstream-storage-error) than Cardsight
// errors. Falls back to "downloadBlobByUrl threw something" semantics.
export class IdentifyBlobDownloadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IdentifyBlobDownloadError";
  }
}

function mimeTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

function filenameFromBlobName(blobName: string | undefined): string {
  if (!blobName) return "image.jpg";
  const tail = blobName.split("/").pop() ?? "image.jpg";
  return tail || "image.jpg";
}

/**
 * Identify a card from an image stored at the given blob URL.
 *
 * Flow:
 *   1. Download blob bytes via photoStorage.downloadBlobByUrl (validates
 *      URL matches configured storage account + container).
 *   2. Forward bytes to Cardsight identify via cardsight.client.identify.
 *   3. Return Cardsight response verbatim (caller decides UX from shape).
 *
 * Error mapping (caller, i.e. the route handler, maps these to HTTP):
 *   - IdentifyBlobDownloadError      -> 502 (upstream blob storage failure)
 *   - CardsightValidationError       -> 400 (image too small / wrong format)
 *   - CardsightTimeoutError          -> 504
 *   - CardsightApiError              -> 502 (persistent Cardsight 4xx/5xx)
 *
 * The "success: false" path is NOT treated as an error -- Cardsight returns
 * 200 with success: false when image quality is insufficient or no card
 * detected. Both cases pass through to the route as-is.
 */
export async function identifyCardByBlobUrl(
  blobUrl: string,
  blobName?: string,
): Promise<CardsightIdentifyResponse> {
  let bytes: Buffer;
  try {
    bytes = await downloadBlobByUrl(blobUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IdentifyBlobDownloadError(
      `Failed to download blob for identify: ${msg}`,
      err,
    );
  }

  const filename = filenameFromBlobName(blobName);
  const mimeType = mimeTypeFromFilename(filename);

  // Cardsight client throws CardsightValidationError / CardsightTimeoutError
  // / CardsightApiError as documented in its surface; we let them propagate
  // unchanged so the route handler maps each to the correct HTTP status.
  return await cardsightIdentify(bytes, filename, mimeType);
}

/**
 * CF-GRADED-SCAN-B1+B2 (2026-06-02; refined CF-FINALIZE 2026-06-03):
 * opt-in variant that runs Cardsight identify and — ONLY when Cardsight
 * detects a PSA slab — additionally runs Azure Vision OCR to extract a
 * cert-number candidate.
 *
 * Coherence rule (CF-FINALIZE): Cardsight's native grading{} is the
 * source of truth for grade/company/value across ALL graders (PSA / BGS
 * / SGC / CGC). The cert OCR layer adds value for PSA ONLY because
 * Cardsight's response doesn't carry the PSA cert NUMBER (only the
 * grade). For BGS/SGC/CGC, Cardsight's grading{} is already complete —
 * adding OCR-derived cert digits would conflate two different graders'
 * cert formats and risk emitting a "cert candidate" for a slab whose
 * cert NUMBER format we haven't validated.
 *
 * Returns a WRAPPED response:
 *   { cardsight: <verbatim CardsightIdentifyResponse>,
 *     certCandidate?: { graderId: "psa", certNumber, ocrConfidence } }
 *
 * certCandidate is OMITTED when:
 *   - Cardsight detected a non-PSA grader (BGS / SGC / CGC) OR no grader
 *   - Cardsight detected PSA but OCR is disabled (AZURE_VISION_* unset)
 *   - PSA + OCR succeeded but no 6-12 digit run above confidence floor
 *   - PSA + OCR failed / timed out (best-effort; never blocks)
 *
 * Error model is IDENTICAL to identifyCardByBlobUrl — Cardsight errors
 * propagate unchanged. OCR errors NEVER throw.
 */
export interface IdentifyWithCertExtractionResult {
  cardsight: CardsightIdentifyResponse;
  certCandidate?: CertCandidate;
}

/**
 * True when Cardsight's first detection has grading{} with
 * company.name = "PSA" (case-insensitive). Used to gate the OCR call.
 */
function isPsaDetection(resp: CardsightIdentifyResponse): boolean {
  const first = resp.detections?.[0];
  const companyName = first?.grading?.company?.name;
  return typeof companyName === "string" && companyName.toUpperCase() === "PSA";
}

export async function identifyCardWithCertExtraction(
  blobUrl: string,
  blobName?: string,
): Promise<IdentifyWithCertExtractionResult> {
  let bytes: Buffer;
  try {
    bytes = await downloadBlobByUrl(blobUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IdentifyBlobDownloadError(
      `Failed to download blob for identify: ${msg}`,
      err,
    );
  }

  const filename = filenameFromBlobName(blobName);
  const mimeType = mimeTypeFromFilename(filename);

  // Cardsight first — its grading.company.name decides whether OCR runs.
  // Serial (not parallel as in B1+B2) so we don't pay the Azure Vision
  // API cost for non-PSA slabs. Latency cost: ~500-1500ms extra on PSA
  // scans only; non-PSA scans are now FASTER (skip OCR).
  const cardsight = await cardsightIdentify(bytes, filename, mimeType);

  if (!isPsaDetection(cardsight)) {
    // Non-PSA slab (BGS/SGC/CGC) or no detected grader — Cardsight's
    // grading{} is the complete truth. No certCandidate.
    return { cardsight };
  }

  // PSA detected — attempt OCR + cert extraction. OCR client never
  // throws (returns null on failure); cert extractor returns null when
  // no digit run passes the confidence floor.
  const ocrResult = await extractTextFromImage(bytes);
  const certCandidate = ocrResult
    ? extractCertCandidate(ocrResult.lines) ?? undefined
    : undefined;

  return certCandidate ? { cardsight, certCandidate } : { cardsight };
}
