import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * THE 1950s TOPPS NON-SPORT SPORT-SEGMENT LIST (2026-09-06).
 *
 * 654 sales of eight 1950s Topps NON-SPORT issues -- Wings, Rails and Sails,
 * Scoop, Look n See, Davy Crockett, World on Wheels, Flags of the World and
 * Fighting Marines -- carry the vertical segment `baseball` and sit inside 355
 * pools that otherwise hold real vintage baseball cards. 353 of those pools are
 * genuine baseball cards being priced off a comp pool that contains cards from
 * a different vertical entirely.
 *
 * WHAT THE MEASUREMENT DECIDED, stated because the pins encode it:
 *
 *   THE GRAMMAR IS NOT THE BLOCKER. `non-sport` is already canonical in
 *   CANONICAL_SPORTS (slugGuard.service.ts) and in the Vertical union
 *   (resolveVertical.service.ts), so a destination is spellable and nothing
 *   here is invented. The sport->vertical refactor that parked the Pokemon
 *   expansion is about RENAMING the segment; it does not gate this list.
 *
 *   THE CHECKLIST IS. card_catalog holds ZERO rows for all eight sets at any
 *   sport and any candidate setKey. So every entry is a PARK: routing 654
 *   sales onto slugs no checklist names would mint 355 identities whose only
 *   evidence is the sales themselves.
 *
 *   THE PHRASE ALONE OVER-COLLECTS BY 780. A first pass on the set phrase
 *   matched 1,434 rows; 675 were Detroit/Parkhurst RED WINGS hockey, 7 were
 *   1940 Gum Inc Superman "Wings of Mercy", and one was a T206 "Scoops Carey"
 *   -- a player nickname. Requiring the title to name TOPPS beside the set is
 *   what makes the population defensible, and this test pins both numbers.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "pool-relocations", "2026-09-06-nonsport-topps-sport-segment.json"),
    "utf8",
  ),
);

type PoolEntry = {
  id: string;
  fromCardId: string;
  currentAddress: string;
  toCardId?: string;
  repointHobbyiqCardId?: string;
  retireSupersededBy?: string;
  parkIdentityUnverified?: boolean;
  wouldBeCardId?: string;
  evidence?: string;
};

const entries = list.entries as PoolEntry[];

