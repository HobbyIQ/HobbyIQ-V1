// CF-PRICE-LOOKUP-COLLAPSE-GRADES. Drew: "a graded card IS an identity" — so
// these tests must prove the collapse NEVER removes a grade row from the
// catalog's meaning. It only stops a pricing lookup from counting one card's
// grade rows as rival candidates.
//
// Fixtures are the real rows a prod probe returned for
// "2024 Bowman Chrome Ohtani Base" on 2026-08-12: 13 grade rows for II-OY plus
// 8 vendor-keyed CardHedge rows for #85 alongside its canonical twin. Those 21
// rows are 4 cards, and the >3 ambiguity guard is why pricing returned null.

import { describe, it, expect } from "vitest";
import {
  catalogIdentityKey,
  preferUngradedCanonical,
  collapseCatalogHitsToCards,
  narrowToRequestedVariants,
  type CatalogHit,
} from "../src/services/catalog/collapseCatalogHits";

const BASE = {
  year: 2024,
  setKey: "bowman-chrome",
  cardNumber: "II-OY",
  parallel: "Base",
  isAuto: true,
  printRun: 1,
  playerName: "Shohei Ohtani",
};

const UNGRADED_1_1: CatalogHit = {
  ...BASE,
  id: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-1",
  cardId: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-1",
  source: "checklistcenter",
};

const GRADES = ["raw", "psa-8", "psa-9", "psa-9-5", "psa-10", "bgs-9", "bgs-9-5",
  "bgs-10", "bgs-10-black", "sgc-10", "cgc-9-5", "cgc-10"];

const GRADE_ROWS: CatalogHit[] = GRADES.map((g) => ({
  ...BASE,
  id: `hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-1:${g}`,
  cardId: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-1",
  source: "checklistcenter-graded",
}));

const CARD_85_CANONICAL: CatalogHit = {
  year: 2024, setKey: "bowman-chrome", cardNumber: "85", parallel: "Base",
  isAuto: false, printRun: null, playerName: "Shohei Ohtani",
  id: "hiq:baseball:2024:bowman-chrome:85:base:no-auto",
  cardId: "hiq:baseball:2024:bowman-chrome:85:base:no-auto",
  source: "baseballcardpedia",
};

// Eight rows, one card, eight vendor ids. Merging these is why the identity
// key is built from fields and not from the id.
const CARD_85_VENDOR: CatalogHit[] = [
  "1727053918585x754433948322413200", "1727050993639x914313283761251100",
  "1727053617964x535822944555215400", "1727051741161x969006587744742900",
  "1727052206732x340106938328600400", "1727052458097x140718212039304460",
  "1727053102333x791071807645702400", "1726538985704x972108490152619800",
].map((vid, i) => ({
  year: 2024, setKey: "bowman-chrome", cardNumber: "85", parallel: "Base",
  isAuto: false, printRun: null, playerName: "Shohei Ohtani",
  id: `cardhedge::${vid}::abc${i}`,
  cardId: vid,
  source: "cardhedge",
  recentSaleCount: i, // give one of them a nonzero count
}));

// Genuinely different cards — these must NOT collapse.
const AUTO_25: CatalogHit = {
  ...BASE, printRun: 25,
  id: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-25",
  cardId: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-25",
};
const AUTO_50: CatalogHit = {
  ...BASE, printRun: 50,
  id: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-50",
  cardId: "hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-50",
};

const PROD_ROWS = [UNGRADED_1_1, ...GRADE_ROWS, CARD_85_CANONICAL,
  ...CARD_85_VENDOR, AUTO_25, AUTO_50];

