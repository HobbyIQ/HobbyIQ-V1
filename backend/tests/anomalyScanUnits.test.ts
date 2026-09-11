/**
 * scripts/lib/anomaly-scan-units.cjs -- the (cardYear, sportClass) unit
 * enumeration + predicate math anomaly-force-scan.cjs walks. Pure, no I/O,
 * so the boundary math is pinned directly -- same discipline
 * tests/rematchShardingAndCanary.test.ts applies to rematch-sold-comps.cjs's
 * own unit helpers: PARTITION (every unit disjoint, together they cover the
 * whole space) and no gap at the absent/null/value year boundary.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Unit = { index: number; yearKind: "absent" | "null" | "value"; year: number | null; sportClass: string };
type Lib = {
  SPORT_CLASSES: string[];
  SPORT_CLASSES_WITH_OTHER: string[];
  MIN_CARD_YEAR: number;
  maxCardYear: (now?: Date) => number;
  enumerateUnits: (opts?: { minYear?: number; maxYear?: number }) => Unit[];
  unitCount: (opts?: { minYear?: number; maxYear?: number }) => number;
  unitPredicate: (unit: Unit, i?: number) => { where: string; params: { name: string; value: unknown }[] };
  unitQuery: (unit: Unit, i?: number) => { query: string; parameters: { name: string; value: unknown }[] };
  rowInUnit: (row: Record<string, unknown>, unit: Unit) => boolean;
};
const lib = require_(path.join(backend, "scripts", "lib", "anomaly-scan-units.cjs")) as Lib;

describe("anomaly-scan-units — enumeration is a real partition", () => {
  it("unitCount matches enumerateUnits().length for a small range", () => {
    const opts = { minYear: 2020, maxYear: 2022 };
    expect(lib.enumerateUnits(opts)).toHaveLength(lib.unitCount(opts));
  });

  it("unitCount matches the default (production) range too", () => {
    expect(lib.enumerateUnits()).toHaveLength(lib.unitCount());
  });

  it("every unit index is unique and dense, 0..n-1, in enumeration order", () => {
    const units = lib.enumerateUnits({ minYear: 2020, maxYear: 2021 });
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
  });

  it("the absent/null buckets come first, one per sport class, before any real year", () => {
    const units = lib.enumerateUnits({ minYear: 2020, maxYear: 2020 });
    const absentCount = units.filter((u) => u.yearKind === "absent").length;
    const nullCount = units.filter((u) => u.yearKind === "null").length;
    expect(absentCount).toBe(lib.SPORT_CLASSES_WITH_OTHER.length);
    expect(nullCount).toBe(lib.SPORT_CLASSES_WITH_OTHER.length);
    // First 2*|classes| units are absent/null; everything after is a real year.
    const boundary = 2 * lib.SPORT_CLASSES_WITH_OTHER.length;
    expect(units.slice(0, boundary).every((u) => u.yearKind !== "value")).toBe(true);
    expect(units.slice(boundary).every((u) => u.yearKind === "value")).toBe(true);
  });

  it("value-year units cover every year in [minYear, maxYear] x every sport class, exactly once each", () => {
    const units = lib.enumerateUnits({ minYear: 2020, maxYear: 2022 }).filter((u) => u.yearKind === "value");
    const seen = new Set(units.map((u) => `${u.year}|${u.sportClass}`));
    expect(seen.size).toBe(units.length); // no duplicates
    for (let y = 2020; y <= 2022; y++) {
      for (const sc of lib.SPORT_CLASSES_WITH_OTHER) {
        expect(seen.has(`${y}|${sc}`)).toBe(true);
      }
    }
    expect(units).toHaveLength(3 * lib.SPORT_CLASSES_WITH_OTHER.length);
  });

  it("a one-year range still produces every sport class, absent and null buckets included", () => {
    const units = lib.enumerateUnits({ minYear: 2020, maxYear: 2020 });
    expect(units).toHaveLength(lib.SPORT_CLASSES_WITH_OTHER.length * 3);
  });

  it("throws rather than silently enumerating nothing when maxYear < minYear", () => {
    expect(() => lib.enumerateUnits({ minYear: 2025, maxYear: 2020 })).toThrow();
  });

  it("maxCardYear is next calendar year, deterministic under an injected clock", () => {
    expect(lib.maxCardYear(new Date(Date.UTC(2026, 8, 11)))).toBe(2027);
    expect(lib.maxCardYear(new Date(Date.UTC(2030, 0, 1)))).toBe(2031);
  });

  it("the default range's earliest year is MIN_CARD_YEAR and its latest is maxCardYear()", () => {
    const units = lib.enumerateUnits().filter((u) => u.yearKind === "value");
    const years = units.map((u) => u.year as number);
    expect(Math.min(...years)).toBe(lib.MIN_CARD_YEAR);
    expect(Math.max(...years)).toBe(lib.maxCardYear());
  });
});

describe("anomaly-scan-units — rowInUnit agrees with the predicate math, and units never overlap", () => {
  const rows: Record<string, unknown>[] = [
    { hobbyiqCardId: "a", price: 10, source: "cardhedge", cardYear: 2021, sport: "baseball" },
    { hobbyiqCardId: "b", price: 10, source: "cardhedge", cardYear: 2021, sport: "football" },
    { hobbyiqCardId: "c", price: 10, source: "cardhedge", cardYear: 2021, sport: "curling" }, // -> "other"
    { hobbyiqCardId: "d", price: 10, source: "cardhedge", cardYear: null, sport: "baseball" },
    { hobbyiqCardId: "e", price: 10, source: "cardhedge", sport: "baseball" }, // cardYear absent entirely
  ];

  it("every row belongs to EXACTLY ONE unit in a range that covers it", () => {
    const units = lib.enumerateUnits({ minYear: 2021, maxYear: 2021 });
    for (const row of rows) {
      const owners = units.filter((u) => lib.rowInUnit(row, u));
      expect(owners, `row ${JSON.stringify(row)} matched ${owners.length} units`).toHaveLength(1);
    }
  });

  it("a sport outside the four named classes belongs to the 'other' bucket, not to any named class", () => {
    const units = lib.enumerateUnits({ minYear: 2021, maxYear: 2021 });
    const curlingRow = rows[2];
    const owner = units.find((u) => lib.rowInUnit(curlingRow, u));
    expect(owner?.sportClass).toBe("other");
  });

  it("absent and null cardYear are two DIFFERENT populations, not one", () => {
    const units = lib.enumerateUnits({ minYear: 2021, maxYear: 2021 });
    const nullRow = rows[3];
    const absentRow = rows[4];
    const nullOwner = units.find((u) => lib.rowInUnit(nullRow, u));
    const absentOwner = units.find((u) => lib.rowInUnit(absentRow, u));
    expect(nullOwner?.yearKind).toBe("null");
    expect(absentOwner?.yearKind).toBe("absent");
    expect(nullOwner).not.toBe(absentOwner);
  });

  it("unitQuery's WHERE clause and unitPredicate() agree, and always constrains both cardYear and sport", () => {
    const unit: Unit = { index: 0, yearKind: "value", year: 2021, sportClass: "baseball" };
    const { where, params } = lib.unitPredicate(unit, 3);
    expect(where).toContain("c.cardYear = @y3");
    expect(where).toContain("c.sport = @s3");
    expect(params.map((p) => p.name)).toEqual(["@y3", "@s3"]);

    const { query, parameters } = lib.unitQuery(unit, 3);
    expect(query).toContain("STARTSWITH(c.hobbyiqCardId, 'hiq:')");
    expect(query).toContain("IS_DEFINED(c.price)");
    expect(query).toContain(where);
    expect(parameters).toEqual(params);
  });

  it("the 'other' predicate parameterises every named sport class as a NOT IN", () => {
    const unit: Unit = { index: 0, yearKind: "value", year: 2021, sportClass: "other" };
    const { where, params } = lib.unitPredicate(unit, 0);
    expect(where).toMatch(/NOT \(c\.sport IN \(/);
    const scParams = params.filter((p) => p.name.startsWith("@sc"));
    expect(scParams.map((p) => p.value).sort()).toEqual([...lib.SPORT_CLASSES].sort());
  });

  it("two units at different positional indices never collide on parameter names", () => {
    const unitA: Unit = { index: 0, yearKind: "value", year: 2021, sportClass: "other" };
    const unitB: Unit = { index: 1, yearKind: "value", year: 2022, sportClass: "baseball" };
    const a = lib.unitPredicate(unitA, 0);
    const b = lib.unitPredicate(unitB, 1);
    const names = new Set([...a.params.map((p) => p.name), ...b.params.map((p) => p.name)]);
    expect(names.size).toBe(a.params.length + b.params.length);
  });
});
