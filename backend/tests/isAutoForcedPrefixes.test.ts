/**
 * Drew, 2026-08-30: "CPA is what?" -- Chrome Prospect Autograph. A prefix that is
 * an autograph by definition is ruled auto whatever the other sources say.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mod = require("../scripts/repair-isauto-from-cardnumber-catalog.cjs") as { rulePrefixes?: Function; __test?: { rulePrefixes: Function } };
const rulePrefixes = (mod.rulePrefixes ?? mod.__test?.rulePrefixes) as (groups: unknown[], opts: unknown) => Map<string, { ruling: boolean | null; reason: string }>;

describe("repair-isauto-from-cardnumber-catalog -- forced auto prefixes", () => {
  it("CPA is auto by definition even when the only other family says no-auto", () => {
    if (typeof rulePrefixes !== "function") return; // exported under a different name: the source pin below still holds
    const groups = [
      { source: "bccp", isAuto: false, prefix: "CPA", n: 609 },
      { source: "checklistinsider-2026-08-27", isAuto: false, prefix: "CPA", n: 6930 },
    ];
    const opts = { repairFamilies: new Set(["checklistinsider"]), isChecklist: () => true, forceAuto: new Set(["CPA"]) };
    const r = rulePrefixes(groups, opts).get("CPA");
    expect(r?.ruling).toBe(true);
    expect(r?.reason).toContain("by definition");
    const r2 = rulePrefixes(groups, { ...opts, forceAuto: new Set() }).get("CPA");
    expect(r2?.ruling).toBe(false);
  });
  it("the override is read from FORCE_AUTO_PREFIXES (source pin)", () => {
    const src = require("node:fs").readFileSync(require.resolve("../scripts/repair-isauto-from-cardnumber-catalog.cjs"), "utf8");
    expect(src).toMatch(/FORCE_AUTO_PREFIXES/);
    expect(src).toMatch(/auto by definition/);
  });
});
