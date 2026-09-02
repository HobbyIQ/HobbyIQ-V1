// CF-A-FLAGGED-ROW-IS-NOT-A-DEDUP-PARTNER — the BEHAVIORAL pins.
//
// #1633 closed two of the three ingest dedup paths and pinned them by
// matching the query STRING in the source. That leaves a live mutant: force
// `incomingIsFlagged` to false and every string assertion still passes, while
// a flagged incoming doc is live-filtered away from its own stored twin and
// re-writes the duplicate the $0.99 guard exists to suppress.
//
// These tests drive the REAL recordSoldComp against a fake container that
// actually interprets the predicates, so what is pinned is the OUTCOME —
// rows written, rows deleted, flags intact — not the text of a query.
//
// Two paths are covered:
//
//   1. the partition-scoped contentHash dedup (#1633), including the
//      flagged-incoming asymmetry the string pin could not reach;
//   2. the CROSS-PARTITION user dedup (CF-SOLDCOMPS-CROSS-PARTITION-USER-
//      DEDUP), the third path, which had NO flaggedWrong predicate and
//      HARD DELETES its losers. Post-#1633 the -1000 scorer penalty makes a
//      flagged twin always lose there, so the delete was guaranteed.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "@azure/cosmos";

// The user-scoped sources under test are in soldCompsStore's USER_SEED_SOURCES,
// so they reconcile against the catalog on EVERY write regardless of env. With
// no COSMOS_CONNECTION_STRING the real matcher returns found:false and the
// write is refused `catalog-unmatched` before it ever reaches the dedup under
// test. Mock canonicalize to report the match, exactly as the D12a store tests
// do -- the catalog is not what these tests are about.
const matcher = vi.hoisted(() => ({ canonicalize: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize };
});

