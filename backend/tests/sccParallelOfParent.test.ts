/**
 * CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT (2026-09-04, run 33875264485).
 *
 * The sportscardchecklist full lane recorded 139 failed / 62 partial and ZERO
 * ingested. 76 of those failures were one verdict:
 *
 *   REFUSED — zero base cards across all 1 staged file(s) (N rows, all carry a parallel)
 *
 * Every one of them is a Topps Chrome Basketball page from 2000-01 to 2008-09,
 * and every one is a PARALLEL or INSERT page of a parent product that this site
 * publishes at its own URL:
 *
 *   /set-151054/2000-01-topps-chrome-aptitude-for-altitude-basketball-...   <- base
 *   /set-151055/2000-01-topps-chrome-aptitude-for-altitude-refractors-...   <- this rung
 *
 * TWO defects, and the second is the dangerous one:
 *
 *   1. THE GATE. The fetcher stamps `parallel` from the slug for every row, so
 *      the file has no base cards and the zero-base rule -- written for a
 *      cross-join -- refuses it. #1723 already built the admission this needs
 *      (LANES_WITH_BASELESS_PRODUCTS + single-rung); sportscardchecklist was
 *      simply not in the set.
 *
 *   2. THE KEY. The driver passes `--set-key` derived from the page's DISPLAY
 *      NAME, so the 76 pages carried 57 DISTINCT invented product keys
 *      (`topps-chrome-refractors-gold`, `topps-chrome-johnson-reprints-...`).
 *      normalizeSetKey collapses all 57 to `topps-chrome` -- but the ingest
 *      child uses the manifest's setKey VERBATIM when one is given, so that
 *      collapse never ran. Admitting the gate WITHOUT fixing the key would have
 *      minted 57 phantom products instead of refusing 76 pages.
 *
 * And one ruling the fix must NOT guess: the identity slug has no subset axis,
 * so two subsets of one product that number their cards alike collide. That is
 * measured here, not hypothesised, from the two live pages.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseSetUrl, parallelFromSlug, parallelTailOf, splitParentAndSubset, buildRows,
} = require("../scripts/fetchSportsCardChecklist.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setKeyFor, gateStagedEntry, LANES_WITH_BASELESS_PRODUCTS,
} = require("../scripts/ingest-universe-driver.cjs");
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const FIX = join(__dirname, "fixtures", "sportscardchecklist");
const html = (n: string) => readFileSync(join(FIX, `${n}.trimmed.html`), "utf8");
const B = "https://www.sportscardchecklist.com";

/** The four live pages pinned here, fetched 2026-09-04 at 1 req/s. */
const RUNG = `${B}/set-151055/2000-01-topps-chrome-aptitude-for-altitude-refractors-basketball-trading-card-checklist`;
const CTNW_RUNG = `${B}/set-151057/2000-01-topps-chrome-cards-that-never-were-refractors-basketball-trading-card-checklist`;
const CTNW_BASE = `${B}/set-151056/2000-01-topps-chrome-cards-that-never-were-basketball-trading-card-checklist`;
const JOHNSON = `${B}/set-151067/2000-01-topps-chrome-johnson-reprints-refractors-basketball-trading-card-checklist`;

