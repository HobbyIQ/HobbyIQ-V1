/**
 * CF-THE-CATEGORY-PREFIX-IS-THE-SOURCE-SPEAKING (Drew, 2026-09-18).
 *
 * `readChecklistCategory` is the ONE reader of the checklist CSV's `category`
 * column, shared by the corpus builder and the ingester. Two readers of the
 * same column that disagree is two different answers to "what card is this".
 *
 * THE DEFECT. Several sources label the BASE ladder with `insert-` categories
 * and put the variant ONLY in the category slug, leaving the parallel column
 * blank — so every row reads as "card 1, no parallel" and they collapse onto
 * one identity. Measured on 2024 panini-zenith football: 485 ids claimed by
 * several rows; 5,338 distinct ids for 6,214 rows.
 *
 * Every fixture below is a REAL row from the committed source CSVs.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readChecklistCategory, identityFieldsFromCategory, insertSetsFromCategories,
  disambiguateSiblingCategories } =
  require_(path.join(backend, "scripts", "lib", "checklist-category.cjs"));

/** One product's real rows, from a COMMITTED fixture.
 *
 * The rows are the category+parallel columns of the real source CSV, extracted
 * verbatim. Committed rather than read from C:/tmp/ci/csv2 because CI has no
 * scratch dir -- a test that needs an uncommitted absolute path is a test that
 * passes only on the machine that wrote it (#2189).
 */
function realRows(file: string): Array<{ category: string; parallel: string }> {
  const fs = require_("node:fs") as typeof import("node:fs");
  const raw = fs.readFileSync(
    path.join(backend, "tests", "fixtures", "checklist-category", file), "utf8");
  return JSON.parse(raw).rows as Array<{ category: string; parallel: string }>;
}

describe("(a) insert-base* is the BASE card, and the tail is the parallel", () => {
  it.each([
    // Real 2024 panini-zenith football categories. Parallel column is BLANK on
    // every one — the variant exists only in the slug.
    ["insert-base-hobby", "Hobby"],
    ["insert-base-retail", "Retail"],
    ["insert-base-1st-down", "1st Down"],
    ["insert-base-no-huddle", "No Huddle"],
    ["insert-base-two-minute-drill", "Two Minute Drill"],
    ["insert-base-red-zone-blue", "Red Zone Blue"],
  ])("%s -> parallel %s, base card, not an insert", (category, expected) => {
    const r = readChecklistCategory(category, "");
    expect(r.kind).toBe("base");
    expect(r.parallel).toBe(expected);
    expect(r.isAuto).toBe(false);
    // The critical half: there is no insert set called "Base".
    expect(r.insertRoot).toBeNull();
  });

  it("bare `insert-base` is the plain base card with no rung", () => {
    const r = readChecklistCategory("insert-base", "");
    expect(r.kind).toBe("base");
    expect(r.parallel).toBeNull();
    expect(r.insertRoot).toBeNull();
  });

  it("a plain `base` category still works — this widens, it does not move", () => {
    expect(readChecklistCategory("base", "Gold")).toMatchObject({ kind: "base", parallel: "Gold", isAuto: false });
    expect(readChecklistCategory("base-refractor", "")).toMatchObject({ kind: "base", parallel: "Refractor" });
  });
});

describe("(b) auto-base* is the same card, signed — because the SOURCE said so", () => {
  it.each([
    ["auto-base-autographs-no-huddle", "Autographs No Huddle"],
    ["auto-base-red-zone-autographs", "Red Zone Autographs"],
    ["auto-base-red-zone-autographs-gold", "Red Zone Autographs Gold"],
  ])("%s -> isAuto true", (category, expected) => {
    const r = readChecklistCategory(category, "");
    expect(r.kind).toBe("auto");
    expect(r.isAuto).toBe(true);
    expect(r.parallel).toBe(expected);
  });

  it("isAuto comes from the PREFIX, never from the words in a name", () => {
    // The attestation is the source's own section heading. A parallel string
    // that merely CONTAINS "autograph" under a non-auto prefix must not flip
    // isAuto — CF-ISAUTO-BOUNDARY-IS-CARDNUMBER-NOT-TEXT still holds.
    expect(readChecklistCategory("insert-base-hobby", "Rookie Autographs").isAuto).toBe(false);
    expect(readChecklistCategory("base", "Autograph Gold").isAuto).toBe(false);
    expect(readChecklistCategory("insert-signature-series", "Signatures").isAuto).toBe(false);
  });
});

