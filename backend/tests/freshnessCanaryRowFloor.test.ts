// D13 (2026-08-29) — alert gates prove delivery. The freshness canary
// could not tell the firehose from the webhook trickle: while the nightly
// firehose is dead the 30-minute webhook keeps observedAt fresh, so the
// 08-03 outage shape read "OK". MIN_ROWS_24H is the second axis. Pins:
//   - spec parsing ("tca-ebay=500,cardhedge=0"; blank = off; junk ignored)
//   - verdicts: below floor → not ok; at floor → ok; floor 0 → not checked
//   - default off: an empty spec yields no verdicts
//   - the workflow sets the tca-ebay floor from the measured minimum day
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseMinRowsSpec, rowFloorVerdicts } = require("../scripts/checkSoldCompsFreshness.cjs") as {
  parseMinRowsSpec: (spec: string | undefined) => Map<string, number>;
  rowFloorVerdicts: (
    counts: Record<string, number>,
    floors: Map<string, number>,
  ) => Array<{ source: string; count: number; floor: number; ok: boolean }>;
};

describe("parseMinRowsSpec", () => {
  it("parses the documented format", () => {
    const m = parseMinRowsSpec("tca-ebay=500,cardhedge=0");
    expect([...m]).toEqual([["tca-ebay", 500], ["cardhedge", 0]]);
  });
  it("blank / undefined → empty (axis off by default)", () => {
    expect(parseMinRowsSpec("")).toEqual(new Map());
    expect(parseMinRowsSpec(undefined)).toEqual(new Map());
  });
  it("ignores malformed, negative and non-numeric entries; tolerates whitespace", () => {
    const m = parseMinRowsSpec(" tca-ebay = 2300 , =5, junk, cardhedge=abc, x=-1, y=1.9 ");
    expect([...m]).toEqual([["tca-ebay", 2300], ["y", 1]]);
  });
});

describe("rowFloorVerdicts", () => {
  const floors = parseMinRowsSpec("tca-ebay=2300,cardhedge=0");
  it("below the floor is NOT ok and carries the count", () => {
    const v = rowFloorVerdicts({ "tca-ebay": 1200 }, floors);
    expect(v).toEqual([{ source: "tca-ebay", count: 1200, floor: 2300, ok: false }]);
  });
  it("exactly at the floor is ok", () => {
    expect(rowFloorVerdicts({ "tca-ebay": 2300 }, floors)[0].ok).toBe(true);
  });
  it("a source with floor 0 is not checked; a missing count reads as 0", () => {
    const v = rowFloorVerdicts({}, floors);
    expect(v.map((x) => x.source)).toEqual(["tca-ebay"]);
    expect(v[0]).toMatchObject({ count: 0, ok: false });
  });
  it("empty spec → no verdicts (default off)", () => {
    expect(rowFloorVerdicts({ "tca-ebay": 0 }, new Map())).toEqual([]);
  });
});

describe("the workflow arms the axis from measured numbers", () => {
  const yml = fs
    .readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "sold-comps-freshness-canary.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  it("passes MIN_ROWS_24H with a tca-ebay floor", () => {
    expect(yml).toMatch(/MIN_ROWS_24H="\$\{\{ inputs\.min_rows_24h \|\| 'tca-ebay=\d+' \}\}"/);
  });
  it("records the 7-day measurement the floor was derived from", () => {
    expect(yml).toContain("9280");
    expect(yml).toMatch(/tca-ebay=2300/);
  });
});
