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
const { parseMinRowsSpec, rowFloorVerdicts, median, volumeVerdicts, numEnv } =
  require("../scripts/checkSoldCompsFreshness.cjs") as {
    parseMinRowsSpec: (spec: string | undefined) => Map<string, number>;
    rowFloorVerdicts: (
      counts: Record<string, number>,
      floors: Map<string, number>,
    ) => Array<{ source: string; count: number; floor: number; ok: boolean }>;
    median: (values: number[]) => number;
    volumeVerdicts: (
      perSource: Record<string, { current: number; baselineCounts: number[] }>,
      opts: { fraction: number; minBaseline: number },
    ) => Array<{
      source: string; current: number; baseline: number;
      floor: number; exempt: boolean; ok: boolean;
    }>;
    numEnv: (raw: string | undefined, dflt: number) => number;
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
  it("records the measurement the armed floor was derived from", () => {
    // CF-CHRONIC-REDS-DRIFT (2026-09-03). This asserted the literal
    // `tca-ebay=2300`. D33 re-derived the floor and the workflow now arms
    // `tca-ebay=25000`, so the pin failed on a number that was never the
    // point -- a floor is SUPPOSED to move when it is re-measured, and a test
    // that forbids that is a test that has to be edited every time the axis is
    // tuned.
    //
    // The invariant it MEANT is provenance: the number the workflow arms must
    // be a measured one, written down in the file next to it, not a guess.
    // Assert the mechanism -- whatever floor is armed appears in the recorded
    // measurement block -- so re-tuning stays green and an UNDOCUMENTED floor
    // still goes red.
    const armed = yml.match(/MIN_ROWS_24H="\$\{\{ inputs\.min_rows_24h \|\| 'tca-ebay=(\d+)' \}\}"/);
    expect(armed, "the workflow must arm a tca-ebay floor").not.toBeNull();
    const floor = Number(armed![1]);
    expect(floor).toBeGreaterThan(0);

    // The measurement block that justifies it: a dated read-only measurement,
    // and the armed number cited in the prose around it.
    expect(yml).toMatch(/Measured \d{4}-\d{2}-\d{2}/);
    expect(
      yml.split("\n").some((l) => l.startsWith("#") && l.includes(String(floor))),
      `the armed floor ${floor} must be justified in a comment, not unexplained`,
    ).toBe(true);
  });
});

// D33 (2026-09-02) — the VOLUME FLOOR axis. A static per-source floor has to
// be hand-set, so only tca-ebay ever carried one and a collapse on any other
// source was unalertable. The floor is now derived per source from its own
// rolling baseline.
describe("median", () => {
  it("odd length takes the middle; even length averages the two middles", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2); // floor(2.5)
  });
  it("ignores non-finite values and reads empty as 0", () => {
    expect(median([])).toBe(0);
    expect(median([NaN, 4, 2, 6] as number[])).toBe(4);
  });
  it("a backfill spike does not move it the way a mean would", () => {
    // tca-ebay's real 08-29 spike against its ~90k/day norm.
    const days = [88000, 90000, 92000, 89000, 438651];
    expect(median(days)).toBe(90000);
    const mean = days.reduce((a, b) => a + b, 0) / days.length;
    expect(mean).toBeGreaterThan(150000); // a mean baseline would be badly inflated
  });
});

describe("numEnv", () => {
  it("blank / undefined / junk / negative fall back to the default", () => {
    expect(numEnv(undefined, 0.5)).toBe(0.5);
    expect(numEnv("", 0.5)).toBe(0.5);
    expect(numEnv("abc", 0.5)).toBe(0.5);
    expect(numEnv("-1", 0.5)).toBe(0.5);
  });
  it("a valid number overrides, including 0 (which disables the axis)", () => {
    expect(numEnv("0.25", 0.5)).toBe(0.25);
    expect(numEnv("0", 0.5)).toBe(0);
  });
});

