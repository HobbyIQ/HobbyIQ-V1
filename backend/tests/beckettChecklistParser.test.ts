/**
 * Unit tests for the Beckett checklist parser.
 *
 * Covers:
 *   - Real-fixture end-to-end (2022 Bowman Baseball)
 *   - Synthetic xlsx fixtures for base extraction, parallel parsing,
 *     autograph identification, missing-column handling, and unknown
 *     sheet-structure diagnostics
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  parseBeckettChecklist,
  parseParallelText,
  looksLikeCardNumber,
  type RawRow,
} from "../src/agents/beckett/beckettChecklistParser.js";

const FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "beckett",
  "2022-Bowman-Baseball-Checklist-2.xlsx",
);

/** Build an in-memory xlsx workbook from a {sheetName: rows[]} map. */
function makeWorkbook(map: Record<string, RawRow[]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(map)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}

describe("looksLikeCardNumber", () => {
  it("accepts plain integers and alphanumeric prefixes", () => {
    expect(looksLikeCardNumber(1)).toBe(true);
    expect(looksLikeCardNumber(150)).toBe(true);
    expect(looksLikeCardNumber("BP-12")).toBe(true);
    expect(looksLikeCardNumber("BCP-141")).toBe(true);
    expect(looksLikeCardNumber("BDB-AM")).toBe(true);
    expect(looksLikeCardNumber("CPA-LD")).toBe(true);
    expect(looksLikeCardNumber("B3D-15")).toBe(true);
    expect(looksLikeCardNumber("BDC-116")).toBe(true);
  });

  it("rejects non-card values", () => {
    expect(looksLikeCardNumber(null)).toBe(false);
    expect(looksLikeCardNumber("Wander Franco")).toBe(false);
    expect(looksLikeCardNumber("Parallels:")).toBe(false);
    expect(looksLikeCardNumber("100 cards.")).toBe(false);
    expect(looksLikeCardNumber("Red - /5")).toBe(false);
    expect(looksLikeCardNumber(-1)).toBe(false);
  });
});

describe("parseParallelText", () => {
  it("parses numbered parallels", () => {
    const p = parseParallelText("Sky Blue - /499");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Sky Blue");
    expect(p!.printRun).toBe(499);
    expect(p!.isOneOfOne).toBe(false);
    expect(p!.note).toBeNull();
  });

  it("captures parenthetical notes", () => {
    const p = parseParallelText("Orange - /25 (hobby only)");
    expect(p!.name).toBe("Orange");
    expect(p!.printRun).toBe(25);
    expect(p!.note).toBe("hobby only");
  });

  it("parses 1/1 tiers as isOneOfOne", () => {
    const p = parseParallelText("Platinum - 1/1");
    expect(p!.name).toBe("Platinum");
    expect(p!.printRun).toBeNull();
    expect(p!.isOneOfOne).toBe(true);
  });

  it("returns null for non-parallel text", () => {
    expect(parseParallelText("just a sentence")).toBeNull();
  });
});