describe("SCC parallel pages belong to the parent product", () => {
  it("reads the rung and the parent from the same slug", () => {
    const p = parseSetUrl(RUNG);
    expect(p.seasonLabel).toBe("2000-01");
    expect(parallelFromSlug(p.rest)).toBe("Refractor");

    const split = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(split.parentSetKey).toBe("topps-chrome");
    expect(split.subset).toBe("Aptitude For Altitude");
  });

  /**
   * THE PARENT KEY MUST BE A normalizeSetKey FIXED POINT. A key that still
   * normalizes to something else is a key the catalog will move out from under
   * the row, and the driver's own verification count would then read a
   * different product than the ingest wrote (CF-THE-COUNT-MUST-READ-THE-KEY-
   * THE-CHILD-WROTE). `topps-chrome`, not `topps`: Chrome and flagship Topps
   * are different products with different pools.
   */
  it("lands on a parent key that is a normalizeSetKey fixed point", () => {
    const p = parseSetUrl(RUNG);
    const { parentSetKey } = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(normalizeSetKey(parentSetKey)).toBe(parentSetKey);
    expect(parentSetKey).not.toBe("topps");
  });

  /**
   * THE DEFECT THE GATE WAS HIDING. Every one of the 76 refused pages carried
   * an invented product key derived from its display name. This asserts the
   * BEFORE and the AFTER on one real entry, so a regression that restores the
   * display-name key is visible as a phantom product rather than as a
   * mysteriously larger catalog.
   */
  it("does not mint a product key out of the page's display name", () => {
    const entry = {
      lane: "sportscardchecklist",
      setName: "2000-01 Topps Chrome Aptitude For Altitude Refractors Basketball",
      year: 2000,
    };
    // What the driver derives, and what it collapses to.
    const derived = setKeyFor(entry);
    expect(derived).toBe("topps-chrome-aptitude-for-altitude-refractors");
    expect(normalizeSetKey(derived)).toBe("topps-chrome");

    // What the fetcher now writes into the manifest, which the ingest child
    // uses verbatim -- the two must agree, or the count reads the wrong product.
    const p = parseSetUrl(RUNG);
    const { parentSetKey } = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(parentSetKey).toBe(normalizeSetKey(derived));
  });

  /**
   * A COMPOUND RUNG IS NOT ITS LAST WORD. `-refractors-gold` matched the bare
   * `-gold$` entry and emitted "Gold", dropping the Refractor -- a different
   * rung and a different pool. 19 of the 76 pages were spelled this way.
   */
  it("reads a compound rung whole, in both spellings", () => {
    expect(parallelFromSlug("topps-chrome-refractors-gold")).toBe("Gold Refractor");
    expect(parallelFromSlug("topps-chrome-gold-refractors")).toBe("Gold Refractor");
    expect(parallelFromSlug("topps-chrome-refractors-black")).toBe("Black Refractor");
    expect(parallelFromSlug("topps-chrome-refractors")).toBe("Refractor");
    // and the plain rungs still read as themselves
    expect(parallelFromSlug("some-product-gold")).toBe("Gold");
    expect(parallelFromSlug("2004-05-topps-chrome-printing-plates-cyan")).toBe("Printing Plate Cyan");
  });

  /**
   * AN INSERT IS NOT A PRODUCT EITHER. The non-parallel sibling page
   * ("Cards That Never Were") lands on the SAME parent with parallel BLANK and
   * the insert name as the subset -- never `topps-chrome-cards-that-never-were`.
   */
  it("lands an insert page on the parent with a blank parallel", () => {
    const p = parseSetUrl(CTNW_BASE);
    expect(parallelFromSlug(p.rest)).toBe("");

    const split = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(split.parentSetKey).toBe("topps-chrome");
    expect(split.subset).toBe("Cards That Never Were");

    const { rows } = buildRows(html("2000-01-topps-chrome-cards-that-never-were"), { parallel: "", isAuto: false });
    expect(rows.length).toBe(10);
    expect(rows.every((r: { parallel: string }) => r.parallel === "")).toBe(true);
  });

  it("stamps every row of a rung page with that one rung", () => {
    const { rows } = buildRows(html("2000-01-topps-chrome-aptitude-for-altitude-refractors"), {
      parallel: "Refractor", isAuto: false,
    });
    expect(rows.length).toBe(10);
    expect(new Set(rows.map((r: { parallel: string }) => r.parallel))).toEqual(new Set(["Refractor"]));
    expect(rows[0].cardNumber).toBe("AA1");
    expect(rows[0].player).toBe("Larry Hughes");
  });
});

/**
 * THE GATE. These build the staged file the driver would gate, with and without
 * the fetcher's attestation, so the admission is pinned in BOTH directions --
 * a guard nobody has mutation-checked is a guard nobody has tested.
 */
