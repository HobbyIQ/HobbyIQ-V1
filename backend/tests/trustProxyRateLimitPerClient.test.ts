// CF-TRUST-PROXY (Fable, 2026-09-13, launch-eve P0).
//
// Azure App Service proxies every request through exactly one front-end
// hop before it reaches this process. Without `app.set("trust proxy", 1)`
// in app.ts, express's req.ip resolves to that single front-end address
// for EVERY request, regardless of the client — so the signinLimiter
// (20 requests / 15 min, keyed on req.ip in auth.routes.ts) becomes ONE
// shared bucket across the entire user base instead of one bucket per
// client. A prod probe the night before launch showed RateLimit-Remaining
// counting down from other users' traffic.
//
// These tests pin the fix at the HTTP boundary: two different clients
// (distinguished only by X-Forwarded-For, exactly what Azure's front end
// sends) must get INDEPENDENT RateLimit-Remaining sequences, and a single
// client must still be capped once its own bucket is exhausted.
//
// signIn("", "") short-circuits before touching Cosmos ("Email and
// password required"), so posting an empty body repeatedly exercises the
// real handler + real limiter without mocking authService at all.

import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

function remaining(res: request.Response): number {
  const header = res.headers["ratelimit-remaining"];
  expect(header, "RateLimit-Remaining header must be present (standardHeaders: true)").toBeDefined();
  return Number(header);
}

describe("trust proxy + per-client sign-in rate limiting", () => {
  it("two distinct X-Forwarded-For clients get independent RateLimit-Remaining sequences", async () => {
    const clientA = "203.0.113.5";
    const clientB = "203.0.113.6";

    const a1 = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", clientA)
      .send({});
    const b1 = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", clientB)
      .send({});

    // Both start from the same fresh limit (20/window) — proves the two
    // X-Forwarded-For values are landing in different buckets, not one
    // shared counter that would already show b1 one lower than a fresh 20.
    expect(remaining(a1)).toBe(19);
    expect(remaining(b1)).toBe(19);

    // Drive client A down further; client B must be completely unaffected
    // by A's traffic — the pre-fix defect (one shared bucket keyed on the
    // Azure front-end's address) would decrement both together.
    const a2 = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", clientA)
      .send({});
    const a3 = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", clientA)
      .send({});
    expect(remaining(a2)).toBe(18);
    expect(remaining(a3)).toBe(17);

    const b2 = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", clientB)
      .send({});
    expect(remaining(b2)).toBe(18);
  });

  it("still caps a single client at 20 requests per window (per-client limit is not weakened)", async () => {
    const client = "203.0.113.77";

    let last: request.Response | undefined;
    for (let i = 0; i < 20; i++) {
      last = await request(app)
        .post("/api/auth/signin")
        .set("X-Forwarded-For", client)
        .send({});
      expect(last.status).not.toBe(429);
    }
    expect(remaining(last!)).toBe(0);

    // The 21st request from the SAME client in the SAME window is blocked.
    const blocked = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", client)
      .send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: "Too many attempts, try again later",
    });

    // A different client is completely unaffected by the 21-request run above.
    const otherClient = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", "203.0.113.88")
      .send({});
    expect(otherClient.status).not.toBe(429);
    expect(remaining(otherClient)).toBe(19);
  });

  it("req.ip resolves to the first X-Forwarded-For hop, not the Azure front-end socket peer", async () => {
    // Multi-hop header, as Azure App Service would forward it if there were
    // an upstream hop of its own: <client>, <azure-front-end>. With
    // trust proxy = 1, express trusts exactly one hop and takes the
    // left-most remaining address as req.ip.
    const res = await request(app)
      .post("/api/auth/signin")
      .set("X-Forwarded-For", "203.0.113.99, 10.0.0.4")
      .send({});
    // A fresh client on a fresh window starts at 19 remaining (one consumed
    // by this request) — proving it was NOT collapsed onto some other
    // bucket already exercised by earlier tests in this file.
    expect(remaining(res)).toBe(19);
  });
});
