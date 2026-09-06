/**
 * CF-A-ROW-FILTER-IS-NOT-A-SHARD-AXIS (2026-09-07).
 *
 * WHY THE FILTER EXISTS. The soccer family->product restem is ONE-TO-MANY: the
 * stem `hiq:soccer:2022:panini-prizm:` holds World Cup rows, Premier League
 * rows and a Copa America row in one pool, so `rekey-product-setkey` — whose
 * TO key is a single scalar — cannot express the move. `rematch-sold-comps`
 * can, because it re-derives every row from its own title, but it had no way to be
 * pointed at one sport and one product family: its only scope was YEARS plus
 * the 32-slot shard table, whose SPORT_CLASSES names baseball, football,
 * basketball and pokemon. Soccer lives in the "other" catch-all and, in the
 * years that are not sport-split at all, in an undifferentiated whole-year
 * unit. There was no dispatch that read soccer Prizm and nothing else.
 *
 * WHY IT IS A ROW FILTER AND NOT A NEW AXIS. The shard table is a MEASURED
 * packing (CF-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED); adding `sport` to
 * it means re-measuring 16.3M rows, and the packing would still not split the
 * sports that need it. So the filter narrows the rows a slot CLASSIFIES and
 * never the rows a slot OWNS. `rowInSlot` decides membership first and is
 * untouched, which is what keeps two slots disjoint under a filter exactly as
 * they are without one — the property this file's first test pins.
 *
 * THE FILTER READS THE STORED ROW, NEVER THE DERIVATION. Which rows are
 * examined must not move when the deriver changes its mind, or two runs of one
 * dispatch would disagree about their own population.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..");
const scriptPath = path.join(backend, "scripts", "rematch-sold-comps.cjs");

/** Load the SHIPPED script with a given filter environment. The selection rule
 *  is pinned on the committed function, never on a copy of it here. */
