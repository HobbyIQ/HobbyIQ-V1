/**
 * D19's incidental find (2026-08-30): catalogSlugIfExists tested `/:num-d+$/` — a literal
 * "d", not a digit class — so its un-numbered-twin fallback never fired. The same `\d`
 * typo hit conform-holdings' year regex the same night. Pin the digit class.
 *
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the rule — and its regex — moved to
 * catalogIdentityResolver.ts; catalogSlugIfExists is a thin wrapper over it. The pin
 * follows the rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

describe("catalogSlugIfExists -- the numbered-twin regex matches digits", () => {
  it("uses \d, not a literal d — in the resolver, where the rule now lives", () => {
    const resolver = read("../src/services/catalog/catalogIdentityResolver.ts");
    const matcher = read("../src/services/catalog/catalogMatcher.service.ts");
    for (const src of [resolver, matcher]) expect(src).not.toMatch(/\/:num-d\+\$\//);
    expect(resolver).toMatch(/\/:num-\\d\+\$\//);
    expect("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150".replace(/:num-\d+$/, "")).toBe("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto");
  });
  it("catalogSlugIfExists defers to the one resolver — no second copy of the twin rule in the matcher", () => {
    const matcher = read("../src/services/catalog/catalogMatcher.service.ts");
    expect(matcher).toMatch(/resolveIdentityToCatalogRow\(id, \{ printRun/);
    expect(matcher).not.toMatch(/candidates\.push\(id\.replace/);
  });
});