describe("the zero-base gate admits a rung of a parent, and only that", () => {
  const HEADER = "category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity";
  const rungCsv = (rung: string) =>
    [HEADER, ...["AA1", "AA2", "AA3"].map((n) => `base,${n},${rung},false,,Larry Hughes,,`)].join("\n");

  const stage = (dir: string, name: string, csv: string, manifest: Record<string, unknown> | null) => {
    const fs = require("node:fs");
    const p = join(dir, `${name}.csv`);
    fs.writeFileSync(p, csv);
    if (manifest) fs.writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify(manifest));
    return p;
  };

  const tmp = () => {
    const fs = require("node:fs");
    const os = require("node:os");
    return fs.mkdtempSync(join(os.tmpdir(), "scc-gate-"));
  };

  const MANIFEST = {
    source: "sportscardchecklist", sport: "basketball", year: 2000,
    setKey: "topps-chrome", setKeyRequested: "topps-chrome-aptitude-for-altitude-refractors",
    parallelOfParent: true, parallelName: "Refractor", subset: "Aptitude For Altitude",
  };

  it("the lane is declared as one whose pages may be rung-only", () => {
    expect(LANES_WITH_BASELESS_PRODUCTS.has("sportscardchecklist")).toBe(true);
    // tcgdexja's own admission is untouched by this change.
    expect(LANES_WITH_BASELESS_PRODUCTS.has("tcgdexja")).toBe(true);
  });

  it("admits a single-rung page that attests it is a rung of a parent", () => {
    const dir = tmp();
    const p = stage(dir, "rung", rungCsv("Refractor"), MANIFEST);
    const gate = gateStagedEntry([p], "sportscardchecklist");
    expect(gate.ok).toBe(true);
    expect(gate.stats.base).toBe(0);
    expect(gate.baselessSingleRung).toBe("Refractor");
    expect(gate.parallelOfParent).toBe(true);
  });

  /**
   * MUTATION 1 — DROP THE FLAG. Without the fetcher's attestation the page is
   * an ordinary baseless file again and the zero-base refusal stands. This is
   * what stops the admission from being "sportscardchecklist may stage
   * anything".
   */
  it("MUTATION: drop parallelOfParent -> refused again", () => {
    const dir = tmp();
    const p = stage(dir, "rung", rungCsv("Refractor"), { ...MANIFEST, parallelOfParent: false });
    const gate = gateStagedEntry([p], "sportscardchecklist");
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/zero base cards/);
    // It is still a CONTENT refusal: reaching this verdict proves the host is up.
    expect(gate.contentRefusal).toBe(true);
  });

  it("MUTATION: no manifest at all -> refused", () => {
    const dir = tmp();
    const p = stage(dir, "rung", rungCsv("Refractor"), null);
    expect(gateStagedEntry([p], "sportscardchecklist").ok).toBe(false);
  });

  /**
   * MUTATION 2 — LAND ON ITS OWN KEY. The attestation is only meaningful
   * because the rows land on the PARENT. A manifest that claims
   * `parallelOfParent` while naming the invented display-name key is the
   * phantom-product shape, and the gate must not take its word for it.
   */
  it("MUTATION: parallelOfParent with no parent key -> refused", () => {
    const dir = tmp();
    const p = stage(dir, "rung", rungCsv("Refractor"), { ...MANIFEST, setKey: "" });
    expect(gateStagedEntry([p], "sportscardchecklist").ok).toBe(false);
  });

  /**
   * TWO RUNGS AND NO BASE IS STILL THE CROSS-JOIN the rule was written for, on
   * every lane, flag or no flag. This is the 11.49M-row graveyard shape.
   */
  it("refuses a baseless file carrying two distinct rungs even with the flag", () => {
    const dir = tmp();
    const csv = [
      "category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity",
      "base,AA1,Refractor,false,,Larry Hughes,,",
      "base,AA1,Gold Refractor,false,,Larry Hughes,,",
    ].join("\n");
    const p = stage(dir, "two-rung", csv, MANIFEST);
    const gate = gateStagedEntry([p], "sportscardchecklist");
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/zero base cards/);
  });

  /** A lane NOT declared baseless keeps the old refusal, flag or no flag. */
  it("does not admit a baseless page on an undeclared lane", () => {
    const dir = tmp();
    const p = stage(dir, "rung", rungCsv("Refractor"), MANIFEST);
    expect(gateStagedEntry([p], "bcp").ok).toBe(false);
  });
});

/**
 * CF-A-SUBSET-IS-NOT-IN-THE-IDENTITY. The ruling this fix refuses to guess.
 *
 * Reparenting is right, and it is safe exactly while the card NUMBERS stay
 * distinct -- because the slug has no subset segment. 2000-01 Topps Chrome
 * publishes two subsets that both number MJ1..MJn for the same player, so both
 * would land on one slug and one would silently replace the other.
 */
