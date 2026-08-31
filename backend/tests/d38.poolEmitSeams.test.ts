/**
 * D38 — THE TWO POOL-EMIT SEAMS (Drew, 2026-08-30).
 *
 * Both are the same shape: the pool row's IDENTITY and the pool row's PRICE
 * are each derived in two places, and the second derivation silently overrules
 * the first.
 *
 * ITEM 1 — a subtotal never regresses to all-in.
 *   `makeId` keys a purchase row on the eBay order line item id. Nothing in
 *   that id depends on price, so every re-emit of one transaction upserts the
 *   SAME document. `purchaseSaleIdentity` prefers `purchase.subtotal` (what
 *   the market paid) and falls back to `holding.purchasePrice` (ALL-IN: item
 *   + shipping + tax). A later writer whose `sourcePurchaseFor` returns null
 *   therefore rewrites 295.95 as 301.43 — a comp flipped from market price to
 *   buyer's basis, on a row that still looks well-formed.
 *
 *   Not caught by the existing guards, and the tests below prove why: price is
 *   INSIDE contentHash (different price → different hash → no dedup hit), and
 *   `scoreForCanonical` never reads price at all.
 *
 * ITEM 2 — one identity, one derivation (the cpa-jg class).
 *   During the D37 backfill APPLY, `recordSoldComp` REFUSED an emit that
 *   carried the holding's pinned, checklist-ruled identity — because it threw
 *   that identity away, recomputed a slug from the holding's free text
 *   ("bowman-chrome" out of a setName), and then rejected the sale for not
 *   matching what it had just computed:
 *
 *       ruled holding   hiq:baseball:2026:bowman:cpa-jg:...:num-499
 *       computedSlug    hiq:baseball:2026:bowman-chrome:cpa-jg:...
 *       outcome         recordcomp_catalog_unmatched_skip
 *
 *   The pin now wins — but only on a POSITIVE confirmation, by read, that it
 *   resolves to a checklist-backed catalog row. Both directions are pinned
 *   here: the pin is honored, and an unpinned emit still recomputes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
  computeContentHash,
  scoreForCanonical,
  keepsExistingPrice,
  _setContainerForTests,
  type SoldCompDoc,
  type RecordSoldCompInput,
} from "../src/services/portfolioiq/soldCompsStore.service.js";
import { purchaseSaleIdentity } from "../src/services/portfolioiq/ebayAutoHolding.service.js";
import { _setContainerForTests as _setCatalogContainerForTests } from "../src/services/catalog/catalogIdentityResolver.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Drew's Gold Max Williams, measured on prod 2026-08-30: $295.95 subtotal,
 *  $301.43 all-in, one eBay order line item id. */
const ORDER_ID = "377291610293-10088272676307";
const GOLD_SLUG = "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50";
const GOLD_PURCHASE = { ebayOrderId: ORDER_ID, ebayItemId: "377291610293", subtotal: 295.95, totalCost: 301.43 };
const GOLD_HOLDING = { id: "aff3236a", ebayOrderId: ORDER_ID, ebayItemId: "377291610293", purchasePrice: 301.43, totalCostBasis: 301.43 };

/** The sold_comps fake. Unlike the hygiene suite's, `item()` also READS —
 *  the D38 regression guard point-reads the row it is about to replace, and a
 *  fake that cannot read would make the guard look like a no-op. */
function fakeSoldComps(): { container: Container; store: Map<string, SoldCompDoc> } {
  const store = new Map<string, SoldCompDoc>();
  const container = {
    item(id: string, partitionKey: string) {
      return {
        async read<T>() {
          const hit = store.get(`${partitionKey}::${id}`);
          if (!hit) { const e: Error & { code?: number } = new Error("NotFound"); e.code = 404; throw e; }
          return { resource: hit as unknown as T };
        },
        async delete() { store.delete(`${partitionKey}::${id}`); return { resource: undefined }; },
      };
    },
    items: {
      async upsert(doc: SoldCompDoc) { store.set(`${doc.cardId}::${doc.id}`, doc); return { resource: doc }; },
      query(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        const params = new Map<string, unknown>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const rows = Array.from(store.values());
            const h = params.get("@h");
            if (h !== undefined) {
              const wanted = Array.isArray(h) ? h : [h];
              return { resources: rows.filter((d) => wanted.includes(d.contentHash as string)) };
            }
            const sameId = params.get("@id");
            if (sameId !== undefined) {
              const notCardId = params.get("@cardId");
              return { resources: rows.filter((d) => d.id === sameId && d.cardId !== notCardId) };
            }
            return { resources: [] };
          },
        };
      },
    },
  } as unknown as Container;
  return { container, store };
}

