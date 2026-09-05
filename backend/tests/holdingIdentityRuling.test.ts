import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRulingPairs,
  fieldsFromRuledRow,
} from "../scripts/comp-quality/recheck-holding-identity.js";

/**
 * CF-A-HUMAN-MAY-OVERRIDE-A-HUMAN (Drew, 2026-09-05) — MODE=rule.
 *
 * #1811 gave MODE=rederive a gate that refuses to overwrite an identity a
 * human ruled on. That gate is right and stays. It also left a state with no
 * exit: when the derivation is CORRECT and the standing ruling is stale,
 * nothing could say so. Both of #1811's canaries were that shape.
 *
 *   6f4f079b  ruled `...:d24:base:no-auto` on 2026-08-30 -- before #1787
 *             ingested the row that made the real answer reachable. Field
 *             recovery then proved `...:diamond-dominance:no-auto:num-1500`
 *             at exact/0.98 and correctly declined to overwrite him.
 *   277b05a3  stores no cardNumber, so NO derivation reaches its row:
 *             inferSetKeyFromTitle reads its description as "Fleer Metal",
 *             and the only witness naming `metal-universe` is the vendor
 *             suggestion that mispriced it onto Tony Gwynn's neighbour. A
 *             machine cannot get here; the person holding the slab can.
 *
 * The danger this mode uniquely creates is a ruling that names a card which
 * does not exist, or one built from our own sales. Most pins below are about
 * what it REFUSES.
 */

describe("the ruling list is parsed strictly, and a bad entry refuses", () => {
  it("reads `id8=slug` pairs", () => {
    expect(parseRulingPairs([
      "6f4f079b=hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500",
      "277b05a3=hiq:baseball:1997:metal-universe:8:magnetic-field:no-auto",
    ])).toEqual([
      { hid: "6f4f079b", slug: "hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500" },
      { hid: "277b05a3", slug: "hiq:baseball:1997:metal-universe:8:magnetic-field:no-auto" },
    ]);
  });

  it("REFUSES a bare id — that spelling means MODE=rederive", () => {
    // feedback_scope_formats_are_per_script, exactly: `years=2018-2019` became
    // ALL in a comma-list script. A bare id here would read a rederive scope
    // as a ruling onto an empty destination, and the operator would believe a
    // card was ruled when it was not.
    expect(() => parseRulingPairs(["6f4f079b"])).toThrow(/bare id/i);
    expect(() => parseRulingPairs(["6f4f079b=hiq:x", "277b05a3"])).toThrow(/bare id/i);
  });

  it("REFUSES a destination that is not a hiq: slug", () => {
    // The Ripken holding's stored cardId is `1675907831540x230095593572250400`
    // — a Bubble id. A ruling names a canonical catalog id, never a vendor id.
    expect(() => parseRulingPairs(["277b05a3=1675907831540x230095593572250400"])).toThrow(/not a hiq: slug/i);
    expect(() => parseRulingPairs(["277b05a3=1997 Metal Universe Magnetic Field"])).toThrow(/not a hiq: slug/i);
  });

  it("REFUSES an empty list and an empty half", () => {
    expect(() => parseRulingPairs([])).toThrow(/no rulings/i);
    expect(() => parseRulingPairs(["=hiq:baseball:1997:x:8:base:no-auto"])).toThrow(/no holding id/i);
    expect(() => parseRulingPairs(["277b05a3="])).toThrow(/names no destination/i);
  });

  it("REFUSES the same holding twice — one card, one ruling", () => {
    expect(() => parseRulingPairs([
      "277b05a3=hiq:baseball:1997:metal-universe:8:magnetic-field:no-auto",
      "277b05a3=hiq:baseball:1997:metal-universe:8:base:no-auto",
    ])).toThrow(/twice/i);
  });

  it("MUTATION: a parser that skipped bad entries would silently half-apply", () => {
    // THE DAMAGE, STATED IN ITS REAL SHAPE. Four rulings dispatched, one
    // mistyped: a parser that skips returns THREE pairs and a green run, and
    // the operator believes all four cards moved. So the pin is that a list
    // with a bad entry NEVER yields a short list — it throws.
    const threeGoodOneBad = [
      "aaaaaaaa=hiq:baseball:1999:x:1:base:no-auto",
      "bbbbbbbb=hiq:baseball:1999:x:2:base:no-auto",
      "cccccccc",                                        // the typo
      "dddddddd=hiq:baseball:1999:x:4:base:no-auto",
    ];
    expect(() => parseRulingPairs(threeGoodOneBad)).toThrow(/bare id/i);
    // Each malformed shape, mixed into an otherwise-valid list.
    for (const bad of ["cccccccc", "cccccccc=notaslug", "cccccccc=", "=hiq:baseball:1999:x:3:base:no-auto"]) {
      expect(() => parseRulingPairs([threeGoodOneBad[0], bad]), bad).toThrow();
    }
  });
});

