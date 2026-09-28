// CF-T206-NAME-TO-POSITION (Drew, "fix all of baseball now", 2026-09-28).
//
// Pins resolveT206ChecklistPosition against the disambiguation rule stated
// in its own doc comment: single-pose surname -> resolves unconditionally;
// multi-pose surname with a stated pose that picks exactly one candidate ->
// resolves; multi-pose surname with no stated pose (or a pose that still
// doesn't narrow to one row) -> UNRESOLVED, never a guess.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveT206ChecklistPosition,
  _resetT206ChecklistIndexForTests,
} from "../src/services/portfolioiq/t206ChecklistPositionResolver.js";

beforeEach(() => {
  _resetT206ChecklistIndexForTests();
});

describe("resolveT206ChecklistPosition", () => {
  it("resolves a single-pose surname unconditionally", () => {
    // Al Mattern has exactly one checklist row (#309, "Al Mattern Portrait")
    // -- confirmed against the 2026-09-22 fold list's own evidence.
    expect(resolveT206ChecklistPosition("Al Mattern")).toBe(309);
    expect(resolveT206ChecklistPosition("al mattern")).toBe(309);
  });

  it("resolves a single-pose surname even when the residue also states the pose", () => {
    // The checklist row itself carries the pose text ("Al Mattern Portrait")
    // but there is still only ONE Al Mattern row, so stating the pose in the
    // residue must not change the answer.
    expect(resolveT206ChecklistPosition("Al Mattern Portrait")).toBe(309);
  });

  it("resolves a multi-pose surname when the residue states the distinguishing pose", () => {
    // Ty Cobb has 4 checklist rows (#95-98): Green Portrait / Red Portrait /
    // Bat off Shoulder / Bat on Shoulder.
    expect(resolveT206ChecklistPosition("Ty Cobb Red Portrait")).toBe(96);
    expect(resolveT206ChecklistPosition("Ty Cobb Green Portrait")).toBe(95);
    expect(resolveT206ChecklistPosition("Ty Cobb Bat off Shoulder")).toBe(97);
    expect(resolveT206ChecklistPosition("Ty Cobb Bat on Shoulder")).toBe(98);
    // Christy Mathewson has 3 rows (#306-308): Portrait / Black cap / White cap.
    expect(resolveT206ChecklistPosition("Christy Mathewson Portrait")).toBe(306);
    expect(resolveT206ChecklistPosition("Christy Mathewson Black cap")).toBe(307);
    expect(resolveT206ChecklistPosition("Christy Mathewson White cap")).toBe(308);
  });

  it("refuses a multi-pose surname when the title states no distinguishing pose — never a guess", () => {
    expect(resolveT206ChecklistPosition("Ty Cobb")).toBeNull();
    expect(resolveT206ChecklistPosition("Christy Mathewson")).toBeNull();
    // Cy Seymour has 3 rows (#433-435: Portrait / Batting / Pitching).
    expect(resolveT206ChecklistPosition("Cy Seymour")).toBeNull();
  });

  it("refuses a multi-pose surname when the stated pose still doesn't pick exactly one row", () => {
    // A pose word that matches none of this player's own candidates (typo /
    // wrong player's pose vocabulary bleeding in) must not fall back to a
    // random member of the group.
    expect(resolveT206ChecklistPosition("Ty Cobb Fielding")).toBeNull();
  });

  it("resolves when the residue is entirely back-brand-stripped already (no pose text survives)", () => {
    // stripT206BackBrand runs BEFORE this resolver in unnumberedCardSegment;
    // this function only ever sees the post-strip residue. A single-pose
    // player whose sale title carried no pose at all still resolves.
    expect(resolveT206ChecklistPosition("Jean Dubuc")).toBe(151);
    expect(resolveT206ChecklistPosition("Tris Speaker")).toBe(455);
  });

  it("returns null for input with no surname to key on", () => {
    expect(resolveT206ChecklistPosition("")).toBeNull();
    expect(resolveT206ChecklistPosition("Cobb")).toBeNull(); // single token, no surname pair
    expect(resolveT206ChecklistPosition(null as unknown as string)).toBeNull();
    expect(resolveT206ChecklistPosition(undefined as unknown as string)).toBeNull();
  });

  it("returns null for a surname absent from the checklist excerpt — absent beats wrong", () => {
    // Nap Lajoie is one of the 41-row "noCanonicalMatch" bucket named in the
    // 2026-09-22 fold list's excluded block (genuinely missing from the
    // fixture excerpt this repo has, not a defect in the resolver).
    expect(resolveT206ChecklistPosition("Nap Lajoie")).toBeNull();
  });

  it("is deterministic across repeated calls (memoized index, no side effects)", () => {
    const a = resolveT206ChecklistPosition("Al Mattern");
    const b = resolveT206ChecklistPosition("Al Mattern");
    expect(a).toBe(b);
    expect(a).toBe(309);
  });
});
