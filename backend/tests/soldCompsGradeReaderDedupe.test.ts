// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). `readSoldCompsForGrade`
// backs the observed grade curve (observedGradeCurve.service.ts), whose
// leading edge is a weighted median of recent sales — exactly the shape
// that let one CardHedge dual-id twin outvote a card's real trend on the
// FMV path (see dedupeSoldComps.ts's own header, the Ohtani 2018 BC #1
// case). This pins that the reader now collapses a twin pair through the
// SAME shared `dedupeSoldComps` rule, while a genuinely distinct sale in
// the same window survives untouched.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: () => ({
              fetchAll: async () => ({ resources: h.rows }),
            }),
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";

import { readSoldCompsForGrade } from "../src/services/compiq/soldCompsGradeReader.js";

describe("readSoldCompsForGrade — dedupes the CardHedge dual-id twin", () => {
  it("collapses a twin pair (same price, minutes apart) to one row", async () => {
    h.rows = [
      { price: 2146.21, soldAt: "2026-07-14T23:35:26Z", source: "cardhedge" },
      { price: 2146.21, soldAt: "2026-07-14T23:35:00Z", source: "cardhedge-daily" },
      // A genuinely distinct sale — different price, same window — must
      // survive the dedupe untouched.
      { price: 1900.00, soldAt: "2026-07-15T10:00:00Z", source: "cardhedge" },
    ];
    const rows = await readSoldCompsForGrade("hiq:baseball:test:1", "Raw");
    expect(rows).toHaveLength(2);
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    expect(prices).toEqual([1900.00, 2146.21]);
  });

  it("counts change ONLY by the twin — n real sales in, n survive when none are twins", async () => {
    h.rows = [
      { price: 100, soldAt: "2026-07-01T10:00:00Z", source: "cardhedge" },
      { price: 110, soldAt: "2026-07-02T10:00:00Z", source: "cardhedge" },
      { price: 120, soldAt: "2026-07-03T10:00:00Z", source: "cardhedge" },
    ];
    const rows = await readSoldCompsForGrade("hiq:baseball:test:1", "Raw");
    expect(rows).toHaveLength(3);
  });
});
