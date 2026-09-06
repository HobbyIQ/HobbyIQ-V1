/**
 * CF-BOWMAN-CHROME-DRAFT-KEEPS-DRAFT, applied to the Great Rematch.
 * THE RULED SIBLING PAIR — `bowman-chrome` -> `bowman-draft` on a DRAFT title.
 *
 * THE ROWS THAT MOTIVATED IT. #1911's census found 10,146 sold_comps rows
 * (2019–2026; 2023: 2,725, 2024: 3,208, 2025: 1,526) sitting on `bowman-chrome`
 * slugs whose OWN TITLE says "Chrome Draft". The parser used to read those
 * titles as `bowman-chrome` — DRAFT was dropped — and the stored slug is that
 * stale answer. #1911 fixed the parser in both word orders. This is the other
 * half: letting the rematch REACH the rows the parser fix was landed for.
 *
 * WHY THE LADDER COULD NOT. SPECIALIZATION-STATED's L1 asks whether the derived
 * key is a strict DESCENDANT of the stored one. `bowman-chrome` and
 * `bowman-draft` are SIBLINGS under `bowman`, so L1 fails BY CONSTRUCTION and
 * every one of those rows classifies CONFLICT changed:setKey — the same shape
 * #1715 hit and the Tiffany ruling resolved for that family.
 *
 * WHY NOT `RULED_COLLAPSE_PAIRS`. That table is the REFUSAL half: every pair in
 * it is a collapse `derivationCollapsesProduct` refuses, and
 * rematchCollapseAndCoverage.test.ts pins `writable === false` for each. Putting
 * this pair there would HARDEN the CONFLICT rather than lift it. The last block
 * in this file pins that invariant still holds, so the two tables cannot be
 * confused for one another later.
 *
 * THE THREE LOAD-BEARING PINS:
 *
 *   1. THE TITLE GATE IS THE PARSER'S OWN RULE. `titleSpellsBowmanDraft` has
 *      exactly one definition (parseTitleIdentity.service.ts) and the
 *      classifier reaches it through a bridge onto the compiled build. A second
 *      regex here would be free to drift by a word — which means moving real
 *      sales between two products' pools, and on CPA-DT onto another PERSON's
 *      card (Diego Tornes in bowman-chrome, Devin Taylor in bowman-draft).
 *   2. IT IS ONE-DIRECTIONAL. A row already on `bowman-draft` whose title says
 *      only "Bowman Chrome" is NOT moved back. The stale-slug population runs
 *      one way.
 *   3. L5 STILL PROTECTS THE COLLISION. Bowman Draft runs its own numbering, so
 *      the pair is deliberately NOT a same-number parallel set: the stored
 *      flagship's checklist is still asked whether it lists this card, and a
 *      YES still refuses.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { productAncestry, productEntry, PRODUCT_SET_KEYS } from "../src/services/catalog/productSetKeys.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle, titleSpellsBowmanDraft } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");
const CLASSIFIER_SRC = readFileSync(new URL("../scripts/lib/rematch-classify.cjs", import.meta.url), "utf8");

// ── fixtures ────────────────────────────────────────────────────────────────

/** The spelling that names the product — the #1860 shape. */
const DRAFT_TITLE = "2023 Bowman Chrome Draft #BDC-100 Gage Wood Refractor";
/** The line the rule must NOT cross: prose about the EVENT, not the product. */
const MLB_DRAFT_PROSE = "2023 Bowman Chrome Aaron Judge 2023 MLB Draft Pick RC Refractor";
/** A plain Bowman Chrome card — no Draft anywhere. */
const CHROME_ONLY = "2023 Bowman Chrome Refractor Auto Diego Tornes #BDC-100";

/**
 * THE DESTINATION IS `bowman-draft`, NOT `bowman-draft-chrome`, and that is a
 * MEASURED fact rather than a simplification: the parser answers the NAME
 * "Bowman Draft Chrome" for these titles, and `normalizeSetKey` folds that to
 * `bowman-draft`. The classifier only ever sees normalized keys.
 *
 * THE PARALLEL IS `Refractor` FOR THE SAME KIND OF REASON. A Chrome Draft sale
 * is a chrome-stock card and its title says so, and the pre-existing IMPROVE
 * guard `improve-title-states-a-finish-over-a-base-destination` refuses a
 * write whose destination parallel is Base while the title names a finish.
 * That guard is untouched by this ruling and still fires — pinned below — so
 * the fixture uses the shape the population actually has.
 */
