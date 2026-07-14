// CF-SOLD-COMPS-VENDOR-INGEST (Drew, 2026-07-14) — pins the compiq engine's
// vendor-ingest wire. Every Cardsight-served comp gets captured into the
// unified sold_comps pool. CH comps are ALREADY emitted upstream by
// tryCardHedge, so this helper must SKIP vendor==="cardhedge" to avoid
// double-writes.
//
// Fire-and-forget — the pricing hot path is authoritative, ingest is
// auxiliary. Tests await a microtask flush to observe writes.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  readCompsByCardId,
  _setContainerForTests,
  type SoldCompDoc,
} from "../src/services/portfolioiq/soldCompsStore.service.js";
import { ingestVendorCompsToPool } from "../src/services/compiq/compiqEstimate.service.js";

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

// Small helper — the ingest is fire-and-forget via an async IIFE. Give the
// microtask queue a chance to drain before asserting.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const csFetched = (opts: {
  vendor?: "cardhedge" | "cardsight" | null;
  cardId?: string | null;
  player?: string | null;
  comps?: Array<{ price: number; soldDate: string; title?: string }>;
} = {}) => ({
  vendor: opts.vendor === undefined ? ("cardsight" as const) : opts.vendor,
  comps: (opts.comps ?? []).map((c) => ({
    price: c.price,
    title: c.title ?? "vendor sale",
    soldDate: c.soldDate,
    listingType: null,
    imageUrl: null,
  })),
  card:
    opts.cardId === null
      ? null
      : {
          card_id: opts.cardId ?? "cs-hartman-blue",
          title: "Eric Hartman Blue Refractor Auto",
          player: opts.player === undefined ? "Eric Hartman" : opts.player,
          set: "2026 Bowman Chrome",
          release: "Bowman Chrome",
          year: 2026,
          number: "CPA-EHA",
          variant: "Blue Refractor Auto",
        },
  variantWarning: [],
  aiCategory: "Baseball" as string | null,
});

const ORIGINAL_ENV = process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED;

let store: Map<string, any>;
beforeEach(() => {
  const f = fakeContainer();
  store = f.store;
  _setContainerForTests(f.container);
  process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED = "true";
});
afterEach(() => {
  _setContainerForTests(null);
  if (ORIGINAL_ENV === undefined) delete process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED;
  else process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED = ORIGINAL_ENV;
});

describe("ingestVendorCompsToPool — env gate", () => {
  it("no-ops when SOLD_COMPS_VENDOR_INGEST_ENABLED is unset", async () => {
    delete process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED;
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });

  it("no-ops when flag is truthy but not exactly 'true'", async () => {
    process.env.SOLD_COMPS_VENDOR_INGEST_ENABLED = "1";
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });
});

describe("ingestVendorCompsToPool — vendor filter (avoids CH double-write)", () => {
  it("SKIPS CH-served fetches (tryCardHedge already emitted upstream)", async () => {
    ingestVendorCompsToPool(
      csFetched({
        vendor: "cardhedge",
        comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });

  it("writes on Cardsight-served fetches", async () => {
    ingestVendorCompsToPool(
      csFetched({
        vendor: "cardsight",
        comps: [
          { price: 420, soldDate: "2026-07-08T00:00:00Z" },
          { price: 450, soldDate: "2026-07-10T00:00:00Z" },
        ],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(2);
  });

  it("skips when vendor is null (unwired path)", async () => {
    ingestVendorCompsToPool(
      csFetched({
        vendor: null,
        comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });
});

describe("ingestVendorCompsToPool — identity requirements", () => {
  it("skips when card is null (no cardId to attest to)", async () => {
    ingestVendorCompsToPool(
      csFetched({
        cardId: null,
        comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });

  it("skips when playerName is missing", async () => {
    ingestVendorCompsToPool(
      csFetched({
        player: null,
        comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });

  it("skips when comps array is empty", async () => {
    ingestVendorCompsToPool(csFetched({ comps: [] }));
    await flushMicrotasks();
    expect(store.size).toBe(0);
  });
});

describe("ingestVendorCompsToPool — per-comp write shape", () => {
  it("stamps source=cardsight, confidence=0.6, verifiedByUser=false", async () => {
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    const rows = await readCompsByCardId({
      cardId: "cs-hartman-blue",
      fromDate: "2026-06-01T00:00:00Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("cardsight");
    expect(rows[0].confidence).toBe(0.6);
    expect(rows[0].verifiedByUser).toBe(false);
  });

  it("carries denormalized identity fields for cross-partition search", async () => {
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    const rows = await readCompsByCardId({
      cardId: "cs-hartman-blue",
      fromDate: "2026-06-01T00:00:00Z",
    });
    expect(rows[0].playerName).toBe("Eric Hartman");
    expect(rows[0].cardYear).toBe(2026);
    expect(rows[0].setName).toBe("2026 Bowman Chrome");
    expect(rows[0].parallel).toBe("Blue Refractor Auto");
    expect(rows[0].cardNumber).toBe("CPA-EHA");
    expect(rows[0].isAuto).toBe(true);  // CPA-* triggers auto detection
  });

  it("filters out non-positive prices and missing soldDate", async () => {
    ingestVendorCompsToPool(
      csFetched({
        comps: [
          { price: 420, soldDate: "2026-07-08T00:00:00Z" },
          { price: 0, soldDate: "2026-07-09T00:00:00Z" },
          { price: -50, soldDate: "2026-07-10T00:00:00Z" },
          { price: 300, soldDate: "" },
        ],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(1);
  });
});

describe("ingestVendorCompsToPool — idempotency", () => {
  it("re-ingesting the same physical sale upserts to the same row (no duplicates)", async () => {
    // First fetch
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(1);

    // Re-fetch — same cardId + same soldDate + same price → same composite id
    ingestVendorCompsToPool(
      csFetched({ comps: [{ price: 420, soldDate: "2026-07-08T00:00:00Z" }] }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(1);
  });

  it("different sales on same day at different prices get separate rows", async () => {
    ingestVendorCompsToPool(
      csFetched({
        comps: [
          { price: 420, soldDate: "2026-07-08T00:00:00Z" },
          { price: 450, soldDate: "2026-07-08T00:00:00Z" },
        ],
      }),
    );
    await flushMicrotasks();
    expect(store.size).toBe(2);
  });
});
