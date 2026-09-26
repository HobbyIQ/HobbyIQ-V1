/**
 * scripts/lib/sales-at-id.cjs -- the dual cross-partition + partition-scoped
 * sales check every retire gate on this runner shares.
 *
 * CF-A-CROSS-PARTITION-QUERY-IS-NOT-THE-WHOLE-POOL (2026-09-26). A real
 * sold_comps document (id ebay-user-purchase::147344007201-10082410797719,
 * cardId === hobbyiqCardId === hiq:baseball:2026:bowman:cpa-vf:black-white-
 * red-ink:auto) was found, reproducibly, by a point read and by a
 * partition-scoped query (FeedOptions.partitionKey = that identity), while a
 * bare cross-partition `WHERE c.hobbyiqCardId = @id` returned ZERO rows for
 * the identical id. A 320-doc sample measured the miss rate at 0.6%, every
 * miss carrying a null hobbyiqCardId.
 *
 * This pins the fix directly against a fake container: a retire may be
 * licensed only when BOTH forms -- the cross-partition query with no
 * partitionKey, and the same predicate scoped with `partitionKey: id` --
 * return zero. The mutation check (last describe) proves the pin actually
 * exercises the partition-scoped form: with it dropped, a doc visible only
 * there is missed and the helper would wrongly license the retire.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type QuerySpec = { query: string; parameters?: Array<{ name: string; value: unknown }> };
type FeedOptions = { maxItemCount?: number; maxDegreeOfParallelism?: number; partitionKey?: unknown };
type Row = { id: string; cardId?: string; hobbyiqCardId?: string };

type Lib = {
  salesAtId: (
    container: { items: { query: (spec: QuerySpec, feedOptions?: FeedOptions) => unknown } },
    id: string,
    opts?: { retry?: (fn: () => unknown) => unknown },
  ) => Promise<{ xp: number; pk: number; total: number; ids: string[] }>;
};
const lib = require_(path.join(backend, "scripts", "lib", "sales-at-id.cjs")) as Lib;

const ANOMALY_ID = "hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto";

/**
 * A fake Cosmos container whose two "visibility" sets are independently
 * controlled -- `crossPartitionVisible` answers the query issued with no
 * partitionKey, `partitionScopedVisible` answers the one issued with
 * `partitionKey` set. A real container would have ONE set of rows; this
 * fake can diverge them on purpose, which is exactly what reproduces the
 * measured anomaly (a row invisible to the cross-partition form only).
 *
 * Paginates in pages of `pageSize`, including one EMPTY page in the middle
 * when there are at least 3 rows to page through, so the drain loop is
 * exercised against exactly the failure mode the doctrine warns about:
 * stopping on an empty page rather than on `hasMoreResults()` going false.
 */
function fakeContainer(opts: {
  crossPartitionVisible: Row[];
  partitionScopedVisible: Row[];
  pageSize?: number;
}) {
  const pageSize = opts.pageSize ?? 500;
  const query = (spec: QuerySpec, feedOptions?: FeedOptions) => {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const target = p["@id"];
    const source = feedOptions && feedOptions.partitionKey !== undefined
      ? opts.partitionScopedVisible
      : opts.crossPartitionVisible;
    const rows = source
      .filter((r) => r.hobbyiqCardId === target || r.cardId === target)
      .map((r) => ({ id: r.id }));

    // Build pages, with a deliberate empty page inserted after the first
    // real page when there is more than one page's worth of rows.
    const pages: Row[][] = [];
    for (let i = 0; i < rows.length; i += pageSize) pages.push(rows.slice(i, i + pageSize) as Row[]);
    if (pages.length > 1) pages.splice(1, 0, []); // empty page in the middle
    if (pages.length === 0) pages.push([]);

    let cursor = 0;
    return {
      hasMoreResults: () => cursor < pages.length,
      fetchNext: async () => {
        const page = pages[cursor] ?? [];
        cursor++;
        return { resources: page };
      },
      fetchAll: async () => ({ resources: rows }),
    };
  };
  return { items: { query } };
}

describe("salesAtId -- the dual check", () => {
  it("(iii) visible to NEITHER form -> licensed (total 0)", async () => {
    const container = fakeContainer({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const res = await lib.salesAtId(container, ANOMALY_ID);
    expect(res.xp).toBe(0);
    expect(res.pk).toBe(0);
    expect(res.total).toBe(0);
  });

  it("(i) visible ONLY to the partition-scoped form -> retire refused (total > 0)", async () => {
    // This is the reproduced anomaly: a real document the cross-partition
    // query misses entirely, but the partition-scoped query (a sale whose
    // cardId equals the identity lives in that partition) finds.
    const row: Row = { id: "ebay-user-purchase::147344007201-10082410797719", cardId: ANOMALY_ID, hobbyiqCardId: ANOMALY_ID };
    const container = fakeContainer({ crossPartitionVisible: [], partitionScopedVisible: [row] });
    const res = await lib.salesAtId(container, ANOMALY_ID);
    expect(res.xp).toBe(0);
    expect(res.pk).toBe(1);
    expect(res.total).toBe(1); // union is non-zero -> a caller must refuse the retire
  });

  it("(ii) visible ONLY cross-partition -> retire refused (total > 0)", async () => {
    // The mirror case: a sale re-pointed (hobbyiqCardId rewritten) but never
    // re-partitioned, so the partition-scoped query at the NEW id misses it
    // while the cross-partition query still finds it.
    const row: Row = { id: "sale-repointed-1", cardId: "some-other-partition", hobbyiqCardId: ANOMALY_ID };
    const container = fakeContainer({ crossPartitionVisible: [row], partitionScopedVisible: [] });
    const res = await lib.salesAtId(container, ANOMALY_ID);
    expect(res.xp).toBe(1);
    expect(res.pk).toBe(0);
    expect(res.total).toBe(1);
  });

  it("(iv) pagination drains an empty middle page", async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `sale-${i}`, cardId: ANOMALY_ID, hobbyiqCardId: ANOMALY_ID,
    }));
    const container = fakeContainer({ crossPartitionVisible: rows, partitionScopedVisible: rows, pageSize: 1 });
    const res = await lib.salesAtId(container, ANOMALY_ID);
    // 3 rows over pageSize 1 means 3 real pages plus one empty page spliced
    // in after the first -- if the drain stopped on the empty page instead
    // of on hasMoreResults() going false, this would come back short.
    expect(res.xp).toBe(3);
    expect(res.pk).toBe(3);
    expect(res.total).toBe(3);
  });

  it("returns the union of distinct ids across both forms", async () => {
    const shared: Row = { id: "shared-1", cardId: ANOMALY_ID, hobbyiqCardId: ANOMALY_ID };
    const xpOnly: Row = { id: "xp-only-1", cardId: "elsewhere", hobbyiqCardId: ANOMALY_ID };
    const pkOnly: Row = { id: "pk-only-1", cardId: ANOMALY_ID, hobbyiqCardId: null as unknown as string };
    const container = fakeContainer({
      crossPartitionVisible: [shared, xpOnly],
      partitionScopedVisible: [shared, pkOnly],
    });
    const res = await lib.salesAtId(container, ANOMALY_ID);
    expect(res.xp).toBe(2);
    expect(res.pk).toBe(2);
    expect(res.total).toBe(3); // shared counted once
    expect(new Set(res.ids)).toEqual(new Set(["shared-1", "xp-only-1", "pk-only-1"]));
  });
});

