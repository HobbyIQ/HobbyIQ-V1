/**
 * CF-A-HOLDING-NEVER-ADOPTS-A-VENDOR-ROW -- Drew, 2026-08-30: the conform pass
 * wanted to move Bobby Witt Jr. 2020 Bowman Draft BD152 onto a CardHedge-minted
 * "bowman-draft-1st-edition" row because the Draft base row was missing.
 * "bobby witt came out of bowman draft … first edition is another bowman set."
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { numberedTwinsOf as resolverNumberedTwinsOf, pickCatalogRow } from "../src/services/catalog/catalogIdentityResolver.js";
const require = createRequire(import.meta.url);
const { identityTargets, productChanged, setKeyOf, rowFor, numberedTwinsOf } = require("../scripts/conform-holdings-to-catalog.cjs") as {
  numberedTwinsOf: (resolved: string, ids: string[]) => string[];
  rowFor: (resolved: string, ids: string[]) => string | null;
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
  it("the identity is a ROW: the composed slug resolves to itself, else to its one numbered twin, else nothing", () => {
    const base = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
    expect(rowFor(base, [base, base + ":num-499"])).toBe(base);
    expect(rowFor(base, [base + ":num-499", "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"])).toBe(base + ":num-499");
    expect(rowFor(base, [base + ":num-499", base + ":num-250"])).toBeNull();
    expect(rowFor(base, ["hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"])).toBeNull();
  });
  it("a graded child is not a numbered twin (Gillen: two children made the card 'ambiguous')", () => {
    const base = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto";
    const ids = [base + ":num-150", base + ":num-150:psa-9", base + ":num-150:psa-10", "hiq:baseball:2024:bowman-draft:cpa-tg:blue-wave-refractor:auto:num-150"];
    expect(numberedTwinsOf(base, ids)).toEqual([base + ":num-150"]);
    expect(rowFor(base, ids)).toBe(base + ":num-150");
  });
});

// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30). The rule's home is the TS
// resolver (catalogIdentityResolver.pickCatalogRow); the .cjs keeps a copy it
// cannot import. ONE fixture table, asserted against BOTH, so they cannot drift.
// The script only ever asks about the un-numbered slug it composed, so the table
// is un-numbered inputs; the numbered direction (#1509) is the resolver's alone.
describe("conform's rowFor and the resolver's pickCatalogRow are the same rule", () => {
  const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
  const TG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto";
  const WJ = "hiq:baseball:2024:bowman-chrome:cpa-wj:refractor:auto";
  // [slug, ids the card holds, expected row]
  const TABLE: Array<[string, string[], string | null]> = [
    [MWI, [MWI, `${MWI}:num-499`], MWI],                                                       // own row wins
    [MWI, [`${MWI}:num-499`, "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"], `${MWI}:num-499`], // the one twin (prod, 2026-08-30)
    [MWI, [`${MWI}:num-499`, `${MWI}:num-250`], null],                                       // two twins: a ruling
    [MWI, ["hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"], null],        // another parallel is not a twin
    [MWI, [], null],
    [TG, [`${TG}:num-150`, `${TG}:num-150:psa-9`, `${TG}:num-150:psa-10`], `${TG}:num-150`],   // graded children are not twins
    [TG, [`${TG}:num-150:psa-9`], null],
    // the prod cpa-wj shape (read-only, 2026-08-30): two twins under graded children -> nothing
    [WJ, [`${WJ}:num-499`, `${WJ}:num-150:psa-10`, `${WJ}:num-10:sgc-10`, `${WJ}:num-499:psa-9`, `${WJ}:num-10:bgs-9-5`, `${WJ}:num-10`], null],
  ];
  it("agree on every row of the table", () => {
    for (const [slug, ids, expected] of TABLE) {
      expect(rowFor(slug, ids), `cjs rowFor ${slug} over ${ids.length} ids`).toBe(expected);
      expect(pickCatalogRow(slug, ids).id, `resolver pickCatalogRow ${slug} over ${ids.length} ids`).toBe(expected);
      expect(numberedTwinsOf(slug, ids), `numberedTwinsOf ${slug}`).toEqual(resolverNumberedTwinsOf(slug, ids));
    }
  });
  it("names the kinds the script reports as prose", () => {
    expect(pickCatalogRow(MWI, [`${MWI}:num-499`]).kind).toBe("numbered-twin");
    expect(pickCatalogRow(MWI, [`${MWI}:num-499`, `${MWI}:num-250`]).kind).toBe("ambiguous");
    expect(pickCatalogRow(MWI, []).kind).toBe("none");
  });
});