import {
  recordSoldComp,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

type Row = Record<string, any>;

/**
 * A fake sold_comps container that INTERPRETS the dedup queries rather than
 * ignoring them. It understands exactly the shapes recordSoldComp issues:
 * the ARRAY_CONTAINS(@h, c.contentHash) partition probe, the cross-partition
 * user probe, the same-id rehome probe, and — critically — the
 * `flaggedWrong != true` predicate, so dropping that predicate in the source
 * changes what these tests observe.
 */
function fakeContainer() {
  const store = new Map<string, Row>();
  const deletes: Array<{ id: string; pk: string }> = [];
  const key = (pk: string, id: string) => `${pk}::${id}`;

  const isFlagged = (d: Row) => d.flaggedWrong === true;

  const container = {
    items: {
      async upsert(doc: Row) {
        store.set(key(doc.cardId, doc.id), doc);
        return { resource: doc };
      },
      query(
        spec: { query: string; parameters?: Array<{ name: string; value: any }> },
        opts?: { partitionKey?: string },
      ) {
        const q = spec.query.replace(/\s+/g, " ");
        const p = new Map<string, any>();
        for (const prm of spec.parameters ?? []) p.set(prm.name, prm.value);
        // The predicate under test, in both its query shapes.
        const excludesFlagged =
          q.includes("NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true");

        return {
          async fetchAll() {
            let rows = Array.from(store.values());

            if (opts?.partitionKey !== undefined) {
              rows = rows.filter((d) => d.cardId === opts.partitionKey);
            }

            if (q.includes("ARRAY_CONTAINS(@h, c.contentHash)")) {
              const hashes: string[] = p.get("@h") ?? [];
              rows = rows.filter((d) => hashes.includes(d.contentHash));
            }

            // Cross-partition user dedup probe.
            if (q.includes("c.hobbyiqCardId = @slug")) {
              rows = rows.filter((d) => d.hobbyiqCardId === p.get("@slug"));
              rows = rows.filter((d) => d.source === p.get("@src"));
              rows = rows.filter((d) => d.contributorUserId === p.get("@u"));
              rows = rows.filter((d) => d.price === p.get("@p"));
              rows = rows.filter((d) => String(d.soldAt ?? "").startsWith(p.get("@day")));
              rows = rows.filter((d) => d.cardId !== p.get("@cardId"));
            }

            // Same-id rehome probe.
            if (q.includes("c.id = @id") && q.includes("c.cardId != @cardId")) {
              rows = rows.filter((d) => d.id === p.get("@id") && d.cardId !== p.get("@cardId"));
            }

            if (excludesFlagged) rows = rows.filter((d) => !isFlagged(d));
            return { resources: rows };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          return { resource: store.get(key(pk, id)) as T | undefined };
        },
        async delete() {
          deletes.push({ id, pk });
          store.delete(key(pk, id));
          return {};
        },
      };
    },
  } as unknown as Container;

  return { container, store, deletes };
}

let fake: ReturnType<typeof fakeContainer>;

const rows = () => Array.from(fake.store.values());

beforeEach(() => {
  fake = fakeContainer();
  _setContainerForTests(fake.container);
  // Report the computed slug back as a confident exact match so the
  // reconcile gate passes and adoptResolvedSlug keeps the computed slug.
  matcher.canonicalize.mockImplementation(async (input: any) => {
    const { deriveHobbyIqSlug } = await import(
      "../src/services/portfolioiq/soldCompsStore.service.js"
    );
    const slug = deriveHobbyIqSlug(input as any).slug;
    return { slug, found: true, confidence: 0.98, matchedBy: "exact", catalogId: slug };
  });
});
afterEach(() => {
  _setContainerForTests(null);
  matcher.canonicalize.mockReset();
});

// A genuine user-scoped sale. The cross-partition probe only runs for
// user-scoped sources with a slug, a contributor and a soldAt.
const userSale = (over: Record<string, any> = {}) => ({
  cardId: "cs-hartshorn-blue",
  playerName: "Eric Hartshorn",
  setName: "2026 Bowman Chrome",
  cardYear: 2026,
  cardNumber: "CPA-EHA",
  parallel: "Blue Refractor",
  price: 608.3,
  soldAt: "2026-08-20T00:00:00Z",
  source: "ebay-user-purchase" as const,
  sourceExternalId: "order-777",
  contributorUserId: "user-drew",
  verifiedByUser: true,
  ...over,
});

describe("cross-partition user dedup: a flagged twin is neither partner nor casualty", () => {
  it("a genuine sale writes, and the flagged twin under another cardId is NOT deleted", async () => {
    // The flagged twin: same slug, same user, same price, same day, but
    // filed under a DIFFERENT cardId — exactly the Hartshorn repro the
    // cross-partition probe was built for. It has already been ruled wrong
    // and carries the provenance the triage lane wrote.
    const first = await recordSoldComp(
      userSale({ cardId: "cs-hartshorn-twin", sourceExternalId: "order-777-twin" }),
    );
    expect(first.written).toBe(true);

    const twinKey = rows().find((d) => d.cardId === "cs-hartshorn-twin");
    expect(twinKey).toBeTruthy();
    twinKey!.flaggedWrong = true;
    twinKey!.dedupSupersededBy = "some-canonical-row-id";
    const slug = twinKey!.hobbyiqCardId;
    expect(slug).toBeTruthy();

    // Now the genuine sale arrives under the other cardId.
    const res = await recordSoldComp(userSale());

    // It must LAND — a row we ruled wrong cannot drop a real sale.
    expect(res.written).toBe(true);
    expect(res.deduped).toBeFalsy();
    expect(rows().some((d) => d.cardId === "cs-hartshorn-blue")).toBe(true);

    // And the flagged twin must SURVIVE with its provenance intact —
    // post-#1633 the -1000 penalty guarantees it loses the arbitration, so
    // without the predicate the delete loop hard-deletes it every time.
    expect(fake.deletes).toHaveLength(0);
    const survivor = rows().find((d) => d.cardId === "cs-hartshorn-twin");
    expect(survivor).toBeTruthy();
    expect(survivor!.flaggedWrong).toBe(true);
    expect(survivor!.dedupSupersededBy).toBe("some-canonical-row-id");
  });

  it("a LIVE cross-partition twin is still deduped — the fix narrows nothing else", async () => {
    // Guards the fix against over-reach: the path must still collapse a
    // genuine cross-partition duplicate. The incoming row here is keyed
    // `holding::`, which scores below the stored real id, so the stored
    // row wins and the incoming write is skipped.
    const first = await recordSoldComp(
      userSale({ cardId: "cs-hartshorn-twin", sourceExternalId: "order-777-twin" }),
    );
    expect(first.written).toBe(true);
    const before = rows().length;

    const res = await recordSoldComp(
      userSale({ sourceExternalId: "holding::abc", verifiedByUser: false }),
    );
    expect(res.deduped).toBe(true);
    expect(rows()).toHaveLength(before);
    expect(rows().some((d) => d.cardId === "cs-hartshorn-blue")).toBe(false);
  });
});

describe("partition dedup: the flagged-incoming asymmetry, pinned behaviorally", () => {
  // This is the mutant #1633's string pin could not kill: force
  // `incomingIsFlagged` false and the source still contains both query
  // strings, but a flagged incoming doc no longer sees its flagged twin.
  const cardsight099 = (over: Record<string, any> = {}) => ({
    cardId: "cs-noise-card",
    playerName: "Noise Player",
    setName: "2026 Bowman Chrome",
    cardYear: 2026,
    parallel: "Refractor",
    price: 0.99,
    soldAt: "2026-08-20T00:00:00Z",
    source: "cardsight" as const,
    ...over,
  });

  it("a flagged $0.99 cardsight row dedups against its flagged twin — pool stays at 1", async () => {
    // The $0.99 ingest guard mints flaggedWrong on BOTH of these.
    const a = await recordSoldComp(cardsight099({ sourceExternalId: "cs-1" }));
    expect(a.written).toBe(true);

    const stored = rows();
    expect(stored).toHaveLength(1);
    // Premise check: the guard really did flag it. If this ever stops being
    // true the asymmetry below is testing nothing.
    expect(stored[0].flaggedWrong).toBe(true);

    // Same sale, second emit path — a different externalId, same contentHash.
    const b = await recordSoldComp(cardsight099({ sourceExternalId: "cs-2" }));

    // THE INVARIANT: the pool still holds ONE row for this sale. The incoming
    // flagged doc found its flagged twin and collapsed onto it — whether it
    // lost the arbitration (`deduped`) or won it (the replace branch: twin
    // deleted, itself written) is an implementation detail, and both leave a
    // single row. What must NOT happen is the twin being invisible: a
    // live-only filter on a flagged incoming doc yields an empty comparison
    // set, and the duplicate the $0.99 guard exists to suppress is
    // resurrected, 1 -> 2. That is the surviving mutant from #1633, whose
    // pin only matched the query string.
    expect(rows()).toHaveLength(1);
    expect(b.written).toBe(true);
    // The one row is still flagged either way — the guard's verdict survives.
    expect(rows()[0].flaggedWrong).toBe(true);
  });

  it("a live incoming sale is not dropped by a flagged same-hash row, and does not delete it", async () => {
    // The (a) failure mode from #1633, pinned on outcome rather than text.
    const a = await recordSoldComp(cardsight099({ sourceExternalId: "cs-1" }));
    expect(a.written).toBe(true);
    expect(rows()[0].flaggedWrong).toBe(true);
    const flaggedId = rows()[0].id;

    // A genuine sale at the same price/day/card — same contentHash.
    const b = await recordSoldComp(
      cardsight099({ source: "cardhedge", sourceExternalId: "ch-daily::991" }),
    );

    expect(b.written).toBe(true);
    expect(b.deduped).toBeFalsy();
    // Both rows present: the real sale landed, the flagged row was not deleted.
    expect(rows()).toHaveLength(2);
    expect(fake.deletes).toHaveLength(0);
    expect(rows().find((d) => d.id === flaggedId)?.flaggedWrong).toBe(true);
  });
});
