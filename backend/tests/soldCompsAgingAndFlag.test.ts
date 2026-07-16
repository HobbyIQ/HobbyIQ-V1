// CF-USER-COMPS-AGING (#7) + CF-USER-COMPS-SOFT-DELETE (#6) — pool
// hygiene tests. Both features protect FMV accuracy without discarding
// provenance data.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
  readCompsByCardId,
  flagCompAsWrong,
  _setContainerForTests,
  type SoldCompDoc,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const key = (pk: string, id: string) => `${pk}::${id}`;
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(key(doc.cardId, doc.id), doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const cid = params.get("@cid");
            const from = params.get("@from");
            const to = params.get("@to");
            let rows = Array.from(store.values()) as SoldCompDoc[];
            if (cid) rows = rows.filter((d) => d.cardId === cid);
            if (from) rows = rows.filter((d) => d.soldAt >= from);
            if (to) rows = rows.filter((d) => d.soldAt <= to);
            rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : a.soldAt > b.soldAt ? -1 : 0));
            return { resources: rows };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const doc = store.get(key(pk, id));
          return { resource: doc as T | undefined };
        },
      };
    },
  } as unknown as Container;
  return { container, store };
}

let store: Map<string, any>;
beforeEach(() => {
  const f = fakeContainer();
  store = f.store;
  _setContainerForTests(f.container);
});
afterEach(() => _setContainerForTests(null));

describe("flagCompAsWrong — write path", () => {
  it("guards on empty cardId or compId", async () => {
    expect((await flagCompAsWrong({
      cardId: "", compId: "x", flaggedByUserId: "u-1",
    })).status).toBe("error");
    expect((await flagCompAsWrong({
      cardId: "x", compId: "", flaggedByUserId: "u-1",
    })).status).toBe("error");
  });

  it("returns not-found when the comp doesn't exist", async () => {
    const r = await flagCompAsWrong({
      cardId: "cs-x", compId: "missing::id", flaggedByUserId: "u-1",
    });
    expect(r.status).toBe("not-found");
  });

  it("flags an existing comp — sets flaggedWrong=true, flaggedByUserId, flaggedAt", async () => {
    await recordSoldComp({
      cardId: "cs-hartman",
      playerName: "Eric Hartman",
      price: 1800,
      soldAt: "2026-07-10T00:00:00Z",
      source: "ebay-user-purchase",
      sourceExternalId: "ebay-1",
      verifiedByUser: true,
    });
    const flaggedByUserId = "u-flagger";
    const t0 = Date.now();
    const r = await flagCompAsWrong({
      cardId: "cs-hartman",
      compId: "ebay-user-purchase::ebay-1",
      flaggedByUserId,
      reason: "Blue Refractor, not Blue X-Fractor",
    });
    expect(r.status).toBe("flagged");

    const rows = Array.from(store.values()) as (SoldCompDoc & { flaggedWrong?: boolean; flaggedByUserId?: string; flaggedAt?: string; flaggedReason?: string })[];
    expect(rows).toHaveLength(1);
    expect(rows[0].flaggedWrong).toBe(true);
    expect(rows[0].flaggedByUserId).toBe(flaggedByUserId);
    expect(rows[0].flaggedReason).toBe("Blue Refractor, not Blue X-Fractor");
    expect(Math.abs(Date.parse(rows[0].flaggedAt!) - t0)).toBeLessThan(5_000);
  });

  it("is idempotent — flagging twice keeps the same end state", async () => {
    await recordSoldComp({
      cardId: "cs-x",
      playerName: "P",
      price: 100,
      soldAt: "2026-07-10T00:00:00Z",
      source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    const r1 = await flagCompAsWrong({
      cardId: "cs-x", compId: "ebay-user-purchase::a", flaggedByUserId: "u-1",
    });
    const r2 = await flagCompAsWrong({
      cardId: "cs-x", compId: "ebay-user-purchase::a", flaggedByUserId: "u-1",
    });
    expect(r1.status).toBe("flagged");
    expect(r2.status).toBe("flagged");
    expect(store.size).toBe(1);
    const doc = Array.from(store.values())[0] as SoldCompDoc & { flaggedWrong?: boolean };
    expect(doc.flaggedWrong).toBe(true);
  });

  it("truncates flaggedReason to 500 chars", async () => {
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 100,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase", sourceExternalId: "a",
    });
    const bigReason = "X".repeat(1000);
    await flagCompAsWrong({
      cardId: "cs-x", compId: "ebay-user-purchase::a", flaggedByUserId: "u-1", reason: bigReason,
    });
    const doc = Array.from(store.values())[0] as SoldCompDoc & { flaggedReason?: string };
    expect(doc.flaggedReason?.length).toBe(500);
  });
});

describe("readCompsByCardId — read path passes flag through", () => {
  it("returns flaggedWrong in the read result so engine can filter", async () => {
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 100,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase", sourceExternalId: "a",
    });
    await flagCompAsWrong({
      cardId: "cs-x", compId: "ebay-user-purchase::a", flaggedByUserId: "u-1",
    });
    const rows = await readCompsByCardId({ cardId: "cs-x", fromDate: "2026-01-01T00:00:00Z" });
    expect(rows).toHaveLength(1);
    expect((rows[0] as SoldCompDoc & { flaggedWrong?: boolean }).flaggedWrong).toBe(true);
  });
});
