/**
 * CF-CHECKLIST-VARIATION-IS-A-PARALLEL (Drew, 2026-08-25).
 *
 * A checklist "variation" is a RUNG on a card that already exists, not a new
 * card. convertBeckettChecklistXlsx.cjs used to file every section as its own
 * category and stamp parallel="Base" on all 1197 rows of 2026 Bowman Chrome, so
 * a Packfractor of BCP-151 became a card standing beside BCP-151 instead of a
 * finish of it — and the ingester then rebuilt a parallel label out of the
 * category slug, yielding names like "Chrome Prospect Packfractor Autographs".
 *
 * The classification is made from CARD NUMBERS, never from the sheet name:
 * Beckett files WBC Flag Variations and Retrofractors on the same 'Variations'
 * sheet as the Packfractors, and those two are their own cards on their own
 * numbering runs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conv = require("../scripts/convertBeckettChecklistXlsx.cjs");

const SCRIPT = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");

type Row = (string | number)[];

/** Build the section descriptor classifySections() consumes. */
function section(sheet: string, name: string, numbers: string[]) {
  return {
    sheet,
    section: name,
    key: `${sheet}>${name}`,
    category: conv.categoryFor(sheet, name),
    numbers: new Set(numbers.map((n) => n.toUpperCase())),
    cards: numbers.length,
  };
}

function classify(secs: ReturnType<typeof section>[]) {
  const map = new Map(secs.map((s) => [s.key, s]));
  const report = conv.classifySections(map);
  return { map, report, roleOf: (key: string) => report.find((r: any) => `${r.sheet}>${r.section}` === key) };
}

describe("classifySections — a variation is a rung, not a card", () => {
  it("folds a section whose card numbers all already exist in an anchor", () => {
    const anchor = section("Prospects", "Chrome Prospects", ["BCP-1", "BCP-2", "BCP-3"]);
    const pack = section("Variations", "Packfractors", ["BCP-1", "BCP-2", "BCP-3"]);
    const { map, roleOf } = classify([anchor, pack]);

    expect(roleOf("Variations>Packfractors").role).toBe("parallel");
    expect(map.get("Variations>Packfractors")!.parallelOf).toBe(anchor);
    // The rung is what the section ADDS to its anchor, singularised, and
    // spelled the way the verified 2026 ladder spells it.
    expect(map.get("Variations>Packfractors")!.rung).toBe("PackFractor");
  });

  it("leaves a section on its own numbering run as its own cards", () => {
    const anchor = section("Base", "Base Set", ["1", "2", "3"]);
    const wbc = section("Variations", "WBC Flag Variations", ["WBC-1", "WBC-2"]);
    const { map, roleOf } = classify([anchor, wbc]);

    expect(roleOf("Variations>WBC Flag Variations").role).toBe("own-cards");
    expect(map.get("Variations>WBC Flag Variations")!.parallelOf).toBeUndefined();
  });

  it("classifies on card numbers, not on the sheet name", () => {
    // Both of these sit on the 'Variations' sheet. Only one is a parallel.
    const anchor = section("Base", "Base Set", ["1", "2"]);
    const redRc = section("Variations", "Red RC Variations", ["1", "2"]);
    const retro = section("Variations", "Retrofractors", ["BCP-251"]);
    const { roleOf } = classify([anchor, redRc, retro]);

    expect(roleOf("Variations>Red RC Variations").role).toBe("parallel");
    expect(roleOf("Variations>Retrofractors").role).toBe("own-cards");
  });

  it("refuses to guess on a partially-overlapping section", () => {
    // Two of three numbers match. Folding would invent a rung for a card that
    // is not on the anchor; not folding is the safe half of the guess, but it
    // must be reported rather than silently chosen.
    const anchor = section("Autographs", "Chrome Rookie Autographs", ["CRA-A", "CRA-B"]);
    const riv = section("Autographs", "Rookie Image Variation Autographs", ["CRA-A", "CRA-B", "CRA-Z"]);
    const { map, roleOf } = classify([anchor, riv]);

    const r = roleOf("Autographs>Rookie Image Variation Autographs");
    expect(r.role).toBe("own-cards-AMBIGUOUS");
    expect(r.overlapPct).toBeCloseTo(66.7, 1);
    expect(map.get("Autographs>Rookie Image Variation Autographs")!.parallelOf).toBeUndefined();
  });

  it("never folds a non-auto section onto an autographed anchor", () => {
    // Same numbers, different auto class — an insert cannot be a rung on an
    // autographed card however well the numbers line up.
    const autoAnchor = section("Autographs", "Chrome Prospect Autographs", ["X-1", "X-2"]);
    const insert = section("Inserts", "Big Break", ["X-1", "X-2"]);
    const { roleOf } = classify([autoAnchor, insert]);

    expect(roleOf("Inserts>Big Break").role).toBe("own-cards");
  });
});