const ID = {
  sport: "baseball", cardYear: 2023, setKey: "bowman-chrome", cardNumber: "BDC-100",
  parallel: "Refractor", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
};

type Opts = { flagshipLists?: boolean | null; derivedBackedStrict?: boolean };
const argsFor = (title: string, storedSetKey: string, derivedSetKey: string, o: Opts = {}) => ({
  row: { id: "sale-1", title, source: "tca-ebay" },
  stored: { ...ID, setKey: storedSetKey },
  derived: { ...ID, setKey: derivedSetKey },
  checklistBacked: true,
  derivedBackedStrict: o.derivedBackedStrict !== false,
  storedFlagshipListsCardNumber: o.flagshipLists === undefined ? false : o.flagshipLists,
});
const classify = (title: string, stored: string, derived: string, o: Opts = {}) =>
  K.classifyRow(argsFor(title, stored, derived, o));

// ── 1. the table itself ─────────────────────────────────────────────────────

describe("the ruled sibling pair is declared, one-directional, and gated", () => {
  it("bowman-chrome -> bowman-draft is ruled, with the measured row count", () => {
    const pair = K.ruledSiblingPair("bowman-chrome", "bowman-draft");
    expect(pair).toBeTruthy();
    expect(pair.ruled).toBe(true);
    // #1911's census: 10,146 rows on bowman-chrome slugs whose title says Draft.
    expect(pair.est).toBe(10146);
    expect(pair.titleGate).toBe("titleSpellsBowmanDraft");
  });

  it("the registered children of the destination are accepted, and they are productSetKeys' own", () => {
    for (const child of K.RULED_SIBLING_PAIRS[0].toChildren) {
      expect(K.ruledSiblingPair("bowman-chrome", child), child).toBeTruthy();
      // the mirror is a cache: the child's parent really is bowman-draft
      expect(productEntry(child)?.parent, child).toBe("bowman-draft");
    }
    expect(K.RULED_SIBLING_PAIRS[0].toChildren).toContain("bowman-draft-sapphire");
  });

  it("EVERY declared destination is a normalizeSetKey FIXED POINT — bowman-draft-chrome is not, and is absent", () => {
    // THE MEASUREMENT THAT SHAPED THIS TABLE. `bowman-draft-chrome` is a real
    // productSetKeys.ts entry and the parser answers the NAME "Bowman Draft
    // Chrome" for exactly the titles this ruling is about — but
    // `normalizeSetKey("bowman-draft-chrome")` is `bowman-draft`, so no stored
    // or derived identity in the corpus can ever carry it. `storedIdentity`
    // and the deriver both normalize; every one of these titles arrives at the
    // classifier as `bowman-draft`.
    //
    // A ruled key that is not a fixed point is not a ruling, it is a rename
    // waiting to fire (project_pokemon_ja_vocab_rulings). Listing it as a
    // destination would read as coverage and do nothing.
    expect(normalizeSetKey("bowman-draft-chrome")).toBe("bowman-draft");
    for (const pair of K.RULED_SIBLING_PAIRS) {
      expect(normalizeSetKey(pair.from), pair.from).toBe(pair.from);
      expect(normalizeSetKey(pair.to), pair.to).toBe(pair.to);
      for (const child of pair.toChildren) {
        expect(normalizeSetKey(child), child).toBe(child);
      }
    }
  });

  it("and the parser's own answer for these titles normalizes onto the declared destination", () => {
    // The end-to-end fact the table depends on: the NAME the parser returns
    // for a Chrome Draft title normalizes to the key this pair moves rows to.
    expect(normalizeSetKey(inferSetKeyFromTitle(DRAFT_TITLE))).toBe("bowman-draft");
    expect(normalizeSetKey(inferSetKeyFromTitle("2025 Bowman Chrome Draft Sapphire Gage Wood")))
      .toBe("bowman-draft-sapphire");
  });

  it("an unregistered key in the family does NOT ride this door", () => {
    // bowman-draft-picks-and-prospects is parented to `bowman`, not
    // `bowman-draft`, and is not a declared child of this pair.
    expect(K.ruledSiblingPair("bowman-chrome", "bowman-draft-picks-and-prospects")).toBeNull();
    expect(K.ruledSiblingPair("bowman-chrome", "bowman-sterling")).toBeNull();
  });

  it("THE PAIR IS ONE-DIRECTIONAL — the reverse direction is not declared", () => {
    expect(K.ruledSiblingPair("bowman-draft", "bowman-chrome")).toBeNull();
    expect(K.ruledSiblingMove("bowman-draft", "bowman-chrome", CHROME_ONLY)).toBeNull();
  });

  it("every declared gate names a function this module BRIDGES", () => {
    for (const pair of K.RULED_SIBLING_PAIRS) {
      expect(typeof K.SIBLING_TITLE_GATES[pair.titleGate], pair.titleGate).toBe("function");
    }
  });
});

