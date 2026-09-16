// R58 as AMENDED (Drew, 2026-09-15, after the grade-source census) — a
// grade says where it came from, and stays.
//
// THE DEFECT. Rivera 1992 Bowman #302 BGS 9, priced 2026-09-15: eight BGS 9
// sales in 90d, of which SIX carried the generic CardHedge product title
// "1992 Bowman Baseball #302 Base" with no grader token in the sale's own
// text at all. Their BGS 9 came from the CardHedge PRODUCT record. Two of
// the six — $67 and $31, a 2:1 price ratio — share an identical soldAt AND
// an identical parallelCanonicalizedAt: one batch payload, every row stamped
// with the product's headline grade.
//
// THE CENSUS said label, don't drop (10,128 graded rows, 2,214 partitions):
//
//     token in title                 9,393   92.7%
//     no token, source cardhedge       596    5.9%
//     no token, other source           139    1.4%
//     of the 596: twin found           126   21.1%, AGREEING 126/126 (100%)
//
// Where a twin exists to check against, the CardHedge product grade was
// right every time. Dropping the class would have removed 470 rows whose
// grades are, on the evidence, correct — and taken this very pool from n=8
// to n=2. So: product-record grades STAY in graded tiers and are LABELLED;
// a twin's title token overrides when one exists.
//
// The census also found the twin lookup MUST be partition-scoped: an
// unscoped first pass surfaced 3 "disagreements", all three price/time
// coincidences between unrelated cards. Scoping eliminated all three.
//
// Fixtures are the real Rivera series with ids scrubbed.
import { describe, it, expect } from "vitest";
import type { ExactPoolRow } from "../src/services/compiq/exactPoolReader.js";
import {
  countGradeSources,
  gradeSourceNote,
  graderTokenInTitle,
  stampGradeSources,
} from "../src/services/compiq/gradeSource.js";

const SLUG = "hiq:baseball:1992:bowman:302:base:no-auto";
const VENDOR_PK = "1588903326082x325049966593310700";

/** The generic CardHedge product title — names no grader. */
const CH_PRODUCT_TITLE = "1992 Bowman Baseball #302 Base";

/**
 * The live Rivera BGS 9 pool: 8 sales, of which 6 carry the generic product
 * title and 2 name BGS 9 in the sale's own text.
 */
function riveraBgs9Pool(): ExactPoolRow[] {
  const row = (
    id: string, price: number, soldAt: string, title: string,
  ): ExactPoolRow => ({
    id, price, soldAt, title,
    gradeCompany: "BGS", gradeValue: 9,
    source: "cardhedge", contributorUserId: null,
    cardId: VENDOR_PK, hobbyiqCardId: SLUG,
  });
  return [
    // Grade IS in the sale's own title.
    row("ch-a", 54.07, "2026-09-13T00:00:00+00:00",
      "1992 Bowman Mariano Rivera BGS Mint 9 #302 Yankees Rookie RC BGS 9"),
    row("ch-b", 96, "2026-07-27T02:30:00+00:00",
      "1992 Bowman #302 Mariano Rivera HOF Yankees Rookie BGS 9 Mint"),
    // Grade came from the PRODUCT RECORD — the title names nothing.
    row("ch-c", 110, "2026-07-24T22:05:00+00:00", CH_PRODUCT_TITLE),
    row("ch-d", 109.99, "2026-07-15T12:27:00+00:00", CH_PRODUCT_TITLE),
    row("ch-e", 48.45, "2026-07-07T01:50:00+00:00", CH_PRODUCT_TITLE),
    row("ch-f", 45, "2026-07-07T01:50:00+00:00", CH_PRODUCT_TITLE),
    // The two that share a soldAt AND a batch stamp, at a 2:1 price ratio.
    row("ch-g", 67, "2026-06-29T00:54:00+00:00", CH_PRODUCT_TITLE),
    row("ch-h", 31, "2026-06-29T00:54:00+00:00", CH_PRODUCT_TITLE),
  ];
}

describe("R58 — the grader token parser", () => {
  it("reads the six named companies, with or without a hyphen or space", () => {
    expect(graderTokenInTitle("… Rookie RC BGS 9")).toEqual({ company: "BGS", value: 9 });
    expect(graderTokenInTitle("… #322 CGC 9.5 MINT+")).toEqual({ company: "CGC", value: 9.5 });
    expect(graderTokenInTitle("… RC PSA-10 Gem")).toEqual({ company: "PSA", value: 10 });
    expect(graderTokenInTitle("… sgc9 …")).toEqual({ company: "SGC", value: 9 });
  });

  it("reads nothing from the generic CardHedge product title", () => {
    expect(graderTokenInTitle(CH_PRODUCT_TITLE)).toBeNull();
    expect(graderTokenInTitle("")).toBeNull();
    expect(graderTokenInTitle(null)).toBeNull();
  });

  it("a grader NOT on R58's list is not evidence (ISA)", () => {
    // The census flagged this explicitly: ISA is not one of the six.
    expect(graderTokenInTitle("… CHROME REFRACTOR 1ST PROSPECT ISA 10")).toBeNull();
  });
});

