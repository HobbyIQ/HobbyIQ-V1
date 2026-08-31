// CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31). Pinning tests for the
// night-over-night gap diff. Pure math, every input inline.

import { describe, it, expect } from "vitest";
import {
  diffGapReports,
  diffHeadline,
  gapKey,
} from "../src/services/catalog/gapHistory.service.js";
import type { GapEntry } from "../src/services/catalog/gapTriage.service.js";

function gap(o: Partial<GapEntry> = {}): GapEntry {
  const distinctNumbers = o.distinctNumbers ?? 300;
  const checklistRows = o.checklistRows ?? 10;
  return {
    sport: o.sport ?? "baseball",
    year: o.year ?? 2015,
    setKey: o.setKey ?? "topps",
    comps: o.comps ?? 5000,
    distinctNumbers,
    checklistRows,
    coverage: o.coverage ?? checklistRows / distinctNumbers,
    uncovered: o.uncovered ?? Math.max(0, distinctNumbers - checklistRows),
  };
}

describe("gapKey — identity is (sport, year, setKey)", () => {
  it("folds case but never folds two different products together", () => {
    expect(gapKey(gap({ sport: "Baseball", setKey: "Topps" })))
      .toBe(gapKey(gap({ sport: "baseball", setKey: "topps" })));
    expect(gapKey(gap({ setKey: "topps" })))
      .not.toBe(gapKey(gap({ setKey: "topps-chrome" })));
    expect(gapKey(gap({ year: 2015 })))
      .not.toBe(gapKey(gap({ year: 2016 })));
    expect(gapKey(gap({ sport: "baseball" })))
      .not.toBe(gapKey(gap({ sport: "football" })));
  });
});

describe("diffGapReports — first run", () => {
  it("reports a baseline rather than calling the whole first report NEW", () => {
    const d = diffGapReports([gap(), gap({ setKey: "topps-chrome" })], null);
    expect(d.baseline).toBe(true);
    expect(d.added).toHaveLength(0);
    expect(d.closed).toHaveLength(0);
    expect(d.unchanged).toHaveLength(2);
    expect(diffHeadline(d)).toContain("no prior night");
  });
});

describe("diffGapReports — closed / new / moved", () => {
  const prior = [
    gap({ setKey: "topps", checklistRows: 10, uncovered: 290 }),
    gap({ setKey: "topps-chrome", checklistRows: 5, uncovered: 195, distinctNumbers: 200 }),
    gap({ setKey: "bowman", checklistRows: 0, uncovered: 100, distinctNumbers: 100 }),
  ];

  it("names a gap that LEFT the report as closed", () => {
    // bowman is gone tonight.
    const current = [prior[0], prior[1]];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.closed.map((g) => g.setKey)).toEqual(["bowman"]);
    expect(d.added).toHaveLength(0);
  });

  it("names a gap that ARRIVED as new", () => {
    const current = [...prior, gap({ setKey: "panini-prizm", uncovered: 50 })];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.added.map((g) => g.setKey)).toEqual(["panini-prizm"]);
    expect(d.closed).toHaveLength(0);
  });

  it("computes per-entry deltas for a gap that moved", () => {
    const current = [
      gap({ setKey: "topps", checklistRows: 260, uncovered: 40, comps: 5200 }),
      prior[1],
      prior[2],
    ];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.changed).toHaveLength(1);
    const c = d.changed[0];
    expect(c.setKey).toBe("topps");
    expect(c.checklistRowsBefore).toBe(10);
    expect(c.checklistRowsAfter).toBe(260);
    expect(c.checklistRowsDelta).toBe(250);
    expect(c.uncoveredBefore).toBe(290);
    expect(c.uncoveredAfter).toBe(40);
    expect(c.uncoveredDelta).toBe(-250);
    expect(c.compsDelta).toBe(200);
  });

  it("separates unchanged entries from movers", () => {
    const d = diffGapReports([...prior], prior, "2026-08-30");
    expect(d.changed).toHaveLength(0);
    expect(d.unchanged).toHaveLength(3);
    expect(diffHeadline(d)).toContain("No change since 2026-08-30");
  });

  it("sorts movers by improvement, biggest first", () => {
    const current = [
      gap({ setKey: "topps", checklistRows: 60, uncovered: 240 }),          // -50
      gap({ setKey: "topps-chrome", checklistRows: 105, uncovered: 95, distinctNumbers: 200 }), // -100
      prior[2],
    ];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.changed.map((c) => c.setKey)).toEqual(["topps-chrome", "topps"]);
  });

  it("counts uncovered closed across both departures and improvements", () => {
    const current = [
      gap({ setKey: "topps", checklistRows: 110, uncovered: 190 }), // -100 improvement
      prior[1],
      // bowman (100 uncovered) left entirely
    ];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.uncoveredClosed).toBe(200);
    expect(d.checklistRowsGained).toBe(100);
  });

  it("does not count a REGRESSION as progress", () => {
    const current = [
      gap({ setKey: "topps", checklistRows: 2, uncovered: 298 }), // got worse
      prior[1],
      prior[2],
    ];
    const d = diffGapReports(current, prior, "2026-08-30");
    expect(d.changed[0].uncoveredDelta).toBe(8);
    expect(d.uncoveredClosed).toBe(0);
    expect(d.checklistRowsGained).toBe(0);
  });
});

describe("diffHeadline", () => {
  it("summarises movement in one line", () => {
    const prior = [gap({ setKey: "a" }), gap({ setKey: "b" })];
    const current = [gap({ setKey: "a", checklistRows: 200, uncovered: 100 }), gap({ setKey: "c" })];
    const d = diffGapReports(current, prior, "2026-08-30");
    const h = diffHeadline(d);
    expect(h).toContain("1 closed");
    expect(h).toContain("1 new");
    expect(h).toContain("1 moved");
    expect(h).toContain("+190 checklist rows");
  });
});
