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
  it("Kurtz-class 2025 Green Lava Refractor: synthesized entry from empirical scan", () => {
    const entry = lookupBowmanFamilyEntry({
      year: 2025,
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Green Lava Refractor",
    });
    // The worksheet has 2026 entries but no 2025 ones — the empirical
    // table (n=28, 2.704×) should now produce a synthesized entry.
    expect(entry).not.toBeNull();
    expect(entry!.year).toBe(2025);
    expect(entry!.baseRelativePremium?.value).toBeGreaterThan(2);
    expect(entry!.baseRelativePremium?.value).toBeLessThan(4);
    expect(entry!.baseRelativePremium?.n).toBeGreaterThanOrEqual(5);
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
