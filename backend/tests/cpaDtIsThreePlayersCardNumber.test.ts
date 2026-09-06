// CF-A-STORED-SET-NAME-CAN-BE-WRONG-TOO (found 2026-09-05 while proving the
// parallel split on holdings 4a82faed / 25bc5079).
//
// THE FINDING, AND WHY IT IS A TEST RATHER THAN A FIX.
//
// With the parallel split in place, `recheck-holding-identity MODE=rederive`
// reports both cpa-dt holdings as REDERIVE at exact/0.98 onto
//
//   hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
//
// and that destination row's `playerName` is DIEGO TORNES, while the holdings
// say DEVIN TAYLOR. The move is checklist-backed, confident, and about a
// different person.
//
// CPA-DT IS A COLLIDING CARD NUMBER — three products, three players, one set
// of initials (project_beckett_initials_card_numbers_collide, exactly):
//
//   2025 Bowman Chrome          cpa-dt -> Diego Tornes    (checklistcenter)
//   2025 Bowman Draft           cpa-dt -> Devin Taylor    (checklistcenter)
//   2025 Topps Chrome Platinum  cpa-dt -> Drew Thorpe     (beckett-checklist)
//
// Both Bowman rows are checklistcenter-2026-08-29, same source, same scrape.
// The checklist is right about BOTH players; what is wrong is the holding's
// stored `setName: "Bowman Chrome"`. Its own listing title reads "2025 Bowman
// Chrome DRAFT 1st Refractor Auto /499 Oakland Athletics" and Devin Taylor is
// an Athletics prospect — the seller's eBay `Set` aspect dropped the word
// "Draft", and `bowman-draft:cpa-dt:refractor:auto:num-499` (Devin Taylor,
// printRun 499) is the row these holdings actually name.
//
// GATE 1b IS THE GATE FOR THIS, AND IT DOES NOT FIRE HERE. It refuses a
// destination whose player contradicts the holding's — but it is scoped to
// RECOVERED set names, on the stated ground that "a STORED set name is the
// holding's own claim about its product, and this pass has never been in the
// business of second-guessing it". These holdings STORE their set name, so
// the report carries `recoveredFields: []` and the gate is skipped.
//
// This file does not widen that scope. Widening GATE 1b to every set name is
// a ruling about which claim outranks which — the user's stored product
// versus the checklist's player — and that belongs to Drew, not to a
// normalizer PR. What the tests below do is make the gap NAMED and MEASURED,
// so it cannot be rediscovered by a wrong-player apply: the decision function
// is exercised directly on the real colliding values, and the pins record
// that it WOULD refuse this move if it were asked.

import { describe, expect, it } from "vitest";
import {
  normalizePlayerForCompare,
  recoveredSetNameIsCorroborated,
} from "../scripts/comp-quality/recheck-holding-identity.js";

describe("CPA-DT is three players' card number", () => {
  // Read out of card_catalog 2026-09-05; all three rows are checklist-backed.
  const rows: Array<[string, string]> = [
    ["hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499", "Diego Tornes"],
    ["hiq:baseball:2025:bowman-draft:cpa-dt:refractor:auto:num-499", "Devin Taylor"],
    ["hiq:baseball:2025:topps-chrome-platinum:cpa-dt:refractor:auto:num-499", "Drew Thorpe"],
  ];

  it("the three destinations name three different people", () => {
    const folded = rows.map(([, p]) => normalizePlayerForCompare(p));
    expect(new Set(folded).size).toBe(3);
  });

  it("the holdings' player does NOT corroborate the bowman-chrome row", () => {
    // The row the matcher lands on today, and the holding that lands there.
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Diego Tornes")).toBe(false);
  });

  it("the holdings' player DOES corroborate the bowman-draft row", () => {
    // Which is the row their own title names — "2025 Bowman Chrome DRAFT ...".
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Devin Taylor")).toBe(true);
  });

  it("near-identical names are still different people", () => {
    // Devin Taylor / Diego Tornes share both initials and nothing else. A
    // similarity threshold is exactly how they would get fused, which is why
    // the gate compares folded equality and not a score.
    expect(normalizePlayerForCompare("Devin Taylor"))
      .not.toBe(normalizePlayerForCompare("Diego Tornes"));
    expect(recoveredSetNameIsCorroborated("Drew Thorpe", "Devin Taylor")).toBe(false);
  });

  it("a destination with no player name is not agreement", () => {
    expect(recoveredSetNameIsCorroborated("Devin Taylor", null)).toBe(false);
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "")).toBe(false);
  });
});