describe("(c) a registered TIER is a product, not a rung", () => {
  it.each([
    ["insert-base-club-level", "club-level"],
    ["insert-base-concourse", "concourse"],
    ["insert-base-premier-level", "premier-level"],
  ])("%s -> tierKey %s", (category, tier) => {
    const r = readChecklistCategory(category, "");
    expect(r.tierKey).toBe(tier);
    expect(r.kind).toBe("base");
  });

  it("the tier is stripped and the REST stays the parallel", () => {
    // Real 2024 panini-select football category.
    const r = readChecklistCategory("insert-base-club-level-black-and-blue-prizm-shock", "");
    expect(r.tierKey).toBe("club-level");
    expect(r.parallel).toBe("Black And Blue Prizm Shock");
  });

  it("a non-tier variant reports no tierKey", () => {
    expect(readChecklistCategory("insert-base-hobby", "").tierKey).toBeNull();
  });
});

describe("(c-dedupe) the same card described twice converges on ONE answer", () => {
  it("Photogenic writes the colour in BOTH places; Zenith only in the category", () => {
    // 2024 panini-photogenic football lists card 1 Black twice:
    //   base,1,Black,,,             <- colour in the parallel column
    //   insert-base-black,1,Black,, <- colour in BOTH
    // and 2024 panini-zenith writes it only in the slug. All three must give
    // the same (parallel, isAuto) so a de-dupe is an exact match rather than a
    // refusal.
    const fromBase = readChecklistCategory("base", "Black");
    const fromInsertBase = readChecklistCategory("insert-base-black", "Black");
    const fromSlugOnly = readChecklistCategory("insert-base-black", "");
    for (const r of [fromBase, fromInsertBase, fromSlugOnly]) {
      expect(r.parallel).toBe("Black");
      expect(r.isAuto).toBe(false);
      expect(r.kind).toBe("base");
    }
  });

  it("the row's OWN parallel text wins when it has one", () => {
    // The stated spelling is the manufacturer's; the slug is a derivation of
    // it. Where they differ, prefer what the source wrote in the field.
    expect(readChecklistCategory("insert-base-red-zone-blue", "Red Zone Blue Prizm").parallel)
      .toBe("Red Zone Blue Prizm");
  });
});

describe("a genuine insert set still reads as one", () => {
  it.each([
    ["insert-z-marquee", "z-marquee"],
    ["insert-illusionists", "illusionists"],
    ["insert-troops-tribute", "troops-tribute"],
  ])("%s -> insertRoot %s", (category, root) => {
    const r = readChecklistCategory(category, "");
    expect(r.kind).toBe("insert");
    expect(r.insertRoot).toBe(root);
  });

  it("NEVER invents a root by stripping the row's parallel out of the slug", () => {
    // MEASURED AND REVERTED (2026-09-18): `insert-prizm-gold` + "Prizm Gold"
    // leaves `prizm`, and 2025 panini-prizm football lost 73 real base rungs
    // to an invented insert set called "Prizm". The root is the tail, whole.
    const r = readChecklistCategory("insert-prizm-gold", "Prizm Gold");
    expect(r.insertRoot).toBe("prizm-gold");
    expect(r.insertRoot).not.toBe("prizm");
  });
});

describe("identityFieldsFromCategory — what a caller building an id needs", () => {
  it("names the base card, its rung and its auto flag in one call", () => {
    expect(identityFieldsFromCategory("insert-base-hobby", "")).toEqual({
      parallel: "Hobby", isAuto: false, tierKey: null, isBaseCard: true,
    });
    expect(identityFieldsFromCategory("auto-base-red-zone-autographs", "")).toEqual({
      parallel: "Red Zone Autographs", isAuto: true, tierKey: null, isBaseCard: true,
    });
    expect(identityFieldsFromCategory("insert-z-marquee", "")).toMatchObject({ isBaseCard: false });
  });

  it("THE COLLAPSE THIS ENDS: five Zenith categories, five distinct rungs", () => {
    // Read naively all five are "card 1, no parallel" and collapse onto one
    // id. This is the 485-collision measurement, in one assertion.
    const cats = [
      "insert-base-hobby", "insert-base-retail", "insert-base-no-huddle",
      "insert-base-two-minute-drill", "auto-base-autographs-no-huddle",
    ];
    const keys = cats.map((c) => {
      const f = identityFieldsFromCategory(c, "");
      return `${f.parallel ?? "(base)"}|${f.isAuto}`;
    });
    expect(new Set(keys).size).toBe(5);
  });
});

