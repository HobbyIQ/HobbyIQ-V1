/**
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME (2026-09-19; EXTENDED by RULING
 * R72, owner, 2026-09-19).
 *
 * repair-rc-marker-playername.cjs's pure planRepair: which stored rows are
 * repaired, and which are correctly left alone, across every marker family
 * MODE now selects (default 'rc' -- unchanged behaviour when MODE is unset).
 * The lane's write behaviour (patchCatalogRowFields args, scope refusal,
 * reconcile, the variant-review listing) is pinned separately in
 * repairRcMarkerPlayerNameLane.test.ts against a stub Cosmos.
 */
import { describe, expect, it } from "vitest";
import { cleanPlayerName, CARD_VARIANT_MARKERS } from "../src/services/portfolioiq/cardCatalog.service";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { rebuildSearchFields } from "../src/services/catalog/catalogRowOps.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planRepair, candidateSpec, INHERITED_SCOPES, CELL_RE, MARKER_FAMILIES } = require("../scripts/repair-rc-marker-playername.cjs");

const deps = { cleanPlayerName, slugify, rebuildSearchFields, CARD_VARIANT_MARKERS };

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: "hiq:baseball:2026:topps:1:base:no-auto",
  cardId: "hiq:baseball:2026:topps:1:base:no-auto",
  hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto",
  sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", setName: "2026 Topps",
  cardNumber: "1", parallel: "Base", parallelSlug: "base", printRun: null, subsetName: null,
  playerName: "Jonah Tong RC", playerSlug: "jonah-tong-rc",
  source: "baseballcardpedia", searchTokens: ["2026", "topps", "1"],
  ...over,
});

