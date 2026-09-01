/**
 * THE CLASSIFIER IS THE RULING. D30's pre-flight counts collisions; this rule
 * says what each one IS, and the fold is unblocked by the ruling, not the count.
 *
 * Two proofs, deliberately asymmetric:
 *   sameness  requires a shared sourceExternalId (the eBay item id, half of the
 *             doc id `{source}::{sourceExternalId}`)
 *   difference requires a differing RAW identity axis
 * Neither is the other's default, so a row we cannot read falls to AMBIGUOUS
 * rather than being collapsed by silence. These tests pin exactly that.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { classifyCollision, pickSurvivor, collapsedAxes } =
  require_(path.join(backend, "scripts", "lib", "collision-triage.cjs"));

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: "tca-ebay::100",
  cardId: "hiq:football:2024:topps-chrome:1:base:no-auto",
  source: "tca-ebay",
  sourceExternalId: "100",
  title: "2024 Topps Chrome Caleb Williams #1",
  parallel: "Base",
  cardNumber: "1",
  gradeCompany: null,
  gradeValue: null,
  isAuto: false,
  printRun: null,
  price: 9.99,
  soldAt: "2026-08-14T23:30:00Z",
  observedAt: "2026-08-15T01:00:00Z",
  ...over,
});

describe("THE MANDATED REFUSAL — different item ids are never one sale", () => {
  it("two $9.99 sales on the same DAY with different sourceExternalIds do not cluster", () => {
    // The sold-comps-cross-source-dedup defect: keyed on (title, price, DAY),
    // so two identical-title same-price sales 19h apart collapsed into one.
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", soldAt: "2026-08-14T01:00:00Z" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", soldAt: "2026-08-14T20:00:00Z" }),
    ]);
    expect(v.class).not.toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(0);
  });

  it("two $9.99 sales in the same MINUTE with different sourceExternalIds do not cluster", () => {
    // The crossSourceDedupSoldComps defect: minute precision was necessary but
    // NOT sufficient — it ignored sourceExternalId entirely, so two real sales
    // one minute apart still collapsed. Two people can buy the same common at
    // the same price in the same minute; both sales are real.
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", soldAt: "2026-08-14T23:30:00Z" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", soldAt: "2026-08-14T23:30:00Z" }),
    ]);
    expect(v.class).not.toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(0);
  });

  it("identical in EVERY field but the item id is AMBIGUOUS — never a dupe", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222" }),
    ]);
    expect(v.class).toBe("AMBIGUOUS");
    expect(v.reason).toMatch(/identity-identical/);
    expect(v.flag).toHaveLength(0);
    expect(v.relocate).toHaveLength(0);
  });
});

describe("a shared item id IS the same sale, whoever ingested it", () => {
  it("the SAME externalId across two sources clusters as TRUE-DUPE", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::555", source: "tca-ebay", sourceExternalId: "555" }),
      row({ id: "cardhedge::555", source: "cardhedge", sourceExternalId: "555" }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.reason).toMatch(/cross-source/);
    expect(v.flag).toHaveLength(1);
    expect(v.survivor).toBeTruthy();
  });

  it("the same externalId within ONE source also clusters (an upsert that did not hold)", () => {
    const v = classifyCollision([
      row({ id: "cardhedge::555", source: "cardhedge", sourceExternalId: "555", title: "long descriptive title" }),
      row({ id: "cardhedge::555b", source: "cardhedge", sourceExternalId: "555" }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.reason).toMatch(/same-source/);
  });

  it("RETRACTED (D1): sameness no longer WINS over a differing parallel", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the reasoning it carried was:
    // "a shared item id is proof of one physical sale; a parallel disagreement
    // between two rows carrying it is a matcher finding, not a licence to keep
    // the sale twice and double-count it in every FMV."
    //
    // That is right about the arithmetic and wrong about the consequence. Under
    // MODE=apply-true-dupes it resolved a wrong-card ingest by RICHNESS and
    // stamped the loser `dedup-superseded`, destroying the matcher finding it
    // had just named and leaving the surviving row on whichever card scored
    // higher — possibly the wrong one. Contradiction is evidence, and evidence
    // goes to a person. The class is CONFLICTED-DUPE and it is never
    // auto-flagged; see collisionTriage.conflictedDupe.test.ts.
    const v = classifyCollision([
      row({ id: "tca-ebay::555", sourceExternalId: "555", parallel: "Base" }),
      row({ id: "cardhedge::555", source: "cardhedge", sourceExternalId: "555", parallel: "Blue Refractor" }),
    ]);
    expect(v.class).toBe("CONFLICTED-DUPE");
    expect(v.flag).toEqual([]);
    expect(v.axes.map((a: { field: string }) => a.field)).toEqual(["parallel"]);
  });

  it("a third row with its own id is left alone while the shared pair clusters", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::555", sourceExternalId: "555" }),
      row({ id: "cardhedge::555", source: "cardhedge", sourceExternalId: "555" }),
      row({ id: "tca-ebay::999", sourceExternalId: "999" }),
    ]);
    expect(v.class).toBe("TRUE-DUPE");
    expect(v.flag).toHaveLength(1);
    // the unrelated third sale is neither survivor nor flagged
    expect(v.flag.map((r: Row) => r.id)).not.toContain("tca-ebay::999");
  });
});

describe("DISTINCT-CARDS — what the retracted \" Refractor\" strip squashed", () => {
  it("\"Uncommon\" and \"Uncommon Refractor\" are two cards, never collapsed", () => {
    // Topps Finest #197 lists both as separate checklist cards. The retracted
    // normParallel strip made them hash identically inside one partition.
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", parallel: "Uncommon" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", parallel: "Uncommon Refractor" }),
    ]);
    expect(v.class).toBe("DISTINCT-CARDS");
    expect(v.flag).toHaveLength(0);          // never excluded
    expect(v.relocate).toHaveLength(2);      // moved instead
  });

  it("it NAMES the collapsed axis and both values, so the report is actionable", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", parallel: "Uncommon" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", parallel: "Uncommon Refractor" }),
    ]);
    expect(v.reason).toMatch(/parallel/);
    const axis = v.axes.find((a: { field: string }) => a.field === "parallel");
    expect(axis.values).toEqual(expect.arrayContaining(["Uncommon", "Uncommon Refractor"]));
  });

  it("a differing grade is a distinct card too — a raw and a PSA 10 are two sales", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", gradeCompany: null }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    expect(v.class).toBe("DISTINCT-CARDS");
    expect(v.reason).toMatch(/gradeCompany/);
  });

  it("a differing cardNumber is a distinct card", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::111", sourceExternalId: "111", cardNumber: "197" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222", cardNumber: "198" }),
    ]);
    expect(v.class).toBe("DISTINCT-CARDS");
    expect(v.reason).toMatch(/cardNumber/);
  });

  it("collapsedAxes reads RAW values — it must NOT normalize the difference away", () => {
    const axes = collapsedAxes([{ parallel: "Uncommon" }, { parallel: "Uncommon Refractor" }]);
    expect(axes.map((a: { field: string }) => a.field)).toContain("parallel");
  });

  it("case and whitespace alone are NOT a distinct card", () => {
    const axes = collapsedAxes([{ parallel: "Blue  Refractor" }, { parallel: "blue refractor" }]);
    expect(axes).toHaveLength(0);
  });
});

describe("AMBIGUOUS is never auto-acted on", () => {
  it("CardHedge's two id shapes share no listing id, so they cannot be proven either way", () => {
    // `ch-daily::<price_history_id>` vs the composed
    // `ch-comp::<cardId>::<soldAt>::<cents>` — the composed shape carries no
    // listing id to recover, so no comparison can prove sameness. That lane is
    // collapse-ch-dual-ids.cjs, which refuses on parallel/grade variance.
    const v = classifyCollision([
      row({ id: "cardhedge::ch-daily::77", source: "cardhedge", sourceExternalId: "ch-daily::77" }),
      row({ id: "cardhedge::ch-comp::x", source: "cardhedge", sourceExternalId: "ch-comp::hiq:x::2026-08-14::999" }),
    ]);
    expect(v.class).toBe("AMBIGUOUS");
    expect(v.flag).toHaveLength(0);
    expect(v.relocate).toHaveLength(0);
  });

  it("a row with NO external id is never flagged — absence of evidence is not proof", () => {
    const v = classifyCollision([
      row({ id: "a", sourceExternalId: null }),
      row({ id: "b", sourceExternalId: "" }),
    ]);
    expect(v.class).toBe("AMBIGUOUS");
    expect(v.reason).toMatch(/carry-none/);
    expect(v.flag).toHaveLength(0);
  });

  it("a single row is not a collision", () => {
    expect(classifyCollision([row()]).class).toBe("AMBIGUOUS");
  });
});

describe("richest-row survivor (mutation-confirmed, and it stays)", () => {
  it("a real item id outranks a synthetic holding:: stand-in", () => {
    // CF-A-REAL-ID-OUTRANKS-A-SYNTHETIC-ONE: the row keyed by the eBay id IS
    // the transaction; `holding::` is our own placeholder for it.
    const real = row({ id: "real", sourceExternalId: "555" });
    const synthetic = row({ id: "synth", sourceExternalId: "holding::abc" });
    expect(pickSurvivor([synthetic, real]).id).toBe("real");
  });

  it("a user-verified row outranks everything", () => {
    const verified = row({ id: "verified", verifiedByUser: true, sourceExternalId: "holding::abc" });
    const rich = row({ id: "rich", sourceExternalId: "555", playerName: "X", imageUrl: "u", team: "T" });
    expect(pickSurvivor([rich, verified]).id).toBe("verified");
  });

  it("the fuller row wins on fill when the id shapes match", () => {
    const sparse = row({ id: "sparse" });
    const full = row({ id: "full", playerName: "Caleb Williams", imageUrl: "u", team: "CHI", setName: "Topps Chrome", cardYear: 2024 });
    expect(pickSurvivor([sparse, full]).id).toBe("full");
  });

  it("ties break to the EARLIEST observed — the record closest to the sale", () => {
    const early = row({ id: "early", observedAt: "2026-08-15T01:00:00Z" });
    const late = row({ id: "late", observedAt: "2026-08-20T01:00:00Z" });
    expect(pickSurvivor([late, early]).id).toBe("early");
  });

  it("the survivor is deterministic when everything ties", () => {
    const a = row({ id: "aaa", observedAt: "2026-08-15T01:00:00Z" });
    const b = row({ id: "bbb", observedAt: "2026-08-15T01:00:00Z" });
    expect(pickSurvivor([b, a]).id).toBe(pickSurvivor([a, b]).id);
  });

  it("the survivor is never itself in the flag list", () => {
    const v = classifyCollision([
      row({ id: "tca-ebay::555", sourceExternalId: "555" }),
      row({ id: "cardhedge::555", source: "cardhedge", sourceExternalId: "555" }),
    ]);
    expect(v.flag.map((r: Row) => r.id)).not.toContain(v.survivor.id);
  });
});
