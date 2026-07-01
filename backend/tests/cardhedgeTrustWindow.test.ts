/**
 * CF-CH-TRUST-WINDOW-90 (2026-07-01) — pin the widened trust window.
 *
 * Bug: `getTrustedComps` hardcoded `days=30` when calling
 * `getPricesByCard`. High-value / low-turnover cards (Trout 2009 BC
 * auto, Griffey 1989 UD, Franco 2019 BDC, Acuna 2017 Bowman) routinely
 * go 30+ days between sales but have real data in 90d. Prod:
 * 32 no_real_data rejections in 6h, all against GOAT-tier cards.
 *
 * Fix: default trust window bumped to 90d, env-tunable via
 * CH_TRUST_WINDOW_DAYS. These pins lock the new behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTrustWindowDays } from "../src/services/compiq/cardhedge.client";

describe("resolveTrustWindowDays (CF-CH-TRUST-WINDOW-90)", () => {
  const original = process.env.CH_TRUST_WINDOW_DAYS;

  beforeEach(() => {
    delete process.env.CH_TRUST_WINDOW_DAYS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CH_TRUST_WINDOW_DAYS;
    else process.env.CH_TRUST_WINDOW_DAYS = original;
  });

  it("default is 90d when env var unset", () => {
    expect(resolveTrustWindowDays()).toBe(90);
  });

  it("env value '180' overrides to 180", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "180";
    expect(resolveTrustWindowDays()).toBe(180);
  });

  it("env value '30' restores legacy behavior (rollback lever)", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "30";
    expect(resolveTrustWindowDays()).toBe(30);
  });

  it("garbage env value falls back to 90d default (defensive)", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "not-a-number";
    expect(resolveTrustWindowDays()).toBe(90);
  });

  it("empty env value falls back to 90d default", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "";
    expect(resolveTrustWindowDays()).toBe(90);
  });

  it("zero rejected — falls back to 90d (0-day window is nonsense)", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "0";
    expect(resolveTrustWindowDays()).toBe(90);
  });

  it("negative rejected — falls back to 90d", () => {
    process.env.CH_TRUST_WINDOW_DAYS = "-5";
    expect(resolveTrustWindowDays()).toBe(90);
  });
});