describe("volumeVerdicts", () => {
  const opts = { fraction: 0.5, minBaseline: 1000 };

  it("a collapse FIRES — the measured CH-lapse state on tca-ebay", () => {
    // Real measured series, 2026-09-02: 488 rows on 09-01 against the 14
    // full days 08-18..08-31. Note the baseline still contains the decline
    // itself (9302/11906/9277/7077/573) and the 438651 backfill spike — the
    // median rides over both and still reads the healthy ~88k/day level.
    const v = volumeVerdicts(
      {
        "tca-ebay": {
          current: 488,
          baselineCounts: [89040, 87014, 80765, 99654, 100162, 114140, 108882, 100941, 9302, 11906, 9277, 438651, 7077, 573],
        },
      },
      opts,
    )[0];
    expect(v.exempt).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.baseline).toBe(88027);
    expect(v.floor).toBe(44013);
    expect(v.current).toBe(488);
  });

  it("a healthy source PASSES — measured cardhedge on the same day", () => {
    // Real measured series, 08-18..08-31. cardhedge is spiky and demand-
    // driven (1.2M/day highs, 12k lows) — exactly the shape nobody would
    // hand-set a static floor for, and it still passes cleanly here.
    const v = volumeVerdicts(
      {
        cardhedge: {
          current: 100867,
          baselineCounts: [1169109, 1200731, 23175, 84503, 189574, 29216, 51683, 92280, 97826, 51069, 12842, 245433, 14436, 33707],
        },
      },
      opts,
    )[0];
    expect(v.exempt).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.baseline).toBe(68093);
    expect(v.floor).toBe(34046);
    expect(v.current).toBeGreaterThanOrEqual(v.floor);
  });

  it("a retired source is EXEMPT and cannot flap — cardsight's real series", () => {
    // 21d median 0, with occasional 253-row blips that must not read as
    // "recovered then collapsed" on successive runs.
    const v = volumeVerdicts(
      { cardsight: { current: 0, baselineCounts: [0, 0, 253, 0, 0, 3, 0, 2, 0, 0, 0, 0, 0, 132] } },
      opts,
    )[0];
    expect(v.exempt).toBe(true);
    expect(v.ok).toBe(true); // exempt can never fire
  });

  it("a tiny source is EXEMPT even when it drops to zero", () => {
    const v = volumeVerdicts(
      { "user-entry": { current: 0, baselineCounts: [12, 30, 8, 41, 19, 22, 5, 17, 26, 9, 33, 14, 21, 11] } },
      opts,
    )[0];
    expect(v.exempt).toBe(true);
    expect(v.ok).toBe(true);
  });

  it("a source just above the minimum baseline is NOT exempt and can fire", () => {
    const v = volumeVerdicts(
      { edge: { current: 10, baselineCounts: Array(14).fill(1000) } },
      opts,
    )[0];
    expect(v.exempt).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.floor).toBe(500);
  });

  it("exactly at the floor is ok", () => {
    const v = volumeVerdicts(
      { s: { current: 5000, baselineCounts: Array(14).fill(10000) } },
      opts,
    )[0];
    expect(v.ok).toBe(true);
  });

  it("thresholds are tunable — a stricter fraction fires where 0.5 passed", () => {
    const data = { s: { current: 6000, baselineCounts: Array(14).fill(10000) } };
    expect(volumeVerdicts(data, { fraction: 0.5, minBaseline: 1000 })[0].ok).toBe(true);
    expect(volumeVerdicts(data, { fraction: 0.8, minBaseline: 1000 })[0].ok).toBe(false);
  });

  it("a higher minBaseline exempts a source that would otherwise fire", () => {
    const data = { s: { current: 0, baselineCounts: Array(14).fill(2000) } };
    expect(volumeVerdicts(data, { fraction: 0.5, minBaseline: 1000 })[0].ok).toBe(false);
    expect(volumeVerdicts(data, { fraction: 0.5, minBaseline: 5000 })[0].exempt).toBe(true);
  });

  it("fraction 0 disables the axis entirely", () => {
    const data = { s: { current: 0, baselineCounts: Array(14).fill(100000) } };
    expect(volumeVerdicts(data, { fraction: 0, minBaseline: 1000 })).toEqual([]);
  });

  it("every checked source gets exactly one verdict — the reconcile line's arithmetic", () => {
    const v = volumeVerdicts(
      {
        "tca-ebay": { current: 488, baselineCounts: Array(14).fill(88027) },
        cardhedge: { current: 100867, baselineCounts: Array(14).fill(68093) },
        cardsight: { current: 0, baselineCounts: Array(14).fill(0) },
      },
      opts,
    );
    expect(v).toHaveLength(3);
    const fired = v.filter((x) => !x.ok).length;
    const passed = v.filter((x) => x.ok && !x.exempt).length;
    const exempt = v.filter((x) => x.exempt).length;
    expect(fired + passed + exempt).toBe(v.length);
    expect([fired, passed, exempt]).toEqual([1, 1, 1]);
  });
});

describe("the workflow arms the volume axis", () => {
  const yml = fs
    .readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "sold-comps-freshness-canary.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  it("passes all three volume knobs with the shipped defaults", () => {
    expect(yml).toMatch(/VOLUME_FLOOR_FRACTION="\$\{\{ inputs\.volume_floor_fraction \|\| '0\.5' \}\}"/);
    expect(yml).toMatch(/BASELINE_DAYS="\$\{\{ inputs\.baseline_days \|\| '14' \}\}"/);
    expect(yml).toMatch(/MIN_BASELINE_ROWS="\$\{\{ inputs\.min_baseline_rows \|\| '1000' \}\}"/);
  });
  it("records the measurement the axis was validated against", () => {
    expect(yml).toContain("88027");
    expect(yml).toContain("44013");
  });
});
