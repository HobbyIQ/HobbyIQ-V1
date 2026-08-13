// CF-IMAGE-MIRROR (Drew, 2026-07-28). Surface tests — the real
// download+upload path needs Azure and a live vendor URL; those are
// integration tests. Here we pin the module surface, the error
// classification, and the silent-safe contract.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mirrorVendorImage,
  __setBlobServiceForTests,
  type MirrorResult,
} from "../src/services/portfolioiq/imageMirror.service.js";

function isError(r: MirrorResult): r is Extract<MirrorResult, { ok: false }> {
  return r.ok === false;
}

describe("mirrorVendorImage — surface", () => {
  it("empty URL → unreachable error, never throws", async () => {
    const r = await mirrorVendorImage("", "staging-1");
    expect(isError(r)).toBe(true);
    if (isError(r)) {
      expect(r.reason).toBe("unreachable");
      expect(r.originalUrl).toBe("");
    }
  });

  it("garbage URL → unreachable error, never throws", async () => {
    const r = await mirrorVendorImage("not-a-real-url", "staging-2");
    expect(isError(r)).toBe(true);
    if (isError(r)) expect(r.reason).toBe("unreachable");
  });

  it("null-ish input → unreachable, never throws", async () => {
    const r = await mirrorVendorImage(null as unknown as string, "staging-3");
    expect(isError(r)).toBe(true);
    if (isError(r)) expect(r.reason).toBe("unreachable");
  });
});

// CF-MIRROR-UPLOAD-RETRY. The upload used to be a single attempt, and
// mirrorVendorImage has exactly one caller (persistVendorSalesToPool, at
// ingest) with nothing anywhere re-mirroring a row — so one transient 403 cost
// that sale its image permanently. Measured on prod 2026-08-13: 97.9% of
// attempts succeed, and the 2.1% that don't are transient, NOT a permission
// misconfiguration (the role has been correct since 2026-05-20).
describe("mirrorVendorImage — upload retry", () => {
  afterEach(() => {
    __setBlobServiceForTests(null);
    vi.unstubAllGlobals();
  });

  /** A vendor response carrying one valid JPEG byte. */
  function stubFetchOk(): void {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff]).buffer,
    }));
  }

  /** Blob stub that throws for the first `failures` uploads, then succeeds. */
  function stubBlob(failures: number) {
    const calls = { uploads: 0 };
    const client = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          url: "https://stghobbyiqdev.blob.core.windows.net/card-images/x.jpg",
          uploadData: async () => {
            calls.uploads++;
            if (calls.uploads <= failures) {
              // The exact prod failure: AuthorizationPermissionMismatch.
              throw new Error(
                "This request is not authorized to perform this operation using this permission.",
              );
            }
          },
        }),
      }),
    };
    __setBlobServiceForTests(client as never);
    return calls;
  }

  it("recovers when the first upload fails transiently", async () => {
    stubFetchOk();
    const calls = stubBlob(1);
    const r = await mirrorVendorImage("https://vendor.example/card.jpg", "staging-retry-1");
    expect(r.ok).toBe(true);
    expect(calls.uploads).toBe(2);
  });

  it("does not retry when the first upload succeeds", async () => {
    stubFetchOk();
    const calls = stubBlob(0);
    const r = await mirrorVendorImage("https://vendor.example/card.jpg", "staging-retry-2");
    expect(r.ok).toBe(true);
    expect(calls.uploads).toBe(1);
  });

  it("gives up after a bounded number of attempts and says how many", async () => {
    stubFetchOk();
    const calls = stubBlob(Number.MAX_SAFE_INTEGER);
    const r = await mirrorVendorImage("https://vendor.example/card.jpg", "staging-retry-3");
    expect(isError(r)).toBe(true);
    if (isError(r)) {
      expect(r.reason).toBe("write-failed");
      // Attempt count is recorded so a 3×-failed row is distinguishable from a
      // one-blip row in the staging data — without it, the "account-wide
      // outage" reading of a 2% transient failure rate is unfalsifiable.
      expect(r.detail).toContain("3 attempts");
      expect(r.detail).toContain("not authorized");
    }
    expect(calls.uploads).toBe(3);
  });

  it("stays silent-safe — a permanently failing upload never throws", async () => {
    stubFetchOk();
    stubBlob(Number.MAX_SAFE_INTEGER);
    await expect(
      mirrorVendorImage("https://vendor.example/card.jpg", "staging-retry-4"),
    ).resolves.toBeDefined();
  });
});
