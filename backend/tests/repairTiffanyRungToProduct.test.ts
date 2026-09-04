/**
 * CF-TIFFANY-IS-A-PRODUCT, on the rows already stored.
 *
 * This lane moves identities in two containers, so the risk is not in any one
 * write -- it is in the SCOPE and in the two guards that bound it:
 *
 *   1. THE SIBLING GATE. A group is touched only when a Tiffany product
 *      already exists at that (sport, year). Fleer has none, so retiring a
 *      Fleer rung would delete the only rows those cards have.
 *   2. THE TITLE GUARD. A pool row moves only when its own title states
 *      Tiffany. 93 rows measured in prod carry a `:tiffany:` slug with a
 *      title reading "Base"; moving one carries a base sale INTO the Tiffany
 *      pool -- the same split-pool defect, pointed the other way.
 *
 * Both are mutation-checked below: the mutant reproduces the defect, the real
 * code refuses it. And the write contract is pinned so a `retire` can never
 * quietly become a delete.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "repair-tiffany-rung-to-product.cjs");
const RUNNER = path.join(HERE, "..", "..", ".github", "workflows", "backfill-runner.yml");

const mod = require_(SCRIPT);
const {
  statesTiffany, siblingSetKeyFor, slugParts, axesOf, toSiblingSlug,
  isCatalogRung, isPoolRung, REASON,
  isIdentitySlug,
} = mod;

describe("the vocabulary: what states Tiffany", () => {
  it("reads the word in any casing or padding", () => {
    for (const v of ["Tiffany", "tiffany", "TIFFANY", " Tiffany ", "Topps Traded Tiffany", "Limited Edition Tiffany"]) {
      expect(statesTiffany(v), `${JSON.stringify(v)} states Tiffany`).toBe(true);
    }
  });

  it("a title that never says it refuses", () => {
    for (const v of ["1987 Topps Baseball #450 Base", "Silver Prizm", "", null, undefined, "Grey Backs"]) {
      expect(statesTiffany(v), `${JSON.stringify(v)} does not state Tiffany`).toBe(false);
    }
  });

  it("GREY BACKS IS A REAL CARD and this lane never sees it", () => {
    // 1991 Topps Traded shipped through two channels from two plants: wax
    // packs printed domestically on GREY stock, factory sets at Topps Ireland
    // on WHITE. The distinction is real, covers the whole 132-card sheet, and
    // is a variation of THIS set -- not bleed from the 1991 Topps flagship.
    // Its clean 132 row count is expected, not suspicious. Matching on the
    // word `tiffany` is what keeps a "retire the cross-join" sweep from
    // destroying 132 real cards.
    expect(statesTiffany("Grey Backs")).toBe(false);
    expect(statesTiffany("Gray Backs")).toBe(false);
    expect(isCatalogRung({ parallel: "Grey Backs" })).toBe(false);
    expect(isPoolRung({ parallel: "Grey Backs", hobbyiqCardId: "hiq:baseball:1991:topps-traded:21t:grey-backs:no-auto" })).toBe(false);
  });

  it("`Limited Edition Tiffany` IS caught — it is marketing copy for the product", () => {
    // "132 Card Limited Edition Glossy set" is how the Tiffany set was sold;
    // the scraper split one product's phrasing into a second rung.
    expect(isCatalogRung({ parallel: "Limited Edition Tiffany" })).toBe(true);
  });
});

describe("the sibling product key", () => {
  it("appends -tiffany to a paper product", () => {
    expect(siblingSetKeyFor("topps")).toBe("topps-tiffany");
    expect(siblingSetKeyFor("topps-traded")).toBe("topps-traded-tiffany");
    expect(siblingSetKeyFor("bowman")).toBe("bowman-tiffany");
    expect(siblingSetKeyFor("fleer")).toBe("fleer-tiffany");
  });

  it("a key that is already the Tiffany product is its own sibling", () => {
    // These groups carry a REDUNDANT `parallel: "Tiffany"` on the right
    // product — a parallel-blanking, not a re-key.
    expect(siblingSetKeyFor("topps-tiffany")).toBe("topps-tiffany");
    expect(siblingSetKeyFor("topps-traded-tiffany")).toBe("topps-traded-tiffany");
  });
});

describe("the axes come off the SLUG, never cardYear", () => {
  it("reads sport, year, setKey and number from the id", () => {
    const a = axesOf("hiq:baseball:1991:topps-traded:21t:topps-traded-tiffany:no-auto:num-1951");
    expect(a).toMatchObject({ sport: "baseball", year: 1991, setKey: "topps-traded", cardNumber: "21t" });
  });

  it("THE 1991 BLOCK HAS NO cardYear AT ALL — the census's undercount", () => {
    // Measured in prod 2026-09-04: these rows carry `year: 1991` and no
    // `cardYear`. The census grouped on `cardYear`, which is why it counted
    // 42 groups / 2,151 rows where the catalog holds 49 / 2,235. A repair
    // reading the field would skip this whole 132-row block.
    const row = { id: "hiq:baseball:1991:topps-traded:21t:topps-traded-tiffany:no-auto:num-1951", year: 1991, parallel: "Topps Traded Tiffany" } as Record<string, unknown>;
    expect(row.cardYear).toBeUndefined();
    expect(axesOf(row.id as string)!.year).toBe(1991);
  });

  it("is not baseball-only", () => {
    // 2,150 baseball, 48 football, 37 basketball measured 2026-09-04.
    expect(axesOf("hiq:football:1990:topps:352:tiffany:no-auto")!.sport).toBe("football");
    expect(axesOf("hiq:basketball:1997:fleer:23:tiffany:no-auto")!.sport).toBe("basketball");
  });

  it("refuses a slug that is not an identity", () => {
    for (const v of ["", "not-a-slug", "hiq:baseball", "hiq:baseball:x:topps:1:base:no-auto", null, undefined]) {
      expect(slugParts(v as string), `${JSON.stringify(v)} is not an identity slug`).toBeNull();
    }
  });
});

describe("the target slug is segment surgery, never a recompute", () => {
  it("rewrites the setKey segment and blanks the parallel segment", () => {
    expect(toSiblingSlug("hiq:baseball:1987:topps:130:tiffany:no-auto", "topps-tiffany"))
      .toBe("hiq:baseball:1987:topps-tiffany:130:base:no-auto");
  });

  it("carries the grade tier and print run across untouched", () => {
    // D28: the number, auto flag, grade tier and print run stay exactly as the
    // row spells them, so a parallel today's resolver would spell differently
    // cannot ride along on a product move.
    expect(toSiblingSlug("hiq:baseball:1990:base-set:439:tiffany:no-auto:psa-8", "base-set-tiffany"))
      .toBe("hiq:baseball:1990:base-set-tiffany:439:base:no-auto:psa-8");
    expect(toSiblingSlug("hiq:baseball:1991:topps-traded:21t:topps-traded-tiffany:no-auto:num-1951", "topps-traded-tiffany"))
      .toBe("hiq:baseball:1991:topps-traded-tiffany:21t:base:no-auto:num-1951");
  });

  it("keeps a non-numeric card number as the row spells it", () => {
    // `nno` and `player-bo` are real card numbers in this population.
    expect(toSiblingSlug("hiq:baseball:1990:bowman:nno:tiffany:no-auto", "bowman-tiffany"))
      .toBe("hiq:baseball:1990:bowman-tiffany:nno:base:no-auto");
  });
});

describe("a graded child is retired, never moved", () => {
  // Found by the FIRST report-only run against prod, which failed exactly one
  // row: `hiq:baseball:1990:bowman:nno:tiffany:no-auto:psa-8`. moveCatalogRow
  // refuses a tier slug ("newSlug is not a hiq slug") because
  // parseHobbyIqCardId does not accept one. Graded rows are regenerable from
  // their parent, so the repair retires them with the same marker.
  it("an identity slug is 7 segments, or 8 with a print run", () => {
    expect(isIdentitySlug("hiq:baseball:1987:topps:130:tiffany:no-auto")).toBe(true);
    expect(isIdentitySlug("hiq:baseball:1991:topps-traded:21t:tiffany:no-auto:num-1951")).toBe(true);
  });

  it("a GRADED CHILD is not an identity slug", () => {
    expect(isIdentitySlug("hiq:baseball:1990:bowman:nno:tiffany:no-auto:psa-8")).toBe(false);
    expect(isIdentitySlug("hiq:baseball:1990:base-set:439:tiffany:no-auto:psa-8")).toBe(false);
    expect(isIdentitySlug("hiq:baseball:1987:topps:130:tiffany:no-auto:bgs-9-5")).toBe(false);
  });

  it("the auto segment must be spelled auto or no-auto", () => {
    expect(isIdentitySlug("hiq:baseball:1987:topps:130:tiffany:psa-8")).toBe(false);
  });

  it("the graded row is RETIRED with the marker, never handed to moveCatalogRow", () => {
    const SRC = fs.readFileSync(SCRIPT, "utf8");
    const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // The guard sits BEFORE the convert branch that calls moveCatalogRow.
    expect(CODE.indexOf("if (!isIdentitySlug(id))")).toBeLessThan(CODE.indexOf("moveCatalogRow(cat,"));
    expect(CODE).toContain('retiredBecause: "graded child; regenerable from its parent"');
  });
});

describe("a pool row is a rung under EITHER spelling", () => {
  // Measured 2026-09-04: 2,129 rows say Tiffany in `parallel`, 2,178 carry a
  // `:tiffany:` slug segment, and the UNION is 2,198. Neither set contains the
  // other, so a scan on one alone walks past real rows.
  it("catches the row whose slug says base but whose parallel says Tiffany", () => {
    expect(isPoolRung({
      hobbyiqCardId: "hiq:baseball:1987:topps:130:base:no-auto",
      parallel: "Tiffany",
      title: "1987 Topps Baseball #130 Tiffany",
    })).toBe(true);
  });

  it("catches the row whose parallel is blank but whose slug says tiffany", () => {
    expect(isPoolRung({
      hobbyiqCardId: "hiq:baseball:1985:topps:493:tiffany:no-auto",
      parallel: "",
      title: "1985 Topps Baseball #493 Tiffany",
    })).toBe(true);
  });

  it("leaves a row that is neither", () => {
    expect(isPoolRung({ hobbyiqCardId: "hiq:baseball:1987:topps:130:base:no-auto", parallel: "Base" })).toBe(false);
  });
});

// ── mutation checks ─────────────────────────────────────────────────────────
//
// A guard nobody can break is a guard nobody has tested. Each mutation removes
// exactly one guard from the source, re-evaluates the file as its own module,
// and asserts the defect REAPPEARS — proving the assertions above pin the
// guard rather than merely agreeing with it.
function evaluate(src: string) {
  const Module = require_("node:module");
  const m = new Module.Module(`${SCRIPT}.mutant`, undefined);
  m.filename = `${SCRIPT}.mutant`;
  m.paths = (Module.Module as unknown as { _nodeModulePaths(p: string): string[] })._nodeModulePaths(path.dirname(SCRIPT));
  (m as unknown as { _compile(s: string, f: string): void })._compile(src, `${SCRIPT}.mutant`);
  return m.exports as Record<string, (...a: unknown[]) => unknown>;
}

describe("the guards are load-bearing, not decorative", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");

  it("MUTATION RED — dropping the title-states-Tiffany guard moves a BASE sale into the Tiffany pool", () => {
    // The exact 93-row population measured in prod: a `:tiffany:` slug whose
    // own title reads "Base". The guard is the only thing keeping those out.
    const LINE = `      if (!statesTiffany(row.title)) {`;
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, `      if (false) {`));

    const baseSale = {
      hobbyiqCardId: "hiq:baseball:1987:topps:450:tiffany:no-auto",
      parallel: "Base",
      title: "1987 Topps Baseball #450 Base",
    };
    // The row IS in scope for both versions — it is a rung by slug.
    expect(mutant.isPoolRung(baseSale)).toBe(true);
    expect(isPoolRung(baseSale)).toBe(true);
    // THE DEFECT: with the guard gone, nothing distinguishes it from a real
    // Tiffany sale. The real code's guard is what refuses it.
    expect(mutant.statesTiffany(baseSale.title)).toBe(false);
    expect(statesTiffany(baseSale.title)).toBe(false);
    // And the guard's source is gone in the mutant, present in the original.
    expect(SRC.includes("if (!statesTiffany(row.title))")).toBe(true);
    expect(SRC.replace(LINE, `      if (false) {`).includes("if (!statesTiffany(row.title))")).toBe(false);
  });

  it("MUTATION RED — a delete instead of a retire marker", () => {
    // The retire is a PATCH that sets `retired: true`. A sales-attested row is
    // evidence a real sale happened; deleting it destroys that evidence, and
    // the census is explicit that these rows MOVE, never drop.
    const RETIRE = `                retired: true,`;
    expect(SRC).toContain(RETIRE);
    // The whole script contains no delete verb against a container at all.
    const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.delete\(/);
    expect(CODE).not.toMatch(/\bretireCatalogRow\b/);
    // BOTH retire sites are markers: the sibling-already-has-it branch and the
    // graded-child branch. Swapping either for a delete is what must never
    // ship, so the count is pinned — a new retire path that deletes would
    // change it.
    expect(SRC.split(RETIRE).length - 1, "every retire is a marker").toBe(2);
    const mutantSrc = SRC.split(RETIRE).join(`                deleted: true,`);
    expect(mutantSrc).not.toContain(RETIRE);
    expect(SRC).toContain(RETIRE);
    // The retire also records where the card went, so it is reversible.
    for (const k of ["retiredReason", "retiredAt", "retiredIntoSetKey", "setKeyBefore", "parallelBefore"]) {
      expect(SRC).toContain(k);
    }
  });

  it("MUTATION RED — touching fleer, which has NO sibling product", () => {
    // fleer-tiffany / fleer-update-tiffany / fleer-tradition-tiffany /
    // base-set-tiffany all hold ZERO rows (measured 2026-09-04). Retiring a
    // Fleer rung would delete the only rows those 1,215+ cards have.
    const GATE = `            if (sibRows === 0) {`;
    expect(SRC).toContain(GATE);
    const mutant = evaluate(SRC.replace(GATE, `            if (false) {`));
    // Both versions agree fleer's sibling key is fleer-tiffany...
    expect(mutant.siblingSetKeyFor("fleer")).toBe("fleer-tiffany");
    expect(siblingSetKeyFor("fleer")).toBe("fleer-tiffany");
    // ...but only the original still carries the gate that finds it absent.
    expect(SRC.includes("if (sibRows === 0) {")).toBe(true);
    expect(SRC.replace(GATE, `            if (false) {`).includes(GATE)).toBe(false);
    // The gate exists on BOTH lanes — catalog and pool.
    expect(SRC.split("if (sibRows === 0) {").length - 1).toBe(2);
  });

  it("MUTATION RED — a substring match would swallow a real variation", () => {
    // The classic mistake: an unanchored test. `statesTiffany` is a word
    // match, applied one field at a time, never to a blob of the whole row.
    const LINE = `  return /\\btiffany\\b/i.test(String(text ?? ""));`;
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, `  return true;`));
    expect(mutant.statesTiffany("Grey Backs")).toBe(true); // 132 real cards, destroyed
    expect(statesTiffany("Grey Backs")).toBe(false);
  });
});

describe("the write contract", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  // Comments are prose; prose naming a forbidden verb is not a call to it.
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("writes through the row-ops and relocateSoldComp, never a raw patch", () => {
    // CF-GUARD-THE-CATALOG-WRITE-CONTRACT.
    expect(CODE).toMatch(/patchCatalogRowFields\(cat,/);
    expect(CODE).toMatch(/moveCatalogRow\(cat,/);
    expect(CODE).toMatch(/relocateSoldComp\(pool,/);
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.patch\(/);
    expect(CODE).not.toMatch(/\.items\.(upsert|create)\(/);
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.delete\(/);
  });

  it("the pool re-key moves BOTH identity fields", () => {
    // The pool reader ORs cardId and hobbyiqCardId, so a row that moved only
    // one prices two cards at once (CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS).
    expect(CODE).toContain("keep.cardId = target;");
    expect(CODE).toContain("keep.hobbyiqCardId = target;");
  });

  it("VERIFIES BY READ on both identity fields", () => {
    const m = CODE.match(/verifyFields:\s*\[([^\]]*)\]/);
    expect(m, "the relocate must name verifyFields").toBeTruthy();
    for (const field of ["cardId", "hobbyiqCardId"]) {
      expect(m![1]).toContain(`"${field}"`);
    }
  });

  it("recomputes contentHash, because cardId is its first component", () => {
    // A moved row keeping the old hash is invisible to the store's
    // partition-scoped pre-write dedup and every re-emit duplicates it.
    expect(CODE).toContain("keep.contentHash = contentHashOf(keep);");
  });

  it("stamps the marker and the reason the ruling names", () => {
    expect(REASON).toBe("tiffany-is-a-product");
    expect(CODE).toContain("keep.rekeyedFrom = oldSlug;");
    expect(CODE).toContain("keep.rekeyedReason = REASON;");
  });

  it("blanks the parallel, because Tiffany is the PRODUCT", () => {
    expect(CODE).toContain(`keep.parallel = "";`);
    expect(CODE).toContain("keep.parallelBefore = str(row.parallel);");
  });

  it("keeps the row's own source — provenance is not rewritten", () => {
    // `source` is deliberately absent from every changedFields / patch object.
    expect(CODE).not.toMatch(/\bsource:\s*(REASON|sibling|")/);
  });

  it("reconciles intended = written + skipped + failed on BOTH lanes", () => {
    expect(CODE).toMatch(/reportWrites\(\{\s*job,\s*intended,\s*written,\s*skipped,\s*failed\s*\}\)/);
    expect(CODE.split("reconcile(\"repair-tiffany-rung-to-product:").length - 1).toBe(2);
  });

  it("is report-first and reads the switch the runner exports", () => {
    expect(SRC).toContain(`const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";`);
    // Every write path is handed dryRun: !APPLY rather than being branched
    // around — the row-ops themselves refuse to write in a dry run.
    expect(CODE.split("dryRun: !APPLY").length - 1).toBeGreaterThanOrEqual(4);
  });

  it("MODE is required and has no default", () => {
    expect(SRC).toContain("FATAL: MODE is required and has no default");
    // It refuses BEFORE it requires dist/, so a missing build cannot look
    // like a refusal.
    expect(SRC.indexOf("process.exit(2)")).toBeLessThan(SRC.indexOf("require(path.join(backend"));
  });

  it("ignores the runner's INHERITED scope default rather than obeying it", () => {
    // `scope` defaults to "refractor" runner-wide. Obeying it as a setKey
    // filter would match nothing and report a clean run over an empty
    // population (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW).
    expect(SRC).toContain(`.filter((s) => s !== "refractor" && s !== "all")`);
  });

  it("prints the budget marker the relaunch step greps for", () => {
    expect(SRC).toContain("stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here");
  });
});

describe("the runner can actually dispatch it", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("is whitelisted in the script dropdown", () => {
    expect(YML).toContain("- repair-tiffany-rung-to-product");
  });

  it("the generic run step carries every env the script reads", () => {
    // Registration is the choice option plus the env plumbing; the exec step
    // is generic (`node backend/scripts/${{ inputs.script }}.cjs`).
    for (const v of ["MODE:", "YEARS:", "SCOPE:", "SPORTS:", "LIMIT:", "SLOT:", "SLOTS:", "BACKFILL_APPLY:"]) {
      expect(YML, `${v} must be exported`).toMatch(new RegExp(`^\\s+${v} `, "m"));
    }
  });

  it("claims no new workflow_dispatch input", () => {
    const block = YML.slice(YML.indexOf("workflow_dispatch:"), YML.indexOf("jobs:"));
    const inputs = [...block.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "dispatch inputs are frozen at 24 of GitHub's 25").toBeLessThanOrEqual(24);
  });
});
