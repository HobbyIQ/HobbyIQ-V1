// CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04).
//
// Drew's standing ruling (2026-09-01): a published FMV needs three
// INDEPENDENT sellers behind it on every path. The engine could not
// evaluate that sentence and did not say so.
//
// `SELF_COMP_MIN_OTHER_SAMPLES = 3` counted ROWS (`others.length >= 3`).
// Three rows is not three sellers: one consignor's three sales satisfy a
// row count exactly as well as three unrelated people do. And it could not
// have counted sellers even if it wanted to — measured read-only in prod
// 2026-09-04 over 90 days of soldAt in sold_comps:
//
//     cardhedge  4,492,670 rows / 0 sellers    tca-ebay 2,116,858 / 0
//     cardsight    261,713 / 0                 ebay-user-purchase 140 / 24
//     ebay-account      22 / 0                 ebay-user-sale 13 / 0
//
// The field is `sellerHandle` (there is no sellerId/sellerName on the
// container); soldCompsStore persists it and every ingest call site but one
// passed a literal `null`. readExactPoolRows did not even project it.
//
// These pins hold the rule: independence is answered on seller identity
// when identity is visible, and when it is not the answer NAMES itself
// `row-count` and no surface may claim seller independence from it.
import { describe, it, expect } from "vitest";
import {
  assessSellerIndependence,
  normalizeSellerHandle,
  sellerHandleFromHolding,
  MIN_INDEPENDENT_SELLERS,
  INDEPENDENCE_UNVERIFIED_CODE,
} from "../src/services/compiq/sellerIndependence.js";

describe("assessSellerIndependence — the basis is never implied", () => {
  it("counts DISTINCT SELLERS, not rows, when every row carries a handle", () => {
    // The defect in one assertion: three rows, one seller. A row count says
    // 3 and publishes; the seller count says 1 and must not.
    const oneSellerThreeSales = [
      { sellerHandle: "probstein123" },
      { sellerHandle: "probstein123" },
      { sellerHandle: "probstein123" },
    ];
    const v = assessSellerIndependence(oneSellerThreeSales);
    expect(v.basis).toBe("seller-identity");
    expect(v.count).toBe(1);
    expect(v.meets).toBe(false);
  });

  it("meets the threshold on three genuinely different sellers", () => {
    const v = assessSellerIndependence([
      { sellerHandle: "dcsports87" },
      { sellerHandle: "comc_consignment" },
      { sellerHandle: "old_cards_crib" },
    ]);
    expect(v.basis).toBe("seller-identity");
    expect(v.count).toBe(MIN_INDEPENDENT_SELLERS);
    expect(v.meets).toBe(true);
  });

  it("is case- and whitespace-insensitive: one seller cannot become two", () => {
    const v = assessSellerIndependence([
      { sellerHandle: "DCSports87" },
      { sellerHandle: " dcsports87 " },
      { sellerHandle: "dcsports87" },
    ]);
    expect(v.count).toBe(1);
    expect(v.meets).toBe(false);
  });

  it("falls back to row-count and SAYS SO when any row lacks a seller", () => {
    // The production shape: vendor rows carry no seller at all.
    const v = assessSellerIndependence([{}, {}, {}, {}]);
    expect(v.basis).toBe("row-count");
    expect(v.count).toBe(4);
    expect(v.rowsMissingSeller).toBe(4);
    // `meets` is true because the ROWS clear the floor — the legacy
    // behaviour is preserved exactly — but `basis` is what forbids anyone
    // downstream from calling this seller independence.
    expect(v.meets).toBe(true);
    expect(v.basis).not.toBe("seller-identity");
  });

  it("a single missing handle collapses the basis rather than undercounting", () => {
    // Two named sellers + forty anonymous rows must NOT report
    // "2 independent sellers" with the authority of an identity check.
    const rows = [
      { sellerHandle: "dcsports87" },
      { sellerHandle: "comc_consignment" },
      ...Array.from({ length: 40 }, () => ({})),
    ];
    const v = assessSellerIndependence(rows);
    expect(v.basis).toBe("row-count");
    expect(v.count).toBe(42);
    expect(v.rowsMissingSeller).toBe(40);
  });

  it("an empty pool is `no-rows` and never meets the threshold", () => {
    const v = assessSellerIndependence([]);
    expect(v.basis).toBe("no-rows");
    expect(v.meets).toBe(false);
  });

  it("treats blank / non-string handles as absent, not as a seller named ''", () => {
    expect(normalizeSellerHandle("")).toBeNull();
    expect(normalizeSellerHandle("   ")).toBeNull();
    expect(normalizeSellerHandle(null)).toBeNull();
    expect(normalizeSellerHandle(undefined)).toBeNull();
    expect(normalizeSellerHandle(42)).toBeNull();
    const v = assessSellerIndependence([{ sellerHandle: "" }, { sellerHandle: "a" }]);
    expect(v.basis).toBe("row-count");
  });
});

describe("sellerHandleFromHolding — the identity was on the holding all along", () => {
  it("reads the enriched eBay seller object prod actually stores", () => {
    // Verbatim shape from prod (2026-09-04): all 111 eBay-sourced holdings.
    expect(sellerHandleFromHolding({
      ebayImageUrl: "https://i.ebayimg.com/x.jpg",
      ebaySeller: { username: "den-of-786-cards", feedbackScore: 280 },
    })).toBe("den-of-786-cards");
  });

  it("takes ONLY the username — feedbackScore is reputation, not identity", () => {
    const h = { ebaySeller: { username: "Old_Cards_Crib", feedbackScore: 1431 } };
    expect(sellerHandleFromHolding(h)).toBe("old_cards_crib");
  });

  it("returns null for a holding with no eBay enrichment", () => {
    expect(sellerHandleFromHolding({ ebayImageUrl: "x" })).toBeNull();
    expect(sellerHandleFromHolding({})).toBeNull();
    expect(sellerHandleFromHolding(null)).toBeNull();
    expect(sellerHandleFromHolding(undefined)).toBeNull();
  });

  it("accepts a bare string handle for legacy holdings", () => {
    expect(sellerHandleFromHolding({ ebaySeller: "probstein123" })).toBe("probstein123");
  });
});

describe("the label vocabulary", () => {
  it("names the unverified case explicitly", () => {
    // A string a client renders and a human reads. Pinned so it cannot be
    // quietly renamed into something that sounds verified.
    expect(INDEPENDENCE_UNVERIFIED_CODE).toBe("independence-unverified");
  });
});
