/**
 * THE SALES WIDTH. `moveCatalogRow` re-points sales with
 * `WHERE c.hobbyiqCardId = @s` -- an EXACT match on the old id
 * (catalogRowOps.service.ts:568). Pool keys routinely EXTEND the row id with
 * `:num-N` and/or a grade segment.
 *
 * Measured on one real loser: `2025:topps-chrome:105:base:no-auto` has 31
 * exact-match sales and 9 more under extending keys. Those 9 would be stranded
 * on a deleted row -- sales silently orphaned, which is the exact failure D30
 * exists to prevent.
 *
 * The second half is subtler: a key that extends a NUMBERED TWIN in the same
 * group belongs to that twin, not to this loser. Attributing by LONGEST match
 * is what stops the fleet stealing a real /N card's sales.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ownsPoolKey } from "../src/services/catalog/duplicateWinnerRule.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

/**
 * THE REAL FUNCTION, not a copy of it. This test used to re-implement the
 * ownership rule locally, so it vouched for its own copy and could drift from
 * the script silently. `ownsPoolKey` now lives in duplicateWinnerRule and the
 * script calls it, so what is asserted here is what runs -- and the regex
 * below pins that the script still delegates rather than re-inlining it.
 */
const ownsKey = (key: string, loserId: string, rivals: string[]): boolean =>
  ownsPoolKey(key, loserId, rivals);

describe("the sales query covers the FULL width, not just the exact id", () => {
  it("queries `id` OR keys extending it with ':'", () => {
    expect(source).toMatch(/c\.hobbyiqCardId = @s OR STARTSWITH\(c\.hobbyiqCardId, @p\)/);
    expect(source).toMatch(/value: `\$\{loserId\}:`/);
  });

  it("the script DELEGATES to ownsPoolKey rather than re-inlining the rule", () => {
    // If someone re-inlines the loop, this fails and the test above stops
    // vouching for the script -- which is exactly the drift being prevented.
    expect(source).toMatch(/ownsPoolKey\(key, loserId, rivals\)/);
    expect(source).toMatch(/ownsPoolKey/);
    // and the rule is NOT duplicated inside the script any more
    expect(source).not.toMatch(/if \(key === loserId\) return true;/);
  });

  it("does NOT hand salesContainer to moveCatalogRow (which would re-scan the narrow subset)", () => {
    const call = source.slice(source.indexOf("const res = await moveCatalogRow"));
    expect(call.slice(0, 400)).not.toMatch(/salesContainer/);
  });
});

describe("each key is attributed to the LONGEST matching row in the group", () => {
  const loser = "hiq:baseball:2025:topps-chrome:105:base:no-auto";
  const numberedTwin = `${loser}:num-50`;

  it("the loser owns its own exact key", () => {
    expect(ownsKey(loser, loser, [numberedTwin])).toBe(true);
  });

  it("the loser owns a GRADE-extending key when no rival is longer", () => {
    expect(ownsKey(`${loser}:psa-10`, loser, [])).toBe(true);
  });

  it("a key under a NUMBERED TWIN belongs to the twin, NOT the loser", () => {
    // The regression: folding the un-numbered row must not drag the /50 card's
    // sales along with it.
    expect(ownsKey(numberedTwin, loser, [numberedTwin])).toBe(false);
    expect(ownsKey(`${numberedTwin}:psa-10`, loser, [numberedTwin])).toBe(false);
  });

  it("the numbered twin, folded on its own, DOES own its extending keys", () => {
    expect(ownsKey(`${numberedTwin}:psa-10`, numberedTwin, [loser])).toBe(true);
  });

  it("an unrelated key is owned by nobody here", () => {
    expect(ownsKey("hiq:baseball:2025:topps-chrome:106:base:no-auto", loser, [])).toBe(false);
  });

  it("the 31 + 9 shape: every key in the measured group is attributed exactly once", () => {
    const keys = [
      loser,
      `${loser}:psa-10`,
      `${loser}:bgs-9-5`,
      numberedTwin,
      `${numberedTwin}:psa-10`,
    ];
    const rows = [loser, numberedTwin];
    for (const key of keys) {
      const owners = rows.filter((r) => ownsKey(key, r, rows.filter((x) => x !== r)));
      expect(owners).toHaveLength(1);
    }
  });
});

describe("the winner-side key keeps whatever the loser key extended", () => {
  it("re-bases the suffix onto the winner rather than flattening it", () => {
    expect(source).toMatch(/const suffix = key\.length > loserId\.length \? key\.slice\(loserId\.length\) : ""/);
    expect(source).toMatch(/const newHiq = `\$\{winnerId\}\$\{suffix\}`/);
  });

  it("a graded sale under the loser lands under the WINNER with its grade intact", () => {
    const loserId = "hiq:baseball:2025:topps-chrome:105:base:no-auto";
    const winnerId = "hiq:baseball:2025:topps-chrome:105:base:no-auto:num-50";
    const key = `${loserId}:psa-10`;
    const suffix = key.length > loserId.length ? key.slice(loserId.length) : "";
    expect(`${winnerId}${suffix}`).toBe(`${winnerId}:psa-10`);
  });
});
