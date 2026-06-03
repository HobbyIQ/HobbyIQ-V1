// CF-FINALIZE (2026-06-03): dailyIQBriefs entitlement gate tests.
//
// 5 gated routes (per the audit approved at HALT GATE 1):
//   GET /api/dailyiq/            (composite brief — alias)
//   GET /api/dailyiq/brief       (composite brief)
//   GET /api/dailyiq/players/top/mlb
//   GET /api/dailyiq/players/top/milb
//   GET /api/dailyiq/dashboard/player-stats
//
// All five: 401 without x-session-id, 402 for free, pass for investor+
// (investor / pro_seller). collector also 402 because dailyIQBriefs is
// investor+ in the entitlements matrix.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

// Stub heavy brief-builder so the route doesn't hit Cosmos / network on
// the 200 pass-through path. Returns minimal valid shape.
vi.mock("../src/services/dailyiq/dynamicIngestion.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    ingestDailyPlayers: vi.fn(async (date: string) => ({
      date,
      mlb: [],
      milb: [],
      errors: [],
    })),
  };
});

let app: any;

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

const makeUser = (plan: string) => ({
  userId: `u-${plan}`,
  email: `${plan}@t`,
  username: null,
  fullName: null,
  plan,
  createdAt: "2026-01-01T00:00:00Z",
});

const ROUTES: Array<[string, string]> = [
  ["composite brief alias", "/api/dailyiq/"],
  ["composite brief",       "/api/dailyiq/brief"],
  ["top MLB",               "/api/dailyiq/players/top/mlb"],
  ["top MiLB",              "/api/dailyiq/players/top/milb"],
  ["dashboard player-stats","/api/dailyiq/dashboard/player-stats"],
];

describe("CF-FINALIZE — dailyIQBriefs entitlement gate", () => {
  for (const [name, path] of ROUTES) {
    describe(`${name} (${path})`, () => {
      it("401 without x-session-id", async () => {
        const r = await request(app).get(path);
        expect(r.status).toBe(401);
      });

      it("402 for free user (subscription_required, requiredTier=investor)", async () => {
        setUser(makeUser("free"));
        const r = await request(app).get(path).set("x-session-id", "s");
        expect(r.status).toBe(402);
        expect(r.body.error).toBe("subscription_required");
        expect(r.body.feature).toBe("dailyIQBriefs");
        expect(r.body.requiredTier).toBe("investor");
      });

      it("402 for collector (dailyIQBriefs is investor+ — collector lacks it)", async () => {
        setUser(makeUser("collector"));
        const r = await request(app).get(path).set("x-session-id", "s");
        expect(r.status).toBe(402);
        expect(r.body.requiredTier).toBe("investor");
      });

      it("investor passes the gate (status !== 401 && !== 402)", async () => {
        setUser(makeUser("investor"));
        const r = await request(app).get(path).set("x-session-id", "s");
        expect(r.status).not.toBe(401);
        expect(r.status).not.toBe(402);
      });

      it("pro_seller passes the gate", async () => {
        setUser(makeUser("pro_seller"));
        const r = await request(app).get(path).set("x-session-id", "s");
        expect(r.status).not.toBe(401);
        expect(r.status).not.toBe(402);
      });
    });
  }
});
