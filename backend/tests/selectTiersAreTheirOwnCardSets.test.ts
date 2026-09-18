// R53(ii) (Drew, 2026-09-15): SELECT'S NAMED TIERS ARE THEIR OWN CARD SETS.
//
// Panini Select prints its base set in named tiers — Concourse, Premier Level,
// Field Level. Whether a tier is a PARALLEL of one checklist or a card set of
// its own is decided by the NUMBERING, and the numbering answers plainly.
//
// Measured read-only on card_catalog, 2026-09-15:
//
//   baseball 2023   concourse 100 + premier level 100 = 200 distinct numbers,
//                   ZERO shared — the tiers partition the set
//   baseball 2025   likewise, 200 distinct, zero overlap
//   baseball 2024   concourse 100, premier level 100, but only 100 DISTINCT:
//                   every number is shared, and 36 of them name a DIFFERENT
//                   PLAYER in each tier —
//                     #21  Rhett Lowder   vs  Homer Bush Jr.
//                     #10  Kyle Manzardo  vs  Paul Skenes
//                     #98  Zach DeLoach   vs  Robert Hassell
//
// If a tier were a finish, #10 would be the same card in both. It is not. Two
// different players at one number is two cards — so the tier rides the setKey
// axis, and on the parallel axis those 36 pairs would collide into one id and
// one pool (`one card, one row, one pool`).
//
// 24,505 checklist-backed rows carry a tier name today, all on bare
// `panini-select`. This registers the destinations; it moves nothing.

import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const TIERS = [
  "panini-select-concourse",
  "panini-select-premier-level",
  "panini-select-field-level",
];

describe("R53(ii): Select's tiers are their own card sets", () => {
  it("registers all three tier keys", () => {
    expect(TIERS.filter((k) => !isProductSetKey(k))).toEqual([]);
  });

  it("every tier key is a normalizeSetKey FIXED POINT", () => {
    // Without the explicit pattern ahead of /panini-select/, each of these
    // normalizes back to the bare product and the key is unreachable —
    // registration alone is not enough, because productSetKeyForName resolves
    // by SPELLED name and a bare P() entry is not spelled.
    const collapsed = TIERS
      .filter((k) => normalizeSetKey(k) !== k)
      .map((k) => `${k} -> ${normalizeSetKey(k)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under Select so the matcher can still widen", () => {
    for (const k of TIERS) {
      expect(productParentOf(k), `${k} parent`).toBe("panini-select");
      expect(productFamilyOf(k), `${k} family`).toBe("panini-select");
    }
  });

  it("leaves the bare product and its neighbours untouched", () => {
    expect(normalizeSetKey("panini-select")).toBe("panini-select");
    expect(isProductSetKey("panini-select")).toBe(true);
    // select-certified was measured DISTINCT in a prior lane (1,376 checklist
    // rows against zero, disjoint eras) and must not be swept in here.
    expect(normalizeSetKey("select-certified")).toBe("select-certified");
  });

  it("is a specialisation, not a hole — an unregistered Select key still collapses", () => {
    // The mutation check: the new rules name three tiers exactly, and anything
    // else under Select still answers to the family catch-all.
    expect(isProductSetKey("panini-select-nonesuch")).toBe(false);
    expect(normalizeSetKey("panini-select-nonesuch")).toBe("panini-select");
  });
});