/** A card_catalog fake keyed by row id, each row carrying the `source` that
 *  decides whether it may adjudicate. */
function fakeCatalog(rows: Record<string, { source: string }>): Container {
  return {
    item(id: string) {
      return {
        async read<T>() {
          const hit = rows[id];
          if (!hit) { const e: Error & { code?: number } = new Error("NotFound"); e.code = 404; throw e; }
          return { resource: { id, ...hit } as unknown as T };
        },
      };
    },
    items: {
      query(spec: { parameters?: Array<{ name: string; value: unknown }> }) {
        const stem = String(spec.parameters?.find((p) => p.name === "@stem")?.value ?? "");
        return {
          async fetchAll() {
            return {
              resources: Object.entries(rows)
                .filter(([id]) => stem !== "" && id.startsWith(stem))
                .map(([id, r]) => ({ id, source: r.source })),
              requestCharge: 1,
            };
          },
        };
      },
    },
  } as unknown as Container;
}

let store: Map<string, SoldCompDoc>;
beforeEach(() => {
  const f = fakeSoldComps();
  store = f.store;
  _setContainerForTests(f.container);
  _setCatalogContainerForTests(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  _setContainerForTests(null);
  _setCatalogContainerForTests(null);
  vi.restoreAllMocks();
});

const allRows = () => Array.from(store.values());
const rowsFor = (cardId: string) => allRows().filter((d) => d.cardId === cardId);

/** The Gold Max Williams emit as the import writes it: the holding's PINNED,
 *  checklist-backed identity travels with it (D38 ITEM 2), which is what lets
 *  the write reach the upsert where the ITEM 1 price guard lives. Without a
 *  catalog, `ebay-user-purchase` reconciles and refuses — see the ITEM 2 suite,
 *  where that refusal is the thing under test. */
const purchaseComp = (over: Partial<RecordSoldCompInput>): RecordSoldCompInput => ({
  cardId: GOLD_SLUG,
  pinnedHobbyIqCardId: GOLD_SLUG,
  playerName: "Max Williams",
  cardYear: 2025,
  setName: "Bowman Draft",
  parallel: "Gold Refractor",
  cardNumber: "CPA-MWI",
  isAuto: true,
  printRun: 50,
  sport: "baseball",
  soldAt: "2026-08-16T21:45:42.035Z",
  source: "ebay-user-purchase",
  sourceExternalId: ORDER_ID,
  contributorUserId: "drew",
  confidence: 0.8,
  price: 295.95,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 1
// ─────────────────────────────────────────────────────────────────────────────

describe("D38 ITEM 1 — the derivation travels with the price", () => {
  it("a purchase with a subtotal is priced at the subtotal, basis `subtotal`", () => {
    const r = purchaseSaleIdentity(GOLD_PURCHASE, GOLD_HOLDING);
    expect(r.price).toBe(295.95);
    expect(r.priceBasis).toBe("subtotal");
  });

  it("THE FALLBACK IS THE FLIP: no purchase record → the holding's ALL-IN price, marked `all-in`", () => {
    const r = purchaseSaleIdentity(null, GOLD_HOLDING);
    // Still keyed to the same transaction — which is exactly why it overwrites.
    expect(r.sourceExternalId).toBe(ORDER_ID);
    expect(r.price).toBe(301.43);
    expect(r.priceBasis).toBe("all-in");
  });

  it("purchase.totalCost is all-in too — the components are unknowable from there", () => {
    const r = purchaseSaleIdentity({ ebayOrderId: ORDER_ID, subtotal: 0, totalCost: 301.43 } as never, GOLD_HOLDING);
    expect(r.price).toBe(301.43);
    expect(r.priceBasis).toBe("all-in");
  });

  it("no price at all is `none`, never a silent zero-basis", () => {
    expect(purchaseSaleIdentity(null, { id: "x" }).priceBasis).toBe("none");
  });
});

describe("D38 ITEM 1 — why the existing guards could not catch it (mutation checks)", () => {
  it("contentHash does NOT collapse them — price is inside the hash, so dedup never fires", () => {
    const base = {
      cardId: GOLD_SLUG,
      parallel: "Gold Refractor",
      isAuto: true,
      gradeCompany: null,
      gradeValue: null,
      soldAt: "2026-08-16T21:45:42.035Z",
    };
    expect(computeContentHash({ ...base, price: 295.95 }))
      .not.toBe(computeContentHash({ ...base, price: 301.43 }));
  });

  it("scoreForCanonical does NOT read price — it cannot prefer the subtotal row", () => {
    const row = {
      verifiedByUser: false,
      sourceExternalId: ORDER_ID,
      parallel: "Gold Refractor",
      observedAt: "2026-08-30T00:00:00Z",
    };
    // Mutating ONLY the price leaves the score identical: proof the old path
    // had nothing to break the tie with.
    expect(scoreForCanonical({ ...row, price: 295.95 } as never))
      .toBe(scoreForCanonical({ ...row, price: 301.43 } as never));
  });
});

describe("D38 ITEM 1 — keepsExistingPrice refuses exactly one direction", () => {
  const sub = { price: 295.95, priceBasis: "subtotal" };
  const allIn = { price: 301.43, priceBasis: "all-in" };

  it("REFUSES all-in over a stored subtotal", () => {
    expect(keepsExistingPrice(sub, allIn)).toBe(true);
  });
  it("ACCEPTS subtotal over a stored all-in — the fix landing later is an upgrade", () => {
    expect(keepsExistingPrice(allIn, sub)).toBe(false);
  });
  it("ACCEPTS subtotal over subtotal — a genuine price correction still lands", () => {
    expect(keepsExistingPrice(sub, { price: 290, priceBasis: "subtotal" })).toBe(false);
  });
  it("ACCEPTS all-in over all-in — no better answer exists", () => {
    expect(keepsExistingPrice(allIn, { price: 310, priceBasis: "all-in" })).toBe(false);
  });
  it("ACCEPTS anything over a pre-D38 row that carries no basis", () => {
    expect(keepsExistingPrice({ price: 295.95 }, allIn)).toBe(false);
  });
  it("does not fire when nothing is stored", () => {
    expect(keepsExistingPrice(null, allIn)).toBe(false);
  });
});

describe("D38 ITEM 1 — the flip, reproduced end to end through recordSoldComp", () => {
  beforeEach(() => {
    _setCatalogContainerForTests(fakeCatalog({ [GOLD_SLUG]: { source: "checklistcenter" } }));
  });

  it("the import writes 295.95; a later confirm without the purchase record does NOT flip it to 301.43", async () => {
    // 1. The import: purchase record present → subtotal.
    const first = purchaseSaleIdentity(GOLD_PURCHASE, GOLD_HOLDING);
    const a = await recordSoldComp(purchaseComp({
      price: first.price, priceBasis: first.priceBasis, sourceExternalId: first.sourceExternalId,
    }));
    expect(a.written).toBe(true);
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0].price).toBe(295.95);

    // 2. A live edit whose sourcePurchaseFor() returns null → all-in, same id.
    const second = purchaseSaleIdentity(null, GOLD_HOLDING);
    expect(second.price).toBe(301.43);
    // The killer detail: the SAME document id, so this is an overwrite.
    expect(second.sourceExternalId).toBe(first.sourceExternalId);
    const b = await recordSoldComp(purchaseComp({
      price: second.price, priceBasis: second.priceBasis, sourceExternalId: second.sourceExternalId,
    }));

    // The sale is still in the pool, at the MARKET's price, in ONE row.
    expect(b.written).toBe(true);
    const after = allRows();
    expect(after).toHaveLength(1);
    expect(after[0].price).toBe(295.95);
    expect(after[0].price).not.toBe(301.43);
    expect(after[0].priceBasis).toBe("subtotal");
  });

  it("the reverse order still converges on the subtotal — an all-in row IS upgraded", async () => {
    await recordSoldComp(purchaseComp({ price: 301.43, priceBasis: "all-in" }));
    expect(allRows()[0].price).toBe(301.43);

    await recordSoldComp(purchaseComp({ price: 295.95, priceBasis: "subtotal" }));
    const after = allRows();
    expect(after).toHaveLength(1);
    expect(after[0].price).toBe(295.95);
    expect(after[0].priceBasis).toBe("subtotal");
  });

  it("a vendor row carries no basis and is completely unaffected", async () => {
    await recordSoldComp(purchaseComp({ source: "tca-ebay", sourceExternalId: "tca-1", price: 250 }));
    expect(allRows()[0].price).toBe(250);
    expect(allRows()[0].priceBasis).toBeNull();

    // A second vendor observation at a different price replaces it as before.
    await recordSoldComp(purchaseComp({ source: "tca-ebay", sourceExternalId: "tca-1", price: 275 }));
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0].price).toBe(275);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 2
// ─────────────────────────────────────────────────────────────────────────────

/** The cpa-jg holding: RULED onto a checklist `bowman` row at :num-499, while
 *  its free-text setName would recompute to `bowman-chrome`. */
const JG_STEM = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto";
const JG_PIN = `${JG_STEM}:num-499`;
const JG_INPUT: RecordSoldCompInput = {
  cardId: JG_PIN,
  pinnedHobbyIqCardId: JG_PIN,
  playerName: "Jonah Grant",
  cardYear: 2026,
  // The drift: the holding's text says Chrome, the checklist ruled Bowman.
  setName: "Bowman Chrome",
  parallel: "Refractor",
  cardNumber: "CPA-JG",
  isAuto: true,
  printRun: 499,
  sport: "baseball",
  price: 255.49,
  soldAt: "2026-08-16T20:08:00.000Z",
  source: "ebay-user-purchase",
  sourceExternalId: "cpa-jg-order-1",
  contributorUserId: "drew",
  confidence: 0.8,
};

describe("D38 ITEM 2 — a checklist-backed pin is the identity", () => {
  it("HONORS the pin: the sale lands on the ruled bowman row, not the recomputed bowman-chrome one", async () => {
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "checklistcenter" } }));

    const res = await recordSoldComp(JG_INPUT);

    expect(res.written).toBe(true);
    // THE BUG: this used to be { written: false, reason: "catalog-unmatched" }.
    expect(res.reason).toBeUndefined();
    expect(res.hobbyiqCardId).toBe(JG_PIN);
    const row = allRows()[0];
    expect(row.hobbyiqCardId).toBe(JG_PIN);
    expect(row.hobbyiqCardId).not.toContain("bowman-chrome");
    expect(row.price).toBe(255.49);
  });

  it("resolves the pin THROUGH THE TWIN RULE — a pin on the stem verifies against its :num-499 row", async () => {
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "checklistcenter" } }));

    const res = await recordSoldComp({ ...JG_INPUT, cardId: JG_STEM, pinnedHobbyIqCardId: JG_STEM });
    expect(res.written).toBe(true);
    expect(res.hobbyiqCardId).toBe(JG_PIN);
  });

  it("REFUSES a pin backed only by a DERIVED row — the catalog must not confirm the sale that seeded it", async () => {
    // sold-comps-stub is a catalog row built FROM comps. Trusting it would
    // close exactly the loop catalogAuthority exists to break.
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "sold-comps-stub-2026-08-12" } }));

    const res = await recordSoldComp(JG_INPUT);
    // Falls through to today's behaviour EXACTLY: derive from the free text,
    // reconcile, and refuse. This IS the pre-fix cpa-jg outcome, which is the
    // point — an unverifiable pin buys the caller nothing.
    expect(res.written).toBe(false);
    expect(res.reason).toBe("catalog-unmatched");
    expect(res.hobbyiqCardId).toBeUndefined();
    expect(allRows()).toHaveLength(0);
  });

  it("REFUSES a pin backed only by a VENDOR row", async () => {
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "cardhedge" } }));
    const res = await recordSoldComp(JG_INPUT);
    expect(res.written).toBe(false);
    expect(res.reason).toBe("catalog-unmatched");
  });

  it("REFUSES a pin with no catalog row at all — fails closed, never on the caller's word", async () => {
    _setCatalogContainerForTests(fakeCatalog({}));
    const res = await recordSoldComp(JG_INPUT);
    expect(res.written).toBe(false);
    expect(res.reason).toBe("catalog-unmatched");
  });
});

