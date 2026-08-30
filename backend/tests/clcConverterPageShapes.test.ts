/**
 * CF-THE-SECTION-IS-THE-PLAIN-SET-VALUE (2026-08-30, D3c).
 *
 * The D3c brief said the converter dropped the Topps flagship base set + foils
 * and the Panini ladders. It never had: the runner's own log converts 2024
 * Topps Series 1 to 20,043 rows and 2025 Donruss to 17,722, and the rows sit
 * in Cosmos at their canonical ids under an earlier checklist label (the
 * coverage lib explains). These fixtures pin what the converter DOES emit for
 * those two page shapes -- base rows and the ladder with print runs -- and the
 * real xlsx-path gaps the diagnosis found on the way: a three-word section
 * with no parallels became a parallel of its own first two words ("Challenge
 * Code", "Topps Baseball", "Recollection Collection", "Image Variation"), a
 * lone auto word stayed as a parallel ("Autographs"), a gold head listed
 * without its plain row lost its Gold ("Vinyl" for Gold Vinyl), Leaf's
 * Base/Auto marker stayed in the finish ("Base Laser Black"), and on the html
 * path "Red #/25 or Less" kept no run at all.
 *
 * Every fixture is a trimmed REAL workbook / page fetched 2026-08-30; every
 * expected name is text in it. 2025 Leaf Vivid is the control the brief named.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conv = require("../scripts/convertChecklistCenterToChecklistCsv.cjs");

const FIX = path.join(__dirname, "fixtures", "clc");
const html = (n: string) => fs.readFileSync(path.join(FIX, n), "utf8");
const rowsJson = (n: string): unknown[][] => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));

type Row = { category: string; parallel: string; isAuto: string; printRun: number | null; player: string; note: string };
const byCard = (rows: string[][], num: string): Row[] =>
  rows.filter((r) => r[1] === num).map((r) => ({ category: r[0], parallel: r[2], isAuto: r[3], printRun: r[4] === "" ? null : Number(r[4]), player: r[5], note: r[6] }));
const runOf = (rows: Row[], parallel: string) => rows.find((r) => r.parallel === parallel)?.printRun;
const names = (rows: Row[]) => rows.map((r) => r.parallel);

const P = (slug: string, year: number) => ({ sourceSlug: slug, year, sport: "baseball" });

describe("2024 Topps Series 1, xlsx (the Topps flagship shape): the base set and its foil ladder", () => {
  const fixture = rowsJson("2024-topps-series-1.rows.json");
  const out = conv.convertXlsx(fixture, P("2024-topps-series-1-baseball-card-checklist", 2024));
  const c33 = byCard(out.rows, "33");

  it("one row per workbook line, nothing multiplied", () => {
    expect(out.rows.length).toBe(fixture.length - 1);
    expect(out.stats.ladderRows).toBe(0);
  });

  it("#33 is Base plus every foil the page lists, with the page's print runs", () => {
    expect(c33.find((r) => r.parallel === "Base" && r.category === "base")).toBeTruthy();
    for (const n of ["Rainbow Foil", "Gold Foil", "Royal Blue", "Aqua", "Yellow", "Holiday", "First Card"]) expect(runOf(c33, n), n).toBeNull();
    expect(runOf(c33, "Gold")).toBe(2024);
    expect(runOf(c33, "Vintage Stock")).toBe(99);
    expect(runOf(c33, "Independence Day")).toBe(76);
    expect(runOf(c33, "Black")).toBe(73);
    expect(runOf(c33, "Blue HoloFoil")).toBe(999);
    expect(runOf(c33, "Memorial Day Camo")).toBe(25);
    expect(runOf(c33, "Platinum")).toBe(1);
    expect(runOf(c33, "Printing Plates Black")).toBe(1);
    expect(c33).toHaveLength(38);
    expect(c33.every((r) => r.category === "base" && r.isAuto === "false")).toBe(true);
  });

  it("a section with no parallels is a section, not a parallel of its first two words", () => {
    expect(byCard(out.rows, "HRC-1")).toEqual([expect.objectContaining({ category: "insert:home-run-challenge-code", parallel: "", isAuto: "false" })]);
    expect(byCard(out.rows, "OTB-24")).toEqual([expect.objectContaining({ category: "insert:oversized-2024-topps-baseball", parallel: "" })]);
    expect(names(out.rows.map((r: string[]) => ({ parallel: r[2] })) as Row[])).not.toContain("Challenge Code");
  });

  it("an auto set nested under a relic set: the plain auto is blank, Red and Platinum keep their runs, isAuto from the type", () => {
    const hsha = byCard(out.rows, "HSHA-BW");
    expect(hsha.every((r) => r.isAuto === "true")).toBe(true);
    expect(hsha.find((r) => r.parallel === "")?.printRun).toBe(25);
    expect(runOf(hsha, "Platinum")).toBe(1);
    expect(names(hsha)).toContain("Red");
    expect(names(hsha).some((n) => /Autographs/.test(n))).toBe(false);
    const cbi = byCard(out.rows, "89BA-CBI");
    expect(cbi.find((r) => r.parallel === "")?.isAuto).toBe("true");
    expect(runOf(cbi, "Black")).toBe(199);
  });
});

describe("2025 Donruss, xlsx (the Panini shape): the ladder on a base card and on a Rated Prospect", () => {
  const fixture = rowsJson("2025-donruss.rows.json");
  const out = conv.convertXlsx(fixture, P("2025-donruss-baseball-card-checklist", 2025));
  const c53 = byCard(out.rows, "53"), c101 = byCard(out.rows, "101");

  it("#53 carries the Panini ladder with the page's print runs; Optic Gold and Gold are two cards", () => {
    expect(c53.find((r) => r.parallel === "Base")).toBeTruthy();
    expect(runOf(c53, "Artist Proof")).toBe(25);
    expect(runOf(c53, "Artist Proof Black")).toBe(1);
    expect(runOf(c53, "Carolina Blue Laser")).toBe(249);
    expect(runOf(c53, "Blue")).toBe(149);
    expect(runOf(c53, "Liberty")).toBeNull();
    expect(runOf(c53, "Gold")).toBe(10);
    expect(runOf(c53, "Optic Gold")).toBe(10);
    expect(runOf(c53, "Optic Black Finite")).toBe(1);
    expect(c53.every((r) => r.category === "base")).toBe(true);
  });

  it("#101: 'Rated Prospects' is the card type, not a parallel -- the bare label is the plain card, the rungs lose the prefix", () => {
    expect(c101.find((r) => r.parallel === "Base")).toBeTruthy();
    expect(runOf(c101, "Artist Proof Black")).toBe(1);
    expect(runOf(c101, "Carolina Blue Laser")).toBe(249);
    expect(runOf(c101, "Optic Gold")).toBe(10);
    expect(names(c101).some((n) => /^Rated Prospects/.test(n))).toBe(false);
    expect(names(c101)).toContain("Optic Signatures");
  });

  it("singletons and unprefixed inserts: no 'Recollection Collection', no 'Kings', no 'Know', no lone 'Autographs'", () => {
    const one = byCard(out.rows, "1");
    expect(one.find((r) => r.category === "insert:1985-donruss-recollection-collection")?.parallel).toBe("");
    expect(one.find((r) => r.category === "insert:diamond-kings")?.parallel).toBe("");
    expect(one.find((r) => r.category === "insert:get-to-know")?.parallel).toBe("");
    expect(one.find((r) => r.category === "insert:next-day-autographs")).toMatchObject({ parallel: "", isAuto: "true" });
    expect(one.some((r) => r.category === "insert:next-day")).toBe(false);
    expect(one.find((r) => r.category === "insert:bomb-squad" && r.parallel === "Blue Ice")?.printRun).toBe(35);
    expect(names(one)).not.toContain("Recollection Collection");
    expect(names(one)).not.toContain("Autographs");
  });
});

describe("2025 Topps Update, xlsx: a variation set listed without 'Base', a dual-auto head, a chrome insert", () => {
  const out = conv.convertXlsx(rowsJson("2025-topps-update.rows.json"), P("2025-topps-update-series-baseball-card-checklist", 2025));

  it("Golden Mirror Image Variation is a Base finish of US193, not a blank row colliding with the base card", () => {
    const us = byCard(out.rows, "US193");
    expect(us.filter((r) => r.parallel === "Base")).toHaveLength(1);
    // D22: the vocabulary's spelling — "Golden Mirror Variation" (image comes
    // off a KNOWN kind; plural to singular) — still a Base finish of US193.
    expect(us.find((r) => r.parallel === "Golden Mirror Variation")?.category).toBe("base");
    expect(names(us)).not.toContain("Image Variation");
    expect(runOf(us, "Diamante Foil")).toBeNull();
    expect(runOf(us, "Black Diamante Foil")).toBe(10);
  });

  it("'Signature Tunes Dual Autographs' heads its ladder; the plain row is blank and auto", () => {
    const tune = byCard(out.rows, "TUNE-OSE");
    expect(tune.every((r) => r.category === "insert:signature-tunes-dual-autographs" && r.isAuto === "true")).toBe(true);
    expect(new Set(names(tune))).toEqual(new Set(["", "Black", "Red", "Gold"]));
    expect(names(tune)).not.toContain("Autographs");
  });

  it("'1990 Topps Baseball Chrome Autographs' is the auto version of the chrome insert, no 'Baseball Chrome' parallel", () => {
    expect(byCard(out.rows, "U90C-1")).toEqual([expect.objectContaining({ category: "insert:1990-topps-baseball-chrome", parallel: "", isAuto: "false" })]);
    expect(byCard(out.rows, "U90CA-AJ")).toEqual([expect.objectContaining({ category: "insert:1990-topps-baseball-chrome", parallel: "", isAuto: "true" })]);
  });
});

describe("2025 Leaf Vivid, xlsx (the control): the counts hold and the finish is the finish", () => {
  const fixture = rowsJson("2025-leaf-vivid.rows.json");
  const out = conv.convertXlsx(fixture, P("2025-leaf-vivid-baseball-card-checklist", 2025));

  it("242 lines in, 242 rows out, 62 distinct rungs, three sections", () => {
    expect(fixture.length - 1).toBe(242);
    expect(out.rows.length).toBe(242);
    expect(out.stats.pars).toBe(62);
    expect(out.stats.sections).toBe(3);
  });

  it("'Base Auto Crystal Black' is the Crystal Black auto of the base set; 'Bursting With Talent Auto Laser Black' is Laser Black, auto; a Colorful Quad is not", () => {
    const ba = byCard(out.rows, "BA-AS2");
    expect(ba.every((r) => r.category === "base" && r.isAuto === "true")).toBe(true);
    expect(runOf(ba, "Crystal Black")).toBe(1);
    expect(runOf(ba, "Prismatic Teal")).toBe(10);
    expect(names(ba).some((n) => /^(Auto|Base) /.test(n))).toBe(false);
    const ta = byCard(out.rows, "TA-AJG");
    expect(ta.every((r) => r.category === "insert:bursting-with-talent" && r.isAuto === "true")).toBe(true);
    expect(runOf(ta, "Laser Black")).toBe(1);
    expect(runOf(ta, "Crystal Teal")).toBe(10);
    expect(names(ta).some((n) => /Talent|^Base |^Auto /.test(n))).toBe(false);
    const cq = byCard(out.rows, "CQ-9");
    expect(cq.every((r) => r.category === "insert:colorful-quads" && r.isAuto === "false")).toBe(true);
    expect(runOf(cq, "Laser Black")).toBe(1);
  });
});

describe("2026 Leaf Metal and 2026 Bowman, xlsx: one-word sets, colour words inside set names, mega autos", () => {
  it("Leaf Metal: 'Tritanium Prismatic White' / 'Tritanium Red Flood' are finishes of Tritanium; '1991 Gold Leaf Prospects' keeps its Gold", () => {
    const out = conv.convertXlsx(rowsJson("2026-leaf-metal.rows.json"), P("2026-leaf-metal-baseball-card-checklist", 2026));
    const t4 = byCard(out.rows, "T-4");
    expect(t4.every((r) => r.category === "insert:tritanium")).toBe(true);
    expect(new Set(names(t4))).toEqual(new Set(["Prismatic White", "Prismatic Gold", "Red Flood", "Super Prismatic Gold"]));
    expect(runOf(t4, "Prismatic White")).toBe(5);
    const aw = byCard(out.rows, "91A-AW1");
    expect(aw.every((r) => r.category === "insert:1991-gold-leaf-prospects" && r.isAuto === "true")).toBe(true);
    expect(runOf(aw, "Prismatic")).toBe(5);
    expect(runOf(aw, "Super Prismatic Gold")).toBe(1);
    expect(names(aw).some((n) => /Gold Leaf|^Auto /.test(n))).toBe(false);
  });

  it("Bowman: the mega auto ladder keeps Chrome + colour + Mojo Refractor, a lone 'Mega Futures Chrome Mojo' keeps Chrome Mojo", () => {
    const out = conv.convertXlsx(rowsJson("2026-bowman.rows.json"), P("2026-bowman-baseball-card-checklist", 2026));
    const eh = byCard(out.rows, "BMA-EH");
    expect(eh.every((r) => r.isAuto === "true")).toBe(true);
    expect(runOf(eh, "Chrome Gold Mojo Refractor")).toBe(50);
    expect(runOf(eh, "Chrome Mojo Refractor")).toBeNull();
    expect(names(eh).some((n) => /Autographs|Prospects/.test(n))).toBe(false);
    expect(byCard(out.rows, "MF-1")).toEqual([expect.objectContaining({ category: "insert:mega-futures", parallel: "Chrome Mojo" })]);
    const bst = byCard(out.rows, "BST-1");
    expect(runOf(bst, "Aqua Refractor")).toBe(125);
    expect(runOf(bst, "Chrome Gold Mojo Refractor")).toBe(50);
  });
});

describe("2022 Panini Prizm Draft Picks, xlsx: a gold head listed without its plain row is a finish", () => {
  it("'Autographs Prizms Gold' /10 and 'Autographs Prizms Gold Vinyl' /1 keep their Gold", () => {
    const out = conv.convertXlsx(rowsJson("2022-panini-prizm-draft-picks.rows.json"), P("2022-panini-prizm-draft-picks-baseball-card-checklist", 2022));
    const one = byCard(out.rows, "1").filter((r) => r.category === "insert:autographs");
    expect(one).toHaveLength(2);
    expect(one.every((r) => r.isAuto === "true")).toBe(true);
    expect(runOf(one, "Prizms Gold")).toBe(10);
    expect(runOf(one, "Prizms Gold Vinyl")).toBe(1);
    expect(names(one)).not.toContain("Vinyl");
    expect(runOf(byCard(out.rows, "1").filter((r) => r.category === "base"), "Prizms Gold Vinyl")).toBe(1);
  });
});

describe("2020 Topps Series 1, html (no workbook): the base set, its legend, and 'or Less'", () => {
  const out = conv.convertHtml(html("2020-topps-series-1.trimmed.html"), P("2020-topps-series-1-baseball-card-checklist", 2020));

  it("the base set's ladder lands on #1 with the page's runs; 'Subset Key: FS=Future Stars' never becomes a rung", () => {
    const one = byCard(out.rows, "1");
    expect(one.find((r) => r.parallel === "Base" && r.category === "base")).toBeTruthy();
    expect(one.find((r) => r.parallel === "Rainbow Foil")?.note).toBe("1:10 Packs");
    expect(runOf(one, "Gold")).toBe(2020);
    expect(runOf(one, "Vintage Stock")).toBe(99);
    expect(runOf(one, "Black")).toBe(69);
    expect(runOf(one, "Platinum")).toBe(1);
    expect(names(out.rows.map((r: string[]) => ({ parallel: r[2] })) as Row[]).some((n) => /=/.test(n))).toBe(false);
  });

  it("'Red #/25 or Less' is Red with a run of 25 (the auto sets)", () => {
    for (const num of ["PPA-AJ", "WCA-FR"]) {
      const rows = byCard(out.rows, num);
      expect(rows.every((r) => r.isAuto === "true"), num).toBe(true);
      expect(runOf(rows, "Red"), num).toBe(25);
      expect(runOf(rows, "Platinum"), num).toBe(1);
      expect(names(rows), num).not.toContain("Red #/25");
    }
  });

  it("Turkey Red keeps its bare colours under a plain label; Chrome Turkey Red gets the Refractor family", () => {
    const tr = byCard(out.rows, "TR-1"), trc = byCard(out.rows, "TRC-1");
    expect(runOf(tr, "Green")).toBe(10);
    expect(runOf(tr, "Blue")).toBe(50);
    expect(runOf(trc, "Green Refractor")).toBe(10);
    expect(runOf(trc, "SuperFractor")).toBe(1);
  });

  it("declares the expansion: sections, laddersFound, ladderRows", () => {
    const cards = new Set(out.rows.map((r: string[]) => `${r[0]}|${r[1]}`)).size;
    expect(out.stats.sections).toBe(5);
    expect(out.stats.laddersFound).toBe(5);
    expect(out.stats.ladderRows).toBe(out.rows.length - cards);
  });
});

describe("the small rules behind the shapes", () => {
  it("clean: 'or Less' comes off before the run is read", () => {
    expect(conv.clean("Red #/25 or Less")).toMatchObject({ name: "Red", printRun: 25 });
    expect(conv.clean("Red #/99 or Less")).toMatchObject({ name: "Red", printRun: 99 });
  });

  it("sectionsOf: the plain Set value heads its section; a lone value is its own; Base owns every 'Base ...'", () => {
    const s: Map<string, { section: string; finish: string }> = conv.sectionsOf([
      "Base", "Base Gold", "Base Rated Prospects Artist Proof Black", "Bomb Squad", "Bomb Squad Blue Ice", "Home Run Challenge Code",
      "Stars of MLB", "Stars of MLB Chrome", "Stars of MLB Chrome Black", "Signature Tunes Dual Autographs", "Signature Tunes Dual Autographs Red",
      "Autographs Prizms Gold", "Autographs Prizms Gold Vinyl", "Black Gold", "Black Gold Pink Foil", "Black Gold Blue Foil",
      "Tritanium Prismatic White", "Tritanium Prismatic Gold", "Tritanium Red Flood", "Mega Futures Chrome Mojo", "1991 Gold Leaf Prospects Auto Prismatic", "1991 Gold Leaf Prospects Base Prismatic",
    ]);
    expect(s.get("Base Gold")).toEqual({ section: "Base", finish: "Gold" });
    expect(s.get("Base Rated Prospects Artist Proof Black")).toEqual({ section: "Base", finish: "Rated Prospects Artist Proof Black" });
    expect(s.get("Bomb Squad Blue Ice")).toEqual({ section: "Bomb Squad", finish: "Blue Ice" });
    expect(s.get("Home Run Challenge Code")).toEqual({ section: "Home Run Challenge Code", finish: "" });
    expect(s.get("Stars of MLB Chrome Black")).toEqual({ section: "Stars of MLB", finish: "Chrome Black" });
    expect(s.get("Signature Tunes Dual Autographs")).toEqual({ section: "Signature Tunes Dual Autographs", finish: "" });
    expect(s.get("Autographs Prizms Gold")).toEqual({ section: "Autographs", finish: "Prizms Gold" });
    expect(s.get("Black Gold Pink Foil")).toEqual({ section: "Black Gold", finish: "Pink Foil" });
    expect(s.get("Tritanium Prismatic White")).toEqual({ section: "Tritanium", finish: "Prismatic White" });
    expect(s.get("Tritanium Red Flood")).toEqual({ section: "Tritanium", finish: "Red Flood" });
    expect(s.get("Mega Futures Chrome Mojo")).toEqual({ section: "Mega Futures", finish: "Chrome Mojo" });
    expect(s.get("1991 Gold Leaf Prospects Auto Prismatic")).toEqual({ section: "1991 Gold Leaf Prospects", finish: "Auto Prismatic" });
  });

  it("sectionsOf: a lone '... Variation(s)' whose numbers are base numbers is a Base finish", () => {
    const nums = (sv: string) => (sv === "Base" ? ["1", "2", "3"] : sv === "Image Variations" ? ["2", "3"] : ["CA-1"]);
    const s: Map<string, { section: string; finish: string }> = conv.sectionsOf(["Base", "Base Refractor", "Image Variations", "Coming Attractions"], nums);
    // D22: the finish is the vocabulary's singular; the entry also carries the
    // per-number anchor map (every number here is a base number).
    expect(s.get("Image Variations")).toMatchObject({ section: "Base", finish: "Image Variation" });
    expect(s.get("Image Variations")!.anchorByNum.get("2")).toEqual({ section: "Base", finish: "Image Variation" });
    expect(s.get("Coming Attractions")).toEqual({ section: "Coming Attractions", finish: "" });
  });
});
