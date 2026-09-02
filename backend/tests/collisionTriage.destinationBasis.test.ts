/**
 * D6 — A DESTINATION IS NAMED BY THE CATALOG, NOT BY STRING LENGTH.
 *
 * THE DEFECT. The triage picked the LONGEST id in the group as its partition
 * stand-in and then REUSED that id to name where a DISTINCT-CARDS row should be
 * relocated. As a hashing stand-in that is harmless — every row in the group
 * hashes against the same partition, so the choice cannot change WHICH rows
 * collide. As a NAME it is illegitimate: `...:base-uncommon:...` outranks
 * `...:uncommon:...` by four characters, so the destination a human is asked to
 * approve flipped between the two on string length.
 *
 * THE RULE. The catalog decides addresses, and within it a checklist-backed row
 * decides (catalogAuthorityOf: checklist > vendor > derived). Where both sides
 * are checklist-backed and disagree, or neither is, no row present has the
 * authority — the answer is UNRESOLVED and a person rules. It stays review-only
 * either way: this NAMES a target for the D31 relocation lane and performs none.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { decideRelocationBasis } = require_(path.join(backend, "scripts", "lib", "collision-triage.cjs"));
// The REAL authority rule, not a test-local guess at what "checklist-backed"
// means. If catalogAuthorityOf's source patterns change, this moves with them.
const { catalogAuthorityOf } = require_(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const isChecklist = (s: string) => catalogAuthorityOf(String(s ?? "")) === "checklist";

const SHORT = "hiq:football:2024:topps-finest:197:uncommon:no-auto";
const LONG = "hiq:football:2024:topps-finest:197:base-uncommon:no-auto";

describe("D6 — the checklist-backed row names the address", () => {
  it("picks the checklist row even when its id is SHORTER than the vendor's", () => {
    // This is the exact flip the length rule got wrong: `base-uncommon` is the
    // longer string, and the vendor row that carries it would have won.
    const basis = decideRelocationBasis([
      { id: SHORT, source: "beckett" },
      { id: LONG, source: "tca-ebay" },
    ], isChecklist);
    expect(basis.kind).toBe("checklist-backed");
    expect(basis.basis).toBe(SHORT);
    expect(SHORT.length).toBeLessThan(LONG.length);
  });

  it("picks the checklist row when its id is LONGER too — length is simply not the rule", () => {
    const basis = decideRelocationBasis([
      { id: LONG, source: "beckett" },
      { id: SHORT, source: "tca-ebay" },
    ], isChecklist);
    expect(basis.kind).toBe("checklist-backed");
    expect(basis.basis).toBe(LONG);
  });

  it("names the source it relied on, so the ruling is auditable", () => {
    const basis = decideRelocationBasis([
      { id: SHORT, source: "beckett" }, { id: LONG, source: "tca-ebay" },
    ], isChecklist);
    expect(basis.why).toMatch(/beckett/);
  });
});

describe("D6 — where no row has the authority, it says UNRESOLVED", () => {
  it("neither side checklist-backed -> unresolved, and it names the sources", () => {
    const basis = decideRelocationBasis([
      { id: SHORT, source: "tca-ebay" },
      { id: LONG, source: "sold-comps-stub" },
    ], isChecklist);
    expect(basis.kind).toBe("unresolved");
    expect(basis.basis).toBeNull();
    expect(basis.why).toMatch(/no checklist-backed row/);
    expect(basis.why).toMatch(/checklist ruling needed/);
  });

  it("TWO checklist-backed rows that disagree -> unresolved, not a coin flip", () => {
    const basis = decideRelocationBasis([
      { id: SHORT, source: "beckett" },
      { id: LONG, source: "checklistinsider" },
    ], isChecklist);
    expect(basis.kind).toBe("unresolved");
    expect(basis.why).toMatch(/disagree/);
    expect(basis.why).toMatch(/checklist ruling needed/);
  });

  it("an EMPTY group is unresolved rather than an exception", () => {
    expect(decideRelocationBasis([], isChecklist).kind).toBe("unresolved");
    expect(decideRelocationBasis(undefined, isChecklist).kind).toBe("unresolved");
  });

  it("two checklist rows with the SAME id are one row, not a disagreement", () => {
    const basis = decideRelocationBasis([
      { id: SHORT, source: "beckett" },
      { id: SHORT, source: "beckett-scraped-2026-08-19" },
    ], isChecklist);
    expect(basis.kind).toBe("checklist-backed");
    expect(basis.basis).toBe(SHORT);
  });
});

describe("D6 — the longest-string rule is gone from the triage", () => {
  it("trueSlugOf is driven by the basis, never by a length sort", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(path.join(backend, "scripts", "triage-contenthash-collisions.cjs"), "utf8").replace(/\r\n/g, "\n");
    const fn = src.slice(src.indexOf("function trueSlugOf"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/basis/);
    expect(body).not.toMatch(/b\.length - a\.length/);
    // and an unresolved basis produces an ADMITTED GAP, never an invented slug
    expect(body).toMatch(/UNRESOLVED -- checklist ruling needed/);
  });

  it("the longest id survives ONLY as the hash partition stand-in, and says so", () => {
    // Keeping it there is correct: it cannot change which rows collide. The
    // defect was reusing it as a NAME.
    return import("node:fs").then((fs) => {
      const src = fs.readFileSync(path.join(backend, "scripts", "triage-contenthash-collisions.cjs"), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/const longestId = /);
      expect(src).toMatch(/Naming a RELOCATION DESTINATION is a different question/);
    });
  });
});
