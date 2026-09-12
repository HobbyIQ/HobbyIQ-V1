import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-09-12 widget ruling (Drew) -- the ONE sold_comps sale sitting on a
 * bowman-chrome CPA phantom-parallel row (see
 * bowmanChromeCpaPhantomParallelsRetire.test.ts for the full finding).
 *
 * Of the 26 phantom catalog rows this repair covers, exactly one
 * (cpa-eha:packfractor:auto:num-89) carries a live sale, counted on both
 * addresses (cardId partition read + hobbyiqCardId filtered query, 2026-09-12).
 * Its title states the current (phantom) Bowman Chrome PackFractor address, but
 * no Bowman-side PackFractor row exists for this player+number -- the 2026
 * Bowman CPA PackFractor Autographs section is a checklist gap here, not a
 * card that does not exist. Absent beats wrong: it parks rather than relocating
 * to an unattested address or being minted from the sale.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "pool-relocations", "2026-09-12-bowman-chrome-cpa-phantom-parallels-park.json"),
    "utf8",
  ),
);

type PoolEntry = {
  id: string;
  fromCardId: string;
  toCardId?: string;
  repointHobbyiqCardId?: string;
  retireSupersededBy?: string;
  parkIdentityUnverified?: boolean;
  price?: number;
  evidence?: string;
};
const entries = list.entries as PoolEntry[];

describe("2026-09-12 bowman-chrome CPA phantom parallels: the pool park list", () => {
  it("is addressed to the pool lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("is exactly ONE entry — the only sale found on the 26 phantom rows", () => {
    expect(list.census.rowsWithSales).toBe(1);
    expect(list.census.salesParked).toBe(1);
    expect(list.census.rowsWithZeroSales).toBe(25);
    expect(entries).toHaveLength(1);
  });

  it("names exactly one shape per entry — never two shapes on one row", () => {
    // Mirrors the lane's own shape-exclusivity check (relocate-pool-rows-by-list.cjs):
    // an entry may carry exactly one of to/repoint/retire/park.
    for (const e of entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes, e.id).toHaveLength(1);
      expect(shapes[0], e.id).toBe("park");
    }
  });

  it("every entry has an id and a fromCardId, the lane's minimum shape", () => {
    for (const e of entries) {
      expect(e.id).toBeTruthy();
      expect(e.fromCardId).toBeTruthy();
    }
  });

  it("parks the exact sale named in the finding, at its phantom address", () => {
    expect(entries[0].id).toBe("tca-ebay::366600338471");
    expect(entries[0].fromCardId).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:packfractor:auto:num-89");
    expect(entries[0].price).toBe(695);
  });

  it("does not relocate — no bowman-side PackFractor address exists to move to", () => {
    expect(entries[0].toCardId).toBeUndefined();
    expect(entries[0].repointHobbyiqCardId).toBeUndefined();
  });

  it("evidence records the checklist gap, not a guess", () => {
    expect(entries[0].evidence, "evidence").toMatch(/No hiq:baseball:2026:bowman:cpa-eha:packfractor:auto:num-89/);
    expect(entries[0].evidence, "evidence").toMatch(/checklist gap/i);
  });

  it("the paired catalog retire depends on this park applying first", () => {
    expect(String(JSON.stringify(list.rulings))).toMatch(
      /retired in the paired catalog list.*ONLY AFTER this park has applied/,
    );
  });
});
