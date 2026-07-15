// CF-SOLD-COMPS-READ (Drew, 2026-07-14) — pins the compiq engine wire
// that reads user-contributed comps from the unified sold_comps pool and
// merges them into vendor-fetched comps.
//
// Guards:
//   - Env-gate: no-op when COMPIQ_READ_SOLD_COMPS_ENABLED != "true"
//   - Trust-source filter: only reads user-contributed sources
//   - Dedup: (day + rounded price) tuple prevents double-count when
//     vendor + user emit the same physical sale
//   - Cap: MAX_INJECT hard-limits to 20 injections
//   - Silent-fail: Cosmos absence or read error returns vendor comps unchanged
//   - Sort order: newest first (matches CH/CS convention downstream code assumes)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
  _setContainerForTests,
  type SoldCompDoc,
} from "../src/services/portfolioiq/soldCompsStore.service.js";
import { augmentCompsWithUserPool } from "../src/services/compiq/compiqEstimate.service.js";

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
    // CF-USER-COMPS-SOFT-DELETE (#6): flagCompAsWrong uses container.item(id, pk).read()
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

const emptyFetched = (compsArgs: Array<{ price: number; soldDate: string; title?: string }> = []) => ({
  comps: compsArgs.map((c) => ({
    price: c.price,
    title: c.title ?? "vendor sale",
    soldDate: c.soldDate,
    listingType: null,
    imageUrl: null,
  })),
  card: {
    card_id: "cs-hartman-blue",
    title: "Eric Hartman Blue Refractor Auto",
    player: "Eric Hartman",
    set: "2026 Bowman Chrome",
    release: "Bowman Chrome",
    year: 2026,
    number: "CPA-EHA",
    variant: "Blue Refractor Auto",
  } as const,
  variantWarning: [],
  aiCategory: "Baseball" as string | null,
});

const ORIGINAL_ENV = process.env.COMPIQ_READ_SOLD_COMPS_ENABLED;

beforeEach(() => {
  const f = fakeContainer();
  _setContainerForTests(f.container);
  process.env.COMPIQ_READ_SOLD_COMPS_ENABLED = "true";
});
afterEach(() => {
  _setContainerForTests(null);
  if (ORIGINAL_ENV === undefined) delete process.env.COMPIQ_READ_SOLD_COMPS_ENABLED;
  else process.env.COMPIQ_READ_SOLD_COMPS_ENABLED = ORIGINAL_ENV;
});

describe("augmentCompsWithUserPool — env gate", () => {
  it("no-ops when COMPIQ_READ_SOLD_COMPS_ENABLED is unset", async () => {
    delete process.env.COMPIQ_READ_SOLD_COMPS_ENABLED;
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1500,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
    expect(merged.comps[0].price).toBe(420);
  });

  it("no-ops when COMPIQ_READ_SOLD_COMPS_ENABLED is not exactly 'true'", async () => {
    process.env.COMPIQ_READ_SOLD_COMPS_ENABLED = "1";  // truthy but not "true"
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1500,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
  });
});

describe("augmentCompsWithUserPool — merge behavior", () => {
  it("injects user-contributed comps alongside vendor comps", async () => {
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1500,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "ebay-1", verifiedByUser: true,
    });
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1800,
      soldAt: "2026-07-12T00:00:00Z", source: "manual-user-entry",
      sourceExternalId: "manual-1", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(3);
    // Sorted DESC by soldDate
    expect(merged.comps[0].soldDate).toBe("2026-07-12T00:00:00Z");
    expect(merged.comps[0].price).toBe(1800);
    expect(merged.comps[1].soldDate).toBe("2026-07-10T00:00:00Z");
    expect(merged.comps[2].soldDate).toBe("2026-07-08T00:00:00Z");
  });

  it("only reads user-contributed sources — cardhedge/cardsight pool entries never merge back in", async () => {
    // CH emit already lives in fetched.comps upstream; reading it back would double-count
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 420,
      soldAt: "2026-07-08T00:00:00Z", source: "cardhedge",
      sourceExternalId: "ch-1",
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
  });

  it("dedups by (day + rounded price) — same physical sale from user + vendor doesn't double", async () => {
    // A user records a purchase; CH later emits the same sale into the pool AND into fetched.comps
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1499.99,
      soldAt: "2026-07-10T14:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "user-1", verifiedByUser: true,
    });
    // Vendor already has essentially the same sale (rounds to same price, same day)
    const vendor = emptyFetched([{ price: 1500, soldDate: "2026-07-10T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
  });

  it("does merge when day matches but price is meaningfully different", async () => {
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1800,
      soldAt: "2026-07-10T14:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "user-1", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-10T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(2);
    expect(merged.comps.map((c) => c.price).sort((a, b) => a - b)).toEqual([420, 1800]);
  });

  it("caps injections at MAX_INJECT (20)", async () => {
    for (let i = 0; i < 30; i++) {
      // Distinct prices + distinct days → no dedup collisions
      const day = String(1 + i).padStart(2, "0");
      await recordSoldComp({
        cardId: "cs-hartman-blue", playerName: "Eric Hartman",
        price: 1000 + i,
        soldAt: `2026-06-${day}T00:00:00Z`, source: "ebay-user-purchase",
        sourceExternalId: `u-${i}`, verifiedByUser: true,
      });
    }
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    // 1 vendor + up to 20 user
    expect(merged.comps.length).toBeLessThanOrEqual(21);
    expect(merged.comps.length).toBeGreaterThanOrEqual(21);
  });
});

