// CF-A-VARIATION-IS-A-CARD (D22, Drew 2026-08-30) — every checklist path that
// sees a variation section emits that finish, never Base and never blank.
//
// Measured before (29 real checklistcenter pages, the converter as of D3c):
// 101 variation (section|finish) keys, 30 emitted BLANK under an
// "insert:image-variations"-style category — the plain card's own id — and
// the rest plural / "Variations"-only / "Super Short Prints". Every fixture
// here is a trimmed REAL page fetched 2026-08-30; every expected name is text
// in it, spelled the vocabulary's way.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { variationFinishOfSection as tsFinish, normalizeVariationSlug as tsSlug } from "../src/services/catalog/variationVocabulary.js";
import { normalizeParallel } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conv = require("../scripts/convertChecklistCenterToChecklistCsv.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mirror = require("../scripts/lib/variationSections.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const beckett = require("../scripts/convertBeckettChecklistXlsx.cjs");

const FIX = path.join(__dirname, "fixtures", "clc");
const html = (n: string) => fs.readFileSync(path.join(FIX, n), "utf8");
const rowsJson = (n: string): unknown[][] => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));
type Row = { category: string; parallel: string; isAuto: string; printRun: number | null; player: string };
const byCard = (rows: string[][], num: string): Row[] =>
  rows.filter((r) => r[1] === num).map((r) => ({ category: r[0], parallel: r[2], isAuto: r[3], printRun: r[4] === "" ? null : Number(r[4]), player: r[5] }));
const names = (rows: Row[]) => rows.map((r) => r.parallel);
const P = (slug: string, year: number) => ({ sourceSlug: slug, year, sport: "baseball" });

describe("the converters' CJS mirror cannot drift from the TS vocabulary", () => {
  const sections = [
    "Image Variations", "Base Image Variations SuperFractor", "Base Image Variations Gold Speckle", "Golden Mirror Image Variations",
    "2020 Bowman Draft - Base Image Variation Set", "Base SP Variation Set", "Base Super Short Print Variation", "Super Short Prints",
    "Variations", "Chrome Prospects Prospector's Special Die-Cut Variation", "Rookie Image Variations", "Base True Photo Variations",
    "Base WBC Flag Variation Green Refractor", "Award Winners Variations", "Base FrozenFractor Variation", "Short Prints", "Gold Refractor", "Base",
  ];
  it("variationFinishOfSection agrees on every real section text", () => {
    for (const s of sections) expect(mirror.variationFinishOfSection(s), s).toBe(tsFinish(s));
    expect(mirror.variationFinishOfSection("Etched in Glass Variations", "Etched in Glass")).toBe(tsFinish("Etched in Glass Variations", "Etched in Glass"));
  });
  it("normalizeVariationSlug agrees on every catalog spelling", () => {
    for (const s of ["image-variations", "golden-mirror-image-variation-short-print", "ssp", "sp-chrome", "rookie-image-variations", "chrome-image-variation", "sp", "gold"]) {
      expect(mirror.normalizeVariationSlug(s), s).toBe(tsSlug(s));
    }
  });
});

describe("checklistcenter xlsx: 2024 Topps Chrome — 'Base Image Variations' and its speckles are finishes of the base card", () => {
  const out = conv.convertXlsx(rowsJson("2024-topps-chrome.rows.json"), P("2024-topps-chrome-baseball-card-checklist", 2024));
  const c1 = byCard(out.rows, "1");
  it("every variation row sits on the base card, named, never blank", () => {
    expect(c1.every((r) => r.category === "base")).toBe(true);
    for (const n of ["Image Variation", "Image Variation SuperFractor", "Image Variation Gold Speckle", "Image Variation Green Speckle", "Image Variation Red Speckle", "Lightboard Logo Variation", "FrozenFractor Variation"]) {
      expect(names(c1), n).toContain(n);
    }
    expect(names(c1)).toContain("Base");
    expect(names(c1).filter((n) => n === "")).toEqual([]);
    expect(out.rows.some((r: string[]) => /^insert:.*variation/.test(r[0]))).toBe(false);
  });
  it("the slug layer files them beside the base card under the same number — no refractor on a bare variation", () => {
    expect(normalizeParallel("Image Variation")).toBe("image-variation");
    expect(normalizeParallel("Image Variation Gold Speckle")).toBe("image-variation-gold-speckle");
    expect(normalizeParallel("Lightboard Logo Variation")).toBe("lightboard-logo-variation");
  });
});

