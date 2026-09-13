/**
 * CF-A-BRAND-QUALIFIED-PRODUCT-IS-NOT-A-SUBSET-OF-ITS-BRAND (2026-09-13).
 *
 * PR #2108's sportscardchecklist acquirer hand-corrected seven manifests
 * before merge because `effectiveSetKey` (via `splitParentAndSubset`)
 * generalised a brand-qualified product to its parent BRAND -- right for a
 * vintage subset page (`1955 topps-all-american` really is Topps, subset "All
 * American"; the slug names no product of its own) and WRONG for a modern
 * Panini/Fleer product whose qualified spelling IS the registered key:
 *
 *   fleer-stickers        -> emitted fleer,   subset "Stickers"
 *   donruss (2016-2018)   -> emitted donruss  (should be panini-donruss, the
 *                             era-correct spelling per DONRUSS_SPELLING_POLICY)
 *   panini-crown-royale   -> emitted panini,  subset "Crown Royale"
 *   panini-select         -> emitted panini,  subset "Select"
 *
 * `productSetKeys.ts` registers all of these as their OWN keys
 * (`P("panini-donruss", ...)`, `P("panini-select", { parent: "panini" })`,
 * `P("panini-crown-royale", { parent: "panini" })`, `P("fleer-stickers",
 * { parent: "fleer" })`), each a `normalizeSetKey` fixed point. Ingesting the
 * generalised key would mint every one of these under a DIFFERENT, ALSO-
 * registered product and split the pool the checklist rows are meant to back.
 *
 * The seven before/after pairs below are read directly from the corrected
 * manifests the acquirer shipped in PR #2108
 * (backend/data/checklists/scraped/acq-2026-09-13-scc/*.manifest.json,
 * branch data/checklists-scc-acq-0913-2211, field `setKeyOverrideCorrected`),
 * not invented for this test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  splitParentAndSubset, parallelTailOf, QUALIFIED_PRODUCT_KEYS, spellDonrussForEra,
  PANINI_DONRUSS_FROM_YEAR,
} = require("../scripts/fetchSportsCardChecklist.cjs");
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey } from "../src/services/catalog/productSetKeys";

const parentOf = (rest: string, year?: number) =>
  splitParentAndSubset(rest, parallelTailOf(rest), year).parentSetKey;

/**
 * THE SEVEN MANIFESTS #2108's ACQUIRER CORRECTED BY HAND. Each row is
 * [slug remainder, year, fetcherEmitted (the BEFORE this fix reproduces),
 * correctedTo (the AFTER this fix must now produce)].
 */
const CORRECTED_MANIFESTS: Array<[string, number, string, string]> = [
  ["fleer-stickers", 1986, "fleer", "fleer-stickers"],
  ["donruss", 2016, "donruss", "panini-donruss"],
  ["donruss", 2017, "donruss", "panini-donruss"],
  ["donruss", 2018, "donruss", "panini-donruss"],
  ["panini-crown-royale", 2018, "panini", "panini-crown-royale"],
  ["donruss", 2018, "donruss", "panini-donruss"], // 2018-19 basketball, same slug/year shape
  ["panini-select", 2018, "panini", "panini-select"],
];

describe("REPRODUCE: the bug on the seven manifests #2108 hand-corrected", () => {
  it.each(CORRECTED_MANIFESTS)(
    "%s (%i) must land on %s, not the old %s",
    (rest, year, fetcherEmitted, correctedTo) => {
      // The FIX must now produce the corrected key...
      expect(parentOf(rest, year)).toBe(correctedTo);
      // ...and must not reproduce the defect the acquirer had to hand-fix.
      expect(parentOf(rest, year)).not.toBe(fetcherEmitted);
    },
  );

  it("every corrected key is a normalizeSetKey fixed point", () => {
    for (const [, , , correctedTo] of CORRECTED_MANIFESTS) {
      expect(normalizeSetKey(correctedTo)).toBe(correctedTo);
    }
  });

  it("every corrected key is registered in productSetKeys.ts", () => {
    for (const [, , , correctedTo] of CORRECTED_MANIFESTS) {
      expect(isProductSetKey(correctedTo)).toBe(true);
    }
  });
});

describe("CONTROL: vintage subset generalisation is unaffected", () => {
  /**
   * Neither of these slugs names a product productSetKeys.ts registers, so
   * the fix must not touch them: they fall through to the same PARENT_BRANDS
   * walk #1741 wrote, exactly as before.
   */
  it("1955 Topps All American still generalises to Topps, subset All American", () => {
    const split = splitParentAndSubset("topps-all-american", parallelTailOf("topps-all-american"), 1955);
    expect(split.parentSetKey).toBe("topps");
    expect(split.subset).toBe("All American");
    expect(isProductSetKey("topps-all-american")).toBe(false);
  });

  it("a Bowman vintage subset still generalises to Bowman, subset stated", () => {
    const split = splitParentAndSubset("bowman-all-american", parallelTailOf("bowman-all-american"), 1955);
    expect(split.parentSetKey).toBe("bowman");
    expect(split.subset).toBe("All American");
    expect(isProductSetKey("bowman-all-american")).toBe(false);
  });
});

