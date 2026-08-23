/**
 * CF-DPP-IS-ITS-OWN-PRODUCT (2026-08-23).
 *
 * Drew: "the name should be the set name" / "the actual full name of the card is
 * correct and what bowman says the name of the set is" / "in most cases ebay is
 * giving us the correct name".
 *
 * A holding imported from eBay carried setName "2005 Bowman Chrome Draft Picks &
 * Prospects" — the product's published name — and was filed under
 * hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto. Six comps instead of
 * sixty-four, on a catalog row that existed only because a human hand-made it
 * (source: user-verified).
 *
 * The cause was an UNANCHORED regex written for a different product. Slugified,
 * the name begins with bowman-chrome-draft, so the Draft Chrome rule matched its
 * prefix and truncated the rest away.
 *
 * MEASURED 2026-08-23:
 *   catalog  bowman-draft-picks-and-prospects          155,555 cards
 *            bowman-chrome-draft-picks-and-prospects       110 cards
 *   sales    filed under bowman-draft  (paper)            7,169
 *            filed under bowman-draft  (chrome)           1,246
 *            filed under bowman-chrome (chrome)             267
 *
 * THE NEGATIVE CASES ARE THE POINT. This change adds vocabulary; it must not
 * disturb CF-MATCH-THE-CATALOG (Bowman Draft Chrome still folds to bowman-draft)
 * and must not touch any neighbouring Bowman product.
 */
import { describe, expect, it } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("Draft Picks & Prospects keeps its own name", () => {
  it("keeps the chrome stock distinct, ampersand or not", () => {
    for (const s of [
      "2005 Bowman Chrome Draft Picks & Prospects",
      "2005 Bowman Chrome Draft Picks and Prospects",
      "Bowman Chrome Draft Picks & Prospects",
      "2009 Bowman Chrome Draft Picks & Prospects Baseball",
    ]) {
      expect(normalizeSetKey(s), s).toBe("bowman-chrome-draft-picks-and-prospects");
    }
  });

  it("keeps the paper stock distinct, ampersand or not", () => {
    for (const s of [
      "2003 Bowman Draft Picks & Prospects Baseball",
      "2003 Bowman Draft Picks and Prospects",
      "Bowman Draft Picks & Prospects",
    ]) {
      expect(normalizeSetKey(s), s).toBe("bowman-draft-picks-and-prospects");
    }
  });

  it("never returns the truncated key the defect produced", () => {
    // This is the exact assertion that fails on main.
    expect(normalizeSetKey("2005 Bowman Chrome Draft Picks & Prospects")).not.toBe("bowman-draft");
    expect(normalizeSetKey("2003 Bowman Draft Picks & Prospects Baseball")).not.toBe("bowman-draft");
  });

  it("never conflates the two stocks with each other", () => {
    // Paper and chrome DPP are different products that both number from 1.
    expect(normalizeSetKey("Bowman Draft Picks & Prospects"))
      .not.toBe(normalizeSetKey("Bowman Chrome Draft Picks & Prospects"));
  });
});

describe("neighbouring Bowman products are undisturbed", () => {
  it("leaves CF-MATCH-THE-CATALOG intact — Draft Chrome still folds to draft", () => {
    // Drew, 2026-08-16: bowman-draft-chrome is a vendor artifact with 0
    // checklist-backed rows; draft chrome cards belong to bowman-draft. That
    // ruling stands and this change must not reverse it.
    expect(normalizeSetKey("2025 Bowman Draft Chrome Baseball")).toBe("bowman-draft");
    expect(normalizeSetKey("2020 Bowman Chrome Draft Baseball")).toBe("bowman-draft");
  });

  it("leaves the rest of the family where it was", () => {
    const unchanged: Array<[string, string]> = [
      ["2026 Bowman Baseball", "bowman"],
      ["2025 Bowman Sapphire Baseball", "bowman-chrome-sapphire"],
      ["2025 Bowman Chrome Mega Box Baseball", "bowman-chrome-mega-box"],
      ["2025 Topps Baseball", "topps"],
      ["2023 Topps Chrome Platinum Baseball", "topps-chrome-platinum"],
      ["Chrome Prospects Autographs", "bowman-chrome"],
    ];
    for (const [input, expected] of unchanged) {
      expect(normalizeSetKey(input), input).toBe(expected);
    }
  });

  it("does not let the new rule swallow a plain Bowman Draft", () => {
    // "Bowman Draft" alone is not Draft Picks & Prospects.
    expect(normalizeSetKey("2024 Bowman Draft")).toBe("bowman-draft");
    expect(normalizeSetKey("Bowman Draft Paper")).toBe("bowman-draft-paper");
  });
});
