/**
 * THE D23 RENAME STILL OWNS 33 PRODUCTS.
 *
 * A `spelled` product is one productSetKeys decides, and the D23 rename x16 is
 * moving those rows right now. Folding a setKey-drift group inside one would
 * move rows to an address that is about to change under us -- and would do it
 * with the fleet's authority. Baseball's id-setkey-drift fell 146,196 -> 57,088
 * in a single day as the rename landed, so this population is genuinely moving.
 *
 * ~55,199 groups sit inside a ruled family (topps-update-series 15,751;
 * leaf-vivid 12,401; topps-series-2 7,425; ...). They are skipped behind their
 * OWN counter, never silently. The other ~99,108 (donruss~panini-donruss 23,190;
 * bowman~bowman-paper 16,489/7,293; bowman~bowman-chrome 10,361) are D30's.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRenameOwnedProduct } from "../src/services/catalog/duplicateWinnerRule.js";
import { isProductSetKey, productEntry } from "../src/services/catalog/productSetKeys.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

describe("isRenameOwnedProduct", () => {
  it("is true for a product the table SPELLS", () => {
    // topps-update-series is the largest ruled family in the drift population.
    expect(productEntry("topps-update-series")?.spelled).toBe(true);
    expect(isRenameOwnedProduct("topps-update-series")).toBe(true);
  });

  it("is false for a product the table carries but does not spell", () => {
    // bowman-paper IS in the table (productSetKeys.ts:159) -- the spec's claim
    // that it is a fleet-emitted spelling is STALE. It is a real parent/child
    // product pair with `bowman`, so it needs a ruling, not a rename.
    expect(isProductSetKey("bowman-paper")).toBe(true);
    expect(isRenameOwnedProduct("bowman-paper")).toBe(false);
  });

  it("is false for an unknown key", () => {
    expect(isRenameOwnedProduct("not-a-real-product")).toBe(false);
    expect(isRenameOwnedProduct(null)).toBe(false);
    expect(isRenameOwnedProduct("")).toBe(false);
  });

  it("the ruled set is non-empty and small -- the 33 `spelled` products", () => {
    const spelled = ["topps-update-series", "topps-series-2", "topps-chrome-update-series"].filter(isRenameOwnedProduct);
    expect(spelled.length).toBeGreaterThan(0);
  });
});

describe("the fleet skips a rename-owned drift group behind its own counter", () => {
  it("checks the group's rows against isRenameOwnedProduct", () => {
    expect(source).toMatch(/kind === "id-setkey-drift" && rows\.some\(\(r\) => isRenameOwnedProduct\(r\.setKey\)\)/);
  });

  it("counts the skip separately and does NOT fold", () => {
    const block = source.slice(source.indexOf('kind === "id-setkey-drift" && rows.some'));
    expect(block.slice(0, 200)).toMatch(/stats\.skippedRenameOwned\+\+/);
    expect(block.slice(0, 200)).toMatch(/continue;/);
  });

  it("reports the counter with its reason", () => {
    expect(source).toMatch(/skipped: D23 rename owns/);
    expect(source).toMatch(/the rename is still moving it/);
  });

  it("the skip is disjoint from ambiguous and from not-a-group", () => {
    // It is its own term in the reconciliation, so a skipped group is never
    // also counted as a decision.
    expect(source).toMatch(/stats\.notReached \+ stats\.outOfMode \+ stats\.skippedRenameOwned/);
  });

  it("the guard fires BEFORE the decision, so a ruled group is never even decided", () => {
    const guard = source.indexOf('kind === "id-setkey-drift" && rows.some');
    const decide = source.indexOf("const decision = decideDuplicateGroup(");
    expect(guard).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(guard);
  });
});
