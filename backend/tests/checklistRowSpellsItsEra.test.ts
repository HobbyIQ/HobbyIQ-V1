import { describe, it, expect } from "vitest";
import { spellForEra } from "../src/services/catalog/productSetKeys";
import { ERA_SPLIT_TABLE } from "../src/services/catalog/setKeyReconciliation";
import { normalizeSetKey, resolveSetKeyForSlug, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service";

/**
 * CF-A-CHECKLIST-ROW-SPELLS-ITS-ERA-LIKE-A-SALE-DOES (Drew, 2026-09-05).
 *
 * ERA_SPLIT_TABLE ruled that Score, Leaf, Fleer and Skybox take the BARE key
 * in every year (`makerKey: null` -- "no synthetic products"). The table had
 * no code consumer: it was evidence for a boundary, while the spelling
 * decision lived in `spellForEra`, which knew only about Donruss and
 * Fleer-Tiffany. So the vocabulary's strict Panini tier kept minting the key
 * the table forbids -- `/panini-score/` matches before `/(?:^|-)score/`, and
 * "2025 Panini Score Football" is what the product's own checklist page is
 * called.
 *
 * Measured on prod 2026-09-05:
 *   card_catalog panini-score   3,702 rows (3,300 STRICT, hobbymonitor-2026-09-04)
 *   card_catalog score         58,985 rows (19,395 of 2025 football, all checklistinsider)
 *   sold_comps   :panini-score: 35,174 pool rows
 *
 * One product, two spellings, two pools. These tests pin the ruling to the ONE
 * deriver both a sale and a checklist row already call.
 */
describe("a checklist row spells its era like a sale does", () => {
  it("THE PIN: 2024/2025 Panini Score is `score`, from the product's own title", () => {
    // The exact text the hobbymonitor checklist page carries.
    expect(resolveSetKeyForSlug("football", "2024 Panini Score", 2024)).toBe("score");
    expect(resolveSetKeyForSlug("football", "2025 Panini Score Football", 2025)).toBe("score");
    // ...and the bare spelling the other source uses lands in the SAME place.
    expect(resolveSetKeyForSlug("football", "2025 Score Football", 2025)).toBe("score");
  });

  it("every never-acquired maker prefix is stripped in EVERY year", () => {
    // `makerKey: null` means bare always -- there is no boundary to sit on,
    // so an absent year must not defeat the rule either.
    for (const k of ["panini-score", "panini-leaf", "panini-fleer", "panini-skybox"]) {
      const bare = k.replace(/^panini-/, "");
      expect(spellForEra(k, 1991)).toBe(bare);
      expect(spellForEra(k, 2025)).toBe(bare);
      expect(spellForEra(k, null)).toBe(bare);
    }
  });

  it("the rule is the era table's own, not a second vocabulary", () => {
    // Every `makerKey: null` brand in the table must be enforced by the
    // deriver. This is what makes the table a ruling rather than a comment:
    // add a never-acquired brand there and this test demands the call site.
    const neverAcquired = ERA_SPLIT_TABLE.filter((r) => r.makerKey === null);
    expect(neverAcquired.length).toBeGreaterThan(0);
    for (const rule of neverAcquired) {
      expect(spellForEra(`panini-${rule.brand}`, 2025)).toBe(rule.brand);
      expect(spellForEra(rule.brand, 2025)).toBe(rule.brand);
    }
  });

  it("DOES NOT touch Donruss -- the one brand with a real two-owner split", () => {
    // 292,792 rows on panini-donruss against 116,723 on donruss, and a
    // genuine 2009 boundary. Stripping this prefix would be the same defect
    // in the other direction.
    expect(spellForEra("panini-donruss", 2020)).toBe("panini-donruss");
    expect(spellForEra("panini-donruss", 1987)).toBe("donruss");
    expect(spellForEra("donruss", 2020)).toBe("panini-donruss");
    expect(spellForEra("donruss", 1987)).toBe("donruss");
    const donruss = ERA_SPLIT_TABLE.find((r) => r.brand === "donruss");
    expect(donruss?.makerKey).toBe("panini-donruss");
  });

  it("a checklist row and a sale mint the SAME slug for the same card", () => {
    // Drake London, 2025 Score football #17 (checklistinsider, confirmed
    // against the published checklist). The checklist ingest passes
    // authoritativeSetKey; the sale path does not. Both must agree.
    const checklistRow = deriveCatalogEntry({
      sport: "football", year: 2025, setKey: "2025 Panini Score Football",
      cardNumber: "17", parallel: "Base", isAuto: false, printRun: null,
      playerName: "Drake London", source: "hobbymonitor" as never, confidence: 0.95,
      setName: "2025 Panini Score Football", authoritativeSetKey: true,
    });
    const saleSlug = computeHobbyIqCardId({
      sport: "football", year: 2025, setKey: "2025 Panini Score Football",
      cardNumber: "17", parallel: "Base", isAuto: false, printRun: null,
    });
    expect(checklistRow?.id).toBe("hiq:football:2025:score:17:base:no-auto");
    expect(saleSlug).toBe(checklistRow?.id);
    // and the FIELD agrees with the id (CF-THE-ID-CARRIES-THE-PRODUCT).
    expect((checklistRow as { setKey?: string })?.setKey).toBe("score");
  });

  it("does not disturb the bare keys or the other Panini products", () => {
    expect(normalizeSetKey("1991 Score")).toBe("score");
    expect(spellForEra("score", 1991)).toBe("score");
    expect(spellForEra("leaf", 2026)).toBe("leaf");
    // Neighbours that must NOT be swept up by a prefix rule.
    expect(spellForEra("score-select", 2025)).toBe("score-select");
    expect(spellForEra("panini-select", 2025)).toBe("panini-select");
    expect(spellForEra("panini-prizm", 2025)).toBe("panini-prizm");
    expect(spellForEra("leaf-limited", 2025)).toBe("leaf-limited");
    expect(spellForEra("fleer-tradition", 2000)).toBe("fleer-tradition");
    expect(spellForEra("score-rookie-and-traded", 1991)).toBe("score-rookie-and-traded");
  });
});
