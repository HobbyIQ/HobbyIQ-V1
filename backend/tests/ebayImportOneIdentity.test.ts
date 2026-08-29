// CF-ONE-IMPORT-ONE-IDENTITY (Drew, 2026-08-29, checklist D9: "We need to fix
// the whole eBay import to holdings process, because it seems broken").
//
// One real import, end to end, as the fixture. The purchase record is Drew's
// own — listing title, subtotal, shipping, eBay ids, Browse aspects (only
// Sport) — and the catalog state is what prod held that day: a checklist row
// for the Gold Refractor /50 plus its Refractor and Base siblings.
//
// What the import produced then, every line a defect:
//   cardTitle   "2026 Bowman Chrome Refractor Marconi German"   finish + /50 gone
//   playerName  "Marconi German,"                               punctuation residue
//   catalogMatchSlug  hiq:...:bowman-chrome::refractor:auto     EMPTY card number
//   cardId      ...:cpa-mg:refractor:auto   (suggester's pick, wrong variant)
//   hobbyiqCardId / catalogVerifiedSlug  ...:cpa-mg:gold-refractor:auto (no /50)
//   a NEW catalog row minted at ...:gold-refractor:auto -- the checklist row's
//   un-numbered twin -- with the sale filed under it.
//
// Every fake here answers Cosmos the way Cosmos would for these rows; nothing
// is stubbed at the function level, so the assertions are about what the
// import DOES, not what it calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Cosmos fakes ─────────────────────────────────────────────────────────
//
// One in-memory container per name. Queries are interpreted from their SQL:
// every `c.field = @param` / `c.field != @param` pair filters, STARTSWITH and
// UPPER() are honoured, and the three projection shapes the import path uses
// (DISTINCT VALUE c.cardNumber / TOP 1 VALUE 1 / VALUE COUNT(1)) are applied.

interface FakeContainer {
  container: unknown;
  rows: Map<string, Record<string, unknown>>;
  upserts: Array<Record<string, unknown>>;
  deletes: string[];
}

