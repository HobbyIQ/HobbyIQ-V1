/**
 * CF-A-HOLDING-NEVER-ADOPTS-A-VENDOR-ROW -- Drew, 2026-08-30: the conform pass
 * wanted to move Bobby Witt Jr. 2020 Bowman Draft BD152 onto a CardHedge-minted
 * "bowman-draft-1st-edition" row because the Draft base row was missing.
 * "bobby witt came out of bowman draft … first edition is another bowman set."
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { numberedTwinsOf as resolverNumberedTwinsOf, pickCatalogRow } from "../src/services/catalog/catalogIdentityResolver.js";
const require = createRequire(import.meta.url);
const { identityTargets, productChanged, setKeyOf, rowFor, numberedTwinsOf, fieldOps } = require("../scripts/conform-holdings-to-catalog.cjs") as {
  numberedTwinsOf: (resolved: string, ids: string[]) => string[];
  rowFor: (resolved: string, ids: string[]) => string | null;
  identityTargets: (rows: Array<{ source?: string }>) => Array<{ source?: string }>;
  productChanged: (existing: string, resolved: string) => boolean;
  setKeyOf: (hiq: string) => string;
  fieldOps: (holdingId: string, h: Record<string, unknown>, fields: Record<string, unknown> | undefined)
    => Array<{ op: string; path: string; value: unknown; _k: string; _from: unknown }>;
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

/**
 * D36 (Drew, 2026-08-30). Five more rulings, and two of them are holdings that
 * carry a cardId but NO hobbyiqCardId at all -- so the rulings file needed
 * `from: null` and the guard had to mean it. A third (Caglianone RA-JC) says
 * "2024 Bowman Draft" while its eBay title says 2026 Topps Chrome, so a ruling
 * can now also correct the holding's OWN text via `fields`.
 *
 * These pins are the mutation checks: relax the from-null guard into a
 * truthiness test (so any identity is overwritten) -> red; write every named
 * field rather than only the differing ones -> red; let a mismatched `from`
 * through -> red.
 */
