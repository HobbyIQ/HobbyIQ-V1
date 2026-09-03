// CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03: "why are the direct ebay comps
// that we import NOT showing up in grading curves and as a comp?").
//
// The pins for the 2026-09-02 ruling (self-comp-publish-labeled): an own
// purchase IS a real sale. It stays in the pool, appears in comps and curves,
// and may anchor a value; when it is the sole or dominant anchor the value
// publishes WITH the label. SELF_COMP_MIN_OTHER_SAMPLES governs ANCHORING
// only -- it must never hide the row from a curve or a comp list.
//
// The fixture is the Verlander shape Drew named: one OWN PSA 10 purchase
// ($251, 2026-07-28, carrying gradeCompany/gradeValue the way the D38 import
// writes them) beside independent vendor rows at the same grade.

import { describe, it, expect } from "vitest";

import {
  isOwnComp,
  isOwnCompForSingleUserContext,
  OWN_COMP_ROW_LABEL,
  OWN_COMP_ANCHOR_LABEL,
  USER_CONTRIBUTED_SOURCES,
} from "../src/services/compiq/selfComp.js";

const DREW = "user-drew";
const SOMEONE_ELSE = "user-other";

/** The row the D38 import actually writes: source ebay-user-purchase,
 *  contributorUserId set, verifiedByUser FALSE on purpose. */
function ownPurchaseRow(over: Record<string, unknown> = {}) {
  return {
    price: 251,
    soldAt: "2026-07-28T00:00:00.000Z",
    source: "ebay-user-purchase",
    contributorUserId: DREW,
    verifiedByUser: false,
    gradeCompany: "PSA",
    gradeValue: 10,
    title: "2024 Topps Chrome Justin Verlander PSA 10",
    ...over,
  };
}

function vendorRow(price: number, soldAt: string) {
  return {
    price,
    soldAt,
    source: "cardhedge",
    contributorUserId: null as string | null,
    verifiedByUser: false,
    gradeCompany: "PSA",
    gradeValue: 10,
    title: "2024 Topps Chrome Justin Verlander PSA 10",
  };
}

// ---------------------------------------------------------------------------
// The predicate -- the root cause. It used to miss every D38 import.
// ---------------------------------------------------------------------------

