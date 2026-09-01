/**
 * CF-BLANK-MEANS-UNKNOWN-NEVER-BASE (2026-09-01).
 *
 * The fetcher emitted `parallel: cat === "base" ? "Base" : ""` — the literal
 * word "Base" in the parallel column of every base card of every hobbymonitor
 * release. hobbymonitor never says it: the source states a finish only on the
 * ladder (cardParallels[]), never on a card object. The word was ours.
 *
 * Two failures came out of that one ternary:
 *   * a base-ONLY release emits nothing the driver can see as a base row, so
 *     the universe driver's zero-base gate REFUSES it — 25 manifest entries,
 *     1952 Topps and its 5,418 rows among them;
 *   * a release WITH inserts passes that gate and ingests every base card
 *     carrying the parallel "Base", a second row beside the blank-parallel row
 *     every other source mints for the same card. One card, two rows, a split
 *     pool, a wrong FMV.
 *
 * Blank means unknown, never "Base". The base tier is expressed by the SLUG
 * (normalizeParallel("") is already base), not by a word in the stored field.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const { buildRows } = require_("../scripts/fetchHobbyMonitorChecklist.cjs");

const FETCHER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "fetchHobbyMonitorChecklist.cjs",
);

/** A base-only release: the shape the zero-base gate refused. */
const BASE_ONLY_CARDS = [
  { cardNumber: "1", players: ["Jac Caglianone"], cardSet: "Base", cardType: "Base" },
  { cardNumber: "2", players: ["Ethan Holliday"], cardSet: "Base", cardType: "Base" },
];

/** A release with a real insert subset carrying a priced ladder. */
const WITH_INSERTS_CARDS = [
  { cardNumber: "1", players: ["Jac Caglianone"], cardSet: "Base", cardType: "Base" },
  { cardNumber: "BP-18", players: ["Ethan Holliday"], cardSet: "Prospects", cardType: "Prospects" },
];
const WITH_INSERTS_GROUPS = [
  { cardSet: "Prospects", cardType: "Prospects", parallels: [
    { name: "Orange Refractor", printRun: 25 },
    { name: "SuperFractor", printRun: null, isOneOfOne: true },
  ] },
];

describe("a base-category row states no finish, because the source stated none", () => {
  it("emits BLANK in the parallel column for every base card", () => {
    const { rows } = buildRows(BASE_ONLY_CARDS, []);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.category).toBe("base");
      expect(r.parallel).toBe("");
    }
  });

  it("never emits the literal word Base in the parallel column, in any category", () => {
    const { rows } = buildRows(WITH_INSERTS_CARDS, WITH_INSERTS_GROUPS);
    const literals = rows.filter((r: any) => /^base$/i.test(String(r.parallel).trim()));
    expect(literals).toEqual([]);
  });

  it("gives the driver's zero-base gate real base rows to count", () => {
    // The gate counts rows in the `base` CATEGORY. Those exist and are blank —
    // which is exactly the point: the category carries the tier, the parallel
    // column carries only what the source said.
    const { rows } = buildRows(BASE_ONLY_CARDS, []);
    const baseRows = rows.filter((r: any) => r.category === "base");
    expect(baseRows.length).toBe(2);
    expect(new Set(baseRows.map((r: any) => r.parallel))).toEqual(new Set([""]));
  });
});

describe("insert and auto behavior is unchanged by the base fix", () => {
  it("an insert card's own row is blank and its ladder rungs keep their real names", () => {
    const { rows } = buildRows(WITH_INSERTS_CARDS, WITH_INSERTS_GROUPS);

    const cardRow = rows.find((r: any) => r.cardNumber === "BP-18" && r.parallel === "");
    expect(cardRow).toBeDefined();
    expect(cardRow.category).toBe("insert-prospects");

    const rungs = rows
      .filter((r: any) => r.cardNumber === "BP-18" && r.parallel !== "")
      .map((r: any) => [r.parallel, r.printRun]);
    // The real rung names survive verbatim, print runs attached.
    expect(rungs).toEqual([["Orange Refractor", 25], ["SuperFractor", 1]]);
  });

  it("an auto card lands in an auto- category with a blank card row", () => {
    const { rows } = buildRows(
      [{ cardNumber: "CPA-JG", players: ["Jac Caglianone"], cardSet: "Chrome Prospect Autographs", cardType: "Chrome Prospect Autographs", autograph: true }],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toMatch(/^auto-/);
    expect(rows[0].parallel).toBe("");
  });
});

describe("the mutation that reintroduces the defect must fail", () => {
  /**
   * Guard against a silent revert. We re-evaluate the fetcher source with the
   * fixed emission swapped back to the original ternary — if the assertions
   * above would still pass under the defect, they are not pinning anything.
   */
  it("restoring `cat === \"base\" ? \"Base\" : \"\"` makes a base row non-blank", () => {
    const src = fs.readFileSync(FETCHER, "utf8");

    const FIXED_LINE = 'rows.push({ category: cat, cardNumber: c.num, parallel: "",';
    expect(src).toContain(FIXED_LINE);

    const mutated = src.replace(
      FIXED_LINE,
      'rows.push({ category: cat, cardNumber: c.num, parallel: cat === "base" ? "Base" : "",',
    );
    expect(mutated).not.toBe(src);

    // Load the mutated source as its own module, without touching disk.
    const Module = require_("node:module");
    const m = new Module.Module(`${FETCHER}.mutant`, undefined);
    m.filename = `${FETCHER}.mutant`;
    m.paths = (Module.Module as any)._nodeModulePaths(path.dirname(FETCHER));
    m._compile(mutated, `${FETCHER}.mutant`);

    const { rows } = (m.exports as any).buildRows(BASE_ONLY_CARDS, []);
    // THE DEFECT, reproduced: the literal word is back in the parallel column.
    expect(rows.every((r: any) => r.parallel === "Base")).toBe(true);

    // And the assertion the real test makes would fail against it.
    const literals = rows.filter((r: any) => /^base$/i.test(String(r.parallel).trim()));
    expect(literals.length).toBe(2);
  });
});
