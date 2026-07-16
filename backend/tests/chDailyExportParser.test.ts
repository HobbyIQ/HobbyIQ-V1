// CF-CH-DAILY-EXPORT-INGEST (2026-07-16) — parser + header-guard
// pin tests. Small on-disk fixture mirrors the real CH CSV shape
// (header + 5 rows verified against an actual 2026-07-15 download).

import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import {
  parseDailyExportStream,
  coerceRow,
} from "../src/services/compiq/cardhedgeDailyExport.client.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

const HEADER =
  "price_history_id,source,description,price,listing_url,image_url,pop,sale_date,sale_type,card_id,card_description,number,player,grade,grader,group,card_set,card_set_type,variant,year,created_at,updated_at";

// Real rows lifted from a 2026-07-15 download; sanitized only for line
// length. Every field position matches the live CSV.
const FIXTURE_ROWS = [
  `1784073605502x568357641200449150,ebay,1992 Classic Four Sport Shaquille O'Neal #1 Magic - Raw,1.25,https://www.ebay.com/itm/127966470410,https://i.ebayimg.com/img.jpg,0,2026-07-15T00:00:00+00:00,Auction,1642909339837x697505140070940700,Shaquille O'Neal 1992 Classic Four Sport,1,Shaquille O'Neal,Raw,Raw,Multi-Sport,1992 Classic Four Sport,Classic Four Sport,Base,1992,2026-07-15T00:00:09.570376+00:00,2026-07-15T00:00:09.570376+00:00`,
  `1784073606836x335022546386084100,ebay,1983 Topps Lawrence Taylor NFC Pro Bowl HOF #133 EXC+/NM - Raw,3.49,https://www.ebay.com/itm/117250624135,https://i.ebayimg.com/img.jpg,0,2026-07-14T23:59:00+00:00,BIN,1650586804953x280706231946687970,Lawrence Taylor 1983 Topps Football,133,Lawrence Taylor,Raw,Raw,Football,1983 Topps Football,Topps Football,Base,1983,2026-07-15T00:00:13.830644+00:00,2026-07-15T00:00:13.830644+00:00`,
  // Empty sale_type — CH intermittently emits blank for unclassified sales.
  `1784073606837x522529459186366100,ebay,"LeBron James, #8B-19 2025-26 Topps 8-Bit Ballers Los Angeles Lakers - Raw",1.35,https://www.ebay.com/itm/376766787292,https://i.ebayimg.com/img.jpg,0,2026-07-14T23:59:00+00:00,,1761830837220x365367031965013760,LeBron James 2025 Topps 8-Bit Ballers Basketball,8B-19,LeBron James,Raw,Raw,Basketball,2025 Topps Basketball,Topps Basketball,Base,2025,2026-07-15T00:00:14.846246+00:00,2026-07-15T00:00:14.846246+00:00`,
];

function streamOf(text: string): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(text);
  stream.push(null);
  return stream;
}

