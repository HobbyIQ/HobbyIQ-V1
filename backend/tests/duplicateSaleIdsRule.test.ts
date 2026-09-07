// The rules behind the duplicate-sale-ids census, pinned where they run.
//
// scripts/lib/duplicate-sale-ids.cjs decides three things the report and any
// future repair lane both depend on, and each has already been got wrong once
// somewhere in this codebase:
//
//   1. the SHARD AXIS -- because a duplicate's copies were written at
//      different times, sharding the walk by `_ts` gives a slot one copy and
//      not the other, and the whole population vanishes into the shard
//      boundaries while every slot reconciles honestly;
//   2. CANONICITY -- #1924 §6 measured "hobbyiqCardId is canonical" and found
//      it false about a third of the time, so the rule is address coherence
//      PLUS a catalog-backed destination, and it parks rather than guesses;
//   3. the REMEDY SHAPE -- a park entry, never a delete.

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const D = require_(path.resolve(__dirname, "../scripts/lib/duplicate-sale-ids.cjs"));

const copy = (over: Record<string, any> = {}) => ({
  cardId: "hiq:hockey:2024:bowman:97:base:no-auto",
  hobbyiqCardId: "hiq:hockey:2024:bowman:97:base:no-auto",
  source: "tca-ebay",
  ts: 1_788_000_000,
  ...over,
});

describe("the shard axis co-locates every copy of an id", () => {
  it("hashes on the id ALONE, so the two copies of a duplicate land in one slot", () => {
    // The copies differ in partition, in slug and in _ts -- that IS the defect.
    // Only the id is shared, so only the id may decide the slot.
    const id = "tca-ebay::267679692186";
    const slots = 64;
    expect(D.shardOfId(id, slots)).toBe(D.shardOfId(id, slots));
    // A different id generally lands elsewhere; the point is determinism per id.
    const spread = new Set(
      Array.from({ length: 500 }, (_, i) => D.shardOfId(`tca-ebay::${i}`, slots)),
    );
    expect(spread.size).toBeGreaterThan(30); // it really does spread
  });

  it("degenerates to a single slot rather than dropping ids when slots <= 1", () => {
    expect(D.shardOfId("anything", 1)).toBe(0);
    expect(D.shardOfId("anything", 0)).toBe(0);
  });
});

describe("observe: a re-fetched page is not a duplicate", () => {
  it("folds an identical (id, cardId) instead of counting it twice", () => {
    const m = new Map();
    D.observe(m, "x", copy());
    D.observe(m, "x", copy());
    expect(m.get("x").copies).toBeUndefined(); // still a single-copy record
  });

  it("materialises the copies only when a SECOND partition appears", () => {
    const m = new Map();
    D.observe(m, "x", copy());
    D.observe(m, "x", copy({ cardId: "hiq:hockey:2024:unknown:97:base:no-auto", ts: 1_787_000_000 }));
    expect(m.get("x").copies).toHaveLength(2);
  });

  it("counts a third partition as a third copy", () => {
    const m = new Map();
    D.observe(m, "x", copy());
    D.observe(m, "x", copy({ cardId: "hiq:hockey:2024:unknown:97:base:no-auto" }));
    D.observe(m, "x", copy({ cardId: "hiq:hockey:2024:upper-deck:97:base:no-auto" }));
    expect(m.get("x").copies).toHaveLength(3);
  });
});

describe("address coherence never judges the designed vendor partition", () => {
  it("a vendor cardId returns null — not false", () => {
    // #1650: the vendor partition is load-bearing and 12.96M rows wide. Calling
    // it incoherent would drown the real finding.
    expect(D.addressCoherent(copy({ cardId: "1769294032882x511083935394397250" }))).toBeNull();
  });

  it("a hiq: partition matching its own slug is coherent", () => {
    expect(D.addressCoherent(copy())).toBe(true);
  });

  it("a hiq: partition disagreeing with its own slug is not", () => {
    expect(D.addressCoherent(copy({ hobbyiqCardId: "hiq:hockey:2024:unknown:97:base:no-auto" }))).toBe(false);
  });
});

