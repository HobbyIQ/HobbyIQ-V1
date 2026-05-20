/**
 * Unit tests for the photoStorage service â€” SAS issuance + blob deletion.
 *
 * The Azure SDK is mocked at module scope so these tests don't touch the
 * network and don't require Azure credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteMock = vi.fn();
const getBlobClientMock = vi.fn();
const getContainerClientMock = vi.fn();
const getUserDelegationKeyMock = vi.fn();
const generateBlobSASQueryParametersMock = vi.fn();

const blobUrlFor = (blobName: string) =>
  `https://stghobbyiqdev.blob.core.windows.net/card-images/${blobName}`;

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor() {}
  },
}));

vi.mock("@azure/storage-blob", () => {
  class FakeBlobSASPermissions {
    static parse(_: string) {
      return new FakeBlobSASPermissions();
    }
  }
  const FakeSASProtocol = { Https: "https" };

  class FakeBlobServiceClient {
    constructor(_url: string, _cred: unknown) {}
    getContainerClient(_name: string) {
      return getContainerClientMock(_name);
    }
    async getUserDelegationKey(start: Date, expiry: Date) {
      return getUserDelegationKeyMock(start, expiry);
    }
  }

  return {
    BlobServiceClient: FakeBlobServiceClient,
    BlobSASPermissions: FakeBlobSASPermissions,
    SASProtocol: FakeSASProtocol,
    generateBlobSASQueryParameters: (...args: unknown[]) =>
      generateBlobSASQueryParametersMock(...args),
  };
});

// Default mock wiring â€” reset per-test in beforeEach.
beforeEach(() => {
  vi.resetModules();
  deleteMock.mockReset();
  getBlobClientMock.mockReset();
  getContainerClientMock.mockReset();
  getUserDelegationKeyMock.mockReset();
  generateBlobSASQueryParametersMock.mockReset();

  getContainerClientMock.mockImplementation(() => ({
    getBlobClient: (blobName: string) => {
      const url = blobUrlFor(blobName);
      return getBlobClientMock(blobName) ?? {
        url,
        delete: deleteMock,
      };
    },
  }));
  getUserDelegationKeyMock.mockResolvedValue({ signedObjectId: "x" });
  generateBlobSASQueryParametersMock.mockReturnValue({
    toString: () => "sv=2024-01-01&sig=fake",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("photoStorage.issueSasUploadUrl", () => {
  it("returns the expected SAS response shape with 8MB cap", async () => {
    const { issueSasUploadUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );

    const out = await issueSasUploadUrl({
      userId: "user-abc",
      clientId: "card-xyz",
      fileExtension: "jpg",
    });

    expect(out.uploadUrl).toContain("sv=2024-01-01");
    expect(out.uploadUrl.startsWith(out.blobUrl + "?")).toBe(true);
    expect(out.blobUrl).toMatch(
      /^https:\/\/stghobbyiqdev\.blob\.core\.windows\.net\/card-images\/user-abc\/card-xyz\/\d+-[0-9a-f-]+\.jpg$/,
    );
    expect(out.blobName).toMatch(
      /^user-abc\/card-xyz\/\d+-[0-9a-f-]+\.jpg$/,
    );
    expect(out.containerName).toBe("card-images");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.maxSizeBytes).toBe(8 * 1024 * 1024);
    expect(typeof out.expiresAt).toBe("string");
    expect(Number.isFinite(Date.parse(out.expiresAt))).toBe(true);
  });

  it("falls back to 'general/' segment when clientId is missing", async () => {
    const { issueSasUploadUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );
    const out = await issueSasUploadUrl({ userId: "user-1", fileExtension: "png" });
    expect(out.blobName).toMatch(/^user-1\/general\/\d+-[0-9a-f-]+\.png$/);
    expect(out.contentType).toBe("image/png");
  });

  it("rejects unsupported file extensions (gif, bmp)", async () => {
    const { issueSasUploadUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );
    await expect(
      issueSasUploadUrl({ userId: "u", fileExtension: "gif" }),
    ).rejects.toThrow(/Unsupported file extension/);
    await expect(
      issueSasUploadUrl({ userId: "u", fileExtension: "bmp" }),
    ).rejects.toThrow(/Unsupported file extension/);
  });

  it("requires a non-empty userId", async () => {
    const { issueSasUploadUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );
    await expect(
      issueSasUploadUrl({ userId: "", fileExtension: "jpg" }),
    ).rejects.toThrow(/userId is required/);
  });
});

describe("photoStorage.deleteBlobByUrl", () => {
  it("calls blob.delete() for a well-formed URL on the configured account", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    const { deleteBlobByUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );

    await deleteBlobByUrl(
      "https://stghobbyiqdev.blob.core.windows.net/card-images/user-1/general/123-abc.jpg",
    );
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a 404 from blob.delete()", async () => {
    deleteMock.mockRejectedValueOnce({ statusCode: 404, message: "BlobNotFound" });
    const { deleteBlobByUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );

    await expect(
      deleteBlobByUrl(
        "https://stghobbyiqdev.blob.core.windows.net/card-images/user-1/general/missing.jpg",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects URLs from a different storage account", async () => {
    const { deleteBlobByUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );
    await expect(
      deleteBlobByUrl(
        "https://otheraccount.blob.core.windows.net/card-images/user-1/x.jpg",
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects URLs that don't target our container", async () => {
    const { deleteBlobByUrl } = await import(
      "../src/services/photoStorage/photoStorage.service.js"
    );
    await expect(
      deleteBlobByUrl(
        "https://stghobbyiqdev.blob.core.windows.net/some-other-container/user-1/x.jpg",
      ),
    ).rejects.toThrow(/Invalid blob URL for our container/);
  });
});