describe("parseBeckettChecklist — synthetic fixtures", () => {
  it("extracts base cards and parallels from a single Base sheet", () => {
    const wb = makeWorkbook({
      Base: [
        ["Bowman Base Set", null, null, null],
        ["100 cards.", null, null, null],
        ["Parallels:", null, null, null],
        ["Sky Blue - /499", null, null, null],
        ["Gold - /50", null, null, null],
        ["Platinum - 1/1", null, null, null],
        [1, "Joey Votto", "Cincinnati Reds", null],
        [2, "Aaron Judge", "New York Yankees", null],
        [3, "Wander Franco", "Tampa Bay Rays", "(RC)"],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    expect(parsed.sections).toHaveLength(1);
    const sec = parsed.sections[0]!;
    expect(sec.name).toBe("Bowman Base Set");
    expect(sec.declaredCount).toBe(100);
    expect(sec.cards).toHaveLength(3);
    expect(sec.parallels.map((p) => p.name)).toEqual([
      "Sky Blue",
      "Gold",
      "Platinum",
    ]);
    expect(sec.parallels[0]!.printRun).toBe(499);
    expect(sec.parallels[2]!.isOneOfOne).toBe(true);
    expect(sec.cards[2]!.isRookie).toBe(true);
    expect(sec.cards[2]!.cardNumber).toBe("3");
    expect(sec.cards[2]!.player).toBe("Wander Franco");
  });

  it("identifies autographs from sheet name and inline print runs", () => {
    const wb = makeWorkbook({
      Autographs: [
        ["Bowman in 3-D Autographs Checklist", null, null, null],
        ["3 cards.", null, null, null],
        ["Parallels:", null, null, null],
        ["Red Refractors - /5", null, null, null],
        ["Superfractors - 1/1", null, null, null],
        ["BDB-AM", "Austin Martin", "Minnesota Twins", "/99"],
        ["BDB-BJ", "Blaze Jordan", "Boston Red Sox", "/99"],
        ["BDB-CC", "Colton Cowser", "Baltimore Orioles", "/99"],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    expect(parsed.sections).toHaveLength(1);
    const sec = parsed.sections[0]!;
    expect(sec.isAutograph).toBe(true);
    expect(sec.cards).toHaveLength(3);
    for (const c of sec.cards) {
      expect(c.isAutograph).toBe(true);
      expect(c.inlinePrintRun).toBe(99);
    }
    expect(sec.cards[0]!.cardNumber).toBe("BDB-AM");
  });

  it("handles missing-column rows without dropping the card", () => {
    const wb = makeWorkbook({
      Autographs: [
        ["Bowman Buyback Autographs Checklist", null, null, null],
        ["3 players.", null, null, null],
        // No card-number column; players in col 1, team col missing entirely
        [null, "Chipper Jones", null, null],
        [null, "Eddie Murray", null, null],
        [null, "Jim Thome", null, null],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    const sec = parsed.sections[0]!;
    expect(sec.cards).toHaveLength(3);
    expect(sec.cards[0]!.cardNumber).toBeNull();
    expect(sec.cards[0]!.player).toBe("Chipper Jones");
    expect(sec.cards[0]!.team).toBeNull();
    expect(sec.cards[0]!.isAutograph).toBe(true);
  });

  it("emits a diagnostic for an unrecognized row shape but never silently drops", () => {
    const wb = makeWorkbook({
      Inserts: [
        ["Bowman Mystery Checklist", null, null, null],
        ["2 cards.", null, null, null],
        // Garbage row — multiple populated cells, none look like a card number.
        ["foo", "bar", "baz", "qux"],
        ["B3D-1", "Wander Franco", "Tampa Bay Rays", null],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    const sec = parsed.sections[0]!;
    expect(sec.cards).toHaveLength(1);
    expect(sec.cards[0]!.cardNumber).toBe("B3D-1");

    const diags = [
      ...parsed.diagnostics,
      ...parsed.sections.flatMap((s) => s.diagnostics),
    ];
    const unknownDiag = diags.find((d) =>
      /unrecognized row shape/i.test(d.message),
    );
    expect(unknownDiag).toBeDefined();
    expect(unknownDiag!.rawRow).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("parses flat (Teams/Master-style) sheets without section headers", () => {
    const wb = makeWorkbook({
      Teams: [
        ["Arizona Diamondbacks", "Base", 36, "Seth Beer", "RC"],
        ["Arizona Diamondbacks", null, 48, "Ketel Marte", null],
        ["Boston Red Sox", "Bowman Prospects", "BP-12", "Marcelo Mayer", "1st"],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    const sec = parsed.sections[0]!;
    expect(sec.sheet).toBe("Teams");
    expect(sec.cards).toHaveLength(3);
    expect(sec.cards[0]!.cardNumber).toBe("36");
    expect(sec.cards[0]!.player).toBe("Seth Beer");
    expect(sec.cards[0]!.team).toBeNull(); // "RC" is a marker, not a team
    expect(sec.cards[0]!.isRookie).toBe(true);
    expect(sec.cards[0]!.section).toBe("Arizona Diamondbacks");
    expect(sec.cards[2]!.isFirstBowman).toBe(true);
  });

  it("dedupes parallels across multiple sections", () => {
    const wb = makeWorkbook({
      Base: [
        ["Bowman Base Set", null, null, null],
        ["Parallels:", null, null, null],
        ["Sky Blue - /499", null, null, null],
        ["Gold - /50", null, null, null],
        [1, "Joey Votto", "Cincinnati Reds", null],
      ],
      Prospects: [
        ["Bowman Prospects Checklist", null, null, null],
        ["Parallels:", null, null, null],
        ["Sky Blue - /499", null, null, null],
        ["Gold - /50", null, null, null],
        ["BP-1", "Marcelo Mayer", "Boston Red Sox", "1st"],
      ],
    });
    const parsed = parseBeckettChecklist(wb);
    expect(parsed.parallels).toHaveLength(2);
    expect(parsed.parallels.map((p) => p.name).sort()).toEqual([
      "Gold",
      "Sky Blue",
    ]);
  });
});

describe("parseBeckettChecklist — 2022 Bowman Baseball fixture", () => {
  it("parses the real Beckett fixture end-to-end", () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    const bytes = fs.readFileSync(FIXTURE_PATH);
    const parsed = parseBeckettChecklist(bytes, {
      sourceLabel: "test-fixture",
    });

    // Workbook structure
    expect(parsed.meta.sheetNames).toEqual([
      "Base",
      "Prospects",
      "Autographs",
      "Inserts",
      "Teams",
      "Master",
    ]);

    // Base set declared 100 cards and we recover them all.
    const baseSection = parsed.sections.find(
      (s) => s.name === "Bowman Base Set",
    );
    expect(baseSection).toBeDefined();
    expect(baseSection!.declaredCount).toBe(100);
    expect(baseSection!.cards).toHaveLength(100);

    // Known parallel structure: Sky Blue /499, Gold /50, Platinum 1/1, etc.
    const parallelNames = baseSection!.parallels.map((p) =>
      `${p.name}|${p.printRun ?? (p.isOneOfOne ? "1of1" : "?")}`,
    );
    expect(parallelNames).toContain("Sky Blue|499");
    expect(parallelNames).toContain("Gold|50");
    expect(parallelNames).toContain("Red|5");
    expect(parallelNames).toContain("Platinum|1of1");

    // Bowman Chrome Prospects has the classic 150-card prospect run.
    const bcp = parsed.sections.find(
      (s) => s.name === "Bowman Chrome Prospects Checklist",
    );
    expect(bcp).toBeDefined();
    expect(bcp!.declaredCount).toBe(150);
    expect(bcp!.cards.length).toBeGreaterThanOrEqual(150);

    // Chrome Prospect Autographs are correctly flagged as autographs.
    const cpa = parsed.sections.find(
      (s) => s.name === "Chrome Prospect Autographs Checklist",
    );
    expect(cpa).toBeDefined();
    expect(cpa!.isAutograph).toBe(true);
    expect(cpa!.cards.every((c) => c.isAutograph)).toBe(true);

    // Lots of autograph SKUs identified across the workbook.
    const autoCount = parsed.cards.filter((c) => c.isAutograph).length;
    expect(autoCount).toBeGreaterThan(200);

    // Quality bar: at most a handful of diagnostics (Beckett footnotes, etc.).
    const allDiagnostics = [
      ...parsed.diagnostics,
      ...parsed.sections.flatMap((s) => s.diagnostics),
    ];
    expect(allDiagnostics.filter((d) => d.level === "error")).toHaveLength(0);
    expect(allDiagnostics.length).toBeLessThan(30);
  });
});
