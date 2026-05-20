import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { parseCardboardConnectionChecklist } from "../src/agents/cardboardConnection/cardboardConnectionParser.js";
import type { RawRow } from "../src/agents/beckett/beckettChecklistParser.js";

const FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "cardboard-connection",
  "2022-Topps-Series-1-Baseball-checklist-Excel-spreadsheet.trimmed.xlsx",
);

function makeWorkbook(sheetName: string, rows: RawRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("Cardboard Connection parser", () => {
  it("parses real CC fixture and surfaces section diagnostics", () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    const bytes = fs.readFileSync(FIXTURE_PATH);
    const parsed = parseCardboardConnectionChecklist(bytes, {
      sourceLabel: "fixture",
    });

    expect(parsed.meta.sheetNames.length).toBeGreaterThan(0);
    expect(parsed.sections.length).toBeGreaterThan(3);
    expect(parsed.cards.length).toBeGreaterThan(40);

    const hasInsert = parsed.sections.some((s) => /INSERT/i.test(s.name));
    const hasAuto = parsed.sections.some((s) => /AUTOGRAPH/i.test(s.name));
    const hasRelic = parsed.sections.some((s) => /RELIC/i.test(s.name));
    expect(hasInsert).toBe(true);
    expect(hasAuto).toBe(true);
    expect(hasRelic).toBe(true);

    const autoCards = parsed.cards.filter((c) => c.isAutograph);
    expect(autoCards.length).toBeGreaterThan(5);

    // CC sheet generally does not expose print-run columns in-cell; parser
    // still captures parallel section markers in the same contract.
    expect(parsed.parallels.length).toBeGreaterThan(0);
  });

  it("keeps rows with missing player column and logs diagnostics", () => {
    const wb = makeWorkbook("Checklist", [
      ["AUTOGRAPH", null, null, null],
      ["BASEBALL STARS AUTOGRAPHS", null, null, null],
      ["BSA-ABC", null, "Boston Red Sox®", "Rookie"],
    ]);

    const parsed = parseCardboardConnectionChecklist(wb);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]!.cardNumber).toBe("BSA-ABC");
    expect(parsed.cards[0]!.player).toBeNull();
  });

  it("captures parallel section rows as parallels", () => {
    const wb = makeWorkbook("Checklist", [
      ["AUTOGRAPH", null, null, null],
      ["GENERATION NOW AUTOGRAPH PARALLEL", null, null, null],
      ["GN-1", "Player One", "Team", null],
    ]);

    const parsed = parseCardboardConnectionChecklist(wb);
    expect(parsed.parallels.some((p) => /PARALLEL/i.test(p.name))).toBe(true);
  });
});
