// CF-ERP-EXPANSION-#1 (2026-06-03): sales-tracking model unit coverage.

import { describe, expect, it } from "vitest";
import { parseSalesTrackingFields } from "../src/services/portfolioiq/portfolioStore.service.js";

describe("parseSalesTrackingFields — enum validation", () => {
  it("accepts a known salesChannel", () => {
    const r = parseSalesTrackingFields({ salesChannel: "whatnot" });
    expect("ok" in r && r.ok.salesChannel).toBe("whatnot");
  });
  it("rejects unknown salesChannel", () => {
    const r = parseSalesTrackingFields({ salesChannel: "stockx" });
    expect("error" in r).toBe(true);
  });
  it("accepts a known paymentMethod (new: cashapp + trade)", () => {
    expect("ok" in parseSalesTrackingFields({ paymentMethod: "cashapp" })).toBe(true);
    expect("ok" in parseSalesTrackingFields({ paymentMethod: "trade" })).toBe(true);
  });
  it("rejects unknown paymentMethod", () => {
    const r = parseSalesTrackingFields({ paymentMethod: "bitcoin" });
    expect("error" in r).toBe(true);
  });
  it("accepts new salesChannel values pwcc + goldin", () => {
    expect("ok" in parseSalesTrackingFields({ salesChannel: "pwcc" })).toBe(true);
    expect("ok" in parseSalesTrackingFields({ salesChannel: "goldin" })).toBe(true);
  });
});

describe('parseSalesTrackingFields — "other" requires note', () => {
  it("salesChannel=other w/o channelNote → error", () => {
    const r = parseSalesTrackingFields({ salesChannel: "other" });
    expect("error" in r).toBe(true);
  });
  it("salesChannel=other + channelNote → ok", () => {
    const r = parseSalesTrackingFields({ salesChannel: "other", channelNote: "Cardshow @ school" });
    expect("ok" in r).toBe(true);
  });
  it("paymentMethod=other w/o paymentNote → error", () => {
    const r = parseSalesTrackingFields({ paymentMethod: "other" });
    expect("error" in r).toBe(true);
  });
  it("paymentMethod=other + paymentNote → ok", () => {
    const r = parseSalesTrackingFields({ paymentMethod: "other", paymentNote: "wire" });
    expect("ok" in r).toBe(true);
  });
});

describe("parseSalesTrackingFields — saleLocation structured", () => {
  it("accepts venue + city + state", () => {
    const r = parseSalesTrackingFields({
      saleLocation: { venue: "National 2026", city: "Rosemont", state: "il" },
    });
    expect("ok" in r).toBe(true);
    if ("ok" in r) {
      expect(r.ok.saleLocation).toEqual({
        venue: "National 2026",
        city: "Rosemont",
        state: "IL",
      });
    }
  });
  it("rejects state > 2 chars", () => {
    const r = parseSalesTrackingFields({ saleLocation: { state: "ILL" } });
    expect("error" in r).toBe(true);
  });
  it("truncates oversized venue to ≤ 80 chars", () => {
    const long = "x".repeat(120);
    const r = parseSalesTrackingFields({ saleLocation: { venue: long } });
    if ("ok" in r) {
      expect(r.ok.saleLocation?.venue?.length).toBeLessThanOrEqual(80);
    }
  });
  it("absent location is undefined (online sale)", () => {
    const r = parseSalesTrackingFields({});
    if ("ok" in r) expect(r.ok.saleLocation).toBeUndefined();
  });
});
