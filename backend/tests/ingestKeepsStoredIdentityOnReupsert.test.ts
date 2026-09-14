// CF-INGEST-KEEPS-STORED-IDENTITY (2026-09-14).
//
// THE FINDING (measured 2026-09-14, see the memory note "ingest re-upserts
// re-derive identity"). The nightly CardHedge daily ingest (`ch-daily` rows,
// ids like `cardhedge::ch-daily::<id>`) and the TCA eBay pull re-upsert
// EXISTING sales and recompute `cardId`/`hobbyiqCardId` with whatever deriver
// is deployed. When the deriver regresses (pre-batch-2 dropped the stated
// "Bush/Mantle" variation to Base), the re-upsert silently re-addressed the
// sale into a different pool: 232 rows of
// `hiq:baseball:2007:topps:40:bushmantle:no-auto` migrated to
// `...:40:base:no-auto` between 2026-09-03 and 09-13, with no ruling, no
// ledger, no `movedBy`.
//
// THE MECHANISM, measured against this codebase. For a CardHedge daily row,
// `doc.cardId` (the Cosmos partition key) is CardHedge's own STABLE
// `card_id` -- see chRowToSoldComp.ts and bulk-import-ch-daily-to-sold-
// comps.cjs, both of which pass `cardId: row.card_id` verbatim. A re-upsert
// of the same CH sale therefore ALWAYS lands at the exact same (id, cardId)
// address: this is a plain Cosmos REPLACE, never a new partition. But
// `hobbyiqCardId` -- the field the pool-membership readers (exactPoolReader
// and friends) actually group comps by -- is recomputed from the row's raw
// title/attributes on EVERY call and was, before this fix, written
// unconditionally. So the split-pool defect lived entirely WITHIN one
// document: same address, silently different identity, on every re-upsert.
//
// THE FIX. `recordSoldComp` now point-reads the document at the address it
// is about to write (and, for a vendor id that lands cross-partition,
// cross-partition too) and keeps the STORED cardId/hobbyiqCardId when they
// disagree with what was just re-derived -- recording the disagreement as
// `derivedIdentityAtIngest` + `identityDriftSeen: true` and counting it via
// `getIdentityDriftKeptCount()` so a batch job's banner can report
// `identity-drift-kept-stored N`. A brand new sale (nothing stored at this
// id anywhere) is unaffected -- it keeps writing the freshly derived
// identity exactly as before this guard existed.

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
  getIdentityDriftKeptCount,
  _resetIdentityDriftKeptCounterForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

type Row = Record<string, any>;

/** Minimal fake sold_comps container, scoped to what this file's write
 *  paths touch: `upsert`, a partition-scoped `item().read()` (the address
 *  point-read the new guard issues), and the two cross-partition `query`
 *  shapes recordSoldComp can issue for a vendor id (`c.id = @id AND
 *  c.cardId != @cardId`, and the content-hash / cross-partition-user-dedup
 *  probes that fire earlier and must return empty so they don't interfere). */
