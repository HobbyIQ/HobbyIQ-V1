// CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31). Pinning tests for the gap
// classifier tags. Every input is constructed inline; the twin and
// release-date probes are injected, so no test touches Cosmos or a network.

import { describe, it, expect } from "vitest";
import {
  classifyGap,
  classifyGaps,
  canonicalTwinOf,
  isFutureRelease,
  lanesFor,
  triageHeadline,
  noReleaseDateProbe,
  LANES,
  _TWIN_MIN_RATIO,
  _TWIN_MIN_ROWS,
  type GapEntry,
  type TwinProbe,
  type ReleaseDateProbe,
} from "../src/services/catalog/gapTriage.service.js";

const ASOF = "2026-08-31";

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

/** No twin anywhere. */
const noTwin: TwinProbe = async () => 0;
/** A twin that is richly checklist-backed. */
const richTwin: TwinProbe = async () => 1200;

const releasesOn = (date: string): ReleaseDateProbe => async () => date;

describe("classifyGap — IMPOSSIBLE-COMPS", () => {
  it("tags a future release that nevertheless carries comps, and routes to slug repair", async () => {
    const r = await classifyGap(gap({ year: 2027, setKey: "topps-chrome", comps: 412 }), {
      twinProbe: noTwin,
      releaseDateProbe: releasesOn("2027-03-15"),
      asOf: ASOF,
    });
    expect(r.tag).toBe("IMPOSSIBLE-COMPS");
    expect(r.route).toBe("slug-repair");
    expect(r.reason).toContain("412");
    expect(r.reason).toContain("cannot sell before it exists");
  });

  it("beats UNRELEASED on the same future date — the contradiction is the finding", async () => {
    const opts = { twinProbe: noTwin, releaseDateProbe: releasesOn("2027-03-15"), asOf: ASOF };
    const withComps = await classifyGap(gap({ year: 2027, comps: 1 }), opts);
    const without = await classifyGap(gap({ year: 2027, comps: 0 }), opts);
    expect(withComps.tag).toBe("IMPOSSIBLE-COMPS");
    expect(without.tag).toBe("UNRELEASED");
  });
});

describe("classifyGap — UNRELEASED", () => {
  it("tags a future release with zero comps and routes to wait", async () => {
    const r = await classifyGap(gap({ year: 2027, comps: 0 }), {
      twinProbe: noTwin,
      releaseDateProbe: releasesOn("2027-02-01"),
      asOf: ASOF,
    });
    expect(r.tag).toBe("UNRELEASED");
    expect(r.route).toBe("wait");
  });

  it("does NOT fire when the probe returns null — no lane exposing a date means UNKNOWN, not unreleased", async () => {
    const r = await classifyGap(gap({ year: 2027, comps: 0 }), {
      twinProbe: noTwin,
      releaseDateProbe: noReleaseDateProbe,
      asOf: ASOF,
    });
    expect(r.tag).not.toBe("UNRELEASED");
    expect(r.tag).not.toBe("IMPOSSIBLE-COMPS");
  });

  it("does NOT fire on a release date that is today or past", async () => {
    for (const d of ["2026-08-31", "2026-08-30", "2001-01-01"]) {
      const r = await classifyGap(gap({ comps: 0 }), {
        twinProbe: noTwin,
        releaseDateProbe: releasesOn(d),
        asOf: ASOF,
      });
      expect(r.tag, `release ${d}`).not.toBe("UNRELEASED");
    }
  });
});

