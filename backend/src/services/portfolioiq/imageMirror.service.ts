// CF-IMAGE-MIRROR (Drew, 2026-07-28).
//
// Downloads a vendor image URL and mirrors it to our own Azure Blob
// storage so we OWN the artifact permanently. Vendor CDNs rotate,
// eBay listings get delisted, bubble.io URLs expire — none of that
// affects our verification pipeline once we've mirrored.
//
// Container: `comps-staging-images` (provisioned 2026-07-28 alongside
// the staging-first ingest architecture). Path scheme:
//     {yyyy}/{mm}/{dd}/{contentHash8}-{stagingId}.{ext}
//
// Content-hash prefix in the blob name means identical vendor images
// (CH + CS reporting the same eBay sale) resolve to co-located blobs
// under the same folder — makes duplicate cleanup + audit easier.
//
// Auth: DefaultAzureCredential — reuses the App Service managed
// identity that already has Blob Data Contributor on stghobbyiqdev.
// Local dev falls back to az login credentials automatically.

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { createHash } from "crypto";

// CF-STAGING-BLOB-COLOCATE (Drew, 2026-07-28). Reuse the existing
// `card-images` container that the App Service managed identity
// already has Storage Blob Data Contributor on. Vendor mirrors live
// under the `vendor-mirror/` path prefix so lifecycle rules can
// still target them independently of user-uploaded card photos.
// Provisioned `comps-staging-images` container stays available for
// future migration when we can grant the identity access to it.
const STORAGE_ACCOUNT_NAME = process.env.AZURE_PHOTO_STORAGE_ACCOUNT ?? "stghobbyiqdev";
const CONTAINER_NAME = process.env.AZURE_COMPS_STAGING_CONTAINER ?? "card-images";
const PATH_PREFIX = process.env.AZURE_COMPS_STAGING_PATH_PREFIX ?? "vendor-mirror";
const ACCOUNT_URL = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`;

// Match the sizing gate from photoStorage — vendor CDNs shouldn't
// serve 100MB images but a runaway response body could OOM the node.
const MAX_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

// CF-MIRROR-UPLOAD-RETRY (Drew, 2026-08-13: "do it upgrade me").
//
// The premise going in was that mirroring was denied account-wide and needed a
// permission upgrade. It isn't, and it doesn't. Measured 2026-08-13 against
// prod: Storage Blob Data Contributor has been on `card-images` since
// 2026-05-20, the App Service has one system-assigned identity (no
// DefaultAzureCredential ambiguity), the account's network default is Allow,
// and 19,570 of 20,000 sampled attempts (97.9%) SUCCEEDED — with fresh blobs
// landing under vendor-mirror/2026/08/13/ while the failures all carried a
// mirroredAt days old. Nothing was upgraded because nothing was misconfigured.
//
// What's real: those 2.1% are transient 403s
// ("This request is not authorized to perform this operation using this
// permission" — AuthorizationPermissionMismatch), and the upload was a SINGLE
// attempt. mirrorVendorImage has exactly one caller (persistVendorSalesToPool,
// at ingest) and nothing anywhere re-mirrors a row, so one blip cost that sale
// its image permanently — the row keeps a stale mirrorError forever.
//
// Retrying is safe because the upload is already idempotent by construction:
// the blob name is content-hash + stagingId and Azure overwrites by default,
// so a retry rewrites identical bytes to the identical path.
//
// Deliberately NOT classifying which errors are retryable. A 403 reads as
// permanent and empirically was not — that misread is what made this a silent
// data-loss path. Bounded attempts with short backoff cost ~1.25s on a row
// that is genuinely unwritable, which is cheaper than being wrong again.
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_BACKOFF_MS = [250, 1000];

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

let _blobService: BlobServiceClient | null = null;
function getBlobService(): BlobServiceClient {
  if (!_blobService) {
    _blobService = new BlobServiceClient(ACCOUNT_URL, new DefaultAzureCredential());
  }
  return _blobService;
}

// Test-only hook (mirrors photoStorage's pattern)
export function __setBlobServiceForTests(client: BlobServiceClient | null): void {
  _blobService = client;
}

export interface MirroredImage {
  /** Permanent URL to the blob (no SAS, container is private). */
  blobUrl: string;
  /** SHA-256 hex of the raw bytes — cross-source dedup key. */
  contentHash: string;
  /** Bytes stored. */
  size: number;
  /** MIME type as reported by the vendor / detected from magic bytes. */
  contentType: string;
  /** Blob path (year/month/day/hash-id.ext). */
  blobName: string;
  /** Original vendor URL, kept for lineage. */
  originalUrl: string;
  /** ISO timestamp when we fetched. */
  mirroredAt: string;
}

export interface MirrorError {
  ok: false;
  reason: "unreachable" | "too-large" | "wrong-type" | "empty" | "write-failed";
  detail?: string;
  originalUrl: string;
}

export type MirrorResult = { ok: true; image: MirroredImage } | MirrorError;

function todayPathSegments(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Download `vendorImageUrl` and mirror it to our blob storage.
 * `stagingId` becomes part of the blob name so we can trace back to
 * the staging row that requested this mirror.
 *
 * Silent-safe: any failure returns a MirrorError (never throws).
 * Callers persist the reason code on the staging row.
 */
export async function mirrorVendorImage(
  vendorImageUrl: string,
  stagingId: string,
): Promise<MirrorResult> {
  if (!vendorImageUrl || typeof vendorImageUrl !== "string") {
    return { ok: false, reason: "unreachable", detail: "missing URL", originalUrl: vendorImageUrl };
  }

  // Fetch
  let bytes: Buffer;
  let contentType: string;
  try {
    const res = await fetch(vendorImageUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: "image/*" },
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}`, originalUrl: vendorImageUrl };
    }
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    contentType = ct || "image/jpeg";  // vendor may not send content-type — default to jpeg
    if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { ok: false, reason: "wrong-type", detail: contentType, originalUrl: vendorImageUrl };
    }
    const ab = await res.arrayBuffer();
    bytes = Buffer.from(ab);
    if (bytes.length === 0) {
      return { ok: false, reason: "empty", originalUrl: vendorImageUrl };
    }
    if (bytes.length > MAX_BYTES) {
      return { ok: false, reason: "too-large", detail: `${bytes.length} bytes`, originalUrl: vendorImageUrl };
    }
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: (err as Error)?.message ?? String(err), originalUrl: vendorImageUrl };
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? "jpg";
  const blobName = `${PATH_PREFIX}/${todayPathSegments()}/${contentHash.slice(0, 8)}-${stagingId}.${ext}`;

  // Upload — bounded retry, see CF-MIRROR-UPLOAD-RETRY.
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const svc = getBlobService();
      const container = svc.getContainerClient(CONTAINER_NAME);
      const blob = container.getBlockBlobClient(blobName);
      // If the same content-hash+stagingId ever collides, that's fine —
      // Azure blob upload will overwrite by default and the bytes are
      // identical (idempotent). That property is also what makes the
      // retry above safe.
      await blob.uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          stagingId,
          vendorUrl: vendorImageUrl.length <= 2048 ? vendorImageUrl : vendorImageUrl.slice(0, 2048),
          contentHash,
        },
      });
      return {
        ok: true,
        image: {
          blobUrl: blob.url,
          contentHash,
          size: bytes.length,
          contentType,
          blobName,
          originalUrl: vendorImageUrl,
          mirroredAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      lastErr = err;
      const backoff = UPLOAD_BACKOFF_MS[attempt - 1];
      if (attempt < UPLOAD_ATTEMPTS && backoff !== undefined) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  // Record the attempt count: a row that failed 3× is a different problem from
  // one that failed once, and without this the two are indistinguishable in
  // the staging data — which is how the account-wide theory survived so long.
  const detail = (lastErr as Error)?.message ?? String(lastErr);
  return {
    ok: false,
    reason: "write-failed",
    detail: `[${UPLOAD_ATTEMPTS} attempts] ${detail}`,
    originalUrl: vendorImageUrl,
  };
}
