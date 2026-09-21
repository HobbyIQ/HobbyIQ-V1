/**
 * Bowman-family baseball checklist-gap acquisition (2026-09-21, revised
 * same day after independent review). Follows the pattern in
 * upperDeckHockeySeries2ExtendedPlannerVerdict.test.ts and
 * toppsSeries1BaseballLaddersMatchTheirCommittedPlannerVerdict.test.ts: pins
 * the sanctioned ingester's OWN planStagedDirectory verdict for each package
 * this PR ships, measured with nothing but what THIS branch provides. Also
 * pins a NO-EXACT-DUPLICATE-ROWS invariant per package, added after review
 * found 288 byte-identical duplicate rows in an earlier version of the
 * mega-box CSV (the checklistinsider nested-list/xlsx-repeat bug: 20 of the
 * mega box's 100 base card numbers are listed twice in the source workbook).
 *
 * Review findings fixed in this revision:
 *   - Mega Box Mojo ladder was restricted to source-verbatim card scope
 *     (108 BST-/ES-/MF-/BMA-/RMA-/CRA-/CPA- rows deduped out; the true base
 *     roster is 100 cards -- 50 numeric + 50 BCP- -- not 268) and its BMA-/
 *     RMA-/BST-/ES- insert subsets moved to their own package with correct
 *     isAuto flags (BMA-/RMA- = true, BST-/ES- = false); CPA-/CRA-/MF- have
 *     no stated ladder on the source page and are staged nowhere.
 *   - Reptilian ladder was rebuilt from a fresh, direct read of the source
 *     page rather than copied from card_catalog's own (apparently partly
 *     wrong) existing Reptilian Black Refractor rows -- the source states
 *     Gold/Fuchsia/Blue/Red/Orange/Green, never Black.
 *   - The combined two-CSV package directory was split into two single-CSV
 *     directories per review instruction #4.
 *   - Draft Sapphire ladder was rebuilt to use card_catalog's own MAJORITY
 *     spelling per rung (e.g. "Gold Sapphire Refractor", not the source
 *     page's bare "Gold Sapphire") rather than adding a second spelling.
 *
 * Re-review (2026-09-21, same day) found that MAJORITY fix itself was wrong:
 * every 2025 Bowman Draft Sapphire SALE (1,359 of them, measured directly
 * against sold_comps under the hiq:baseball:2025:bowman-draft: prefix) uses
 * the BARE slug form (yellow-sapphire, gold-sapphire, ...) and NONE use
 * '-sapphire-refractor' -- that slug shape belongs to the different product
 * bowman-chrome-sapphire. The source page also states every rung bare. The
 * Draft Sapphire ladder was re-rebuilt a second time to use the bare form
 * throughout, matching both the source and the sale side; the catalog's
 * pre-existing '...Refractor'-suffixed bowman-draft rows are a fork the
 * ingest matcher should fold toward bare, flagged in the manifest, not
 * touched by this package. A stated "Blue Sapphire" rung was also checked
 * for (69 blue-sapphire sales exist) and confirmed absent from the source
 * page entirely -- not minted, left as a reported gap.
 *
 * All setKeys (bowman-mega, bowman-draft, bowman, bowman-chrome) were
 * already registered in productSetKeys.ts before this PR -- no
 * registrations made here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const plans = INGEST.planStagedDirectory(dir, files);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

/** Fails if the CSV (header excluded) contains any two byte-identical data
 *  rows -- the exact defect a prior version of the mega-box package had. */
function expectNoExactDuplicateRows(dir: string, file: string) {
  const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
  const dataRows = lines.slice(1);
  const seen = new Map<string, number>();
  for (const row of dataRows) seen.set(row, (seen.get(row) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  expect(dupes, `exact-duplicate rows found in ${file}: ${JSON.stringify(dupes.slice(0, 5))}`).toEqual([]);
}

describe("2026 Bowman Mega Box Baseball base Mojo ladder — PASS, 100-card scope only", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-mojo-ladder-2026");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2026);
    expect(entry.product.setKey).toBe("bowman-mega");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(1504);
  });

  it("has no exact-duplicate rows and no BST-/ES-/MF-/BMA-/RMA-/CRA-/CPA- rows", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-mojo-ladder-2026");
    expectNoExactDuplicateRows(dir, file);
    const csv = readFileSync(join(dir, file), "utf8");
    for (const prefix of ["BST-", "ES-", "MF-", "BMA-", "RMA-", "CRA-", "CPA-"]) {
      expect(csv.includes(`,${prefix}`), `${prefix} rows must not be in the base-ladder package`).toBe(false);
    }
  });

  it("restricts cardNumber to exactly the source's 100-card base roster (50 numeric + 50 BCP-)", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-mojo-ladder-2026");
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").slice(1);
    const numbers = new Set(lines.map((l) => l.split(",")[1]));
    expect(numbers.size).toBe(100);
    const bcpCount = [...numbers].filter((n) => n.toUpperCase().startsWith("BCP-")).length;
    const numericCount = [...numbers].filter((n) => /^[0-9]+$/.test(n)).length;
    expect(bcpCount).toBe(50);
    expect(numericCount).toBe(50);
  });
});

