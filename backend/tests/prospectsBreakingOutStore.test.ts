// CF-PROSPECTS-BREAKING-OUT-MATERIALIZE (Drew, 2026-07-26). Pins the
// per-sport rollup store — write / read / fallback contracts that the
// route depends on.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  writeProspectsRollup,
  readLatestProspectsRollup,
  _setContainerForTests,
} from "../src/services/portfolioiq/prospectsBreakingOutStore.service.js";
import type { SubRawInversion } from "../src/services/signals/subRawInversionScan.service.js";

function fakeContainer(opts: {
  failMode?: "throw-on-write" | "throw-on-read" | null;
} = {}): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        if (opts.failMode === "throw-on-write") throw new Error("simulated");
        store.set(`${doc.sport}::${doc.id}`, doc);
        return { resource: doc };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          if (opts.failMode === "throw-on-read") throw new Error("simulated");
          const key = `${pk}::${id}`;
          if (!store.has(key)) {
            const err: any = new Error("not found");
            err.statusCode = 404; err.code = 404;
            throw err;
          }
          return { resource: store.get(key) as T };
        },
      };
    },
  } as unknown as Container;
  return { container, store };
}

const sampleInv: SubRawInversion = {
  cardId: "cs-hartman",
  playerName: "Eric Hartman",
  parallel: "Blue Refractor",
  cardNumber: "CPA-EH",
  cardYear: 2026,
  grader: "PSA 10",
  gradedMedian: 500,
  gradedCount: 8,
  rawMedian: 800,
  rawMax: 1200,
  rawCount: 4,
  marginPct: 60,
  marginUSD: 300,
};

let store: Map<string, any>;
beforeEach(() => {
  const f = fakeContainer();
  store = f.store;
  _setContainerForTests(f.container);
});
afterEach(() => {
  _setContainerForTests(null);
});

describe("writeProspectsRollup", () => {
  it("upserts today's rollup with the ranked prospects", async () => {
    const ok = await writeProspectsRollup({
      sport: "baseball",
      windowDays: 30,
      minMarginPct: 5,
      prospects: [sampleInv],
      totalDetected: 1,
    });
    expect(ok).toBe(true);
    expect(store.size).toBe(1);
    const [[, doc]] = [...store.entries()];
    expect(doc.sport).toBe("baseball");
    expect(doc.windowDays).toBe(30);
    expect(doc.minMarginPct).toBe(5);
    expect(doc.prospects).toEqual([sampleInv]);
    expect(doc.totalDetected).toBe(1);
    expect(doc.id).toMatch(/^baseball::\d{4}-\d{2}-\d{2}$/);
  });

  it("returns false on empty sport (guard)", async () => {
    const ok = await writeProspectsRollup({
      sport: "", windowDays: 30, minMarginPct: 5, prospects: [], totalDetected: 0,
    });
    expect(ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it("swallows Cosmos errors — never rejects (best-effort contract)", async () => {
    const f = fakeContainer({ failMode: "throw-on-write" });
    _setContainerForTests(f.container);
    const ok = await writeProspectsRollup({
      sport: "baseball", windowDays: 30, minMarginPct: 5, prospects: [sampleInv], totalDetected: 1,
    });
    expect(ok).toBe(false);
  });
});

describe("readLatestProspectsRollup", () => {
  it("returns today's rollup on hit", async () => {
    await writeProspectsRollup({
      sport: "baseball", windowDays: 30, minMarginPct: 5, prospects: [sampleInv], totalDetected: 1,
    });
    const rollup = await readLatestProspectsRollup("baseball");
    expect(rollup).not.toBeNull();
    expect(rollup?.sport).toBe("baseball");
    expect(rollup?.prospects).toEqual([sampleInv]);
  });

  it("returns null when no rollup exists for today OR yesterday", async () => {
    const rollup = await readLatestProspectsRollup("baseball");
    expect(rollup).toBeNull();
  });

  it("returns null on empty sport (guard)", async () => {
    expect(await readLatestProspectsRollup("")).toBeNull();
  });

  it("returns null on transient read failure (route fallback contract)", async () => {
    const f = fakeContainer({ failMode: "throw-on-read" });
    _setContainerForTests(f.container);
    expect(await readLatestProspectsRollup("baseball")).toBeNull();
  });

  it("isolates by sport — reading basketball does not return baseball's rollup", async () => {
    await writeProspectsRollup({
      sport: "baseball", windowDays: 30, minMarginPct: 5, prospects: [sampleInv], totalDetected: 1,
    });
    expect(await readLatestProspectsRollup("basketball")).toBeNull();
  });
});