describe("R58 — the Rivera pool keeps all 8 rows and says where its grades came from", () => {
  it("6 product-record + 2 sale-title; n STAYS 8", () => {
    const rows = riveraBgs9Pool();
    stampGradeSources(rows);

    // THE HEADLINE: nothing is dropped. The amended ruling labels.
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.gradeCompany).toBe("BGS");
      expect(r.gradeValue).toBe(9);
    }

    const counts = countGradeSources(rows);
    expect(counts).toEqual({ "sale-title": 2, "product-record": 6, "twin-title": 0 });
  });

  it("the two rows whose own titles name BGS 9 are sale-title", () => {
    const rows = riveraBgs9Pool();
    stampGradeSources(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("ch-a")!.gradeSource).toBe("sale-title");
    expect(byId.get("ch-b")!.gradeSource).toBe("sale-title");
  });

  it("the six generic-title rows are product-record, including the $67/$31 batch pair", () => {
    const rows = riveraBgs9Pool();
    stampGradeSources(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ["ch-c", "ch-d", "ch-e", "ch-f", "ch-g", "ch-h"]) {
      expect(byId.get(id)!.gradeSource).toBe("product-record");
    }
    // The pair that made the defect visible: same second, 2:1 price ratio,
    // both stamped BGS 9 by the product record and neither by a sale.
    expect(byId.get("ch-g")!.soldAt).toBe(byId.get("ch-h")!.soldAt);
    expect(byId.get("ch-g")!.price / byId.get("ch-h")!.price).toBeCloseTo(2.16, 1);
  });

  it("the basis sentence names the split", () => {
    const rows = riveraBgs9Pool();
    stampGradeSources(rows);
    expect(gradeSourceNote(countGradeSources(rows)))
      .toBe("grades: 2 from sale titles, 6 from the vendor product record");
  });
});

describe("R58 — a twin's title token overrides a product-record grade", () => {
  /** A product-record row with a ch-fill twin whose title names a grader. */
  function pairWithTwin(twinTitle: string, twinOverrides: { cardId: string }) {
    const productRecord: ExactPoolRow = {
      id: "ch-daily-1", price: 96, soldAt: "2026-07-27T02:30:00+00:00",
      title: CH_PRODUCT_TITLE,
      gradeCompany: "BGS", gradeValue: 9,
      source: "cardhedge", contributorUserId: null,
      cardId: VENDOR_PK, hobbyiqCardId: SLUG,
    };
    const twin: ExactPoolRow = {
      id: "ch-fill-1", price: 96, soldAt: "2026-07-27T02:30:04.000Z",
      title: twinTitle,
      gradeCompany: "BGS", gradeValue: 9,
      source: "cardhedge", contributorUserId: null,
      cardId: twinOverrides.cardId, hobbyiqCardId: SLUG,
    };
    return [productRecord, twin];
  }

  it("an AGREEING twin promotes the row to twin-title, grade unchanged (the census's 126/126)", () => {
    const rows = pairWithTwin(
      "1992 Bowman Mariano Rivera Rookie RC #302 BGS 9 Mint",
      { cardId: SLUG },      // the PAIRED partition
    );
    stampGradeSources(rows);
    expect(rows[0].gradeSource).toBe("twin-title");
    expect(rows[0].gradeCompany).toBe("BGS");
    expect(rows[0].gradeValue).toBe(9);
    expect(rows[0].gradeOverriddenFrom).toBeUndefined();
  });

  it("a DISAGREEING twin wins — the twin's grade replaces the product record's", () => {
    const rows = pairWithTwin(
      "1992 Bowman Mariano Rivera Rookie RC #302 PSA 8",
      { cardId: SLUG },
    );
    stampGradeSources(rows);
    // The sale's own text said PSA 8; the vendor's product record said BGS 9.
    expect(rows[0].gradeSource).toBe("twin-title");
    expect(rows[0].gradeCompany).toBe("PSA");
    expect(rows[0].gradeValue).toBe(8);
    // The override is auditable, not silent.
    expect(rows[0].gradeOverriddenFrom).toBe("BGS 9");
  });

  it("the twin itself is settled on its own title, not by looking at anyone", () => {
    const rows = pairWithTwin(
      "1992 Bowman Mariano Rivera Rookie RC #302 BGS 9 Mint",
      { cardId: SLUG },
    );
    stampGradeSources(rows);
    expect(rows[1].gradeSource).toBe("sale-title");
  });
});

