// CF-ALERT-PRESETS (Drew, 2026-07-17). Pinning tests for the preset
// catalog + materialization.

import { describe, it, expect } from "vitest";
import {
  listAlertPresets,
  getAlertPreset,
  materializePreset,
  _PRESET_IDS_FOR_TESTS,
} from "../src/services/advancedAlerts/alertPresets.service.js";

describe("listAlertPresets", () => {
  it("returns at least 3 curated presets", () => {
    const presets = listAlertPresets();
    expect(presets.length).toBeGreaterThanOrEqual(3);
  });

  it("every preset has a stable slug id, name, category, description, whyItMatters", () => {
    for (const p of listAlertPresets()) {
      expect(p.presetId).toMatch(/^[a-z0-9-]+$/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.category).toBeTruthy();
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.whyItMatters.length).toBeGreaterThan(0);
    }
  });

  it("every preset has a valid scope and at least one condition", () => {
    for (const p of listAlertPresets()) {
      expect(p.scope).toBeTruthy();
      expect(p.conditions.length).toBeGreaterThan(0);
      expect(["AND", "OR"]).toContain(p.combinator);
    }
  });

  it("presetIds are unique", () => {
    const ids = _PRESET_IDS_FOR_TESTS;
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getAlertPreset", () => {
  it("returns null for unknown id", () => {
    expect(getAlertPreset("does-not-exist")).toBeNull();
  });

  it("returns the preset for a known id", () => {
    const p = getAlertPreset("portfolio-sell-window-opens");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Sell window opens (portfolio)");
  });
});

describe("materializePreset", () => {
  it("returns the shape the rules repository accepts", () => {
    const preset = getAlertPreset("portfolio-sell-window-opens")!;
    const rule = materializePreset(preset);
    expect(rule.name).toBe(preset.name);
    expect(rule.scope).toEqual(preset.scope);
    expect(rule.combinator).toBe(preset.combinator);
    expect(rule.conditions).toEqual(preset.conditions);
    expect(rule.cooldownMin).toBe(preset.cooldownMin);
  });

  it("overrides price_crosses value with user-supplied price target", () => {
    const preset = getAlertPreset("portfolio-price-target")!;
    const rule = materializePreset(preset, { priceTarget: 2500 });
    const priceCond = rule.conditions.find((c) => c.kind === "price_crosses");
    expect(priceCond).toBeDefined();
    if (priceCond && "value" in priceCond) {
      expect(priceCond.value).toBe(2500);
    }
  });

  it("ignores price target on presets that don't have price_crosses", () => {
    const preset = getAlertPreset("watchlist-move-fast")!;
    const rule = materializePreset(preset, { priceTarget: 9999 });
    // No price_crosses condition to override
    expect(rule.conditions.some((c) => c.kind === "price_crosses")).toBe(false);
  });

  it("customName overrides the preset name", () => {
    const preset = getAlertPreset("portfolio-sell-window-opens")!;
    const rule = materializePreset(preset, { customName: "My Custom Sell Alert" });
    expect(rule.name).toBe("My Custom Sell Alert");
  });
});
