// CF-SEARCH-FUZZY-PLAYER + CF-SEARCH-DEDUP + CF-SEARCH-CHECKLIST-IS-THE-INDEX
// (Drew, 2026-08-13).
//
// The report: searching "2026 bowman Justin gonzalez auto" "came back with
// duplicates - leaking from sold comps", and none of the checklist's auto
// options showed. Three separate causes, pinned here:
//
//   1. The checklist spells him "Justin Gonzales" (s), Drew typed "gonzalez"
//      (z). Exact matching killed the strongest scoring signal.
//   2. `cardhedge::` vendor mirrors carry the vendor's setKey, so they never
//      collapsed into their canonical twin — and outscored it. Every one had
//      comps=0, because sales hang off the canonical slug.
//   3. Grade variants share the ungraded card's identity fields, so a
//      `:psa-10` row could win the dedup tie and return the card with an empty
//      market panel.
//
// These exercise the pure helpers. The Cosmos-backed query shape is verified
// against prod, not mocked here.

import { describe, it, expect } from "vitest";
import {
  __testables,
} from "../src/services/catalog/catalogSearch.service";

const { fold, editDistance, fuzzyIncludes, dedupeKey, preferHit } = __testables;

describe("fold — diacritics and punctuation", () => {
  it("folds accents so the catalog's spelling matches what users type", () => {
    expect(fold("Ronald Acuña, Jr.")).toBe(fold("Ronald Acuna Jr"));
    expect(fold("José Ramírez")).toBe(fold("Jose Ramirez"));
    expect(fold("Jeremy Peña")).toBe(fold("Jeremy Pena"));
  });

  it("does not collapse genuinely different names", () => {
    expect(fold("Jose Ramirez")).not.toBe(fold("Jose Ramos"));
  });
});

describe("editDistance — bounded", () => {
  it("measures small edits", () => {
    expect(editDistance("gonzalez", "gonzales", 2)).toBe(1);
    expect(editDistance("smith", "smith", 2)).toBe(0);
  });

  it("bails out past the budget rather than computing the true distance", () => {
    expect(editDistance("gonzalez", "rodriguez", 1)).toBeGreaterThan(1);
  });
});

describe("fuzzyIncludes — the Gonzalez/Gonzales case", () => {
  it("matches the z/s variant that started this", () => {
    expect(fuzzyIncludes("Justin Gonzales", "gonzalez")).toBe(true);
  });

  it("matches exactly when the spelling is right", () => {
    expect(fuzzyIncludes("Justin Gonzales", "gonzales")).toBe(true);
  });

  it("matches across accents without spending the edit budget", () => {
    // "Peña" folds to "pena" first, so the accent costs nothing — it matches
    // as a plain substring rather than consuming the 1-edit allowance.
    expect(fuzzyIncludes("Jeremy Peña", "pena")).toBe(true);
    // But a 4-letter token is still below the fuzzy floor, so a typo on a
    // short name does NOT match — the same rule that keeps "Cruz" from
    // matching "Ruiz". Folding widens what counts as exact; it does not lower
    // the floor.
    expect(fuzzyIncludes("Jeremy Peña", "pina")).toBe(false);
    // On a long enough name, folding and a real typo compose:
    expect(fuzzyIncludes("Teoscar Hernández", "hernandes")).toBe(true);
  });

  it("refuses fuzzy matching on short tokens", () => {
    // A 1-edit window on 4 letters would make "Cruz" match "Ruiz".
    expect(fuzzyIncludes("Nelson Cruz", "ruiz")).toBe(false);
    expect(fuzzyIncludes("Nelson Cruz", "cruk")).toBe(false);
  });

  it("does not match unrelated surnames of similar length", () => {
    expect(fuzzyIncludes("Justin Gonzales", "rodriguez")).toBe(false);
    expect(fuzzyIncludes("Justin Gonzales", "martinez")).toBe(false);
  });

  it("still matches a plain substring", () => {
    expect(fuzzyIncludes("Justin Gonzales", "justin")).toBe(true);
  });
});

describe("dedupeKey — identity from fields, not ids", () => {
  const hit = (over: Record<string, unknown> = {}) => ({
    slug: "hiq:baseball:2026:bowman:cpa-jg:base:auto",
    cardNumber: "CPA-JG", playerName: "Justin Gonzales", sport: "baseball",
    year: 2026, setKey: "bowman", setName: null, parallel: "Base",
    isAuto: true, printRun: null, imageUrl: null, kind: null, score: 1,
    salesSummary: null, ...over,
  }) as never;

  it("merges a vendor-keyed row with its canonical twin", () => {
    // The only thing that can: the ids share nothing.
    expect(dedupeKey(hit({ slug: "cardhedge::123::abc" })))
      .toBe(dedupeKey(hit()));
  });

  it("keeps different print runs apart — they are different cards", () => {
    expect(dedupeKey(hit({ printRun: 99 }))).not.toBe(dedupeKey(hit({ printRun: 150 })));
  });

  it("keeps different parallels apart", () => {
    expect(dedupeKey(hit({ parallel: "Green Refractor" }))).not.toBe(dedupeKey(hit()));
  });

  it("keeps auto and non-auto apart", () => {
    expect(dedupeKey(hit({ isAuto: false }))).not.toBe(dedupeKey(hit()));
  });
});

describe("preferHit — which row represents the card", () => {
  const mk = (slug: string, score: number) => ({
    slug, score, cardNumber: "CPA-JG", playerName: "Justin Gonzales",
    sport: "baseball", year: 2026, setKey: "bowman", setName: null,
    parallel: "Base", isAuto: true, printRun: null, imageUrl: null,
    kind: null, salesSummary: null,
  }) as never;

  const UNGRADED = mk("hiq:baseball:2026:bowman:cpa-jg:base:auto", 0.5);
  const PSA10 = mk("hiq:baseball:2026:bowman:cpa-jg:base:auto:psa-10", 0.9);
  const VENDOR = mk("cardhedge::123::abc", 0.9);

  it("prefers the ungraded row even when a grade row scores higher", () => {
    // Comps hang off the ungraded slug; picking psa-10 returns the right card
    // with an empty market panel.
    expect(preferHit(UNGRADED, PSA10)).toBe(true);
    expect(preferHit(PSA10, UNGRADED)).toBe(false);
  });

  it("prefers a canonical slug over a vendor-keyed row", () => {
    expect(preferHit(UNGRADED, VENDOR)).toBe(true);
  });

  it("falls back to score between equals", () => {
    const lo = mk("hiq:baseball:2026:bowman:cpa-jg:base:auto", 0.3);
    const hi = mk("hiq:baseball:2026:bowman:cpa-jg:base:auto", 0.8);
    expect(preferHit(hi, lo)).toBe(true);
  });
});