describe("registered TIERS vs Zenith's variant-as-parallel — both, correctly", () => {
  it("Select FB tiers hold DISJOINT number ranges, so they are products", () => {
    // Measured on 2024 panini-select football: concourse #1-100, club-level
    // #201-300, suite-level #301-400. Disjoint ranges are the proof these are
    // separate products rather than parallels of one card.
    expect(readChecklistCategory("insert-base-concourse", "")).toMatchObject({
      kind: "base", tierKey: "concourse", tierIsRegistered: true, parallel: null,
    });
    expect(readChecklistCategory("insert-base-club-level", "")).toMatchObject({
      tierKey: "club-level", tierIsRegistered: true,
    });
  });

  it("suite-level is a REAL tier the registry lacks — named, and flagged", () => {
    // Reported for acquisition rather than invented: `panini-select-suite-level`
    // is not in productSetKeys. The helper still must not file "Suite Level" as
    // a PARALLEL of the flagship, which is the wrong of the two answers, so it
    // reports the tier AND that it is unresolvable.
    const r = readChecklistCategory("insert-base-suite-level", "");
    expect(r.tierKey).toBe("suite-level");
    expect(r.tierIsRegistered).toBe(false);
    expect(r.parallel).toBeNull();
  });

  it("Zenith's insert-base variants REUSE #1-100 and are parallels, not tiers", () => {
    // The mirror case: same players, same numbers, different printing. A
    // variant that is not a registered tier is a rung of the base card.
    const r = readChecklistCategory("insert-base-1st-down", "");
    expect(r.tierKey).toBeNull();
    expect(r.parallel).toBe("1st Down");
    expect(r.kind).toBe("base");
  });
});

describe("insertSetsFromCategories — the root the parallel column omits", () => {
  it("derives Zenith's 18 insert sets from its own categories", () => {
    const sets = insertSetsFromCategories(realRows("zenith-2024-fb-categories.json"));
    const roots = sets.map((s: { root: string }) => s.root);
    expect(roots).toContain("Z Marquee");
    expect(roots).toContain("Idols");
    expect(roots).toContain("Chalk Talk");
    // A multi-word root is kept WHOLE -- "Color Guard" is one set, not
    // `color` + guard. This is the clause that keeps this from being the strip
    // rule that lost 73 real Prizm rungs.
    expect(roots).toContain("Color Guard");
    const zm = sets.find((s: { root: string }) => s.root === "Z Marquee");
    expect(zm.children).toEqual([
      "Z Marquee Blue", "Z Marquee Gold", "Z Marquee Orange",
      "Z Marquee Red", "Z Marquee White",
    ]);
  });

  it("admits a child only when the SIBLING attests its own parallel text", () => {
    // A bare root with no attested children yields nothing -- there is no
    // evidence of a ladder, and inventing one is the defect.
    expect(insertSetsFromCategories([{ category: "insert-lonely", parallel: "" }])).toEqual([]);
  });
});

describe("disambiguateSiblingCategories — when the column cannot tell them apart", () => {
  const resolved = () => disambiguateSiblingCategories(realRows("zenith-2024-fb-categories.json"));

  it("resolves a real colour collision the parallel column leaves blank", () => {
    const m = resolved();
    expect(m.get("insert-zoom-blue")).toBe("Blue");
    expect(m.get("insert-zoom-red")).toBe("Red");
  });

  it("REFUSES the Variation group, because `green` is not attested on this product", () => {
    // THE MEASURED LIMIT, recorded rather than worked around. Zenith's
    // `...variation-rps-preview-{blue,red,green}` all carry #10 at /24, with the
    // column reading "Variation" for blue and red and blank for green -- so blue
    // #10 and red #10 mint the identical id (25 collisions).
    //
    // Clause 3 refuses the group: `green` never appears as a standalone parallel
    // anywhere in this product's file, so promoting the tails would be
    // inventing one. Absent beats wrong -- the ingester refuses these rows
    // visibly, which is recoverable, while a guessed colour is not.
    const m = resolved();
    for (const c of [
      "insert-contenders-optic-rookie-ticket-variation-rps-preview-blue",
      "insert-contenders-optic-rookie-ticket-variation-rps-preview-red",
      "insert-contenders-optic-rookie-ticket-variation-rps-preview-green",
    ]) expect(m.has(c)).toBe(false);
  });

  it("leaves a column that ALREADY distinguishes siblings alone", () => {
    const m = disambiguateSiblingCategories([
      { category: "insert-x-blue", parallel: "Blue" },
      { category: "insert-x-red", parallel: "Red" },
    ]);
    expect(m.size).toBe(0);
  });

  it("never answers for a BASE-like category — readChecklistCategory owns those", () => {
    // `insert-base-red-zone-blue` must read "Red Zone Blue" (the whole variant),
    // not "Blue". Two answers for one row is the drift this module prevents.
    const m = resolved();
    expect(m.has("insert-base-red-zone-blue")).toBe(false);
    expect(readChecklistCategory("insert-base-red-zone-blue", "").parallel).toBe("Red Zone Blue");
  });
});

