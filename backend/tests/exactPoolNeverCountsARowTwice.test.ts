/**
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS, at the READER (#1919, 2026-09-07).
 *
 * A sold_comps row carries TWO identity fields: `cardId` (the partition key)
 * and `hobbyiqCardId` (the canonical slug). readExactPoolRows matches on
 * EITHER:
 *
 *     WHERE (c.cardId = @cid OR c.hobbyiqCardId = @hiq)
 *
 * The #1919 census asks a precise question of that OR, and the answer has two
 * halves that are easy to conflate. This file pins BOTH, because a repair that
 * assumed the wrong half would be aimed at the wrong defect.
 *
 * HALF 1 — WITHIN ONE POOL READ, A ROW IS RETURNED ONCE.
 * `OR` is a predicate over documents, not a join. A document satisfying both
 * disjuncts still satisfies the WHERE clause exactly once, so Cosmos returns
 * it once and the pool holds one copy. There is no self-join and no UNION ALL
 * anywhere in this query, so no in-process dedupe by `id` is required to make
 * one pool correct — and none is possible here regardless, because the
 * projection does not even select `c.id` (asserted below, so a future
 * projection change cannot quietly invalidate the reasoning that follows).
 *
 * HALF 2 — ACROSS TWO POOL READS, THE SAME ROW IS COUNTED IN BOTH.
 * This is the actual damage and it is NOT a dedupe bug. When the two fields
 * name different cards, a read for card A matches the row on `cardId` and a
 * read for card B matches the SAME document on `hobbyiqCardId`. Each pool is
 * internally consistent — one row, counted once — which is exactly why no
 * per-pool audit can see it. One sale prices two cards.
 *
 * WHY NO DEDUPE-BY-ID IS ADDED HERE. The rows are not duplicates within any
 * one answer, so there is nothing for a reader-side dedupe to remove: the two
 * counts happen in two separate queries, for two different cards, in two
 * different requests. Deduping by `id` inside one read would change nothing
 * about the split (it is already one row per read) while adding a projection
 * field and a pass over every pool. The defect is in the STORED ROW — one of
 * its two identity fields is wrong — so the repair belongs in the data
 * (relocate-pool-rows-by-list), not in the reader. This test exists so that
 * conclusion is pinned rather than re-litigated from memory.
 *
 * MUTATION CHECK: change the reader's `OR` to a self-join or a UNION ALL and
 * "one row, one copy" fails; drop the identity union entirely and the
 * cross-pool test fails. Either way this file goes red.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;

/** The captured query text plus the fixture the fake container answers from. */
const captured: { query?: string; params?: Array<{ name: string; value: unknown }> } = {};

/**
 * A fake sold_comps that evaluates the ONE predicate this test is about — the
 * identity union — over a fixture, the way Cosmos does: a document is returned
 * once if it satisfies the WHERE clause, however many disjuncts it matches.
 */
function fakeContainerOver(rows: readonly Row[]) {
  return {
    items: {
      query: (spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) => {
        captured.query = spec.query;
        captured.params = spec.parameters;
        const byName = new Map(spec.parameters.map((p) => [p.name, p.value]));
        const cid = byName.get("@cid");
        // Every @hiq / @hiq1 / @hiq2 … the reader bound for this read.
        const hiqs = spec.parameters.filter((p) => /^@hiq\d*$/.test(p.name)).map((p) => p.value);
        const matched = rows.filter((r) => r.cardId === cid || hiqs.includes(r.hobbyiqCardId));
        return {
          fetchAll: async () => ({
            // Cosmos returns the DOCUMENT, projected. The projection is what
            // the reader asked for; `id` is deliberately not in it.
            resources: matched.map((r) => ({
              price: r.price, soldAt: r.soldAt,
              gradeCompany: r.gradeCompany ?? null, gradeValue: r.gradeValue ?? null,
              source: r.source ?? null, sellerHandle: r.sellerHandle ?? null,
            })),
          }),
        };
      },
    },
  };
}

