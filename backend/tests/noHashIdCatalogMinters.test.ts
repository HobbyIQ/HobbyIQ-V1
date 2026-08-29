import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// CF-ONLY-CHECKLISTS-MINT (Drew, 2026-08-29; catalog rebuild D5). Two runtime
// paths minted card_catalog rows at hash ids ("ebay-browse:<sha>",
// "user-verified:<sha>") outside the one canonical writer. They are gone; this
// pins that they stay gone. Every catalog row's id is its hiq slug.
const FILES = [
  "src/services/portfolioiq/ebayAutoHolding.service.ts",
  "src/services/portfolioiq/ebayReviewQueue.service.ts",
];
const WRITES_CATALOG = new RegExp('container\("card_catalog"\)');
const HASH_ID = new RegExp('"(ebay-browse|user-verified):"\s*\+');

describe("no hash-id catalog minters", () => {
  for (const f of FILES) {
    it(`${f} never writes card_catalog`, () => {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(WRITES_CATALOG);
      expect(src).not.toMatch(HASH_ID);
    });
  }
});