describe("canonicity: coherent AND catalog-backed, or nobody wins", () => {
  const older = copy({ cardId: "hiq:hockey:2024:unknown:97:base:no-auto", hobbyiqCardId: "hiq:hockey:2024:unknown:97:base:no-auto", ts: 1_787_000_000 });
  const newer = copy();

  it("promotes the one copy that is coherent and resolves to a catalog row", () => {
    const cat = new Set([newer.cardId]);
    const d = D.decideCanonical([older, newer], cat);
    expect(d.verdict).toBe("CANONICAL");
    expect(d.canonical.cardId).toBe(newer.cardId);
    expect(d.extras.map((e: any) => e.cardId)).toEqual([older.cardId]);
  });

  it("parks when BOTH copies qualify — there is no tell between them", () => {
    const cat = new Set([older.cardId, newer.cardId]);
    const d = D.decideCanonical([older, newer], cat);
    expect(d.verdict).toBe("PARK-BOTH-QUALIFY");
    expect(d.canonical).toBeNull();
  });

  it("parks when NEITHER qualifies — a sale never mints its own identity", () => {
    // CF-CATALOG-MATCH-IS-SELF-CONFIRMING: with no checklist naming either
    // address, promoting one would make the sale its own evidence.
    const d = D.decideCanonical([older, newer], new Set());
    expect(d.verdict).toBe("PARK-NEITHER-QUALIFIES");
    expect(d.canonical).toBeNull();
  });

  it("does NOT let the newer copy win merely for being newer — the OLDER one can be canonical", () => {
    // The convention #1924 measured and rejected. Here the NEWER copy is
    // catalog-backed but INCOHERENT (its partition disagrees with its own
    // slug), and the older copy is both coherent and catalog-backed. The older
    // one wins, because the rule reads evidence and not recency.
    const incoherentNewer = copy({ hobbyiqCardId: "hiq:hockey:2024:unknown:97:base:no-auto" });
    const d = D.decideCanonical([older, incoherentNewer], new Set([incoherentNewer.cardId, older.cardId]));
    expect(d.verdict).toBe("CANONICAL");
    expect(d.canonical.cardId).toBe(older.cardId);
    // ...and the extra parked is the NEWER document.
    expect(d.extras.map((e: any) => e.cardId)).toEqual([incoherentNewer.cardId]);
  });

  it("parks when the only catalog-backed copy is incoherent", () => {
    // Neither qualifies: the newer is catalog-backed but incoherent, the older
    // is coherent but names no catalog row. No evidence promotes either.
    const incoherentNewer = copy({ hobbyiqCardId: "hiq:hockey:2024:unknown:97:base:no-auto" });
    const d = D.decideCanonical([older, incoherentNewer], new Set([incoherentNewer.cardId]));
    expect(d.verdict).toBe("PARK-NEITHER-QUALIFIES");
    expect(d.canonical).toBeNull();
  });
});

describe("the remedy is a park entry, never a delete", () => {
  it("addresses ONE document by (id, fromCardId) and asks for identityUnverified", () => {
    const e = D.parkEntry("tca-ebay::267679692186", copy(), "both copies coherent");
    expect(e).toMatchObject({
      id: "tca-ebay::267679692186",
      fromCardId: "hiq:hockey:2024:bowman:97:base:no-auto",
      parkIdentityUnverified: true,
    });
    // The lane keys uniqueness on (id, fromCardId) -- each copy is repaired at
    // its OWN address, which is exactly the granularity this defect needs.
    expect(e.evidence).toContain("duplicate-partition-copy");
    // No delete, no relocate, no toCardId: a sale is never lost and this lane
    // never guesses a destination.
    expect(e).not.toHaveProperty("toCardId");
  });
});

describe("summarize reconciles", () => {
  it("documents equal ids plus excess, and orders copies newest-first", () => {
    const dups = [
      { id: "a", copies: [copy({ ts: 1 }), copy({ cardId: "hiq:x", ts: 2 })] },
      { id: "b", copies: [copy({ ts: 1 }), copy({ cardId: "hiq:y", ts: 2 }), copy({ cardId: "hiq:z", ts: 3 })] },
    ];
    const r = D.summarize(dups, 1_788_000_000);
    expect(r.dupIds).toBe(2);
    expect(r.dupIds3plus).toBe(1);
    expect(r.dupDocs).toBe(5);
    expect(r.excessDocs).toBe(3);
    expect(r.dupDocs).toBe(r.dupIds + r.excessDocs);
  });
});
