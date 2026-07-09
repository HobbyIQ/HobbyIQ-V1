// perUserThrottle.test.ts — unit tests for the in-memory sliding-window
// per-user throttle used by POST /api/compiq/log-selection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  perUserThrottle,
  __perUserThrottleInternals,
} from "../src/middleware/perUserThrottle";

interface MockRes {
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  __status: number | null;
  __body: unknown;
}

function mockReq(userId: string | undefined): Request {
  return { userId } as unknown as Request;
}

function mockRes(): MockRes & Response {
  const r: MockRes = {
    __status: null,
    __body: null,
    status(code: number) {
      this.__status = code;
      return this;
    },
    json(body: unknown) {
      this.__body = body;
      return this;
    },
  };
  return r as unknown as MockRes & Response;
}

describe("perUserThrottle — sliding-window per-user limit", () => {
  let mw: ReturnType<typeof perUserThrottle>;

  afterEach(() => {
    if (mw) {
      const { evictionTimer } = __perUserThrottleInternals(mw);
      clearInterval(evictionTimer);
    }
    vi.useRealTimers();
  });

  it("passes through until limit reached, then 429s", () => {
    mw = perUserThrottle({ limit: 3, windowMs: 1000 });
    const req = mockReq("user-a");
    let nextCount = 0;
    const next: NextFunction = () => { nextCount++; };

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      mw(req, res, next);
      expect(res.__status).toBeNull(); // still within limit
    }
    expect(nextCount).toBe(3);

    // 4th request in the same window — throttled
    const res = mockRes();
    mw(req, res, next);
    expect(res.__status).toBe(429);
    const body = res.__body as { success: boolean; error: string; retryAfterSec: number };
    expect(body.success).toBe(false);
    expect(body.error).toBe("throttled");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(nextCount).toBe(3); // handler not invoked on throttle
  });

  it("windowed: after windowMs elapses, old requests drop out and user is allowed again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 8, 12, 0, 0));

    mw = perUserThrottle({ limit: 2, windowMs: 5000 });
    const req = mockReq("user-b");
    const next: NextFunction = vi.fn();

    // 2 requests at t=0 — fills the window
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      mw(req, res, next);
      expect(res.__status).toBeNull();
    }
    // 3rd request at t=0 — throttled
    const throttled = mockRes();
    mw(req, throttled, next);
    expect(throttled.__status).toBe(429);

    // Advance past the window — the two old timestamps drop off
    vi.advanceTimersByTime(5100);

    // Fresh request now allowed
    const fresh = mockRes();
    mw(req, fresh, next);
    expect(fresh.__status).toBeNull();
  });

  it("per-user isolation: user-a hitting limit does not throttle user-b", () => {
    mw = perUserThrottle({ limit: 2, windowMs: 1000 });
    const next: NextFunction = vi.fn();

    // Saturate user-a
    for (let i = 0; i < 2; i++) mw(mockReq("user-a"), mockRes(), next);
    const throttled = mockRes();
    mw(mockReq("user-a"), throttled, next);
    expect(throttled.__status).toBe(429);

    // user-b still fine
    const bRes = mockRes();
    mw(mockReq("user-b"), bRes, next);
    expect(bRes.__status).toBeNull();
  });

  it("missing userId → defensive pass-through (do not block anon; upstream requireSession handles auth)", () => {
    mw = perUserThrottle({ limit: 1, windowMs: 1000 });
    const nextFn = vi.fn();
    // Many requests with no userId — should all pass
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      mw(mockReq(undefined), res, nextFn);
      expect(res.__status).toBeNull();
    }
    expect(nextFn).toHaveBeenCalledTimes(5);
  });

  it("retryAfterSec reflects time until oldest timestamp falls out of window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 8, 12, 0, 0));

    mw = perUserThrottle({ limit: 1, windowMs: 10_000 });
    const next: NextFunction = vi.fn();

    // 1 request at t=0, fills the window
    mw(mockReq("user-c"), mockRes(), next);

    // Advance 3s, retry → throttled with retryAfterSec ≈ 7
    vi.advanceTimersByTime(3000);
    const res = mockRes();
    mw(mockReq("user-c"), res, next);
    expect(res.__status).toBe(429);
    const body = res.__body as { retryAfterSec: number };
    expect(body.retryAfterSec).toBe(7);
  });

  it("evicts idle users past evictWindow to bound memory", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 8, 12, 0, 0));

    mw = perUserThrottle({ limit: 5, windowMs: 1000 });
    const { buckets } = __perUserThrottleInternals(mw);
    const next: NextFunction = vi.fn();

    mw(mockReq("user-d"), mockRes(), next);
    expect(buckets.has("user-d")).toBe(true);

    // Advance well past the 10× window eviction floor (5min minimum) so the
    // eviction interval fires and cleans up.
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(buckets.has("user-d")).toBe(false);
  });
});
