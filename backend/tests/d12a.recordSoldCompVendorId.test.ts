// CF-ONE-IDENTITY-IN-THE-POOL (2026-08-29, checklist D12a). Pins what the ONE
// writer does with the cardId it is handed, because the finding turned on it.
//
// sold_comps is partitioned on /cardId. Every user-sale emit in
// portfolioStore handed recordSoldComp `holding.cardId` — a CardHedge
// bubble.io id on a vendor-sourced holding — so the sale landed in the
// VENDOR's partition, and the only canonical key on the row was the
// hobbyiqCardId the store re-derived from the sale's ATTRIBUTES (free text),
// reconciled through the catalog. The holding's own pin was never consulted.
//
// These tests pin that store behaviour (it is unchanged) and the one additive
// change: `vendorCardId` rides on the row as metadata.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize };
});

import {
  recordSoldComp,
  deriveHobbyIqSlug,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

// A sold_comps fake keyed the way Cosmos keys it: (partition, id). Queries are
// interpreted from their `c.field = @param` predicates; range predicates are
// ignored (a superset is what the probes tolerate).
function fakeContainer(): { container: Container; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  const key = (id: string, pk: string) => `${pk}::${id}`;
  const run = (q: string, params: Record<string, unknown>): unknown[] => {
    let list = Array.from(store.values());
    const pred = /c\.(\w+)\s*(!=|=)\s*(@\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pred.exec(q)) !== null) {
      const [, field, op, param] = m;
      if (!(param in params)) continue;
      const want = params[param];
      list = list.filter((r) => (op === "=" ? r[field] === want : r[field] !== want));
    }
    if (/VALUE\s+COUNT\(1\)/i.test(q)) return [list.length];
    if (/TOP\s+1\s+VALUE\s+1/i.test(q)) return list.length ? [1] : [];
    return list;
  };
  const container = {
    item(id: string, pk: string) {
      return {
        async read() {
          const r = store.get(key(id, pk));
          if (!r) { const e = new Error("NotFound") as Error & { code: number }; e.code = 404; throw e; }
          return { resource: r };
        },
        async delete() { store.delete(key(id, pk)); return { resource: undefined }; },
      };
    },
    items: {
      async upsert(doc: Record<string, unknown>) { store.set(key(String(doc.id), String(doc.cardId)), doc); return { resource: doc }; },
      async create(doc: Record<string, unknown>) { store.set(key(String(doc.id), String(doc.cardId)), doc); return { resource: doc }; },
      query(spec: string | { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        const q = typeof spec === "string" ? spec : spec.query;
        const params: Record<string, unknown> = {};
        if (typeof spec !== "string") for (const p of spec.parameters ?? []) params[p.name] = p.value;
        return { async fetchAll() { return { resources: run(q, params) }; } };
      },
    },
  };
  return { container: container as unknown as Container, store };
}

const VENDOR_ID = "1606922959335x293409091214639100";
const POOL_SLUG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";

const sale = {
  playerName: "Theo Gillen",
  cardYear: 2024,
  setName: "Bowman Chrome",
  cardNumber: "CPA-TG",
  parallel: "Blue Refractor",
  isAuto: true,
  sport: "baseball",
  price: 729,
  soldAt: "2026-08-20T00:00:00.000Z",
  source: "ebay-user-sale" as const,
  sourceExternalId: "12-34567-89012",
  contributorUserId: "user-1",
  verifiedByUser: true,
  confidence: 1.0,
};

let fake: ReturnType<typeof fakeContainer>;

beforeEach(() => {
  fake = fakeContainer();
  _setContainerForTests(fake.container);
  matcher.canonicalize.mockReset();
  delete process.env.CATALOG_MATCH_ONLY_ENABLED;
});
afterEach(() => {
  _setContainerForTests(null);
});

function rows(): Array<Record<string, unknown>> {
  return Array.from(fake.store.values());
}

describe("recordSoldComp with a VENDOR cardId — what the store does today", () => {
  it("files the row in the vendor id's partition; hobbyiqCardId is derived from the attributes and catalog-reconciled, never read off the cardId", async () => {
    matcher.canonicalize.mockResolvedValue({ slug: POOL_SLUG, found: true, confidence: 0.98, matchedBy: "exact" });
    const res = await recordSoldComp({ ...sale, cardId: VENDOR_ID });
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.cardId).toBe(VENDOR_ID);                 // the partition IS the vendor id
    expect(doc.hobbyiqCardId).toBe(POOL_SLUG);          // the canonical key came from the attributes -> catalog
    expect(res.hobbyiqCardId).toBe(POOL_SLUG);
    expect(doc.vendorCardId).toBeNull();                // nothing told the store this was a vendor id
  });

  it("a user sale the catalog cannot place is NOT written (D7d: catalog-unmatched), whatever the cardId", async () => {
    matcher.canonicalize.mockResolvedValue({ slug: POOL_SLUG, found: false, confidence: 0.4, matchedBy: "not-found" });
    const res = await recordSoldComp({ ...sale, cardId: VENDOR_ID });
    expect(res.written).toBe(false);
    expect(res.reason).toBe("catalog-unmatched");
    expect(rows()).toHaveLength(0);
  });
});

describe("recordSoldComp with an hiq: cardId", () => {
  it("files the row in the slug's partition and carries the vendor id as metadata", async () => {
    matcher.canonicalize.mockResolvedValue({ slug: POOL_SLUG, found: true, confidence: 0.98, matchedBy: "exact" });
    const res = await recordSoldComp({ ...sale, cardId: POOL_SLUG, vendorCardId: VENDOR_ID });
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.cardId).toBe(POOL_SLUG);
    expect(doc.hobbyiqCardId).toBe(POOL_SLUG);
    // Mutation check: drop `vendorCardId` from the doc and this is undefined.
    expect(doc.vendorCardId).toBe(VENDOR_ID);
  });

  it("still derives hobbyiqCardId from the attributes — a cardId slug and the derived slug can disagree, and the row shows both", async () => {
    const derived = deriveHobbyIqSlug(sale).slug;
    expect(derived).toBeTruthy();
    expect(derived).not.toBe(POOL_SLUG);
    // The catalog confirms the DERIVED slug (bowman-chrome), while the caller
    // filed under a bowman-draft slug: the store does not rewrite one from
    // the other. This is the disagreement ebayAutoHolding logs as
    // ebay_import_sale_slug_disagrees; the emit sites now pass the pin, and
    // the pin's attributes, so the two derive together.
    matcher.canonicalize.mockResolvedValue({ slug: derived, found: true, confidence: 0.98, matchedBy: "exact" });
    const res = await recordSoldComp({ ...sale, cardId: POOL_SLUG });
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.cardId).toBe(POOL_SLUG);
    expect(doc.hobbyiqCardId).toBe(derived);
  });
});
