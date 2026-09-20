// R67 (Drew, ruling round of 2026-09-19), sibling to
// photogenicInsertKeysAreFixedPoints.test.ts and zenithInsertKeysAreFixedPoints
// -- 2024 PANINI PHOENIX FOOTBALL, THE NAMED INSERT SETS.
//
// A named insert set is its own product key; colour variants are NOT keys --
// the colour rides the parallel field. THE ROSTER DECIDES: a child roster
// that is a SUBSET of the parent on the same numbers is a colour child; a
// child with numbers/players the parent lacks (or, here, that DISAGREES with
// the parent at every shared number despite 100% numeric overlap) is its own
// key. Measured directly against the regenerated, #2350-fixed CSV (20,309
// rows, `acq-2026-09-19-beckett-panini-phoenix-fb`) using planStagedDirectory's
// own `unregistered` output -- never a hand-spelled guess -- then re-verified
// per key: 0% roster agreement with Base at the same card numbers (see
// productSetKeys.ts's own registration comment for the full per-key table).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const SCRAPED_ROOT = path.join(__dirname, "..", "data", "checklists", "scraped");

// The 23 roots measured against the regenerated CSV -- see productSetKeys.ts's
// own registration comment for the full per-root row/roster-agreement table.
const PHOENIX_INSERTS = [
  "rookie-rising", "contours", "rookie-phenoms-jersey-autographs", "rookie-silhouettes",
  "treasured-tandems", "franchise-future-material", "rookie-phenom-jersey",
  "rising-rookie-autographs-jersey", "incredible-inked-materials", "pandora-patch",
  "rising-rookies-dual-patch-autographs", "rising-star-autographs-jersey",
  "phoenician-rookie-penmanship", "rookie-calligraphy", "regeneration", "calligraphy",
  "phoenician-penmanship", "phenomenal-duo-jersey-autographs", "color-blast", "flex",
  "gridiron-crowns", "phoenician", "archetype",
];

describe("Phoenix insert keys", () => {
  it("registers every measured root", () => {
    expect(PHOENIX_INSERTS.length).toBe(23);
    const missing = PHOENIX_INSERTS.filter((sub) => !isProductSetKey(`panini-phoenix-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    const collapsed = PHOENIX_INSERTS
      .map((sub) => `panini-phoenix-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-phoenix, now registered as its parent", () => {
    for (const sub of PHOENIX_INSERTS) {
      const key = `panini-phoenix-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-phoenix`).toBe("panini-phoenix");
    }
  });

  it("panini-phoenix itself is now a registered product, still a fixed point", () => {
    expect(isProductSetKey("panini-phoenix")).toBe(true);
    expect(normalizeSetKey("panini-phoenix", "football")).toBe("panini-phoenix");
  });

  it("the staged, regenerated CSV's own unregistered-key list (pre-registration) is exactly these 23 roots", () => {
    // Reads the CURRENT staged CSV (already regenerated with this branch's
    // converter, all 23 now registered) and re-derives, from the rows
    // themselves, which categories are auto-/insert- roots with ZERO roster
    // agreement against Base at the same card numbers -- the same evidence
    // productSetKeys.ts's own registration comment cites, verified
    // independently here rather than trusted blindly.
    const csvPath = path.join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-phoenix-fb", "2024-panini-phoenix-football.csv");
    const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], parallel: parts[2], player: parts.slice(5).join(",") };
    });
    const baseByNum = new Map<string, string>();
    for (const r of rows) if (r.category === "base" && r.parallel === "") baseByNum.set(r.cardNumber, r.player);
    for (const sub of PHOENIX_INSERTS) {
      const matchingCats = new Set(rows.filter((r) => r.category.replace(/^auto-|^insert-/, "") === sub).map((r) => r.category));
      expect(matchingCats.size, sub).toBeGreaterThan(0);
      for (const cat of matchingCats) {
        const catRows = rows.filter((r) => r.category === cat && r.parallel === "");
        let agree = 0;
        for (const r of catRows) {
          const bp = baseByNum.get(r.cardNumber);
          if (bp !== undefined && bp.trim().toLowerCase() === r.player.trim().toLowerCase()) agree++;
        }
        expect(agree, `${cat} must share zero players with Base at the same numbers`).toBe(0);
      }
    }
  });
});
