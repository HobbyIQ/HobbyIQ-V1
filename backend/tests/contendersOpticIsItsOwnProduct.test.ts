// R62 (Drew, 2026-09-15): PLAYOFF CONTENDERS OPTIC IS ITS OWN PRODUCT.
//
// D31 (2026-08-31) already listed `panini-contenders-optic` among the
// neighbours that must NOT collapse into donruss-optic — "'Optic' names a
// stock those products borrow; it is not this product" — but it was never
// registered, so it collapsed anyway, one product to its LEFT: normalizeSetKey
// took it to `panini-contenders` via the bare `/panini-contenders/` pattern.
//
// Registering it in productSetKeys was NOT enough on its own. normalizeSetKey
// asks productSetKeyForName first, and that resolves by SPELLED name — a bare
// P() entry is not spelled, so the catch-all still answered first. The fix is
// the same shape the panini-prizm-draft-picks keys already use: an explicit
// pattern placed BEFORE the family catch-all.
//
// Evidence it is a product, measured read-only 2026-09-15: 18,397
// checklist-backed catalog rows already carry this setKey (FB2023 7,133 /
// FB2024 5,537 / BK2023 5,727) from checklistinsider, checklistcenter and
// hobbymonitor; and C:/tmp/ci/csv2 ships its checklists as FILES of their own
// with 59-148 sub-sets each — Season Ticket, Rookie Ticket Autographs, X's and
// O's, All-Time Contenders. That is a product's checklist, not a rung ladder.

import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("R62: Playoff Contenders Optic is its own product", () => {
  it("is registered and is a normalizeSetKey FIXED POINT", () => {
    expect(isProductSetKey("panini-contenders-optic")).toBe(true);
    expect(normalizeSetKey("panini-contenders-optic")).toBe("panini-contenders-optic");
  });

  it("no longer collapses into panini-contenders — the defect R62 names", () => {
    // Before R62 this returned "panini-contenders", merging two products'
    // pools: one card, one row, one pool, failing on the product axis.
    expect(normalizeSetKey("panini-contenders-optic")).not.toBe("panini-contenders");
  });

  it("nests under Contenders so the matcher can still widen", () => {
    expect(productParentOf("panini-contenders-optic")).toBe("panini-contenders");
    expect(productFamilyOf("panini-contenders-optic")).toBe("panini-contenders");
  });

  it("leaves panini-contenders itself untouched", () => {
    expect(isProductSetKey("panini-contenders")).toBe(true);
    expect(normalizeSetKey("panini-contenders")).toBe("panini-contenders");
  });

  it("does not rescue UNREGISTERED contenders keys — the pattern is exact", () => {
    // The new rule must be a specialisation, not a hole: anything that is not
    // this product still answers to the family catch-all.
    expect(isProductSetKey("panini-contenders-rookie-ticket")).toBe(false);
    expect(normalizeSetKey("panini-contenders-rookie-ticket")).toBe("panini-contenders");
  });

  it("does not disturb donruss-optic, the product it was collapsing beside", () => {
    expect(normalizeSetKey("donruss-optic")).toBe("donruss-optic");
    expect(normalizeSetKey("panini-optic")).toBe("donruss-optic");
  });
});
