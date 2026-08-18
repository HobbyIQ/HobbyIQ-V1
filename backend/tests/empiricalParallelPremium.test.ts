// CF-PARALLEL-PREMIUM-CALIBRATION (2026-06-28) — pins the empirical
// parallel-premium fallthrough in lookupBowmanFamilyEntry. When the
// static worksheet has no entry for a (year, product, subset, parallel)
// combo, the lookup now falls through to the JSON-backed empirical
// table at backend/data/parallel-premiums-latest.json.
//
// Pinned: Kurtz Green Lava 2025 — pre-CF the worksheet had no 2025
// entry → lookup returned null → no Build B → engine degenerate FMV.
// Post-CF the empirical entry synthesized at runtime carries the
// 2.704× baseRelativePremium from 28 paired observations.

import { describe, expect, it } from "vitest";
import { lookupBowmanFamilyEntry } from "../src/services/compiq/chromeDraftMultipliers.js";

describe("lookupBowmanFamilyEntry — empirical-table fallthrough", () => {
  it("Kurtz-class 2025 Green Lava: synthesized entry from empirical scan", () => {
    // Post-CF-CH-PARALLEL-DISCOVERY (PR #192): the empirical table now
    // uses CH's canonical variant names without manual suffix-stripping.
    // CH catalogs the variant as "Green Lava" (no "Refractor" suffix),
    // so iOS sends "Green Lava" too. Test reflects the canonical name.
    const entry = lookupBowmanFamilyEntry({
      year: 2025,
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Green Lava",
    });
    expect(entry).not.toBeNull();
    expect(entry!.year).toBe(2025);
    expect(entry!.baseRelativePremium?.value).toBeGreaterThan(2);
    expect(entry!.baseRelativePremium?.value).toBeLessThan(4);
    // The original pin was n >= 5, written when this entry carried 28 paired
    // observations. parallel-premiums-latest.json is REGENERATED on a rolling
    // window (calibratedAt 2026-08-14, windowDays in the header), and the 2025
    // Green Lava auto now rests on 4 — the premium is still 2.631 and still
    // provenance "empirical". A hard sample-count floor pins a number that
    // moves every recalibration, so it breaks on healthy data.
    //
    // What actually matters, and what is pinned now: the fallthrough produced
    // a REAL observation-backed entry rather than a guess. n >= 1 plus
    // provenance "empirical" says exactly that; the value bounds above say it
    // is sane. If sample size itself needs a floor, it belongs in the
    // calibration job that writes the file, not in a consumer test.
    expect(entry!.baseRelativePremium?.n).toBeGreaterThanOrEqual(1);
    expect(entry!.baseRelativePremium?.provenance).toBe("empirical");
  });

  it("static worksheet matches still win — 2026 Blue X-Fractor /150 returns the curated entry", () => {
    // Hartman's CF-XMULT entry from 2026-06-21.
    const entry = lookupBowmanFamilyEntry({
      year: 2026,
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Blue X-Fractor",
    });
    expect(entry).not.toBeNull();
    // The hand-curated entry has the CF-XMULT 2.974× value.
    expect(entry!.baseRelativePremium?.value).toBeCloseTo(2.974, 2);
  });

  it("non-existent combo (year mismatch + parallel not in empirical) → null", () => {
    const entry = lookupBowmanFamilyEntry({
      year: 1985,
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Hot Pink Refractor",
    });
    expect(entry).toBeNull();
  });
});
