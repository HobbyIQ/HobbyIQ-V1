/**
 * D1 — A SHARED ITEM ID PLUS A DISAGREEING IDENTITY IS NOT A DUPLICATE.
 *
 * THE DEFECT. `classifyCollision` tested sameness FIRST and let it win outright:
 * any rows sharing a `sourceExternalId` classed TRUE-DUPE with `axes: []`, even
 * when they disagreed about which CARD the sale was for. The old comment
 * defended it — "one ingester having mislabelled a parallel, which is a matcher
 * finding, not a licence to keep the sale twice" — and that reasoning is sound
 * about the arithmetic and wrong about the consequence: under
 * MODE=apply-true-dupes it silently resolved a wrong-card ingest in favour of
 * whichever row scored richer, stamped the other `dedup-superseded`, and
 * destroyed the very matcher finding it named.
 *
 * A differing cardNumber is the wrong-card-ingest signature. A card number is
 * not identity on its own (Beckett initials collide), which is exactly why a
 * disagreement on one needs a person rather than a rule.
 *
 * THE FOURTH CLASS. CONFLICTED-DUPE: surfaced with its conflicting axes named,
 * routed to review, and NEVER auto-flagged by apply-true-dupes.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { classifyCollision, CONFLICT_AXES } =
  require_(path.join(backend, "scripts", "lib", "collision-triage.cjs"));

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: "tca-ebay::100", cardId: "hiq:football:2024:topps-chrome:1:base:no-auto",
  source: "tca-ebay", sourceExternalId: "100",
  title: "2024 Topps Chrome Caleb Williams #1", parallel: "Base", cardNumber: "1",
  gradeCompany: null, gradeValue: null, isAuto: false, printRun: null,
  price: 9.99, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-15T01:00:00Z",
  ...over,
});

describe("D1 — the R1 judge's exact case", () => {
  // Shared item id '999'; cardNumber '12' vs '88'; parallel Gold vs Blue.
  const theCase = [
    row({ id: "tca-ebay::999", sourceExternalId: "999", cardNumber: "12", parallel: "Gold" }),
    row({ id: "cardhedge::999", source: "cardhedge", sourceExternalId: "999", cardNumber: "88", parallel: "Blue" }),
  ];

  it("classes CONFLICTED-DUPE, not TRUE-DUPE", () => {
    expect(classifyCollision(theCase).class).toBe("CONFLICTED-DUPE");
  });

  it("names BOTH conflicting axes, with their values", () => {
    const v = classifyCollision(theCase);
    const byField = Object.fromEntries(v.axes.map((a: { field: string; values: unknown[] }) => [a.field, a.values]));
    expect(Object.keys(byField).sort()).toEqual(["cardNumber", "parallel"]);
    expect(byField.cardNumber).toEqual(["12", "88"]);
    expect(byField.parallel).toEqual(["Gold", "Blue"]);
  });

  it("proposes NO flag and NO relocation — it is a question, not an action", () => {
    const v = classifyCollision(theCase);
    expect(v.flag).toEqual([]);
    expect(v.relocate).toEqual([]);
    expect(v.survivor).toBeNull();
  });

  it("the reason says what is wrong, in the report's own words", () => {
    expect(classifyCollision(theCase).reason)
      .toBe("shared-sourceExternalId-but-identity-disagrees-on-cardNumber+parallel");
  });

  it("it reports the shared id, so the conflicting listing can be looked up", () => {
    expect(classifyCollision(theCase).sharedIds).toEqual(["999"]);
    expect(classifyCollision(theCase).conflicts[0].sharedId).toBe("999");
  });
});

describe("D1 — one axis at a time is still a conflict", () => {
  it("cardNumber alone: the wrong-card-ingest signature", () => {
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: "999", cardNumber: "12" }),
      row({ id: "b", sourceExternalId: "999", cardNumber: "88" }),
    ]);
    expect(v.class).toBe("CONFLICTED-DUPE");
    expect(v.axes.map((a: { field: string }) => a.field)).toEqual(["cardNumber"]);
  });

  it("grade alone: the same listing cannot be a PSA 10 and a raw card", () => {
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: "999", gradeCompany: "PSA", gradeValue: 10 }),
      row({ id: "b", sourceExternalId: "999", gradeCompany: null, gradeValue: null }),
    ]);
    expect(v.class).toBe("CONFLICTED-DUPE");
    expect(v.axes.map((a: { field: string }) => a.field).sort()).toEqual(["gradeCompany", "gradeValue"]);
  });
});

describe("D1 — TRUE-DUPE survives where identity AGREES", () => {
  it("the same listing from two vendors, identity agreeing, is still a TRUE-DUPE", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::777", sourceExternalId: "777", title: "long descriptive title" }),
      row({ id: "cardhedge::777", source: "cardhedge", sourceExternalId: "777" }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(1);
    expect(v.survivor).toBeTruthy();
  });

  it("differing case and whitespace is NOT a conflict — a human reads them as one", () => {
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: "777", parallel: "Gold Refractor" }),
      row({ id: "b", sourceExternalId: "777", parallel: "  gold   refractor " }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
  });

  it("a missing printRun on one side is NOT a conflict — that is a fill gap", () => {
    // printRun and isAuto are deliberately outside CONFLICT_AXES: one side of a
    // cross-source pair commonly carries neither, and treating every such gap as
    // a contradiction would route the whole population to review.
    expect(CONFLICT_AXES).not.toContain("printRun");
    expect(CONFLICT_AXES).not.toContain("isAuto");
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: "777", printRun: 99, isAuto: true }),
      row({ id: "b", sourceExternalId: "777", printRun: null, isAuto: false }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
  });
});

describe("D1 — the conflict test is scoped to the rows that SHARE an id", () => {
  it("a bystander with its own id cannot make a clean pair conflict", () => {
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: "777", cardNumber: "1" }),
      row({ id: "b", source: "cardhedge", sourceExternalId: "777", cardNumber: "1" }),
      // different card, different id: a different sale, and none of its business
      row({ id: "c", sourceExternalId: "555", cardNumber: "99", parallel: "Gold" }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.flag.map((r: Row) => r.id)).toEqual(["b"]);
  });
});

describe("D1 — one conflict defers the WHOLE cluster, clean pairs included", () => {
  it("a conflicting pair and a clean pair in one cluster: nothing is auto-flagged", () => {
    // Deliberate under-action. A cluster containing a proven wrong-card ingest
    // is one whose partition we have just discovered we cannot trust; flagging
    // part of it while a person rules on the rest writes into a pool that is
    // about to be re-adjudicated. Under-acting is recoverable, over-acting is
    // not — the flag would have to be found and lifted by hand.
    const v = classifyCollision([
      row({ id: "a1", sourceExternalId: "111", cardNumber: "12" }),
      row({ id: "a2", source: "cardhedge", sourceExternalId: "111", cardNumber: "88" }),
      row({ id: "b1", sourceExternalId: "222", cardNumber: "5" }),
      row({ id: "b2", source: "cardhedge", sourceExternalId: "222", cardNumber: "5" }),
    ]);
    expect(v.class).toBe("CONFLICTED-DUPE");
    expect(v.flag).toEqual([]);
    // and it reports ONLY the pair that actually conflicts, so the review names
    // the real question rather than the whole cluster
    expect(v.conflicts).toHaveLength(1);
    expect(v.conflicts[0].sharedId).toBe("111");
  });
});

describe("D1 — MUTANT: letting sameness win outright brings the defect back", () => {
  it("removing the conflict branch re-classes the judge's case as TRUE-DUPE", async () => {
    const fs = await import("node:fs");
    const libPath = path.join(backend, "scripts", "lib", "collision-triage.cjs");
    const src = fs.readFileSync(libPath, "utf8").replace(/\r\n/g, "\n");
    // The pre-D1 behaviour: no conflict is ever found, so a shared id wins.
    const mutant = src.replace(
      "      if (axes.length > 0) conflicts.push({ sharedId: ext, rows: arr, axes });",
      "      if (false) conflicts.push({ sharedId: ext, rows: arr, axes });",
    );
    expect(mutant, "mutation must actually apply").not.toBe(src);
    const mod = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", "require", mutant)(mod, mod.exports, require_);
    const mutated = (mod.exports as { classifyCollision: (r: Row[]) => { class: string; flag: Row[] } }).classifyCollision;

    const theCase = [
      row({ id: "tca-ebay::999", sourceExternalId: "999", cardNumber: "12", parallel: "Gold" }),
      row({ id: "cardhedge::999", source: "cardhedge", sourceExternalId: "999", cardNumber: "88", parallel: "Blue" }),
    ];
    expect(classifyCollision(theCase).class).toBe("CONFLICTED-DUPE");
    // and the mutant would auto-flag a wrong-card ingest under apply-true-dupes
    expect(mutated(theCase).class).toBe("TRUE-DUPE");
    expect(mutated(theCase).flag).toHaveLength(1);
  });
});