function fakeContainer() {
  const store = new Map<string, Row>();
  const deletes: Array<{ id: string; pk: string }> = [];
  const patches: Array<{ id: string; pk: string; ops: Row[] }> = [];
  const key = (pk: string, id: string) => `${pk}::${id}`;

  const container = {
    items: {
      async upsert(doc: Row) {
        store.set(key(doc.cardId, doc.id), { ...doc });
        return { resource: doc };
      },
      query(
        spec: { query: string; parameters?: Array<{ name: string; value: any }> },
        opts?: { partitionKey?: string },
      ) {
        const q = spec.query.replace(/\s+/g, " ");
        const p = new Map<string, any>();
        for (const prm of spec.parameters ?? []) p.set(prm.name, prm.value);

        return {
          async fetchAll() {
            let rows = Array.from(store.values());
            if (opts?.partitionKey !== undefined) rows = rows.filter((d) => d.cardId === opts.partitionKey);
            if (q.includes("ARRAY_CONTAINS(@h, c.contentHash)")) {
              const hashes: string[] = p.get("@h") ?? [];
              rows = rows.filter((d) => hashes.includes(d.contentHash));
            }
            if (q.includes("c.hobbyiqCardId = @slug")) {
              // Cross-partition user dedup probe — not exercised by these
              // vendor-source tests, but must resolve to empty rather than
              // throw if a caller's shape happens to match it.
              rows = rows.filter((d) => d.hobbyiqCardId === p.get("@slug") && d.cardId !== p.get("@cardId"));
            }
            if (q.includes("c.id = @id") && q.includes("c.cardId != @cardId")) {
              rows = rows.filter((d) => d.id === p.get("@id") && d.cardId !== p.get("@cardId"));
            }
            return { resources: rows };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const found = store.get(key(pk, id));
          if (!found) { const e: any = new Error("not found"); e.code = 404; throw e; }
          return { resource: found as T };
        },
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
  _resetIdentityDriftKeptCounterForTests();
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

/** The measured signature: a CardHedge daily row keyed on CardHedge's own
 *  stable `card_id` as the Cosmos partition -- exactly what
 *  chRowToSoldComp.ts / bulk-import-ch-daily-to-sold-comps.cjs pass. */
const chDailySale = (over: Record<string, any> = {}) => ({
  cardId: "ch-card-90210",
  playerName: "Bush and Mantle",
  setName: "2007 Topps",
  cardYear: 2007,
  cardNumber: "40",
  parallel: "Bush/Mantle",
  // CardHedge's `group` field states the vertical directly — normSport
  // maps it to this canonical tag, so a real CH-daily row always carries it.
  sport: "baseball",
  sportAttestedBy: "cardhedge-group",
  price: 45,
  soldAt: "2026-09-03T00:00:00Z",
  source: "cardhedge" as const,
  sourceExternalId: "ch-daily::price-hist-556677",
  ...over,
});

describe("CF-INGEST-KEEPS-STORED-IDENTITY: a re-upsert never silently re-addresses an existing sale", () => {
  it("the ch-daily id shape: cardhedge::ch-daily::<id>, stable across re-derivation", async () => {
    const result = await recordSoldComp(chDailySale());
    expect(result.written).toBe(true);
    expect(result.id).toBe("cardhedge::ch-daily::price-hist-556677");
    expect(rows()).toHaveLength(1);
    // The Cosmos partition key is CardHedge's own stable card_id, unrelated
    // to the derived hiq slug — this is WHY a re-upsert never lands under a
    // new partition for this source.
    expect(rows()[0].cardId).toBe("ch-card-90210");
  });

  it("re-upserting the SAME sale after the deriver regresses to Base keeps the STORED (Bush/Mantle) identity and marks the drift", async () => {
    // 09-03: the deriver correctly reads the stated Bush/Mantle variation.
    const first = await recordSoldComp(chDailySale());
    expect(first.written).toBe(true);
    const storedHobbyiqCardId = rows()[0].hobbyiqCardId;
    expect(storedHobbyiqCardId).toMatch(/bushmantle/);

    // 09-13: the SAME sale is re-upserted (nightly ingest re-runs the row),
    // but the deployed deriver has regressed and now drops the variation to
    // Base. Same cardId (CardHedge's card_id never changes), same
    // sourceExternalId — a genuine re-upsert of the row already in the pool.
    const second = await recordSoldComp(chDailySale({
      parallel: "Base",
      price: 47, // a real price update should still land
    }));
    expect(second.written).toBe(true);
    expect(second.identityDriftKept).toBe(true);

    // Still exactly ONE document — the sale was never re-addressed.
    expect(rows()).toHaveLength(1);
    const stored = rows()[0];

    // The STORED identity wins — the pool this sale prices did not silently
    // change out from under it.
    expect(stored.hobbyiqCardId).toBe(storedHobbyiqCardId);
    expect(stored.hobbyiqCardId).toMatch(/bushmantle/);
    expect(stored.cardId).toBe("ch-card-90210");

    // But the sale field DID update — a re-upsert is still allowed to
    // correct price/date/title/grade.
    expect(stored.price).toBe(47);

    // The disagreement is recorded, not silently discarded.
    expect(stored.identityDriftSeen).toBe(true);
    expect(stored.derivedIdentityAtIngest).toBeTruthy();
    expect(stored.derivedIdentityAtIngest.hobbyiqCardId).toMatch(/\bbase\b/);
    expect(stored.derivedIdentityAtIngest.hobbyiqCardId).not.toMatch(/bushmantle/);

    // Never flagged, never superseded — the row was never treated as a
    // duplicate of anything; it is the one and only copy of this sale.
    expect(stored.flaggedWrong).not.toBe(true);
    expect(stored.dedupSupersededBy).toBeUndefined();
    expect(fake.deletes).toHaveLength(0);
    expect(fake.patches).toHaveLength(0);
  });

  it("a re-upsert whose re-derived identity AGREES with the stored one is a plain update — no drift marker", async () => {
    await recordSoldComp(chDailySale());
    const second = await recordSoldComp(chDailySale({ price: 50 }));
    expect(second.identityDriftKept).toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].identityDriftSeen).toBeUndefined();
    expect(rows()[0].derivedIdentityAtIngest).toBeUndefined();
    expect(rows()[0].price).toBe(50);
  });

  it("a genuinely NEW sale (nothing stored at this id, anywhere) keeps today's behaviour — the derived identity is written", async () => {
    const result = await recordSoldComp(chDailySale({
      cardId: "ch-card-brand-new",
      sourceExternalId: "ch-daily::price-hist-999999",
    }));
    expect(result.written).toBe(true);
    expect(result.identityDriftKept).toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].identityDriftSeen).toBeUndefined();
    // The freshly derived slug is what got written — nothing to keep instead.
    expect(rows()[0].hobbyiqCardId).toMatch(/bushmantle/);
  });

  it("the counter getIdentityDriftKeptCount() increments once per drift-kept write, for a batch job's banner", async () => {
    const before = getIdentityDriftKeptCount();
    await recordSoldComp(chDailySale()); // establishes bushmantle — not a re-upsert, no drift possible
    await recordSoldComp(chDailySale({ parallel: "Base" })); // drift #1: Base disagrees with stored bushmantle
    await recordSoldComp(chDailySale({ parallel: "Bush/Mantle", price: 48 })); // agrees with stored — no drift
    await recordSoldComp(chDailySale({ parallel: "Refractor", price: 60 })); // drift #2: Refractor disagrees with stored bushmantle
    expect(getIdentityDriftKeptCount() - before).toBe(2);
  });

  it("a vendor id that DOES land cross-partition (e.g. tca-ebay, whose cardId is the caller's own slug) also keeps the stored identity, not the new partition", async () => {
    const tcaSale = (over: Record<string, any> = {}) => ({
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

    await recordSoldComp(tcaSale());
    const firstId = rows()[0].id;

    const second = await recordSoldComp(tcaSale({
      cardId: "hiq:hockey:2024:bowman:97:base:no-auto",
      setName: "2024 Bowman",
    }));
    expect(second.identityDriftKept).toBe(true);

    // Still one document, at the ORIGINAL address — never re-addressed, and
    // the "new" partition never receives a second copy of this sale.
    const all = rows().filter((r) => r.id === firstId);
    expect(all).toHaveLength(1);
    expect(all[0].cardId).toBe("hiq:hockey:2024:unknown:97:base:no-auto");
    expect(all[0].flaggedWrong).not.toBe(true);
    expect(fake.deletes).toHaveLength(0);
    expect(fake.patches).toHaveLength(0);
  });
});