// ── 2. the title gate is the parser's ONE rule ──────────────────────────────

describe("the title gate has exactly one definition", () => {
  it("the classifier's gate and the parser's predicate answer identically", () => {
    // Not a re-implementation compared against another re-implementation: the
    // classifier BRIDGES the compiled parser, and this asserts the bridge is
    // wired to the rule the parser actually uses.
    for (const t of [
      DRAFT_TITLE, MLB_DRAFT_PROSE, CHROME_ONLY,
      "2025 Bowman Chrome Draft 1st Refractor Auto /499 Devin Taylor #CPA-DT",
      "2025 Bowman Draft Chrome Gage Wood",
      "2025 Bowman Chrome Refractor Draft Night Auto Judge",
      "Bowman 2025 Chrome Draft Gage Wood",
    ]) {
      expect(K.SIBLING_TITLE_GATES.titleSpellsBowmanDraft(t), t).toBe(titleSpellsBowmanDraft(t));
    }
  });

  it("the classifier keeps NO second copy of the rule", () => {
    // The whole point of the bridge. If this goes red somebody inlined the
    // adjacency test here, and the two copies are now free to drift.
    expect(CLASSIFIER_SRC).toContain('require("./bowman-draft-title.cjs")');
    expect(CLASSIFIER_SRC).not.toContain("chrome\\s+draft");
    expect(CLASSIFIER_SRC).not.toContain("draft\\s+chrome");
  });

  it("the parser itself still reads both word orders (the #1911 contract)", () => {
    expect(inferSetKeyFromTitle(DRAFT_TITLE)).toBe("Bowman Draft Chrome");
    expect(inferSetKeyFromTitle("2025 Bowman Draft Chrome Gage Wood")).toBe("Bowman Draft Chrome");
    expect(inferSetKeyFromTitle(MLB_DRAFT_PROSE)).toBe("Bowman Chrome");
  });

  it("the predicate demands DRAFT ADJACENT to chrome — that adjacency IS the safety", () => {
    expect(titleSpellsBowmanDraft(DRAFT_TITLE)).toBe(true);
    expect(titleSpellsBowmanDraft("2025 Bowman Draft Chrome Gage Wood")).toBe(true);
    // the event, not the product
    expect(titleSpellsBowmanDraft(MLB_DRAFT_PROSE)).toBe(false);
    expect(titleSpellsBowmanDraft("2025 Bowman Chrome Refractor Draft Night Auto Judge")).toBe(false);
    // no bowman at all
    expect(titleSpellsBowmanDraft("2025 Topps Chrome Draft Pick")).toBe(false);
    expect(titleSpellsBowmanDraft(null)).toBe(false);
  });
});

// ── 3. THE TABLE-DRIVEN VERDICTS ────────────────────────────────────────────