describe("the non-sport sport-segment list", () => {
  it("is addressed to the pool lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list.cjs");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("carries all 654 in-scope rows, each exactly once", () => {
    expect(list.census.rowsInScope).toBe(654);
    expect(entries).toHaveLength(654);
    expect(new Set(entries.map((e) => e.id)).size).toBe(654);
  });

  it("is ENTIRELY parks -- no relocate, no repoint, no retire", () => {
    // The load-bearing pin. A destination that no checklist names must never
    // be routed to, so this list moves nothing at all until one exists.
    expect(list.census.relocate).toBe(0);
    expect(list.census.park).toBe(654);
    expect(entries.filter((e) => e.parkIdentityUnverified === true)).toHaveLength(654);
    expect(entries.filter((e) => e.toCardId)).toHaveLength(0);
    expect(entries.filter((e) => e.repointHobbyiqCardId)).toHaveLength(0);
    expect(entries.filter((e) => e.retireSupersededBy)).toHaveLength(0);
  });

  it("every entry names exactly ONE shape, the way the lane counts them", () => {
    for (const e of entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes).toHaveLength(1);
    }
  });

  it("every entry carries an id, an address, and real evidence", () => {
    for (const e of entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(String(e.evidence ?? "").length).toBeGreaterThan(60);
    }
  });

  it("the lane's own module loads, and no entry is malformed by its rules", () => {
    // Pinning against the lane means a shape drift fails here, not mid-apply.
    const lane = path.join(process.cwd(), "scripts", "relocate-pool-rows-by-list.cjs");
    const L = require_(lane) as Record<string, unknown>;
    expect(typeof L.planRelocatedIdentity).toBe("function");
    for (const e of entries) {
      expect(String(e.id ?? "").trim(), "the lane rejects an entry with no id").not.toBe("");
      expect(
        String(e.fromCardId ?? "").trim(),
        "the lane rejects an entry with no partition",
      ).not.toBe("");
    }
  });

  it("the destination would be spelled with the CANONICAL non-sport vertical", () => {
    // Never invented: non-sport is the value the guard already accepts.
    const { CANONICAL_SPORTS } = require_(
      path.join(process.cwd(), "dist", "services", "portfolioiq", "slugGuard.service.js"),
    ) as { CANONICAL_SPORTS: ReadonlySet<string> };
    expect(CANONICAL_SPORTS.has("non-sport")).toBe(true);
    for (const e of entries) {
      expect(String(e.wouldBeCardId)).toMatch(/^hiq:non-sport:/);
      expect(String(e.currentAddress)).toMatch(/^hiq:baseball:/);
    }
  });

  it("records that NO checklist destination exists -- which is WHY it parks", () => {
    expect(list.provenance.catalogDestinationsFound).toBe(0);
    expect(list.provenance.catalogDestinationsChecked).toBe(355);
    expect(JSON.stringify(list.rulings)).toMatch(/ZERO rows for all eight sets/);
    expect(JSON.stringify(list.rulings)).toMatch(/NEVER MINTS AN IDENTITY FROM A SALE/);
  });

  it("states the grammar already allows non-sport, so the refactor is not the blocker", () => {
    expect(JSON.stringify(list.rulings)).toMatch(/GRAMMAR ALLOWS non-sport ALREADY/);
    expect(JSON.stringify(list.rulings)).toMatch(/VERTICAL REFACTOR IS NOT THE BLOCKER/);
  });

  it("pins the 780 false positives the phrase-only pass collected", () => {
    // If a future re-measure loses this exclusion, the population silently
    // doubles and 675 hockey cards get marked identityUnverified.
    expect(list.census.titlePhraseCandidates).toBe(1434);
    expect(list.census.falsePositivesExcluded).toBe(780);
    expect(list.census.titlePhraseCandidates - list.census.falsePositivesExcluded).toBe(654);
    expect(JSON.stringify(list.rulings)).toMatch(/MUST NAME TOPPS/);
    for (const e of entries) expect(String(e.evidence)).toMatch(/1950s Topps NON-SPORT issue/);
  });

  it("pins the pool exposure: 353 real baseball pools are diluted", () => {
    expect(list.census.pollutedPools).toBe(355);
    expect(list.census.salesOnPollutedPools).toBe(48444);
    expect(list.census.poolsMixedRealBaseballDiluted).toBe(353);
    expect(list.census.poolsPureNonSport).toBe(2);
    expect(
      list.census.poolsMixedRealBaseballDiluted + list.census.poolsPureNonSport,
    ).toBe(list.census.pollutedPools);
  });

  it("the eight sets sum to the population, and the year is not the defect", () => {
    const bySet = list.census.bySet as Record<string, number>;
    expect(Object.values(bySet).reduce((a, b) => a + b, 0)).toBe(654);
    expect(Object.keys(bySet).sort()).toEqual([
      "davy crockett",
      "fighting marines",
      "flags of the world",
      "look n see",
      "rails and sails",
      "scoop",
      "wings",
      "world on wheels",
    ]);
    // Every row's cardYear already agrees with its set's real issue year, so
    // only the vertical segment is wrong -- this is not a cardYear repair.
    expect(JSON.stringify(list.rulings)).toMatch(/THE YEAR IS NOT THE DEFECT/);
  });

  it("splits the population by partition shape, because the two repair differently", () => {
    // A vendor-id partition is not a card address and must never become one:
    // if these are ever routed, those rows repoint in place rather than move.
    expect(list.census.slugPartitioned).toBe(583);
    expect(list.census.vendorPartitioned).toBe(71);
    expect(list.census.slugPartitioned + list.census.vendorPartitioned).toBe(654);
    expect(entries.filter((e) => !e.fromCardId.startsWith("hiq:"))).toHaveLength(71);
  });
});