describe("a subset is not in the identity, so a shared number is a collision", () => {
  it("the two colliding pages are siblings of ONE parent product and rung", () => {
    // Both are Refractor rungs of topps-chrome in the same season, differing
    // only by a subset the identity slug cannot see. That is what makes the
    // collision possible at all.
    for (const url of [CTNW_RUNG, JOHNSON]) {
      const p = parseSetUrl(url);
      const split = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
      expect(p.seasonLabel).toBe("2000-01");
      expect(parallelFromSlug(p.rest)).toBe("Refractor");
      expect(split.parentSetKey).toBe("topps-chrome");
    }
    expect(splitParentAndSubset(parseSetUrl(CTNW_RUNG).rest, parallelTailOf(parseSetUrl(CTNW_RUNG).rest)).subset)
      .toBe("Cards That Never Were");
    expect(splitParentAndSubset(parseSetUrl(JOHNSON).rest, parallelTailOf(parseSetUrl(JOHNSON).rest)).subset)
      .toBe("Johnson Reprints");
  });

  it("two subsets of one product really do share card numbers", () => {
    const a = buildRows(html("2000-01-topps-chrome-cards-that-never-were-refractors"), { parallel: "Refractor", isAuto: false });
    const b = buildRows(html("2000-01-topps-chrome-johnson-reprints-refractors"), { parallel: "Refractor", isAuto: false });

    expect(a.rows.length).toBe(10);
    expect(b.rows.length).toBe(7);

    const numsA = new Set(a.rows.map((r: { cardNumber: string }) => r.cardNumber));
    const shared = b.rows.filter((r: { cardNumber: string }) => numsA.has(r.cardNumber));
    expect(shared.length).toBe(7); // MJ1..MJ7, every row of the smaller page
    expect(a.rows[0].player).toBe("Magic Johnson");
    expect(b.rows[0].player).toBe("Magic Johnson");
  });

  it("and the identity slug cannot tell them apart until the clash is STATED", () => {
    // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
    // 2026-09-04) answers the question this test posed. Carrying the subset is
    // still not enough — it is display data on ~1.48M catalog rows and only 17
    // rungs actually clash — so the slug is unchanged unless the caller states
    // the clash it can SEE. That is `subsetInId`, decided at ingest from the
    // catalog and persisted on the row. Pinned in full in
    // tests/subsetIsPartOfTheIdentity.test.ts.
    const slugOf = (subset: string, extra: Record<string, unknown> = {}) =>
      computeHobbyIqCardId({
        sport: "basketball", year: 2000, setKey: "topps-chrome",
        cardNumber: "MJ1", parallel: "Refractor", isAuto: false, printRun: null,
        subsetName: subset, ...extra,
      });
    // Naming the subset alone still changes nothing — the hazard this test was
    // written to record, and the reason the flag is a separate decision.
    expect(slugOf("Cards That Never Were")).toBe(slugOf("Johnson Reprints"));
    expect(slugOf("Cards That Never Were")).toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
    // With the clash stated, they are two cards with two pools.
    expect(slugOf("Cards That Never Were", { subsetInId: true }))
      .not.toBe(slugOf("Johnson Reprints", { subsetInId: true }));
  });
});

/**
 * THE MANIFEST IS THE CONTRACT. Everything above tests the helpers; this runs
 * the fetcher end to end over the real trimmed page and asserts the file the
 * ingest child actually reads. `setKey` here is used VERBATIM by productOf, so
 * this is the assertion that stands between the lane and 57 phantom products.
 */
describe("the manifest the fetcher writes for a rung page", () => {
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");

  const runFetcher = (fixture: string, url: string, requestedKey: string) => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "scc-manifest-"));
    const out = join(dir, "staged.csv");
    execFileSync(process.execPath, [
      join(__dirname, "..", "scripts", "fetchSportsCardChecklist.cjs"),
      "--html-file", join(FIX, `${fixture}.trimmed.html`),
      "--url", url,
      "--out", out,
      "--year", "2000",
      "--set-key", requestedKey,
      "--set-name", "2000-01 Topps Chrome Basketball",
      "--sport", "basketball",
    ], { encoding: "utf8" });
    return JSON.parse(fs.readFileSync(out.replace(/\.csv$/, ".manifest.json"), "utf8"));
  };

  it("names the PARENT product, not the page's display name", () => {
    const m = runFetcher(
      "2000-01-topps-chrome-aptitude-for-altitude-refractors",
      RUNG,
      "topps-chrome-aptitude-for-altitude-refractors",
    );
    expect(m.setKey).toBe("topps-chrome");
    expect(m.productKey).toBe("2000-topps-chrome");
    // the display-name key is kept, so a wrong split is auditable
    expect(m.setKeyRequested).toBe("topps-chrome-aptitude-for-altitude-refractors");
    expect(m.parallelOfParent).toBe(true);
    expect(m.parallelName).toBe("Refractor");
    expect(m.subset).toBe("Aptitude For Altitude");
  });

  it("names the parent for an INSERT page too, with no parallel claimed", () => {
    const m = runFetcher(
      "2000-01-topps-chrome-cards-that-never-were",
      CTNW_BASE,
      "topps-chrome-cards-that-never-were",
    );
    expect(m.setKey).toBe("topps-chrome");
    expect(m.parallelOfParent).toBe(false);
    expect(m.parallelName).toBeNull();
    expect(m.subset).toBe("Cards That Never Were");
  });
});
