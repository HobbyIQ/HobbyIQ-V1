/**
 * LANE 4 (a) -- the decision surface of repair-select-subbrand-misslug.
 *
 * 1,525 card_catalog rows sit under setKey `panini-select` (basketball, 2025)
 * while their own setName says they are Select WNBA (1,347) or Select
 * EuroLeague (160). normalizeSetKey collapses both sub-brands into the
 * flagship; both destinations already exist and are populated.
 *
 * These tests pin the two things that make the pass safe: it moves ONLY on
 * evidence the row already carries, and it refuses everything else rather than
 * guessing. The 18 rows whose setName names no sub-brand must stay put.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require("../scripts/repair-select-subbrand-misslug.cjs");

describe("destinationFor reads the row's own setName", () => {
  it("routes the two real sub-brands", () => {
    expect(R.destinationFor("2025 Panini Select WNBA Basketball").setKey).toBe("panini-select-wnba");
    expect(R.destinationFor("2025 Panini Select EuroLeague Basketball").setKey).toBe("panini-select-euroleague");
    // Spelled as two words, as some rows do.
    expect(R.destinationFor("2025 Panini Select Euro League Basketball").setKey).toBe("panini-select-euroleague");
  });

  it("leaves the flagship alone -- it may well BE the flagship", () => {
    // These are the 8 + 10 rows the measurement found. Nothing on them says
    // sub-brand, so nothing moves them.
    expect(R.destinationFor("2025 Panini Select Basketball")).toBeNull();
    expect(R.destinationFor("2025 panini-select Basketball")).toBeNull();
  });

  it("blank means unknown, never the flagship and never a guess", () => {
    expect(R.destinationFor("")).toBeNull();
    expect(R.destinationFor(null)).toBeNull();
    expect(R.destinationFor(undefined)).toBeNull();
  });

  it("refuses a setName naming BOTH sub-brands rather than picking one", () => {
    expect(R.destinationFor("2025 Panini Select WNBA EuroLeague Basketball")).toBeNull();
  });

  it("does not fire on an unrelated product that merely contains the word", () => {
    expect(R.destinationFor("2025 Panini Prizm Basketball")).toBeNull();
    expect(R.destinationFor("2025 Topps Chrome Baseball")).toBeNull();
  });
});

describe("the whitelist is closed", () => {
  it("every destination the router can return is whitelisted", () => {
    for (const d of R.DESTINATIONS) expect(R.WHITELIST.has(d.setKey)).toBe(true);
  });

  it("is exactly the two verified-populated products, and nothing else", () => {
    expect([...R.WHITELIST].sort()).toEqual(["panini-select-euroleague", "panini-select-wnba"]);
  });
});

describe("rekeyId swaps the setKey segment and nothing else", () => {
  it("preserves every other segment, print run included", () => {
    expect(R.rekeyId("hiq:basketball:2025:panini-select:88:neon-green:no-auto:num-75", "panini-select", "panini-select-wnba"))
      .toBe("hiq:basketball:2025:panini-select-wnba:88:neon-green:no-auto:num-75");
    expect(R.rekeyId("hiq:basketball:2025:panini-select:56:pink-ice:no-auto", "panini-select", "panini-select-wnba"))
      .toBe("hiq:basketball:2025:panini-select-wnba:56:pink-ice:no-auto");
  });

  it("returns null when the id does not carry the scoped setKey -- refuse, do not rebuild", () => {
    expect(R.rekeyId("hiq:basketball:2025:panini-prizm:88:base:no-auto", "panini-select", "panini-select-wnba")).toBeNull();
  });

  it("does not corrupt an id whose OTHER segments contain the key as a substring", () => {
    // The delimiter-anchored search is what keeps this honest.
    const out = R.rekeyId("hiq:basketball:2025:panini-select:panini-select:base:no-auto", "panini-select", "panini-select-wnba");
    expect(out).toBe("hiq:basketball:2025:panini-select-wnba:panini-select:base:no-auto");
  });
});

describe("a graded child is carried by its parent, never moved directly", () => {
  // The first bounded dry run (2026-08-31, LIMIT=200) failed 4 rows with
  // "moveCatalogRow: newSlug is not a hiq slug: ...:psa-6". Graded ids are
  // `${parentSlug}:${tier}` and moveCatalogRow RETIRES them when the parent
  // moves, so addressing one directly is both a double-move and a hard error.
  it("recognises a graded child by its tier suffix", () => {
    expect(R.isGradedChildId({ id: "hiq:basketball:2025:panini-select:6:base:no-auto:psa-6" })).toBe(true);
    expect(R.isGradedChildId({ id: "hiq:basketball:2025:panini-select:6:base:no-auto:bgs-9-5" })).toBe(true);
  });

  it("recognises one by its gradeTier field even when the id is unusual", () => {
    expect(R.isGradedChildId({ id: "hiq:basketball:2025:panini-select:6:base:no-auto", gradeTier: "psa-10" })).toBe(true);
  });

  it("does NOT mistake a numbered sibling for a graded child -- that is a real card", () => {
    // :num-75 is the numbered parallel itself and MUST still move.
    expect(R.isGradedChildId({ id: "hiq:basketball:2025:panini-select:88:neon-green:no-auto:num-75" })).toBe(false);
    expect(R.isGradedChildId({ id: "hiq:basketball:2025:panini-select:56:pink-ice:no-auto" })).toBe(false);
  });
});

describe("the scoped query never selects the whole container", () => {
  it("binds sport, year and setKey as parameters", () => {
    const spec = R.querySpec();
    const names = spec.parameters.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["@sk", "@sp", "@y"]);
    expect(spec.query).toContain("c.setKey = @sk");
    expect(spec.query).toContain("c.sport = @sp");
    expect(spec.query).toContain("c.cardYear = @y");
  });
});

describe("reconcile partitions every row examined", () => {
  it("balances when the paths sum to the candidates", () => {
    const r = R.reconcile("j", { candidates: 1525, written: 1507, skipped: 18, failed: 0, notReached: 0 });
    expect(r.balances).toBe(true);
    expect(r.accountsForAll).toBe(true);
    expect(r.intended).toBe(1525);
  });

  it("does NOT balance when a row went down no path -- the check has teeth", () => {
    expect(R.reconcile("j", { candidates: 1525, written: 1500, skipped: 18, failed: 0 }).balances).toBe(false);
  });
});