describe("classifyGap — VOCAB-TWIN", () => {
  it("tags a gap whose product the vocabulary spells differently, when the twin is richly backed", async () => {
    // "topps-update" is a known alias of the ruled spelling "topps-update-series".
    const r = await classifyGap(gap({ setKey: "topps-update", checklistRows: 4 }), {
      twinProbe: richTwin,
      asOf: ASOF,
    });
    expect(r.tag).toBe("VOCAB-TWIN");
    expect(r.route).toBe("vocab-repair");
    expect(r.twinSetKey).toBe("topps-update-series");
    expect(r.twinChecklistRows).toBe(1200);
    expect(r.reason).toContain("under another key");
  });

  it("refuses the twin when the candidate is no better backed than the gap itself", async () => {
    // Same thin coverage under both spellings is one hole spelled twice.
    const r = await classifyGap(gap({ setKey: "topps-update", checklistRows: 10 }), {
      twinProbe: async () => 12,
      asOf: ASOF,
    });
    expect(r.tag).not.toBe("VOCAB-TWIN");
  });

  it("enforces the absolute row floor so a 0-vs-1 comparison cannot clear the ratio", async () => {
    const r = await classifyGap(gap({ setKey: "topps-update", checklistRows: 0 }), {
      twinProbe: async () => 1,
      asOf: ASOF,
    });
    expect(r.tag).not.toBe("VOCAB-TWIN");
    expect(_TWIN_MIN_ROWS).toBe(25);
    expect(_TWIN_MIN_RATIO).toBe(3);
  });

  it("beats UNREACHABLE — an owned checklist is never hidden behind a lane excuse", async () => {
    // 1998 football: no insider (2022+), no hobbymonitor (2024+), not baseball
    // for BCP — beckett is the only lane, so force the no-lane case via a sport
    // BCP cannot serve and a year the modern lanes cannot.
    const r = await classifyGap(gap({ sport: "football", year: 1998, setKey: "topps-update", checklistRows: 3 }), {
      twinProbe: richTwin,
      asOf: ASOF,
    });
    expect(r.tag).toBe("VOCAB-TWIN");
  });
});

describe("canonicalTwinOf — the vocabulary decides, and the Donruss era ruling applies", () => {
  it("resolves a known alias to the ruled spelling", () => {
    expect(canonicalTwinOf("topps-update", 2015)).toBe("topps-update-series");
    expect(canonicalTwinOf("topps-series-one", 2015)).toBe("topps-series-1");
  });

  it("returns null for a key that is already canonical — a product is not its own twin", () => {
    expect(canonicalTwinOf("topps-update-series", 2015)).toBeNull();
    expect(canonicalTwinOf("topps", 2015)).toBeNull();
  });

  it("applies the 2009 Panini boundary rather than calling donruss its own twin", () => {
    // Panini did not own Donruss until 2009.
    expect(canonicalTwinOf("panini-donruss", 1990)).toBe("donruss");
    expect(canonicalTwinOf("donruss", 1990)).toBeNull();
    expect(canonicalTwinOf("donruss", 2015)).toBe("panini-donruss");
  });

  it("returns null on an unknown key rather than inventing a candidate", () => {
    expect(canonicalTwinOf("not-a-real-product-xyz", 2015)).toBeNull();
    expect(canonicalTwinOf("", 2015)).toBeNull();
  });
});

describe("lanesFor — the static reachability table", () => {
  it("gives a modern baseball year every lane", () => {
    const names = lanesFor("baseball", 2025).map((l) => l.name);
    expect(names).toContain("checklistinsider");
    expect(names).toContain("hobbymonitor");
    expect(names).toContain("baseballcardpedia");
    expect(names).toContain("beckett");
  });

  it("holds insider to 2022+ and hobbymonitor to modern", () => {
    expect(lanesFor("baseball", 2021).map((l) => l.name)).not.toContain("checklistinsider");
    expect(lanesFor("baseball", 2022).map((l) => l.name)).toContain("checklistinsider");
    expect(lanesFor("baseball", 2010).map((l) => l.name)).not.toContain("hobbymonitor");
  });

  it("keeps BCP to baseball only", () => {
    expect(lanesFor("baseball", 1995).map((l) => l.name)).toContain("baseballcardpedia");
    expect(lanesFor("football", 1995).map((l) => l.name)).not.toContain("baseballcardpedia");
    expect(lanesFor("basketball", 1995).map((l) => l.name)).not.toContain("baseballcardpedia");
  });

  it("never lists cardboardconnection — the domain is dead and would relabel unreachable gaps as work", () => {
    expect(LANES.map((l) => l.name)).not.toContain("cardboardconnection");
    for (const y of [1985, 2005, 2026]) {
      expect(lanesFor("baseball", y).map((l) => l.name)).not.toContain("cardboardconnection");
    }
  });
});