describe("D38 ITEM 2 — an UNPINNED emit still recomputes (the other direction)", () => {
  it("with no pin, the slug is derived from the fields exactly as before", async () => {
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "checklistcenter" } }));

    const { pinnedHobbyIqCardId: _drop, ...unpinned } = JG_INPUT;
    const res = await recordSoldComp(unpinned);

    // THE CONTROL for the honored-pin test above: the SAME checklist row is in
    // the catalog and the SAME fields are supplied. Only the pin is missing —
    // and the store recomputes "bowman-chrome", reconciles, and refuses,
    // reproducing the 20:08Z skip exactly. The pin is what changes the outcome,
    // not the fake, not the fields.
    expect(res.written).toBe(false);
    expect(res.reason).toBe("catalog-unmatched");
    expect(allRows()).toHaveLength(0);
  });

  it("a vendor source's cardId is not a pin — passing cardId alone changes nothing", async () => {
    _setCatalogContainerForTests(fakeCatalog({ [JG_PIN]: { source: "checklistcenter" } }));
    const { pinnedHobbyIqCardId: _drop, ...unpinned } = JG_INPUT;
    const res = await recordSoldComp({ ...unpinned, source: "tca-ebay", sourceExternalId: "tca-jg" });
    // A vendor source does not reconcile (CATALOG_MATCH_ONLY_ENABLED is unset
    // in tests), so it writes — under the RECOMPUTED slug, never the pin's.
    expect(res.written).toBe(true);
    expect(res.hobbyiqCardId).toContain("bowman-chrome");
    expect(res.hobbyiqCardId).not.toBe(JG_PIN);
  });
});