async function loadReaderOver(rows: readonly Row[]) {
  vi.doMock("@azure/cosmos", () => ({
    CosmosClient: class {
      database() { return { container: () => fakeContainerOver(rows) }; }
    },
  }));
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
  return await import("../src/services/compiq/exactPoolReader.js");
}

/** The #1919 split row: a pokemon slug partitioned under a baseball cardId. */
const A = "hiq:baseball:2023:crown-zenith:gg01:base:no-auto";
const B = "hiq:pokemon:2023:crown-zenith:gg01:base:no-auto";
/**
 * A SAME-PRODUCT pair (the numbered/bare twin). Needed wherever a test has to
 * observe the OR actually matching one document on both sides: the union guard
 * (identityUnionGuard.mayUnionIdentities) drops a caller-supplied second key
 * whose `sport:year:setKey` differs from `cardId`, so A/B above would produce a
 * SINGLE-SIDED query rather than the two-disjunct one under test.
 */
const TWIN_BARE = "hiq:pokemon:2023:crown-zenith:gg01:base:no-auto";
const TWIN_NUMBERED = "hiq:pokemon:2023:crown-zenith:gg01:base:no-auto:num-499";
const SPLIT_ROW: Row = {
  id: "tca-ebay::999000111",
  cardId: A,
  hobbyiqCardId: B,
  price: 120,
  soldAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  source: "tca-ebay",
};

beforeEach(() => { captured.query = undefined; captured.params = undefined; vi.resetModules(); });

describe("#1919 — one row is never counted twice WITHIN a single pool read", () => {
  it("a row matching BOTH disjuncts is returned exactly once", async () => {
    // The twin pair — the SAME product, so the union guard admits both halves
    // and the OR genuinely matches this one document on both sides at once.
    // (A cross-sport pair cannot be used here: the guard drops the second
    // disjunct entirely, which the cross-pool describe block below pins.)
    const twinRow: Row = { ...SPLIT_ROW, cardId: TWIN_BARE, hobbyiqCardId: TWIN_NUMBERED };
    const { readExactPoolRows } = await loadReaderOver([twinRow]);
    const rows = await readExactPoolRows({
      cardId: TWIN_BARE, hobbyiqCardId: TWIN_NUMBERED, windowDays: 90,
    });
    expect(rows).not.toBeNull();
    // Both disjuncts hit the SAME document. Cosmos returns it once; a
    // self-join or a UNION ALL would return it twice.
    expect(rows!.length).toBe(1);
    expect(rows![0]!.price).toBe(120);
  });

  it("the query is a single predicate over documents — no self-join, no UNION ALL", async () => {
    const { readExactPoolRows } = await loadReaderOver([SPLIT_ROW]);
    // A same-product union, so the guard admits both halves and the OR is real.
    await readExactPoolRows({
      cardId: "hiq:pokemon:2023:crown-zenith:gg01:base:no-auto",
      hobbyiqCardId: "hiq:pokemon:2023:crown-zenith:gg01:refractor:no-auto",
      windowDays: 90,
    });
    const q = String(captured.query ?? "");
    expect(q).toContain("c.cardId = @cid");
    expect(q).toContain("c.hobbyiqCardId = @hiq");
    // A self-join or a UNION ALL is what WOULD duplicate a row that matches
    // both sides. Neither may appear in the one read behind every pool rung.
    expect(q.toUpperCase()).not.toContain("UNION");
    expect(q.toUpperCase()).not.toContain("JOIN");
    // Exactly one FROM clause: two would mean two row sources feeding one
    // answer. Matched on a word boundary — "excludedFromFmv" contains "From".
    expect(q.match(/\bFROM\b/gi) ?? []).toHaveLength(1);
  });

  it("the projection does not select id — so no reader-side dedupe by id exists", async () => {
    // This is an ASSERTION OF FACT that the census reasoning rests on, not a
    // preference: a dedupe by id is impossible on rows that carry no id. If a
    // future change adds `c.id` to the projection intending to dedupe, this
    // test fails and forces the reasoning above to be revisited.
    const { readExactPoolRows } = await loadReaderOver([SPLIT_ROW]);
    await readExactPoolRows({ cardId: A, hobbyiqCardId: null, windowDays: 90 });
    expect(String(captured.query ?? "")).not.toContain("c.id");
  });

  it("duplicate union keys are collapsed before they reach the query", async () => {
    // The reader de-dupes the KEYS it binds. Passing the same slug twice must
    // not bind it twice, or a fixture row would match one disjunct per copy.
    const twinRow: Row = { ...SPLIT_ROW, cardId: TWIN_BARE, hobbyiqCardId: TWIN_NUMBERED };
    const { readExactPoolRows } = await loadReaderOver([twinRow]);
    const rows = await readExactPoolRows({
      cardId: TWIN_BARE, hobbyiqCardId: TWIN_NUMBERED,
      hobbyiqCardIds: [TWIN_NUMBERED, TWIN_NUMBERED, TWIN_NUMBERED], windowDays: 90,
    });
    expect(rows!.length).toBe(1);
    const hiqParams = (captured.params ?? []).filter((p) => /^@hiq\d*$/.test(p.name));
    expect(hiqParams.length).toBe(1);
  });
});

