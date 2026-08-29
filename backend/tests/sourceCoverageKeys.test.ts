/**
 * CF-COVERAGE-IS-MEASURED-ON-KEYS (2026-08-29, D3b). The key the audit and the
 * retire share. Pinned here because a coverage number is only as honest as
 * its key: strip too little and a glued subset prefix hides real coverage,
 * strip too much and "Gold Refractor" collapses onto "Refractor" and a retire
 * deletes a rung the replacement never had.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cov = require("../scripts/lib/sourceCoverage.cjs");

describe("normalised parallel", () => {
  const subsets = cov.subsetWordsOf([{ subsetName: "Chrome Prospects" }, { subsetName: "Gold Rush" }, { subsetName: "Set - Concourse" }]);

  it("strips the old ingesters' glued prefixes", () => {
    expect(cov.normalizeParallel("prizms blue", subsets)).toBe("blue");
    expect(cov.normalizeParallel("Blue Prizms", subsets)).toBe("blue");
    expect(cov.normalizeParallel("set concourse gold prizms", subsets)).toBe("gold");
    expect(cov.normalizeParallel("auto crystal", subsets)).toBe("crystal");
    expect(cov.normalizeParallel("paper gold", subsets)).toBe("gold");
    expect(cov.normalizeParallel("Chrome Prospects Gold Refractor", subsets)).toBe("gold refractor");
    expect(cov.normalizeParallel("Silver (RC)", subsets)).toBe("silver");
  });

  it("never strips a colour or finish word, whatever the product's subsets are called", () => {
    expect(cov.normalizeParallel("Gold Refractor", subsets)).toBe("gold refractor");
    expect(cov.normalizeParallel("Gold Rush Refractor", subsets)).toBe("gold rush refractor");
    expect(cov.normalizeParallel("Refractor", subsets)).toBe("refractor");
  });

  it("subset words exclude colour and finish words", () => {
    expect(subsets.has("chrome")).toBe(false);
    expect(subsets.has("prospects")).toBe(true);
    expect(subsets.has("gold")).toBe(false);
    expect(subsets.has("concourse")).toBe(true);
  });
});

describe("keys", () => {
  it("exact and normalised keys agree on the plain shape and differ on the glued one", () => {
    const row = { cardNumber: "CPA-MWI", parallel: "Gold Refractor", printRun: 50 };
    expect(cov.exactKey(row)).toBe("cpa-mwi|gold refractor|50");
    expect(cov.normalizedKey(row, new Set())).toBe("cpa-mwi|gold refractor|50");
    const glued = { cardNumber: "1", parallel: "Prizms Blue", printRun: 199 };
    expect(cov.exactKey(glued)).toBe("1|prizms blue|199");
    expect(cov.normalizedKey(glued, new Set())).toBe("1|blue|199");
  });

  it("resolves the replacement source the way the retire does", () => {
    expect(cov.resolveNewSource({})).toBe("checklistcenter-2026-08-29");
    expect(cov.resolveNewSource({ SCOPE: "refractor" })).toBe("checklistcenter-2026-08-29");
    expect(cov.resolveNewSource({ SCOPE: "checklistcenter-2026-09-01" })).toBe("checklistcenter-2026-09-01");
    expect(cov.resolveNewSource({ NEW_SOURCE: "x", REPLACED_BY: "y" })).toBe("x");
  });
});
