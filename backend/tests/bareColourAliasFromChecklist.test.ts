/**
 * CF-A-BARE-COLOUR-IS-WHATEVER-ITS-OWN-CHECKLIST-SAYS (2026-09-13).
 *
 * Round-2 parallel-semantics rulings (2026-09-13) found `dropped:parallel` is
 * ~10% of all non-Pokemon pool rows, and 448 of 450 sampled rows are the same
 * shape: a title states a bare colour word ("2025 Donruss Elite Football #9
 * Green"), the stored `parallel` field already carries that word, and
 * `extractParallel` still answers "Base" because the 2026-09-03 bare-colour
 * ruling's per-product allowlist was hand-built and never reached
 * `donruss-elite`, `panini-certified`, `panini-prizm-draft-picks`,
 * `topps-signature-class` and the rest of the 2024-2025 football slate.
 *
 * EVERY TITLE IN THIS FILE IS A REAL ROW, drawn read-only from the
 * census-partial CONFLICT samples (slots 1, 3, 4; the same read-only artifact
 * the round-2 rulings doc cites) on 2026-09-13. `stored` is that sample's own
 * `parallel` field.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import {
  bareColourAliasFromChecklist,
  _resetBareColourAliasMap,
  _bareColourAliasMapForTest,
} from "../src/services/portfolioiq/bareColourAliasFromChecklist";

const parallelOf = (title: string, ctx?: { year?: number | null; setKey?: string | null }): string =>
  parseListingIdentity(title, undefined, ctx ?? {}).parallel;

describe("CF-A-BARE-COLOUR-IS-WHATEVER-ITS-OWN-CHECKLIST-SAYS", () => {
  beforeEach(() => _resetBareColourAliasMap());

  // ── THE 448-SAMPLE SHAPE: A BARE COLOUR NOW RESOLVES ────────────────────

  it("donruss-elite: a bare colour resolves to the checklist's own bare-colour parallel", () => {
    expect(bareColourAliasFromChecklist(
      "2025 Donruss Elite Football #10 Orange",
      { year: 2025, setKey: "donruss-elite" },
    )).toBe("Orange");
    expect(bareColourAliasFromChecklist(
      "2025 Donruss Elite Football #9 Green",
      { year: 2025, setKey: "donruss-elite" },
    )).toBeNull(); // donruss-elite has 2025 "Green Disco" AND several "<Insert> Green" ties -- ambiguous, see below
    expect(bareColourAliasFromChecklist(
      "2024 Donruss Elite Football #124 Black",
      { year: 2024, setKey: "donruss-elite" },
    )).toBe("Black");
    expect(bareColourAliasFromChecklist(
      "2024 Donruss Elite Football #164 Blue",
      { year: 2024, setKey: "donruss-elite" },
    )).toBe("Blue");
    expect(bareColourAliasFromChecklist(
      "2024 Donruss Elite Football #87 Gold",
      { year: 2024, setKey: "donruss-elite" },
    )).toBe("Gold");
  });

  it("panini-certified: a bare colour resolves to the checklist's Mirror-prefixed base parallel", () => {
    // panini-certified has never printed a bare, unqualified colour parallel --
    // only "Mirror <Colour>" -- so the checklist's own answer is NOT the bare
    // word the title states, and this module correctly returns the checklist's
    // spelling rather than echoing the title.
    expect(bareColourAliasFromChecklist(
      "2025 Panini Certified Football #79 Teal",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Teal");
    expect(bareColourAliasFromChecklist(
      "2025 Panini Certified Football #56 Green",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Green");
    expect(bareColourAliasFromChecklist(
      "2025 Panini Certified Football #11 Blue",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Blue");
    expect(bareColourAliasFromChecklist(
      "2025 Panini Certified Football #53 Red",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Red");
    expect(bareColourAliasFromChecklist(
      "2025 Panini Certified Football #87 Purple",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Purple");
  });

  it("topps-signature-class: a bare colour resolves via the Refractor-suffixed checklist name", () => {
    expect(bareColourAliasFromChecklist(
      "2025 Topps Signature Class Football #SC-18 Blue",
      { year: 2025, setKey: "topps-signature-class" },
    )).toBe("Blue Refractor");
  });

  it("the parser as a whole resolves the sampled titles end to end", () => {
    expect(parallelOf(
      "2025 Donruss Elite Football #10 Orange",
      { year: 2025, setKey: "donruss-elite" },
    )).toBe("Orange");
    expect(parallelOf(
      "2025 Panini Certified Football #79 Teal",
      { year: 2025, setKey: "panini-certified" },
    )).toBe("Mirror Teal");
  });

  // ── AMBIGUOUS FOR THIS PRODUCT: TWO PARALLELS SHARE THE COLOUR ──────────

  it("refuses when the product's checklist has two same-length same-colour parallels", () => {
    // 2025 donruss-elite lists "Green Disco" (base insert accent) and several
    // "<Insert> Green" names ("Status Green", "MVPBound Green", ...) tied at
    // the same shortest length -- no single name is THE checklist's answer to
    // a bare "Green", so this refuses rather than guessing.
    expect(bareColourAliasFromChecklist(
      "2025 Donruss Elite Football #9 Green",
      { year: 2025, setKey: "donruss-elite" },
    )).toBeNull();
    expect(parallelOf(
      "2025 Donruss Elite Football #9 Green",
      { year: 2025, setKey: "donruss-elite" },
    )).toBe("Base");
  });

  it("2024 panini-certified Gold ties between the Mirror line and a same-length insert name", () => {
    // "Mirror Gold" and "Gold Team" are both two-word names built from "gold" --
    // a real ambiguity the checklist itself carries, not a defect to paper over.
    expect(bareColourAliasFromChecklist(
      "2024 Panini Certified Football #71 Gold",
      { year: 2024, setKey: "panini-certified" },
    )).toBeNull();
  });

  // ── A COLOUR WORD INSIDE THE PRODUCT'S OWN NAME IS NEVER A PARALLEL ─────

  it("MUTATION: never reads a colour baked into the product's own setKey as a parallel", () => {
    // 2025 panini-black's checklist has exactly one parallel containing the
    // word "black" -- "Black Gold" ("Blacked Out ..." is a different word) --
    // so WITHOUT the productWords guard this would resolve unambiguously to
    // "Black Gold" for a bare "Black" title. The guard must refuse it anyway:
    // "black" is baked into the product's own name (panini-BLACK), so it can
    // never be read as this product's parallel regardless of what the
    // checklist otherwise lists. Reverting the suppression makes this pass.
    expect(bareColourAliasFromChecklist(
      "2025 Panini Black Football #10 Black",
      { year: 2025, setKey: "panini-black" },
    )).toBeNull();
  });

  // ── NO PRODUCT CONTEXT, NO CORPUS ENTRY, NO COLOUR ──────────────────────

  it("refuses with no year/setKey context at all", () => {
    expect(bareColourAliasFromChecklist("2025 Donruss Elite Football #10 Orange", {})).toBeNull();
  });

  it("refuses a product the corpus does not carry", () => {
    // panini-rookies-and-stars and panini-donruss are absent from the corpus
    // entirely in this sample window -- absent beats wrong.
    expect(bareColourAliasFromChecklist(
      "2025 Panini Rookies & Stars Football #28 Silver",
      { year: 2025, setKey: "panini-rookies-and-stars" },
    )).toBeNull();
  });

  it("a title with no colour word at all is not touched", () => {
    expect(bareColourAliasFromChecklist(
      "2025 Donruss Elite Football #NGJ-TRH Jerseys",
      { year: 2025, setKey: "donruss-elite" },
    )).toBeNull();
  });

  it("MUTATION: two colour words together is not 'a bare colour'", () => {
    // "Blue & Orange" is a NAMED two-colour parallel on some products; reading
    // either word alone here would risk mis-answering a title that states the
    // combined name. This reader's job is the single bare colour only -- named
    // combinations are the finish-reader's and the pattern rules' territory.
    expect(bareColourAliasFromChecklist(
      "2024 Topps Signature Class Football #1 Blue Orange",
      { year: 2024, setKey: "topps-signature-class" },
    )).toBeNull();
  });

  // ── DOES NOT OVERRIDE ANYTHING ABOVE IT ─────────────────────────────────

  it("does not override a named finish the title states", () => {
    // "Green Refractor" is a real checklist name with a finish word beside the
    // colour -- statedFinishFromChecklist (or an earlier rule) answers first.
    expect(parallelOf(
      "2024 Topps Chrome Football #234 Green Refractor",
      { year: 2024, setKey: "topps-chrome" },
    )).toBe("Green Refractor");
  });

  it("does not override an explicit Base", () => {
    expect(parallelOf(
      "2025 Donruss Elite Football #10 Base",
      { year: 2025, setKey: "donruss-elite" },
    )).toBe("Base");
  });

  it("a lot states no single card's colour", () => {
    expect(parallelOf(
      "2025 Donruss Elite Football Lot of 5 Orange",
      { year: 2025, setKey: "donruss-elite" },
    )).toBe("Base");
  });

  // ── COVERAGE SHAPE ───────────────────────────────────────────────────────

  it("MUTATION: the corpus is actually loaded and produces a non-empty map", () => {
    _resetBareColourAliasMap();
    const map = _bareColourAliasMapForTest();
    expect(map).not.toBeNull();
    expect(map!.size).toBeGreaterThan(0);
    // donruss-elite and panini-certified must each contribute at least one
    // resolved colour in at least one year -- if this regresses to zero the
    // whole feature silently stopped covering the products it was built for.
    const keys = [...map!.keys()];
    expect(keys.some((k) => k.endsWith("|donruss-elite"))).toBe(true);
    expect(keys.some((k) => k.endsWith("|panini-certified"))).toBe(true);
  });
});
