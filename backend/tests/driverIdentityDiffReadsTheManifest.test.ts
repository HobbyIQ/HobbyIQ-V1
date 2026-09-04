/**
 * CF-THE-DIFF-MUST-READ-THE-KEY-THE-MANIFEST-STATES (2026-09-04).
 *
 * THE DOMINANT LANE FAILURE, measured on the `crawl_state` control docs of
 * main: 631 of 706 `failed` entries are one of four verdicts, and they share
 * one cause.
 *
 *   sportscardchecklist  380  "short ingest — N of N staged identities are not
 *                              in the catalog"
 *   sportscardchecklist   96  "ingest reported success but the catalog holds
 *                              N rows for this product"
 *   bcp                   99  short ingest, Bowman's Best 1994-2005
 *   sportscardchecklist   35  "zero base cards"
 *
 * THE CAUSE. The ingest child resolves its product through `productOf`, which
 * reads the fetcher's manifest and takes `m.setKey` VERBATIM. The driver's
 * verification never read that manifest -- it RECONSTRUCTED a key from the
 * entry's display name (`setKeyFor`) and asked the catalog under that. Since
 * #1741 the two routinely disagree, because a rung or insert page states its
 * PARENT product. Re-fetched from the live source on 2026-09-04, the three
 * entries the failures name:
 *
 *   2004-05 Topps Chrome Town Heroes Basketball
 *     manifest setKey `topps-chrome`  vs  setKeyFor `topps-chrome-town-heroes`
 *   2000-01 Topps Gallery Basketball
 *     manifest setKey `topps`         vs  setKeyFor `topps-gallery`
 *   2003 Bowman's Best (bcp)
 *     manifest setKey `bowman`        vs  setKeyFor `bowman-s-best`
 *
 * #1738's alias normalisation cannot reach any of them: `topps-gallery` and
 * `bowmans-best` are RULED products that normalizeSetKey returns unchanged, so
 * no alias resolution turns them into the parent the manifest named. Gallery
 * is the proof -- 150 clean base rows staged, all 150 written under `topps`,
 * and the driver read `topps-gallery`, found 0, and recorded "ingest reported
 * success but the catalog holds 0 rows for this product".
 *
 * THE FIXTURES ARE THE REAL FILES, fetched from the live pages the control
 * docs name. Nothing here is hand-written, so the pin fails the moment the
 * comparison stops resolving the product the way the writer does.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const driver = require_("../scripts/ingest-universe-driver.cjs");
const scc = require_("../scripts/fetchSportsCardChecklist.cjs");
const FIX = path.join(__dirname, "fixtures", "manifest-key-diff");
const fix = (n: string) => path.join(FIX, n);
const DRIVER_SRC = path.join(__dirname, "..", "scripts", "ingest-universe-driver.cjs");

/** The entries exactly as the manifests name them, one per failing control doc. */
const CASES = [
  {
    file: "town-heroes.csv",
    entry: { lane: "sportscardchecklist", year: 2004, sport: "basketball", setName: "2004-05 Topps Chrome Town Heroes Basketball" },
    manifestKey: "topps-chrome",
    reconstructed: "topps-chrome-town-heroes",
  },
  {
    file: "gallery.csv",
    entry: { lane: "sportscardchecklist", year: 2000, sport: "basketball", setName: "2000-01 Topps Gallery Basketball" },
    manifestKey: "topps",
    reconstructed: "topps-gallery",
  },
  {
    file: "bowmans-best.csv",
    entry: { lane: "bcp", year: 2003, sport: "baseball", setName: "Bowman’s Best".replace("’", "'") },
    manifestKey: "bowman",
    reconstructed: "bowman-s-best",
  },
];

