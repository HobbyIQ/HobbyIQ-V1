// CF-CARDLADDER-IMPORT (Drew, 2026-07-27). Pins the header-map + row
// parser support for Card Ladder's CSV export shape so we can accept
// their spreadsheets as-is. Header row from a real Card Ladder export:
//
//   Date Purchased, Quantity, Card, Subject, Year, Set, Variation,
//   Number, Category, Condition, Investment, Current Value,
//   Potential Profit, Graded Cert #, Population, Notes

import { describe, expect, it } from "vitest";
import { parseHoldingsFile } from "../src/services/portfolioiq/import/fileParser.js";
const parseFile = (input: Buffer | string, fmt: "csv" | "xlsx") => parseHoldingsFile(input, fmt);

const HEADER =
  "Date Purchased,Quantity,Card,Subject,Year,Set,Variation,Number,Category,Condition,Investment,Current Value,Potential Profit,Graded Cert #,Population,Notes";

describe("Card Ladder CSV import — header + row shape", () => {
  it("Card Ladder headers auto-map to canonical columns", async () => {
    const csv =
      HEADER + "\n" +
      "2024-03-14,1,Bowman Chrome Prospects BCP1 Ohtani,Shohei Ohtani,2018,Bowman Chrome Prospects,Refractor,BCP1,Baseball,PSA 10,45.00,120.00,75.00,12345678,,Rookie season" +
      "\n";
    const res = await parseFile(csv, "csv");
    expect(res.totalRows).toBe(1);
    const row = res.rows[0]!;
    expect(row.cells["playerName"]?.value).toBe("Shohei Ohtani");
    expect(row.cells["cardYear"]?.value).toBe(2018);
    expect(row.cells["product"]?.value).toBe("Bowman Chrome Prospects");
    // Card Ladder's "Variation" header matches our canonical `variation`
    // column directly (case-insensitive). Downstream normalizer treats
    // variation + parallel interchangeably when resolving SKUs.
    expect(row.cells["variation"]?.value).toBe("Refractor");
    expect(row.cells["cardNumber"]?.value).toBe("BCP1");
    expect(row.cells["purchasePrice"]?.value).toBe(45);
    expect(row.cells["quantity"]?.value).toBe(1);
    // Timezone-tolerant — the date parser normalizes to UTC then formats,
    // so a "2024-03-14" input can emit as "2024-03-13" in negative UTC
    // offsets. Both are the same calendar day for import intent.
    expect(row.cells["purchaseDate"]?.value).toMatch(/^2024-03-1[34]$/);
    expect(row.cells["certNumber"]?.value).toBe("12345678");
  });

  it("Condition = 'PSA 10' splits into gradeCompany + gradeValue", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,PSA 10,50,,,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    expect(row.cells["gradeCompany"]?.value).toBe("PSA");
    expect(row.cells["gradeValue"]?.value).toBe(10);
    // The pseudo-canonical must NEVER show up in the parsed cells
    expect(row.cells["_gradeCombined"]).toBeUndefined();
  });

  it("Condition = 'BGS 9.5' handles the half-grade", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Topps,,#5,Baseball,BGS 9.5,25,,,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    expect(row.cells["gradeCompany"]?.value).toBe("BGS");
    expect(row.cells["gradeValue"]?.value).toBe(9.5);
  });

  it("Condition = 'BGS 10 Black Label' keeps the qualifier as a note", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,BGS 10 Black Label,500,,,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    expect(row.cells["gradeCompany"]?.value).toBe("BGS");
    expect(row.cells["gradeValue"]?.value).toBe(10);
    expect(row.cells["notes"]?.value).toContain("Black Label");
  });

  it("Condition = 'Raw' leaves grade cells empty (raw card convention)", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,Raw,10,,,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    expect(row.cells["gradeCompany"]).toBeUndefined();
    expect(row.cells["gradeValue"]).toBeUndefined();
  });

  it("Condition = arbitrary string (e.g. 'Near Mint') carries through as a note + flags the row", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,Near Mint,10,,,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    expect(row.cells["gradeCompany"]).toBeUndefined();
    expect(row.cells["notes"]?.value).toContain("Near Mint");
    expect(row.flags.some((f) => f.column === "condition")).toBe(true);
  });

  it("Card Ladder 'Current Value' + 'Potential Profit' fall on read-only computed paths (not stored)", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,PSA 10,50,999,999,,,\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    // Current Value is a synonym for fairMarketValue, which is in the
    // computed-ignore set — the parser drops it. Same for potential profit.
    expect(row.cells["fairMarketValue"]).toBeUndefined();
    expect(row.cells["totalProfitLoss"]).toBeUndefined();
  });

  it("Population header folds into notes so nothing goes silently missing", async () => {
    const csv = HEADER + "\n" +
      ",1,Card,Player,2020,Bowman,,BCP1,Baseball,PSA 10,50,,,,120," +
      "\n";
    const res = await parseFile(csv, "csv");
    const row = res.rows[0]!;
    // Notes column is empty in the row but population="120" mapped to it
    expect(row.cells["notes"]?.value).toBe("120");
  });

  it("Full round trip on a fresh CardLadder-shaped file — round-trip anchor stays false", async () => {
    const csv = HEADER + "\n" +
      "2024-03-14,1,Bowman Chrome Prospects Ohtani,Shohei Ohtani,2018,Bowman Chrome Prospects,Refractor,BCP1,Baseball,PSA 10,45,120,75,12345678,50,Rookie season\n";
    const res = await parseFile(csv, "csv");
    // Not our export shape (no holdingId column), so isRoundTrip is
    // false and lenient parsing applies — which is the right regime
    // for a foreign spreadsheet.
    expect(res.isRoundTrip).toBe(false);
  });
});