const fakes = vi.hoisted(() => {
  const registry = new Map<string, FakeContainerShape>();
  type FakeContainerShape = {
    container: unknown;
    rows: Map<string, Record<string, unknown>>;
    upserts: Array<Record<string, unknown>>;
    deletes: string[];
  };

  function runQuery(
    rows: Map<string, Record<string, unknown>>,
    q: string,
    params: Record<string, unknown>,
  ): unknown[] {
    let list = Array.from(rows.values());
    // Equality / inequality predicates on plain fields.
    const pred = /c\.(\w+)\s*(!=|=)\s*(@\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pred.exec(q)) !== null) {
      const [, field, op, param] = m;
      if (!(param in params)) continue;
      const want = params[param];
      list = list.filter((r) => (op === "=" ? r[field] === want : r[field] !== want));
    }
    const upper = /UPPER\(c\.(\w+)\)\s*=\s*(@\w+)/g;
    while ((m = upper.exec(q)) !== null) {
      const [, field, param] = m;
      const want = String(params[param] ?? "").toUpperCase();
      list = list.filter((r) => String(r[field] ?? "").toUpperCase() === want);
    }
    const starts = /STARTSWITH\(c\.(\w+),\s*(@\w+)\)/g;
    const startsClauses: Array<{ field: string; param: string }> = [];
    while ((m = starts.exec(q)) !== null) startsClauses.push({ field: m[1], param: m[2] });
    if (startsClauses.length === 1) {
      const { field, param } = startsClauses[0];
      list = list.filter((r) => String(r[field] ?? "").startsWith(String(params[param] ?? "")));
    } else if (startsClauses.length > 1) {
      // `(STARTSWITH(a, @p0) OR STARTSWITH(a, @p1))` -- the matcher's widened family query.
      list = list.filter((r) => startsClauses.some(({ field, param }) =>
        String(r[field] ?? "").startsWith(String(params[param] ?? ""))));
    }
    if (/SELECT\s+DISTINCT\s+VALUE\s+c\.(\w+)/i.test(q)) {
      const field = q.match(/SELECT\s+DISTINCT\s+VALUE\s+c\.(\w+)/i)![1];
      return Array.from(new Set(list.map((r) => r[field]).filter((v) => v !== null && v !== undefined)));
    }
    if (/SELECT\s+TOP\s+1\s+VALUE\s+1/i.test(q)) return list.length ? [1] : [];
    if (/SELECT\s+VALUE\s+COUNT\(1\)/i.test(q)) return [list.length];
    return list;
  }

  function makeFake(name: string): FakeContainerShape {
    const rows = new Map<string, Record<string, unknown>>();
    const upserts: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    // sold_comps is partitioned on /cardId, so its key models the partition;
    // the same id under two cardIds is TWO documents, exactly as in Cosmos.
    const keyOf = (id: string, pk?: string) => (name === "sold_comps" ? `${pk ?? ""}::${id}` : id);
    const container = {
      id: name,
      item(id: string, pk?: string) {
        return {
          async read() {
            const r = rows.get(keyOf(id, pk));
            if (!r) { const e = new Error("NotFound") as Error & { code: number }; e.code = 404; throw e; }
            return { resource: r };
          },
          async delete() { rows.delete(keyOf(id, pk)); deletes.push(id); return { resource: undefined }; },
        };
      },
      items: {
        async upsert(doc: Record<string, unknown>) {
          rows.set(keyOf(String(doc.id), String(doc.cardId ?? "")), doc);
          upserts.push(doc);
          return { resource: doc };
        },
        async create(doc: Record<string, unknown>) {
          rows.set(keyOf(String(doc.id), String(doc.cardId ?? "")), doc);
          upserts.push(doc);
          return { resource: doc };
        },
        query(spec: string | { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
          const q = typeof spec === "string" ? spec : spec.query;
          const params: Record<string, unknown> = {};
          if (typeof spec !== "string") for (const p of spec.parameters ?? []) params[p.name] = p.value;
          return { async fetchAll() { return { resources: runQuery(rows, q, params) }; } };
        },
      },
    };
    return { container, rows, upserts, deletes };
  }

  function get(name: string): FakeContainerShape {
    let f = registry.get(name);
    if (!f) { f = makeFake(name); registry.set(name, f); }
    return f;
  }

  // Modules memoise their container for the process, so the fake OBJECTS must
  // survive across tests; only their contents reset.
  function reset(): void {
    for (const f of registry.values()) { f.rows.clear(); f.upserts.length = 0; f.deletes.length = 0; }
  }

  return { registry, get, reset };
});

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_: unknown) { /* connection string is never used */ }
    database(_: string) {
      return { container: (name: string) => fakes.get(name).container };
    }
    databases = {
      createIfNotExists: async (_: { id: string }) => ({
        database: {
          containers: {
            createIfNotExists: async (opts: { id: string }) => ({ container: fakes.get(opts.id).container }),
          },
        },
      }),
    };
  }
  return { CosmosClient };
});

import { autoCreateHoldingForPurchase } from "../src/services/portfolioiq/ebayAutoHolding.service.js";
import { _setContainerForTests } from "../src/services/portfolioiq/soldCompsStore.service.js";
import type { PortfolioPurchaseEntry } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { EbayItemDetails } from "../src/services/ebay/ebayItemDetails.service.js";

// ─── The fixture ──────────────────────────────────────────────────────────

const LISTING_TITLE = "2026 Bowman Marconi German Chrome Auto Gold Refractor 1st #/50 Nationals";
const ORDER_ID = "377413083669-10083183646909";
const ITEM_ID = "377413083669";

const CHECKLIST_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50";
const TWIN_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto";
const REFRACTOR_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:refractor:auto";
const BASE_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:base:auto";

