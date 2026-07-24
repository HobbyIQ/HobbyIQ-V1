// CF-HOBBYIQ-FMV service smoke tests. Focus on the envelope shape +
// empty-input handling. Real behavior is verified live against sold_comps
// after deploy.

import { describe, it, expect } from "vitest";
import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

describe("computeHobbyIqFmv — envelope shape", () => {
  it("empty slug → no-basis result, envelope preserved (including new ladder fields)", async () => {
    const r = await computeHobbyIqFmv({ hobbyiqCardId: "" });
    expect(r.slug).toBe("");
    expect(r.fmv).toBeNull();
    expect(r.compCount).toBe(0);
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
    expect(r.recentComps).toEqual([]);
    expect(r.breakdown.bySource).toEqual({});
    expect(r.breakdown.byAutoStyle).toEqual({ onCard: 0, sticker: 0, unknown: 0 });
    expect(r.breakdown.byGradeQualifier).toEqual({});
    expect(r.trend).toEqual({ direction: "flat", slopePerMonthPct: 0, method: "none" });
    expect(r.method).toBe("no-basis");
    expect(r.confidence).toBe(0);
    expect(typeof r.basisNote).toBe("string");
    expect(r.population).toBeNull();
    expect(r.cachedFrom).toBe("sold_comps");
  });

  it("non-hiq slug → treats as empty (guard)", async () => {
    const r = await computeHobbyIqFmv({ hobbyiqCardId: "not-a-slug" });
    expect(r.fmv).toBeNull();
    expect(r.compCount).toBe(0);
  });

  it("valid-looking slug with no Cosmos → empty result envelope, no throw", async () => {
    // Temporarily unset the connection string to simulate Cosmos-unavailable
    const prev = process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_CONNECTION_STRING;
    const r = await computeHobbyIqFmv({
      hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto:num-150",
    });
    expect(r.fmv).toBeNull();
    expect(r.compCount).toBe(0);
    if (prev !== undefined) process.env.COSMOS_CONNECTION_STRING = prev;
  });
});

describe("computeHobbyIqFmv — response shape includes all iOS render fields", () => {
  it("recentComps entries expose price, soldAt, source, parallel, autoStyle, gradeQualifier, url", async () => {
    // Even on empty pool, the shape declaration should be typed correctly.
    const r = await computeHobbyIqFmv({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto" });
    // The type declaration itself is verified by tsc; this test just
    // confirms the runtime shape doesn't include unexpected extras.
    expect(Array.isArray(r.recentComps)).toBe(true);
    for (const c of r.recentComps) {
      expect(Object.keys(c).sort()).toEqual([
        "autoStyle", "gradeQualifier", "parallel", "price", "soldAt", "source", "url",
      ]);
    }
  });
});
