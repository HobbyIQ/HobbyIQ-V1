import { randomUUID } from "crypto";
import {
  BlobServiceClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  UserDelegationKey,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

// ── Tunable constants per the multi-tab migration ADR §3.4 ──────────────────
const STORAGE_ACCOUNT_NAME = process.env.AZURE_PHOTO_STORAGE_ACCOUNT ?? "stghobbyiqdev";
const CONTAINER_NAME = process.env.AZURE_PHOTO_CONTAINER ?? "card-images";
const SAS_EXPIRY_MINUTES = 15;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB hard cap on upload

const ACCOUNT_URL = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`;

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

// ── Lazy singletons (module-scoped — no DI to keep route surface small) ─────
let _blobServiceClient: BlobServiceClient | null = null;
function getBlobServiceClient(): BlobServiceClient {
  if (!_blobServiceClient) {
    _blobServiceClient = new BlobServiceClient(
      ACCOUNT_URL,
      new DefaultAzureCredential(),
    );
  }
  return _blobServiceClient;
}

// Test/DI hook — allows tests to inject a mocked BlobServiceClient.
export function __setBlobServiceClientForTests(client: BlobServiceClient | null): void {
  _blobServiceClient = client;
}

export interface SasUploadUrlResponse {
  uploadUrl: string;
  blobUrl: string;
  blobName: string;
  containerName: string;
  contentType: string;
  maxSizeBytes: number;
  expiresAt: string;
}

export interface IssueSasUploadUrlOptions {
  userId: string;
  clientId?: string;
  fileExtension?: string;
}

function normalizeExtension(input: string | undefined): string {
  const ext = (input ?? "jpg").toLowerCase().replace(/^\./, "");
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
  return ext;
}

function contentTypeFor(ext: string): string {
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

// userId/clientId components are sanitized to keep blob paths predictable and
// to prevent path traversal or query-string injection via odd characters.
function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_\-]/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function issueSasUploadUrl(opts: IssueSasUploadUrlOptions): Promise<SasUploadUrlResponse> {
  if (!opts.userId || !String(opts.userId).trim()) {
    throw new Error("userId is required");
  }
  const ext = normalizeExtension(opts.fileExtension);
  const contentType = contentTypeFor(ext);

  const userSeg = sanitizeSegment(String(opts.userId), "anonymous");
  const clientSeg = sanitizeSegment(String(opts.clientId ?? ""), "general");
  const blobName = `${userSeg}/${clientSeg}/${Date.now()}-${randomUUID()}.${ext}`;

  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobName);

  const startsOn = new Date(Date.now() - 60 * 1000); // 1 min back-dated for clock skew
  const expiresOn = new Date(Date.now() + SAS_EXPIRY_MINUTES * 60 * 1000);

  const userDelegationKey: UserDelegationKey = await blobServiceClient.getUserDelegationKey(
    startsOn,
    expiresOn,
  );

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName,
      permissions: BlobSASPermissions.parse("cw"), // create + write only
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
      contentType,
    },
    userDelegationKey,
    STORAGE_ACCOUNT_NAME,
  );

  const uploadUrl = `${blobClient.url}?${sas.toString()}`;
  const blobUrl = blobClient.url; // permanent URL (no SAS) used as the persistent reference

  return {
    uploadUrl,
    blobUrl,
    blobName,
    containerName: CONTAINER_NAME,
    contentType,
    maxSizeBytes: MAX_PHOTO_BYTES,
    expiresAt: expiresOn.toISOString(),
  };
}

// Parse a blob URL and validate it points at our configured account +
// container. Returns the blob name. Shared by deleteBlobByUrl and
// downloadBlobByUrl below.
function parseBlobUrlOrThrow(blobUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    throw new Error(`Invalid blob URL: ${blobUrl}`);
  }

  const expectedHost = `${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`;
  if (parsed.host.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error(`Blob URL host does not match configured storage account: ${parsed.host}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0] !== CONTAINER_NAME) {
    throw new Error(`Invalid blob URL for our container: ${blobUrl}`);
  }
  return segments.slice(1).map((s) => decodeURIComponent(s)).join("/");
}

export async function deleteBlobByUrl(blobUrl: string): Promise<void> {
  const blobName = parseBlobUrlOrThrow(blobUrl);
  const blobServiceClient = getBlobServiceClient();
  const blobClient = blobServiceClient
    .getContainerClient(CONTAINER_NAME)
    .getBlobClient(blobName);

  try {
    await blobClient.delete();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number; details?: { errorCode?: string } } | null)?.statusCode;
    if (statusCode === 404) return;
    throw err;
  }
}

/**
 * CF-ACCOUNT-DELETION (2026-06-04): enumerate every blob under a user's
 * sanitized prefix and delete each. Mirrors `uploadCardPhoto`'s
 * `${sanitizeSegment(userId)}/...` path scheme — so the same input userId
 * resolves to the same path-prefix that owned the uploads.
 *
 * Returns the count of blobs deleted. Errors on individual blobs are
 * logged + skipped (so a transient transport failure on one photo doesn't
 * abort the whole purge). Returns 0 cleanly when the user has no photos
 * or when storage is unconfigured.
 */
export async function deleteAllBlobsForUser(userId: string): Promise<number> {
  if (!userId || !String(userId).trim()) return 0;
  let serviceClient;
  try {
    serviceClient = getBlobServiceClient();
  } catch (err: unknown) {
    console.warn("[photoStorage] deleteAllBlobsForUser: storage unconfigured —", (err as Error)?.message);
    return 0;
  }
  const containerClient = serviceClient.getContainerClient(CONTAINER_NAME);
  const userPrefix = `${sanitizeSegment(String(userId), "anonymous")}/`;

  let deleted = 0;
  try {
    for await (const blob of containerClient.listBlobsFlat({ prefix: userPrefix })) {
      try {
        await containerClient.getBlobClient(blob.name).delete();
        deleted += 1;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 404) continue;
        console.error("[photoStorage] deleteAllBlobsForUser item failed:", (err as Error)?.message ?? err);
      }
    }
  } catch (err: unknown) {
    console.error("[photoStorage] deleteAllBlobsForUser listing failed:", (err as Error)?.message ?? err);
  }
  return deleted;
}

// CF-CARDSIGHT-IDENTIFY-INTEGRATION: download a blob's bytes by URL
// for server-side forwarding to Cardsight identify. Reuses the same
// URL validation as deleteBlobByUrl so callers can't trick this into
// downloading from arbitrary storage accounts.
export async function downloadBlobByUrl(blobUrl: string): Promise<Buffer> {
  const blobName = parseBlobUrlOrThrow(blobUrl);
  const blobServiceClient = getBlobServiceClient();
  const blobClient = blobServiceClient
    .getContainerClient(CONTAINER_NAME)
    .getBlobClient(blobName);

  return await blobClient.downloadToBuffer();
}

export const PHOTO_STORAGE_CONFIG = {
  accountName: STORAGE_ACCOUNT_NAME,
  containerName: CONTAINER_NAME,
  sasExpiryMinutes: SAS_EXPIRY_MINUTES,
  maxPhotoBytes: MAX_PHOTO_BYTES,
  allowedExtensions: Array.from(ALLOWED_EXT),
} as const;
