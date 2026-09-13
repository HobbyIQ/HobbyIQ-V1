/**
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET + CF-COMPUTE-EVERY-ID-BEFORE-
 * WRITING-ANY (R30, Drew 2026-09-13).
 *
 * THE DEFECT, measured on the staged 2014 Panini Prizm FIFA World Cup file:
 * 5,462 upserts landed on 2,949 documents, because the ingest never read the
 * CSV's `category` column and base #1 plus nine inserts' #1 all computed
 *
 *     hiq:soccer:2014:panini-prizm-fifa-world-cup:1:base:no-auto
 *
 * -- Rais M'Bolhi, Cristiano Ronaldo, Lionel Messi, a mascot and a stadium
 * poster, each overwriting the last inside ONE run, under a "5,462 rows
 * written" counter that counts upsert CALLS and so could not see it.
 *
 * WHAT THIS FILE PINS, in the order the run applies it:
 *
 *   1. the key derivation -- base and its rungs keep the product key; a
 *      SAME-NUMBERED insert set takes its own, and a parallel rung of that
 *      insert stays on the insert's key with the parallel field set;
 *   2. the SCOPE -- a file whose inserts number in their own ranges is left
 *      exactly as it was, because separating it would split nothing and refuse
 *      a file that is already correct (feedback: right guard, wrong scope);
 *   3. the refusal contract -- a derived key that is not a normalizeSetKey
 *      FIXED POINT refuses the file and names the keys to register, and a
 *      collision the key cannot fix refuses with the colliding groups;
 *   4. the counter -- distinct ids, reconciled against rows written.
 *
 * THE MUTATION CHECKS are the point of items 2 and 3: the Gold Label class
 * rows and the Sonic tier fixtures must come through unchanged, and a key must
 * never be minted just because the code could spell it.
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("../scripts/lib/insert-set-key.cjs");

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto?: string; printRun?: string; player: string; setKey?: string;
};

/** The staged CSV format, as a fixture: the ingest reads exactly these six
 *  columns in exactly this order. */
function fixture(csv: string): Row[] {
  return csv.trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, player] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player };
  });
}

/** The ingest's own id derivation, so a test can never agree with a slug the
 *  run would not actually write. */
const idFor = (sport: string, year: number) => (r: Row) => computeHobbyIqCardId({
  sport, year, setKey: r.setKey,
  cardNumber: String(r.cardNumber), parallel: r.parallel || "Base",
  isAuto: r.isAuto === "true", printRun: r.printRun ? Number(r.printRun) : null,
  authoritativeSetKey: true,
});

describe("a named insert set is its own card set — the key derivation", () => {
  it("leaves base and every parallel RUNG of base on the product key", () => {
    for (const [category, parallel] of [
      ["base", ""], ["base", "Gold Prizm"], ["base", "Black Prizm"],
      ["", ""], ["checklist", ""], ["inserts", ""],
    ]) {
      expect(lib.setKeyForRow({
        productSetKey: "panini-prizm-fifa-world-cup", category, parallel,
        separate: new Set(["guardians"]),
      })).toEqual({ setKey: "panini-prizm-fifa-world-cup", subsetSlug: "", isInsertSet: false });
    }
  });

  it("puts a SEPARATED insert set on its own key, rung and all", () => {
    const separate = new Set(["guardians"]);
    // The plain rung of the insert.
    expect(lib.setKeyForRow({
      productSetKey: "panini-prizm-fifa-world-cup", category: "insert-guardians",
      parallel: "", separate,
    }).setKey).toBe("panini-prizm-fifa-world-cup-guardians");
    // A PARALLEL RUNG of the insert stays on the INSERT'S key. The rung is the
    // parallel field's job; moving it into the key would mint a product per
    // colour, which is the cartesian smear the retracted ruling forbids.
    expect(lib.setKeyForRow({
      productSetKey: "panini-prizm-fifa-world-cup", category: "insert-guardians",
      parallel: "Gold Prizm", separate,
    }).setKey).toBe("panini-prizm-fifa-world-cup-guardians");
  });

  it("reads a rung of BASE as base however the scraper spelled it", () => {
    // checklistinsider writes the base set's own parallels as `insert-base-*`.
    // Those are the BASE CARD's rungs; reading them as a `-base-gold` insert
    // set would split the base pool one way per colour.
    for (const [category, parallel] of [
      ["insert-base-gold", "Base Gold"],
      ["insert-base-preferred-black", "Base Preferred Black"],
      ["insert-base-true-blue", "Base True Blue"],
    ]) {
      expect(lib.categorySubsetSlug(category, parallel)).toBe("");
    }
  });

  it("never strips a category down to nothing", () => {
    // insider repeats the family in the parallel: `insert-airborne-gold` +
    // "Airborne Gold". A strip that allowed an empty remainder would eat
    // "airborne" too and read a real insert as the base print.
    expect(lib.categorySubsetSlug("insert-airborne-gold", "Airborne Gold")).toBe("airborne-gold");
    expect(lib.categorySubsetSlug("insert-guardians", "Guardians")).toBe("guardians");
  });
});

