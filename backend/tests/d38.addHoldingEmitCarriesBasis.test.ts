/**
 * D38 ITEM 1, THE FOURTH SEAM — the Add Card / Edit Card emit (Drew, 2026-08-31).
 *
 * D38 closed the flip on three writers (import, confirm, rematch) by threading
 * `priceBasis` out of `purchaseSaleIdentity` and into `recordSoldComp`. A
 * fourth writer was left behind: `emitUserEbayPurchaseComp` in
 * portfolioStore.service.ts, which fires from addHolding AND updateHolding.
 *
 * It already CALLED purchaseSaleIdentity — but destructured only
 * `sourceExternalId`, throwing away the price and the basis that same call had
 * just derived, and priced the row off `holding.purchasePrice` instead:
 *
 *     const price = Number(holding.purchasePrice)          // ALL-IN
 *     const { sourceExternalId } = purchaseSaleIdentity(...) // basis DISCARDED
 *     await recordSoldComp({ ..., price })                  // no priceBasis
 *
 * That is the flip with the guards disarmed. BOTH D38 layers gate on the
 * INCOMING basis — `keepsExistingPrice` returns false unless
 * `incoming.priceBasis === "all-in"`, and the point-read in recordSoldComp is
 * wrapped in `if (doc.priceBasis === "all-in")`. An unmarked all-in price
 * satisfies neither, so it sails through and overwrites the stored subtotal on
 * the SAME doc id. Every user who edits a card they imported from eBay walks
 * this path.
 *
 * Two fixes, pinned here as two layers:
 *   1. the emit threads the real basis (and prefers the purchase subtotal);
 *   2. the store treats an UNMARKED `ebay-user-purchase` price as all-in, so a
 *      future writer that forgets cannot re-open the seam.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
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
/** The holding as addHolding/updateHolding see it: purchasePrice is ALL-IN. */
const GOLD_HOLDING = { id: "aff3236a", ebayOrderId: ORDER_ID, ebayItemId: "377291610293", purchasePrice: 301.43, totalCostBasis: 301.43 };

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
  _setCatalogContainerForTests(fakeCatalog({ [GOLD_SLUG]: { source: "checklistcenter" } }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  _setContainerForTests(null);
  _setCatalogContainerForTests(null);
  vi.restoreAllMocks();
});

const allRows = () => Array.from(store.values());

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
  verifiedByUser: true,
  confidence: 1.0,
  price: 295.95,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — the store, on its own, refuses an UNMARKED all-in write
// ─────────────────────────────────────────────────────────────────────────────

describe("D38 — an unmarked ebay-user-purchase price is treated as all-in", () => {
  it("THE SEAM: an unmarked 301.43 does NOT overwrite a stored subtotal 295.95", async () => {
    // 1. The import wrote the market's price, correctly marked.
    await recordSoldComp(purchaseComp({ price: 295.95, priceBasis: "subtotal" }));
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0].price).toBe(295.95);

    // 2. The Add Card / Edit Card emit, pre-fix shape: the holding's ALL-IN
    //    price with NO basis at all, on the SAME doc id.
    const res = await recordSoldComp(purchaseComp({ price: 301.43 }));

    // The sale stays in the pool at the MARKET's price, in ONE row.
    expect(res.written).toBe(true);
    const after = allRows();
    expect(after).toHaveLength(1);
    expect(after[0].price).toBe(295.95);
    expect(after[0].price).not.toBe(301.43);
    expect(after[0].priceBasis).toBe("subtotal");
  });

  it("stamps the inferred basis on the row, so the next writer can see it", async () => {
    await recordSoldComp(purchaseComp({ price: 301.43 }));
    expect(allRows()[0].priceBasis).toBe("all-in");
  });

  it("an explicit subtotal still UPGRADES an unmarked row — inference is not a ratchet", async () => {
    await recordSoldComp(purchaseComp({ price: 301.43 }));
    expect(allRows()[0].price).toBe(301.43);

    await recordSoldComp(purchaseComp({ price: 295.95, priceBasis: "subtotal" }));
    const after = allRows();
    expect(after).toHaveLength(1);
    expect(after[0].price).toBe(295.95);
    expect(after[0].priceBasis).toBe("subtotal");
  });

  it("does NOT touch other sources — a vendor row still carries no basis", async () => {
    await recordSoldComp(purchaseComp({ source: "tca-ebay", sourceExternalId: "tca-1", price: 250 }));
    expect(allRows()[0].priceBasis).toBeNull();

    // And a second vendor observation replaces it exactly as before.
    await recordSoldComp(purchaseComp({ source: "tca-ebay", sourceExternalId: "tca-1", price: 275 }));
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0].price).toBe(275);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — the emit derives the price the same way every other writer does
// ─────────────────────────────────────────────────────────────────────────────

