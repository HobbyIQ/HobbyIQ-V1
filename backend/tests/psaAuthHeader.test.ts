// CF-PSA-AUTH-RAW-TOKEN (Drew, 2026-07-27). Pins the wire format for
// PSA's publicapi: raw token, no "Bearer " prefix. Reproduced live
// 2026-07-27 against cert 76556858 — with prefix, PSA returned 403
// "approved customers only"; without prefix, auth passed (429 quota was
// the only remaining signal on the same path).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("CF-PSA-AUTH-RAW-TOKEN — outgoing auth header format", () => {
  const originalToken = process.env.PSA_API_BEARER_TOKEN;
  const originalTimeout = process.env.PSA_API_TIMEOUT_MS;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.PSA_API_TIMEOUT_MS = "1000";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ PSACert: { CertNumber: "76556858" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalToken === undefined) delete process.env.PSA_API_BEARER_TOKEN;
    else process.env.PSA_API_BEARER_TOKEN = originalToken;
    if (originalTimeout === undefined) delete process.env.PSA_API_TIMEOUT_MS;
    else process.env.PSA_API_TIMEOUT_MS = originalTimeout;
  });

  it("sends the raw token when stored without a Bearer prefix", async () => {
    process.env.PSA_API_BEARER_TOKEN = "abc123RAW";
    const { lookupPsaCertByNumber } = await import("../src/services/psa/psaCert.service.js");
    await lookupPsaCertByNumber("76556858");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("abc123RAW");
    expect(auth).not.toMatch(/^Bearer\b/i);
  });

  it("strips a leading Bearer if stored with one (defensive)", async () => {
    process.env.PSA_API_BEARER_TOKEN = "Bearer abc123RAW";
    vi.resetModules();
    const { lookupPsaCertByNumber } = await import("../src/services/psa/psaCert.service.js");
    await lookupPsaCertByNumber("76556858");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("abc123RAW");
  });
});