describe("base + two inserts restarting at 1 + a rung of an insert", () => {
  // The World Cup shape in miniature: three subsets that all number from 1,
  // and one of them with a colour rung.
  const rows = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,Rais M'Bolhi
base,2,,false,,Madjid Bougherra
base,1,Gold Prizm,false,10,Rais M'Bolhi
insert-guardians,1,,false,,Thibaut Courtois
insert-guardians,2,,false,,Manuel Neuer
insert-guardians,1,Gold Prizm,false,10,Thibaut Courtois
insert-world-cup-stars,1,,false,,Lionel Messi
insert-world-cup-stars,2,,false,,Sergio Aguero
`);
  const productSetKey = "panini-prizm-fifa-world-cup";
  const computeId = idFor("soccer", 2014);

  it("measures the clash BEFORE any key is derived", () => {
    const separate = lib.subsetsToSeparate(rows, productSetKey, computeId);
    // base, guardians and world-cup-stars all claim #1 and #2 on the product
    // key. The two NAMED ones are separated; base is the product.
    expect([...separate].sort()).toEqual(["guardians", "world-cup-stars"]);
  });

  it("derives one key per same-numbered insert set, with its rung on it", () => {
    const separate = lib.subsetsToSeparate(rows, productSetKey, computeId);
    const keys = lib.insertSetKeysOf(rows, productSetKey, separate);
    expect(keys.map((k: any) => k.setKey).sort()).toEqual([
      "panini-prizm-fifa-world-cup-guardians",
      "panini-prizm-fifa-world-cup-world-cup-stars",
    ]);
    // The Gold Prizm rung of Guardians rides on the Guardians key -- 3 rows,
    // not 2 plus a key of its own.
    expect(keys.find((k: any) => k.setKey.endsWith("-guardians")).rows).toBe(3);
  });

  it("REFUSES, because those keys are not normalizeSetKey fixed points yet", () => {
    // This is the real, measured state of the product on main: the derived
    // keys fold PAST the product onto the bare `panini-prizm` flagship, so
    // writing them would be strictly worse than the collision.
    expect(normalizeSetKey("panini-prizm-fifa-world-cup-guardians")).toBe("panini-prizm");
    const plan = lib.planFile({ rows, productSetKey, computeId, normalize: normalizeSetKey });
    expect(plan.verdict).toBe("refuse");
    expect(plan.reason).toBe("unregistered-set-keys");
    expect(plan.unregistered.map((u: any) => u.setKey).sort()).toEqual([
      "panini-prizm-fifa-world-cup-guardians",
      "panini-prizm-fifa-world-cup-world-cup-stars",
    ]);
    // The refusal must NAME what it folds to, or nobody can act on it.
    expect(plan.unregistered[0].resolvesTo).toBe("panini-prizm");
  });

  it("mints DISTINCT ids for all eight rows once the keys are registered", () => {
    // Registration is a src change (productSetKeys.ts + an anchored
    // normalizeSetKey rule) and is deliberately NOT in this PR. Simulate it:
    // the keys become fixed points, and the separation must then leave zero
    // collisions and eight documents for eight rows.
    const registered = new Set([
      "panini-prizm-fifa-world-cup-guardians",
      "panini-prizm-fifa-world-cup-world-cup-stars",
    ]);
    const asIf = (k: string) => (registered.has(k) ? k : normalizeSetKey(k));
    // The id must also carry the registered key rather than folding, which is
    // what the src half buys; stand in for it here.
    const idWithKey = (r: Row) => (registered.has(String(r.setKey))
      ? `hiq:soccer:2014:${r.setKey}:${String(r.cardNumber).toLowerCase()}:${(r.parallel || "base").toLowerCase().replace(/ /g, "-")}:no-auto${r.printRun ? ":num-" + r.printRun : ""}`
      : computeId(r));
    const plan = lib.planFile({ rows, productSetKey, computeId: idWithKey, normalize: asIf });
    expect(plan.verdict).toBe("pass");
    expect(plan.ids).toBe(rows.length);
    expect(plan.collisions).toHaveLength(0);
  });
});

describe("the collision fixture — a clash the set key cannot fix", () => {
  // 1989 Pro Set #47 really is two cards in the SAME base section: the
  // checklist prints one number twice. No subset separates them, so the honest
  // answer is a refusal that names the group rather than an invented axis.
  const rows = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,46,,false,,Neal Anderson
base,47,,false,,William Perry
base,47,,false,,Ron Morris
base,48,,false,,Brad Muster
`);
  const computeId = idFor("football", 1989);

  it("refuses and reports the colliding group with its rows and players", () => {
    const plan = lib.planFile({ rows, productSetKey: "pro-set", computeId, normalize: normalizeSetKey });
    expect(plan.verdict).toBe("refuse");
    expect(plan.reason).toBe("id-collisions");
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0].rows.map((r: Row) => r.player).sort()).toEqual(["Ron Morris", "William Perry"]);
    // It derives NO key for this: one subset colliding with itself is not the
    // insert-set defect, and minting `pro-set-base` would be inventing one.
    expect(plan.keys).toHaveLength(0);
    expect([...plan.separate]).toHaveLength(0);
  });

  it("prints the categories and players, which are what decide the diagnosis", () => {
    const plan = lib.planFile({ rows, productSetKey: "pro-set", computeId, normalize: normalizeSetKey });
    const report = lib.formatCollision(plan.collisions[0]);
    expect(report).toContain("hiq:football:1989:pro-set:47:base:no-auto");
    expect(report).toContain("[base] #47");
    expect(report).toContain("William Perry");
    expect(report).toContain("Ron Morris");
  });
});