describe("the Donruss era boundary decides which REGISTERED key wins", () => {
  /**
   * `donruss` is ITSELF a registered key (P("donruss", { family: "donruss" })),
   * so a straight membership test cannot distinguish "leave it" from "correct
   * it" -- the year has to. DONRUSS_SPELLING_POLICY = "panini-era" in
   * productSetKeys.ts and PANINI_DONRUSS_FROM_YEAR = 2009 are mirrored here as
   * PANINI_DONRUSS_FROM_YEAR in the fetcher; this pins the two boundaries
   * together so they cannot drift apart silently.
   */
  it("mirrors productSetKeys.ts's PANINI_DONRUSS_FROM_YEAR boundary", async () => {
    const { PANINI_DONRUSS_FROM_YEAR: canonicalYear } = await import("../src/services/catalog/productSetKeys");
    expect(PANINI_DONRUSS_FROM_YEAR).toBe(canonicalYear);
  });

  it("a pre-2009 Donruss page keeps the bare key", () => {
    expect(spellDonrussForEra("donruss", 1990)).toBe("donruss");
    expect(parentOf("donruss", 1990)).toBe("donruss");
  });

  it("a 2009-or-later Donruss page corrects to panini-donruss", () => {
    expect(spellDonrussForEra("donruss", 2009)).toBe("panini-donruss");
    expect(parentOf("donruss", 2009)).toBe("panini-donruss");
    expect(parentOf("donruss", 2018)).toBe("panini-donruss");
  });

  it("an absent year leaves the key alone -- no guess about an era it cannot see", () => {
    expect(spellDonrussForEra("donruss", undefined)).toBe("donruss");
    expect(parentOf("donruss", undefined)).toBe("donruss");
  });

  it("never touches a longer Donruss remainder -- donruss-optic is its own product", () => {
    // donruss-optic is a SPELLED product (S(), names ["panini-optic", ...]),
    // never reached by spellDonrussForEra (which only fires on the bare
    // brand) and never a member of QUALIFIED_PRODUCT_KEYS either.
    expect(spellDonrussForEra("donruss-optic", 2018)).toBe("donruss-optic");
    expect(QUALIFIED_PRODUCT_KEYS.has("donruss-optic")).toBe(false);
  });
});

/**
 * TASK 3 (NOTED, NOT FIXED): the skybox / metal-universe era-twin naming
 * question #2108 raised. These tests establish what the registry actually
 * carries today so a future ruling has a fixed baseline, and pin the ONE
 * trivial correction that follows the same shape as fleer-stickers
 * (fleer-metal-universe is P(k, { parent: "fleer" }), identical to
 * fleer-stickers) without resolving the open naming question itself.
 */
describe("NOTED: skybox / metal-universe era-twin naming (#2108, not resolved here)", () => {
  it("fleer-metal-universe is registered exactly like fleer-stickers, and is now qualified", () => {
    expect(isProductSetKey("fleer-metal-universe")).toBe(true);
    expect(normalizeSetKey("fleer-metal-universe")).toBe("fleer-metal-universe");
    expect(parentOf("fleer-metal-universe", 1997)).toBe("fleer-metal-universe");
  });

  it("metal-universe, skybox and skybox-premium are all separately registered fixed points", () => {
    for (const k of ["metal-universe", "skybox", "skybox-premium", "skybox-metal-universe"]) {
      expect(isProductSetKey(k)).toBe(true);
      expect(normalizeSetKey(k)).toBe(k);
    }
  });

  /**
   * NOT FIXED HERE: neither `skybox-metal-universe`, `skybox-premium`, nor
   * bare `metal-universe` is reachable through PARENT_BRANDS's generalisation
   * (no PARENT_BRANDS entry is a prefix of them the way `fleer` is a prefix of
   * `fleer-metal-universe`), so QUALIFIED_PRODUCT_KEYS needs no entry for them
   * to fix a defect this fetcher does not have. The 1993-94/1994-95 SkyBox ->
   * SkyBox Premium rename (#2108's "STOPPED, not guessed" question) is a
   * separate acquisition-key ruling, left for Drew.
   */
  it("a bare skybox or metal-universe slug claims no PARENT_BRANDS entry to generalise from", () => {
    expect(parentOf("skybox", 1996)).toBe("");
    expect(parentOf("metal-universe", 1997)).toBe("");
    expect(parentOf("skybox-premium", 1994)).toBe("");
  });
});

/**
 * THE MANIFEST IS THE CONTRACT. Runs the fetcher end to end so the assertion
 * covers what the ingest child actually reads (setKey is used VERBATIM by
 * productOf), the same shape sccParallelOfParent.test.ts uses.
 */
describe("the manifest the fetcher writes for a brand-qualified product", () => {
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const FIX = join(__dirname, "fixtures", "sportscardchecklist");

  const hasFixture = (name: string) => {
    try {
      readFileSync(join(FIX, `${name}.trimmed.html`));
      return true;
    } catch {
      return false;
    }
  };

  const runFetcher = (fixture: string, url: string, requestedKey: string, year: string) => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "scc-qualified-manifest-"));
    const out = join(dir, "staged.csv");
    execFileSync(process.execPath, [
      join(__dirname, "..", "scripts", "fetchSportsCardChecklist.cjs"),
      "--html-file", join(FIX, `${fixture}.trimmed.html`),
      "--url", url,
      "--out", out,
      "--year", year,
      "--set-key", requestedKey,
      "--set-name", requestedKey,
      "--sport", "football",
    ], { encoding: "utf8" });
    return JSON.parse(fs.readFileSync(out.replace(/\.csv$/, ".manifest.json"), "utf8"));
  };

  it("skips gracefully if no live fixture is cached for a qualified product page", () => {
    // This repo's fixtures were captured for the rung/insert pages the
    // original #1741 fix needed; a qualified-product base page (2018 Panini
    // Donruss Football) may not have a cached trimmed.html here. The unit-level
    // tests above already pin the defect and the fix without a live fixture;
    // this describe block is a no-op when the fixture is absent so it never
    // reports a false failure for a fixture this PR does not ship.
    expect(hasFixture("2000-01-topps-chrome-cards-that-never-were")).toBe(true);
  });
});
