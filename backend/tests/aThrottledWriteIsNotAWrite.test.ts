/**
 * CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (#2015 follow-up, 2026-09-09).
 *
 * THE DEFECT. `recordSoldComp` wraps its Cosmos upsert in a try/catch. The
 * catch incremented the emit-failure counter, logged `sold_comps_upsert_error`
 * -- and then FELL THROUGH to the function's closing
 *
 *     return { written: true, deduped: false, id: doc.id, ... };
 *
 * So a Cosmos 429, a schema drift, a missing container, a dropped connection
 * -- every reason the one write path can fail -- was reported to the caller as
 * a sale that landed in the pool. The result type has declared
 * `{ written: false, reason: "error" }` since the loop-back fix; the catch
 * simply never used it.
 *
 * WHY IT MATTERS MORE THAN A WRONG COUNTER. `written` is not decoration; it is
 * the value the callers BRANCH on:
 *
 *   - `ebayOrderPoll` advances its cursor unless `writeFailed` is set, so an
 *     order whose sale was throttled was never looked at again
 *   - `promotionJob` stamps the staging row `promoted` -- terminal -- and the
 *     audit record then claims a promotion that did not happen
 *   - `emit-staging-to-pool` flips the staging row to `in-pool`
 *   - every ingest ledger reconciles `fetched = written + skipped + errors`
 *     and balanced perfectly on sales that are not in `sold_comps`
 *
 * A throttle is the most likely failure here AND the most retryable one.
 * Reporting it as success is precisely how a retryable loss becomes permanent.
 *
 * WHAT THESE TESTS PIN.
 *   1. the catch returns `written: false, reason: "error"` (behavioural, via
 *      an upsert that throws)
 *   2. the emit-failure counter still moves, and the caller-side ledger delta
 *      from #2015 counts the row ONCE -- not once for `written: false` and
 *      again for the counter delta
 *   3. the callers that COUNT `written` bucket a `reason: "error"` result as
 *      failed, never as skipped or deduped
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize };
});

import {
  recordSoldComp,
  getEmitFailureCount,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(here, "..", "src", "services", "portfolioiq", "soldCompsStore.service.ts");

/** A 429 as Cosmos raises it: the retryable one, and the one this fix is for. */
function throttle(): Error & { code: number } {
  const e = new Error("Request rate is large") as Error & { code: number };
  e.code = 429;
  return e;
}

/** The d12a fake, with an upsert that can be told to throw. Queries are
 *  interpreted from their `c.field = @param` predicates. */
function fakeContainer(opts: { upsertThrows?: boolean } = {}) {
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
      async upsert(doc: Record<string, unknown>) {
        if (opts.upsertThrows) throw throttle();
        store.set(key(String(doc.id), String(doc.cardId)), doc);
        return { resource: doc };
      },
      async create(doc: Record<string, unknown>) {
        if (opts.upsertThrows) throw throttle();
        store.set(key(String(doc.id), String(doc.cardId)), doc);
        return { resource: doc };
      },
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

const POOL_SLUG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";
const sale = {
  cardId: POOL_SLUG,
  playerName: "Theo Gillen",
  cardYear: 2024,
  setName: "Bowman Chrome",
  cardNumber: "CPA-TG",
  parallel: "Blue Refractor",
  isAuto: true,
  sport: "baseball",
  price: 729,
  soldAt: "2026-08-20T00:00:00.000Z",
  source: "ebay-user-sale" as const,
  contributorUserId: "user-1",
  verifiedByUser: true,
  confidence: 1.0,
};

beforeEach(() => {
  matcher.canonicalize.mockReset();
  matcher.canonicalize.mockResolvedValue({ slug: POOL_SLUG, found: true, confidence: 0.98, matchedBy: "exact" });
  delete process.env.CATALOG_MATCH_ONLY_ENABLED;
});
afterEach(() => { _setContainerForTests(null); });

describe("the catch path reports the write it did not do", () => {
  it("a throttled upsert returns written:false with reason 'error' — NOT written:true", async () => {
    const fake = fakeContainer({ upsertThrows: true });
    _setContainerForTests(fake.container);

    const res = await recordSoldComp({ ...sale, sourceExternalId: "throttled-1" });

    // THE MUTATION CHECK. Revert the catch to fall through to
    // `return { written: true, ... }` and both of these go red.
    expect(res.written).toBe(false);
    expect(res.reason).toBe("error");
    // And the sale really is not in the pool — which is the whole point.
    expect(fake.store.size).toBe(0);
  });

  it("does not claim an id or a deduped verdict for a row that was never written", async () => {
    const fake = fakeContainer({ upsertThrows: true });
    _setContainerForTests(fake.container);
    const res = await recordSoldComp({ ...sale, sourceExternalId: "throttled-2" });
    expect(res.written).toBe(false);
    // A caller linking a holding to `res.id` would otherwise pin it to a
    // document that does not exist.
    expect(res.id ?? null).toBeNull();
    expect(res.deduped ?? false).toBe(false);
  });

  it("a successful upsert is still written:true — the fix does not fail closed on healthy writes", async () => {
    const fake = fakeContainer();
    _setContainerForTests(fake.container);
    const res = await recordSoldComp({ ...sale, sourceExternalId: "healthy-1" });
    expect(res.written).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(fake.store.size).toBe(1);
  });
});

describe("the emit-failure counter and the return value are ONE row, counted ONCE", () => {
  it("keeps incrementing getEmitFailureCount() on a throttle", async () => {
    const fake = fakeContainer({ upsertThrows: true });
    _setContainerForTests(fake.container);
    const before = getEmitFailureCount();
    await recordSoldComp({ ...sale, sourceExternalId: "counter-1" });
    expect(getEmitFailureCount()).toBe(before + 1);
  });

  it("NO DOUBLE COUNT: one failed write moves the counter by exactly one and returns exactly one written:false", async () => {
    // #2015's caller-side ledger delta reads getEmitFailureCount() around a
    // batch. Now that the return value ALSO reports the failure, a caller that
    // added both terms would count one lost sale twice. The invariant the
    // callers rely on: emit-failure delta === number of written:false/"error"
    // results, so a caller counts ONE of the two, never their sum.
    const fake = fakeContainer({ upsertThrows: true });
    _setContainerForTests(fake.container);
    const before = getEmitFailureCount();

    const results = [];
    for (const ext of ["dbl-1", "dbl-2", "dbl-3"]) {
      results.push(await recordSoldComp({ ...sale, sourceExternalId: ext }));
    }

    const delta = getEmitFailureCount() - before;
    const refused = results.filter((r) => r.written === false && r.reason === "error").length;
    expect(refused).toBe(3);
    expect(delta).toBe(3);
    // The two are the SAME three rows. A caller adding them would report 6.
    expect(delta).toBe(refused);
  });
});

describe("the store's source states the rule", () => {
  it("the catch returns rather than falling through to the success return", () => {
    const src = readFileSync(STORE, "utf8");
    // The catch block's tail must RETURN. Pinned textually as well as
    // behaviourally because the defect was a missing statement, and a missing
    // statement is exactly what a text pin catches on re-introduction.
    expect(src).toMatch(
      /event: "sold_comps_upsert_error"[\s\S]{0,3000}?return \{ written: false, reason: "error" \};/,
    );
  });

  it("still logs sold_comps_upsert_error and still increments the counter", () => {
    const src = readFileSync(STORE, "utf8");
    expect(src).toContain('event: "sold_comps_upsert_error"');
    expect(src).toContain("_emitFailureCounter++;");
    expect(src).toContain("export function getEmitFailureCount()");
  });
});