function checklistRow(slug: string, parallel: string, printRun: number | null): Record<string, unknown> {
  return {
    id: slug, cardId: slug, hobbyiqCardId: slug,
    sport: "baseball", year: 2026, setKey: "bowman-chrome", setName: "Bowman Chrome",
    cardNumber: "CPA-MG", parallel, parallelSlug: parallel.toLowerCase().replace(/\s+/g, "-"),
    isAuto: true, printRun, playerName: "Marconi German", playerSlug: "marconi-german",
    source: "checklist", confidence: 0.95, verificationStatus: "verified",
  };
}

function purchaseFixture(overrides: Partial<PortfolioPurchaseEntry> = {}): PortfolioPurchaseEntry {
  return {
    id: "purchase-1",
    userId: "user-1",
    purchaseDate: "2026-08-18T00:00:00.000Z",
    source: "ebay",
    subtotal: 182.5,
    tax: 0,
    shipping: 4.99,
    otherFees: 0,
    totalCost: 187.49,
    holdingIds: [],
    vendor: "dcsports87",
    notes: LISTING_TITLE,
    ebayItemId: ITEM_ID,
    ebayOrderId: ORDER_ID,
    createdAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function browseFixture(aspects: Record<string, string> = { Sport: "Baseball" }): EbayItemDetails {
  return {
    itemId: `v1|${ITEM_ID}|0`,
    legacyItemId: ITEM_ID,
    title: LISTING_TITLE,
    shortDescription: null,
    price: null,
    condition: null,
    grader: null,
    grade: null,
    aspects,
    images: { primary: null, additional: [] },
    categoryPath: null,
    seller: null,
    itemCreationDate: null,
    itemEndDate: null,
    buyingOptions: [],
  };
}

function docFixture(purchase: PortfolioPurchaseEntry) {
  return { userId: "user-1", holdings: {} as Record<string, never>, purchases: [purchase] };
}

/** Fire-and-forget branches (ensureCatalogRow, fmv accuracy) run after the
 *  import returns; let them land before counting catalog writes. */
const settle = () => new Promise((r) => setTimeout(r, 25));

let catalog: FakeContainer;
let pool: FakeContainer;

beforeEach(() => {
  fakes.reset();
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://fake.invalid/;AccountKey=ZmFrZQ==;";
  delete process.env.CATALOG_MATCH_ONLY_ENABLED;
  delete process.env.EBAY_IMPORT_FORCE_REVIEW;
  catalog = fakes.get("card_catalog") as FakeContainer;
  pool = fakes.get("sold_comps") as FakeContainer;
  _setContainerForTests(pool.container as never);
});
afterEach(() => {
  _setContainerForTests(null);
  delete process.env.COSMOS_CONNECTION_STRING;
});

function seedChecklist(): void {
  for (const row of [
    checklistRow(CHECKLIST_SLUG, "Gold Refractor", 50),
    checklistRow(REFRACTOR_SLUG, "Refractor", 499),
    checklistRow(BASE_SLUG, "Base", null),
    checklistRow("hiq:baseball:2026:bowman-chrome:cpa-mg:blue-refractor:auto:num-150", "Blue Refractor", 150),
  ]) catalog.rows.set(String(row.id), row);
}

function poolRows(): Array<Record<string, unknown>> {
  return Array.from(pool.rows.values());
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("D9: one import, one identity -- Drew's Marconi German Gold Refractor /50", () => {
  it("parses, resolves, pins and files the sale under the checklist row, and mints nothing", async () => {
    seedChecklist();
    // The state prod was in: the sale had already been filed once, under the
    // un-numbered twin, keyed by the same eBay order. One transaction is one
    // pool row; the import must not leave a second copy behind.
    pool.rows.set(`${TWIN_SLUG}::ebay-user-purchase::${ORDER_ID}`, {
      id: `ebay-user-purchase::${ORDER_ID}`, cardId: TWIN_SLUG, hobbyiqCardId: TWIN_SLUG,
      source: "ebay-user-purchase", sourceExternalId: ORDER_ID, price: 187.49,
      soldAt: "2026-08-18T00:00:00.000Z", playerName: "Marconi German,", parallel: "Gold Refractor",
      contributorUserId: "user-1", contentHash: "stale",
    });
    const catalogRowsBefore = catalog.rows.size;

    const purchase = purchaseFixture();
    const doc = docFixture(purchase);
    const result = await autoCreateHoldingForPurchase(doc, purchase, browseFixture());
    await settle();

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const h = result.holding as Record<string, unknown>;

    // 1. Parse: the listing title is the identity input, and nothing it said is lost.
    expect(h.playerName).toBe("Marconi German");
    expect(h.cardYear).toBe(2026);
    expect(h.setName).toBe("Bowman Chrome");
    expect(h.parallel).toBe("Gold Refractor");
    expect(h.printRun).toBe(50);
    expect(h.isAuto).toBe(true);
    expect(h.cardNumber).toBe("CPA-MG");
    expect(String(h.cardTitle)).toMatch(/Gold Refractor/);
    expect(String(h.cardTitle)).toMatch(/\/50/);
    expect(String(h.cardTitle)).toMatch(/CPA-MG/);
    expect(h.ebayListingTitle).toBe(LISTING_TITLE);

    // 2. Match: the card number the catalog resolves from the player, AND the
    //    title's parallel and print run -- the checklist row, exactly.
    expect(h.catalogMatchedBy).toBe("exact");
    expect(h.catalogMatchSlug).toBe(CHECKLIST_SLUG);
    expect(h.catalogMatchConfidence).toBeGreaterThanOrEqual(0.9);

    // 3. One identity.
    expect(h.cardId).toBe(CHECKLIST_SLUG);
    expect(h.hobbyiqCardId).toBe(CHECKLIST_SLUG);
    expect(h.catalogVerifiedSlug).toBe(CHECKLIST_SLUG);
    expect(h.soldCompSlug).toBe(CHECKLIST_SLUG);
    expect(h.ebayItemId).toBe(ITEM_ID);
    expect(h.ebayOrderId).toBe(ORDER_ID);
    expect(purchase.holdingIds).toEqual([h.id]);

    // 4. Seed: a checklist row resolved, so the import minted NOTHING -- no
    //    un-numbered twin, no row of any kind.
    expect(catalog.upserts).toHaveLength(0);
    expect(catalog.rows.size).toBe(catalogRowsBefore);

    // 5. Sale: under the resolved slug, keyed by the eBay order, priced at the
    //    subtotal (what the item sold for -- shipping is not part of the sale),
    //    and the stale copy under the twin is gone: one transaction, one row.
    const rows = poolRows();
    expect(rows).toHaveLength(1);
    const sale = rows[0];
    expect(sale.id).toBe(`ebay-user-purchase::${ORDER_ID}`);
    expect(sale.sourceExternalId).toBe(ORDER_ID);
    expect(sale.cardId).toBe(CHECKLIST_SLUG);
    expect(sale.hobbyiqCardId).toBe(CHECKLIST_SLUG);
    expect(sale.price).toBe(182.5);
    expect(sale.source).toBe("ebay-user-purchase");
    expect(sale.playerName).toBe("Marconi German");
    expect(sale.parallel).toBe("Gold Refractor");
    expect(sale.contributorUserId).toBe("user-1");
    expect(h.soldCompId).toBe(sale.id);
  });

  it("a seller-typed Player aspect with a trailing comma is cleaned by the one normalizer", async () => {
    seedChecklist();
    const purchase = purchaseFixture();
    const result = await autoCreateHoldingForPurchase(
      docFixture(purchase), purchase, browseFixture({ Sport: "Baseball", Player: "Marconi German," }),
    );
    await settle();
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const h = result.holding as Record<string, unknown>;
    expect(h.playerName).toBe("Marconi German");
    expect(h.cardId).toBe(CHECKLIST_SLUG);
    expect(poolRows()[0]?.playerName).toBe("Marconi German");
  });

  it("re-running the import for a purchase already linked writes nothing twice", async () => {
    seedChecklist();
    const purchase = purchaseFixture();
    const doc = docFixture(purchase);
    await autoCreateHoldingForPurchase(doc, purchase, browseFixture());
    await settle();
    const second = await autoCreateHoldingForPurchase(doc, purchase, browseFixture());
    await settle();
    expect(second.status).toBe("skipped-already-linked");
    expect(poolRows()).toHaveLength(1);
    expect(catalog.upserts).toHaveLength(0);
  });
});

describe("D9: when no checklist row exists, the seed is the numbered card", () => {
  it("seeds ONE row carrying printRun and the numbered slug, and files the sale under it", async () => {
    // Nothing in the catalog. The title names the card number itself, so the
    // identity is complete without a lookup.
    const purchase = purchaseFixture({
      notes: "2026 Bowman Chrome Marconi German 1st Auto Gold Refractor #CPA-MG /50 Nationals",
    });
    const doc = docFixture(purchase);
    const result = await autoCreateHoldingForPurchase(doc, purchase, browseFixture());
    await settle();

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const h = result.holding as Record<string, unknown>;
    expect(h.cardNumber).toBe("CPA-MG");
    expect(h.printRun).toBe(50);
    expect(h.catalogMatchedBy).toBe("seeded");
    expect(h.cardId).toBe(CHECKLIST_SLUG);
    expect(h.hobbyiqCardId).toBe(CHECKLIST_SLUG);
    expect(h.soldCompSlug).toBe(CHECKLIST_SLUG);

    // Exactly one catalog write, and it is the numbered card with its player.
    expect(catalog.upserts).toHaveLength(1);
    const seeded = catalog.upserts[0];
    expect(seeded.id).toBe(CHECKLIST_SLUG);
    expect(seeded.printRun).toBe(50);
    expect(seeded.cardNumber).toBe("CPA-MG");
    expect(seeded.parallel).toBe("Gold Refractor");
    expect(seeded.playerName).toBe("Marconi German");
    expect(seeded.source).toBe("ebay-user-purchase");
    expect(catalog.rows.has(TWIN_SLUG)).toBe(false);

    const rows = poolRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(CHECKLIST_SLUG);
    expect(rows[0].hobbyiqCardId).toBe(CHECKLIST_SLUG);
    expect(rows[0].price).toBe(182.5);
  });
});

describe("D9: a title that names no finish is Base", () => {
  it("resolves to the Base row and never invents a Refractor", async () => {
    seedChecklist();
    const purchase = purchaseFixture({
      notes: "2026 Bowman Chrome Marconi German 1st Auto CPA-MG Nationals",
      subtotal: 40, shipping: 4.99, totalCost: 44.99,
    });
    const doc = docFixture(purchase);
    const result = await autoCreateHoldingForPurchase(doc, purchase, browseFixture());
    await settle();

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const h = result.holding as Record<string, unknown>;
    expect(h.parallel ?? null).toBeNull();
    expect(h.printRun ?? null).toBeNull();
    expect(h.catalogMatchedBy).toBe("exact");
    expect(h.cardId).toBe(BASE_SLUG);
    expect(h.hobbyiqCardId).toBe(BASE_SLUG);
    expect(h.soldCompSlug).toBe(BASE_SLUG);
    expect(String(h.cardTitle)).not.toMatch(/refractor/i);
    expect(catalog.upserts).toHaveLength(0);
    const rows = poolRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(BASE_SLUG);
    expect(rows[0].price).toBe(40);
  });
});
