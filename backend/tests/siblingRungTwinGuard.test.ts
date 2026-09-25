/**
 * CF-A-SIBLING-KEY-IS-STILL-THE-SAME-RUNG (Drew, 2026-09-25).
 *
 * Unit tests for the PURE half of the rung-level sibling guard --
 * `scripts/lib/sibling-rung-twin.cjs` -- with fakes, so the branch logic is
 * pinned independent of any Cosmos container shape. The end-to-end wiring
 * through the real ingest script (exact-id checklist skip, exact-id derived
 * write, sibling-twin skip with an example, no-twin write, and the balanced
 * reconciliation) is covered separately in
 * tests/ingestSkipsExactIdChecklistAndSiblingRungTwins.test.ts, which drives
 * the actual script as a child process.
 */
import { describe, it, expect } from "vitest";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("../scripts/lib/sibling-rung-twin.cjs");

const parallelSlugOf = (p: string) => slugify(p || "Base");

describe("siblingRungTwinQuery", () => {
  it("filters by sport, year (or cardYear) and cardNumber only -- never COUNT/GROUP BY", () => {
    const q = lib.siblingRungTwinQuery({ sport: "baseball", year: 1990, cardNumber: "232" });
    expect(q.query).toMatch(/SELECT c\.id, c\.setKey, c\.parallel, c\.isAuto, c\.printRun, c\.source, c\.playerName/);
    expect(q.query).not.toMatch(/COUNT|GROUP BY/i);
    expect(q.query).toMatch(/c\.sport = @sport/);
    expect(q.query).toMatch(/c\.year = @year OR c\.cardYear = @year/);
    expect(q.query).toMatch(/c\.cardNumber = @cardNumber/);
    expect(q.parameters).toEqual([
      { name: "@sport", value: "baseball" },
      { name: "@cardNumber", value: "232" },
      { name: "@year", value: 1990 },
    ]);
  });

  it("uppercases the card number the same way the write path stores it", () => {
    const q = lib.siblingRungTwinQuery({ sport: "baseball", year: 1990, cardNumber: "cpa-br" });
    expect(q.parameters.find((p: { name: string }) => p.name === "@cardNumber").value).toBe("CPA-BR");
  });
});

describe("isSiblingRungTwin", () => {
  const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "" };

  it("is a twin: same rung, checklist authority, different setKey", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  it("is NOT a twin at the SAME setKey -- that is the exact-id case, handled separately", () => {
    const row = { setKey: "bowman", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when the sibling row is DERIVED, not checklist -- a self-confirming row is not evidence", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "ingest-auto-seed" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when the parallel differs, even under the same spelling rules", () => {
    const row = { setKey: "bowman-chrome", parallel: "Gold Prizm", isAuto: false, printRun: null, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("folds parallel through the SAME slug function on both sides -- case and spacing never matter", () => {
    const row = { setKey: "bowman-chrome", parallel: "silver   prizm", isAuto: false, printRun: null, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  it("is NOT a twin when isAuto disagrees", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: true, printRun: null, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when printRun disagrees", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: 99, source: "sportscardchecklist" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("blank parallel on both sides (Base vs Base) still matches", () => {
    const baseStaged = { cardNumber: "1", parallel: "", isAuto: "false", printRun: "" };
    const row = { setKey: "topps-series-1", parallel: null, isAuto: false, printRun: null, source: "beckett" };
    expect(lib.isSiblingRungTwin(row, baseStaged, { setKey: "topps", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });
});

describe("findSiblingRungTwins", () => {
  function fakeContainer(rows: unknown[]) {
    return {
      items: {
        query() {
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => { done = true; return { resources: rows }; },
          };
        },
      },
    };
  }

  it("returns every match across a single page", async () => {
    const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "" };
    const container = fakeContainer([
      { id: "a", setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
      { id: "b", setKey: "bowman", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
      { id: "c", setKey: "bowman-paper", parallel: "Gold Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
    ]);
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins.map((t: { id: string }) => t.id)).toEqual(["a"]);
  });

  it("pages a multi-page result to completion -- never breaks on an empty page", async () => {
    const staged = { cardNumber: "1", parallel: "", isAuto: "false", printRun: "" };
    let call = 0;
    const container = {
      items: {
        query() {
          return {
            hasMoreResults: () => call < 3,
            fetchNext: async () => {
              call++;
              if (call === 1) return { resources: [] }; // empty page, NOT done
              if (call === 2) return { resources: [{ setKey: "bowman-chrome", parallel: null, isAuto: false, printRun: null, source: "sportscardchecklist" }] };
              return { resources: [] };
            },
          };
        },
      },
    };
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins).toHaveLength(1);
    expect(call).toBe(3);
  });

  it("returns empty when nothing matches", async () => {
    const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "" };
    const container = fakeContainer([]);
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins).toEqual([]);
  });
});