describe("catalogIdentityKey", () => {
  it("gives every grade of one card the same identity", () => {
    const keys = new Set([UNGRADED_1_1, ...GRADE_ROWS].map(catalogIdentityKey));
    expect(keys.size).toBe(1);
  });

  it("merges vendor-keyed rows with their canonical twin", () => {
    // The whole reason the key uses fields, not ids.
    const keys = new Set([CARD_85_CANONICAL, ...CARD_85_VENDOR].map(catalogIdentityKey));
    expect(keys.size).toBe(1);
  });

  it("keeps different print runs apart — /1, /25 and /50 are three cards", () => {
    const keys = new Set([UNGRADED_1_1, AUTO_25, AUTO_50].map(catalogIdentityKey));
    expect(keys.size).toBe(3);
  });

  it("keeps auto and non-auto apart", () => {
    expect(catalogIdentityKey({ ...BASE, isAuto: true }))
      .not.toBe(catalogIdentityKey({ ...BASE, isAuto: false }));
  });

  it("keeps different parallels apart", () => {
    expect(catalogIdentityKey({ ...BASE, parallel: "Base" }))
      .not.toBe(catalogIdentityKey({ ...BASE, parallel: "Gold Refractor" }));
  });

  it("normalises case and whitespace so text noise is not a new card", () => {
    expect(catalogIdentityKey({ ...BASE, cardNumber: " ii-oy " }))
      .toBe(catalogIdentityKey({ ...BASE, cardNumber: "II-OY" }));
  });
});

describe("preferUngradedCanonical", () => {
  it("prefers the ungraded row over any grade row", () => {
    for (const g of GRADE_ROWS) {
      expect(preferUngradedCanonical(UNGRADED_1_1, g), String(g.id)).toBeLessThan(0);
      expect(preferUngradedCanonical(g, UNGRADED_1_1), String(g.id)).toBeGreaterThan(0);
    }
  });

  it("prefers a canonical hiq: slug over a vendor-keyed row", () => {
    expect(preferUngradedCanonical(CARD_85_CANONICAL, CARD_85_VENDOR[0])).toBeLessThan(0);
  });

  it("prefers the canonical row even when a vendor row is more traded", () => {
    // Provenance beats popularity — same rule as the catalog visibility tiers.
    const busyVendor = { ...CARD_85_VENDOR[0], recentSaleCount: 9999 };
    expect(preferUngradedCanonical(CARD_85_CANONICAL, busyVendor)).toBeLessThan(0);
  });

  it("falls back to most-traded between otherwise equal rows", () => {
    const a = { ...CARD_85_CANONICAL, recentSaleCount: 3 };
    const b = { ...CARD_85_CANONICAL, recentSaleCount: 40 };
    expect(preferUngradedCanonical(b, a)).toBeLessThan(0);
  });
});

describe("collapseCatalogHitsToCards", () => {
  it("turns 24 prod rows into 4 distinct cards", () => {
    // 13 grade rows for II-OY /1, 9 rows for #85 (canonical + 8 vendor-keyed),
    // plus II-OY /25 and /50. The four survivors are real, different cards —
    // the collapse must not merge them.
    const cards = collapseCatalogHitsToCards(PROD_ROWS);
    expect(PROD_ROWS.length).toBe(24);
    expect(cards).toHaveLength(4);
  });

  it("keeps the ungraded, canonical row as each card's representative", () => {
    const ids = collapseCatalogHitsToCards(PROD_ROWS).map((c) => c.id);
    expect(ids).toContain("hiq:baseball:2024:bowman-chrome:ii-oy:base:auto:num-1");
    expect(ids).toContain("hiq:baseball:2024:bowman-chrome:85:base:no-auto");
    expect(ids.some((i) => String(i).startsWith("cardhedge::"))).toBe(false);
    expect(ids.some((i) => /:psa-|:bgs-|:sgc-|:cgc-|:raw$/.test(String(i)))).toBe(false);
  });

  it("is order-independent", () => {
    const fwd = collapseCatalogHitsToCards(PROD_ROWS).map((c) => c.id).sort();
    const rev = collapseCatalogHitsToCards([...PROD_ROWS].reverse()).map((c) => c.id).sort();
    expect(rev).toEqual(fwd);
  });

  it("still surfaces a grade row when it is the only row for that card", () => {
    // Never make a card unpriceable just because its ungraded row is missing.
    const only = [GRADE_ROWS[4]];
    expect(collapseCatalogHitsToCards(only)).toHaveLength(1);
    expect(collapseCatalogHitsToCards(only)[0].id).toBe(GRADE_ROWS[4].id);
  });

  it("reports genuine ambiguity as ambiguous", () => {
    // Four different players' cards must NOT collapse into one.
    const rivals = ["10", "20", "30", "40"].map((n) => ({
      ...CARD_85_CANONICAL, cardNumber: n,
      id: `hiq:baseball:2024:bowman-chrome:${n}:base:no-auto`,
      cardId: `hiq:baseball:2024:bowman-chrome:${n}:base:no-auto`,
    }));
    expect(collapseCatalogHitsToCards(rivals).length > 3).toBe(true);
  });

  it("handles empty and malformed input without throwing", () => {
    expect(collapseCatalogHitsToCards([])).toEqual([]);
    expect(collapseCatalogHitsToCards([{}])).toHaveLength(1);
  });
});