describe("a variation listed on the Base sheet (Mega Box shape)", () => {
  // Mega Box files image variations INSIDE the Base and Autographs sheets:
  //   Base > Mega Chrome Base Cards - Image Variations
  //   Autographs > Prospect Mega Autographs - Image Variations
  // If those came back as category "base"/"auto-...-image-variations" they
  // would be treated as anchors in their own right and collide with the cards
  // they vary — same number, same player — losing 10 rows to the dedup.
  it("is never an anchor, and folds onto the base card it varies", () => {
    const anchor = section("Base", "Mega Chrome Base Cards", ["1", "2"]);
    const iv = section("Base", "Mega Chrome Base Cards - Image Variations", ["1", "2"]);
    expect(iv.category).toBe("insert-mega-chrome-base-cards-image-variations");

    const { map, roleOf } = classify([anchor, iv]);
    expect(roleOf("Base>Mega Chrome Base Cards - Image Variations").role).toBe("parallel");
    expect(map.get("Base>Mega Chrome Base Cards - Image Variations")!.rung).toBe("Image Variation");
  });

  it("keeps the sheet's auto-ness so an autographed variation can fold", () => {
    const anchor = section("Autographs", "Prospect Mega Autographs", ["PMA-A", "PMA-B"]);
    const iv = section("Autographs", "Prospect Mega Autographs - Image Variations", ["PMA-A"]);
    // Not "insert-", or it could never be compared against an autographed anchor.
    expect(iv.category.startsWith("auto-")).toBe(true);

    const { map, roleOf } = classify([anchor, iv]);
    expect(roleOf("Autographs>Prospect Mega Autographs - Image Variations").role).toBe("parallel");
    expect(map.get("Autographs>Prospect Mega Autographs - Image Variations")!.parallelOf).toBe(anchor);
    expect(map.get("Autographs>Prospect Mega Autographs - Image Variations")!.rung).toBe("Image Variation");
  });
});

describe("rungName — the rung is what the section adds to its anchor", () => {
  it("subtracts the anchor's own words rather than storing the whole title", () => {
    expect(conv.rungName("Chrome Prospect Packfractor Autographs", "Chrome Prospect Autographs"))
      .toBe("PackFractor");
    expect(conv.rungName("Chrome Prospect International Refractor Autographs", "Chrome Prospect Autographs"))
      .toBe("International Refractor");
  });

  it("canonicalises to the spelling the verified 2026 ladder uses", () => {
    // parallelLadders.ts: { name: "Gold Ink Variation", slug: "gold-ink-variation" }
    expect(conv.rungName("Chrome Prospect Autographs - Gold Ink", "Chrome Prospect Autographs"))
      .toBe("Gold Ink Variation");
  });

  it("singularises Beckett's plural section titles", () => {
    expect(conv.rungName("International Refractors", "Chrome Prospects")).toBe("International Refractor");
    expect(conv.rungName("Red RC Variations", "Base Set")).toBe("Red RC Variation");
    expect(conv.rungName("Base - Rookie Image Variations", "Base Set")).toBe("Rookie Image Variation");
  });
});

