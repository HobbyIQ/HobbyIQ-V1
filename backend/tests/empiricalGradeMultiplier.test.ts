/**
 * CF-EMPIRICAL-MULTIPLIER-SPLIT / CF-LADDER-PROJECTS-FROM-ANCHOR (2026-08-22).
 *
 * The grade ladder now PROJECTS tiers that have no sales of their own, off the
 * card's anchor times a grade ratio. That is only legitimate while the ratio is
 * empirical. gradeTierMultiplier cannot answer "is this empirical?" — it falls
 * back to a hardcoded matrix (PSA 10 = 4x, BGS 10 = 5x) and returns it
 * indistinguishably from a calibrated ratio.
 *
 * empiricalGradeMultiplier is the half that CAN answer: it returns null where
 * only the fallback would apply, so the ladder omits the tier instead of
 * inventing one. This is the boundary between "we projected from data" and
 * "we made a number up", and it is the whole basis for showing projected tiers
 * to users at all.
 */
import { describe, it, expect } from "vitest";
import { empiricalGradeMultiplier } from "../src/services/compiq/canonicalFmv.service.js";
import { classifyFamily } from "../src/services/compiq/gradeCalibrationConfig.js";

describe("empiricalGradeMultiplier — the projection boundary", () => {
  it("returns null when no calibration exists, so the tier is omitted not invented", () => {
    // A family we hold no grade calibration for must not borrow the hardcoded
    // PSA 10 = 4x. Omission is the correct output.
    expect(empiricalGradeMultiplier("PSA", 10, "definitely-not-a-real-family", "baseball")).toBeNull();
  });

  it("returns null when the family is unknown entirely", () => {
    expect(empiricalGradeMultiplier("PSA", 10, null, "baseball")).toBeNull();
  });

  it("treats raw as 1 — a raw card IS the anchor", () => {
    expect(empiricalGradeMultiplier(null, null, "topps-chrome", "baseball")).toBe(1);
    expect(empiricalGradeMultiplier("PSA", null, "topps-chrome", "baseball")).toBe(1);
  });

  it("returns a real ratio for a calibrated family, and scales it by sub-tier", () => {
    const family = classifyFamily("topps-chrome");
    const ten = empiricalGradeMultiplier("PSA", 10, family, "baseball");
    const nine = empiricalGradeMultiplier("PSA", 9, family, "baseball");
    // If this family has calibration at all, 10 must carry the full ratio and
    // 9 a scaled-down share of it. If it has none, both are null — also valid,
    // and the ladder omits both.
    if (ten !== null) {
      expect(ten).toBeGreaterThan(0);
      expect(nine).not.toBeNull();
      expect(nine!).toBeLessThan(ten);
    } else {
      expect(nine).toBeNull();
    }
  });

  it("never returns the hardcoded fallback values", () => {
    // The fallback table's exact PSA numbers are 4 / 1.6 / 1.2. Seeing one of
    // those from an UNCALIBRATED family would mean the split leaked.
    const leaked = empiricalGradeMultiplier("PSA", 10, "no-such-family-xyz", "baseball");
    expect(leaked).not.toBe(4);
    expect(leaked).toBeNull();
  });
});

describe("classifyFamily accepts the slug form the ladder derives", () => {
  it("maps a hobbyiqCardId setKey segment, not just a human product name", () => {
    // The ladder only has the slug, so it passes segment 3 ("topps-chrome").
    // If this ever stopped being hyphen-tolerant, every projected tier would
    // silently vanish — the family would be "other" and every ratio null.
    expect(classifyFamily("topps-chrome")).toBe(classifyFamily("Topps Chrome"));
    expect(classifyFamily("bowman-chrome")).toBe(classifyFamily("Bowman Chrome"));
  });
});
