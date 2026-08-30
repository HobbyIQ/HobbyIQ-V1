/**
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, 2026-08-30) — the two store
 * pieces the poll leans on.
 *
 *  1. `findSellerHoldingForIdentity` — the holding ladder (deliverable 3):
 *     exact identity + grade, then the identity un-graded. It WALKS
 *     `Object.values(doc.holdings)`, because `holdings` is a MAP keyed by
 *     holding id and a `JOIN h IN c.holdings` iterates nothing (#1538). The
 *     walk reports how many holdings it examined and refuses on zero.
 *
 *  2. `upsertEbayAccountSale` — idempotent on (ebayOrderId, lineItemId). The
 *     poll re-fetches an hour of overlap on every cycle by design, and the
 *     backfill replays ninety days, so a replay that is not a no-op would
 *     rewrite every user doc every hour.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

import {
  readUserDoc,
  writeUserDoc,
  findSellerHoldingForIdentity,
  upsertEbayAccountSale,
  listEbayAccountSales,
  ebayAccountSaleId,
  EBAY_ACCOUNT_SALES_MAX,
  type EbayAccountSaleEntry,
} from "../src/services/portfolioiq/portfolioStore.service.js";

const SLUG = "hiq:baseball:2018:topps-chrome:150:refractor:no-auto";
const OTHER = "hiq:baseball:2024:bowman-chrome:bcp-14:gold-refractor:auto:num-50";

let USER: string;

function holding(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(over.id ?? randomUUID());
  return {
    id,
    playerName: "Shohei Ohtani",
    cardYear: 2018,
    setName: "Topps Chrome",
    cardNumber: "150",
    parallel: "Refractor",
    isAuto: false,
    quantity: 1,
    hobbyiqCardId: SLUG,
    cardId: SLUG,
    ...over,
  };
}

async function seed(holdings: Record<string, unknown>[]): Promise<void> {
  const doc = await readUserDoc(USER);
  doc.holdings = {};
  for (const h of holdings) doc.holdings[String(h.id)] = h as never;
  await writeUserDoc(USER, doc);
}

beforeEach(() => {
  USER = `user-d26-${randomUUID()}`;
});

describe("D26 — findSellerHoldingForIdentity: the ladder", () => {
  it("prefers the exact identity AND the same grade", async () => {
    await seed([
      holding({ id: "raw", gradeCompany: null, gradeValue: null }),
      holding({ id: "psa10", gradeCompany: "PSA", gradeValue: 10 }),
      holding({ id: "psa9", gradeCompany: "PSA", gradeValue: 9 }),
    ]);
    const m = await findSellerHoldingForIdentity(USER, SLUG, { gradeCompany: "PSA", gradeValue: 10 });
    expect(m?.holdingId).toBe("psa10");
    expect(m?.matchedBy).toBe("identity-and-grade");
    expect(m?.holdingsWalked).toBe(3);
  });

  it("falls back to the identity UN-GRADED when the graded copy is not held", async () => {
    await seed([holding({ id: "raw", gradeCompany: null, gradeValue: null })]);
    const m = await findSellerHoldingForIdentity(USER, SLUG, { gradeCompany: "PSA", gradeValue: 10 });
    expect(m?.holdingId).toBe("raw");
    expect(m?.matchedBy).toBe("identity-ungraded");
  });

  it("a raw sale matches the raw holding as an exact grade match, not a fallback", async () => {
    await seed([holding({ id: "raw", gradeCompany: null, gradeValue: null })]);
    const m = await findSellerHoldingForIdentity(USER, SLUG, {});
    expect(m?.holdingId).toBe("raw");
    expect(m?.matchedBy).toBe("identity-and-grade");
  });

  it("a graded sale NEVER matches a DIFFERENTLY-graded holding", async () => {
    // A PSA 9 is not the PSA 10 that sold. Marking it sold would remove the
    // wrong card from inventory and book the wrong cost basis.
    await seed([holding({ id: "psa9", gradeCompany: "PSA", gradeValue: 9 })]);
    const m = await findSellerHoldingForIdentity(USER, SLUG, { gradeCompany: "PSA", gradeValue: 10 });
    expect(m).toBeNull();
  });

  it("never crosses identities", async () => {
    await seed([holding({ id: "other", hobbyiqCardId: OTHER, cardId: OTHER })]);
    expect(await findSellerHoldingForIdentity(USER, SLUG, {})).toBeNull();
  });

  it("ignores a holding with no pinned hiq slug — a vendor id is not an identity", async () => {
    await seed([holding({ id: "vendorish", hobbyiqCardId: null, cardId: "1712345678901x999" })]);
    expect(await findSellerHoldingForIdentity(USER, SLUG, {})).toBeNull();
  });

  it("WALKS the holdings map: a user with holdings is examined, an empty one refuses", async () => {
    await seed([]);
    expect(await findSellerHoldingForIdentity(USER, SLUG, {})).toBeNull();
    await seed([holding({ id: "psa10", gradeCompany: "PSA", gradeValue: 10 })]);
    const m = await findSellerHoldingForIdentity(USER, SLUG, { gradeCompany: "PSA", gradeValue: 10 });
    expect(m?.holdingsWalked).toBe(1);
  });

  it("an empty slug or userId is refused rather than matching everything", async () => {
    await seed([holding({ id: "psa10", gradeCompany: "PSA", gradeValue: 10 })]);
    expect(await findSellerHoldingForIdentity(USER, "", {})).toBeNull();
    expect(await findSellerHoldingForIdentity("", SLUG, {})).toBeNull();
  });
});

function sale(over: Partial<EbayAccountSaleEntry> = {}): Omit<EbayAccountSaleEntry, "id" | "observedAt"> {
  return {
    ebayOrderId: "ORD-1",
    lineItemId: "LI-1",
    ebayListingId: "1234567890",
    soldAt: "2026-08-20T12:00:00.000Z",
    title: "2018 Topps Chrome Shohei Ohtani #150 Refractor PSA 10",
    quantity: 1,
    unitSalePrice: 412.5,
    currency: "USD",
    buyerUsername: "a_buyer",
    status: "resolved",
    cardId: SLUG,
    proposedIdentity: null,
    unresolvedReason: null,
    fields: {
      sport: "baseball", year: 2018, setName: "Topps Chrome", player: "Shohei Ohtani",
      cardNumber: "150", parallel: "Refractor", isAuto: false, printRun: null,
      gradeCompany: "PSA", gradeValue: 10,
    },
    imageUrl: null,
    holdingId: null,
    holdingMatchedBy: null,
    poolRowId: "sc-1",
    poolWrittenBy: "ebay-account",
    ...over,
  } as Omit<EbayAccountSaleEntry, "id" | "observedAt">;
}

describe("D26 — upsertEbayAccountSale: idempotent on (orderId, lineItemId)", () => {
  it("first write creates; the identical replay writes NOTHING", async () => {
    const a = await upsertEbayAccountSale(USER, sale());
    expect(a.replay).toBe(false);
    expect(a.written).toBe(true);
    expect(a.entry.id).toBe(ebayAccountSaleId("ORD-1", "LI-1"));

    const b = await upsertEbayAccountSale(USER, sale());
    expect(b.replay).toBe(true);
    expect(b.written).toBe(false);

    const doc = await readUserDoc(USER);
    expect(doc.ebayAccountSales).toHaveLength(1);
  });

  it("a replay whose resolution IMPROVED updates in place and keeps observedAt", async () => {
    const first = await upsertEbayAccountSale(USER, sale({
      status: "parked", cardId: null,
      proposedIdentity: { slug: SLUG, confidence: 0.72, matchedBy: "fuzzy-parallel" },
      poolRowId: null, poolWrittenBy: null,
    }));
    const observedAt = first.entry.observedAt;

    const second = await upsertEbayAccountSale(USER, sale());
    expect(second.replay).toBe(true);
    expect(second.written).toBe(true);
    expect(second.entry.status).toBe("resolved");
    expect(second.entry.cardId).toBe(SLUG);
    // observedAt is when WE first saw the sale; a re-resolution never rewrites it.
    expect(second.entry.observedAt).toBe(observedAt);

    const doc = await readUserDoc(USER);
    expect(doc.ebayAccountSales).toHaveLength(1);
  });

  it("a different line item on the SAME order is a different sale", async () => {
    await upsertEbayAccountSale(USER, sale({ lineItemId: "LI-1" }));
    await upsertEbayAccountSale(USER, sale({ lineItemId: "LI-2" }));
    const doc = await readUserDoc(USER);
    expect(doc.ebayAccountSales).toHaveLength(2);
  });

  it("listEbayAccountSales returns newest first and filters by status", async () => {
    await upsertEbayAccountSale(USER, sale({ lineItemId: "old", soldAt: "2026-08-01T00:00:00.000Z" }));
    await upsertEbayAccountSale(USER, sale({ lineItemId: "new", soldAt: "2026-08-25T00:00:00.000Z" }));
    await upsertEbayAccountSale(USER, sale({
      lineItemId: "parked", soldAt: "2026-08-10T00:00:00.000Z",
      status: "parked", cardId: null,
      proposedIdentity: { slug: SLUG, confidence: 0.6, matchedBy: "fuzzy" },
    }));

    const all = await listEbayAccountSales(USER);
    expect(all.map((s) => s.lineItemId)).toEqual(["new", "parked", "old"]);

    const parked = await listEbayAccountSales(USER, { status: "parked" });
    expect(parked).toHaveLength(1);
    expect(parked[0].proposedIdentity?.slug).toBe(SLUG);
  });
});

describe("D26 — the sale array is bounded: a user doc has a 2MB ceiling", () => {
  it("keeps the newest EBAY_ACCOUNT_SALES_MAX by sale date and drops the oldest", async () => {
    // The array shares one Cosmos doc with holdings, ledger, purchases and
    // price history. A Pro Seller replaying 90 days would otherwise push it
    // through the document limit and every write on the doc would start
    // failing — including the holdings ones.
    const over = EBAY_ACCOUNT_SALES_MAX + 5;
    const doc = await readUserDoc(USER);
    doc.ebayAccountSales = Array.from({ length: over }, (_, i) => ({
      ...sale({ lineItemId: `LI-${i}` }),
      id: ebayAccountSaleId("ORD-1", `LI-${i}`),
      observedAt: "2026-08-01T00:00:00.000Z",
      // i=0 is the OLDEST.
      soldAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    })) as never;
    await writeUserDoc(USER, doc);

    await upsertEbayAccountSale(USER, sale({ lineItemId: "brand-new", soldAt: "2026-08-29T00:00:00.000Z" }));

    const after = await readUserDoc(USER);
    expect(after.ebayAccountSales).toHaveLength(EBAY_ACCOUNT_SALES_MAX);
    const ids = new Set(after.ebayAccountSales!.map((e) => e.lineItemId));
    expect(ids.has("brand-new")).toBe(true);   // the newest survives
    expect(ids.has("LI-0")).toBe(false);       // the oldest is dropped
  });

  it("does not prune when the array is under the ceiling", async () => {
    await upsertEbayAccountSale(USER, sale({ lineItemId: "a" }));
    await upsertEbayAccountSale(USER, sale({ lineItemId: "b" }));
    const doc = await readUserDoc(USER);
    expect(doc.ebayAccountSales).toHaveLength(2);
  });
});
