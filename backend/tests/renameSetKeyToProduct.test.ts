/**
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23): the rename fleet's decisions, made
 * with the slug generator's own functions (the TS sources, not dist) so the
 * fleet cannot drift from the generator it exists to catch the catalog up to.
 *
 * Each ruled family round-trips: a row minted under the collapsed id, with
 * the product in its field or its name, is moved to the id the generator
 * produces today; a row whose id is right but whose field is wrong is healed
 * in place; a row that agrees with itself is left alone; anything that is
 * not an identity row, or names no ruled product, is refused and counted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { resolveSetKeyForSlug, slugify } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import * as table from "../src/services/catalog/productSetKeys.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require("../scripts/rename-setkey-to-product.cjs");

const ruled = script.ruledProducts(table) as Array<{ setKey: string; spellings: string[]; era: boolean }>;
const ruledKeys = new Set(ruled.flatMap((p) => (p.era ? ["donruss", "panini-donruss"] : [p.setKey])));
const deps = {
  resolveSetKeyForSlug,
  slugify,
  isRuled: (k: string) => ruledKeys.has(k),
  productSetKeyForName: table.productSetKeyForName,
  spellForEra: table.spellForEra,
};
type Row = { id: string; cardId?: string; sport?: string; year?: number; setKey?: string; setName?: string; cardNumber?: string; source?: string };
const row = (id: string, o: Partial<Row> = {}): Row => ({ id, cardId: id, sport: id.split(":")[1], year: Number(id.split(":")[2]), ...o });
const decide = (r: Row) => script.decideProductRow(r, deps);

describe("the ruled products", () => {
  it("are every spelled entry of the table plus the Donruss pair", () => {
    const keys = ruled.map((p) => p.setKey);
    for (const k of ["topps-series-1", "topps-series-2", "topps-update-series", "topps-updates-and-highlights", "topps-chrome-update-series",
      "bowman-draft-1st-edition", "upper-deck-series-1", "upper-deck-series-2", "topps-heritage-high-number", "leaf-vivid", "leaf-metal", "donruss"]) {
      expect(keys, k).toContain(k);
    }
    expect(ruled.find((p) => p.setKey === "topps-update-series")!.spellings).toContain("topps-update");
    expect(ruled.find((p) => p.era)!.spellings.sort()).toEqual(["donruss", "panini-donruss"]);
    // Family-only entries are not renamed by this fleet.
    expect(keys).not.toContain("bowman-chrome");
    expect(keys).not.toContain("topps");
    expect(keys).not.toContain("bowman-chrome-prospects");
  });
});

describe("MODE=product: each family round-trips through decideProductRow", () => {
  it.each([
    // [id as minted (collapsed), field, setName, expected new id]
    ["hiq:baseball:2024:topps:100:base:no-auto", "topps-series-1", "2024 Topps Series 1 Baseball", "hiq:baseball:2024:topps-series-1:100:base:no-auto"],
    ["hiq:baseball:2024:topps:400:base:no-auto", "topps-series-2", "2024 Topps Series 2", "hiq:baseball:2024:topps-series-2:400:base:no-auto"],
    ["hiq:baseball:2025:topps-update:us135:base:no-auto", "topps-update-series", "2025 Topps Update Series", "hiq:baseball:2025:topps-update-series:us135:base:no-auto"],
    ["hiq:baseball:2025:topps-update:us135:base:no-auto", "topps-update", "Topps Update", "hiq:baseball:2025:topps-update-series:us135:base:no-auto"],
    ["hiq:baseball:2024:topps-chrome:usc88:base:no-auto", "topps-chrome-update-series", "Topps Chrome Update Series", "hiq:baseball:2024:topps-chrome-update-series:usc88:base:no-auto"],
    ["hiq:baseball:2024:topps-chrome:usc88:base:no-auto", "topps-chrome", "Topps Chrome Update", "hiq:baseball:2024:topps-chrome-update-series:usc88:base:no-auto"],
    ["hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", "bowman-draft-1st-edition", "Bowman Draft 1st Edition", "hiq:baseball:2020:bowman-draft-1st-edition:bd-152:base:no-auto"],
    ["hiq:hockey:1999:upper-deck:1:base:no-auto", "upper-deck-series-1", "Upper Deck Series 1", "hiq:hockey:1999:upper-deck-series-1:1:base:no-auto"],
    ["hiq:baseball:2024:topps-heritage:501:base:no-auto", "topps-heritage-high-number", "Topps Heritage High Number", "hiq:baseball:2024:topps-heritage-high-number:501:base:no-auto"],
    ["hiq:baseball:2025:leaf:1:base:no-auto", "leaf-vivid", "Leaf Vivid", "hiq:baseball:2025:leaf-vivid:1:base:no-auto"],
    ["hiq:baseball:2026:leaf:1:base:no-auto", "leaf-metal-baseball", "2026 Leaf Metal Baseball", "hiq:baseball:2026:leaf-metal:1:base:no-auto"],
    ["hiq:baseball:2022:leaf:1:base:no-auto", "leaf-metal-draft", "Leaf Metal Draft", "hiq:baseball:2022:leaf-metal-draft:1:base:no-auto"],
  ])("%s -> the product (%s / %s)", (id, setKey, setName, want) => {
    const d = decide(row(id, { setKey, setName, cardNumber: id.split(":")[4].toUpperCase() }));
    expect(d.action).toBe("move");
    expect(d.newId).toBe(want);
    expect(d.setKey).toBe(want.split(":")[3]);
  });

  it("the checklist's name wins over the field, and says so", () => {
    const d = decide(row("hiq:baseball:2008:topps-update:uh1:base:no-auto", { setKey: "topps-update", setName: "2008 Topps Updates & Highlights", cardNumber: "UH1" }));
    expect(d).toMatchObject({ action: "move", newId: "hiq:baseball:2008:topps-updates-and-highlights:uh1:base:no-auto", nameOverField: true });
  });

  it("Donruss: the era decides; a right id with a wrong field is healed, never moved", () => {
    expect(decide(row("hiq:baseball:2025:panini-donruss:1:base:no-auto", { setKey: "donruss", setName: "2025 Donruss Baseball", cardNumber: "1" })))
      .toMatchObject({ action: "heal", setKey: "panini-donruss" });
    expect(decide(row("hiq:baseball:1990:donruss:33:base:no-auto", { setKey: "panini-donruss", setName: "1990 Donruss", cardNumber: "33" })))
      .toMatchObject({ action: "heal", setKey: "donruss" });
    expect(decide(row("hiq:baseball:1990:panini-donruss:33:base:no-auto", { setKey: "panini-donruss", setName: "1990 Donruss", cardNumber: "33" })))
      .toMatchObject({ action: "move", newId: "hiq:baseball:1990:donruss:33:base:no-auto", setKey: "donruss" });
    expect(decide(row("hiq:football:2023:panini-donruss:1:base:no-auto", { setKey: "panini-donruss", setName: "2023 Panini Donruss Football", cardNumber: "1" })).action).toBe("canonical");
  });

  it("the card-number segment follows the field's spelling, hyphen kept", () => {
    const d = decide(row("hiq:baseball:2020:bowman-draft-1st-edition:bd152:base:no-auto", { setKey: "bowman-draft-1st-edition", setName: "Bowman Draft 1st Edition", cardNumber: "BD-152" }));
    expect(d).toMatchObject({ action: "move", newId: "hiq:baseball:2020:bowman-draft-1st-edition:bd-152:base:no-auto", cardNumber: "BD-152" });
    const same = decide(row("hiq:baseball:2025:topps-update-series:us135:base:no-auto", { setKey: "topps-update-series", setName: "Topps Update Series", cardNumber: "US135" }));
    expect(same.action).toBe("canonical");
  });

  it("a row that agrees with itself is left alone; the print-run segment travels", () => {
    expect(decide(row("hiq:baseball:2024:topps-series-1:100:gold:no-auto:num-2024", { setKey: "topps-series-1", setName: "2024 Topps Series 1", cardNumber: "100" })).action).toBe("canonical");
    const d = decide(row("hiq:baseball:2024:topps:100:gold:no-auto:num-2024", { setKey: "topps-series-1", setName: "2024 Topps Series 1", cardNumber: "100" }));
    expect(d.newId).toBe("hiq:baseball:2024:topps-series-1:100:gold:no-auto:num-2024");
  });

  it("refuses what it cannot decide, and names why", () => {
    expect(decide(row("hiq:baseball:2024:topps:100:base:no-auto:psa-10", { setKey: "topps-series-1" }))).toMatchObject({ action: "refuse", why: "not-an-identity-row" });
    expect(decide(row("hiq:baseball:2024:topps-chrome:1:base:no-auto", { setKey: "topps-chrome", setName: "Topps Chrome", cardNumber: "1" }))).toMatchObject({ action: "refuse", why: "no-ruled-product" });
    expect(decide({ id: "ch-12345", setKey: "topps-series-1" })).toMatchObject({ action: "refuse", why: "not-an-identity-row" });
    expect(decide({ id: "hiq:baseball:0:topps:1:base:no-auto", setKey: "topps-series-1", year: 0 })).toMatchObject({ action: "refuse", why: "no-year" });
  });
});

describe("MODE=hyphen: the checklist's spelling is probed, never invented", () => {
  it("bd152 asks for bd-152; a hyphenated number is canonical; a plain number is refused", () => {
    expect(script.decideHyphenRow(row("hiq:baseball:2020:bowman-draft:bd152:base:no-auto", { cardNumber: "BD152" }), deps))
      .toMatchObject({ action: "probe", twinId: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", cardNumber: "BD-152" });
    expect(script.decideHyphenRow(row("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", { cardNumber: "BD-152" }), deps)).toMatchObject({ action: "refuse" });
    expect(script.decideHyphenRow(row("hiq:baseball:2024:topps:100:base:no-auto", { cardNumber: "100" }), deps)).toMatchObject({ action: "refuse", why: "not-letters-then-digits" });
    expect(script.hyphenatedTwin("bd152")).toBe("BD-152");
    expect(script.hyphenatedTwin("us135")).toBe("US-135");
    // Letters on both sides (CPA-TG as "cpatg") has no derivable split -- refused, never guessed.
    expect(script.hyphenatedTwin("cpatg")).toBeNull();
    expect(script.hyphenatedTwin("CPA-TG")).toBeNull();
  });
});

describe("MODE=holdings: the target is derived the way the rows were, then confirmed", () => {
  it("a holding's setName, the id's spelling and the hyphenated twin are the candidates, in that order", () => {
    const h = { hobbyiqCardId: "hiq:baseball:2011:topps-update:us175:base:no-auto", setName: "2011 Topps Update", cardNumber: "US175", sport: "baseball", year: 2011 };
    const { candidates, tier } = script.holdingTargetCandidates(h, deps);
    expect(tier).toBeNull();
    expect(candidates[0]).toBe("hiq:baseball:2011:topps-update-series:us175:base:no-auto");
    expect(candidates).toContain("hiq:baseball:2011:topps-update-series:us-175:base:no-auto");
  });

  it("a collapsed flagship id resolves through the holding's own name", () => {
    const h = { hobbyiqCardId: "hiq:baseball:2024:topps:100:base:no-auto", setName: "2024 Topps Series 1 Baseball", cardNumber: "100" };
    expect(script.holdingTargetCandidates(h, deps).candidates[0]).toBe("hiq:baseball:2024:topps-series-1:100:base:no-auto");
  });

  it("a graded id yields its parent's candidates and the tier to re-append", () => {
    const h = { cardId: "hiq:baseball:2020:bowman-draft:bd152:base:no-auto:psa-9", setName: "2020 Bowman Draft", cardNumber: "BD152" };
    const { candidates, tier } = script.holdingTargetCandidates(h, deps);
    expect(tier).toBe("psa-9");
    expect(candidates).toContain("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto");
    expect(candidates.every((c: string) => !c.endsWith(":psa-9"))).toBe(true);
  });

  it("a vendor id yields nothing", () => {
    expect(script.holdingTargetCandidates({ cardId: "ch-12345" }, deps)).toEqual({ candidates: [], tier: null });
  });
});

describe("the population is per product and self-shrinking", () => {
  it("names the aliases and the canonical key, and the era clauses for Donruss", () => {
    const upd = script.productPopulation(ruled.find((p) => p.setKey === "topps-update-series"), table);
    expect(upd.sql).toContain("c.setKey IN (@al0");
    // The id's own text decides, never CONCAT over the row's sport / year
    // fields: a row missing either would silently drop out of the population
    // (8 leaf-limited rows did, measured 2026-08-30).
    expect(upd.sql).toContain("NOT CONTAINS(c.id, CONCAT(\":\", @canon, \":\"))");
    expect(upd.sql).not.toContain("ToString(c.year)");
    expect(upd.params.find((p: { name: string }) => p.name === "@canon")?.value).toBe("topps-update-series");
    expect(upd.params.some((p: { value: string }) => p.value === "topps-update")).toBe(true);
    const chrome = script.productPopulation(ruled.find((p) => p.setKey === "topps-chrome-update-series"), table);
    expect(chrome.sql).toContain(`c.setKey = "topps-chrome" AND (CONTAINS(c.setName, "Update")`);
    const era = script.productPopulation(ruled.find((p) => p.era), table);
    expect(era.sql).toContain(`c.setKey = "donruss" AND (c.year >= 2009`);
    expect(era.sql).toContain(`c.setKey = "panini-donruss" AND (c.year < 2009`);
  });
});

describe("the fleet's contract with the runner", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "rename-setkey-to-product.cjs"), "utf8");
  it("reads the runner's switch, moves through catalogRowOps, reconciles, and prints the budget marker", () => {
    expect(src).toMatch(/BACKFILL_APPLY/);
    expect(src).toMatch(/moveCatalogRow\(/);
    expect(src).toMatch(/reportWrites\(/);
    expect(src).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
    expect(src).toMatch(/MODE=hyphen needs SOURCES/);
  });
  it("is whitelisted with a marker-keyed relaunch that forwards every input", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/^\s+- rename-setkey-to-product\s*$/m);
    const step = yml.split(/\n(?=      - name:)/).find((s) => /inputs\.script == 'rename-setkey-to-product'/.test(s)) ?? "";
    expect(step).toMatch(/stopped at the \.\*budget/);
    for (const input of ["slot", "slots", "mode", "sports", "years", "scope", "sources"]) expect(step, input).toContain(`-f ${input}="\${{ inputs.${input} }}"`);
  });
});
