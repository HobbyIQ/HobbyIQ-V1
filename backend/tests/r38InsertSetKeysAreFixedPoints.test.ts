// CF-A-REGISTERED-INSERT-SET-KEY-IS-A-FIXED-POINT, R38 (Drew, 2026-09-15).
//
// R38 registered 120 insert-set keys for the 2019-2021 Donruss and Mosaic
// packages staged in `acq-2026-09-14-cardboardconnection-2`. Those 8 files
// carry 77,333 cards and were refused by lib/insert-set-key.cjs because 4,193
// addresses on the bare product key were claimed by two or more different
// cards.
//
// The list itself ships as data (`data/checklist-rulings/2026-09-15-r38-*.json`,
// merged in #2169), so this file reads it and asserts the registration contract
// against every key in it: the day someone adds a key to the list without
// registering it, the first test fails and names it.
//
// BOTH HALVES OR NEITHER. `lib/insert-set-key.cjs` refuses a key that is not a
// `normalizeSetKey` fixed point, because such a key folds somewhere else and
// the rows sit where nothing can reach them. Measured on main BEFORE R38:
// `normalizeSetKey("panini-donruss-rated-rookies")` returned `panini-donruss`
// — a fold past the subset onto the bare parent. Registering with `S`
// (spelled) is what makes the key answer as itself, because normalizeSetKey
// consults `productSetKeyForName`, and only `spelled` products answer there.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const LIST = path.join(__dirname, "..", "data", "checklist-rulings", "2026-09-15-r38-insert-set-keys-for-ruling.json");

type Key = { proposedSetKey: string; parent: string; alreadyRegistered: boolean };

const keys: Key[] = fs.existsSync(LIST)
  ? (JSON.parse(fs.readFileSync(LIST, "utf8")).proposedKeys as Key[])
  : [];

describe("R38 insert-set keys", () => {
  it("the ruling list is present and non-trivial", () => {
    expect(keys.length).toBeGreaterThanOrEqual(120);
  });

  it("every key in the list is a registered product key", () => {
    const missing = keys.filter((k) => !isProductSetKey(k.proposedSetKey)).map((k) => k.proposedSetKey);
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — never folds to its parent", () => {
    const folded = keys
      .map((k) => ({ key: k.proposedSetKey, to: normalizeSetKey(k.proposedSetKey) }))
      .filter((x) => x.to !== x.key);
    expect(folded).toEqual([]);
  });

  it("every key keeps its parent and family, so pools price within the product", () => {
    const wrong = keys.filter(
      (k) => productParentOf(k.proposedSetKey) !== k.parent || productFamilyOf(k.proposedSetKey) !== k.parent
    ).map((k) => k.proposedSetKey);
    expect(wrong).toEqual([]);
  });

  it("the qualified form is what is registered — the BARE subset name is not a key", () => {
    // A bare name collides across sports: `jersey-kings` and `the-rookies` each
    // appear in both a basketball and a football product. Registering the bare
    // form would make one key answer for two different cards.
    const bare = keys
      .map((k) => k.proposedSetKey.slice(k.parent.length + 1))
      .filter((sub) => isProductSetKey(sub));
    expect(bare).toEqual([]);
  });

  it("keeps a brand-repeat name exactly as the source prints it", () => {
    // The insert printed inside Donruss really is called "Donruss Threads";
    // trimming to `panini-donruss-threads` would invent a name the source does
    // not use (Drew, R38).
    expect(isProductSetKey("panini-donruss-donruss-threads")).toBe(true);
    expect(normalizeSetKey("panini-donruss-donruss-threads")).toBe("panini-donruss-donruss-threads");
  });

  it("does NOT register `panini-donruss-rookie`, which names no card set", () => {
    // The guard's cell-wide rung fold derives this key by folding "Rookie
    // Dominator Signatures" and "Rookie Jersey Kings" onto a shared first-word
    // root. They are two DIFFERENT insert sets — at card #1 both name Zion
    // Williamson, but one is an auto /25 and the other a non-auto /99 — and the
    // source prints no section called "Rookie". Registering it would cement the
    // fold's error; the fix belongs in the fold heuristic.
    expect(isProductSetKey("panini-donruss-rookie")).toBe(false);
  });
});
