// R71 (owner, 2026-09-19): THE REST OF SELECT'S TIERS, SAME RULING AS R53(ii)
// (#2231) and R67 -- a named Select tier is its own card set, registered per
// SPORT and per YEAR against what the committed checklist data actually
// shows, never assumed from the ruling's own guessed tier names.
//
// EVIDENCE (backend/data/checklists/**, backend/data/checklist-parallel-
// names.json):
//
//   football 2024 (checklistinsider, confidence 0.9, 27,324 rows; manifest
//   provenance literally names "the Concourse/Club Level/Suite Level/
//   Premier Level/Field Level tiers"): five disjoint 100-card blocks,
//   #1-100 / #101-200 / #201-300 / #301-400 / #401-500, zero shared numbers.
//   Concourse/Premier Level/Field Level were already registered by #2231;
//   this file pins the two more that product's own checklist also carries.
//
//   football 2018 (sportscardchecklist, 300 rows): Concourse/Premier Level/
//   Field Level only, #1-100/101-200/201-300 -- Club Level and Suite Level
//   did not exist as tiers yet. Confirms the #2231 three, independently.
//
//   basketball 2024 (hobbymonitor, 25,999 rows, insert-base-* categories
//   authoritative): FOUR disjoint 100-card tiers, #1-100/101-200/201-300/
//   301-400 -- Concourse / Premier Level / Courtside / Mezzanine Level. NOT
//   the three this ruling's own text guessed ("Concourse / Premier Level /
//   Courtside" -- Mezzanine Level is real and was missing from the guess).
//
//   basketball WNBA 2024/2025 (checklist-parallel-names.json): "Courtside"
//   also appears there, but as a named INSERT SET
//   (insertSets[].categories: ["insert-courtside"]), never as a base-card
//   tier -- it does not partition WNBA's numbering. NOT registered for WNBA.
//
//   soccer Select FIFA: `panini-select-fifa` is real and checklist-backed
//   (25 colour parallels / 7,006 seen in 2023; 34 / 9,708 in 2024) but had
//   NO registration at all before this PR, and no committed source names a
//   FIFA TIER (Terrace, Mezzanine, ...) anywhere searched. Registers the
//   bare product only -- no invented tier children.
import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf, productEntry } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const NEW_TIERS = [
  "panini-select-club-level",
  "panini-select-suite-level",
  "panini-select-courtside",
  "panini-select-mezzanine-level",
];
const NEW_KEYS = [...NEW_TIERS, "panini-select-fifa"];
const PRIOR_TIERS_2231 = [
  "panini-select-concourse",
  "panini-select-premier-level",
  "panini-select-field-level",
];

