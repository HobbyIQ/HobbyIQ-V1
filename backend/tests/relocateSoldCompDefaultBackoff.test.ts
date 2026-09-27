import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const R = require_(path.join(LIB, "relocate-sold-comp.cjs"));

/**
 * relocate-sold-comp.cjs's DEFAULT `retry` is now a bounded Cosmos-429
 * backoff (lib/cosmos-backoff.cjs's `withBackoff`) instead of a bare
 * `(fn) => fn()` passthrough -- see relocate-sold-comp.cjs's own header,
 * `defaultRetry`, for the incident this fixes (run 36297136135). This file
 * pins ONLY the default-parameter change itself: every one of the 22 other
 * callers grepped in that header passes its OWN `retry`, so a caller-supplied
 * `retry` (proven never to matter which one, here) must always win.
 */

type Doc = Record<string, any>;

function fakePool(seed: Doc[] = []) {
  const store = new Map<string, Doc>();
  const key = (id: string, pk: string) => `${pk}::${id}`;
  for (const d of seed) store.set(key(d.id, d.cardId), { ...d });
  return {
    store,
    all: () => [...store.values()],
    items: {
      upsert: async (doc: Doc) => {
        store.set(key(doc.id, doc.cardId), { ...doc });
        return { resource: { ...doc } };
      },
    },
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        if (!store.delete(key(id, pk))) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return {};
      },
    }),
  };
}

function throttled() {
  return Object.assign(new Error("The request rate is too large. Please retry after sometime."), { code: 429 });
}

const noGuard = () => ({ verdict: "ok" });

