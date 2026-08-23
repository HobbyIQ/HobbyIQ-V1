/**
 * CF-SAPPHIRE-ONE-NAME (2026-08-23).
 *
 * The catalog holds one product under several setKey spellings, each from a
 * different checklist source and all of them real:
 *
 *   bowman-chrome-sapphire          21858
 *   bowman-chrome-sapphire-edition   6188
 *   bowman-sapphire-chrome           4676
 *   topps-chrome-sapphire           36519
 *   topps-sapphire-chrome             946
 *
 * I set out to add a token-set normaliser for this and then measured: every
 * case already converges through knownSetKeyPatterns. normalizeSetKey was never
 * the defect — a refile tool computing "<base>-sapphire" blindly was, and that
 * is fixed where it belongs, in the tool.
 *
 * So this file adds no production code. It pins the convergence that already
 * works, because it is load-bearing for every sapphire sale we file and nothing
 * currently guards it.
 *
 * THE NEGATIVE CASES ARE THE POINT. bowman-sapphire and bowman-chrome-sapphire
 * are DIFFERENT SETS and must never collapse into each other — that merge is
 * the one Drew has called catastrophic. Sales are filed correctly by matching
 * the set, not by flattening the names.
 */
import { describe, expect, it } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("sapphire spellings already converge on one name", () => {
  it("folds spellings of the same product", () => {
    const groups: Array<[string[], string]> = [
      [
        ["Bowman Chrome Sapphire", "Bowman Chrome Sapphire Edition", "Bowman Sapphire Chrome"],
        "bowman-chrome-sapphire",
      ],
      [["Bowman Draft Sapphire", "Bowman Draft Sapphire Edition"], "bowman-draft-sapphire"],
      [
        ["Topps Chrome Sapphire", "Topps Chrome Sapphire Edition", "Topps Sapphire Chrome"],
        "topps-chrome-sapphire",
      ],
    ];
    for (const [variants, canonical] of groups) {
      for (const v of variants) {
        expect(normalizeSetKey(v), `${v} should normalise to ${canonical}`).toBe(canonical);
      }
    }
  });

  it("never drops the word sapphire — the defect that filed sales into the base set", () => {
    // "Bowman Draft Sapphire" normalised to "bowman-draft" because the only
    // Draft-Sapphire pattern required the word "chrome" between them. Every
    // such sale was filed into the base Draft set AT INGEST — 6,417 of the ones
    // the refile sweep is now moving back. Cleaning them up without this fix
    // would just let the ingest recreate them.
    for (const name of ["Bowman Draft Sapphire", "Bowman Draft Sapphire Edition", "Bowman Chrome Sapphire", "Topps Chrome Sapphire", "Bowman Sapphire"]) {
      expect(normalizeSetKey(name), `${name} must keep sapphire`).toContain("sapphire");
    }
  });

  it("keeps Bowman and Bowman Chrome apart — they are different sets", () => {
    // The whole reason the fold has to be conservative. Collapsing these would
    // put one set's comps in the other's pool.
    expect(normalizeSetKey("Bowman Chrome Sapphire")).not.toBe(normalizeSetKey("Bowman Sapphire"));
    expect(normalizeSetKey("Bowman Draft Sapphire")).not.toBe(normalizeSetKey("Bowman Chrome Sapphire"));
  });

  it("leaves non-sapphire products untouched", () => {
    expect(normalizeSetKey("Bowman Draft")).toBe("bowman-draft");
    expect(normalizeSetKey("Bowman Chrome")).toBe("bowman-chrome");
  });
});