describe("the identity diff reads the key the manifest states", () => {
  it("every fixture is the REAL staged pair, manifest beside CSV", () => {
    for (const c of CASES) {
      expect(fs.existsSync(fix(c.file))).toBe(true);
      const m = JSON.parse(fs.readFileSync(fix(c.file).replace(/\.csv$/, ".manifest.json"), "utf8"));
      // The manifest states the key the CHILD writes under, and it is NOT the
      // one the display name reconstructs. That divergence IS the bug.
      expect(m.setKey).toBe(c.manifestKey);
      expect(m.setKey).not.toBe(c.reconstructed);
      expect(driver.setKeyFor(c.entry)).toBe(c.reconstructed);
    }
  });

  it("setKeyCandidates leads with the manifest's key, for all three", () => {
    for (const c of CASES) {
      const keys = driver.setKeyCandidates(c.entry, [fix(c.file)]);
      // FIRST, not merely present: it is the key the rows are actually under,
      // and a union that reaches it only by luck of alias order is not a fix.
      expect(keys[0]).toBe(c.manifestKey);
      // The reconstructed key stays in the union -- residue sits under it (25
      // rows under `topps-chrome-town-heroes` in prod on 2026-09-04) and the
      // honest count is both.
      expect(keys).toContain(c.reconstructed);
    }
  });

  it("without a manifest it still answers, on the reconstructed key alone", () => {
    // An entry staged before the fetcher wrote sidecars must stay verifiable:
    // the manifest LEADS, it does not become a precondition.
    const keys = driver.setKeyCandidates(CASES[1].entry, []);
    expect(keys).toContain("topps-gallery");
    expect(keys.length).toBeGreaterThan(0);
  });

  it("the writer's own product resolution is what the comparison is written against", () => {
    // ONE RECONSTRUCTION, NEVER TWO. The child mints every id through
    // computeHobbyIqCardId with the MANIFEST's setKey; a diff that resolves a
    // different key is comparing two different products.
    const child = fs.readFileSync(path.join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"), "utf8");
    expect(child).toMatch(/setKey:\s*m\.setKey\s*\|\|\s*normalizeSetKey\(m\.setName\)/);
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    // The driver reads that same field, from that same sidecar.
    expect(src).toMatch(/function manifestSetKeys\(entry, csvPaths\)/);
    expect(src).toMatch(/for \(const k of manifestSetKeys\(entry, csvPaths\)\) \{ add\(k\); add\(canonicalSetKey\(k\)\); \}/);
    // and every read site is given the files this run acquired.
    expect(src).toMatch(/const after = await countCatalogRows\(entry, csvPaths\);/);
    expect(src).toMatch(/const inCatalog = await catalogIdentities\(entry, csvPaths\)\.catch/);
    expect(src).toMatch(/countCatalogRowsBySource\(entry, sourceLabelFor\(lane\), csvPaths\)/);
  });

  it("a zero-row verdict NAMES the key it counted", () => {
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    // "the catalog holds 0 rows" was unactionable: 96 entries carried it and
    // every one was a key mismatch the sentence never showed.
    expect(src).toMatch(/counted under \$\{countedKeys\.length/);
    expect(src).toMatch(/countedSetKeys: countedKeys/);
    // and the short-ingest verdict names its address for the same reason.
    expect(src).toMatch(/under \$\{shortIngest\.countedKeys\.map/);
  });
});

/**
 * CF-A-RUNG-PAGE-OF-AN-UNLISTED-BRAND-IS-STILL-A-RUNG-PAGE. The 35 zero-base
 * refusals: `parallelOfParent` is derived from PARENT_BRANDS, and every refused
 * page was a brand that list never named (Bowman's Best 33, Select 3,
 * Pacific 2 -- counted from the control docs on 2026-09-04).
 */
describe("a rung page of a ruled product is admitted", () => {
  const split = (rest: string) => scc.splitParentAndSubset(rest, scc.parallelTailOf(rest));

  it("Pacific, Bowman's Best and Select rung pages find their parent", () => {
    expect(split("pacific-prisms-gold").parentSetKey).toBe("pacific-prism");
    expect(split("pacific-crown-collection-silver").parentSetKey).toBe("pacific-crown-collection");
    expect(split("bowmans-best-refractors").parentSetKey).toBe("bowmans-best");
    expect(split("bowmans-best-atomic-refractors").parentSetKey).toBe("bowmans-best");
    expect(split("score-select-gold").parentSetKey).toBe("score-select");
  });

  it("the real Pacific Prisms Gold manifest now attests parallelOfParent", () => {
    const m = JSON.parse(fs.readFileSync(fix("pacific-prisms-gold.manifest.json"), "utf8"));
    // Fetched from the live page after the fix. Before it: parentSetKey=(none),
    // parallelOfParent=false, and the driver's zero-base gate refused the page.
    expect(m.parallelOfParent).toBe(true);
    expect(m.setKey).toBe("pacific-prism");
    expect(m.parallelName).toBe("Gold");
    // and the gate admits it on that attestation.
    expect(driver.allFilesAreParallelOfParent([fix("pacific-prisms-gold.csv")])).toBe(true);
  });

  it("the site's plural slug resolves to the key productSetKeys rules", () => {
    // `pacific-prisms` is what the site serves; `pacific-prism` is the ruled
    // product (its own note in productSetKeys: three authorities agree on the
    // singular). Both spellings must land on the singular, or a Prisms rung
    // page splits from the pool it belongs to.
    expect(split("pacific-prisms-gold").parentSetKey).toBe("pacific-prism");
    expect(split("pacific-prism-gold").parentSetKey).toBe("pacific-prism");
  });

  it("LONGEST FIRST: a specific product is never shadowed by its brand", () => {
    // `bowmans-best` before `bowman`, `pacific-crown-collection` before
    // `pacific` -- the #1666 collapse in miniature.
    expect(split("bowmans-best-refractors").parentSetKey).not.toBe("bowman");
    expect(split("pacific-crown-collection-silver").parentSetKey).not.toBe("pacific");
  });

  it("the ruled-product and coated-reprint exemptions still refuse a parent", () => {
    // #1748 and #1758 must survive: a Tiffany/Glossy printing and a separately
    // issued junk-wax product are their OWN products, never a brand's subset.
    expect(split("topps-tiffany-traded").parentSetKey).toBe("");
    expect(split("score-rookie-and-traded").parentSetKey).toBe("");
    expect(split("upper-deck-minors").parentSetKey).toBe("");
  });
});

/**
 * THE PIN THAT KEEPS THE LOCAL LIST HONEST. PARENT_BRANDS lives in the fetcher
 * as a local constant so the script runs offline with no dist/, so it can drift
 * from the catalog vocabulary. Every parent it can return must be a product
 * productSetKeys actually spells.
 */
describe("every parent the fetcher can name is a product the catalog spells", () => {
  it("asserts each brand against productSetKeys", async () => {
    const { isProductSetKey } = await import("../src/services/catalog/productSetKeys.js");
    const split = (rest: string) => scc.splitParentAndSubset(rest, scc.parallelTailOf(rest));
    for (const slug of [
      "topps-chrome-refractors", "bowman-chrome-refractors", "bowman-sterling-refractors",
      "topps-finest-refractors", "topps-heritage-refractors", "topps-traded-refractors",
      "topps-stadium-club-refractors", "upper-deck-refractors", "o-pee-chee-refractors",
      "topps-refractors", "bowman-refractors", "fleer-refractors", "donruss-refractors",
      "score-refractors", "leaf-refractors", "panini-refractors",
      "pacific-refractors", "pacific-prisms-gold", "pacific-prism-gold",
      "pacific-crown-collection-silver", "bowmans-best-refractors", "score-select-gold",
    ]) {
      const parent = split(slug).parentSetKey;
      expect(parent, `${slug} named no parent`).toBeTruthy();
      expect(isProductSetKey(parent), `${parent} (from ${slug}) is not in productSetKeys`).toBe(true);
    }
  });
});