describe("checklistcenter xlsx: 2023 Topps Series 1 'Base Clear Variation' and 2024 Heritage's named kinds", () => {
  it("Clear Variation is a base finish, singular", () => {
    const out = conv.convertXlsx(rowsJson("2023-topps-series-1.rows.json"), P("2023-topps-series-1-baseball-card-checklist", 2023));
    const c1 = byCard(out.rows, "1");
    expect(c1.map((r) => r.category)).toEqual(["base", "base"]);
    expect(names(c1)).toEqual(["Base", "Clear Variation"]);
  });
  it("Heritage: Color Swap Variation and Image Variation are finishes of the base card", () => {
    const out = conv.convertXlsx(rowsJson("2024-topps-heritage.rows.json"), P("2024-topps-heritage-baseball-card-checklist", 2024));
    const rows = out.rows as string[][];
    expect(rows.every((r) => r[0] === "base")).toBe(true);
    expect(rows.map((r) => r[2]).sort()).toEqual(["Base", "Color Swap Variation", "Image Variation"]);
  });
});

describe("checklistcenter html: 2020 Bowman Draft — 'Base Image Variation Set' is the base set's variation (the Witt card)", () => {
  const out = conv.convertHtml(html("2020-bowman-draft.trimmed.html"), P("2020-bowman-draft-baseball-card-checklist", 2020));
  it("BD-152 carries Image Variation (and its auto) under the base category — not a blank row on the plain card's id", () => {
    const witt = byCard(out.rows, "BD-152");
    expect(witt.length).toBeGreaterThan(0);
    expect(witt.every((r) => r.category === "base")).toBe(true);
    expect(names(witt)).toContain("Image Variation");
    // the page's "Base Image Variation Auto Set" lists other numbers; its rows are the auto variation
    expect(out.rows.some((r: string[]) => r[0] === "base" && r[2] === "Image Variation" && r[3] === "true")).toBe(true);
    // the plain card is there too, under base — and no blank row anywhere
    expect(names(witt)).toContain("Base");
    expect(witt.some((r) => r.parallel === "")).toBe(false);
    expect(out.rows.some((r: string[]) => /^insert:base-image-variation/.test(r[0]))).toBe(false);
  });
});

describe("checklistcenter html: 2023 Stadium Club — SP Variation, Image Variation, 1991 Design, Rookie Design", () => {
  const out = conv.convertHtml(html("2023-topps-stadium-club.trimmed.html"), P("2023-topps-stadium-club-baseball-card-checklist", 2023));
  it("every variation subset is a finish of the base card; 'SP Variation' is the plain image variation", () => {
    const all = out.rows as string[][];
    expect(all.every((r) => r[0] === "base")).toBe(true);
    const finishes = new Set(all.map((r) => r[2]));
    expect(finishes.has("Image Variation")).toBe(true);
    expect(finishes.has("1991 Design Variation")).toBe(true);
    expect([...finishes].some((f) => /^SP Variation/.test(f))).toBe(false);
    expect(finishes.has("")).toBe(false);
  });
});

describe("beckett / checklistinsider: classifySections folds a variation onto its anchor and the rung speaks the vocabulary", () => {
  const sec = (sheet: string, section: string, category: string, numbers: string[]) =>
    ({ key: `${sheet}>${section}`, sheet, section, category, numbers: new Set(numbers), cards: numbers.length });
  it("'Base - Image Variations' is the Image Variation rung of Base; 'SP Variations' / 'SSP Variations' the two tiers", () => {
    const sections = new Map<string, ReturnType<typeof sec>>();
    for (const s of [
      sec("Base", "Base", "base", ["1", "2", "3", "4"]),
      sec("Base", "Base - Image Variations", beckett.categoryFor("Base", "Base - Image Variations"), ["1", "2"]),
      sec("Variations", "SP Variations", beckett.categoryFor("Variations", "SP Variations"), ["1", "3"]),
      sec("Variations", "SSP Variations", beckett.categoryFor("Variations", "SSP Variations"), ["2"]),
    ]) sections.set(s.key, s);
    const report = beckett.classifySections(sections) as Array<{ section: string; role: string; rung?: string }>;
    const rung = (name: string) => report.find((r) => r.section === name)?.rung;
    expect(report.find((r) => r.section === "Base - Image Variations")?.role).toBe("parallel");
    expect(rung("Base - Image Variations")).toBe("Image Variation");
    expect(rung("SP Variations")).toBe("SP Variation");
    expect(rung("SSP Variations")).toBe("SSP Variation");
    expect(normalizeParallel("Image Variation")).toBe("image-variation");
    expect(normalizeParallel("SP Variation")).toBe("image-variation");
    expect(normalizeParallel("SSP Variation")).toBe("image-variation-ssp");
  });
});

describe("baseballcardpedia: a variation heading varies the base set", () => {
  it("the scrape reads a 'Variations' heading as a base-category section with the finish (source-level pin)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scrape-baseballcardpedia.cjs"), "utf8");
    expect(src).toMatch(/const variationFinish = variationFinishOfSection\(leaf\);/);
    expect(src).toMatch(/parallel: variationFinish \?\? "Base"/);
    expect(mirror.variationFinishOfSection("Image Variations")).toBe("Image Variation");
    expect(mirror.variationFinishOfSection("SP Variations")).toBe("Image Variation");
  });
});