describe("MUTATION CHECK — a file that does not clash is untouched", () => {
  /**
   * checklistinsider's 2025 Panini Rookies & Stars file carries 157 insert
   * categories across 6,360 rows and already mints 6,360 distinct ids: its
   * inserts number in their own ranges. Separating them would split nothing,
   * refuse a correct file and demand 157 registry entries no card needs.
   */
  const rows = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,Patrick Mahomes II
base,2,,false,,Shedeur Sanders
insert-airborne-gold,201,Airborne Gold,false,10,Patrick Mahomes II
insert-airborne-gold,202,Airborne Gold,false,10,Jalen Hurts
insert-rookies,301,,false,,Shedeur Sanders
insert-base-gold,1,Base Gold,false,10,Patrick Mahomes II
`);
  const computeId = idFor("football", 2025);

  it("passes, derives no key and separates nothing", () => {
    const plan = lib.planFile({ rows, productSetKey: "panini-rookies-and-stars", computeId, normalize: normalizeSetKey });
    expect(plan.verdict).toBe("pass");
    expect(plan.keys).toHaveLength(0);
    expect([...plan.separate]).toHaveLength(0);
    expect(plan.ids).toBe(rows.length);
  });

  it("leaves every row on the product key — byte for byte the old behaviour", () => {
    const plan = lib.planFile({ rows, productSetKey: "panini-rookies-and-stars", computeId, normalize: normalizeSetKey });
    for (const r of rows) {
      expect(lib.setKeyForRow({
        productSetKey: "panini-rookies-and-stars", category: r.category,
        parallel: r.parallel, separate: plan.separate,
      }).setKey).toBe("panini-rookies-and-stars");
    }
  });
});

describe("MUTATION CHECK — the Gold Label class rows and the Sonic tier", () => {
  /**
   * CF-A-DECLARED-PARALLEL-IS-NOT-A-CARD-LINE: 2017 Topps Gold Label numbers
   * ONE card set across three Classes, which are RUNGS on the product and
   * live in the parallel column. This rule must not read "Class 1" as an
   * insert set -- that would mint three products where the checklist prints
   * one, and split the pool three ways.
   */
  const goldLabel = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,Class 1,false,,Mike Trout
base,1,Class 2,false,,Mike Trout
base,1,Class 3,false,,Mike Trout
base,2,Class 1,false,,Aaron Judge
`);

  it("leaves every Class row on the product key and derives nothing", () => {
    const computeId = idFor("baseball", 2017);
    const plan = lib.planFile({ rows: goldLabel, productSetKey: "topps-gold-label", computeId, normalize: normalizeSetKey });
    expect(plan.verdict).toBe("pass");
    expect(plan.keys).toHaveLength(0);
    // The Classes separate the cards on the PARALLEL axis, which is where the
    // checklist puts them: four rows, four ids.
    expect(plan.ids).toBe(4);
  });

  /**
   * R23 / the Sonic tier: an Image Variation is a NAMED CARD LINE and the tier
   * is part of the card, not a section of the page. Its rows carry the tier in
   * the parallel column on the product key, and must keep doing so.
   */
  const sonic = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,Sonic
base,1,Image Variation SP,false,,Sonic
base,1,Image Variation SSP,false,,Sonic
`);

  it("leaves the Sonic tier rows on the product key and derives nothing", () => {
    const computeId = idFor("pokemon", 2024);
    const plan = lib.planFile({ rows: sonic, productSetKey: "topps-chrome", computeId, normalize: normalizeSetKey });
    expect(plan.verdict).toBe("pass");
    expect(plan.keys).toHaveLength(0);
    expect(plan.ids).toBe(3);
  });
});

describe("the distinct-ids counter reconciles against rows written", () => {
  const rows = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,A Player
base,2,,false,,B Player
base,3,,false,,C Player
`);
  const computeId = idFor("baseball", 2020);

  it("counts DOCUMENTS, not upsert calls", () => {
    const plan = lib.planFile({ rows, productSetKey: "topps", computeId, normalize: normalizeSetKey });
    expect(plan.ids).toBe(3);
    expect(plan.rows).toBe(3);
  });

  it("a run that would write more rows than there are ids is the defect itself", () => {
    // The World Cup shape: ten rows, one id. The counter the run reconciles on
    // must be able to SEE that, which `written` alone never could.
    const clobber = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,Rais M'Bolhi
insert-guardians,1,,false,,Thibaut Courtois
insert-world-cup-stars,1,,false,,Lionel Messi
`);
    const before = lib.idCollisions(clobber, (r: Row) =>
      computeId({ ...r, setKey: "panini-prizm-fifa-world-cup" }));
    expect(before.ids).toBe(1);
    expect(clobber.length).toBe(3);
    expect(before.collisions[0].rows).toHaveLength(3);
  });

  it("a row the slug generator REFUSES is not counted as a collision", () => {
    // computeHobbyIqCardId throws on an identity it cannot derive (the three
    // NNO Checklist rows of 1999-00 Skybox Premium). The guard must reach the
    // same verdict as the ingest's own per-row catch rather than taking the
    // whole file down.
    const thrower = () => { throw new Error("UNDERIVABLE"); };
    const out = lib.idCollisions(rows, thrower);
    expect(out.ids).toBe(0);
    expect(out.collisions).toHaveLength(0);
    expect(out.unslugable).toBe(3);
  });
});

describe("the refusal contract cannot be bypassed", () => {
  const rows = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
base,1,,false,,Rais M'Bolhi
insert-guardians,1,,false,,Thibaut Courtois
`);
  const computeId = idFor("soccer", 2014);

  it("refuses when no normalizer is supplied — never 'assume fine'", () => {
    const plan = lib.planFile({ rows, productSetKey: "panini-prizm-fifa-world-cup", computeId, normalize: undefined });
    expect(plan.verdict).toBe("refuse");
    expect(plan.reason).toBe("unregistered-set-keys");
    expect(plan.unregistered[0].resolvesTo).toBeNull();
  });

  it("reports an unregistered key even when the separation would clear every collision", () => {
    // ORDER IS LOAD-BEARING: writing to a key that folds elsewhere is the
    // worse outcome of the two, so it is named first and it refuses.
    const plan = lib.planFile({ rows, productSetKey: "panini-prizm-fifa-world-cup", computeId, normalize: normalizeSetKey });
    expect(plan.reason).toBe("unregistered-set-keys");
    expect(plan.unregistered).toHaveLength(1);
  });
});