describe("augmentCompsWithUserPool — fallback behavior", () => {
  it("returns vendor comps unchanged when no cardId provided anywhere", async () => {
    const vendor = { ...emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]), card: null };
    const merged = await augmentCompsWithUserPool(vendor, undefined);
    expect(merged).toBe(vendor);  // exact same reference — early return
  });

  it("falls back to fetched.card.card_id when caller doesn't pass cardId", async () => {
    await recordSoldComp({
      cardId: "cs-hartman-blue", playerName: "Eric Hartman", price: 1500,
      soldAt: "2026-07-10T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, undefined);
    expect(merged.comps).toHaveLength(2);
  });

  it("returns vendor unchanged when pool is empty", async () => {
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
  });

  it("returns vendor unchanged on Cosmos absence (silent fail)", async () => {
    _setContainerForTests(null);
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-hartman-blue");
    expect(merged.comps).toHaveLength(1);
  });
});

// CF-USER-COMPS-AGING (#7)
describe("augmentCompsWithUserPool — aging (drop stale user comps)", () => {
  it("drops user comps older than the 180-day default window", async () => {
    // Fresh comp (30 days ago) — should merge
    const fresh = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // Stale comp (200 days ago) — should be dropped
    const stale = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 100, soldAt: fresh,
      source: "ebay-user-purchase", sourceExternalId: "fresh", verifiedByUser: true,
    });
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 500, soldAt: stale,
      source: "ebay-user-purchase", sourceExternalId: "stale", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-x");
    // Only the fresh (100) should merge — vendor 420 + fresh 100 = 2 comps
    expect(merged.comps).toHaveLength(2);
    const prices = merged.comps.map((c) => c.price).sort((a, b) => a - b);
    expect(prices).toEqual([100, 420]);
  });

  it("respects COMPIQ_USER_COMP_MAX_AGE_DAYS override", async () => {
    const originalOverride = process.env.COMPIQ_USER_COMP_MAX_AGE_DAYS;
    process.env.COMPIQ_USER_COMP_MAX_AGE_DAYS = "30";
    try {
      const fresh = new Date(Date.now() - 15 * 86_400_000).toISOString();
      const borderline = new Date(Date.now() - 60 * 86_400_000).toISOString(); // > 30d
      await recordSoldComp({
        cardId: "cs-x", playerName: "P", price: 100, soldAt: fresh,
        source: "ebay-user-purchase", sourceExternalId: "f", verifiedByUser: true,
      });
      await recordSoldComp({
        cardId: "cs-x", playerName: "P", price: 500, soldAt: borderline,
        source: "ebay-user-purchase", sourceExternalId: "b", verifiedByUser: true,
      });
      const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
      const merged = await augmentCompsWithUserPool(vendor, "cs-x");
      expect(merged.comps).toHaveLength(2);  // vendor + fresh only
      expect(merged.comps.map((c) => c.price).sort((a, b) => a - b)).toEqual([100, 420]);
    } finally {
      if (originalOverride === undefined) delete process.env.COMPIQ_USER_COMP_MAX_AGE_DAYS;
      else process.env.COMPIQ_USER_COMP_MAX_AGE_DAYS = originalOverride;
    }
  });

  it("drops comps with unparseable soldAt as aged-out (defensive)", async () => {
    // Directly insert a malformed doc so recordSoldComp guards don't reject.
    // (recordSoldComp rejects empty soldAt — we're testing the reader's
    // resilience against pre-existing dirty data.)
    const container = (await import("../src/services/portfolioiq/soldCompsStore.service.js"))._setContainerForTests;
    void container;  // no-op to appease TS
    // Instead: use a garbage-date string that Date.parse can't handle
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 100,
      soldAt: "not-a-real-date",
      source: "ebay-user-purchase", sourceExternalId: "bad", verifiedByUser: true,
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-x");
    // Bad-date comp dropped → only vendor comp survives
    expect(merged.comps).toHaveLength(1);
  });
});

// CF-USER-COMPS-SOFT-DELETE (#6)
describe("augmentCompsWithUserPool — soft-delete via flaggedWrong", () => {
  it("skips flaggedWrong comps during merge (moderation)", async () => {
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 100,
      soldAt: new Date().toISOString(),
      source: "ebay-user-purchase", sourceExternalId: "clean", verifiedByUser: true,
    });
    await recordSoldComp({
      cardId: "cs-x", playerName: "P", price: 999,
      soldAt: new Date().toISOString(),
      source: "ebay-user-purchase", sourceExternalId: "wrong", verifiedByUser: true,
    });
    // Flag the second one
    const { flagCompAsWrong } = await import("../src/services/portfolioiq/soldCompsStore.service.js");
    await flagCompAsWrong({
      cardId: "cs-x", compId: "ebay-user-purchase::wrong", flaggedByUserId: "u-mod",
    });
    const vendor = emptyFetched([{ price: 420, soldDate: "2026-07-08T00:00:00Z" }]);
    const merged = await augmentCompsWithUserPool(vendor, "cs-x");
    // vendor 420 + clean 100 = 2 comps. The flagged 999 is filtered.
    expect(merged.comps).toHaveLength(2);
    expect(merged.comps.map((c) => c.price).sort((a, b) => a - b)).toEqual([100, 420]);
  });
});