function loadWith(env: Record<string, string>): any {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["SPORTS", "SETKEY_LIKE"]) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require_.cache[require_.resolve(scriptPath)];
  try {
    return require_(scriptPath);
  } finally {
    for (const k of ["SPORTS", "SETKEY_LIKE"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require_.cache[require_.resolve(scriptPath)];
  }
}

const deps = {
  normalizeSetKey: require_(path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js")).normalizeSetKey,
};

const row = (sport: string, cardId: string, extra: Record<string, unknown> = {}) => ({ sport, cardId, ...extra });

describe("the filter narrows what a slot CLASSIFIES, never what it OWNS", () => {
  it("slot membership is decided by rowInSlot alone — the filter cannot change it", () => {
    // The disjointness property the 32 dispatches depend on. `rowInSlot` is
    // the shipped membership test; a filtered load must answer identically.
    const unfiltered = loadWith({});
    const filtered = loadWith({ SPORTS: "soccer", SETKEY_LIKE: "panini-prizm" });
    const units = unfiltered.unitsForSlot(19);
    expect(units.length).toBeGreaterThan(0);
    const sample = [
      { id: "a1", cardYear: 2022, sport: "soccer" },
      { id: "b2", cardYear: 2022, sport: "football" },
      { id: "c3", cardYear: 2022, sport: "baseball" },
      { id: "d4", cardYear: 1991, sport: "soccer" },
    ];
    for (const r of sample) {
      expect(filtered.rowInSlot(r, units), r.id).toBe(unfiltered.rowInSlot(r, units));
    }
  });

  it("no filter set means every row the slot owns is classified", () => {
    const M = loadWith({});
    expect(M.ROW_FILTER_ON).toBe(false);
    expect(M.rowPassesFilter(row("soccer", "hiq:soccer:2022:panini-prizm:23:base:no-auto"), deps)).toBe(true);
    expect(M.rowPassesFilter(row("baseball", "hiq:baseball:1987:topps:70t:base:no-auto"), deps)).toBe(true);
  });
});

describe("sports — matched against the row's own sport segment", () => {
  const M = () => loadWith({ SPORTS: "soccer" });

  it("selects the named sport and skips every other", () => {
    const m = M();
    expect(m.ROW_FILTER_ON).toBe(true);
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:panini-prizm:23:base:no-auto"), deps)).toBe(true);
    // THE MUTATION THE TASK NAMES: a wrong-sport row is skipped BY FILTER.
    expect(m.rowPassesFilter(row("football", "hiq:football:2022:panini-prizm:23:base:no-auto"), deps)).toBe(false);
    expect(m.rowPassesFilter(row("basketball", "hiq:basketball:2022:panini-prizm:23:base:no-auto"), deps)).toBe(false);
  });

  it("is a comma LIST, and is case- and space-insensitive", () => {
    const m = loadWith({ SPORTS: " Soccer , hockey " });
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:panini-prizm:1:base:no-auto"), deps)).toBe(true);
    expect(m.rowPassesFilter(row("HOCKEY", "hiq:hockey:2022:upper-deck:1:base:no-auto"), deps)).toBe(true);
    expect(m.rowPassesFilter(row("baseball", "hiq:baseball:2022:topps:1:base:no-auto"), deps)).toBe(false);
  });

  it("a row with no sport at all is not selected by a sports filter", () => {
    const m = M();
    expect(m.rowPassesFilter({ cardId: "hiq:soccer:2022:panini-prizm:1:base:no-auto" }, deps)).toBe(false);
  });
});

describe("setkey_like — a PREFIX on the row's STORED setKey segment", () => {
  const M = () => loadWith({ SETKEY_LIKE: "panini-prizm" });

  it("selects the family key itself AND its specializations", () => {
    // This is the shape a family->product restem is scoped by: the stem being
    // emptied and every destination it empties into, in ONE dispatch.
    const m = M();
    for (const key of [
      "panini-prizm",
      "panini-prizm-premier-league",
      "panini-prizm-fifa-world-cup-qatar",
      "panini-prizm-fifa",
    ]) {
      expect(m.rowPassesFilter(row("soccer", `hiq:soccer:2022:${key}:23:base:no-auto`), deps), key).toBe(true);
    }
  });

  it("the prefix is `-` BOUNDED — it never captures a longer name that merely starts with it", () => {
    // Guard in the direction #1863 cared about: an exact-token ruling must not
    // capture a different product whose name contains it.
    const m = M();
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:panini-prizmatic:1:base:no-auto"), deps)).toBe(false);
  });

  it("is anchored at the START — a key that merely contains it is not selected", () => {
    const m = M();
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:donruss-panini-prizm:1:base:no-auto"), deps)).toBe(false);
  });

  it("skips a row on another product entirely", () => {
    const m = M();
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:topps-chrome:23:base:no-auto"), deps)).toBe(false);
  });

  it("reads the SLUG's segment, and falls back to normalizing setName only when the slug cannot answer", () => {
    const m = M();
    // A slug that is not the canonical shape: the stored set name answers.
    expect(m.rowPassesFilter({ sport: "soccer", cardId: "legacy-id-42", setName: "Panini Prizm" }, deps)).toBe(true);
    expect(m.rowPassesFilter({ sport: "soccer", cardId: "legacy-id-42", setName: "Topps Chrome" }, deps)).toBe(false);
    // Neither answers -> not selected. Absent beats wrong: a row whose address
    // cannot be read is not one a scoped dispatch should silently write.
    expect(m.rowPassesFilter({ sport: "soccer", cardId: "legacy-id-42" }, deps)).toBe(false);
  });

  it("the SLUG outranks setName — the address is what a restem is scoped against", () => {
    const m = M();
    // Free text disagreeing with the address must not drag the row in or out:
    // two rows in one pool can spell `setName` differently.
    expect(m.rowPassesFilter(
      { sport: "soccer", cardId: "hiq:soccer:2022:panini-prizm:23:base:no-auto", setName: "Topps Chrome" }, deps,
    )).toBe(true);
    expect(m.rowPassesFilter(
      { sport: "soccer", cardId: "hiq:soccer:2022:topps-chrome:23:base:no-auto", setName: "Panini Prizm" }, deps,
    )).toBe(false);
  });
});

describe("the two axes are ANDed — both must hold", () => {
  const M = () => loadWith({ SPORTS: "soccer", SETKEY_LIKE: "panini-prizm" });

  it("the 2022 soccer Prizm cell passes; a football Prizm row in the same slot does not", () => {
    const m = M();
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:panini-prizm:23:base:no-auto"), deps)).toBe(true);
    // Same year, same product family, same slot — excluded by the sport axis.
    expect(m.rowPassesFilter(row("football", "hiq:football:2022:panini-prizm:23:base:no-auto"), deps)).toBe(false);
    // Same sport, same slot — excluded by the setKey axis.
    expect(m.rowPassesFilter(row("soccer", "hiq:soccer:2022:topps-chrome:9:base:no-auto"), deps)).toBe(false);
  });
});

describe("slugSetKeySegment reads the address, not the free text", () => {
  const M = () => loadWith({});

  it("reads segment 4 of a canonical hiq slug", () => {
    expect(M().slugSetKeySegment("hiq:soccer:2022:panini-prizm:23:base:no-auto")).toBe("panini-prizm");
    expect(M().slugSetKeySegment("hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto")).toBe("topps-traded-tiffany");
  });

  it("returns empty for anything that is not that shape, rather than guessing", () => {
    for (const bad of ["", "legacy-id-42", "hiq:soccer", "hiq:soccer:2022", "holding::abc"]) {
      expect(M().slugSetKeySegment(bad), JSON.stringify(bad)).toBe("");
    }
  });
});