describe("#1919 — the guard makes a CROSS-SPORT caller union single-sided", () => {
  it("a caller naming both halves of a split gets one disjunct, not two", async () => {
    // Measured while writing this file: mayUnionIdentities compares
    // `sport:year:setKey`, so baseball:2023:crown-zenith != pokemon:2023:
    // crown-zenith and the hobbyiqCardId disjunct is REFUSED at the reader.
    // The query goes out single-sided on cardId alone.
    const { readExactPoolRows } = await loadReaderOver([SPLIT_ROW]);
    await readExactPoolRows({ cardId: A, hobbyiqCardId: B, windowDays: 90 });
    const q = String(captured.query ?? "");
    expect(q).toContain("c.cardId = @cid");
    expect(q).not.toContain("c.hobbyiqCardId = @hiq");
    // This is why the split cannot be repaired at the read: the guard already
    // refuses the union it can SEE, and the damage below happens in two
    // SEPARATE reads where no guard has both halves in front of it.
  });
});

describe("#1919 — the damage is ACROSS pools: one sale prices two cards", () => {
  it("the same document is read into the baseball pool AND the pokemon pool", async () => {
    // Pool A: asked for by the partition key. Matches on cardId.
    const readerA = await loadReaderOver([SPLIT_ROW]);
    const poolA = await readerA.readExactPoolRows({ cardId: A, hobbyiqCardId: A, windowDays: 90 });
    vi.resetModules();
    // Pool B: asked for by the canonical slug. Matches the SAME row on
    // hobbyiqCardId. Different card, different sport, same single sale.
    const readerB = await loadReaderOver([SPLIT_ROW]);
    const poolB = await readerB.readExactPoolRows({ cardId: B, hobbyiqCardId: B, windowDays: 90 });

    expect(poolA!.length).toBe(1);
    expect(poolB!.length).toBe(1);
    // Each pool is internally consistent — one row, counted once — which is
    // exactly why no per-pool audit can see this. The sale is nonetheless in
    // two pools, and one of them is the wrong sport.
    expect(poolA![0]!.price).toBe(120);
    expect(poolB![0]!.price).toBe(120);
  });

  it("a COHERENT row reaches only its own pool", async () => {
    // The control: fix the stored row so both fields agree, and the baseball
    // pool no longer sees it. This is what the data repair achieves, and it is
    // why the repair belongs in the row rather than in the reader.
    const healed: Row = { ...SPLIT_ROW, cardId: B };
    const readerA = await loadReaderOver([healed]);
    const poolA = await readerA.readExactPoolRows({ cardId: A, hobbyiqCardId: A, windowDays: 90 });
    vi.resetModules();
    const readerB = await loadReaderOver([healed]);
    const poolB = await readerB.readExactPoolRows({ cardId: B, hobbyiqCardId: B, windowDays: 90 });

    expect(poolA!.length).toBe(0);
    expect(poolB!.length).toBe(1);
  });
});