describe("D38 — the emit paths hand the store their ruled identity", () => {
  it("the D37 backfill passes the holding's pinned id, and the priceBasis with the price", () => {
    const src = fs.readFileSync(path.resolve(HERE, "../scripts/backfill-ebay-purchase-comps.cjs"), "utf8");
    expect(src).toContain("pinnedHobbyIqCardId: identity.hobbyiqCardId");
    expect(src).toContain("const { sourceExternalId, price, priceBasis } = purchaseSaleIdentity(purchase, h);");
    expect(src).toContain("priceBasis,");
  });

  it("every live writer that keys a purchase carries the basis through — none may drop it", () => {
    // A writer that destructures price WITHOUT priceBasis is the flip coming
    // back: it emits an unmarked all-in price that the store cannot refuse.
    for (const rel of [
      "../src/services/portfolioiq/ebayAutoHolding.service.ts",
      "../src/services/portfolioiq/ebayReviewQueue.service.ts",
      "../src/routes/ebayImportRematch.routes.ts",
    ]) {
      const src = fs.readFileSync(path.resolve(HERE, rel), "utf8");
      expect(src).toMatch(/const \{ sourceExternalId, price, priceBasis \} = purchaseSaleIdentity\(/);
      expect(src).toContain("priceBasis,");
    }
  });
});
