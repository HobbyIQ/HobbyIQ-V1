/**
 * D19's incidental find (2026-08-30): catalogSlugIfExists tested `/:num-d+$/` — a literal
 * "d", not a digit class — so its un-numbered-twin fallback never fired. The same `\d`
 * typo hit conform-holdings' year regex the same night. Pin the digit class.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("catalogSlugIfExists -- the numbered-twin regex matches digits", () => {
  it("uses \d, not a literal d", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/services/catalog/catalogMatcher.service.ts"), "utf8");
    expect(src).not.toMatch(/\/:num-d\+\$\//);
    expect(src).toMatch(/\/:num-\\d\+\$\//);
    expect("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150".replace(/:num-\d+$/, "")).toBe("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto");
  });
});