describe("narrowToRequestedVariants", () => {
  const cards = collapseCatalogHitsToCards(PROD_ROWS);

  it("resolves the prod query to exactly the base card", () => {
    // End to end: 23 rows → 4 cards → 1 answer, clearing the >3 guard that
    // was returning a null FMV for "2024 Bowman Chrome Ohtani Base".
    const narrowed = narrowToRequestedVariants(cards, {});
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].id).toBe("hiq:baseball:2024:bowman-chrome:85:base:no-auto");
    expect(narrowed.length > 3).toBe(false);
  });

  it("keeps every variant once the query names a specific card number", () => {
    // An explicit card number means the caller is targeting a card, so the
    // base-set numbering heuristic stands down entirely.
    const narrowed = narrowToRequestedVariants(cards, {
      wantsAuto: true, wantsPrintRun: true, hasExplicitCardNumber: true,
    });
    expect(narrowed).toHaveLength(4);
  });

  it("still prefers the base-numbered card even when autos are wanted", () => {
    // "Ohtani Base auto" with no card number: II-OY is an insert auto, #85 is
    // the base card. Numbering decides, and it decides before ambiguity.
    const narrowed = narrowToRequestedVariants(cards, { wantsAuto: true, wantsPrintRun: true });
    expect(narrowed.map((c) => c.cardNumber)).toEqual(["85"]);
  });

  it("keeps serial-numbered cards when the query names a print run", () => {
    const narrowed = narrowToRequestedVariants(cards, { wantsPrintRun: true });
    // Unsigned survives the auto filter; #85 is the only unsigned card.
    expect(narrowed.map((c) => c.printRun)).toEqual([null]);
  });

  it("never empties a set that is entirely autos", () => {
    // Prospect-auto products have no unsigned card at all. Narrowing must not
    // turn a findable card into no answer.
    const autosOnly = [AUTO_25, AUTO_50];
    expect(narrowToRequestedVariants(autosOnly, {})).toHaveLength(2);
  });

  it("never empties a set that is entirely serial-numbered", () => {
    const numberedOnly = [{ ...CARD_85_CANONICAL, printRun: 99 }];
    expect(narrowToRequestedVariants(numberedOnly, {})).toHaveLength(1);
  });

  it("treats undefined printRun the same as null", () => {
    const noField = [{ ...CARD_85_CANONICAL, printRun: undefined }];
    expect(narrowToRequestedVariants(noField, {})).toHaveLength(1);
  });

  it("is a no-op on empty input", () => {
    expect(narrowToRequestedVariants([], {})).toEqual([]);
  });
});

