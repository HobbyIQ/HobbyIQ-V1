/**
 * F4 (review finding on the R66/R67/R70 PR, 2026-09-19). 791 unregistered
 * single-word insert roots in the real corpus are ordinary English words
 * ("fireworks", "dominance", "prime", "emergent", ...) -- an incidental
 * mention in an otherwise ORDINARY base-card title must not park the sale.
 *
 * RULING pinned here, end-to-end through the real `recordSoldComp`: for an
 * UNREGISTERED root, park only if the BASE checklist does NOT confirm this
 * sale as a base card. When it DOES confirm (same setKey/cardNumber/player
 * as a checklist row), the sale is left untouched -- no park, no re-key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";

const catalogQuery = vi.fn();
vi.mock("@azure/cosmos", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class FakeCosmosClient {
    database() { return { container: () => ({ items: { query: catalogQuery } }) }; }
  }
  return { ...actual, CosmosClient: FakeCosmosClient };
});

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize };
});

import { recordSoldComp, _setContainerForTests } from "../src/services/portfolioiq/soldCompsStore.service.js";
import { _clearInsertSetConfirmCacheForTests } from "../src/services/portfolioiq/insertSetChecklistConfirm.js";

function fakeSoldCompsContainer(): { container: Container; store: Map<string, Record<string, unknown>> } {
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

// panini-prizm basketball 2024 carries a real, unregistered single-word
// insert root "Fireworks" in the shipped corpus (data/checklist-parallel-names.json).
const sale = {
  playerName: "Some Player",
  cardYear: 2024,
  setName: "Panini Prizm",
  cardNumber: "6",
  parallel: "Base",
  isAuto: false,
  sport: "basketball",
  price: 120,
  soldAt: "2026-09-01T00:00:00.000Z",
  source: "tca-ebay" as const,
  sourceExternalId: "tca-f4",
  title: "2024 Panini Prizm Fireworks Some Player #6",
  cardId: "hiq:basketball:2024:panini-prizm:6:base:no-auto",
};

let fake: ReturnType<typeof fakeSoldCompsContainer>;

beforeEach(() => {
  fake = fakeSoldCompsContainer();
  _setContainerForTests(fake.container);
  matcher.canonicalize.mockReset();
  catalogQuery.mockReset();
  _clearInsertSetConfirmCacheForTests();
  delete process.env.CATALOG_MATCH_ONLY_ENABLED;
  process.env.COSMOS_CONNECTION_STRING =
    process.env.COSMOS_CONNECTION_STRING
    ?? "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdC1rZXktbm90LWEtc2VjcmV0;";
});
afterEach(() => { _setContainerForTests(null); });

function rows(): Array<Record<string, unknown>> { return Array.from(fake.store.values()); }

describe("F4 -- an unregistered insert root that is an ordinary word in a checklist-confirmed base title", () => {
  it("is left UNTOUCHED (no park) when the base checklist confirms this sale's card number", async () => {
    catalogQuery.mockImplementation(() => ({
      fetchAll: async () => ({ resources: [{ id: "hiq:z", source: "beckett-2026-08", cardNumber: "6", playerName: "Some Player" }] }),
    }));
    const res = await recordSoldComp(sale);
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.identityUnverified).toBeUndefined();
    expect(doc.identityUnverifiedReason).toBeUndefined();
  });

  it("PARKS as insert-named-no-key when the base checklist does NOT confirm this card either", async () => {
    catalogQuery.mockImplementation(() => ({
      // Checklist rows exist for the product but none at THIS card number.
      fetchAll: async () => ({ resources: [{ id: "hiq:z", source: "beckett-2026-08", cardNumber: "999", playerName: "Someone Else" }] }),
    }));
    const res = await recordSoldComp(sale);
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.identityUnverified).toBe(true);
    expect(doc.identityUnverifiedReason).toBe("insert-named-no-key");
  });

  it("FIX B: is left UNTOUCHED (no park) when the base-confirm read answers UNKNOWN (a query throw) -- a stalled read must never park a real base sale", async () => {
    catalogQuery.mockImplementation(() => ({
      fetchAll: async () => { throw new Error("simulated catalog blip"); },
    }));
    const res = await recordSoldComp(sale);
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.identityUnverified).toBeUndefined();
    expect(doc.identityUnverifiedReason).toBeUndefined();
  });
});