describe("a ruled row dictates the CARD, and only fills blanks", () => {
  /** The live row for Drew's D24 ruling, read from card_catalog 2026-09-05. */
  const D24_ROW = {
    setName: "Black Diamond", cardNumber: "D24",
    parallel: "Diamond Dominance", printRun: 1500,
  };
  /** The live row for the Ripken ruling. */
  const RIPKEN_ROW = {
    setName: "1997 Metal Universe Magnetic Field", cardNumber: "8",
    parallel: "Magnetic Field", printRun: null,
  };

  it("fills the Ripken holding's three blank fields from the ruled row", () => {
    // 277b05a3 stores no setName, no cardNumber, no parallel — which is why
    // the matcher threw before reaching the catalog at all.
    const fills = fieldsFromRuledRow(
      { playerName: "Cal Ripken, Jr.", cardYear: 1997, gradeCompany: "PSA", gradeValue: 8 },
      RIPKEN_ROW);
    expect(fills.map((f) => f.field).sort()).toEqual(["cardNumber", "parallel", "setName"]);
    expect(fills.find((f) => f.field === "cardNumber")?.value).toBe("8");
    expect(fills.find((f) => f.field === "parallel")?.value).toBe("Magnetic Field");
    // No printRun on this row, so none is invented.
    expect(fills.some((f) => f.field === "printRun")).toBe(false);
  });

  it("NEVER overwrites a field the user set — D24 keeps its own strings", () => {
    // THE GUARD THAT MATTERS. 6f4f079b already states setName, cardNumber and
    // printRun; the ruling settles WHICH CARD, and the owner's own typing is
    // still the better witness for the rest. Only its blank `parallel` is
    // filled — and the holding stores "Base" there, which is NOT blank, so
    // even that is left alone. The ruling moves the identity, not the text.
    const holding = {
      setName: "1999 Upper Deck Black Diamond", product: "Black Diamond",
      cardNumber: "D24", parallel: "Base", printRun: 1500,
    };
    expect(fieldsFromRuledRow(holding, D24_ROW)).toEqual([]);
  });

  it("fills a blank parallel but not a stated one", () => {
    expect(fieldsFromRuledRow({ setName: "x", cardNumber: "D24", parallel: null, printRun: 1500 }, D24_ROW)
      .map((f) => f.field)).toEqual(["parallel"]);
    expect(fieldsFromRuledRow({ setName: "x", cardNumber: "D24", parallel: "Base", printRun: 1500 }, D24_ROW))
      .toEqual([]);
    // Whitespace is blank; a value is not.
    expect(fieldsFromRuledRow({ setName: "x", cardNumber: "D24", parallel: "   ", printRun: 1500 }, D24_ROW)
      .map((f) => f.field)).toEqual(["parallel"]);
  });

  it("never touches playerName or any grade field", () => {
    // Drew's ruling says so, and the reason outlives the instruction: the
    // row's player is a transcription and the holding's is what the owner
    // calls their card; the grade belongs to the slab in hand.
    const fills = fieldsFromRuledRow({}, {
      ...RIPKEN_ROW, ...({ playerName: "Cal Ripken Jr.", gradeValue: 10 } as any),
    } as any);
    for (const f of fills) {
      expect(["setName", "cardNumber", "parallel", "printRun"]).toContain(f.field);
    }
  });

  it("MUTATION: a fill that ignored blankness would rewrite the user's fields", () => {
    // With the blank check gone, D24's own "1999 Upper Deck Black Diamond"
    // becomes the row's "Black Diamond" and its "Base" becomes "Diamond
    // Dominance" — the pass would be editing text the owner typed.
    const holding = {
      setName: "1999 Upper Deck Black Diamond", cardNumber: "D24",
      parallel: "Base", printRun: 1500,
    };
    expect(fieldsFromRuledRow(holding, D24_ROW).length).toBe(0);
  });
});

