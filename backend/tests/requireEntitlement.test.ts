// CF-PAYMENTS-A — requireEntitlement middleware unit test.
//
// Contract per the HALT:
//   200 path:    next() if req.user.plan has the feature.
//   401 path:    if req.user is missing (caller forgot requireSession).
//   402 path:    { success:false, error:"subscription_required",
//                  feature, currentTier, requiredTier }

import { describe, expect, it, vi } from "vitest";
import { requireEntitlement } from "../src/middleware/requireEntitlement.js";

function makeReqRes(user?: any) {
  const req: any = { user, headers: {} };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: any) { body = payload; return res; },
  };
  Object.defineProperty(res, "_status", { get: () => statusCode });
  Object.defineProperty(res, "_body", { get: () => body });
  const next = vi.fn();
  return { req, res, next };
}

describe("requireEntitlement middleware", () => {
  it("401 if req.user is missing (requireSession not run upstream)", () => {
    const mw = requireEntitlement("watchlist");
    const { req, res, next } = makeReqRes(undefined);
    mw(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("402 with full shape when plan lacks the feature (free -> watchlist)", () => {
    const mw = requireEntitlement("watchlist");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body).toEqual({
      success: false,
      error: "subscription_required",
      feature: "watchlist",
      currentTier: "free",
      requiredTier: "collector",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("402 for collector trying investor-only feature (ebayIntegration)", () => {
    const mw = requireEntitlement("ebayIntegration");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "collector" });
    mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body.requiredTier).toBe("investor");
    expect(res._body.currentTier).toBe("collector");
    expect(res._body.feature).toBe("ebayIntegration");
    expect(next).not.toHaveBeenCalled();
  });

  it("402 for investor trying pro_seller-only feature (trendIQLayer3Full)", () => {
    const mw = requireEntitlement("trendIQLayer3Full");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "investor" });
    mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body.requiredTier).toBe("pro_seller");
    expect(next).not.toHaveBeenCalled();
  });

  it("200 (next) when collector has watchlist", () => {
    const mw = requireEntitlement("watchlist");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "collector" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(0);
  });

  it("200 (next) when investor has ebayIntegration", () => {
    const mw = requireEntitlement("ebayIntegration");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "investor" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("200 (next) when pro_seller has trendIQLayer3Full", () => {
    const mw = requireEntitlement("trendIQLayer3Full");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "pro_seller" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
