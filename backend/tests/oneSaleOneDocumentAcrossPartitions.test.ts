// CF-ONE-SALE-ONE-DOCUMENT — the same sale id must never be resident in two
// partitions.
//
// THE DEFECT. `makeId` returns `${source}::${externalId}` whenever the source
// provides an external id, and for a VENDOR source it always does. That id does
// NOT contain `cardId`. sold_comps is partitioned on /cardId, so when the
// parser learns a better setKey and the same vendor listing is re-ingested, the
// SAME id is written under a NEW partition key: `items.upsert` CREATES rather
// than replaces, and the sale is now two documents in two pools.
//
// Why nothing else catches it:
//
//   - the partition-scoped contentHash probe hashes `cardId`, so the two
//     copies cannot collide by construction;
//   - the cross-partition probe keys on `hobbyiqCardId`, which is exactly the
//     field that just changed, and was gated to user-scoped sources anyway;
//   - exactPoolReader's `OR` is a predicate over DOCUMENTS. A split ROW
//     satisfies it once (pinned in exactPoolNeverCountsARowTwice.test.ts) --
//     but two DOCUMENTS are two rows, one returned by each pool's read, and no
//     reader ever holds both;
//   - `dedupeSoldComps` clusters within ONE array; the copies are never in the
//     same array.
//
// So every per-pool audit reconciles while the sale prices two cards. The
// guard has to be at the write door, and these tests pin it there.
//
// The remedy differs by source and that difference is pinned too: a user
// transaction is one row by definition and its stale copy is DELETED (D9), a
// vendor sale is a real observation and its older copy is FLAGGED --
// CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE, the pool is sacred.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "@azure/cosmos";

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
 * A fake sold_comps container that INTERPRETS the probes recordSoldComp
 * issues, and -- unlike the #1633 fake -- also implements `patch`, because the
 * vendor remedy under test is a patch rather than a delete.
 *
 * Crucially `upsert` is keyed on (cardId, id) exactly as Cosmos keys a
 * partitioned container: the same id under a different cardId CREATES a second
 * document. That is the whole defect, so the fake has to reproduce it or the
 * tests would pass against a store that cannot exhibit the bug.
 */
