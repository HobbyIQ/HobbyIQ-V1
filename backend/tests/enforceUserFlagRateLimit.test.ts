// CF-USER-FLAG-RATE-LIMIT (Drew, 2026-07-26, P0.2). Pins the middleware
// contract: per-user daily cap, 429 with Retry-After when exceeded,
// advisory X-Flag-Remaining-Today header, forget-on-restart semantics.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { enforceUserFlagRateLimit, _resetForTests } from "../src/middleware/enforceUserFlagRateLimit.js";

function makeReq(userId: string | null = "user-A"): any {
  return { user: userId ? { userId } : undefined };
}
function makeRes(): { statusCode: number; headers: Record<string, string>; body: any; res: any } {
  const state: any = { statusCode: 200, headers: {} as Record<string, string>, body: null };
  state.res = {
    status(code: number) { state.statusCode = code; return state.res; },
    json(payload: any) { state.body = payload; return state.res; },
    setHeader(name: string, value: string) { state.headers[name] = value; },
  };
  return state;
}

describe("enforceUserFlagRateLimit", () => {
  const ORIGINAL_CAP = process.env.USER_FLAG_RATE_LIMIT_PER_DAY;
  beforeEach(() => { _resetForTests(); });
  afterEach(() => {
    if (ORIGINAL_CAP === undefined) delete process.env.USER_FLAG_RATE_LIMIT_PER_DAY;
    else process.env.USER_FLAG_RATE_LIMIT_PER_DAY = ORIGINAL_CAP;
    vi.useRealTimers();
  });

  it("allows the first request and sets X-Flag-Remaining-Today", () => {
    process.env.USER_FLAG_RATE_LIMIT_PER_DAY = "5";
    const req = makeReq();
    const { res, headers, statusCode } = makeRes();
    let called = false;
    enforceUserFlagRateLimit(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(statusCode).toBe(200);   // untouched
    expect(headers["X-Flag-Remaining-Today"]).toBe("4");
  });

  it("blocks the 6th request when cap=5", () => {
    process.env.USER_FLAG_RATE_LIMIT_PER_DAY = "5";
    const req = makeReq();
    // Burn through the first 5
    for (let i = 0; i < 5; i++) {
      const { res } = makeRes();
      enforceUserFlagRateLimit(req, res, () => {});
    }
    // 6th should 429
    const state = makeRes();
    let called = false;
    enforceUserFlagRateLimit(req, state.res, () => { called = true; });
    expect(called).toBe(false);
    expect(state.statusCode).toBe(429);
    expect(state.body.success).toBe(false);
    expect(state.body.limit).toBe(5);
    expect(state.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.headers["Retry-After"]).toBeTruthy();
  });

  it("counts per-user, not global", () => {
    process.env.USER_FLAG_RATE_LIMIT_PER_DAY = "2";
    // user-A hits cap
    for (let i = 0; i < 2; i++) {
      enforceUserFlagRateLimit(makeReq("user-A"), makeRes().res, () => {});
    }
    // user-B should still be allowed
    const state = makeRes();
    let called = false;
    enforceUserFlagRateLimit(makeReq("user-B"), state.res, () => { called = true; });
    expect(called).toBe(true);
    expect(state.statusCode).toBe(200);
  });

  it("rejects unauthenticated requests (defense in depth)", () => {
    const state = makeRes();
    let called = false;
    enforceUserFlagRateLimit(makeReq(null), state.res, () => { called = true; });
    expect(called).toBe(false);
    expect(state.statusCode).toBe(401);
  });

  it("defaults to cap=20 when env not set", () => {
    delete process.env.USER_FLAG_RATE_LIMIT_PER_DAY;
    const req = makeReq();
    for (let i = 0; i < 20; i++) {
      enforceUserFlagRateLimit(req, makeRes().res, () => {});
    }
    const state = makeRes();
    enforceUserFlagRateLimit(req, state.res, () => {});
    expect(state.statusCode).toBe(429);
    expect(state.body.limit).toBe(20);
  });

  it("resets after 24h window elapses (fake timer)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 26, 12, 0, 0));
    process.env.USER_FLAG_RATE_LIMIT_PER_DAY = "1";
    const req = makeReq();
    enforceUserFlagRateLimit(req, makeRes().res, () => {});     // ok
    const blocked = makeRes();
    enforceUserFlagRateLimit(req, blocked.res, () => {});
    expect(blocked.statusCode).toBe(429);

    // Advance 24h+1s
    vi.setSystemTime(Date.UTC(2026, 6, 27, 12, 0, 1));
    const fresh = makeRes();
    let called = false;
    enforceUserFlagRateLimit(req, fresh.res, () => { called = true; });
    expect(called).toBe(true);
    expect(fresh.statusCode).toBe(200);
  });
});