describe("sub-product and vendor-row leakage", () => {
  // The catalog query must CONTAINS-match setKey (setName is sparse), and
  // CONTAINS('bowman-chrome') pulls in bowman-chrome-sapphire and
  // bowman-chrome-mega-box. A prod probe on 2026-08-12 returned exactly this.
  const mk = (setKey: string, id: string, cardNumber = "85"): CatalogHit => ({
    year: 2024, setKey, cardNumber, parallel: "Base", isAuto: false,
    printRun: null, id, cardId: id, playerName: "Shohei Ohtani",
  });

  const SAPPHIRE = mk("bowman-chrome-sapphire", "hiq:baseball:2024:bowman-chrome-sapphire:85:base:no-auto");
  const MEGA = mk("bowman-chrome-mega-box", "hiq:baseball:2024:bowman-chrome-mega-box:85:base:no-auto");
  const CHROME = mk("bowman-chrome", "hiq:baseball:2024:bowman-chrome:85:base:no-auto");
  const INSERT = mk("bowman-chrome", "hiq:baseball:2024:bowman-chrome:ii-1:base:no-auto", "II-1");
  const VENDOR_33: CatalogHit = {
    year: 2024, setKey: "bowman-chrome", cardNumber: "33", parallel: "Base",
    isAuto: false, printRun: null, playerName: "Shohei Ohtani",
    id: "cardhedge::1721757573073x511086152714813400::920f5eca",
    cardId: "1721757573073x511086152714813400",
  };
  const LEAKED = [SAPPHIRE, MEGA, CHROME, INSERT, VENDOR_33];

  it("drops sub-products when the exact set exists", () => {
    const out = narrowToRequestedVariants(LEAKED, { exactSetKey: "bowman-chrome" });
    expect(out.map((c) => c.setKey)).not.toContain("bowman-chrome-sapphire");
    expect(out.map((c) => c.setKey)).not.toContain("bowman-chrome-mega-box");
  });

  it("drops vendor-keyed rows once a canonical row is present", () => {
    const out = narrowToRequestedVariants(LEAKED, { exactSetKey: "bowman-chrome" });
    expect(out.some((c) => String(c.id).startsWith("cardhedge::"))).toBe(false);
  });

  it("clears the >3 guard on the real prod result", () => {
    const out = narrowToRequestedVariants(LEAKED, { exactSetKey: "bowman-chrome" });
    expect(out.length > 3).toBe(false);
    // Sub-products, the vendor row and the alpha-numbered insert all fall
    // away: 5 leaked candidates resolve to the one base card.
    expect(out.map((c) => c.id)).toEqual([CHROME.id]);
  });

  it("keeps the insert when the query supplies its card number", () => {
    const out = narrowToRequestedVariants(LEAKED, {
      exactSetKey: "bowman-chrome", hasExplicitCardNumber: true,
    });
    expect(out.map((c) => c.id).sort()).toEqual([CHROME.id, INSERT.id].sort());
  });

  it("refuses to substitute a sub-product when the exact set is absent", () => {
    // "2023 Topps Chrome Acuna Base" resolved to topps-chrome-sapphire in prod
    // — a different product at a different price, returned confidently. A miss
    // the caller can seed beats a wrong answer it cannot detect.
    expect(narrowToRequestedVariants([SAPPHIRE, MEGA], { exactSetKey: "bowman-chrome" }))
      .toEqual([]);
  });

  it("answers normally when the sub-product IS what was asked for", () => {
    const out = narrowToRequestedVariants([SAPPHIRE, MEGA], { exactSetKey: "bowman-chrome-sapphire" });
    expect(out.map((c) => c.setKey)).toEqual(["bowman-chrome-sapphire"]);
  });

  it("keeps rows that carry no setKey at all", () => {
    // Legacy rows matched via setName. Absence of evidence is not a mismatch.
    const legacy: CatalogHit = { ...CHROME, setKey: undefined, id: "hiq:legacy:85" };
    expect(narrowToRequestedVariants([SAPPHIRE, legacy], { exactSetKey: "bowman-chrome" }))
      .toEqual([legacy]);
  });

  it("still answers when ONLY vendor rows exist", () => {
    const out = narrowToRequestedVariants([VENDOR_33], { exactSetKey: "bowman-chrome" });
    expect(out).toHaveLength(1);
  });

  it("does nothing when no exact key is supplied", () => {
    expect(narrowToRequestedVariants([SAPPHIRE, MEGA], {})).toHaveLength(2);
  });
});
