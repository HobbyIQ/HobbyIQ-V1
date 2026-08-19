// CF-SETKEY-IS-ALWAYS-A-SLUG (Drew, 2026-08-19: "Fix the setkeys to work").
//
// 821 setKey spellings in card_catalog were not slugs — 91,135 rows of
// checklist evidence we owned and could not reach, because a conformance audit
// cannot see `bowman's-best` when every comp says `bowmans-best`.
//
// THE POINT OF THIS TEST IS THAT slugify() WAS NEVER BROKEN.
//
// It already produces the canonical form for every case found in production.
// The damage came from bulk ingest paths writing setKey RAW — a vendor
// setName, or a display string like "2024 Panini Donruss" — without passing it
// through. The live auto-seed path (ensureCatalogRow) does call
// normalizeSetKey and its rows are clean.
//
// So this pins the rule rather than adding one. While writing the repair I
// reimplemented the same normalisation independently, which is the
// one-rule-two-implementations defect that produced half the bugs in this
// effort. These cases are the contract both sides must satisfy, and the repair
// script now imports slugify instead of carrying its own copy.

import { describe, it, expect } from "vitest";
import { slugify, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** A setKey is a slug: lowercase, a-z 0-9, single internal hyphens. */
const isSlug = (k: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k);

describe("CF-SETKEY-IS-ALWAYS-A-SLUG", () => {
  it("strips apostrophes rather than hyphenating them", () => {
    // "america-s-best-signatures" is what a naive collapse-everything-to-hyphen
    // rule produces, and it is wrong. The already-correct majority spelling in
    // production is `bowmans-best`, which is the specification.
    expect(slugify("Bowman's Best")).toBe("bowmans-best");
    expect(slugify("America's Best Signatures")).toBe("americas-best-signatures");
    expect(slugify("Can't Miss")).toBe("cant-miss");
    expect(slugify("Scouts' Top 100")).toBe("scouts-top-100");
  });

  it("treats a curly apostrophe like a straight one", () => {
    // Both spellings existed in the catalog as SEPARATE keys (2,353 and 96 rows).
    expect(slugify("Bowman’s Best")).toBe(slugify("Bowman's Best"));
  });

  it("drops commas inside numbers instead of splitting them", () => {
    expect(slugify("1,000 Yard Club")).toBe("1000-yard-club");
  });

  it("normalises case and spaces, so a display name cannot become a key", () => {
    // "2024 Panini Donruss" (3,599 rows) and "Topps" (639) were stored as keys.
    expect(slugify("Topps")).toBe("topps");
    expect(slugify("2024 Panini Donruss")).toBe("2024-panini-donruss");
    expect(slugify("2024-25 Panini Prizm")).toBe("2024-25-panini-prizm");
  });

  it("strips ampersands and exclamation marks", () => {
    expect(slugify("Topps Allen & Ginter")).toBe("topps-allen-ginter");
    expect(slugify("LFG!")).toBe("lfg");
  });

  it("trims a dangling hyphen", () => {
    // `bbm-` held 23,515 rows from one tcdb ingest whose setName was absent.
    expect(slugify("bbm-")).toBe("bbm");
  });

  it("is idempotent — re-slugging a slug changes nothing", () => {
    // Required for a repair to be safe to re-run, and for the audit and the
    // parser to agree on what "already clean" means.
    for (const s of ["bowmans-best", "topps-allen-ginter", "2024-panini-donruss", "1000-yard-club"]) {
      expect(slugify(s)).toBe(s);
    }
  });

  it("every production spelling that had to be repaired slugs to its target", () => {
    // Taken from the largest rewrites in the live repair, so the parser and the
    // data fix cannot drift apart.
    const cases: Array<[string, string]> = [
      ["bowman's-best", "bowmans-best"],
      ["topps-allen-&-ginter", "topps-allen-ginter"],
      ["upper-deck-tim-hortons-collector's-series", "upper-deck-tim-hortons-collectors-series"],
      ["player's-collection-signatures", "players-collection-signatures"],
      ["ecklar's-choice-signatures", "ecklars-choice-signatures"],
      ["red,-white-&-blue-gems", "red-white-blue-gems"],
      ["in-the-name-(series-2)", "in-the-name-series-2"],
      ["lfg!-autographs", "lfg-autographs"],
    ];
    for (const [dirty, clean] of cases) {
      expect(slugify(dirty), dirty).toBe(clean);
      expect(isSlug(slugify(dirty)), dirty).toBe(true);
    }
  });

  it("normalizeSetKey output is always a slug", () => {
    for (const s of ["Bowman's Best", "LFG!", "1,000 Yard Club", "bbm-", "Topps Allen & Ginter"]) {
      expect(isSlug(normalizeSetKey(s)), s).toBe(true);
    }
  });
});
