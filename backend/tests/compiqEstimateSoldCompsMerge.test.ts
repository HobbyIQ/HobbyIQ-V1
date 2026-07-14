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
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
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