describe("TABLE: what each title does to a bowman-chrome row", () => {
  it.each([
    [DRAFT_TITLE, "bowman-chrome", "bowman-draft", "IMPROVE", true,
      "a DRAFT-stated row moves to the Draft product"],
    [MLB_DRAFT_PROSE, "bowman-chrome", "bowman-draft", "CONFLICT", false,
      "prose about the MLB draft is NOT the product"],
    [CHROME_ONLY, "bowman-draft", "bowman-chrome", "CONFLICT", false,
      "ONE-DIRECTIONAL: a Draft row is not moved back to Chrome"],
  ])("%s (%s -> %s) is %s writable=%s — %s",
    (title, stored, derived, klass, writable) => {
      const res = classify(title as string, stored as string, derived as string);
      expect(res.klass).toBe(klass);
      expect(res.writable).toBe(writable);
    });

  it("the qualifying row names its subclass, its pair and the word the title stated", () => {
    const res = classify(DRAFT_TITLE, "bowman-chrome", "bowman-draft");
    expect(res.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(res.reasons.join(" ")).toContain("specialization:bowman-chrome->bowman-draft");
    expect(res.reasons.join(" ")).toContain("title-states:draft");
  });

  it("THE VERDICT CLASS IS THE ORDINARY IMPROVE — armed by scope=improve, no new scope", () => {
    // The ruling reuses SPECIALIZATION-STATED deliberately: it has no entry in
    // `applyKindOf`'s subclass ladder, so it falls to IMPROVE and the fleet
    // dispatch that already says scope=improve arms it. No new scope value and
    // no new workflow input — GitHub caps workflow_dispatch at 25 and 24 are used.
    const res = classify(DRAFT_TITLE, "bowman-chrome", "bowman-draft");
    expect(K.applyKindOf(res)).toBe(K.IMPROVE);
    const scope = K.parseApplyScope("improve");
    expect(scope.ok).toBe(true);
    expect(K.writableUnderScope(res, scope.classes)).toBe(true);
    // ...and the three 2026-09-06 ruled scopes are untouched by this ruling.
    expect(scope.classes.has(K.GRADE_FROM_TITLE)).toBe(false);
    expect(scope.classes.has(K.YEAR_FROM_TITLE_VINTAGE)).toBe(false);
    expect(scope.classes.has(K.SPORT_FROM_PRODUCT)).toBe(false);
  });
});

// ── 4. L2–L5 still hold ─────────────────────────────────────────────────────

describe("L2–L5 are unchanged — the sibling door widens L1 and nothing else", () => {
  it("L5: if the STORED flagship's checklist lists this number, the move is REFUSED", () => {
    // THE COLLISION THIS PROTECTS. cpa-dt is Diego Tornes in bowman-chrome and
    // Devin Taylor in bowman-draft. A row whose number the stored product
    // really does list is not moved on a title alone.
    const res = classify(DRAFT_TITLE, "bowman-chrome", "bowman-draft", { flagshipLists: true });
    expect(res.klass).toBe("CONFLICT");
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-checklist-lists-this-card");
  });

  it("L5: an UNANSWERED coverage question is a refusal — absent beats wrong", () => {
    const res = classify(DRAFT_TITLE, "bowman-chrome", "bowman-draft", { flagshipLists: null });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-coverage-unknown");
  });

  it("L3: without a REAL scraped checklist for the destination, the move is refused", () => {
    const res = classify(DRAFT_TITLE, "bowman-chrome", "bowman-draft", { derivedBackedStrict: false });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("derived-not-checklist-backed");
  });

  it("the pair is deliberately NOT a same-number parallel set", () => {
    // Bowman Draft runs its own BDC-/CPA- numbering against the flagship's, so
    // the number still carries information and L5 must keep asking. Declaring
    // it here would switch L5 off and lose the collision protection above.
    expect(K.isSameNumberParallelSet("bowman-draft", "bowman-chrome")).toBe(false);
    expect(K.isSameNumberParallelSet("bowman-draft-sapphire", "bowman-chrome")).toBe(false);
  });

  it("the FINISH guard is untouched: a Base destination under a Chrome title is still refused", () => {
    // The pre-existing `improve-title-states-a-finish-over-a-base-destination`
    // guard is not weakened by this ruling, and it is the reason the fixtures
    // above carry parallel=Refractor. A Chrome Draft title over a BASE
    // destination may have dropped the parallel, so it is reported, not
    // written — the row still promotes to the subclass and still does not
    // become writable.
    const res = K.classifyRow({
      row: { id: "r", title: DRAFT_TITLE, source: "tca-ebay" },
      stored: { ...ID, setKey: "bowman-chrome", parallel: "Base" },
      derived: { ...ID, setKey: "bowman-draft", parallel: "Base" },
      checklistBacked: true, derivedBackedStrict: true, storedFlagshipListsCardNumber: false,
    });
    expect(res.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("improve-title-states-a-finish-over-a-base-destination");
  });
});

// ── 5. the mirror is a cache — the black-diamond shape must not recur ────────

describe("the mirrored ladder agrees with productSetKeys.ts for EVERY declared parent", () => {
  it("bowman-draft and its children are mirrored, with their TABLE parents", () => {
    expect(K.SPECIALIZATION_PARENTS["bowman-draft"]).toBe("bowman");
    expect(productEntry("bowman-draft")?.parent).toBe("bowman");
    expect(productAncestry("bowman-draft")).toContain("bowman");
    for (const child of ["bowman-draft-paper", "bowman-draft-sapphire"]) {
      expect(K.SPECIALIZATION_PARENTS[child], child).toBe("bowman-draft");
      expect(productEntry(child)?.parent, child).toBe("bowman-draft");
    }
    // ...and `bowman-draft-chrome` is deliberately NOT mirrored, because it is
    // not a normalizeSetKey fixed point. Mirroring it would put a key in the
    // ladder that no row can ever carry, and would go red against the
    // "every mirrored key is a FIXED POINT" pin in
    // rematchSpecializationStated.test.ts — which is exactly the guard working.
    expect(K.SPECIALIZATION_PARENTS["bowman-draft-chrome"]).toBeUndefined();
  });

  it("THE upper-deck-black-diamond SHAPE MUST NOT RECUR: every mirrored key matches the table", () => {
    // The mirror is a CACHE of productSetKeys.ts, and a mirror nobody compares
    // is a second source of truth. `upper-deck-black-diamond` was a declared
    // distinct product, a ruled collapse pair and a productSetKeys entry —
    // every table but the mirror — so `specializationAncestry` returned [] and
    // L1 failed on rows every other table agreed about. `bowman-draft` was the
    // same shape. This asserts the direction that catches the NEXT one.
    for (const key of K.LADDER_MIRRORED_KEYS) {
      expect(productEntry(key)?.parent, `mirror key ${key}`).toBe(K.SPECIALIZATION_PARENTS[key]);
    }
  });

  it("every key this ruling can MOVE A ROW ONTO is mirrored — no silent [] ancestry", () => {
    // The destinations of every ruled sibling pair, and every registered child.
    // A destination missing from the mirror is exactly the black-diamond bug:
    // declared everywhere except the one table L1 reads.
    for (const pair of K.RULED_SIBLING_PAIRS) {
      for (const key of [pair.to, ...pair.toChildren]) {
        expect(K.SPECIALIZATION_PARENTS[key], `destination ${key} is not mirrored`).toBeTruthy();
        expect(K.specializationAncestry(key).length, `ancestry of ${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("and the mirror carries no key productSetKeys.ts contradicts", () => {
    // The other direction of the same equality: a mirrored key whose table
    // entry names a DIFFERENT parent would admit a wider move than the ruling.
    const declared = new Map(
      PRODUCT_SET_KEYS.filter((p) => p.parent).map((p) => [p.setKey, p.parent as string]),
    );
    for (const [key, parent] of Object.entries(K.SPECIALIZATION_PARENTS as Record<string, string>)) {
      if (!declared.has(key)) continue; // documented exceptions (bowman-tiffany)
      expect(declared.get(key), `mirror ${key}`).toBe(parent);
    }
  });
});

// ── 6. MUTATION — the table is load-bearing ─────────────────────────────────

/** Run `fn` against a mutated copy of the classifier. */
function withMutant<T>(mutate: (src: string) => string, fn: (m: typeof K) => T): T {
  const tmp = fileURLToPath(new URL("../scripts/lib/rematch-classify.__sibling_mutant__.cjs", import.meta.url));
  const mutated = mutate(CLASSIFIER_SRC);
  expect(mutated, "the mutation did not apply").not.toBe(CLASSIFIER_SRC);
  writeFileSync(tmp, mutated);
  try {
    return fn(require_(tmp) as typeof K);
  } finally {
    try { delete require_.cache[require_.resolve(tmp)]; } catch { /* best effort */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

describe("MUTATION CHECK: drop the sibling table and the rows go back to CONFLICT", () => {
  const args = () => argsFor(DRAFT_TITLE, "bowman-chrome", "bowman-draft");

  it("emptying RULED_SIBLING_PAIRS makes the DRAFT-stated row unreachable again", () => {
    const real = K.classifyRow(args());
    expect(real.klass).toBe(K.IMPROVE);
    expect(real.writable).toBe(true);

    const broken = withMutant(
      (src) => src.replace(
        /const RULED_SIBLING_PAIRS = Object\.freeze\(\[[\s\S]*?\n\]\);/,
        "const RULED_SIBLING_PAIRS = Object.freeze([]);",
      ),
      (m) => m.classifyRow(args()),
    );
    // Back to the state #1911 left: the parser reads the title right, and the
    // rematch still cannot move the row.
    expect(broken.klass).toBe("CONFLICT");
    expect(broken.writable).toBe(false);
  });

  it("the SIBLING PAIR is what carries L1 — the mirrored edge cannot rescue the row alone", () => {
    // MEASURED, and worth stating because the two halves of this change look
    // interchangeable and are not.
    //
    // The mirrored `bowman-draft -> bowman` edge is load-bearing for the
    // DESTINATION's ancestry — it is what keeps `specializationAncestry`
    // from returning [], which is the `upper-deck-black-diamond` bug this
    // ruling refuses to reintroduce (pinned in "every key this ruling can MOVE
    // A ROW ONTO is mirrored").
    //
    // But it cannot admit this row on its own: `bowman-chrome` and
    // `bowman-draft` are SIBLINGS under `bowman`, so the ladder has no edge
    // between them in EITHER direction no matter how complete the mirror is.
    // Only the ruled pair opens that door — which is what this mutation shows.
    const noPair = withMutant(
      (src) => src.replace(
        /const RULED_SIBLING_PAIRS = Object\.freeze\(\[[\s\S]*?\n\]\);/,
        "const RULED_SIBLING_PAIRS = Object.freeze([]);",
      ),
      (m) => m.classifyRow(args()),
    );
    expect(noPair.writable).toBe(false);
    expect(noPair.reasons.join(" ")).toContain("changed:setKey");
    // the mirror is still fully intact in that mutant, and the row is still
    // unreachable — so the pair, not the mirror, is what moves it.
    const stillMirrored = withMutant(
      (src) => src.replace(
        /const RULED_SIBLING_PAIRS = Object\.freeze\(\[[\s\S]*?\n\]\);/,
        "const RULED_SIBLING_PAIRS = Object.freeze([]);",
      ),
      (m) => m.SPECIALIZATION_PARENTS["bowman-draft"],
    );
    expect(stillMirrored).toBe("bowman");
  });
});

// ── 7. the refusal table is NOT this table ──────────────────────────────────

describe("RULED_COLLAPSE_PAIRS is the refusal half and stays that way", () => {
  it("this pair was NOT added to the collapse table", () => {
    // Adding it there would harden the CONFLICT rather than lift it — the
    // opposite of the ruling. The two tables read the same ladder in opposite
    // directions and are deliberately separate.
    expect(K.ruledCollapsePair("bowman-chrome", "bowman-draft")).toBeNull();
  });

  it("and its own invariant still holds: every collapse pair is unwritable", () => {
    // The pin rematchCollapseAndCoverage.test.ts carries, restated here so a
    // future edit that confuses the two tables fails in BOTH files.
    for (const pair of K.RULED_COLLAPSE_PAIRS) {
      const res = K.classifyRow({
        row: { id: "r", title: `a ${pair.from} card`, source: "tca-ebay" },
        stored: { ...ID, setKey: pair.from },
        derived: { ...ID, setKey: pair.to },
        checklistBacked: true,
      });
      expect(res.writable, `${pair.from} -> ${pair.to}`).toBe(false);
    }
  });

  it("the Sapphire twin keeps its own direction — draft -> chrome is still a REFUSAL", () => {
    // #1897 declared `bowman-draft-sapphire -> bowman-chrome-sapphire` as a
    // collapse: that direction DROPS the word DRAFT and must stay refused. The
    // new pair runs the other way. Both are true at once, and this pins that
    // the sibling door did not quietly reverse the older ruling.
    expect(K.ruledCollapsePair("bowman-draft-sapphire", "bowman-chrome-sapphire")).toBeTruthy();
    expect(K.ruledSiblingPair("bowman-draft-sapphire", "bowman-chrome-sapphire")).toBeNull();
  });
});