describe("one card, one address — whichever column said so (#2106 vs #2114)", () => {
  /**
   * Two acquisition lanes spell the same claim in two places:
   *
   *   per-ROW    the `category` column names the subset (tcdb, insider)
   *   per-FILE   the MANIFEST declares `subset` (cardboardconnection #2114:
   *              197 subset-declaring files across 6 products)
   *
   * They must derive the SAME key, or Great Significance #1 has two addresses
   * and two pools. R30's KEY form is canonical (Drew's ruling; #2106 already
   * ships `panini-rookies-and-stars-rookies-signatures`, which IS a
   * normalizeSetKey fixed point today).
   */
  it("a manifest-declared subset derives the same key a category would", () => {
    const fromCategory = lib.setKeyForRow({
      productSetKey: "nba-hoops", category: "auto-great-significance",
      parallel: "", separate: new Set(["great-significance"]),
    });
    const fromManifest = lib.setKeyForRow({
      productSetKey: "nba-hoops", category: "base", parallel: "",
      subsetName: "Great Significance", separate: new Set(["great-significance"]),
    });
    expect(fromManifest.setKey).toBe("nba-hoops-great-significance");
    expect(fromManifest.setKey).toBe(fromCategory.setKey);
  });

  it("folds a structural label in the MANIFEST exactly as it does in a category", () => {
    // A manifest saying `subset: "Base Set"` claims nothing, the same way a
    // category of "base" does (CF-BASE-SET-IS-NOT-A-SUBSET).
    for (const s of ["Base Set", "Inserts", "Checklist", ""]) {
      expect(lib.subsetSlugFor({ category: "base", parallel: "", subsetName: s })).toBe("");
    }
  });

  it("the ROW's own column wins when a file states both", () => {
    // A file-wide subset plus a per-row category means the row names a subset
    // WITHIN the file's subset; the row is the more specific statement.
    expect(lib.subsetSlugFor({
      category: "auto-hoops-ink", parallel: "", subsetName: "Great Significance",
    })).toBe("hoops-ink");
  });

  it("uses the source's own words for display and the key for identity", () => {
    expect(lib.subsetDisplayName({ subsetName: "The Legends Series Autographs" }))
      .toBe("The Legends Series Autographs");
    // Only a slug has to be reconstructed, and that is display only.
    expect(lib.subsetDisplayName({ category: "insert-world-cup-stars" })).toBe("World Cup Stars");
  });
});