describe("parseDailyExportStream", () => {
  it("parses the header + N data rows into typed CHDailySaleRow", async () => {
    const csv = HEADER + "\n" + FIXTURE_ROWS.join("\n") + "\n";
    const seen: CHDailySaleRow[] = [];
    const res = await parseDailyExportStream(streamOf(csv), (row) => { seen.push(row); });
    expect(res.rows).toBe(FIXTURE_ROWS.length);
    expect(res.errors).toBe(0);
    expect(seen[0].price_history_id).toBe("1784073605502x568357641200449150");
    expect(seen[0].player).toBe("Shaquille O'Neal");
    expect(seen[0].price).toBe(1.25);
    expect(seen[0].year).toBe(1992);
    expect(seen[0].card_id).toBe("1642909339837x697505140070940700");
    expect(seen[1].sale_type).toBe("BIN");
    // The middle row's sale_type is empty in the CSV.
    expect(seen[2].sale_type).toBe("");
    expect(seen[2].description).toContain("LeBron James");
    expect(seen[2].description).toContain("2025-26 Topps 8-Bit Ballers");
  });

  it("throws when header column count is wrong", async () => {
    // Include one data row so csv-parse actually invokes the columns
    // callback in a way that surfaces the throw at the iterator layer.
    const shortHeader = "price_history_id,source,description,price\ndata,x,y,z\n";
    await expect(
      parseDailyExportStream(streamOf(shortHeader), () => {}),
    ).rejects.toThrow(/header mismatch.*22 columns.*got 4/i);
  });

  it("throws when header column names are wrong", async () => {
    const badHeader =
      "price_history_id,source,DESCRIPTION_typo,price,listing_url,image_url,pop,sale_date,sale_type,card_id,card_description,number,player,grade,grader,group,card_set,card_set_type,variant,year,created_at,updated_at\n" +
      // One data row to force csv-parse to consume the header.
      FIXTURE_ROWS[0] + "\n";
    await expect(
      parseDailyExportStream(streamOf(badHeader), () => {}),
    ).rejects.toThrow(/header mismatch at column 2/i);
  });

  it("row-level errors do not abort the stream", async () => {
    // Second row missing card_id → coerceRow throws; parser continues.
    const badRow = "some-id,ebay,desc,1.00,url,img,0,2026-07-15T00:00:00+00:00,BIN,,card-desc,1,Player,Raw,Raw,Baseball,Set,SetType,Base,2020,2026-07-15T00:00:00+00:00,2026-07-15T00:00:00+00:00";
    const csv = HEADER + "\n" + FIXTURE_ROWS.join("\n") + "\n" + badRow + "\n";
    const seen: CHDailySaleRow[] = [];
    const res = await parseDailyExportStream(streamOf(csv), (row) => { seen.push(row); });
    expect(res.rows).toBe(3);           // 3 good rows consumed
    expect(res.errors).toBe(1);         // 1 bad row counted
    expect(res.firstError).toMatch(/missing card_id/i);
  });

  it("async onRow is awaited (parser pauses/resumes)", async () => {
    const csv = HEADER + "\n" + FIXTURE_ROWS.join("\n") + "\n";
    const seen: string[] = [];
    const res = await parseDailyExportStream(streamOf(csv), async (row) => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(row.price_history_id);
    });
    expect(res.rows).toBe(FIXTURE_ROWS.length);
    expect(seen).toEqual([
      "1784073605502x568357641200449150",
      "1784073606836x335022546386084100",
      "1784073606837x522529459186366100",
    ]);
  });
});

describe("coerceRow", () => {
  const baseRecord: Record<string, string> = {
    price_history_id: "id-1",
    source: "ebay",
    description: "desc",
    price: "12.34",
    listing_url: "https://x.y/z",
    image_url: "https://x.y/i.jpg",
    pop: "42",
    sale_date: "2026-07-15T00:00:00+00:00",
    sale_type: "BIN",
    card_id: "card-1",
    card_description: "card desc",
    number: "BCP-1",
    player: "Mike Trout",
    grade: "10",
    grader: "PSA",
    group: "Baseball",
    card_set: "2011 Topps Update Baseball",
    card_set_type: "Topps Update",
    variant: "Base",
    year: "2011",
    created_at: "2026-07-15T00:00:00+00:00",
    updated_at: "2026-07-15T00:00:00+00:00",
  };

  it("throws when price_history_id is missing", () => {
    expect(() => coerceRow({ ...baseRecord, price_history_id: "" })).toThrow(/price_history_id/);
  });

  it("throws when card_id is missing", () => {
    expect(() => coerceRow({ ...baseRecord, card_id: "" })).toThrow(/card_id/);
  });

  it("coerces numeric fields", () => {
    const row = coerceRow(baseRecord);
    expect(row.price).toBe(12.34);
    expect(row.pop).toBe(42);
    expect(row.year).toBe(2011);
  });

  it("unparseable numeric fields default to 0 (not throw)", () => {
    const row = coerceRow({ ...baseRecord, price: "not-a-number", pop: "", year: "abc" });
    expect(row.price).toBe(0);
    expect(row.pop).toBe(0);
    expect(row.year).toBe(0);
  });

  it("preserves description content (may contain commas)", () => {
    const row = coerceRow({ ...baseRecord, description: "Player, Year, Set — Raw" });
    expect(row.description).toBe("Player, Year, Set — Raw");
  });
});