describe("D38 — emitUserEbayPurchaseComp carries the basis (addHolding / updateHolding)", () => {
  const EMIT = fs.readFileSync(
    path.resolve(HERE, "../src/services/portfolioiq/portfolioStore.service.ts"),
    "utf8",
  );
  /** Just the emit function — the file is ~6k lines and `price,` appears all
   *  over it. Anchored on the function head and its closing brace. */
  const emitBody = (() => {
    const start = EMIT.indexOf("async function emitUserEbayPurchaseComp(");
    expect(start).toBeGreaterThan(-1);
    const end = EMIT.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return EMIT.slice(start, end);
  })();

  it("destructures the basis out of purchaseSaleIdentity — never sourceExternalId alone", () => {
    // The pre-fix line was `const { sourceExternalId } = purchaseSaleIdentity(`,
    // which discarded the price and the basis the call had just derived.
    expect(emitBody).toMatch(/const \{ sourceExternalId, price: identityPrice, priceBasis \} = purchaseSaleIdentity\(/);
    expect(emitBody).not.toMatch(/const \{ sourceExternalId \} = purchaseSaleIdentity\(/);
  });

  it("hands recordSoldComp a priceBasis", () => {
    expect(emitBody).toMatch(/priceBasis:/);
  });

  it("prices off the purchase record, not the holding's all-in field, when both exist", () => {
    // purchasePrice may still be read as the fallback, but it must not be what
    // reaches the pool when purchaseSaleIdentity found a subtotal.
    expect(emitBody).toMatch(/price: priceForPool/);
  });
});

describe("D38 — the four live purchase writers, enumerated", () => {
  it("every writer that keys a purchase carries the basis through — none may drop it", () => {
    for (const rel of [
      "../src/services/portfolioiq/ebayAutoHolding.service.ts",
      "../src/services/portfolioiq/ebayReviewQueue.service.ts",
      "../src/routes/ebayImportRematch.routes.ts",
    ]) {
      const src = fs.readFileSync(path.resolve(HERE, rel), "utf8");
      expect(src).toMatch(/const \{ sourceExternalId, price, priceBasis \} = purchaseSaleIdentity\(/);
      expect(src).toContain("priceBasis,");
    }
    // The fourth, which D38 missed: same contract, different destructure name
    // (it keeps a `price` local for the guard clause above the call).
    const emit = fs.readFileSync(
      path.resolve(HERE, "../src/services/portfolioiq/portfolioStore.service.ts"),
      "utf8",
    );
    expect(emit).toMatch(/priceBasis \} = purchaseSaleIdentity\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The behavioural end-to-end: the two derivations, through the real store
// ─────────────────────────────────────────────────────────────────────────────

describe("D38 — the Add Card emit's own derivation, end to end", () => {
  it("with the purchase record present it prices at the subtotal", () => {
    const r = purchaseSaleIdentity(GOLD_PURCHASE, GOLD_HOLDING);
    expect(r.price).toBe(295.95);
    expect(r.priceBasis).toBe("subtotal");
  });

  it("with the purchase record MISSING it falls back to the holding, and says all-in", async () => {
    // This is the exact shape updateHolding hits when the purchases array no
    // longer carries the source purchase: same doc id, all-in price.
    const r = purchaseSaleIdentity(null, GOLD_HOLDING);
    expect(r.price).toBe(301.43);
    expect(r.priceBasis).toBe("all-in");
    expect(r.sourceExternalId).toBe(ORDER_ID);

    await recordSoldComp(purchaseComp({ price: 295.95, priceBasis: "subtotal" }));
    await recordSoldComp(purchaseComp({ price: r.price, priceBasis: r.priceBasis, sourceExternalId: r.sourceExternalId }));

    const after = allRows();
    expect(after).toHaveLength(1);
    expect(after[0].price).toBe(295.95);
  });
});
