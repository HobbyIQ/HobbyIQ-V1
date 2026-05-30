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
