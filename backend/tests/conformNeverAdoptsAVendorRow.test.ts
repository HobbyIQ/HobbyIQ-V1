/**
 * CF-A-HOLDING-NEVER-ADOPTS-A-VENDOR-ROW -- Drew, 2026-08-30: the conform pass
 * wanted to move Bobby Witt Jr. 2020 Bowman Draft BD152 onto a CardHedge-minted
 * "bowman-draft-1st-edition" row because the Draft base row was missing.
 * "bobby witt came out of bowman draft … first edition is another bowman set."
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { identityTargets, productChanged, setKeyOf } = require("../scripts/conform-holdings-to-catalog.cjs") as {
  identityTargets: (rows: Array<{ source?: string }>) => Array<{ source?: string }>;
  productChanged: (existing: string, resolved: string) => boolean;
  setKeyOf: (hiq: string) => string;
};

describe("conform-holdings-to-catalog -- a holding never adopts a vendor-minted row", () => {
  it("only checklist-authority rows are identity targets; the CardHedge 1st Edition twin is not one", () => {
    const rows = [
      { id: "hiq:baseball:2020:bowman-draft-1st-edition:bd152:base:no-auto", source: "cardhedge" },
      { id: "hiq:baseball:2020:bowman-draft:bd152:gold:no-auto:num-50", source: "bccp" },
      { id: "hiq:baseball:2020:bowman:bd152:base:no-auto", source: "user-verified" },
      { id: "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto:num-499", source: "checklistcenter-2026-08-29" },
    ];
    expect(identityTargets(rows).map((r) => r.source)).toEqual(["bccp", "checklistcenter-2026-08-29"]);
    expect(identityTargets([{ source: "cardsight" }, { source: "pool" }, { source: "sold-comps-stub-2026-08-12" }])).toEqual([]);
  });
  it("a correction never changes the product of an existing identity", () => {
    expect(productChanged("hiq:baseball:2020:bowman-draft:bd152:base:no-auto", "hiq:baseball:2020:bowman-draft-1st-edition:bd152:base:no-auto")).toBe(true);
    expect(productChanged("hiq:baseball:2020:bowman-draft:bd152:base:no-auto", "hiq:baseball:2020:bowman-draft:bd152:base:no-auto:num-499")).toBe(false);
    expect(productChanged("", "hiq:baseball:2020:bowman-draft:bd152:base:no-auto")).toBe(false); // no identity yet: nothing to keep
    expect(setKeyOf("hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto:num-499")).toBe("bowman-draft");
    expect(setKeyOf("1778814561816x835862652021336800")).toBe("");
  });
});