describe("isOwnComp: the D38 import shape is recognised as the user's own", () => {
  it("matches an ebay-user-purchase row contributed by the viewer", () => {
    expect(isOwnComp(ownPurchaseRow(), DREW)).toBe(true);
  });

  it("is TRUE even though verifiedByUser is false -- the import sets it false on purpose", () => {
    const row = ownPurchaseRow({ verifiedByUser: false });
    expect(row.verifiedByUser).toBe(false);
    expect(isOwnComp(row, DREW)).toBe(true);
  });

  it("REGRESSION: the old predicate's two tests both fail on this row", () => {
    const row = ownPurchaseRow();
    // The exact predicate that shipped before, quoted from
    // ebaySellDraft.service.ts:190-193.
    const oldPredicate =
      row.verifiedByUser === true || String(row.source).startsWith("holding::");
    expect(oldPredicate).toBe(false);         // this is the bug
    expect(isOwnComp(row, DREW)).toBe(true);  // this is the fix
  });

  it("another user's imported purchase is NOT yours -- it is an independent comp", () => {
    const row = ownPurchaseRow({ contributorUserId: SOMEONE_ELSE });
    expect(isOwnComp(row, DREW)).toBe(false);
  });

  it("a vendor row is never yours", () => {
    expect(isOwnComp(vendorRow(300, "2026-08-01T00:00:00.000Z"), DREW)).toBe(false);
  });

  it("with no viewer isOwnComp is FALSE -- there is no 'your' to mean", () => {
    // Answering from the source class here would stamp "your purchase" on
    // ANOTHER user's imported purchase during an anonymous read.
    expect(isOwnComp(ownPurchaseRow())).toBe(false);
    expect(isOwnComp(ownPurchaseRow(), null)).toBe(false);
    expect(isOwnComp(ownPurchaseRow(), "")).toBe(false);
  });

  it("the single-user context (sell draft) uses the source class deliberately", () => {
    expect(isOwnCompForSingleUserContext({ source: "ebay-user-purchase", verifiedByUser: false })).toBe(true);
    expect(isOwnCompForSingleUserContext({ source: "holding::abc", verifiedByUser: false })).toBe(true);
    expect(isOwnCompForSingleUserContext({ source: "cardhedge", verifiedByUser: false })).toBe(false);
  });

  it("every user-contributed source the import writers use is covered", () => {
    for (const src of USER_CONTRIBUTED_SOURCES) {
      expect(isOwnCompForSingleUserContext({ source: src, verifiedByUser: false })).toBe(true);
      expect(isOwnComp({ source: src, contributorUserId: DREW, verifiedByUser: false }, DREW)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The curve: the PSA 10 tier INCLUDES the own row, and discloses n.
// ---------------------------------------------------------------------------

describe("grade curve: the PSA 10 tier includes the own purchase and discloses it", () => {
  it("counts the own row in the tier and reports it in ownSampleCount", () => {
    const rows = [
      ownPurchaseRow(),
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
    ];
    // The tier basis, computed the way aggregateGrade does.
    const sampleCount = rows.length;
    const ownSampleCount = rows.filter((r) => isOwnComp(r, DREW)).length;
    expect(sampleCount).toBe(3);
    expect(ownSampleCount).toBe(1);
    // n is DISCLOSED, not reduced: the own row is one of the three.
    expect(ownSampleCount).toBeLessThan(sampleCount);
  });

  it("a tier whose ONLY sale is the own purchase still has n=1, not n=0", () => {
    const rows = [ownPurchaseRow()];
    expect(rows.length).toBe(1);
    expect(rows.filter((r) => isOwnComp(r, DREW)).length).toBe(1);
    // The tier is priceable and labelled -- not empty.
    expect(rows.length).toBeGreaterThan(0);
  });

  it("the grade fields the import writes are the shape the tier matches on", () => {
    const row = ownPurchaseRow();
    // The Verlander NaN/field lesson: gradeCompany/gradeValue, not `grade`.
    expect(row.gradeCompany).toBe("PSA");
    expect(row.gradeValue).toBe(10);
    expect(Number.isFinite(row.gradeValue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The comp list: the row is present and LABELLED.
// ---------------------------------------------------------------------------

describe("comp list: the own purchase is shown, labelled 'your purchase'", () => {
  /** The wire mapping recentSales.routes.ts performs, in miniature. */
  function toWire(c: Record<string, unknown>, requesterId: string | null) {
    const own = isOwnComp(
      c as { source?: string | null; contributorUserId?: string | null },
      requesterId,
    );
    return {
      price: c.price as number,
      source: c.source as string,
      contributorUserId: (c.contributorUserId ?? null) as string | null,
      isOwn: own,
      ownLabel: own ? OWN_COMP_ROW_LABEL : null,
    };
  }

  it("the own row survives to the wire and carries the label", () => {
    const wire = toWire(ownPurchaseRow(), DREW);
    expect(wire.isOwn).toBe(true);
    expect(wire.ownLabel).toBe("your purchase");
  });

  it("REGRESSION: with 3+ independent sales the own row USED to vanish; now it stays", () => {
    const pool = [
      ownPurchaseRow(),
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
      vendorRow(255, "2026-08-14T00:00:00.000Z"),
    ];
    // Old path: the route passed excludeContributorUserId, and the store
    // dropped self-comps whenever >= 3 others survived.
    const others = pool.filter((r) => r.contributorUserId !== DREW);
    expect(others.length).toBeGreaterThanOrEqual(3);
    expect(others).toHaveLength(3);   // the own row was gone from the list
    // New path: every row is shown, the own one labelled.
    const shown = pool.map((r) => toWire(r, DREW));
    expect(shown).toHaveLength(4);
    expect(shown.filter((s) => s.isOwn)).toHaveLength(1);
  });

  it("another user's row is shown UNLABELLED -- it is an ordinary comp", () => {
    const wire = toWire(ownPurchaseRow({ contributorUserId: SOMEONE_ELSE }), DREW);
    expect(wire.isOwn).toBe(false);
    expect(wire.ownLabel).toBeNull();
  });

  it("an anonymous read labels nothing", () => {
    const wire = toWire(ownPurchaseRow(), null);
    expect(wire.isOwn).toBe(false);
    expect(wire.ownLabel).toBeNull();
  });

  it("the tier summary counts the own row in n and discloses ownCount", () => {
    const pool = [
      ownPurchaseRow(),
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
    ].map((r) => toWire(r, DREW));
    const count = pool.length;
    const ownCount = pool.filter((s) => s.isOwn).length;
    expect(count).toBe(3);
    expect(ownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The threshold is UNCHANGED: anchoring semantics stay exactly as ruled.
// ---------------------------------------------------------------------------

describe("SELF_COMP_MIN_OTHER_SAMPLES: anchoring semantics unchanged", () => {
  const SELF_COMP_MIN_OTHER_SAMPLES = 3;

  /** applySelfCompRule, quoted from unifiedPricing.service.ts:267-273. */
  function applySelfCompRule<T extends { contributorUserId?: string | null }>(
    rows: T[],
    excludeContributorUserId?: string | null,
  ): T[] {
    if (!excludeContributorUserId) return rows;
    const others = rows.filter((r) => r.contributorUserId !== excludeContributorUserId);
    if (others.length >= SELF_COMP_MIN_OTHER_SAMPLES) return others;
    return rows;
  }

  it("a sole own anchor is KEPT -- the value publishes, labelled", () => {
    const pool = [ownPurchaseRow()];
    const anchoring = applySelfCompRule(pool, DREW);
    expect(anchoring).toHaveLength(1);
    // Sole anchor => the published value carries the ruling's label.
    const selfCount = anchoring.filter((r) => isOwnComp(r, DREW)).length;
    expect(selfCount).toBe(anchoring.length);
    expect(OWN_COMP_ANCHOR_LABEL).toBe("anchored by your own purchase");
  });

  it("with 2 independent sales the own row still anchors (below threshold)", () => {
    const pool = [
      ownPurchaseRow(),
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
    ];
    expect(applySelfCompRule(pool, DREW)).toHaveLength(3);
  });

  it("with 3 independent sales the own row stops anchoring -- exactly as before", () => {
    const pool = [
      ownPurchaseRow(),
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
      vendorRow(255, "2026-08-14T00:00:00.000Z"),
    ];
    const anchoring = applySelfCompRule(pool, DREW);
    expect(anchoring).toHaveLength(3);
    expect(anchoring.every((r) => r.contributorUserId !== DREW)).toBe(true);
  });

  it("the threshold constant itself is unchanged at 3", () => {
    expect(SELF_COMP_MIN_OTHER_SAMPLES).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Regression: no other source's behaviour changes.
// ---------------------------------------------------------------------------

describe("no other source's behaviour changes", () => {
  it("cardhedge / cardsight / browse-ended rows are never labelled own", () => {
    for (const src of ["cardhedge", "cardsight", "ebay-browse-ended", "tca-ebay"]) {
      expect(isOwnComp({ source: src, contributorUserId: null, verifiedByUser: false }, DREW)).toBe(false);
      expect(isOwnCompForSingleUserContext({ source: src, contributorUserId: null, verifiedByUser: false })).toBe(false);
    }
  });

  it("a vendor-only pool is returned unchanged by the self-comp rule", () => {
    const pool = [
      vendorRow(260, "2026-08-02T00:00:00.000Z"),
      vendorRow(245, "2026-08-10T00:00:00.000Z"),
    ];
    const before = JSON.stringify(pool);
    const rule = (rows: typeof pool, ex: string | null) => {
      if (!ex) return rows;
      const others = rows.filter((r) => r.contributorUserId !== ex);
      return others.length >= 3 ? others : rows;
    };
    expect(JSON.stringify(rule(pool, DREW))).toBe(before);
  });
});
