// CF-USER-REPUTATION (Drew, 2026-07-15) — pins the per-user attestation
// reputation store. Reputation is EARNED via activity and lost via
// pool-pollution flags. Later PR will apply reputation as an
// aggregation weight (0.6 + 0.4 * reputation).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  computeReputation,
  getUserReputation,
  bumpUserStats,
  _setContainerForTests,
  type UserReputationDoc,
} from "../src/services/portfolioiq/userReputation.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.userId}::${doc.id}`, doc);
        return { resource: doc };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const doc = store.get(`${pk}::${id}`);
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

describe("computeReputation — pure function", () => {
  it("new user (0 stats) → 0.5 baseline", () => {
    expect(computeReputation({ confirmations: 0 })).toBe(0.5);
  });

  it("activity bonus grows with confirmations, plateaus below 0.9", () => {
    const r10 = computeReputation({ confirmations: 10 });
    const r50 = computeReputation({ confirmations: 50 });
    const r200 = computeReputation({ confirmations: 200 });
    expect(r10).toBeGreaterThan(0.5);
    expect(r50).toBeGreaterThan(r10);
    expect(r200).toBeGreaterThan(r50);
    expect(r200).toBeLessThan(0.95);  // plateau ~0.9
  });

  it("flags-against penalty (-0.05 each) — heavy negative signal", () => {
    const clean = computeReputation({ confirmations: 100 });
    const oneFlag = computeReputation({ confirmations: 100, flagsAgainst: 1 });
    const fiveFlags = computeReputation({ confirmations: 100, flagsAgainst: 5 });
    expect(clean - oneFlag).toBeCloseTo(0.05, 2);
    expect(clean - fiveFlags).toBeCloseTo(0.25, 2);
  });

  it("corrections penalty is small + capped (parser bugs shouldn't destroy users)", () => {
    const noCorrections = computeReputation({ confirmations: 50 });
    const withCorrections = computeReputation({ confirmations: 50, totalCorrections: 200 });
    // Capped at 0.05 penalty regardless of how many corrections (small
    // FP tolerance — subtraction produces 0.0500000000000004 in JS).
    expect(noCorrections - withCorrections).toBeLessThanOrEqual(0.051);
  });

  it("clamps to [0.05, 0.95]", () => {
    // Impossible-to-achieve high score
    expect(computeReputation({ confirmations: 100_000 })).toBeLessThanOrEqual(0.95);
    // Attack scenario: massive flags-against
    expect(computeReputation({ confirmations: 0, flagsAgainst: 100 })).toBe(0.05);
  });

  it("flags-issued bonus is small + capped (prevents gaming)", () => {
    const noFlags = computeReputation({ confirmations: 20 });
    const someFlags = computeReputation({ confirmations: 20, flagsIssued: 5 });
    const manyFlags = computeReputation({ confirmations: 20, flagsIssued: 100 });
    expect(someFlags).toBeGreaterThan(noFlags);
    expect(manyFlags - noFlags).toBeLessThanOrEqual(0.051);  // capped (FP tolerance)
  });
});

describe("getUserReputation — safe defaults", () => {
  it("returns neutral (0.5) for empty userId", async () => {
    const r = await getUserReputation("");
    expect(r.reputation).toBe(0.5);
    expect(r.confirmations).toBe(0);
  });

  it("returns neutral for unknown user (no doc)", async () => {
    const r = await getUserReputation("u-never-seen");
    expect(r.reputation).toBe(0.5);
    expect(r.confirmations).toBe(0);
  });

  it("returns stored doc when present", async () => {
    await bumpUserStats({ userId: "u-1", confirmations: 5 });
    const r = await getUserReputation("u-1");
    expect(r.confirmations).toBe(5);
    expect(r.reputation).toBeGreaterThan(0.5);
  });
});

describe("bumpUserStats — write path", () => {
  it("no-ops on empty userId", async () => {
    await bumpUserStats({ userId: "", confirmations: 1 });
    expect(store.size).toBe(0);
  });

  it("first bump creates the doc + stamps firstSeenAt", async () => {
    const t0 = Date.now();
    await bumpUserStats({ userId: "u-1", confirmations: 1 });
    const rows = Array.from(store.values()) as UserReputationDoc[];
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("u-1");
    expect(rows[0].confirmations).toBe(1);
    expect(Math.abs(Date.parse(rows[0].firstSeenAt) - t0)).toBeLessThan(5_000);
  });

  it("subsequent bumps accumulate stats", async () => {
    await bumpUserStats({ userId: "u-1", confirmations: 5, totalCorrections: 3 });
    await bumpUserStats({ userId: "u-1", confirmations: 2 });
    await bumpUserStats({ userId: "u-1", flagsIssued: 1 });
    const r = await getUserReputation("u-1");
    expect(r.confirmations).toBe(7);
    expect(r.totalCorrections).toBe(3);
    expect(r.flagsIssued).toBe(1);
  });

  it("recomputes reputation on every bump", async () => {
    await bumpUserStats({ userId: "u-1", confirmations: 1 });
    const r1 = await getUserReputation("u-1");
    await bumpUserStats({ userId: "u-1", confirmations: 50 });
    const r2 = await getUserReputation("u-1");
    expect(r2.reputation).toBeGreaterThan(r1.reputation);
  });

  it("firstSeenAt is preserved across bumps", async () => {
    await bumpUserStats({ userId: "u-1", confirmations: 1 });
    const r1 = await getUserReputation("u-1");
    const originalFirstSeen = r1.firstSeenAt;
    await new Promise((r) => setTimeout(r, 10));
    await bumpUserStats({ userId: "u-1", confirmations: 1 });
    const r2 = await getUserReputation("u-1");
    expect(r2.firstSeenAt).toBe(originalFirstSeen);
    expect(Date.parse(r2.updatedAt)).toBeGreaterThan(Date.parse(originalFirstSeen));
  });
});
