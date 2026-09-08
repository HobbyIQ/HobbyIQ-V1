/**
 * CF-A-SET-NAME-IS-NEVER-A-PARALLEL (#1979) -- the LIST's contract.
 *
 * #1979 shipped these 220 rows as a CATALOG list whose `from` was the row's
 * hobbyiqCardId. sold_comps is partitioned on /cardId, so every point-read at
 * that address 404'd: 220 entries FAILED and 0 were written (runs
 * 34169103280 report / 34169221325 apply). The repair is not a lane change --
 * the lane behaved correctly -- it is a correctly SHAPED list, and this test
 * pins the two judgements that shaping encodes, because both are the kind that
 * a regenerated list could silently get wrong again.
 *
 * 1. THE PARTITION IS WHERE THE ROW IS. `fromCardId` must be the address the
 *    row actually lives at, verified by point-read. Every one of these rows
 *    lives at what the old file called `partitionKey`.
 *
 * 2. THE ACTION FOLLOWS THE cardId's CLASS, and the classes are counted BY
 *    SOURCE, not by row count. A vendor-partitioned row (CardHedge's Bubble id
 *    in cardId) is the 12.96M-row VENDOR-DESIGN class -- disagreement by
 *    CONSTRUCTION, which decideSplitIdentity fails open on -- so only
 *    hobbyiqCardId carries the residue and a REPOINT is the whole repair. A
 *    row whose cardId is an `hiq:` slug naming a DIFFERENT SPORT is genuine
 *    split identity: repointing hobbyiqCardId alone is forbidden there, and a
 *    RELOCATE is refused independently because the destination has no catalog
 *    row to relocate onto. That row PARKS.
 *
 * The mutation this guards: flip a PARK entry to a REPOINT and the list starts
 * asserting a pokemon identity on a row whose partition still says baseball --
 * the exact half-move CF-ONE-CARD-ONE-ROW-ONE-POOL forbids.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const listPath = join(
  __dirname, "..", "data", "pool-relocations", "2026-09-07-pokemon-set-name-residue.json",
);
const list = JSON.parse(readFileSync(listPath, "utf8")) as {
  forLane: string;
  count: number;
  actions: { REPOINT: number; PARK: number; RELOCATE: number };
  catalogRowsAtFakeParallelAddresses: number;
  entries: Array<{
    id: string;
    fromCardId: string;
    repointHobbyiqCardId?: string;
    parkIdentityUnverified?: boolean;
    cardIdClass: string;
    storedHobbyiqCardId: string;
    fakeParallel: string;
    setKey: string;
    evidence: string;
  }>;
};

const isVendorKey = (k: string) => !k.startsWith("hiq:");
const sportOf = (k: string) => (k.startsWith("hiq:") ? k.split(":")[1] : null);

describe("the residue list is a POOL list, not a catalog one", () => {
  it("names the pool lane", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list");
  });

  it("carries all 220 rows, one entry per row", () => {
    expect(list.entries).toHaveLength(220);
    expect(list.count).toBe(220);
  });

  it("is unique on (id, fromCardId) -- the real key", () => {
    // #1936: 1,444 sale ids exist as several documents in DIFFERENT partitions,
    // so the id alone is not the key and a dedup on it would drop real rows.
    const keys = new Set(list.entries.map((e) => `${e.id}|${e.fromCardId}`));
    expect(keys.size).toBe(220);
  });

  it("never uses an hobbyiqCardId as the fromCardId -- the #1979 defect", () => {
    // The mis-filed file set from = the pokemon slug while the row was
    // partitioned elsewhere. If fromCardId ever equals the row's STORED
    // hobbyiqCardId again, every read 404s exactly as it did before.
    for (const e of list.entries) {
      expect(e.fromCardId).not.toBe(e.storedHobbyiqCardId);
    }
  });
});

describe("the action follows the cardId's class", () => {
  it("names exactly one shape per entry", () => {
    // The lane fails an entry that names two shapes; a list must never rely on
    // a precedence order to pick for it.
    for (const e of list.entries) {
      const shapes = [e.repointHobbyiqCardId ? 1 : 0, e.parkIdentityUnverified ? 1 : 0];
      expect(shapes.reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it("REPOINTs only vendor-partitioned rows, and every one of them", () => {
    const repoints = list.entries.filter((e) => e.repointHobbyiqCardId);
    expect(repoints).toHaveLength(196);
    expect(list.actions.REPOINT).toBe(196);
    for (const e of repoints) {
      expect(isVendorKey(e.fromCardId)).toBe(true);
      expect(e.cardIdClass).toBe("vendor-design");
      // A vendor key names no sport, so there is no rival sport to arbitrate --
      // which is the only reason repointing hobbyiqCardId alone is legal here.
      expect(sportOf(e.fromCardId)).toBeNull();
    }
  });

  it("PARKs every row whose cardId is an hiq slug naming another sport", () => {
    const parks = list.entries.filter((e) => e.parkIdentityUnverified);
    expect(parks).toHaveLength(24);
    expect(list.actions.PARK).toBe(24);
    for (const e of parks) {
      expect(isVendorKey(e.fromCardId)).toBe(false);
      expect(e.cardIdClass).toBe("split-identity");
      // Both halves are hiq slugs and the sports genuinely differ. This is the
      // population `never repoint by hobbyiqCardId alone` was written for.
      expect(sportOf(e.fromCardId)).toBe("baseball");
      expect(sportOf(e.storedHobbyiqCardId)).toBe("pokemon");
    }
  });

  it("RELOCATEs nothing -- a relocate here would mint a card from sales", () => {
    // #1924: 0 of 1,218 split destinations existed in card_catalog, so the
    // vehicle is PARK. The 7 base destinations these rows would move to have
    // no catalog row either; a partition move onto them would create the card.
    expect(list.actions.RELOCATE).toBe(0);
    for (const e of list.entries) {
      expect(e).not.toHaveProperty("toCardId");
    }
  });
});

describe("the destination is the BASE address, never a finish", () => {
  it("strips the residue segment and nothing else", () => {
    // CF-A-SET-NAME-IS-NEVER-A-PARALLEL: only the parallel segment changes,
    // and it changes to `base`. A FINISH IS A DIFFERENT CARD LINE (#1935) --
    // 25 of these titles state a real finish and this list does NOT route them
    // there, so a destination naming a finish is a scope breach.
    for (const e of list.entries.filter((x) => x.repointHobbyiqCardId)) {
      const from = e.storedHobbyiqCardId.split(":");
      const to = e.repointHobbyiqCardId!.split(":");
      expect(to).toHaveLength(from.length);
      from.forEach((seg, i) => {
        if (i === 5) {
          expect(seg).toBe(e.fakeParallel);
          expect(to[i]).toBe("base");
        } else {
          expect(to[i]).toBe(seg);
        }
      });
    }
  });

  it("has no catalog companion, because there is nothing to retire", () => {
    // Verified by read 2026-09-07: all 113 distinct fake-parallel addresses
    // hold zero card_catalog rows. A companion retire list would name rows
    // that do not exist.
    expect(list.catalogRowsAtFakeParallelAddresses).toBe(0);
  });
});
