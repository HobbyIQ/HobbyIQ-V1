// CF-PAYMENTS-A — requireCapacity middleware unit test.
//
// Contract per the HALT:
//   200 path:   next() if cap is "unlimited" OR currentCount < limit.
//   401 path:   if req.user missing.
//   402 path:   { success:false, error:"capacity_exceeded",
//                 cap, limit, current, currentTier, requiredTier }
//   500 path:   countFn threw -> fail-closed.

import { describe, expect, it, vi } from "vitest";
import { requireCapacity } from "../src/middleware/requireCapacity.js";

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

describe("requireCapacity middleware", () => {
  it("401 if req.user missing", async () => {
    const mw = requireCapacity("priceAlerts", async () => 0);
    const { req, res, next } = makeReqRes(undefined);
    await mw(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("200 (next) when cap is unlimited (pro_seller priceAlerts)", async () => {
    const countFn = vi.fn(async () => 9999);
    const mw = requireCapacity("priceAlerts", countFn);
    const { req, res, next } = makeReqRes({ userId: "u", plan: "pro_seller" });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    // countFn should be SHORT-CIRCUITED when unlimited (no need to read Cosmos).
    expect(countFn).not.toHaveBeenCalled();
  });

  it("200 (next) when current < limit (collector priceAlerts cap=10, current=9)", async () => {
    const countFn = vi.fn(async () => 9);
    const mw = requireCapacity("priceAlerts", countFn);
    const { req, res, next } = makeReqRes({ userId: "u-collector", plan: "collector" });
    await mw(req, res, next);
    expect(countFn).toHaveBeenCalledWith("u-collector");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("402 with full shape when current >= limit (free holdingsCap cap=25, current=25)", async () => {
    const mw = requireCapacity("holdingsCap", async () => 25);
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    await mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body).toEqual({
      success: false,
      error: "capacity_exceeded",
      cap: "holdingsCap",
      limit: 25,
      current: 25,
      currentTier: "free",
      requiredTier: "collector",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("402 when collector tries to exceed priceAlerts cap (count=10)", async () => {
    const mw = requireCapacity("priceAlerts", async () => 10);
    const { req, res, next } = makeReqRes({ userId: "u", plan: "collector" });
    await mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body.requiredTier).toBe("investor");
    expect(res._body.currentTier).toBe("collector");
    expect(res._body.cap).toBe("priceAlerts");
    expect(res._body.limit).toBe(10);
    expect(res._body.current).toBe(10);
  });

  it("402 for free attempting to create first priceAlert (cap=0)", async () => {
    const mw = requireCapacity("priceAlerts", async () => 0);
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    await mw(req, res, next);
    expect(res._status).toBe(402);
    expect(res._body.error).toBe("capacity_exceeded");
    expect(res._body.limit).toBe(0);
    expect(res._body.current).toBe(0);
    expect(res._body.requiredTier).toBe("collector");
    expect(next).not.toHaveBeenCalled();
  });

  it("500 fail-closed when countFn throws", async () => {
    const mw = requireCapacity("holdingsCap", async () => {
      throw new Error("Cosmos read failed");
    });
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    await mw(req, res, next);
    expect(res._status).toBe(500);
    expect(res._body).toEqual({
      success: false,
      error: "capacity_check_failed",
      cap: "holdingsCap",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
