/**
 * A winner that contradicts data/holding-identity-rulings.json is reported as
 * ambiguous and NEVER silently applied.
 *
 * The rulings file is Drew's own hand. Nine rulings live there, several of them
 * CPA bowman-chrome -> bowman decisions (cpa-ba 2026 -> bowman /499, cpa-fa
 * 2025 -> bowman /250) -- exactly the population MODE=cpa touches. The fleet
 * asserts this PER GROUP rather than trusting a sample that found no conflict.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contradictsRulings, decideDuplicateGroup, type DupRow, type IdentityRuling } from "../src/services/catalog/duplicateWinnerRule.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulingsFile = JSON.parse(fs.readFileSync(path.join(backend, "data", "holding-identity-rulings.json"), "utf8")) as {
  rulings: IdentityRuling[];
};
const RULINGS = rulingsFile.rulings;

describe("the rulings file itself", () => {
  it("is present and carries the rulings the guard is built for", () => {
    expect(RULINGS.length).toBeGreaterThanOrEqual(9);
    const targets = RULINGS.map((r) => String(r.to));
    expect(targets).toContain("hiq:baseball:2026:bowman:cpa-ba:refractor:auto:num-499");
    expect(targets).toContain("hiq:baseball:2025:bowman:cpa-fa:purple-refractor:auto:num-250");
  });
});

describe("contradictsRulings", () => {
  it("fires when a RULED id would be retired as a loser", () => {
    const ruled = "hiq:baseball:2026:bowman:cpa-ba:refractor:auto:num-499";
    expect(contradictsRulings("hiq:baseball:2026:bowman-chrome:cpa-ba:refractor:auto", [ruled], RULINGS)).not.toBeNull();
  });

  it("does NOT fire when the ruled id is the WINNER", () => {
    const ruled = "hiq:baseball:2026:bowman:cpa-ba:refractor:auto:num-499";
    expect(contradictsRulings(ruled, ["hiq:baseball:2026:bowman-chrome:cpa-ba:refractor:auto"], RULINGS)).toBeNull();
  });

  it("does not fire on an unrelated group", () => {
    expect(contradictsRulings("hiq:baseball:2024:topps:1:base:no-auto", ["hiq:baseball:2024:topps:1:gold:no-auto"], RULINGS)).toBeNull();
  });
});

describe("the group decision honours the rulings", () => {
  const ruledTo = "hiq:baseball:2025:bowman:cpa-fa:purple-refractor:auto:num-250";

  it("reports AMBIGUOUS rather than folding away a ruled identity", () => {
    // A derived row with more sales would otherwise out-rank nothing here, but
    // the ruled row is deliberately made the LOSER by giving the rival row
    // checklist authority and a print run -- the guard must still refuse.
    const rows: DupRow[] = [
      { id: "hiq:baseball:2025:bowman:cpa-fa:purple-refractor:auto:num-250:rival", source: "checklistcenter", printRun: 250, playerName: "F Arias", parallelSlug: "purple-refractor", setKey: "bowman", cardNumber: "cpa-fa", year: 2025, sport: "baseball", isAuto: true },
      { id: ruledTo, source: "beckett", printRun: 250, playerName: "F Arias", parallelSlug: "purple-refractor", setKey: "bowman", cardNumber: "cpa-fa", year: 2025, sport: "baseball", isAuto: true },
    ];
    const d = decideDuplicateGroup({ rows, rulings: RULINGS });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.why).toBe("contradicts-holding-ruling");
      expect(d.detail).toContain(ruledTo);
    }
  });

  it("folds normally when no ruling is involved", () => {
    const rows: DupRow[] = [
      { id: "hiq:baseball:2024:topps:1:gold:no-auto:num-50", source: "checklistcenter", printRun: 50, playerName: "A Player", parallelSlug: "gold", setKey: "topps", cardNumber: "1", year: 2024, sport: "baseball", isAuto: false },
      { id: "hiq:baseball:2024:topps:1:gold:no-auto", source: "ingest-auto-seed", playerName: "A Player", parallelSlug: "gold", setKey: "topps", cardNumber: "1", year: 2024, sport: "baseball", isAuto: false },
    ];
    const d = decideDuplicateGroup({ rows, rulings: RULINGS });
    expect(d.kind).toBe("consolidate");
  });

  it("with NO rulings passed, the same ruled group would have folded -- the guard is what stops it", () => {
    // Mutation check: remove the rulings and the decision flips. If this passes
    // with an empty list AND with the real list, the guard is not load-bearing.
    const rows: DupRow[] = [
      { id: "hiq:baseball:2025:bowman:cpa-fa:purple-refractor:auto:num-250:rival", source: "checklistcenter", printRun: 250, playerName: "F Arias", parallelSlug: "purple-refractor", setKey: "bowman", cardNumber: "cpa-fa", year: 2025, sport: "baseball", isAuto: true },
      { id: ruledTo, source: "beckett", printRun: 250, playerName: "F Arias", parallelSlug: "purple-refractor", setKey: "bowman", cardNumber: "cpa-fa", year: 2025, sport: "baseball", isAuto: true },
    ];
    expect(decideDuplicateGroup({ rows, rulings: [] }).kind).toBe("consolidate");
    expect(decideDuplicateGroup({ rows, rulings: RULINGS }).kind).toBe("ambiguous");
  });
});