function fakeContainer() {
  const store = new Map<string, Row>();
  const deletes: Array<{ id: string; pk: string }> = [];
  const patches: Array<{ id: string; pk: string; ops: Row[] }> = [];
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
        const excludesFlagged =
          q.includes("NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true");

        return {
          async fetchAll() {
            let rows = Array.from(store.values());
            if (opts?.partitionKey !== undefined) rows = rows.filter((d) => d.cardId === opts.partitionKey);
            if (q.includes("ARRAY_CONTAINS(@h, c.contentHash)")) {
              const hashes: string[] = p.get("@h") ?? [];
              rows = rows.filter((d) => hashes.includes(d.contentHash));
            }
            if (q.includes("c.hobbyiqCardId = @slug")) {
              rows = rows.filter((d) => d.hobbyiqCardId === p.get("@slug"));
              rows = rows.filter((d) => d.source === p.get("@src"));
              rows = rows.filter((d) => d.contributorUserId === p.get("@u"));
              rows = rows.filter((d) => d.price === p.get("@p"));
              rows = rows.filter((d) => String(d.soldAt ?? "").startsWith(p.get("@day")));
              rows = rows.filter((d) => d.cardId !== p.get("@cardId"));
            }
            // The same-id rehome probe — the one this file is about.
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
        async read<T>() { return { resource: store.get(key(pk, id)) as T | undefined }; },
        async delete() {
          deletes.push({ id, pk });
          store.delete(key(pk, id));
          return {};
        },
        async patch(ops: Row[]) {
          const doc = store.get(key(pk, id));
          if (!doc) { const e: any = new Error("not found"); e.code = 404; throw e; }
          patches.push({ id, pk, ops });
          for (const op of ops) {
            if (op.op === "set") doc[String(op.path).replace(/^\//, "")] = op.value;
          }
          store.set(key(pk, id), doc);
          return { resource: doc };
        },
      };
    },
  } as unknown as Container;

  return { container, store, deletes, patches };
}

let fake: ReturnType<typeof fakeContainer>;
const rows = () => Array.from(fake.store.values());

beforeEach(() => {
  fake = fakeContainer();
  _setContainerForTests(fake.container);
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

/**
 * The measured signature, from the 2026-09-07 duplicate-sale-ids census: one
 * tca-ebay listing ingested on 08-06 under an `unknown` setKey, then again on
 * 08-10 after the parser learned `bowman`. Same externalId, so the SAME id --
 * a second document, not a replacement.
 */
const vendorSale = (over: Record<string, any> = {}) => ({
  cardId: "hiq:hockey:2024:unknown:97:base:no-auto",
  playerName: "Connor Bedard",
  setName: "2024 Unknown",
  cardYear: 2024,
  cardNumber: "97",
  parallel: null,
  price: 42.5,
  soldAt: "2026-08-05T00:00:00Z",
  source: "tca-ebay" as const,
  sourceExternalId: "267679692186",
  ...over,
});

describe("one sale, one document: a re-ingest under a new setKey does not leave two", () => {
  it("the same vendor id under a second partition leaves ONE live row, and the older copy is FLAGGED not deleted", async () => {
    // 08-06: the parser does not know the set yet.
    await recordSoldComp(vendorSale());
    expect(rows()).toHaveLength(1);
    const firstId = rows()[0].id;

    // 08-10: the parser learned `bowman`. Same listing, same externalId, so
    // makeId mints the SAME id -- under a different partition key.
    await recordSoldComp(vendorSale({
      cardId: "hiq:hockey:2024:bowman:97:base:no-auto",
      setName: "2024 Bowman",
    }));

    // Both documents still EXIST -- a sale is never deleted -- but exactly one
    // is live. Without the guard both would be live and the sale would price
    // two cards.
    const all = rows().filter((r) => r.id === firstId);
    expect(all).toHaveLength(2);
    const live = all.filter((r) => r.flaggedWrong !== true);
    expect(live).toHaveLength(1);
    expect(live[0].cardId).toBe("hiq:hockey:2024:bowman:97:base:no-auto");

    // The older copy is MARKED, never removed, and carries its provenance.
    const older = all.find((r) => r.cardId === "hiq:hockey:2024:unknown:97:base:no-auto");
    expect(older?.flaggedWrong).toBe(true);
    expect(older?.flaggedReason).toBe("duplicate-partition-copy");
    expect(older?.dedupSupersededBy).toBe("hiq:hockey:2024:bowman:97:base:no-auto");
    expect(fake.deletes).toHaveLength(0);
  });

  it("a VENDOR copy is never hard-deleted — the pool is sacred", async () => {
    await recordSoldComp(vendorSale());
    await recordSoldComp(vendorSale({ cardId: "hiq:hockey:2024:bowman:97:base:no-auto" }));
    expect(fake.deletes).toHaveLength(0);
    expect(fake.patches.length).toBeGreaterThan(0);
    expect(fake.patches[0].ops.some((o) => o.path === "/flaggedWrong" && o.value === true)).toBe(true);
  });

  it("a USER transaction keeps the D9 delete — the id IS the order, so a copy is a stale filing", async () => {
    const userSale = (over: Record<string, any> = {}) => ({
      cardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:blue-refractor:auto",
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

    await recordSoldComp(userSale());
    await recordSoldComp(userSale({
      cardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:blue-refractor:auto:num-150",
    }));

    // One document, because the stale filing was deleted -- D9's behaviour,
    // unchanged by widening the DETECTION to every externalId-keyed source.
    expect(rows()).toHaveLength(1);
    expect(fake.deletes.length).toBeGreaterThan(0);
  });

  it("a re-ingest at the SAME address is a replacement, not a duplicate", async () => {
    await recordSoldComp(vendorSale());
    await recordSoldComp(vendorSale({ price: 44 }));
    // Same id, same partition: upsert replaces. Nothing is flagged, because
    // there is no second address for the guard to find.
    expect(rows()).toHaveLength(1);
    expect(fake.patches).toHaveLength(0);
    expect(fake.deletes).toHaveLength(0);
  });

  it("the guard is keyed on the EXTERNAL ID, not on the source being user-scoped", async () => {
    // The regression this fixes: the probe used to be gated `isUserScoped &&
    // ...`, so tca-ebay -- 225 of the 255 duplicate ids in the census pilot --
    // never ran it. A vendor source with an externalId must reach the probe.
    await recordSoldComp(vendorSale({ source: "cardsight" as const, sourceExternalId: "cs-991" }));
    await recordSoldComp(vendorSale({
      source: "cardsight" as const,
      sourceExternalId: "cs-991",
      cardId: "hiq:hockey:2024:bowman:97:base:no-auto",
    }));
    const live = rows().filter((r) => r.flaggedWrong !== true);
    expect(live).toHaveLength(1);
  });
});