describe("planRepair -- the RC row is repaired (default family, mode=rc)", () => {
  it("cleans the name, recomputes the slug, and rebuilds search fields", () => {
    const plan = planRepair(baseRow(), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("repair");
    expect(plan.before).toBe("Jonah Tong RC");
    expect(plan.after).toBe("Jonah Tong");
    expect(plan.playerSlug).toBe("jonah-tong");
    expect(plan.patch.playerName).toBe("Jonah Tong");
    expect(plan.patch.playerSlug).toBe("jonah-tong");
    expect(typeof plan.patch.searchText).toBe("string");
    expect(typeof plan.patch.displayName).toBe("string");
    expect(Array.isArray(plan.patch.searchTokens)).toBe(true);
    // RC/RR/DP/TC/tier-rc never carry the variant-review flag.
    expect(plan.variant).toBe(false);
  });

  it("never proposes a patch to id / cardId / hobbyiqCardId", () => {
    const plan = planRepair(baseRow(), deps, MARKER_FAMILIES.rc);
    expect(plan.patch).not.toHaveProperty("id");
    expect(plan.patch).not.toHaveProperty("cardId");
    expect(plan.patch).not.toHaveProperty("hobbyiqCardId");
  });

  it("unions existing search tokens with the rebuilt set -- a graded row keeps its grade tokens", () => {
    const plan = planRepair(baseRow({ gradeTier: "psa-10", searchTokens: ["2026", "topps", "1", "psa-10"] }), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("repair");
    expect(plan.graded).toBe(true);
    expect(plan.patch.searchTokens).toEqual(expect.arrayContaining(["psa-10"]));
  });

  it("handles the RC* and (RC) shapes too", () => {
    for (const [name, slug] of [
      ["Jonah Tong RC*", "jonah-tong"],
      ["Jonah Tong (RC)", "jonah-tong"],
    ]) {
      const plan = planRepair(baseRow({ playerName: name, playerSlug: `${slug}-rc` }), deps, MARKER_FAMILIES.rc);
      expect(plan.action).toBe("repair");
      expect(plan.after).toBe("Jonah Tong");
      expect(plan.playerSlug).toBe("jonah-tong");
    }
  });

  it("the default family (no explicit family arg) is 'rc' -- matches module-level FAMILY when MODE is unset", () => {
    const plan = planRepair(baseRow(), deps);
    expect(plan.action).toBe("repair");
    expect(plan.after).toBe("Jonah Tong");
  });
});

describe("planRepair -- what it correctly skips, mode=rc", () => {
  it("skips a clean row -- cleanPlayerName makes no change", () => {
    const plan = planRepair(baseRow({ playerName: "Mike Trout", playerSlug: "mike-trout" }), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("skip");
    expect(plan.reason).toMatch(/no change/);
  });

  it("skips a row whose playerName is null or empty", () => {
    for (const v of [null, "", "   "]) {
      const plan = planRepair(baseRow({ playerName: v }), deps, MARKER_FAMILIES.rc);
      expect(plan.action).toBe("skip");
    }
  });

  it("skips a row whose playerSlug already matches the cleaned name (stale -rc slug already healed)", () => {
    const plan = planRepair(baseRow({ playerName: "Jonah Tong", playerSlug: "jonah-tong" }), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("skip");
  });
});

describe("R72 -- every non-rc marker family repairs its own shape, and ONLY its own shape", () => {
  const cases: Array<[string, string, string, string]> = [
    // [mode, playerName, expectedAfter, slugEnding-before-clean]
    ["rr", "Al Leiter RR", "Al Leiter", "-rr"],
    ["dp", "Luis De Los Santos DP", "Luis De Los Santos", "-dp"],
    ["tc", "New York Yankees TC", "New York Yankees", "-tc"],
    ["uer", "Mike Trout UER", "Mike Trout", "-uer"],
    ["sp", "Jonah Tong SP", "Jonah Tong", "-sp"],
    ["ssp", "Jonah Tong SSP", "Jonah Tong", "-ssp"],
  ];
  it.each(cases)("mode=%s repairs %j -> %j", (mode, name, after) => {
    const family = MARKER_FAMILIES[mode];
    const plan = planRepair(baseRow({ playerName: name, playerSlug: slugify(name) }), deps, family);
    expect(plan.action).toBe("repair");
    expect(plan.after).toBe(after);
    // sp/ssp/uer are flagged for review; rr/dp/tc are not.
    expect(plan.variant).toBe(family.variant === true);
  });

  it("mode=tier-rc repairs the tier-letter-before-RC shape", () => {
    const family = MARKER_FAMILIES["tier-rc"];
    const plan = planRepair(baseRow({ playerName: "Rich Hunter B RC", playerSlug: "rich-hunter-b-rc" }), deps, family);
    expect(plan.action).toBe("repair");
    expect(plan.after).toBe("Rich Hunter");
    expect(plan.variant).toBe(false);
  });

  it("a family's own repair is independent of which family the caller asked for -- an rr row under mode=rc still cleans (cleanPlayerName strips both), but the SCAN would never have found it", () => {
    // This documents the two-gate design: candidateSpec is the COARSE filter
    // (which rows are even candidates for THIS dispatch), planRepair/
    // cleanPlayerName is the FINE gate that decides whether a candidate
    // actually changes. A row that slipped through under the wrong scan
    // (should not happen in real Cosmos, since ENDSWITH would exclude it)
    // still gets the correct treatment because cleanPlayerName's own scope
    // is the single source of truth, never re-declared per family here.
    const plan = planRepair(baseRow({ playerName: "Al Leiter RR", playerSlug: "al-leiter-rr" }), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("repair");
    expect(plan.after).toBe("Al Leiter");
  });

  it("the variant flag is defense-in-depth: an SP row is flagged even under a NON-variant family's dispatch", () => {
    // family.variant answers "was this RUN scoped for a variant family";
    // CARD_VARIANT_MARKERS.test(before) answers "does this ROW actually
    // carry one, independent of the dispatch". planRepair ORs them so a
    // stray SP/SSP/UER row that reaches planRepair under the wrong family
    // (should not happen via a real Cosmos ENDSWITH scan, but the review
    // flag must not depend on that) still gets listed rather than silently
    // patched like an ordinary rc/rr/dp/tc row.
    const plan = planRepair(baseRow({ playerName: "Jonah Tong SP", playerSlug: "jonah-tong-sp" }), deps, MARKER_FAMILIES.rc);
    expect(plan.action).toBe("repair");
    expect(plan.after).toBe("Jonah Tong");
    expect(plan.variant).toBe(true);
  });
});

describe("R72 -- a real name that coincidentally slugifies to a marker ending is untouched", () => {
  it("a -tc slug whose name does not end in the literal ' TC' token is skipped", () => {
    // playerSlugify lowercases and hyphenates; a hypothetical surname ending
    // "...Tc" some other way would still need the exact uppercase whitespace-
    // separated token to match cleanPlayerName. Constructed name: ends in
    // lowercase 'tc' shape, not the marker.
    const plan = planRepair(baseRow({ playerName: "Marco Tc", playerSlug: "marco-tc" }), deps, MARKER_FAMILIES.tc);
    // "Marco Tc" -- mixed case "Tc" is not the marker (case-sensitive), so
    // cleanPlayerName makes no change and planRepair skips it.
    expect(plan.action).toBe("skip");
  });

  it("a -sp slug whose name does not carry the SP token is skipped -- the scan predicate is only a candidate filter", () => {
    const plan = planRepair(baseRow({ playerName: "Warren Spahn", playerSlug: "warren-spahn" }), deps, MARKER_FAMILIES.sp);
    expect(plan.action).toBe("skip");
  });
});

describe("candidateSpec -- the query never runs a cross-partition COUNT/GROUP BY", () => {
  it("filters by sport/year equality and ENDSWITH on playerSlug, default family rc", () => {
    const spec = candidateSpec("baseball", 2026, [], MARKER_FAMILIES.rc);
    expect(spec.query).toMatch(/c\.sport = @sport/);
    expect(spec.query).toMatch(/ENDSWITH\(c\.playerSlug, @end0\)/);
    expect(spec.parameters.some((p: any) => p.name === "@end0" && p.value === "-rc")).toBe(true);
    expect(spec.query).not.toMatch(/COUNT\(1\)/);
    expect(spec.query).not.toMatch(/GROUP BY/i);
  });

  it("adds an optional setKey filter without loosening the required axes", () => {
    const spec = candidateSpec("baseball", 2026, ["topps", "topps-chrome"], MARKER_FAMILIES.rc);
    expect(spec.query).toMatch(/c\.setKey = @sk0 OR c\.setKey = @sk1/);
    expect(spec.parameters.some((p: any) => p.name === "@sk0" && p.value === "topps")).toBe(true);
  });

  it("mode=tier-rc ORs all three tier-letter endings together", () => {
    const spec = candidateSpec("baseball", 1996, [], MARKER_FAMILIES["tier-rc"]);
    expect(spec.query).toMatch(/ENDSWITH\(c\.playerSlug, @end0\) OR ENDSWITH\(c\.playerSlug, @end1\) OR ENDSWITH\(c\.playerSlug, @end2\)/);
    const values = spec.parameters.filter((p: any) => p.name.startsWith("@end")).map((p: any) => p.value);
    expect(values.sort()).toEqual(["-b-rc", "-g-rc", "-s-rc"]);
  });

  it("mode=sp excludes -ssp so the two dispatches partition rather than overlap", () => {
    const spec = candidateSpec("baseball", 2026, [], MARKER_FAMILIES.sp);
    expect(spec.query).toMatch(/ENDSWITH\(c\.playerSlug, @end0\)/);
    expect(spec.query).toMatch(/AND NOT ENDSWITH\(c\.playerSlug, @exend0\)/);
    expect(spec.parameters.some((p: any) => p.name === "@exend0" && p.value === "-ssp")).toBe(true);
  });

  it("mode=ssp carries no exclusion -- it is the narrower family", () => {
    const spec = candidateSpec("baseball", 2026, [], MARKER_FAMILIES.ssp);
    expect(spec.query).not.toMatch(/NOT ENDSWITH/);
  });
});

describe("MARKER_FAMILIES -- the mapping documented in the script header", () => {
  it("covers every marker R72 rules on, plus the pre-existing rc family", () => {
    expect(Object.keys(MARKER_FAMILIES).sort()).toEqual(
      ["dp", "rc", "rr", "sp", "ssp", "tc", "tier-rc", "uer"].sort(),
    );
  });

  it("only sp/ssp/uer are flagged as able to name a different card", () => {
    for (const [mode, family] of Object.entries(MARKER_FAMILIES) as any) {
      const expected = ["sp", "ssp", "uer"].includes(mode);
      expect(family.variant, `${mode}.variant`).toBe(expected);
    }
  });
});

describe("the scope constants match the sibling lanes' convention", () => {
  it("rejects the runner's inherited defaults", () => {
    expect(INHERITED_SCOPES.has("")).toBe(true);
    expect(INHERITED_SCOPES.has("refractor")).toBe(true);
    expect(INHERITED_SCOPES.has("all")).toBe(true);
  });

  it("a cell is sport:year, lowercase, four-digit year", () => {
    expect(CELL_RE.test("baseball:2026")).toBe(true);
    expect(CELL_RE.test("Baseball:2026")).toBe(false);
    expect(CELL_RE.test("baseball:26")).toBe(false);
    expect(CELL_RE.test("baseball:2026:topps")).toBe(false);
  });
});