describe("relocateSoldComp's DEFAULT retry -- no retry supplied at all", () => {
  it("retries a 429 on the upsert and still succeeds, with NO retry option passed by the caller", async () => {
    const pool = fakePool();
    let upsertCalls = 0;
    const realUpsert = pool.items.upsert;
    pool.items.upsert = async (doc: Doc) => {
      upsertCalls++;
      if (upsertCalls === 1) throw throttled();
      return realUpsert(doc);
    };
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
    const result = await R.relocateSoldComp(pool, {
      keep, drop: [], verifyFields: [], guard: noGuard,
      // `wait` is injected only to keep this test fast -- `retry` itself is
      // OMITTED, proving the module's own default (not a test-supplied one)
      // is what retries here.
      wait: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(upsertCalls).toBe(2);
  }, 15000);

  it("a 404 on the pre-upsert existedBefore check is NOT retried (it is not a 429) and existedBefore is correctly false", async () => {
    const pool = fakePool();
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
    const result = await R.relocateSoldComp(pool, { keep, drop: [], verifyFields: [], guard: noGuard, wait: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.existedBefore).toBe(false);
  });

  it("exhausts the default's own bounded attempts and rejects (never hangs) when the upsert throttles FOREVER, with no retry supplied", async () => {
    // defaultRetry's own backoff sleeps via the REAL setTimeout (it is a
    // fixed module-scope closure -- relocateSoldComp's own `wait` option
    // controls a DIFFERENT timer, the read-back retry loop's). Fake timers
    // let this test prove exhaustion without paying ~30s of real waits.
    vi.useFakeTimers();
    try {
      const pool = fakePool();
      pool.items.upsert = async () => { throw throttled(); };
      const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
      const pending = R.relocateSoldComp(pool, { keep, drop: [], verifyFields: [], guard: noGuard });
      await vi.runAllTimersAsync();
      const result = await pending;
      // relocateSoldComp's own try/catch around the upsert call site turns
      // the (eventually rethrown, labeled) exhausted error into a normal
      // `{ ok: false, stage: "upsert" }` result -- it does not itself throw.
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("upsert");
      expect(String(result.error)).toMatch(/\[backoff\] relocate-sold-comp exhausted after \d+ attempts/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("relocateSoldComp -- a CALLER-SUPPLIED retry always wins over the default", () => {
  it("a caller's own no-op passthrough means a throttled upsert is NOT retried at all", async () => {
    const pool = fakePool();
    let calls = 0;
    pool.items.upsert = async () => { calls++; throw throttled(); };
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
    const result = await R.relocateSoldComp(pool, {
      keep, drop: [], verifyFields: [], guard: noGuard,
      retry: (fn: () => Promise<any>) => fn(), // the OLD default, explicitly supplied
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1); // never retried -- the caller's own retry is a bare passthrough
  });

  it("a caller's own custom retry (e.g. resolve-disagreeing-sale-twins.cjs's throttleStats-tracking retry) is used instead of the module default", async () => {
    const pool = fakePool();
    let upsertCalls = 0;
    const realUpsert = pool.items.upsert;
    pool.items.upsert = async (doc: Doc) => {
      upsertCalls++;
      if (upsertCalls === 1) throw throttled();
      return realUpsert(doc);
    };
    let customRetryHits = 0;
    const customRetry = async (fn: () => Promise<any>) => {
      try { return await fn(); }
      catch (e: any) {
        if (String(e?.code) !== "429") throw e;
        customRetryHits++;
        return fn();
      }
    };
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
    const result = await R.relocateSoldComp(pool, { keep, drop: [], verifyFields: [], guard: noGuard, retry: customRetry });
    expect(result.ok).toBe(true);
    expect(customRetryHits).toBe(1); // the CALLER's retry logic ran, not the module default's
  });
});

describe("readBackKeptRow's DEFAULT retry -- no retry supplied at all", () => {
  it("retries a 429 on the point-read and still finds the write", async () => {
    const pool = fakePool([{ id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto", hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto" }]);
    let readCalls = 0;
    const realItem = pool.item;
    pool.item = (id: string, pk: string) => {
      const base = realItem(id, pk);
      return {
        ...base,
        read: async () => {
          readCalls++;
          if (readCalls === 1) throw throttled();
          return base.read();
        },
      };
    };
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" };
    // No `retry` argument at all -- readBackKeptRow(pool, keep, retry, wait, verifyFields)
    const doc = await R.readBackKeptRow(pool, keep, undefined, async () => {}, []);
    expect(doc).toBeTruthy();
    expect(doc.id).toBe("s1");
    expect(readCalls).toBeGreaterThanOrEqual(2);
  }, 15000);
});

describe("relocateSoldComp -- the incident's own semantics are unchanged by the new default", () => {
  it("a move is STILL create -> read-back -> delete: the default retry changes ONLY how long a call waits, never the order", async () => {
    const pool = fakePool([{ id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" }]);
    const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:auto" };
    const result = await R.relocateSoldComp(pool, {
      keep, drop: [{ id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" }],
      verifyFields: [], guard: noGuard, wait: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(pool.all()).toHaveLength(1);
    expect(pool.all()[0].cardId).toBe("hiq:baseball:2026:topps:1:base:auto");
  });

  it("if the DELETE's retries exhaust after a successful create+verify, the row is reported as duplicatesLeft -- never silently lost", async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool([{ id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" }]);
      pool.item = ((realItem) => (id: string, pk: string) => {
        const base = realItem(id, pk);
        if (pk === "hiq:baseball:2026:topps:1:base:no-auto") {
          return { ...base, delete: async () => { throw throttled(); } };
        }
        return base;
      })(pool.item);
      const keep = { id: "s1", cardId: "hiq:baseball:2026:topps:1:base:auto" };
      const pending = R.relocateSoldComp(pool, {
        keep, drop: [{ id: "s1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" }],
        verifyFields: [], guard: noGuard,
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.duplicatesLeft).toHaveLength(1);
      // The keeper landed at its NEW address -- a duplicate, never a lost sale.
      expect(pool.all().some((d) => d.cardId === "hiq:baseball:2026:topps:1:base:auto")).toBe(true);
      expect(pool.all().some((d) => d.cardId === "hiq:baseball:2026:topps:1:base:no-auto")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
