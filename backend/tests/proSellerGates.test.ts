// CF-PRO-SELLER-GATE (Drew, 2026-09-02): "Gate all five to the Pro tiers."
//
// The five paid backing routes behind the Pro Seller workspace (apps/web
// /app/seller, PR #1660) must be entitlement-gated SERVER-SIDE. This file
// pins the gate on the ROUTE-shaped four; the FIELD-shaped one (sellSignal
// on GET /api/portfolio) is pinned in proSellerSellSignalGate.test.ts,
// because "the field is absent" is a different assertion from "the request
// is refused" and conflating them would let a route-level pass hide a
// field-level leak.
//
//   route-shaped, gated here:
//     GET /api/portfolio/sell-now-radar        recent-sales velocity
//     GET /api/portfolio/notable-sales         deal-scanner feed
//     GET /api/portfolio/grade-worthy-alerts   grade-arb opportunities
//     GET /api/portfolio/erp/pnl               fee / P&L summary
//
// TIERING. The first three move onto the new `sellerIntelligence` key at
// INVESTOR. They were reachable by every paid tier before this ruling, and
// the ruling asked to turn the FREE tier away — not to revoke a surface from
// paying investor customers. /erp/pnl keeps `erpReconciliation` at
// pro_seller: it was ALREADY correctly gated, and regrouping it onto the new
// key would have widened it from pro_seller to investor. Gating work that
// accidentally un-gates something is the failure mode this test exists to
// catch, so the expected requiredTier is asserted per route, not shared.
//
// WHAT THIS FILE PROVES, per the ruling's pins:
//   - a free user gets the gate status (402) on every one of the four
//   - a paid user is not refused (the 200 path is exercised, not stubbed past)
//   - the 402 carries the status + body the web workspace's resolveSection()
//     classifies as `locked` (apps/web/src/lib/api.ts LOCKED_STATUSES)

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

// Stub the stores so the 200 path resolves without Cosmos. An empty
// portfolio is enough: this file asserts the GATE, not the payload — the
// payloads have their own suites (sellNowRadarCompute, notableSalesRead,
// gradeWorthyCompute, pnlCogs.integration).
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: vi.fn(async (userId: string) => ({
      id: userId,
      userId,
      holdings: {},
      ledger: [],
    })),
  };
});

vi.mock("../src/services/portfolioiq/notableSalesRead.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readNotableSales: vi.fn(async () => ({ count: 0, sales: [] })),
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

interface GatedRoute {
  name: string;
  path: string;
  feature: string;
  /** Minimum tier per the entitlements matrix. */
  requiredTier: "investor" | "pro_seller";
  /** Tiers that must be REFUSED (below requiredTier). */
  refused: string[];
  /** Tiers that must PASS. */
  allowed: string[];
}

const ROUTES: GatedRoute[] = [
  {
    name: "recent-sales velocity",
    path: "/api/portfolio/sell-now-radar",
    feature: "sellerIntelligence",
    requiredTier: "investor",
    refused: ["free", "collector"],
    allowed: ["investor", "pro_seller"],
  },
  {
    name: "deal-scanner feed",
    path: "/api/portfolio/notable-sales",
    feature: "sellerIntelligence",
    requiredTier: "investor",
    refused: ["free", "collector"],
    allowed: ["investor", "pro_seller"],
  },
  {
    name: "grade-arb opportunities",
    path: "/api/portfolio/grade-worthy-alerts",
    feature: "sellerIntelligence",
    requiredTier: "investor",
    refused: ["free", "collector"],
    allowed: ["investor", "pro_seller"],
  },
  {
    // Already gated before this CF. Pinned here so a future edit that
    // "tidies" the five onto one key cannot silently widen pro_seller's
    // ERP surface to investor.
    name: "fee / P&L summary",
    path: "/api/portfolio/erp/pnl",
    feature: "erpReconciliation",
    requiredTier: "pro_seller",
    refused: ["free", "collector", "investor"],
    allowed: ["pro_seller"],
  },
];

describe("CF-PRO-SELLER-GATE — the four route-shaped paid surfaces", () => {
  for (const route of ROUTES) {
    describe(`${route.name} (${route.path})`, () => {
      it("401 without a session", async () => {
        const r = await request(app).get(route.path);
        expect(r.status).toBe(401);
      });

      for (const plan of route.refused) {
        it(`402 for ${plan} — the gate status, with the upgrade target`, async () => {
          setUser(makeUser(plan));
          const r = await request(app).get(route.path).set("x-session-id", "s");
          expect(r.status).toBe(402);
          expect(r.body.error).toBe("subscription_required");
          expect(r.body.feature).toBe(route.feature);
          expect(r.body.currentTier).toBe(plan);
          expect(r.body.requiredTier).toBe(route.requiredTier);
        });
      }

      for (const plan of route.allowed) {
        it(`${plan} gets data, not a gate`, async () => {
          setUser(makeUser(plan));
          const r = await request(app).get(route.path).set("x-session-id", "s");
          expect(r.status).not.toBe(401);
          expect(r.status).not.toBe(402);
          expect(r.status).toBeLessThan(500);
        });
      }
    });
  }

  // The free user's 402 must be the SUBSCRIPTION one, never the rate-limit
  // one. Both are 402 — a free caller who was told "rate_limit_exceeded"
  // would be told to come back tomorrow for a feature they cannot have at
  // any hour. This is why the entitlement middleware is ordered ahead of
  // requireRateLimited on these routes; ordering is easy to flip by accident
  // in a later edit, and the status code alone would not reveal it.
  it("a free user's 402 is subscription_required, never rate_limit_exceeded", async () => {
    setUser(makeUser("free"));
    for (const route of ROUTES) {
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.error).toBe("subscription_required");
      expect(r.body.error).not.toBe("rate_limit_exceeded");
    }
  });

  // The web workspace feature-detects each section: 402/403 -> `locked`
  // upsell, 404/501 -> section hidden entirely, anything else -> an error
  // box. A gate that answered 403 would still render the upsell, but a gate
  // that answered 404 would make the section VANISH — the paid surface would
  // look like it does not exist rather than like something to buy.
  it("the gate status is one resolveSection() classifies as locked (402/403), not absent (404/501)", async () => {
    setUser(makeUser("free"));
    const LOCKED = new Set([402, 403]);
    const ABSENT = new Set([404, 501]);
    for (const route of ROUTES) {
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(LOCKED.has(r.status)).toBe(true);
      expect(ABSENT.has(r.status)).toBe(false);
    }
  });

  // requiredTier is what the upsell renders ("upgrade to X"). A 402 that
  // omitted it would put the workspace in a locked state with no target.
  it("every 402 names a requiredTier the upsell can render", async () => {
    setUser(makeUser("free"));
    for (const route of ROUTES) {
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.body.requiredTier).toBeTruthy();
      expect(["collector", "investor", "pro_seller"]).toContain(r.body.requiredTier);
    }
  });
});