describe("the clash is a fact about the PRODUCT, not the file", () => {
  /**
   * cardboardconnection ships ONE FILE PER SUBSET. Every file is internally
   * distinct, so a per-file measurement passes all 207 — while the product
   * cells underneath hold 1,803 contested addresses. The measurement must
   * therefore be taken over the whole (sport, year, setKey) cell.
   */
  const greatSignificance = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
auto-great-significance,1,,true,,Joe Ingles
auto-great-significance,2,,true,,Jordan Nwora
`).map((r) => ({ ...r, subsetName: "Great Significance" }));
  const hoopsInk = fixture(`
category,cardNumber,parallel,isAuto,printRun,player
auto-hoops-ink,1,,true,,Cade Cunningham
auto-hoops-ink,2,,true,,LaMelo Ball
`).map((r) => ({ ...r, subsetName: "Hoops Ink" }));
  const computeId = idFor("basketball", 2022);

  it("sees nothing when each file is measured alone — the gap this closes", () => {
    for (const rows of [greatSignificance, hoopsInk]) {
      const plan = lib.planFile({ rows, productSetKey: "nba-hoops", computeId, normalize: normalizeSetKey });
      expect(plan.verdict).toBe("pass");
      expect(plan.keys).toHaveLength(0);
    }
    // And yet the two files claim the same two addresses.
    const together = lib.idCollisions([...greatSignificance, ...hoopsInk],
      (r: Row) => computeId({ ...r, setKey: "nba-hoops" }));
    expect(together.ids).toBe(2);
    expect(together.collisions).toHaveLength(2);
  });

  it("separationByCell measures across every file of one product", () => {
    const byCell = new Map([["basketball/2022/nba-hoops", {
      productSetKey: "nba-hoops", rows: [...greatSignificance, ...hoopsInk],
    }]]);
    const sep = lib.separationByCell(byCell, (r: Row) => computeId({ ...r, setKey: r.setKey }));
    expect([...sep.get("basketball/2022/nba-hoops")].sort())
      .toEqual(["great-significance", "hoops-ink"]);
  });

  it("and each file then REFUSES, naming its own key to register", () => {
    const separate = new Set(["great-significance", "hoops-ink"]);
    const plan = lib.planFile({
      rows: greatSignificance, productSetKey: "nba-hoops", computeId,
      normalize: normalizeSetKey, separate,
    });
    expect(plan.verdict).toBe("refuse");
    expect(plan.reason).toBe("unregistered-set-keys");
    expect(plan.unregistered.map((u: any) => u.setKey)).toEqual(["nba-hoops-great-significance"]);
    expect(plan.unregistered[0].resolvesTo).toBe("nba-hoops");
  });

  it("#2106's key form IS already a fixed point — the canonical shape, proven", () => {
    // Registered in src by #2106. This is what the cbc keys must become, and
    // it is why the key form is canonical rather than the `:sub-` segment.
    expect(normalizeSetKey("panini-rookies-and-stars-rookies-signatures"))
      .toBe("panini-rookies-and-stars-rookies-signatures");
  });
});

describe("the ingest lane wires the rule in", () => {
  it("exposes the same module the library tests exercise", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lane = require("../scripts/ingest-checklist-csv-to-catalog.cjs");
    expect(lane.insertSetKey).toBe(lib);
    expect(typeof lane.insertSetKey.planFile).toBe("function");
  });
});