describe("R71: the rest of Select's tiers, plus panini-select-fifa", () => {
  it("registers every new key", () => {
    expect(NEW_KEYS.filter((k) => !isProductSetKey(k))).toEqual([]);
  });

  it("every new key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = NEW_KEYS
      .filter((k) => normalizeSetKey(k) !== k)
      .map((k) => `${k} -> ${normalizeSetKey(k)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under Select so the matcher can still widen", () => {
    for (const k of NEW_KEYS) {
      expect(productParentOf(k), `${k} parent`).toBe("panini-select");
      expect(productFamilyOf(k), `${k} family`).toBe("panini-select");
    }
  });

  it("the four new tiers are `spelled` -- reachable from a real title, not just their own bare slug", () => {
    // A P() entry only survives normalizeSetKey when the input IS its own
    // slug already (the identity fallback). A real title has other words in
    // it, so being a bare-slug fixed point proves nothing on its own -- this
    // is the gap #2231's own comment named ("registering the keys is NOT
    // enough on its own"). Each of these titles carries a tier word AND
    // other words, the way a real sale title does.
    expect(normalizeSetKey("2024 Panini Select Club Level #215 Some Player")).toBe("panini-select-club-level");
    expect(normalizeSetKey("2024 Panini Select Suite Level #350 Some Player")).toBe("panini-select-suite-level");
    expect(normalizeSetKey("2024 Panini Select Courtside #250 Some Player")).toBe("panini-select-courtside");
    expect(normalizeSetKey("2024 Panini Select Mezzanine Level #350 Some Player")).toBe("panini-select-mezzanine-level");
    // Sanity: each is genuinely `spelled` in the table, which is the
    // mechanism that makes the line above true (productSetKeyForName only
    // reads spelled names).
    for (const k of NEW_TIERS) {
      expect(productEntry(k)?.spelled, `${k} spelled`).toBe(true);
    }
  });

  it("panini-select-fifa is reachable from a real FIFA title, not just its own bare slug", () => {
    expect(normalizeSetKey("2023-24 Panini Select FIFA #124 Some Player")).toBe("panini-select-fifa");
    expect(productEntry("panini-select-fifa")?.spelled).toBe(true);
  });

  it("no data names a FIFA tier -- a tier word in a FIFA title does not mint one, and the row still lands on the real product", () => {
    // This is the open item the PR reports rather than solves: the tier word
    // is silently dropped because no `panini-select-fifa-mezzanine`-shaped key
    // exists (none is backed by committed data). Landing on the bare FIFA
    // product is correct; landing on plain `panini-select` would not be.
    expect(normalizeSetKey("2023-24 Panini Select FIFA Mezzanine #124 Some Player")).toBe("panini-select-fifa");
    expect(isProductSetKey("panini-select-fifa-mezzanine")).toBe(false);
    expect(isProductSetKey("panini-select-fifa-terrace")).toBe(false);
  });

  it("WNBA's Courtside insert set is NOT registered as a tier key", () => {
    // Courtside is a real WNBA insert-set name (checklist-parallel-names.json,
    // panini-select-wnba 2024/2025), but it does not partition WNBA's own
    // numbering the way it partitions the flagship basketball product, so it
    // gets no `panini-select-wnba-courtside` key here.
    expect(isProductSetKey("panini-select-wnba-courtside")).toBe(false);
  });

  it("a title with NO tier word stays on the bare, untiered panini-select", () => {
    expect(normalizeSetKey("2024 Panini Select #1 Some Player")).toBe("panini-select");
  });

  it("leaves the #2231 tiers, the bare product, and its neighbours untouched", () => {
    for (const k of PRIOR_TIERS_2231) {
      expect(isProductSetKey(k), `${k} still registered`).toBe(true);
      expect(normalizeSetKey(k), `${k} still a fixed point`).toBe(k);
    }
    expect(normalizeSetKey("panini-select")).toBe("panini-select");
    expect(isProductSetKey("panini-select")).toBe(true);
    // select-certified was measured DISTINCT in a prior lane and must not be
    // swept in here by anything this PR touches.
    expect(normalizeSetKey("select-certified")).toBe("select-certified");
  });

  it("is a specialisation, not a hole — an unregistered Select key still collapses", () => {
    expect(isProductSetKey("panini-select-nonesuch")).toBe(false);
    expect(normalizeSetKey("panini-select-nonesuch")).toBe("panini-select");
  });

  it("a title naming two tiers resolves to A REGISTERED TIER, deterministically, never to the untiered product", () => {
    // Not a real Select title shape -- a physical card belongs to exactly one
    // tier -- so this pins the boundary rather than a case Select actually
    // prints. Measured behaviour of productSetKeyForName's run-match: the
    // LEFTMOST tier phrase in the slug wins, deterministically, on both
    // orderings. What matters for this ruling is that it never silently
    // falls back to the bare, untiered `panini-select` -- a two-tier title is
    // unusual, but it still names a tiered card, and landing on `panini-
    // select` would look like an untiered row when it never was one.
    const clubFirst = normalizeSetKey("2024 Panini Select Club Level Suite Level #1 Some Player");
    const suiteFirst = normalizeSetKey("2024 Panini Select Suite Level Club Level #1 Some Player");
    expect(clubFirst).toBe("panini-select-club-level");
    expect(suiteFirst).toBe("panini-select-suite-level");
    expect([clubFirst, suiteFirst]).not.toContain("panini-select");
  });
});
