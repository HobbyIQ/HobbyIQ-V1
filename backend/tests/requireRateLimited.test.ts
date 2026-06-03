// CF-PAYMENTS-B1 — requireRateLimited middleware unit tests.
//
// Contract per the HALT spec:
//   401 if req.user missing.
//   unlimited cap   -> next() WITH NO count read (no Cosmos work).
//   count <  limit  -> next() + arm res.on("finish") increment hook
//                      that fires only on statusCode < 400.
//   count >= limit  -> 402 {success:false, error:"rate_limit_exceeded",
//                            cap, limit, current, currentTier, requiredTier}
//   handler error  -> increment hook SKIPS the write (failed call doesn't
//                     burn the user's quota).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock the usageCounter service so we can assert what the middleware does
// without exercising Cosmos.
vi.mock("../src/services/usage/usageCounter.service.js", () => ({
  getUsageCount: vi.fn(() => 0),
  incrementUsage: vi.fn(async () => undefined),
  currentWindowKey: vi.fn(() => "2026-06-02"),
}));

const usageMod = await import("../src/services/usage/usageCounter.service.js");
const { requireRateLimited } = await import("../src/middleware/requireRateLimited.js");

function makeReqRes(user?: any) {
  const req: any = { user, headers: {} };
  // res must emit "finish" events for the post-response hook to fire.
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: any) => { res._body = payload; return res; };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireRateLimited middleware", () => {
  it("401 if req.user missing", () => {
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes(undefined);
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(usageMod.getUsageCount).not.toHaveBeenCalled();
  });

  it("unlimited cap (collector priceChecksPerDay): next() + NO count read", () => {
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "collector" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(usageMod.getUsageCount).not.toHaveBeenCalled();
  });

  it("unlimited cap (investor scansPerMonth): next() + NO count read", () => {
    const mw = requireRateLimited("scansPerMonth");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "investor" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(usageMod.getUsageCount).not.toHaveBeenCalled();
  });

  it("402 when free user is at priceChecksPerDay limit (count=5, limit=5)", () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(5);
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u-free", plan: "free" });
    mw(req, res, next);
    expect(res.statusCode).toBe(402);
    expect(res._body).toEqual({
      success: false,
      error: "rate_limit_exceeded",
      cap: "priceChecksPerDay",
      limit: 5,
      current: 5,
      currentTier: "free",
      requiredTier: "collector",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("402 when free user is at scansPerMonth limit (count=10, limit=10)", () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(10);
    const mw = requireRateLimited("scansPerMonth");
    const { req, res, next } = makeReqRes({ userId: "u-free", plan: "free" });
    mw(req, res, next);
    expect(res.statusCode).toBe(402);
    expect(res._body).toMatchObject({
      success: false,
      error: "rate_limit_exceeded",
      cap: "scansPerMonth",
      limit: 10,
      current: 10,
      requiredTier: "collector",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("under-limit free user: next() called, increment hook armed", () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(3);
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u-free", plan: "free" });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(usageMod.incrementUsage).not.toHaveBeenCalled();
  });

  it("INCREMENT-ON-SUCCESS-ONLY: 2xx -> increment fires", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    const mw = requireRateLimited("priceChecksPerDay");
    const user = { userId: "u-free", plan: "free" };
    const { req, res, next } = makeReqRes(user);
    mw(req, res, next);
    // Simulate a successful handler completion.
    res.statusCode = 200;
    res.emit("finish");
    // Allow the fire-and-forget promise to settle.
    await new Promise((r) => setImmediate(r));
    expect(usageMod.incrementUsage).toHaveBeenCalledTimes(1);
    expect(usageMod.incrementUsage).toHaveBeenCalledWith(user, "priceChecksPerDay");
  });

  it("INCREMENT-ON-SUCCESS-ONLY: 201 -> increment fires", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    const mw = requireRateLimited("scansPerMonth");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    res.statusCode = 201;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    expect(usageMod.incrementUsage).toHaveBeenCalledTimes(1);
  });

  it("INCREMENT-ON-SUCCESS-ONLY: 400 -> NO increment", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    res.statusCode = 400;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    expect(usageMod.incrementUsage).not.toHaveBeenCalled();
  });

  it("INCREMENT-ON-SUCCESS-ONLY: 500 (handler threw) -> NO increment", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    res.statusCode = 500;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    expect(usageMod.incrementUsage).not.toHaveBeenCalled();
  });

  it("INCREMENT-ON-SUCCESS-ONLY: 502 (upstream Cardsight timeout) -> NO increment", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    const mw = requireRateLimited("scansPerMonth");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    res.statusCode = 502;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    expect(usageMod.incrementUsage).not.toHaveBeenCalled();
  });

  it("increment failure does NOT crash the process (caught + logged)", async () => {
    (usageMod.getUsageCount as any).mockReturnValueOnce(0);
    (usageMod.incrementUsage as any).mockRejectedValueOnce(new Error("Cosmos write failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mw = requireRateLimited("priceChecksPerDay");
    const { req, res, next } = makeReqRes({ userId: "u", plan: "free" });
    mw(req, res, next);
    res.statusCode = 200;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