describe("converter end-to-end", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-"));

  function run(sheets: Record<string, Row[]>) {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
    }
    const xlsxPath = path.join(tmp, `${Math.abs(hash(JSON.stringify(sheets)))}.xlsx`);
    const outPath = xlsxPath.replace(/\.xlsx$/, ".csv");
    XLSX.writeFile(wb, xlsxPath);
    execFileSync(process.execPath, [
      SCRIPT, "--xlsx", xlsxPath, "--year", "2026", "--set-key", "bowman-chrome",
      "--set-name", "2026 Bowman Chrome", "--out", outPath, "--source-url", "test",
    ], { encoding: "utf8" });
    const csv = fs.readFileSync(outPath, "utf8").trim().split("\n");
    const manifest = JSON.parse(fs.readFileSync(outPath.replace(/\.csv$/, ".manifest.json"), "utf8"));
    return {
      manifest,
      rows: csv.slice(1).map((l) => {
        const f = l.split(",");
        return { category: f[0], cardNumber: f[1], parallel: f[2], isAuto: f[3], printRun: f[4], player: f[5] };
      }),
    };
  }

  const SHEETS: Record<string, Row[]> = {
    Base: [["Base Set"], ["2 cards"], ["1", "Konnor Griffin,", "Pirates", "RC"], ["2", "Mookie Betts,", "Dodgers"]],
    Prospects: [["Chrome Prospects"], ["2 cards"], ["BCP-151", "Slater de Brun,", "Marlins"], ["BCP-152", "Ethan Holliday,", "Rockies"]],
    Variations: [
      ["Packfractors"], ["2 cards"], ["BCP-151", "Slater de Brun,", "Marlins"], ["BCP-152", "Ethan Holliday,", "Rockies"],
      ["WBC Flag Variations"], ["1 cards"], ["WBC-1", "Maikel Garcia,", "Royals"],
    ],
    Autographs: [
      ["Chrome Prospect Autographs"], ["2 cards"], ["CPA-SB", "Slater de Brun,", "Marlins"], ["CPA-EH", "Ethan Holliday,", "Rockies"],
      ["Chrome Prospect Autographs - Gold Ink"], ["1 cards"], ["CPA-SB", "Slater de Brun,", "Marlins"],
    ],
  };

  it("files a variation as a parallel ON the anchor card, keeping both rows", () => {
    const { rows } = run(SHEETS);
    const bcp151 = rows.filter((r) => r.cardNumber === "BCP-151");
    expect(bcp151).toHaveLength(2);
    // Same card, same category — the rung is the only thing separating them.
    expect(new Set(bcp151.map((r) => r.category))).toEqual(new Set(["base"]));
    expect(bcp151.map((r) => r.parallel).sort()).toEqual(["", "PackFractor"]);
  });

  it("keeps the autographed rung on the autographed anchor", () => {
    const { rows } = run(SHEETS);
    const cpaSb = rows.filter((r) => r.cardNumber === "CPA-SB");
    expect(cpaSb).toHaveLength(2);
    expect(cpaSb.every((r) => r.isAuto === "true")).toBe(true);
    expect(cpaSb.map((r) => r.parallel).sort()).toEqual(["", "Gold Ink Variation"]);
  });

  it("never asserts parallel=Base, and never guesses a print run", () => {
    const { rows } = run(SHEETS);
    expect(rows.filter((r) => /^base$/i.test(r.parallel))).toHaveLength(0);
    expect(rows.every((r) => r.printRun === "")).toBe(true);
    // Exactly the three folded rows carry a finish; every other row leaves it
    // blank, because a card list never stated one.
    expect(rows.filter((r) => r.parallel !== "").map((r) => r.parallel).sort())
      .toEqual(["Gold Ink Variation", "PackFractor", "PackFractor"]);
    expect(rows.filter((r) => r.parallel === "")).toHaveLength(7);
  });

  it("leaves a section on its own numbering run alone", () => {
    const { rows, manifest } = run(SHEETS);
    const wbc = rows.filter((r) => r.cardNumber === "WBC-1");
    expect(wbc).toHaveLength(1);
    expect(wbc[0].category).toBe("insert-wbc-flag-variations");
    expect(wbc[0].parallel).toBe("");
    expect(manifest.parallelColumnAuthoritative).toBe(true);
  });

  it("the folded rows survive dedup — the rung is part of the identity", () => {
    const { rows } = run(SHEETS);
    // 2 base + 2 prospects + 2 packfractor + 1 wbc + 2 cpa + 1 gold ink
    expect(rows).toHaveLength(10);
    const keys = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto, r.player].join("|"));
    expect(new Set(keys).size).toBe(rows.length);
  });
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