describe("salesAtId -- mutation check", () => {
  it("MUTATION: dropping the partition-scoped form fails test (i)", async () => {
    // A stand-in for "the fix reverted to a single cross-partition query" --
    // reruns case (i)'s exact fixture through a helper that only issues the
    // cross-partition form, and asserts the pin above would then fail.
    const salesAtIdCrossPartitionOnly = async (
      container: { items: { query: (spec: QuerySpec, feedOptions?: FeedOptions) => { hasMoreResults(): boolean; fetchNext(): Promise<{ resources: Row[] }> } } },
      id: string,
    ) => {
      const iter = container.items.query(
        { query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @id OR c.cardId = @id", parameters: [{ name: "@id", value: id }] },
      );
      let n = 0;
      while (iter.hasMoreResults()) {
        const { resources } = await iter.fetchNext();
        n += resources.length;
      }
      return n;
    };
    const row: Row = { id: "ebay-user-purchase::147344007201-10082410797719", cardId: ANOMALY_ID, hobbyiqCardId: ANOMALY_ID };
    const container = fakeContainer({ crossPartitionVisible: [], partitionScopedVisible: [row] });
    const regressedCount = await salesAtIdCrossPartitionOnly(container, ANOMALY_ID);
    // The regressed, single-query helper says 0 -- which is exactly the false
    // "safe to retire" the dual check exists to refuse. Prove the real
    // helper disagrees with it, i.e. the partition-scoped form is doing
    // real work.
    expect(regressedCount).toBe(0);
    const res = await lib.salesAtId(container, ANOMALY_ID);
    expect(res.total).toBe(1);
    expect(res.total).not.toBe(regressedCount);
  });
});

describe("salesAtId -- a query failure is never swallowed", () => {
  // CF-A-RETIRE-NEEDS-ZERO-SALES-BY-BOTH-FORMS (review finding, 2026-09-26).
  // The original helper never had a try/catch of its own, but the callers
  // wrapping it (relocate-catalog-rows-by-list.cjs's old `salesAt`) turned a
  // throw into `null` -- "unknown", logged and forgotten, then treated as a
  // green light to delete. This pins that salesAtId itself never hides a
  // throw, from either form, at either stage (the query call itself or a
  // later fetchNext), so every caller is forced to make its own decision
  // rather than inheriting a swallow.
  function throwingContainer(failOn: "cross-partition" | "partition-scoped" | "query-call") {
    return {
      items: {
        query: (_spec: QuerySpec, feedOptions?: FeedOptions) => {
          const scoped = Boolean(feedOptions && feedOptions.partitionKey !== undefined);
          if (failOn === "query-call") throw new Error("probe: items.query itself threw");
          const shouldFailHere = (failOn === "partition-scoped" && scoped) || (failOn === "cross-partition" && !scoped);
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => {
              done = true;
              if (shouldFailHere) throw new Error(`probe: ${failOn} fetchNext threw`);
              return { resources: [] };
            },
          };
        },
      },
    };
  }

  it("propagates a throw from the cross-partition form's fetchNext", async () => {
    await expect(lib.salesAtId(throwingContainer("cross-partition"), ANOMALY_ID))
      .rejects.toThrow(/cross-partition fetchNext threw/);
  });

  it("propagates a throw from the partition-scoped form's fetchNext", async () => {
    await expect(lib.salesAtId(throwingContainer("partition-scoped"), ANOMALY_ID))
      .rejects.toThrow(/partition-scoped fetchNext threw/);
  });

  it("propagates a throw from items.query itself, before any page is fetched", async () => {
    await expect(lib.salesAtId(throwingContainer("query-call"), ANOMALY_ID))
      .rejects.toThrow(/items\.query itself threw/);
  });

  it("propagates a throw raised inside the caller's own `retry` wrapper", async () => {
    const container = fakeContainer({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const retry = () => { throw new Error("probe: retry wrapper threw"); };
    await expect(lib.salesAtId(container, ANOMALY_ID, { retry }))
      .rejects.toThrow(/retry wrapper threw/);
  });
});
