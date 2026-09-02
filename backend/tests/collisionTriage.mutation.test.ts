/**
 * MUTATION CHECK — the externalId guard must be load-bearing.
 *
 * A guard nobody can break is a guard nobody has tested. The lesson is D29's:
 * a right guard with the wrong scope passed every test it had because none of
 * them removed it. So this file takes the shipped rule, DELETES the external-id
 * discriminator from it, and asserts the mandated refusals then FAIL.
 *
 * If a future edit makes these mutants pass, the guard has stopped doing
 * anything and the refusal is decoration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const libPath = path.join(backend, "scripts", "lib", "collision-triage.cjs");
const source = fs.readFileSync(libPath, "utf8");

type Row = Record<string, unknown>;
type Verdict = { class: string; flag: Row[]; relocate: Row[]; reason: string };

/** Load a (possibly mutated) copy of the rule. */
function load(src: string): { classifyCollision: (rows: Row[]) => Verdict } {
  const mod = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", src)(mod, mod.exports, require_);
  return mod.exports as { classifyCollision: (rows: Row[]) => Verdict };
}

const row = (over: Row = {}): Row => ({
  id: "tca-ebay::100", cardId: "hiq:football:2024:topps-chrome:1:base:no-auto",
  source: "tca-ebay", sourceExternalId: "100",
  title: "2024 Topps Chrome Caleb Williams #1", parallel: "Base", cardNumber: "1",
  gradeCompany: null, gradeValue: null, isAuto: false, printRun: null,
  price: 9.99, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-15T01:00:00Z",
  ...over,
});

/** The two $9.99 sales the doctrine says must NEVER be collapsed. */
const twoRealSales = [
  row({ id: "tca-ebay::111", sourceExternalId: "111", soldAt: "2026-08-14T23:30:00Z" }),
  row({ id: "tca-ebay::222", sourceExternalId: "222", soldAt: "2026-08-14T23:30:00Z" }),
];

describe("the shipped rule refuses to collapse two real sales", () => {
  it("baseline: different item ids, identical everything else -> never TRUE-DUPE", () => {
    const v = load(source).classifyCollision(twoRealSales);
    expect(v.class).not.toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(0);
  });
});

describe("MUTANTS — removing the guard must break the refusal", () => {
  it("MUTANT A: treating any multi-row cluster as a dupe collapses two real sales", () => {
    // Replaces the shared-id requirement with `length > 0` — i.e. "everything
    // in this cluster is the same sale", which is what rev-2 effectively did.
    const mutant = source.replace(
      "const shared = [...byExternal.entries()].filter(([, arr]) => arr.length > 1);",
      "const shared = [[\"*\", list]].filter(([, arr]) => arr.length > 1);",
    );
    expect(mutant, "mutation must actually apply").not.toBe(source);
    const v = load(mutant).classifyCollision(twoRealSales);
    // The mutant collapses them — proving the real guard is what prevents it.
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(1);
  });

  it("MUTANT B: ignoring sourceExternalId entirely collapses two real sales", () => {
    // Every row reports the same external id — the shape of a script that does
    // not read the field at all.
    const mutant = source.replace(
      "  const raw = row?.sourceExternalId;",
      "  const raw = \"SAME\";",
    );
    expect(mutant).not.toBe(source);
    const v = load(mutant).classifyCollision(twoRealSales);
    expect(v.class).toBe("TRUE-DUPE");
  });

  it("MUTANT C: restoring the retracted \" Refractor\" strip collapses two distinct cards", () => {
    // With the strip back in the raw comparison, `Uncommon` and
    // `Uncommon Refractor` stop differing, so the pair loses its
    // DISTINCT-CARDS proof and falls through to AMBIGUOUS.
    const mutant = source.replace(
      'const rawKey = (v) => (isMissing(v) ? "" : typeof v === "string" ? v.trim().toLowerCase().replace(/\\s+/g, " ") : JSON.stringify(v));',
      'const rawKey = (v) => (isMissing(v) ? "" : typeof v === "string" ? v.trim().toLowerCase().replace(/\\s+/g, " ").replace(/ refractors?$/, "") : JSON.stringify(v));',
    );
    expect(mutant, "mutation must actually apply").not.toBe(source);
    const pair = [
      row({ id: "a", sourceExternalId: "111", parallel: "Uncommon" }),
      row({ id: "b", sourceExternalId: "222", parallel: "Uncommon Refractor" }),
    ];
    expect(load(source).classifyCollision(pair).class).toBe("DISTINCT-CARDS");
    expect(load(mutant).classifyCollision(pair).class).toBe("AMBIGUOUS");
  });

  it("MUTANT D: making a missing id match another missing id flags unprovable rows", () => {
    // `null` external ids must never cluster with each other. A mutant that
    // lets them collapses rows for which there is no evidence at all.
    const mutant = source.replace(
      "  if (isMissing(raw)) return null;",
      "  if (isMissing(raw)) return \"\";",
    );
    expect(mutant).not.toBe(source);
    const noIds = [row({ id: "a", sourceExternalId: null }), row({ id: "b", sourceExternalId: null })];
    expect(load(source).classifyCollision(noIds).class).toBe("AMBIGUOUS");
    expect(load(mutant).classifyCollision(noIds).class).toBe("TRUE-DUPE");
  });
});
