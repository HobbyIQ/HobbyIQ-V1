import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE READ-BACK VERIFY TWINS -- the rows the IMPROVE fleet left at two
 * addresses, and the ONE shape this lane can express for them.
 *
 * relocateSoldComp upserts the keeper, reads it back, and only then deletes
 * the old row. When the read-back could not be verified the keeper was
 * ALREADY written and the old row still stood -- so the sale is resident
 * twice. Across the 32-slot rematch-sold-comps IMPROVE fleet, 21 rows
 * reported `read-back differs from the written row`; a per-id cross-partition
 * probe found 14 of them resident TWICE, and those 14 are this list.
 *
 * THE LANE CANNOT DELETE. relocate-pool-rows-by-list supports four shapes --
 * relocate, repoint, retire, park -- and CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE
 * makes RETIRE a patch in place: `flaggedWrong` plus `dedupSupersededBy`, which
 * is what every FMV read already excludes and which is reversible where a
 * delete is not. So the twin is RETIRED, not removed, and this list invents no
 * new mode to do it.
 */
describe("the read-back verify twins list is well-formed and report-first", () => {
  const LIST = "data/pool-relocations/2026-09-06-readback-verify-twins.json";
  const list = JSON.parse(readFileSync(path.join(process.cwd(), LIST), "utf8"));

  it("names ONLY marker shapes — never a relocate, a repoint, or a delete", () => {
    // The same pin the twin-address-dedup list carries. A relocate shape here
    // would MOVE a row, and moving is exactly what already went wrong.
    const relocate = list.entries.filter((e: any) => e.toCardId && e.toCardId !== e.fromCardId);
    const repoint = list.entries.filter((e: any) => e.repointHobbyiqCardId);
    expect(relocate).toHaveLength(0);
    expect(repoint).toHaveLength(0);
    expect(list.entries.length).toBeGreaterThan(0);
  });

  it("every entry names exactly ONE shape, and it is retire", () => {
    // The lane refuses an entry naming two shapes; a silent precedence order
    // is how the wrong one gets applied.
    for (const e of list.entries as any[]) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes).toEqual(["retire"]);
    }
  });

  it("every entry carries an id, the twin's address, and its evidence", () => {
    // `id` + `fromCardId` is how the lane point-reads the row it will mark;
    // an entry the lane cannot address is an entry it silently skips.
    for (const e of list.entries as any[]) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(String(e.evidence ?? "").length).toBeGreaterThan(30);
    }
  });

  it("never retires a row onto its own address", () => {
    // A marker pointing at the row it is stamped on would orphan the sale.
    for (const e of list.entries as any[]) {
      expect(e.retireSupersededBy).not.toBe(e.fromCardId);
    }
  });

  it("names the KEEPER so the retired row can be audited back to it", () => {
    // The lane stamps `retireSupersededBy` onto the twin as
    // `dedupSupersededBy`. Without the keeper's address a retired row is a
    // dead end -- there would be no way to show the sale still has a home.
    for (const e of list.entries as any[]) {
      expect(String(e.retireSupersededBy ?? "")).toMatch(/^hiq:/);
      expect(String(e.keeperHobbyiqCardId ?? "")).toMatch(/^hiq:/);
      // The keeper is canonical: its partition IS its slug. That is what
      // makes it the address the pricing engine will read.
      expect(e.keeperHobbyiqCardId).toBe(e.retireSupersededBy);
      // And the write that made it is dated -- the proof it landed.
      expect(String(e.keeperVerifiedAt ?? "")).toMatch(/^2026-09-0[56]T/);
    }
  });

  it("every entry names the fleet run that minted the twin", () => {
    // A twin with no run id cannot be traced back to the log line that
    // reported it, and this list's whole claim is that the failure was
    // spurious -- that claim has to be checkable.
    for (const e of list.entries as any[]) {
      expect(String(e.runId ?? "")).toMatch(/^\d{8,}$/);
    }
  });

  it("one entry per id — a twin is retired once", () => {
    // Two entries for one id would mark the same row twice, or worse, mark
    // BOTH copies and leave the sale in no pool at all.
    const ids = (list.entries as any[]).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the census matches the entries it describes", () => {
    // The number in the header is the number a reviewer checks the diff
    // against; if they can drift, the header stops being evidence.
    expect(list.census.retire).toBe(list.entries.length);
    expect(list.census.park).toBe(0);
    expect(list.census.probedResidentTwice).toBe(list.entries.length);
    // The rows that reported the error but are resident ONCE are excluded on
    // purpose: a failure is not a twin until the container says so.
    expect(list.census.differsFromWrittenRow).toBe(
      list.census.probedResidentTwice + list.census.probedResidentOnce,
    );
  });

  it("targets the lane by name", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list.cjs");
  });
});