describe("2026 Bowman Mega Box Baseball insert subsets (BMA-/RMA-/BST-/ES-) — PASS", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-insert-ladders-2026");
    expect(entry.product.setKey).toBe("bowman-mega");
    expect(entry.product.year).toBe(2026);
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(857);
  });

  it("has no exact-duplicate rows and correct isAuto flags per subset", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-insert-ladders-2026");
    expectNoExactDuplicateRows(dir, file);
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const [category, cardNumber, , isAuto] = line.split(",");
      const prefix = cardNumber.toUpperCase().slice(0, cardNumber.indexOf("-") + 1);
      if (prefix === "BMA-" || prefix === "RMA-") {
        expect(isAuto, `${cardNumber} (${category}) must be isAuto=true`).toBe("true");
      } else if (prefix === "BST-" || prefix === "ES-") {
        expect(isAuto, `${cardNumber} (${category}) must be isAuto=false`).toBe("false");
      } else {
        throw new Error(`unexpected cardNumber prefix in insert-ladders package: ${cardNumber}`);
      }
    }
  });
});

describe("2025 Bowman Draft Sapphire Baseball ladder — PASS, bare spelling matching source + sale slugs", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-draft-sapphire-ladder-2025");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2025);
    expect(entry.product.setKey).toBe("bowman-draft");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(1410);
  });

  it("has no exact-duplicate rows and uses the BARE spelling (no '...Refractor' suffix) for every Sapphire rung, matching the sale-side slugs", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-draft-sapphire-ladder-2025");
    expectNoExactDuplicateRows(dir, file);
    const csv = readFileSync(join(dir, file), "utf8");
    expect(csv.includes(",Yellow Sapphire,")).toBe(true);
    expect(csv.includes(",Gold Sapphire,")).toBe(true);
    expect(csv.includes(",Orange Sapphire,")).toBe(true);
    expect(csv.includes(",Black Sapphire,")).toBe(true);
    expect(csv.includes(",Red Sapphire,")).toBe(true);
    expect(csv.includes(",Green Sapphire,")).toBe(true);
    // no '...Sapphire Refractor' spelling anywhere -- that slug shape belongs
    // to the different product bowman-chrome-sapphire, and zero live sales
    // under the bowman-draft prefix use it.
    expect(/Sapphire Refractor/.test(csv)).toBe(false);
  });

  it("does not mint a Blue Sapphire rung — the source page states none, despite 69 blue-sapphire sales existing", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-draft-sapphire-ladder-2025");
    const csv = readFileSync(join(dir, file), "utf8");
    expect(/Blue Sapphire/i.test(csv)).toBe(false);
  });
});

describe("2026 Bowman Baseball BP- Border/Pattern ladder — PASS (own package dir)", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-baseball-border-ladder-2026");
    expect(entry.product.setKey).toBe("bowman");
    expect(entry.product.year).toBe(2026);
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(2161);
  });

  it("has no exact-duplicate rows", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-baseball-border-ladder-2026");
    expectNoExactDuplicateRows(dir, file);
  });
});

describe("2026 Bowman Chrome Baseball BCP- Reptilian ladder — PASS (own package dir, no Black rung)", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-chrome-reptilian-ladder-2026");
    expect(entry.product.setKey).toBe("bowman-chrome");
    expect(entry.product.year).toBe(2026);
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(716);
  });

  it("has no exact-duplicate rows, includes Fuchsia, and never mints Reptilian Black Refractor", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-chrome-reptilian-ladder-2026");
    expectNoExactDuplicateRows(dir, file);
    const csv = readFileSync(join(dir, file), "utf8");
    expect(csv.includes("Reptilian Fuchsia Refractor")).toBe(true);
    expect(csv.includes("Reptilian Black Refractor")).toBe(false);
  });
});