describe("classifyGap — DISPATCHABLE and UNREACHABLE", () => {
  it("tags a real, released, correctly-keyed, reachable hole as DISPATCHABLE", async () => {
    const r = await classifyGap(gap({ sport: "baseball", year: 1995, setKey: "topps", checklistRows: 8, distinctNumbers: 400 }), {
      twinProbe: noTwin,
      asOf: ASOF,
    });
    expect(r.tag).toBe("DISPATCHABLE");
    expect(r.route).toBe("acquire");
    expect(r.reason).toContain("beckett");
  });

  it("names the lane(s) that can actually serve it", async () => {
    const r = await classifyGap(gap({ sport: "baseball", year: 2025, setKey: "topps" }), {
      twinProbe: noTwin,
      asOf: ASOF,
    });
    expect(r.tag).toBe("DISPATCHABLE");
    expect(r.reason).toContain("checklistinsider");
    expect(r.reason).toContain("baseballcardpedia");
  });
});

describe("classifyGaps + triageHeadline — the honest headline", () => {
  it("says plainly that nothing is dispatchable when every gap triages away", async () => {
    const s = await classifyGaps(
      [gap({ setKey: "topps-update", checklistRows: 2 }), gap({ setKey: "topps-series-one", checklistRows: 2 })],
      { twinProbe: richTwin, asOf: ASOF },
    );
    expect(s.byTag["VOCAB-TWIN"]).toBe(2);
    expect(s.dispatchable).toHaveLength(0);
    const h = triageHeadline(s);
    expect(h).toContain("Nothing to dispatch");
    expect(h).toContain("2 already ours under another key");
  });

  it("counts each tag and exposes only DISPATCHABLE entries for a dispatch", async () => {
    const s = await classifyGaps(
      [
        gap({ sport: "baseball", year: 1995, setKey: "topps" }),          // dispatchable
        gap({ setKey: "topps-update", checklistRows: 2 }),                 // vocab twin
        gap({ sport: "baseball", year: 2027, setKey: "bowman", comps: 9 }), // impossible comps
      ],
      {
        twinProbe: async (_s, _y, k) => (k === "topps-update-series" ? 900 : 0),
        releaseDateProbe: async (_s, y) => (y === 2027 ? "2027-04-01" : null),
        asOf: ASOF,
      },
    );
    expect(s.total).toBe(3);
    expect(s.byTag.DISPATCHABLE).toBe(1);
    expect(s.byTag["VOCAB-TWIN"]).toBe(1);
    expect(s.byTag["IMPOSSIBLE-COMPS"]).toBe(1);
    expect(s.dispatchable).toHaveLength(1);
    expect(s.dispatchable[0].setKey).toBe("topps");
    expect(triageHeadline(s)).toContain("1 of 3 gaps are dispatchable");
  });

  it("handles an empty report without claiming work", async () => {
    const s = await classifyGaps([], { twinProbe: noTwin, asOf: ASOF });
    expect(s.total).toBe(0);
    expect(triageHeadline(s)).toBe("No gaps on the report.");
  });
});

describe("isFutureRelease", () => {
  it("is strict — a release dated today is not future", () => {
    expect(isFutureRelease("2026-08-31", ASOF)).toBe(false);
    expect(isFutureRelease("2026-09-01", ASOF)).toBe(true);
    expect(isFutureRelease("2026-08-30", ASOF)).toBe(false);
  });

  it("treats a null date as not-future rather than guessing", () => {
    expect(isFutureRelease(null, ASOF)).toBe(false);
  });

  it("tolerates a full ISO timestamp", () => {
    expect(isFutureRelease("2027-01-05T00:00:00.000Z", ASOF)).toBe(true);
  });
});
