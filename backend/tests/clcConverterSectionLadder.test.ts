/**
 * CF-THE-LABEL-IS-PART-OF-THE-RUNG (2026-08-29, D3b).
 *
 * A checklistcenter page states a subset's parallel ladder ONCE, at the
 * section head, under a label that names the finish family:
 *
 *   <strong>Refractor Parallels:</strong> Refractor #/499; Purple #/250; ...
 *   Gold #/50; ... SuperFractor 1/1; Printing Plates 1/1
 *
 * The html path expanded that ladder onto every card of the section (the real
 * shape: cards x ladder is the checklist, not an explosion) but dropped the
 * label -- "Purple", "Gold" -- where the same product's workbook says "Purple
 * Refractor", "Gold Refractor"; it read "SuperFractor 1/1" as "SuperFractor 1"
 * with no print run; and it split Topps Chrome's odds footnotes "(1:3 Hobby;
 * 1:1 Jumbo)" into rungs. The fixtures are trimmed REAL pages and workbook
 * rows fetched 2026-08-29; every expected name below is text on the page.
 *
 * The xlsx path (one row per published line, #1413) is the control: it already
 * carried the full ladder and must convert exactly as before.
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

const BOWMAN_DRAFT = { sourceSlug: "2025-bowman-draft-baseball-card-checklist", year: 2025, sport: "baseball" };
const TOPPS_CHROME = { sourceSlug: "2025-topps-chrome-baseball-card-checklist", year: 2025, sport: "baseball" };
const SELECT = { sourceSlug: "2025-panini-select-baseball-card-checklist", year: 2025, sport: "baseball" };
const PRIZM = { sourceSlug: "2025-panini-prizm-baseball-card-checklist", year: 2025, sport: "baseball" };

describe("2025 Bowman Draft, html path: the section ladder lands on every card of the section", () => {
  const out = conv.convertHtml(html("2025-bowman-draft.trimmed.html"), BOWMAN_DRAFT);
  const mwi = byCard(out.rows, "CPA-MWI");

  it("CPA-MWI carries the whole Refractor ladder, long form, with the page's print runs", () => {
    expect(runOf(mwi, "Refractor")).toBe(499);
    expect(runOf(mwi, "Purple Refractor")).toBe(250);
    expect(runOf(mwi, "Blue Refractor")).toBe(150);
    expect(runOf(mwi, "Green Refractor")).toBe(99);
    expect(runOf(mwi, "Gold Refractor")).toBe(50);
    expect(runOf(mwi, "Orange Refractor")).toBe(25);
    expect(runOf(mwi, "Red Refractor")).toBe(5);
    expect(runOf(mwi, "SuperFractor")).toBe(1);
    expect(runOf(mwi, "Printing Plates")).toBe(1);
  });

  it("a rung that already names its finish is left as written", () => {
    expect(runOf(mwi, "Black X-Fractor")).toBe(5);
    expect(mwi.map((r) => r.parallel)).not.toContain("Black X-Fractor Refractor");
    expect(mwi.map((r) => r.parallel)).not.toContain("SuperFractor Refractor");
  });

  it("no bare colour, no '1' glued to a name, no digit-led rung survives", () => {
    const names = mwi.map((r) => r.parallel).filter(Boolean);
    for (const bare of ["Purple", "Gold", "Blue", "Orange", "Red", "SuperFractor 1", "Printing Plates 1"]) expect(names).not.toContain(bare);
    expect(names.some((n) => /^\d/.test(n))).toBe(false);
  });

  it("the footnote is a note, never part of the name", () => {
    const orange = mwi.find((r) => r.parallel === "Orange Refractor");
    expect(orange?.note).toBe("Hobby Exclusive");
    expect(mwi.find((r) => r.parallel === "Gumball Refractor")?.note).toBe("Variety Pack Exclusive");
  });

  it("the plain card is a blank parallel (never the word Base) and the CPA- section is auto", () => {
    expect(mwi.some((r) => r.parallel === "")).toBe(true);
    expect(mwi.every((r) => r.isAuto === "true")).toBe(true);
    expect(mwi.every((r) => r.category === "insert:chrome-prospect-auto")).toBe(true);
    expect(mwi[0].player).toBe("Max Williams");
  });

  it("a plain 'Parallels:' label appends nothing: the Base Set's bordered rungs stay as written", () => {
    const bd1 = byCard(out.rows, "BD-1");
    expect(bd1.find((r) => r.parallel === "Base")).toBeTruthy();
    expect(runOf(bd1, "Sky Blue Border")).toBe(499);
    expect(runOf(bd1, "Black Border")).toBe(1);
    expect(bd1.every((r) => r.isAuto === "false" && r.category === "base")).toBe(true);
    expect(bd1.map((r) => r.parallel)).not.toContain("Sky Blue Border Refractor");
  });

  it("declares what the expansion added: sections, ladders, ladderRows", () => {
    const cards = new Set(out.rows.map((r: string[]) => `${r[0]}|${r[1]}`)).size;
    expect(out.stats.sections).toBe(2);
    expect(out.stats.laddersFound).toBe(2);
    expect(out.stats.ladderRows).toBe(out.rows.length - cards);
    expect(out.stats.ladderRows).toBeGreaterThan(cards * 5);
  });
});

describe("2025 Bowman Draft, xlsx path (the control): one row per published line, ladder already there", () => {
  const fixture = rowsJson("2025-bowman-draft.rows.json");
  const out = conv.convertXlsx(fixture, BOWMAN_DRAFT);
  const mwi = byCard(out.rows, "CPA-MWI");

  it("emits exactly the workbook's lines, nothing multiplied", () => {
    expect(out.rows.length).toBe(fixture.length - 1);
    expect(out.stats.ladderRows).toBe(0);
  });

  it("CPA-MWI: 26 lines, Gold Refractor /50 ... SuperFractor /1, all auto, type qualifier stripped", () => {
    expect(mwi).toHaveLength(26);
    expect(runOf(mwi, "Gold Refractor")).toBe(50);
    expect(runOf(mwi, "Purple Refractor")).toBe(250);
    expect(runOf(mwi, "Blue Refractor")).toBe(150);
    expect(runOf(mwi, "Orange Refractor")).toBe(25);
    expect(runOf(mwi, "Red Refractor")).toBe(5);
    expect(runOf(mwi, "SuperFractor")).toBe(1);
    expect(mwi.every((r) => r.isAuto === "true")).toBe(true);
    expect(mwi.some((r) => r.parallel === "")).toBe(true);
    expect(mwi.map((r) => r.parallel).some((p) => /^Autographs/.test(p))).toBe(false);
  });
});

describe("2025 Topps Chrome, html: an odds footnote with semicolons is ONE footnote", () => {
  const out = conv.convertHtml(html("2025-topps-chrome.trimmed.html"), TOPPS_CHROME);
  const one = byCard(out.rows, "1");

  it("no '1:3 Hobby' rung; Refractor keeps its odds as a note", () => {
    const names = one.map((r) => r.parallel);
    expect(names.some((n) => /^\d+:\d/.test(n) || /\)$/.test(n) || /\($/.test(n))).toBe(false);
    expect(one.find((r) => r.parallel === "Refractor")?.note).toMatch(/1:3 Hobby; 1:1 Jumbo/);
  });

  it("the page's labels name the families the workbook uses", () => {
    const names = one.map((r) => r.parallel);
    for (const n of ["Sepia Refractor", "Prism Refractor", "Negative Refractor", "Teal Refractor", "Purple Refractor", "Aqua Lava", "Purple RayWave", "Green Geometric"]) expect(names, n).toContain(n);
    expect(runOf(one, "Purple Refractor")).toBe(250);
    expect(runOf(one, "SuperFractor")).toBe(1);
    expect(one[0].player).toBe("Shohei Ohtani");
  });
});

describe("2025 Topps Chrome, xlsx path (the control): unchanged", () => {
  const fixture = rowsJson("2025-topps-chrome.rows.json");
  const out = conv.convertXlsx(fixture, TOPPS_CHROME);
  it("#1 converts line for line with the plain colour ladder the old source had", () => {
    expect(out.rows.length).toBe(fixture.length - 1);
    const names = byCard(out.rows, "1").map((r) => r.parallel);
    for (const n of ["Base", "Sepia Refractor", "Prism Refractor", "Teal Refractor", "Blue Refractor", "Purple Refractor", "Gold Refractor", "SuperFractor"]) expect(names, n).toContain(n);
  });
});

describe("2025 Panini Select: Prizm families", () => {
  it("html: 'Prizm Parallels' / 'Flash Prizm' / 'Ice Prizm' labels reach every rung", () => {
    const out = conv.convertHtml(html("2025-panini-select.trimmed.html"), SELECT);
    const one = byCard(out.rows, "1");
    expect(one[0].player).toBe("Christian Moore");
    // "Base Concourse Set" is categorised insert:base-concourse today, so its
    // plain row is a blank parallel (both shapes slug to :base:).
    expect(one.find((r) => r.parallel === "" || r.parallel === "Base")).toBeTruthy();
    expect(runOf(one, "Gold Prizm")).toBe(10);
    expect(runOf(one, "Red and Blue Prizm")).toBe(399);
    expect(runOf(one, "Black Finite Prizm")).toBe(1);
    expect(runOf(one, "Gold Vinyl Prizm")).toBe(1);
    expect(one.map((r) => r.parallel)).toContain("Silver Prizm");
    expect(runOf(one, "Red Flash Prizm")).toBe(299);
    expect(runOf(one, "Red Ice Prizm")).toBe(299);
    expect(one.map((r) => r.parallel)).toContain("Ice Prizm");       // the family itself, not "Ice Ice Prizm"
    expect(one.map((r) => r.parallel)).not.toContain("Gold");
    expect(one.map((r) => r.parallel)).not.toContain("Ice Ice Prizm");
  });

  it("xlsx: 'Base Set - Concourse - Gold Prizms' loses its qualifier AND the separator", () => {
    const fixture = rowsJson("2025-panini-select.rows.json");
    const out = conv.convertXlsx(fixture, SELECT);
    expect(out.rows.length).toBe(fixture.length - 1);
    const base = byCard(out.rows, "1").filter((r) => r.category === "base");
    expect(base.find((r) => r.parallel === "Base")).toBeTruthy();
    expect(runOf(base, "Black and Blue Prizms")).toBe(49);
    expect(base.map((r) => r.parallel).some((p) => /^[-–]/.test(p))).toBe(false);
    const mem = byCard(out.rows, "1").filter((r) => r.category !== "base");
    expect(mem.every((r) => r.isAuto === "true")).toBe(true);
    expect(runOf(mem, "Blue Prizms")).toBe(35);
  });
});

describe("2025 Panini Prizm, xlsx path: the workbook's own words", () => {
  it("base #1 keeps 'Prizms Blue' as the manufacturer wrote it, with its run", () => {
    const fixture = rowsJson("2025-panini-prizm.rows.json");
    const out = conv.convertXlsx(fixture, PRIZM);
    expect(out.rows.length).toBe(fixture.length - 1);
    const one = byCard(out.rows, "1");
    expect(runOf(one, "Prizms Blue")).toBe(199);
    expect(runOf(one, "Prizms Gold")).toBe(10);
    expect(one.find((r) => r.parallel === "Base")).toBeTruthy();
  });
});

describe("the small rules behind the ladder", () => {
  it("clean: '1/1' is a print run of one; '#/-5' tolerates the stray dash", () => {
    expect(conv.clean("SuperFractor 1/1")).toMatchObject({ name: "SuperFractor", printRun: 1 });
    expect(conv.clean("Gold Vinyl 1/1")).toMatchObject({ name: "Gold Vinyl", printRun: 1 });
    expect(conv.clean("Black Finite 1/1 (*No Rocker)")).toMatchObject({ name: "Black Finite", printRun: 1, note: "*No Rocker" });
    expect(conv.clean("FrozenFractor #/-5")).toMatchObject({ name: "FrozenFractor", printRun: 5 });
    expect(conv.clean("Orange #/25 (Hobby Exclusive)")).toMatchObject({ name: "Orange", printRun: 25, note: "Hobby Exclusive" });
  });

  it("splitRungs: semicolons inside parentheses do not split", () => {
    expect(conv.splitRungs("Refractor (1:3 Hobby; 1:1 Jumbo); Purple #/250")).toEqual(["Refractor (1:3 Hobby; 1:1 Jumbo)", " Purple #/250"]);
  });

  it("ladderFamily: a finish label applies, an insert-set label does not", () => {
    expect(conv.ladderFamily("Refractor Parallels")).toBe("Refractor");
    expect(conv.ladderFamily("Prizms Parallels")).toBe("Prizm");
    expect(conv.ladderFamily("Ice Prizm Parallels")).toBe("Ice Prizm");
    expect(conv.ladderFamily("Geometric Refractor Parallels")).toBe("Geometric Refractor");
    expect(conv.ladderFamily("Parallels")).toBe("");
    expect(conv.ladderFamily("Prime Number Parallels")).toBe("");
    expect(conv.ladderFamily("Aspirations Parallels")).toBe("");
  });

  it("applyFamily: append, keep, or the family itself", () => {
    expect(conv.applyFamily("Gold", "Refractor")).toBe("Gold Refractor");
    expect(conv.applyFamily("Gold Wave", "Refractor")).toBe("Gold Wave Refractor");
    expect(conv.applyFamily("Refractor", "Refractor")).toBe("Refractor");
    expect(conv.applyFamily("Base Refractor", "Refractor")).toBe("Base Refractor");
    expect(conv.applyFamily("SuperFractor", "Refractor")).toBe("SuperFractor");
    expect(conv.applyFamily("Black X-Fractor", "Refractor")).toBe("Black X-Fractor");
    expect(conv.applyFamily("Printing Plates", "Refractor")).toBe("Printing Plates");
    expect(conv.applyFamily("Ice", "Ice Prizm")).toBe("Ice Prizm");
    expect(conv.applyFamily("Sky Blue Border", "")).toBe("Sky Blue Border");
  });

  it("productMeta: every trailing sport word comes off the setKey", () => {
    expect(conv.productMeta({ sourceSlug: "2020-bowman-baseball-baseball-card-checklist", year: 2020, sport: "baseball" })).toMatchObject({ year: 2020, sport: "baseball", setKey: "bowman" });
    expect(conv.productMeta({ sourceSlug: "2024-leaf-metal-baseball-baseball-card-checklist", year: 2024 })).toMatchObject({ sport: "baseball", setKey: "leaf-metal" });
    expect(conv.productMeta({ sourceSlug: "2025-topps-chrome-baseball-card-checklist", year: 2025 })).toMatchObject({ sport: "baseball", setKey: "topps-chrome" });
    expect(conv.productMeta({ sourceSlug: "2025-panini-prizm-football-card-checklist", year: 2025 })).toMatchObject({ sport: "football", setKey: "panini-prizm" });
  });
});
