/**
 * THE SHARD AXIS, measured rather than assumed.
 *
 * The setKey-range lesson: an axis that was never GROUP BY'd before dispatch
 * put 89% of a retire on one worker and could not reach 66,711 rows. So the
 * axis here is hash(identityKey) % SLOTS, and two properties are asserted:
 *
 *   1. EVERY row of one identity lands on ONE slot. Sharding on the loser id
 *      instead would let two workers race to move the same target.
 *   2. The distribution is flat enough to be worth dispatching. Probed over the
 *      real catalog: football 41,626 multi-row groups -> SLOTS=8 skew 1.016x;
 *      baseball 202,487 -> 1.006x. SLOTS=8 and 16 are both safe.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shardOfIdentity, identityKeyOf } from "../src/services/catalog/foldTwinRuleChecklistNumbered.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");
const sha1 = (s: string) => crypto.createHash("sha1").update(String(s)).digest("hex");

describe("the axis is the identity GROUP, not the row", () => {
  it("shards on hash(identityKey), and skips before grouping", () => {
    expect(source).toMatch(/shardOfIdentity\(key, SLOTS, sha1\) !== SLOT/);
  });

  it("every row of one identity lands on the SAME slot", () => {
    // Same card, four different row spellings/sources -- one identity key, so
    // one slot, whatever the ids look like.
    const rows = [
      { id: "hiq:baseball:2025:topps-chrome:79:gold:no-auto", sport: "baseball", year: 2025, setKey: "topps-chrome", cardNumber: "79", parallelSlug: "gold", isAuto: false },
      { id: "hiq:baseball:2025:topps-chrome:79:base-gold:no-auto", sport: "baseball", year: 2025, setKey: "topps-chrome", cardNumber: "79", parallelSlug: "base-gold", isAuto: false },
      { id: "hiq:baseball:2025:topps-chrome:79:gold:no-auto:num-50", sport: "baseball", year: 2025, setKey: "topps-chrome", cardNumber: "79", parallelSlug: "gold", isAuto: false },
      { id: "hiq:baseball:2025:topps-chrome:79:gold:no-auto:psa-10x", sport: "baseball", year: 2025, setKey: "topps-chrome", cardNumber: "79", parallelSlug: "gold", isAuto: false },
    ];
    for (const slots of [8, 16]) {
      const slotsUsed = new Set(rows.map((r) => shardOfIdentity(identityKeyOf(r), slots, sha1)));
      expect(slotsUsed.size).toBe(1);
    }
  });

  it("sharding on the ROW ID would split one identity -- the axis being avoided", () => {
    const ids = [
      "hiq:baseball:2025:topps-chrome:79:gold:no-auto",
      "hiq:baseball:2025:topps-chrome:79:base-gold:no-auto",
      "hiq:baseball:2025:topps-chrome:79:gold:no-auto:num-50",
    ];
    const byRowId = new Set(ids.map((id) => shardOfIdentity(id, 8, sha1)));
    expect(byRowId.size).toBeGreaterThan(1); // two workers would race the same target
  });
});

describe("the distribution is flat enough to dispatch", () => {
  const keys: string[] = [];
  for (let year = 2020; year <= 2026; year++) {
    for (let n = 1; n <= 400; n++) {
      for (const par of ["gold", "refractor", "orange-refractor", "base"]) {
        keys.push(`baseball|${year}|bowman-chrome|${n}|${par}|no-auto`);
      }
    }
  }

  for (const slots of [8, 16]) {
    it(`skew stays under 1.1x at SLOTS=${slots} over ${keys.length} keys`, () => {
      const counts = new Array(slots).fill(0);
      for (const k of keys) counts[shardOfIdentity(k, slots, sha1)]++;
      expect(counts.filter((c) => c === 0)).toHaveLength(0);
      const skew = (Math.max(...counts) * slots) / keys.length;
      expect(skew).toBeLessThan(1.1);
    });
  }

  it("SLOTS<=1 is a single slot, never a modulo by zero", () => {
    expect(shardOfIdentity("anything", 1, sha1)).toBe(0);
    expect(shardOfIdentity("anything", 0, sha1)).toBe(0);
  });

  it("is deterministic across runs, so a relaunch resumes the same slot", () => {
    const k = "baseball|2025|topps-chrome|79|gold|no-auto";
    expect(shardOfIdentity(k, 8, sha1)).toBe(shardOfIdentity(k, 8, sha1));
  });
});

describe("PROBE_SHARDS is available before a fleet is dispatched", () => {
  it("prints per-slot shares and a skew figure", () => {
    expect(source).toMatch(/PROBE_SHARDS/);
    expect(source).toMatch(/SHARD PROBE over/);
    expect(source).toMatch(/skew \$\{skew\.toFixed\(3\)\}x/);
    expect(source).toMatch(/empty slots/);
  });
});