describe("R58 — the twin lookup is PARTITION-SCOPED (the census's 3 false disagreements)", () => {
  /** Same price, same second, a real grader token — but a different card. */
  const unrelatedCard: ExactPoolRow = {
    id: "unrelated-1", price: 96, soldAt: "2026-07-27T02:30:02.000Z",
    title: "2026 Pokemon Mega Evolution Perfect Order #21 PSA 8",
    gradeCompany: "PSA", gradeValue: 8,
    source: "tca-ebay", contributorUserId: null,
    cardId: "hiq:pokemon:2026:mega-evolution:21:base:no-auto",
    hobbyiqCardId: "hiq:pokemon:2026:mega-evolution:21:base:no-auto",
  };

  it("MUTATION CHECK: a price/time coincidence in ANOTHER partition is not a twin", () => {
    const productRecord: ExactPoolRow = {
      id: "ch-daily-1", price: 96, soldAt: "2026-07-27T02:30:00+00:00",
      title: CH_PRODUCT_TITLE,
      gradeCompany: "BGS", gradeValue: 9,
      source: "cardhedge", contributorUserId: null,
      cardId: VENDOR_PK, hobbyiqCardId: SLUG,
    };
    const rows = [productRecord, { ...unrelatedCard }];
    stampGradeSources(rows);
    // Unscoped, this is exactly the shape that produced the census's 3 false
    // disagreements. Scoped, the Rivera row keeps its own grade.
    expect(rows[0].gradeSource).toBe("product-record");
    expect(rows[0].gradeCompany).toBe("BGS");
    expect(rows[0].gradeValue).toBe(9);
    expect(rows[0].gradeOverriddenFrom).toBeUndefined();
  });

  it("the vendor partition and the hiq slug ARE a pair (shared identity key)", () => {
    // A vendor-partition row carries the slug on hobbyiqCardId — that is the
    // pairing, and it is how the engine's cross-partition OR found both.
    const vendorRow: ExactPoolRow = {
      id: "v", price: 96, soldAt: "2026-07-27T02:30:00Z", title: CH_PRODUCT_TITLE,
      gradeCompany: "BGS", gradeValue: 9, cardId: VENDOR_PK, hobbyiqCardId: SLUG,
    };
    const slugRow: ExactPoolRow = {
      id: "s", price: 96, soldAt: "2026-07-27T02:30:10Z",
      title: "1992 Bowman Mariano Rivera #302 BGS 9",
      gradeCompany: "BGS", gradeValue: 9, cardId: SLUG, hobbyiqCardId: SLUG,
    };
    const rows = [vendorRow, slugRow];
    stampGradeSources(rows);
    expect(rows[0].gradeSource).toBe("twin-title");
  });

  it("MUTATION CHECK: outside the 60s window is not a twin", () => {
    const rows: ExactPoolRow[] = [
      { id: "a", price: 96, soldAt: "2026-07-27T02:30:00Z", title: CH_PRODUCT_TITLE,
        gradeCompany: "BGS", gradeValue: 9, cardId: VENDOR_PK, hobbyiqCardId: SLUG },
      { id: "b", price: 96, soldAt: "2026-07-27T02:35:00Z", title: "… #302 PSA 8",
        gradeCompany: "PSA", gradeValue: 8, cardId: SLUG, hobbyiqCardId: SLUG },
    ];
    stampGradeSources(rows);
    expect(rows[0].gradeSource).toBe("product-record");
    expect(rows[0].gradeValue).toBe(9);
  });

  it("MUTATION CHECK: a different price is not a twin", () => {
    const rows: ExactPoolRow[] = [
      { id: "a", price: 96, soldAt: "2026-07-27T02:30:00Z", title: CH_PRODUCT_TITLE,
        gradeCompany: "BGS", gradeValue: 9, cardId: VENDOR_PK, hobbyiqCardId: SLUG },
      { id: "b", price: 67, soldAt: "2026-07-27T02:30:05Z", title: "… #302 PSA 8",
        gradeCompany: "PSA", gradeValue: 8, cardId: SLUG, hobbyiqCardId: SLUG },
    ];
    stampGradeSources(rows);
    expect(rows[0].gradeSource).toBe("product-record");
  });

  it("MUTATION CHECK: a row is never its own twin", () => {
    const only: ExactPoolRow[] = [{
      id: "solo", price: 96, soldAt: "2026-07-27T02:30:00Z", title: CH_PRODUCT_TITLE,
      gradeCompany: "BGS", gradeValue: 9, cardId: VENDOR_PK, hobbyiqCardId: SLUG,
    }];
    stampGradeSources(only);
    expect(only[0].gradeSource).toBe("product-record");
  });
});