describe("MODE=rule refuses a destination it may not name", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf8");

  it("GATE R1 — the row must EXIST, read back by id", () => {
    expect(SRC).toMatch(/GATE R1/);
    expect(SRC).toMatch(/no catalog row carries/);
  });

  it("GATE R2 — the row must be CHECKLIST-BACKED, by the catalog's own test", () => {
    // canAdjudicate is what the catalog uses to decide which row may
    // adjudicate a card. Verified live 2026-09-05: baseballcardpedia and
    // sportscardchecklist pass; holding-seeded-*, sales-attested,
    // ingest-auto-seed and cardhedge do not. Ruling onto one of those would
    // pin a user's card to a row built from our own sales.
    expect(SRC).toMatch(/GATE R2/);
    expect(SRC).toMatch(/if \(!canAdjudicate\(source\)\)/);
    expect(SRC).toContain('from "../../src/services/catalog/catalogAuthority.service.js"');
  });

  it("a REFUSED ruling exits non-zero", () => {
    // A dispatch of four rulings where one was a typo must not read as
    // success (feedback_gate_merges_on_exit_codes).
    expect(SRC).toMatch(/verdict === "REFUSED"\)\) process\.exit\(6\)/);
  });

  it("refuses the WHOLE list when a ruled holding matches nothing", () => {
    // A partial run that reads as a complete one is the failure; three of four
    // applied silently would leave the operator believing all four moved.
    expect(SRC).toMatch(/ruled holding\(s\) matched NOTHING/);
    expect(SRC).toMatch(/matches more than one holding/);
  });

  it("writes are etag-guarded and verified by re-read", () => {
    // feedback_green_workflow_is_not_data_flow. The reconciliation asserts the
    // identity AND the ruling stamp AND every filled field.
    expect(SRC).toMatch(/accessCondition: \{ type: "IfMatch", condition: etag! \}/);
    expect(SRC).toMatch(/RECONCILIATION: re-reading/);
    expect(SRC).toMatch(/got === v\.to && h\?\.identityResolvedBy === RULING_ID && !badFill/);
  });

  it("stamps the ruling and what it superseded", () => {
    for (const field of [
      "identityResolvedBy", "identityResolvedAt",
      "identityRederivedFrom", "identityRederivedAt", "identityRederivedBy",
      "identityRulingSupersedes", "identityRuledFields",
    ]) expect(SRC, field).toContain(field);
    expect(SRC).toMatch(/RULING_ID = String\(process\.env\.RULING_ID \?\? "ruling:Drew:2026-09-05"\)/);
  });
});

describe("the asymmetry: only MODE=rule may override a human", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf8");

  it("MODE=rederive still stands down on a ruled row", () => {
    // #1811's GATE 4, untouched. A script overriding a human is the failure it
    // was built against; a human overriding a human is a decision.
    expect(SRC).toMatch(/GATE 4/);
    expect(SRC).toMatch(/recovery\?\.userAuthored/);
    expect(SRC).toMatch(/a human's identity is never overwritten by this pass/);
  });

  it("MODE=rule is a separate branch that never consults the matcher", () => {
    // The slug is dictated, so there is nothing to derive. `rule` takes no
    // `canonicalize` at all — which is why no derivation gate can be
    // accidentally skipped here: there is no derivation.
    expect(SRC).toMatch(/const RULE = MODE === "rule"/);
    expect(SRC).toMatch(/await rule\(\{ docs: resources as any\[\], container: c, catalog: catalogReadOnly \}\)/);
    const ruleFn = SRC.slice(SRC.indexOf("async function rule("));
    expect(ruleFn).not.toContain("canonicalize");
  });

  it("MUTATION: rederive's gate and rule's override are independent", () => {
    // If MODE=rule's write were folded into the rederive path, the ruled-row
    // gate would have to be loosened to let it through -- and every DERIVED
    // verdict would then be able to overwrite a human too. They are separate
    // functions precisely so that cannot happen.
    expect(SRC).toMatch(/async function rederive\(/);
    expect(SRC).toMatch(/async function rule\(/);
  });
});

describe("the runner shim carries MODE=rule through", () => {
  const SHIM = readFileSync(
    join(__dirname, "..", "scripts", "rederive-holding-identity.cjs"), "utf8");

  it("never overwrites an explicit MODE", () => {
    // The shim defaults to rederive; a dispatch that says `rule` must reach
    // the script as `rule`.
    expect(SHIM).toMatch(/if \(!String\(env\.MODE \?\? ""\)\.trim\(\)\) env\.MODE = "rederive"/);
  });

  it("documents the id8=slug format the mode requires", () => {
    expect(SHIM).toMatch(/MODE=rule/);
    expect(SHIM).toMatch(/id8=slug/);
    expect(SHIM).toMatch(/RULING_ID/);
  });

  it("preserves the child's exit code, so a REFUSED ruling fails the workflow", () => {
    expect(SHIM).toMatch(/process\.exit\(r\.status === null \? 3 : r\.status\)/);
  });
});
