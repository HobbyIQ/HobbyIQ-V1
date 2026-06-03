// CF-PAYMENTS-B1 — usageCounter.service.ts unit tests.
//
// Locks the window-key derivation + read-time reset semantics that
// requireRateLimited depends on. Storage I/O is mocked at the
// setUserUsageCounter boundary so these tests run pure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/authService.js", async () => {
  const actual = await vi.importActual<any>("../src/services/authService.js");
  return {
    ...actual,
    setUserUsageCounter: vi.fn(async () => undefined),
  };
});

const authMod = await import("../src/services/authService.js");
const {
  currentWindowKey,
  getUsageCount,
  incrementUsage,
} = await import("../src/services/usage/usageCounter.service.js");

function userWith(usage?: any): any {
  return {
    userId: "u-1",
    email: "u@t",
    username: null,
    fullName: null,
    plan: "free",
    createdAt: "2026-01-01T00:00:00Z",
    usage,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("currentWindowKey", () => {
  it("priceChecksPerDay returns YYYY-MM-DD in UTC", () => {
    const date = new Date(Date.UTC(2026, 5, 2, 23, 59, 59)); // 2026-06-02 23:59:59 UTC
    expect(currentWindowKey("priceChecksPerDay", date)).toBe("2026-06-02");
  });

  it("scansPerMonth returns YYYY-MM in UTC", () => {
    const date = new Date(Date.UTC(2026, 5, 2, 23, 59, 59));
    expect(currentWindowKey("scansPerMonth", date)).toBe("2026-06");
  });

  it("priceChecksPerDay zero-pads single-digit month + day", () => {
    const date = new Date(Date.UTC(2026, 0, 3, 12, 0, 0)); // 2026-01-03
    expect(currentWindowKey("priceChecksPerDay", date)).toBe("2026-01-03");
  });

  it("UTC boundary: 23:59 PST = next-day UTC", () => {
    // 2026-06-02 23:59:00 PST == 2026-06-03 06:59:00 UTC -> day rolls
    const date = new Date(Date.UTC(2026, 5, 3, 6, 59, 0));
    expect(currentWindowKey("priceChecksPerDay", date)).toBe("2026-06-03");
  });
});

describe("getUsageCount", () => {
  const now = new Date(Date.UTC(2026, 5, 2, 12, 0, 0));

  it("returns 0 when user has no usage record at all", () => {
    expect(getUsageCount(userWith(undefined), "priceChecksPerDay", now)).toBe(0);
  });

  it("returns 0 when user has usage but not for this cap", () => {
    const user = userWith({ scans: { windowKey: "2026-06", count: 4 } });
    expect(getUsageCount(user, "priceChecksPerDay", now)).toBe(0);
  });

  it("returns stored count when windowKey matches current", () => {
    const user = userWith({ priceChecks: { windowKey: "2026-06-02", count: 3 } });
    expect(getUsageCount(user, "priceChecksPerDay", now)).toBe(3);
  });

  it("returns 0 when stored windowKey is from a previous day (DAY ROLLOVER)", () => {
    // Stored from yesterday; reset semantics fire at read time.
    const user = userWith({ priceChecks: { windowKey: "2026-06-01", count: 5 } });
    expect(getUsageCount(user, "priceChecksPerDay", now)).toBe(0);
  });

  it("returns 0 when stored windowKey is from a previous month (MONTH ROLLOVER)", () => {
    const user = userWith({ scans: { windowKey: "2026-05", count: 10 } });
    expect(getUsageCount(user, "scansPerMonth", now)).toBe(0);
  });

  it("returns stored count when month windowKey matches", () => {
    const user = userWith({ scans: { windowKey: "2026-06", count: 7 } });
    expect(getUsageCount(user, "scansPerMonth", now)).toBe(7);
  });

  it("priceChecks for one day does NOT leak into scans cap (separate storage keys)", () => {
    const user = userWith({ priceChecks: { windowKey: "2026-06-02", count: 4 } });
    expect(getUsageCount(user, "scansPerMonth", now)).toBe(0);
  });
});

describe("incrementUsage", () => {
  const now = new Date(Date.UTC(2026, 5, 2, 12, 0, 0));

  it("first increment: writes {windowKey: current, count: 1}", async () => {
    await incrementUsage(userWith(undefined), "priceChecksPerDay", now);
    expect(authMod.setUserUsageCounter).toHaveBeenCalledWith(
      "u-1",
      "priceChecks",
      { windowKey: "2026-06-02", count: 1 },
    );
  });

  it("subsequent same-window increment: count goes to N+1", async () => {
    const user = userWith({ priceChecks: { windowKey: "2026-06-02", count: 3 } });
    await incrementUsage(user, "priceChecksPerDay", now);
    expect(authMod.setUserUsageCounter).toHaveBeenCalledWith(
      "u-1",
      "priceChecks",
      { windowKey: "2026-06-02", count: 4 },
    );
  });

  it("DAY ROLLOVER: stored is yesterday -> reset to {today, 1} (NOT 6)", async () => {
    const user = userWith({ priceChecks: { windowKey: "2026-06-01", count: 5 } });
    await incrementUsage(user, "priceChecksPerDay", now);
    expect(authMod.setUserUsageCounter).toHaveBeenCalledWith(
      "u-1",
      "priceChecks",
      { windowKey: "2026-06-02", count: 1 },
    );
  });

  it("MONTH ROLLOVER: stored is last month -> reset to {this month, 1}", async () => {
    const user = userWith({ scans: { windowKey: "2026-05", count: 10 } });
    await incrementUsage(user, "scansPerMonth", now);
    expect(authMod.setUserUsageCounter).toHaveBeenCalledWith(
      "u-1",
      "scans",
      { windowKey: "2026-06", count: 1 },
    );
  });
});
