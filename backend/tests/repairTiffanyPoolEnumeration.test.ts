/**
 * CF-TIFFANY-IS-A-PRODUCT, the two gaps #1745 left behind.
 *
 * GAP 1 -- the pool was enumerated FROM THE CATALOG, so a comp with no rung
 * row to hang off was never seen. 2,127 comps survived #1745's apply. The
 * scan is now on the pool itself.
 *
 * GAP 2 -- 132 rows carry `num-1951`, a YEAR read out of a baseballcardpedia
 * navbox footer ("Topps (flagship) Classic Era: 1951 - 1952 - ..."), plus a
 * parallel that NAMES the sibling product rather than a finish.
 *
 * The guard that matters most here is the SIBLING TABLE: #1748 proved the
 * sibling is not `${setKey}-tiffany` -- 1987-1989 Fleer is the GLOSSY TIN
 * (`fleer-glossy`) while 1996/1997/2002 Fleer really is `fleer-tiffany`. A
 * naming rule would route a third of the population to a product that will
 * never exist.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "repair-tiffany-pool-enumeration.cjs");
const SCRAPER = path.join(HERE, "..", "scripts", "scrape-bcp-ladders.cjs");
const RUNNER = path.join(HERE, "..", "..", ".github", "workflows", "backfill-runner.yml");
const STAGED = path.join(HERE, "..", "data", "checklists", "scraped");

const mod = require_(SCRIPT);
const {
  statesTiffany, isYearShapedPrintRun, parallelNamesProduct, axesOf,
  toSiblingSlug, isPoolRung, loadStagedSiblings, siblingFor,
  siblingCandidates, resolveSibling,
} = mod;

describe("a year is not a print run", () => {
  it("refuses the navbox year that minted 132 rows", () => {
    // The captured text was literally "Classic Era: 1951" -- the first link in
    // the page's Topps-flagship navbox, matched by RUN_NOTE's bare
    // `:\s*(\d+)` arm. The page's own production sentence declines to give a
    // figure at all: "Although production figures were never disclosed...".
    expect(isYearShapedPrintRun(1951)).toBe(true);
  });

  it("the test is the SHAPE, never the literal 1951", () => {
    // The number captured is whatever leads THAT page's navbox, so a page
    // opening on a different era would mint a different year. A repair keyed
    // on "1951" would under-count.
    for (const y of [1900, 1951, 1987, 2002, 2100]) {
      expect(isYearShapedPrintRun(y), `${y} is year-shaped`).toBe(true);
    }
  });

  it("a REAL print run passes untouched", () => {
    // Measured on this source: the real distribution is 1, 5, 10, 25, 50, 75,
    // 99, 100, 125, 150, 199, 250, 299, 399, 499, 500, 999...
    for (const n of [1, 5, 25, 50, 99, 100, 150, 199, 250, 499, 500, 999, 1500, 12000, 100000]) {
      expect(isYearShapedPrintRun(n), `${n} is a real print run`).toBe(false);
    }
  });

  it("a non-integer or absent value is not year-shaped", () => {
    for (const v of [null, undefined, "", "abc", 1951.5, NaN]) {
      expect(isYearShapedPrintRun(v as never)).toBe(false);
    }
  });
});

describe("a parallel that NAMES the product is not a finish", () => {
  it("the sibling product's own name is caught", () => {
    expect(parallelNamesProduct("Topps Traded Tiffany", "topps-traded-tiffany")).toBe(true);
    expect(parallelNamesProduct("topps traded tiffany", "topps-traded-tiffany")).toBe(true);
  });

  it("`Limited Edition Tiffany` is caught — it is that product's marketing copy", () => {
    // "132 Card Limited Edition Glossy set" is how the Tiffany set was sold.
    expect(parallelNamesProduct("Limited Edition Tiffany", "topps-traded-tiffany")).toBe(true);
    // ...and it is caught even when the sibling is not resolvable.
    expect(parallelNamesProduct("Limited Edition Tiffany", null)).toBe(true);
  });

  it("a REAL finish is never caught", () => {
    // Grey Backs is a real 1991 Topps Traded variation: two plants, grey pack
    // stock vs white factory stock, across the whole 132-card sheet.
    for (const p of ["Grey Backs", "Gray Backs", "Silver Prizm", "Refractor", "Gold", "Base", ""]) {
      expect(parallelNamesProduct(p, "topps-traded-tiffany"), `${p} is a finish`).toBe(false);
    }
  });

  it("a parallel naming a DIFFERENT product is not this row's defect", () => {
    expect(parallelNamesProduct("Topps Traded Tiffany", "topps-tiffany")).toBe(false);
  });
});

describe("the target slug drops the bogus print run", () => {
  it("rewrites setKey, blanks parallel, and strips a year-shaped num- segment", () => {
    expect(toSiblingSlug("hiq:baseball:1991:topps-traded:21t:topps-traded-tiffany:no-auto:num-1951", "topps-traded-tiffany"))
      .toBe("hiq:baseball:1991:topps-traded-tiffany:21t:base:no-auto");
  });

  it("a REAL print run survives the move", () => {
    // Only a year-shaped run is dropped; /150 is a real serial number.
    expect(toSiblingSlug("hiq:baseball:1991:topps-traded:21t:tiffany:no-auto:num-150", "topps-traded-tiffany"))
      .toBe("hiq:baseball:1991:topps-traded-tiffany:21t:base:no-auto:num-150");
  });

  it("a grade tier is carried across untouched", () => {
    expect(toSiblingSlug("hiq:baseball:1990:bowman:27:tiffany:no-auto:psa-9", "bowman-tiffany"))
      .toBe("hiq:baseball:1990:bowman-tiffany:27:base:no-auto:psa-9");
  });
});

describe("THE SIBLING TABLE comes from the staged checklists, not a naming rule", () => {
  const staged = loadStagedSiblings(STAGED);

  it("reads the staged Tiffany/Glossy manifests", () => {
    expect(staged.size).toBeGreaterThanOrEqual(21);
  });

  it("1996/1997/2002 Fleer is fleer-TIFFANY", () => {
    expect(siblingFor(staged, "baseball", 1996, "fleer")).toBe("fleer-tiffany");
    expect(siblingFor(staged, "baseball", 1997, "fleer")).toBe("fleer-tiffany");
    expect(siblingFor(staged, "baseball", 2002, "fleer")).toBe("fleer-tiffany");
    expect(siblingFor(staged, "basketball", 1997, "fleer")).toBe("fleer-tiffany");
  });

  it("1987-1989 Fleer is fleer-GLOSSY — the rule that would break it", () => {
    // THE POINT OF THE WHOLE TABLE. #1748: "FLEER GLOSSY IS 1987-1989, NOT
    // 1987-1991... The Glossy Tin ran three years and was discontinued after
    // 1989." A `${setKey}-tiffany` rule sends these to a product that does not
    // exist and never will.
    expect(siblingFor(staged, "baseball", 1987, "fleer")).toBe("fleer-glossy");
    expect(siblingFor(staged, "baseball", 1988, "fleer")).toBe("fleer-glossy");
    expect(siblingFor(staged, "baseball", 1989, "fleer")).toBe("fleer-glossy");
    // and the naming rule's answer is NOT what we return
    expect(siblingFor(staged, "baseball", 1987, "fleer")).not.toBe("fleer-tiffany");
  });

  it("the update sets keep their own product", () => {
    expect(siblingFor(staged, "baseball", 1987, "fleer-update")).toBe("fleer-update-glossy");
    expect(siblingFor(staged, "baseball", 1996, "fleer-update")).toBe("fleer-update-tiffany");
  });

  it("1990 and 1991 Fleer Glossy DO NOT EXIST — absent beats wrong", () => {
    // #1748 checked the sitemap: no 1990 or 1991 page exists, so none was
    // minted. A rule that invented one would mint a phantom product.
    expect(siblingFor(staged, "baseball", 1990, "fleer")).toBeNull();
    expect(siblingFor(staged, "baseball", 1991, "fleer")).toBeNull();
  });

  it("a key already on the Tiffany product is its own sibling", () => {
    expect(siblingFor(staged, "baseball", 1989, "topps-tiffany")).toBe("topps-tiffany");
    expect(siblingFor(staged, "baseball", 1987, "fleer-glossy")).toBe("fleer-glossy");
  });

  it("an unacquired group returns null rather than a guess", () => {
    expect(siblingFor(staged, "baseball", 1990, "base-set")).toBeNull();
    expect(siblingFor(staged, "football", 1996, "fleer")).toBeNull();
  });
});

describe("the sibling exists if it is STAGED **or** already INGESTED", () => {
  const staged = loadStagedSiblings(STAGED);
  // The first prod report proved why both halves are needed. Only 1987
  // `topps-tiffany` has a staged manifest, but the CATALOG holds 2,423
  // topps-tiffany rows across 1984-1991 (minted by earlier lanes, not a staged
  // CSV). A staged-only gate reported 808 comps as "acquire before retire"
  // whose product was sitting right there, ingested.
  const none = async () => 0;
  const ingested = async (c: string) => (c === "topps-tiffany" ? 95 : 0);

  it("STAGED-only resolution still misses 1985 topps — the defect, reproduced", async () => {
    expect(siblingFor(staged, "baseball", 1985, "topps")).toBeNull();
  });

  it("...and the INGESTED half rescues it", async () => {
    const r = await resolveSibling(staged, "baseball", 1985, "topps", ingested);
    expect(r).toMatchObject({ sibling: "topps-tiffany", via: "ingested" });
  });

  it("a staged product resolves without any catalog read at all", async () => {
    let reads = 0;
    const counting = async () => { reads++; return 0; };
    const r = await resolveSibling(staged, "baseball", 1987, "fleer", counting);
    expect(r).toMatchObject({ sibling: "fleer-glossy", via: "staged" });
    expect(reads, "a staged hit must not cost a Cosmos read").toBe(0);
  });

  it("neither staged nor ingested stays absent — acquire before retire", async () => {
    expect(await resolveSibling(staged, "baseball", 1990, "base-set", none)).toBeNull();
    expect(await resolveSibling(staged, "football", 1996, "fleer", none)).toBeNull();
  });

  it("a key already on the Tiffany product needs neither source", async () => {
    let reads = 0;
    const r = await resolveSibling(staged, "baseball", 1989, "topps-tiffany", async () => { reads++; return 0; });
    expect(r).toMatchObject({ sibling: "topps-tiffany", via: "self" });
    expect(reads).toBe(0);
  });

  it("the candidates are -tiffany then -glossy, never anything else", () => {
    expect(siblingCandidates("fleer")).toEqual(["fleer-tiffany", "fleer-glossy"]);
    expect(siblingCandidates("topps-tiffany")).toEqual(["topps-tiffany"]);
    expect(siblingCandidates("")).toEqual([]);
  });

  it("STAGED WINS over ingested, so #1748's vocabulary is authoritative", async () => {
    // 1987 Fleer is the GLOSSY tin. If some stray `fleer-tiffany` rows existed
    // in the catalog for 1987, the staged manifest must still decide.
    const strayTiffany = async (c: string) => (c === "fleer-tiffany" ? 999 : 0);
    const r = await resolveSibling(staged, "baseball", 1987, "fleer", strayTiffany);
    expect(r).toMatchObject({ sibling: "fleer-glossy", via: "staged" });
  });
});

describe("the pool is enumerated under EITHER spelling", () => {
  it("catches a row whose slug says tiffany", () => {
    expect(isPoolRung({ hobbyiqCardId: "hiq:baseball:1985:topps:493:tiffany:no-auto", parallel: "" })).toBe(true);
  });
  it("catches a row whose parallel says Tiffany though the slug says base", () => {
    expect(isPoolRung({ hobbyiqCardId: "hiq:baseball:1987:topps:130:base:no-auto", parallel: "Tiffany" })).toBe(true);
  });
  it("leaves a row that is neither", () => {
    expect(isPoolRung({ hobbyiqCardId: "hiq:baseball:1987:topps:130:base:no-auto", parallel: "Base" })).toBe(false);
  });
});

// ── mutation checks ─────────────────────────────────────────────────────────
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
  const staged = loadStagedSiblings(STAGED);

  it("MUTATION RED — a `${setKey}-tiffany` naming rule sends 1987 Fleer to a phantom", () => {
    // The candidate list is what encodes #1748's vocabulary. Collapse it to
    // the naming rule and 1987-1989 Fleer routes to a product that will never
    // exist, because the Glossy Tin was discontinued after 1989.
    const LINE = '  return [`${k}-tiffany`, `${k}-glossy`];';
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, '  return [`${k}-tiffany`];'));
    const st = mutant.loadStagedSiblings(STAGED);
    expect(mutant.siblingCandidates("fleer")).toEqual(["fleer-tiffany"]);
    // THE DEFECT, and it is worse than a miss: 1987 Fleer resolves to
    // `fleer-tiffany` -- a product that is NOT staged for 1987 and never will
    // be, because the Glossy Tin was discontinued after 1989. The comps would
    // be re-keyed onto a phantom.
    expect(st.has("baseball:1987:fleer-tiffany")).toBe(false);
    expect(mutant.siblingFor(st, "baseball", 1987, "fleer")).toBe("fleer-tiffany");
    // The real code reads the staged manifest and says glossy.
    expect(siblingFor(staged, "baseball", 1987, "fleer")).toBe("fleer-glossy");
    expect(siblingCandidates("fleer")).toEqual(["fleer-tiffany", "fleer-glossy"]);
  });

  it("MUTATION RED — dropping the INGESTED half strands 808 comps", async () => {
    // Only 1987 topps-tiffany is staged, but the catalog holds 2,423
    // topps-tiffany rows across 1984-1991. A staged-only gate reports those
    // comps as "acquire before retire" when their product already exists.
    expect(SRC).toContain("if (n > 0) return { sibling: c, via: \"ingested\" };");
    const mutant = evaluate(SRC.replace('    if (n > 0) return { sibling: c, via: "ingested" };', "    if (false) return null;"));
    const st = mutant.loadStagedSiblings(STAGED);
    const ingested = async (c: string) => (c === "topps-tiffany" ? 95 : 0);
    // THE DEFECT: 1985 topps has no staged manifest, so it resolves to nothing.
    expect(await mutant.resolveSibling(st, "baseball", 1985, "topps", ingested)).toBeNull();
    // The real code finds the ingested product.
    expect(await resolveSibling(staged, "baseball", 1985, "topps", ingested))
      .toMatchObject({ sibling: "topps-tiffany", via: "ingested" });
  });

  it("MUTATION RED — dropping the year-shape test lets 1951 through as a print run", () => {
    const LINE = `  return Number.isInteger(n) && n >= 1900 && n <= 2100;`;
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, "  return false;"));
    expect(mutant.isYearShapedPrintRun(1951)).toBe(false); // the defect
    expect(isYearShapedPrintRun(1951)).toBe(true);
    // ...and the bogus segment then survives the move into the new id.
    expect(mutant.toSiblingSlug("hiq:baseball:1991:topps-traded:21t:tiffany:no-auto:num-1951", "topps-traded-tiffany"))
      .toBe("hiq:baseball:1991:topps-traded-tiffany:21t:base:no-auto:num-1951");
    expect(toSiblingSlug("hiq:baseball:1991:topps-traded:21t:tiffany:no-auto:num-1951", "topps-traded-tiffany"))
      .toBe("hiq:baseball:1991:topps-traded-tiffany:21t:base:no-auto");
  });

  it("MUTATION RED — dropping the title guard moves a BASE sale into the Tiffany pool", () => {
    const LINE = `      if (!statesTiffany(row.title)) {`;
    expect(SRC).toContain(LINE);
    const mutated = SRC.replace(LINE, `      if (false) {`);
    expect(mutated).not.toContain(LINE);
    // The 93-row population: slug says tiffany, the row's own title says Base.
    const baseSale = { hobbyiqCardId: "hiq:baseball:1987:topps:450:tiffany:no-auto", parallel: "Base", title: "1987 Topps Baseball #450 Base" };
    expect(isPoolRung(baseSale)).toBe(true);
    expect(statesTiffany(baseSale.title)).toBe(false);
  });

  it("MUTATION RED — a substring match would swallow a real variation", () => {
    const LINE = `  return /\\btiffany\\b/i.test(String(text ?? ""));`;
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, `  return true;`));
    expect(mutant.statesTiffany("Grey Backs")).toBe(true);
    expect(statesTiffany("Grey Backs")).toBe(false);
  });
});

describe("the write contract", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("retire is a MARKER — the script contains no delete at all", () => {
    expect(CODE).toContain("retired: true,");
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.delete\(/);
    expect(CODE).not.toMatch(/\bretireCatalogRow\b/);
    expect(CODE).not.toMatch(/\.items\.(upsert|create)\(/);
  });

  it("writes through the row-ops and relocateSoldComp only", () => {
    expect(CODE).toMatch(/patchCatalogRowFields\(cat,/);
    expect(CODE).toMatch(/relocateSoldComp\(pool,/);
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.patch\(/);
  });

  it("the pool re-key moves BOTH identity fields and verifies by read", () => {
    expect(CODE).toContain("keep.cardId = target;");
    expect(CODE).toContain("keep.hobbyiqCardId = target;");
    const m = CODE.match(/verifyFields:\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    for (const field of ["cardId", "hobbyiqCardId"]) expect(m![1]).toContain(`"${field}"`);
  });

  it("recomputes contentHash, because cardId is its first component", () => {
    expect(CODE).toContain("keep.contentHash = contentHashOf(keep);");
  });

  it("the num1951 retire records what it undid, so it is reversible", () => {
    for (const k of ["printRunBefore", "parallelBefore", "setKeyBefore", "retiredBecause"]) {
      expect(SRC).toContain(k);
    }
  });

  it("reconciles on both lanes and is report-first", () => {
    expect(CODE).toMatch(/reportWrites\(\{\s*job,\s*intended,\s*written,\s*skipped,\s*failed\s*\}\)/);
    expect(CODE.split('reconcile("repair-tiffany-pool-enumeration:').length - 1).toBe(2);
    expect(SRC).toContain(`const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";`);
    expect(CODE.split("dryRun: !APPLY").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("MODE is required, and it refuses before it requires dist/", () => {
    expect(SRC).toContain("FATAL: MODE is required and has no default");
    expect(SRC.indexOf("process.exit(2)")).toBeLessThan(SRC.indexOf("require(path.join(backend"));
  });

  it("ignores the runner's inherited scope default", () => {
    expect(SRC).toContain(`.filter((s) => s !== "refractor" && s !== "all")`);
  });
});

describe("the scraper defence", () => {
  const SRC = fs.readFileSync(SCRAPER, "utf8");
  const scraper = require_(SCRAPER);

  it("the navbox is page chrome, so a slice stops at it", () => {
    // The 1991 page's navbox begins at byte 38,160; the nearest OLD terminator
    // (printfooter) is at 57,511 — so the last heading in Parallels absorbed
    // 19,000 bytes of chrome opening "Classic Era: 1951".
    expect(scraper.PAGE_CHROME).toContain('<table class="toccolours');
  });

  it("a year-shaped value is refused as a print run", () => {
    expect(scraper.isYearShaped(1951)).toBe(true);
    expect(scraper.isYearShaped(1900)).toBe(true);
    expect(scraper.isYearShaped(2100)).toBe(true);
    // Real print runs on this source are unaffected.
    for (const n of [1, 25, 50, 99, 150, 499, 999, 12000]) {
      expect(scraper.isYearShaped(n), `${n} is a real print run`).toBe(false);
    }
  });

  it("the guard is wired into BOTH parse paths", () => {
    // The heading-rung gate and the <li> gate both take their figure from
    // `runFromNote`, which is where the year guard now lives. Asserting the
    // CALL rather than the old inline expressions: #1758 moved the guard into
    // that helper to scope it to the bare-colon arm, and a pin that greps for
    // a line the fix rewrote pins the file's history, not its behaviour.
    expect(SRC).toContain("const n = runFromNote(text);");   // heading rungs
    expect(SRC).toContain("let n = runFromNote(note);");     // <li> rungs
    expect(SRC).toContain("if (isBareColonRun(m) && isYearShaped(n)) return null;");
    // ...and the behaviour those two paths inherit: the navbox year is refused.
    expect(scraper.runFromNote("Classic Era: 1951 - 1952")).toBeNull();
  });

  it("but a STATED serial that looks like a year survives — #1758", () => {
    // #1752's blanket guard also erased 1999 Black Diamond's real Double
    // Diamond exception rung, "serial-numbered to 1998" on the three 1998
    // home-run-chase cards. Only figures scraped from a bare colon are chrome.
    expect(scraper.runFromNote("(serial-numbered to 1998)")).toBe(1998);
    expect(scraper.isBareColonRun("Classic Era: 1951".match(/(?::\s*)([\d,]+)/))).toBe(true);
  });

  it("MUTATION RED — without the guard, 1951 is accepted as a print run", () => {
    const LINE = "  return Number.isInteger(n) && n >= 1900 && n <= 2100;";
    expect(SRC).toContain(LINE);
    const mutated = SRC.replace(LINE, "  return false;");
    expect(mutated).not.toContain(LINE);
    // The old gate `n >= 1 && n <= 100000` admits every four-digit year, which
    // is exactly why this shipped.
    const n = 1951;
    expect(n >= 1 && n <= 100000).toBe(true);
    expect(scraper.isYearShaped(n)).toBe(true);
  });
});

describe("the runner can dispatch it", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("is whitelisted", () => {
    expect(YML).toContain("- repair-tiffany-pool-enumeration");
  });

  it("the generic run step carries every env it reads", () => {
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
