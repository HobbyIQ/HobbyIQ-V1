// CF-ADMIN-GATE-SCOPE (Drew, 2026-08-12). Regression pin for a live
// production outage.
//
// Several admin routers are mounted at the BARE "/api" path in app.ts. An
// unscoped `router.use(requireAdmin)` inside one of those routers runs for
// every /api/* request that reaches it — and requireAdmin ends the response
// instead of calling next(). That made every route mounted after it in
// app.ts unreachable: 401 "Invalid admin token" in production (where
// ADMIN_API_TOKEN is set) and 503 in CI (where it isn't).
//
// It shipped 2026-07-31 with the variant labeler and went unnoticed for
// ~12 days because backend-tests was already red, so nothing gated it.
// /api/account (Apple Guideline 5.1.1(v) account deletion) and
// /api/subscriptions (Apple receipt verification) were both dead.
//
// These tests assert the two halves of the contract:
//   1. non-admin routes mounted after an admin router are NOT shadowed
//   2. admin routes are still actually gated
//
// ADMIN_API_TOKEN is deliberately left unset so a re-broken gate surfaces
// as the unmistakable 503 rather than a plausible-looking 401.

import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";
delete process.env.ADMIN_API_TOKEN;

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getUserBySession: vi.fn(async () => null) };
});

let app: any;
beforeAll(async () => {
  app = (await import("../src/app")).default;
});

/** Routes mounted AFTER the bare-"/api" admin routers in app.ts. Each must
 *  reach its own auth gate — never the admin gate. */
const SHADOW_VICTIMS: Array<{ method: "get" | "delete"; path: string }> = [
  { method: "delete", path: "/api/account" },
  { method: "get", path: "/api/entitlements/me" },
];

describe("admin gate is path-scoped, not blanket /api", () => {
  for (const { method, path } of SHADOW_VICTIMS) {
    it(`${method.toUpperCase()} ${path} is not shadowed by the admin gate`, async () => {
      const res = await (request(app) as any)[method](path).send({});

      // The precise failure we are guarding against.
      expect(res.body?.error ?? "").not.toMatch(/admin/i);
      expect(res.status).not.toBe(503);

      // Unauthenticated, so the route's OWN gate should answer.
      expect(res.status).toBe(401);
    });
  }

  it("still gates the admin routes it is supposed to protect", async () => {
    // ADMIN_API_TOKEN is unset here, so a correctly-scoped gate returns the
    // "disabled" 503 for admin paths — proving the gate still fires.
    const res = await request(app).get("/api/labeler/queue");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ADMIN_API_TOKEN not configured/);
  });

  it("gates both prefixes served by the verify-queue router", async () => {
    for (const p of ["/api/verify/queue", "/api/data-quality/report"]) {
      const res = await request(app).get(p);
      expect(res.status, `${p} should still be admin-gated`).toBe(503);
    }
  });
});
