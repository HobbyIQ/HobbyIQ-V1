// CF-IMAGE-MIRROR (Drew, 2026-07-28). Surface tests — the real
// download+upload path needs Azure and a live vendor URL; those are
// integration tests. Here we pin the module surface, the error
// classification, and the silent-safe contract.

import { describe, expect, it } from "vitest";
import { mirrorVendorImage, type MirrorResult } from "../src/services/portfolioiq/imageMirror.service.js";

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
