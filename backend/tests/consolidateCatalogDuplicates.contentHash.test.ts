/**
 * THE contentHash HAZARD -- and its two fixes.
 *
 * THE HAZARD. `computeContentHash` and its mirror in relocate-sold-comp.cjs
 * both stripped a trailing " Refractor", on the rule that a colour and its
 * colour-refractor sibling were one card. D31 RETRACTED that rule on
 * 2026-08-30: the catalog resolver decides per card, and Topps Finest #197
 * lists `Uncommon` AND `Uncommon Refractor` as two of ~600 real pairs Drew
 * named. contentHash is the store's partition-scoped PRE-WRITE dedup key, so
 * with the strip in place a fold that lands a `Gold` sale and a `Gold
 * Refractor` sale in ONE partition makes the pool's dedup eat a real sale.
 *
 * FIX 1 -- THE HASH. The strip is gone from the hash input; the parallel is
 * hashed whole. The legacy form survives only so the dedup LOOKUP can still
 * find rows stored under it during the transition. That work is pinned in
 * `soldCompsContentHashD31.test.ts`; asserted here only where the FLEET
 * depends on it.
 *
 * FIX 2 -- THE GUARD'S ORDERING. The first build probed the hash inside
 * `moveSalesAndRow` and refused AFTER the group loop, so under APPLY every
 * colliding sale was already written before `exit(2)` could fire. The probe is
 * now a read-only PRE-FLIGHT over the whole plan, and APPLY refuses with zero
 * writes. The ordering itself is pinned in
 * `consolidateCatalogDuplicates.preflight.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");
const require_ = createRequire(import.meta.url);
const lib = require_(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs")) as {
  contentHashOf: (row: Record<string, unknown>) => string;
  legacyContentHashOf: (row: Record<string, unknown>) => string;
  contentHashesForLookup: (row: Record<string, unknown>) => string[];
};

const common = {
  cardId: "hiq:baseball:2025:topps-chrome:79:gold:no-auto",
  isAuto: false,
  gradeCompany: "PSA",
  gradeValue: 10,
  price: 123.45,
  soldAt: "2026-08-01T00:00:00.000Z",
};

describe("the hazard is CLOSED: the strip is gone from the hash", () => {
  it("a Gold sale and a Gold Refractor sale no longer collide in one partition", () => {
    expect(lib.contentHashOf({ ...common, parallel: "Gold" }))
      .not.toBe(lib.contentHashOf({ ...common, parallel: "Gold Refractor" }));
  });

  it("THE BUG WAS REAL: the legacy hash DID collide them (mutation check)", () => {
    // The counter-check. If this stops holding, the legacy helper has changed
    // and the transition lookup no longer describes the stored pool.
    expect(lib.legacyContentHashOf({ ...common, parallel: "Gold" }))
      .toBe(lib.legacyContentHashOf({ ...common, parallel: "Gold Refractor" }));
  });

  it("the live hash in the script lib strips nothing", () => {
    const mirror = fs.readFileSync(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"), "utf8");
    const live = mirror.slice(mirror.indexOf("function contentHashOf"), mirror.indexOf("function legacyContentHashOf"));
    expect(live).not.toMatch(/replace\(\/ refractors\?\$\/, ""\)/);
  });

  it("a stored legacy row is still findable, so the fix cannot resurrect duplicates", () => {
    const row = { ...common, parallel: "Gold Refractor" };
    expect(lib.contentHashesForLookup(row)).toContain(lib.legacyContentHashOf(row));
    expect(lib.contentHashesForLookup(row)[0]).toBe(lib.contentHashOf(row));
  });
});

describe("the fleet still measures the collisions a fold WOULD create", () => {
  it("probes each sale's would-be hash in the WINNER's partition", () => {
    expect(source).toMatch(/contentHashOf\(\{ \.\.\.row, cardId: winnerId \}\)/);
  });

  it("reports the count in the dry run, whether or not APPLY is set", () => {
    expect(source).toMatch(/contentHash PRE-FLIGHT/);
    expect(source).toMatch(/contentHash COLLISIONS/);
  });

  it("APPLY exits non-zero while any collision is outstanding", () => {
    // Bounded to the guard's own block — from the `if` to the write phase that
    // follows it — rather than a fixed character count. The count was 900 and
    // D30-R3's longer refusal message (which now has to explain that only a
    // SHARED sourceExternalId blocks) pushed `process.exit(2)` past the window,
    // reddening a test whose subject had not changed at all.
    const start = source.indexOf("if (APPLY && preflight.collisions > 0)");
    const end = source.indexOf("-- the write phase", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(/process\.exit\(2\)/);
  });

  it("the refusal sits BEFORE the write reconciliation, so a blocked run never reports writes", () => {
    const guard = source.indexOf("if (APPLY && preflight.collisions > 0)");
    const rw = source.indexOf("reportWrites({");
    expect(guard).toBeGreaterThan(-1);
    expect(rw).toBeGreaterThan(guard);
  });

  it("...and BEFORE the first write, which is the whole point of the restructure", () => {
    const guard = source.indexOf("if (APPLY && preflight.collisions > 0)");
    const firstWrite = source.indexOf("await moveSalesAndRow(");
    expect(guard).toBeLessThan(firstWrite);
  });
});