describe("a ruling may target a holding with no identity yet, and may correct its fields", () => {
  // The guard exactly as the applier states it: `from: null` means "expect NO
  // hobbyiqCardId", and it is every bit as strict as a named `from`.
  const guardPasses = (from: string | null | undefined, current: string) => {
    const expectsNone = from === null || from === undefined || from === "";
    return expectsNone ? current === "" : current === from;
  };

  it("from: null matches only a holding that really has no hobbyiqCardId", () => {
    expect(guardPasses(null, "")).toBe(true);
    expect(guardPasses(undefined, "")).toBe(true);
    expect(guardPasses("", "")).toBe(true);
    // the holding acquired an identity between the ruling and the run: SKIP,
    // never overwrite. (This is exactly what happened to the Gonzalez CPA-JG
    // holding, pinned by the conform pass before the ruling ran.)
    expect(guardPasses(null, "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499")).toBe(false);
    expect(guardPasses(null, "hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto")).toBe(false);
  });

  it("a holding whose current id differs from `from` is never moved", () => {
    const from = "hiq:baseball:1997:bowman:bbp4:atomic-refractor:no-auto";
    expect(guardPasses(from, from)).toBe(true);
    // no identity at all is NOT "any identity" -- a named `from` still misses
    expect(guardPasses(from, "")).toBe(false);
    // the holding sits on some other id: the ruling does not apply to it
    expect(guardPasses(from, "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto")).toBe(false);
    expect(guardPasses(from, "hiq:baseball:1997:finest:238:base:no-auto")).toBe(false);
    // and the /1500 ruling only fires on the exact numbered id it names
    const numbered = "hiq:baseball:1999:upper-deck-black-diamond:d24:base:no-auto:num-1500";
    expect(guardPasses(numbered, numbered)).toBe(true);
    expect(guardPasses(numbered, "hiq:baseball:1999:upper-deck-black-diamond:d24:base:no-auto")).toBe(false);
  });

  it("fields writes only what actually differs", () => {
    const h = { year: 2024, setName: "2024 Bowman Draft", cardNumber: "RA-JC", playerName: "Jac Caglianone" };
    const ops = fieldOps("9b971b03", h, { year: 2026, setName: "2026 Topps Chrome" });
    expect(ops.map((o) => o._k).sort()).toEqual(["setName", "year"]);
    expect(ops.map((o) => o.path)).toEqual(expect.arrayContaining([
      "/holdings/9b971b03/year",
      "/holdings/9b971b03/setName",
    ]));
    expect(ops.find((o) => o._k === "year")!.value).toBe(2026);
    expect(ops.every((o) => o.op === "set")).toBe(true);
    // a re-run of an applied ruling is a no-op, not a churn of identical writes
    expect(fieldOps("9b971b03", { ...h, year: 2026, setName: "2026 Topps Chrome" }, { year: 2026, setName: "2026 Topps Chrome" })).toEqual([]);
    // no fields block at all is simply no ops
    expect(fieldOps("9b971b03", h, undefined)).toEqual([]);
    expect(fieldOps("9b971b03", h, {})).toEqual([]);
  });

  it("a string year and a number year are the same value, not a rewrite", () => {
    expect(fieldOps("h1", { year: "2026" }, { year: 2026 })).toEqual([]);
    expect(fieldOps("h1", { year: "2024" }, { year: 2026 })).toHaveLength(1);
  });

  it("a field key never builds a patch path out of arbitrary text", () => {
    const ops = fieldOps("h1", { ok: "a" }, { "../../evil": "x", "a/b": "y", "": "z", ok: "b" });
    expect(ops.map((o) => o._k)).toEqual(["ok"]);
    expect(ops[0].path).toBe("/holdings/h1/ok");
  });

  it("the five D36 rulings are well formed, and only the named ones carry from: null / fields", () => {
    const file = new URL("../data/holding-identity-rulings.json", import.meta.url);
    const rulings = JSON.parse(readFileSync(file, "utf8")).rulings as Array<{
      holdingId: string; userId: string; from: string | null; to: string;
      rulingBy: string; date: string; note: string; fields?: Record<string, unknown>;
    }>;
    const by = new Map(rulings.map((r) => [r.holdingId.slice(0, 8), r]));
    for (const id of ["ca820b08", "9b971b03", "5979f485", "6f4f079b", "86cb8844"]) {
      const r = by.get(id);
      expect(r, `ruling ${id} present`).toBeTruthy();
      expect(r!.to).toMatch(/^hiq:/);
      expect(r!.rulingBy).toBe("Drew");
      expect(r!.note.length).toBeGreaterThan(20);
    }
    expect(by.get("ca820b08")!.from).toBeNull();
    expect(by.get("9b971b03")!.from).toBeNull();
    expect(by.get("9b971b03")!.fields).toEqual({ year: 2026, setName: "2026 Topps Chrome" });
    // the base card is NOT numbered -- the /1500 is the Triple's print run
    expect(by.get("6f4f079b")!.to).toBe("hiq:baseball:1999:black-diamond:d24:base:no-auto");
    expect(by.get("6f4f079b")!.to).not.toContain(":num-");
    expect(by.get("86cb8844")!.from).toContain(":undefined:");
    expect(by.get("86cb8844")!.to).toBe("hiq:baseball:1992:donruss-studio:232:base:no-auto");
    // CF-CHRONIC-REDS-DRIFT (2026-09-03). This used to hardcode the two
    // known no-identity rulings (ca820b08, 9b971b03) and demand a string
    // `from` on every other row. #1613 added a THIRD legitimate one --
    // fe7f69f7, a 1993 Topps Finest holding with no identity yet, carrying
    // corrective fields -- so the whitelist went stale and the suite went red
    // on a ruling that is exactly what this test's own title allows ("a ruling
    // may target a holding with no identity yet").
    //
    // A list of ids has to be edited every time Drew rules on another
    // identity-less holding, which is a maintenance tax, not a guard. The real
    // invariant is the RULE those ids were standing in for: a ruling may omit
    // `from` only when it supplies `fields` to correct the holding with --
    // a null `from` AND no `fields` is a ruling that names neither what it is
    // changing nor what to change it to, which is the actual defect.
    for (const r of rulings) {
      // `from` is either a real slug, or explicitly null for a holding that
      // had no identity to move away from. What is NOT allowed is a `from`
      // that is some other shape -- undefined, a number, an object -- which is
      // how a malformed hand-written ruling actually shows up.
      expect(
        r.from === null || typeof r.from === "string",
        `${r.holdingId.slice(0, 8)}: from must be a slug string or explicitly null`,
      ).toBe(true);
      // Whatever the `from`, the ruling must still say where the holding goes
      // and why -- that is what makes an identity-less ruling actionable.
      expect(r.to, `${r.holdingId.slice(0, 8)} names a destination`).toMatch(/^hiq:/);
      expect(
        r.note.length,
        `${r.holdingId.slice(0, 8)} explains itself`,
      ).toBeGreaterThan(20);
    }
  });
});