describe("a tier name the NUMBERS contradict is a conflict, not a correction", () => {
  // MEASURED on 2024-25 panini-select basketball:
  //
  //   insert-base-set-concourse                       #1-100    (#1 Holmgren)
  //   insert-base-set-premier-level                   #101-200
  //   insert-base-set-courtside                       #201-300
  //   insert-base-set-courtside-green-tectonic-prizms #1-100    (#1 Holmgren)
  //
  // The last carries COURTSIDE's name over CONCOURSE's roster and range. Its
  // parallel column is blank, so it collapses to plain `base` and collides on
  // 100 ids.
  const RANGES = { concourse: [1, 100], "premier-level": [101, 200], courtside: [201, 300] };

  it("reports the contradiction and names what the range says instead", () => {
    const r = readChecklistCategory(
      "insert-base-set-courtside-green-tectonic-prizms", "",
      { tierRanges: RANGES, cardNumber: 1 },
    );
    expect(r.conflict).toMatchObject({
      reason: "tier-name-contradicts-card-number",
      statedTier: "courtside",
      cardNumber: 1,
      rangeSays: "concourse",
    });
  });

  it("does NOT re-assign the card — one observed row is not a rule", () => {
    // Swept all 1,236 tier-suffixed categories in every Select file: this is
    // the ONLY one whose numbers contradict its tier name. Auto-correcting on
    // a single case would be re-filing a card to a DIFFERENT PRODUCT on an
    // inference, which is the expensive direction to be wrong in. The caller
    // refuses the category by name instead.
    const r = readChecklistCategory(
      "insert-base-set-courtside-green-tectonic-prizms", "",
      { tierRanges: RANGES, cardNumber: 1 },
    );
    expect(r.tierKey, "the STATED tier is reported unchanged").toBe("courtside");
  });

  it("a legitimate tier row in its own range reports no conflict", () => {
    const r = readChecklistCategory("insert-base-set-courtside", "", { tierRanges: RANGES, cardNumber: 250 });
    expect(r.tierKey).toBe("courtside");
    expect(r.conflict).toBeNull();
  });

  it("tierRanges is OPTIONAL — a caller that cannot supply it gets today's answer", () => {
    // The corpus builder reads names, not numbers. It must be no worse off.
    const r = readChecklistCategory("insert-base-set-courtside-green-tectonic-prizms", "");
    expect(r.conflict).toBeNull();
    expect(r.tierKey).toBe("courtside");
  });

  it("`insert-base-set-<x>` is the same as `insert-base-<x>` — 113 files spell it so", () => {
    // 167,474 rows carry the extra `set-` segment. Without handling it the
    // tier match fails on every one, filing "Set Courtside" as a PARALLEL of
    // the flagship instead of naming the Courtside product.
    expect(readChecklistCategory("insert-base-set-concourse", "").tierKey).toBe("concourse");
    expect(readChecklistCategory("insert-base-concourse", "").tierKey).toBe("concourse");
    expect(readChecklistCategory("insert-base-set-all-stars", "").parallel).toBe("All Stars");
  });

  it("courtside is a real tier the registry lacks — named and flagged", () => {
    // Same shape as suite-level. ACQUISITION: `panini-select-courtside`.
    const r = readChecklistCategory("insert-base-set-courtside", "");
    expect(r.tierKey).toBe("courtside");
    expect(r.tierIsRegistered).toBe(false);
  });
});
