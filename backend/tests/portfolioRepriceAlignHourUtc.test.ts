// portfolioRepriceAlignHourUtc.test.ts — unit tests for the wall-clock
// alignment helper used by startPortfolioRepriceJob().
//
// The scheduler previously fired its first run PORTFOLIO_REPRICE_FIRST_DELAY_MS
// after startup. That meant the 6h cycle drifted with each redeploy. When
// PORTFOLIO_REPRICE_ALIGN_HOUR_UTC is set we snap the first run to HH:00 UTC
// so the cycle lands on predictable wall-clock hours (5am ET pre-market being
// the target case). Covered here:
//
//   - later today  -> delta is remainder-of-day
//   - already past -> delta is (24h - elapsed)
//   - exact match  -> defers to tomorrow (guards against boot-time double-fire)
//   - within 60s guard band -> defers to tomorrow

import { describe, expect, it } from "vitest";
import { computeAlignedFirstDelayMs } from "../src/jobs/portfolioReprice.job";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * HOUR;

function utc(y: number, m: number, d: number, h: number, min = 0, s = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s, 0);
}

describe("computeAlignedFirstDelayMs", () => {
  it("later today: delta is remainder-of-day to target hour", () => {
    // 03:00 UTC now, target 09:00 UTC -> +6h
    const now = utc(2026, 7, 8, 3, 0);
    expect(computeAlignedFirstDelayMs(now, 9)).toBe(6 * HOUR);
  });

  it("already past: delta wraps to same hour tomorrow", () => {
    // 12:30 UTC now, target 09:00 UTC -> +20h30m (next day)
    const now = utc(2026, 7, 8, 12, 30);
    expect(computeAlignedFirstDelayMs(now, 9)).toBe(20 * HOUR + 30 * MIN);
  });

  it("exact match: defers to tomorrow so the same-boot restart cannot double-fire", () => {
    const now = utc(2026, 7, 8, 9, 0);
    expect(computeAlignedFirstDelayMs(now, 9)).toBe(DAY);
  });

  it("within the 60s guard band: still defers to tomorrow", () => {
    // 08:59:30 UTC -- inside the 60s guard window before 09:00
    const now = utc(2026, 7, 8, 8, 59, 30);
    // target computed as today's 09:00 which is +30s. Because delta <= 60s,
    // we push to tomorrow: +30s + 24h.
    expect(computeAlignedFirstDelayMs(now, 9)).toBe(30 * 1000 + DAY);
  });

  it("midnight target: works across the day boundary", () => {
    // 23:00 UTC now, target 00:00 UTC -> +1h
    const now = utc(2026, 7, 8, 23, 0);
    expect(computeAlignedFirstDelayMs(now, 0)).toBe(1 * HOUR);
  });

  it("pre-market ET example: computes correctly for 5am ET (09:00 UTC)", () => {
    // 04:00 UTC now (before 09:00 UTC) -> +5h until pre-market warm
    const now = utc(2026, 7, 8, 4, 0);
    expect(computeAlignedFirstDelayMs(now, 9)).toBe(5 * HOUR);
  });
});
