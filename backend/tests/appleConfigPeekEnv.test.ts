// CF-PAYMENTS-APPLE-PEEK-ENV-FIX (2026-06-04):
// Regression pin for the ASSN V2 payload shape — `environment` is nested
// inside `data`, not top-level. The original implementation returned
// "Production" by default on every real V2 notification (silent bug;
// surfaced via the end-to-end test notif fire on 2026-06-04). Tests cover
// both V2 (nested) and V1 (top-level) shapes plus malformed inputs.

import { describe, expect, it } from "vitest";
import { peekJwsEnvironment } from "../src/services/subscriptions/appleConfig.js";

function makeJws(payload: Record<string, unknown>): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" }))
    .toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  // peekJwsEnvironment doesn't verify the signature, so a fake sig is fine.
  return `${headerB64}.${payloadB64}.fakesig`;
}

describe("peekJwsEnvironment — ASSN V2 schema (nested under data)", () => {
  it("returns 'Sandbox' when data.environment === 'Sandbox'", () => {
    const jws = makeJws({
      notificationType: "TEST",
      data: { bundleId: "com.example", environment: "Sandbox" },
    });
    expect(peekJwsEnvironment(jws)).toBe("Sandbox");
  });

  it("returns 'Production' when data.environment === 'Production'", () => {
    const jws = makeJws({
      notificationType: "DID_RENEW",
      data: { bundleId: "com.example", environment: "Production" },
    });
    expect(peekJwsEnvironment(jws)).toBe("Production");
  });

  it("ignores top-level environment when data.environment is set (data wins)", () => {
    const jws = makeJws({
      environment: "Production",
      data: { environment: "Sandbox" },
    });
    expect(peekJwsEnvironment(jws)).toBe("Sandbox");
  });
});

describe("peekJwsEnvironment — V1 / legacy top-level shape (fallback)", () => {
  it("returns 'Sandbox' when only top-level environment is set", () => {
    const jws = makeJws({ environment: "Sandbox" });
    expect(peekJwsEnvironment(jws)).toBe("Sandbox");
  });

  it("returns 'Production' when only top-level environment is set", () => {
    const jws = makeJws({ environment: "Production" });
    expect(peekJwsEnvironment(jws)).toBe("Production");
  });
});

describe("peekJwsEnvironment — defaults to Production on missing/malformed", () => {
  it("returns 'Production' when no environment is set anywhere", () => {
    const jws = makeJws({ notificationType: "TEST", data: {} });
    expect(peekJwsEnvironment(jws)).toBe("Production");
  });

  it("returns 'Production' on JWS missing a payload segment", () => {
    expect(peekJwsEnvironment("header.")).toBe("Production");
    expect(peekJwsEnvironment("not-a-jws")).toBe("Production");
  });

  it("returns 'Production' on malformed JSON payload", () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
    const bogusB64 = Buffer.from("not valid json").toString("base64url");
    expect(peekJwsEnvironment(`${headerB64}.${bogusB64}.sig`)).toBe("Production");
  });

  it("returns 'Production' when environment is some unknown string", () => {
    const jws = makeJws({ data: { environment: "Staging" } });
    expect(peekJwsEnvironment(jws)).toBe("Production");
  });
});
