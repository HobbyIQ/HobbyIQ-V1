// CF-PLAYER-TREND (Drew, 2026-07-17). Tests for the store's slug +
// upsert + read semantics.

import { describe, it, expect, afterEach } from "vitest";
import {
  slugPlayer,
  upsertPlayerTrend,
  readPlayerTrend,
  _setContainerForTesting,
} from "../src/services/portfolioiq/playerTrendStore.service.js";
import type { PlayerTrendResult } from "../src/types/playerTrend.types.js";

function makeTrend(overrides: Partial<PlayerTrendResult> = {}): PlayerTrendResult {
  return {
    player: "Eric Hartman",
    computedAt: "2026-07-17T12:00:00Z",
    momentum: 1.36,
    direction: "up",
    velocityPerWeek: 228.67,
    cardsInPool: 56,
    qualifyingCards: 25,
    totalSales: 1754,
    perCardRatios: [],
    flags: [],
    options: {
      recentWindowDays: 30,
      priorWindowDays: 30,
      minSalesPerWindow: 3,
      minTotalSales: 4,
      topCardsInResult: 20,
    },
    ...overrides,
  };
}

function makeMockContainer() {
  const items: Record<string, any> = {};
  return {
    __items: items,
    items: {
      upsert: async (doc: any) => {
        items[doc.id] = doc;
        return { resource: doc };
      },
      query: () => ({
        hasMoreResults: () => false,
        fetchNext: async () => ({ resources: [Object.keys(items).length] }),
      }),
    },
    item: (id: string, _pk: string) => ({
      read: async () => {
        if (id in items) return { resource: items[id] };
        const err: any = new Error("NotFound");
        err.code = 404;
        throw err;
      },
    }),
  };
}

describe("slugPlayer", () => {
  it("lowercases + underscores + trims edge underscores", () => {
    expect(slugPlayer("Eric Hartman")).toBe("eric_hartman");
    expect(slugPlayer("Ken Griffey Jr.")).toBe("ken_griffey_jr");
    expect(slugPlayer("  Ronaldo Peña  ")).toBe("ronaldo_pe_a");
    expect(slugPlayer("A.J. Preller")).toBe("a_j_preller");
    expect(slugPlayer("Shohei Ohtani")).toBe("shohei_ohtani");
  });

  it("collapses multiple non-alphanum in a row", () => {
    expect(slugPlayer("O'Malley - III")).toBe("o_malley_iii");
  });
});

describe("upsertPlayerTrend / readPlayerTrend", () => {
  afterEach(() => _setContainerForTesting(null));

  it("upsert then read returns the same trend", async () => {
    const mock = makeMockContainer();
    _setContainerForTesting(mock as any);
    const t = makeTrend();
    const stored = await upsertPlayerTrend(t);
    expect(stored.id).toBe("eric_hartman");
    expect(stored.version).toBe(1);
    expect(stored.momentum).toBe(1.36);
    const read = await readPlayerTrend("Eric Hartman");
    expect(read).not.toBeNull();
    expect(read!.momentum).toBe(1.36);
  });

  it("read returns null for absent player (Cosmos 404)", async () => {
    const mock = makeMockContainer();
    _setContainerForTesting(mock as any);
    const read = await readPlayerTrend("Nobody Ever");
    expect(read).toBeNull();
  });

  it("upsert overwrites existing trend (same id)", async () => {
    const mock = makeMockContainer();
    _setContainerForTesting(mock as any);
    await upsertPlayerTrend(makeTrend({ momentum: 1.36 }));
    await upsertPlayerTrend(makeTrend({ momentum: 1.48 }));
    const read = await readPlayerTrend("Eric Hartman");
    expect(read!.momentum).toBe(1.48);
  });
});