describe("R58 — a clean pool is untouched and says nothing", () => {
  it("MUTATION CHECK: every grade from a sale title => no note, no change", () => {
    const rows: ExactPoolRow[] = [
      { id: "a", price: 100, soldAt: "2026-09-10T00:00:00Z",
        title: "2020 Bowman Chrome … PSA 10 Gem Mint",
        gradeCompany: "PSA", gradeValue: 10, cardId: SLUG, hobbyiqCardId: SLUG },
      { id: "b", price: 105, soldAt: "2026-09-08T00:00:00Z",
        title: "2020 Bowman Chrome … PSA 10",
        gradeCompany: "PSA", gradeValue: 10, cardId: SLUG, hobbyiqCardId: SLUG },
      { id: "c", price: 98, soldAt: "2026-09-05T00:00:00Z",
        title: "2020 Bowman Chrome … PSA 10 GEM",
        gradeCompany: "PSA", gradeValue: 10, cardId: SLUG, hobbyiqCardId: SLUG },
    ];
    const before = rows.map((r) => `${r.gradeCompany} ${r.gradeValue} ${r.price}`);
    stampGradeSources(rows);

    const counts = countGradeSources(rows);
    expect(counts).toEqual({ "sale-title": 3, "product-record": 0, "twin-title": 0 });
    // The sentence is emitted ONLY when there is something to caveat.
    expect(gradeSourceNote(counts)).toBeNull();
    // Output unchanged: same grades, same prices, same count.
    expect(rows.map((r) => `${r.gradeCompany} ${r.gradeValue} ${r.price}`)).toEqual(before);
    expect(rows).toHaveLength(3);
  });

  it("ungraded (raw) rows are out of scope entirely", () => {
    const rows: ExactPoolRow[] = [
      { id: "raw1", price: 58, soldAt: "2026-07-24T00:14:00Z",
        title: "1992 Bowman Mariano Rivera #302 Rookie RC HOF - Raw",
        gradeCompany: null, gradeValue: null, cardId: SLUG, hobbyiqCardId: SLUG },
    ];
    stampGradeSources(rows);
    expect(rows[0].gradeSource).toBeUndefined();
    expect(countGradeSources(rows))
      .toEqual({ "sale-title": 0, "product-record": 0, "twin-title": 0 });
  });

  it("the note counts twin-title rows as title evidence, because they are", () => {
    expect(gradeSourceNote({ "sale-title": 2, "product-record": 6, "twin-title": 0 }))
      .toBe("grades: 2 from sale titles, 6 from the vendor product record");
    expect(gradeSourceNote({ "sale-title": 1, "product-record": 2, "twin-title": 3 }))
      .toBe("grades: 4 from sale titles, 2 from the vendor product record");
    expect(gradeSourceNote({ "sale-title": 0, "product-record": 1, "twin-title": 0 }))
      .toBe("grades: 1 from the vendor product record");
  });
});

describe("R58 — classification runs BEFORE dedupe, which is the whole trick", () => {
  it("a ch-daily row and its token-carrying ch-fill twin collapse under dedupe", async () => {
    // dedupeSoldComps buckets by (gradeKey, price) and keeps the FIRST row of
    // each cluster. The copy carrying the grader token is exactly the one
    // that gets dropped — so if classification ran after dedupe, the
    // surviving row would be stamped product-record and the twin's evidence
    // lost. This pins the ordering the engine relies on.
    const { dedupeSoldComps } = await import("../src/services/portfolioiq/dedupeSoldComps.js");
    const rows: ExactPoolRow[] = [
      { id: "ch-daily", price: 96, soldAt: "2026-07-27T02:30:00Z", title: CH_PRODUCT_TITLE,
        gradeCompany: "BGS", gradeValue: 9, cardId: VENDOR_PK, hobbyiqCardId: SLUG },
      { id: "ch-fill", price: 96, soldAt: "2026-07-27T02:30:04Z",
        title: "1992 Bowman Mariano Rivera #302 BGS 9 Mint",
        gradeCompany: "BGS", gradeValue: 9, cardId: SLUG, hobbyiqCardId: SLUG },
    ];
    // Classify first (what the engine does), THEN dedupe.
    stampGradeSources(rows);
    const kept = dedupeSoldComps(rows as any) as unknown as ExactPoolRow[];

    // Dedupe collapsed the pair to one row …
    expect(kept).toHaveLength(1);
    // … and the survivor carries the evidence its twin brought.
    expect(kept[0].gradeSource).toBe("twin-title");
  });
});
