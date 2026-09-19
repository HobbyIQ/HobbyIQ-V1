/**
 * F1 (critical, review finding on the R66/R67/R70 PR, 2026-09-19).
 *
 * `recordSoldComp`'s `doc.cardId` -- the Cosmos PARTITION KEY, i.e. the pool a
 * sale is actually read from -- came from the caller's `input.cardId`
 * verbatim, never from the derived `hobbyiqCardId`. When the R66/R67 pre-step
 * re-keys `hobbyiqCardId` to an insert product while `cardId` stays an `hiq:`
 * slug on the pre-rewrite BASE product, `decideSplitIdentity` (the existing
 * #1924 write-door guard) sees "same sport, different product" and PARKS the
 * row as `split-identity` -- `cardId` never moves, so the re-key was a
 * complete no-op for the pool `exactPoolReader` actually reads from.
 *
 * THE FIX pinned here: `carryProductRekeyOntoCardId` (splitIdentityWriteGuard.ts)
 * rewrites ONLY `cardId`'s product segment when the re-key is CONFIRMED
 * (F3+F5) and `cardId` already named the exact pre-rewrite base product --
 * so `cardId` and `hobbyiqCardId` agree and the row files under the insert's
 * OWN pool, one axis moved, nothing else.
 *
 * TWO CALLER SHAPES, both exercised end-to-end through the real
 * `recordSoldComp`:
 *
 *   - a disagreeing `hiq:` input.cardId (F1's own repro shape) -- must carry;
 *   - a RAW VENDOR cardId (never an `hiq:` slug) -- must be left alone, since
 *     `decideSplitIdentity`'s own vendor-key fail-open never compares it in
 *     the first place, and `carryProductRekeyOntoCardId` must agree.
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

import {
  recordSoldComp,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";
import { _clearInsertSetConfirmCacheForTests } from "../src/services/portfolioiq/insertSetChecklistConfirm.js";

// A sold_comps fake keyed the way Cosmos keys it: (partition, id).
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

// The title names Donruss Optic's registered "Downtown" insert; the fake
// card_catalog answers the F3+F5 confirmation query with a checklist row at
// this exact card number, so the re-key is CONFIRMED.
const CONFIRMING_ROW = { id: "hiq:x", source: "checklistcenter-2026-08-30", cardNumber: "6", playerName: "Justin Herbert" };
const sale = {
  playerName: "Justin Herbert",
  cardYear: 2024,
  setName: "Donruss Optic",
  cardNumber: "6",
  parallel: "Base",
  isAuto: false,
  sport: "football",
  price: 450,
  soldAt: "2026-09-01T00:00:00.000Z",
  source: "tca-ebay" as const,
  sourceExternalId: "tca-1",
  title: "2024 Panini Donruss Optic Downtown Justin Herbert #6",
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
afterEach(() => {
  _setContainerForTests(null);
});

function rows(): Array<Record<string, unknown>> {
  return Array.from(fake.store.values());
}

describe("F1 -- a disagreeing hiq: input.cardId carries the confirmed re-key onto the pool", () => {
  it("cardId's product segment moves with hobbyiqCardId's confirmed insert re-key -- no split-identity park", async () => {
    catalogQuery.mockImplementation(() => ({
      fetchAll: async () => ({ resources: [CONFIRMING_ROW] }),
    }));
    // input.cardId names the BASE product (donruss-optic) at the SAME sport --
    // exactly the F1 repro shape: a caller's cardId that disagrees with the
    // insert-rekeyed hobbyiqCardId on setKey alone.
    const baseCardId = "hiq:football:2024:donruss-optic:6:base:no-auto";
    const res = await recordSoldComp({ ...sale, cardId: baseCardId });
    expect(res.written).toBe(true);
    const [doc] = rows();
    // Both fields now name the INSERT product -- one axis (setKey) moved,
    // sport/cardNumber/parallel untouched.
    expect(doc.hobbyiqCardId).toContain("donruss-optic-downtown");
    expect(doc.cardId).toContain("donruss-optic-downtown");
    // NOT parked as split-identity: the whole point of the fix.
    expect(doc.identityUnverified).toBeUndefined();
    expect(doc.identityUnverifiedReason).toBeUndefined();
  });

  it("without confirmation (no checklist row at this number), the sale PARKS as insert-named-unconfirmed -- cardId is never rewritten on a guess", async () => {
    catalogQuery.mockImplementation(() => ({
      // Checklist rows exist for the product, but none at card number 6 --
      // e.g. a different card number's row only.
      fetchAll: async () => ({ resources: [{ ...CONFIRMING_ROW, cardNumber: "999" }] }),
    }));
    const baseCardId = "hiq:football:2024:donruss-optic:6:base:no-auto";
    const res = await recordSoldComp({ ...sale, cardId: baseCardId });
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.identityUnverified).toBe(true);
    expect(doc.identityUnverifiedReason).toBe("insert-named-unconfirmed");
    // cardId is UNCHANGED -- no re-key on an unconfirmed title match.
    expect(doc.cardId).toBe(baseCardId);
  });
});

describe("F1 -- a RAW VENDOR cardId is never touched by the re-key carry", () => {
  it("a non-hiq cardId is left exactly as the caller supplied it, even when the re-key confirms", async () => {
    catalogQuery.mockImplementation(() => ({
      fetchAll: async () => ({ resources: [CONFIRMING_ROW] }),
    }));
    const vendorCardId = "1606922959335x293409091214639100";
    const res = await recordSoldComp({ ...sale, cardId: vendorCardId });
    expect(res.written).toBe(true);
    const [doc] = rows();
    // The partition stays the vendor id -- decideSplitIdentity's own
    // vendor-key fail-open never compares it, and carryProductRekeyOntoCardId
    // must agree rather than invent a rewrite it has no authority for.
    expect(doc.cardId).toBe(vendorCardId);
    // hobbyiqCardId still carries the confirmed insert re-key.
    expect(doc.hobbyiqCardId).toContain("donruss-optic-downtown");
    // No split-identity park: a vendor key naming no product is not a split.
    expect(doc.identityUnverified).toBeUndefined();
  });
});

describe("F1 -- no catalog access fails open to park, never to a guessed re-key", () => {
  it("when card_catalog cannot be reached (a query throws, the same shape a Cosmos blip or the shared breaker being open produces), the title match is left unconfirmed and the sale parks rather than re-keying on the title alone", async () => {
    // Simulates a catalog blip via a throwing query rather than an absent
    // connection string: catalogMatcher.service.ts caches its Cosmos client
    // at module scope for the life of the process, so once a prior test in
    // this file has built one, deleting COSMOS_CONNECTION_STRING afterward
    // would not actually remove it -- a throwing query exercises the SAME
    // fail-open path (insertSetChecklistConfirm.ts's try/catch) without
    // depending on that module-private cache's state.
    catalogQuery.mockImplementation(() => ({
      fetchAll: async () => { throw new Error("simulated catalog blip"); },
    }));
    const baseCardId = "hiq:football:2024:donruss-optic:6:base:no-auto";
    const res = await recordSoldComp({ ...sale, cardId: baseCardId });
    expect(res.written).toBe(true);
    const [doc] = rows();
    expect(doc.cardId).toBe(baseCardId);
    expect(doc.identityUnverified).toBe(true);
    expect(doc.identityUnverifiedReason).toBe("insert-named-unconfirmed");
  });
});
