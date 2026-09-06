/**
 * I9 USES THE ONE CLASSIFIER — the pins (#1878).
 *
 * CF-ONE-CLASSIFICATION-PATH-NOT-TWO. I9's whole value is that it re-derives
 * with the SAME code the census and the apply lane use: a nightly rate measured
 * by a different deriver is a rate about the auditor, and no repair lane can act
 * on it. Run 34027575655 proved it had drifted into being exactly that — on a
 * corpus the 32-shard census measures at 47.1% AGREE, the auditor's shadow
 * re-derivation agreed with NOTHING: 0 AGREE and 0 IMPROVE in 1,797 rows, and
 * 100% of its 1,178 CONFLICT rows carried `filled:setKey,sport`.
 *
 * Three defects, each pinned below:
 *
 *   1. A 10-FIELD PROJECTION STARVED THE CLASSIFIER. `storedIdentity` reads
 *      row.setName (the projection fetched row.setKey — the wrong field),
 *      row.sport, row.isAuto, row.gradeCompany and row.gradeValue;
 *      `provenanceTier` reads row.verifiedByUser, row.rekeyedReason and
 *      row.relocatedReason. All eight arrived undefined, so every row looked
 *      like it had a blank setKey and a blank sport — hence the universal
 *      `filled:setKey,sport`. The fleet reads `SELECT *`.
 *   2. `storedIdentity` WAS CALLED WITHOUT ITS DEPS, so it threw
 *      `Cannot read properties of undefined (reading 'normalizeSetKey')` on
 *      every row carrying a setName.
 *   3. `checklistBacked` WAS HARDCODED FALSE, so the second gate ("a match
 *      proves nothing unless checklist-backed") rejected every
 *      strictly-more-specific row and IMPROVE was unreachable by construction.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INV = require_(path.join(backend, "scripts", "lib", "corpus-invariants.cjs"));
const CLASSIFY = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));
const RM = require_(path.join(backend, "scripts", "rematch-sold-comps.cjs"));

const dist = (...p: string[]) => require_(path.join(backend, "dist", "services", ...p));
const pti = dist("portfolioiq", "parseTitleIdentity.service.js");
const hic = dist("portfolioiq", "hobbyIqCardId.service.js");
const guard = dist("portfolioiq", "slugGuard.service.js");
const pvs = dist("portfolioiq", "persistVendorSalesToPool.service.js");
const slugRe = dist("portfolioiq", "slugRederivation.service.js");

/** The deps the FLEET assembles — not a second wiring. */
const DERIVE_DEPS = {
  parseListingIdentity: pti.parseListingIdentity,
  isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
  inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
  inferSportFromTitle: pti.inferSportFromTitle,
  ingestGradeFromTitle: pvs.ingestGradeFromTitle,
  isMultiCardLot: pti.isMultiCardLot,
  normalizeSetKey: hic.normalizeSetKey,
  computeHobbyIqCardId: hic.computeHobbyIqCardId,
  guardSlugInputs: guard.guardSlugInputs,
  normalizeSportStrict: guard.normalizeSportStrict,
  extractYearFromTitle: slugRe.extractYearFromTitle,
};

type Row = Record<string, unknown>;

/** Classify exactly as the fixed auditor does. */
const classify = (row: Row, checklistBacked = true) =>
  INV.classifyStoredRow(row, CLASSIFY, {
    deriveIdentity: RM.deriveIdentity,
    storedIdentity: RM.storedIdentity,
    deriveDeps: DERIVE_DEPS,
    checklistBacked,
  });

/** THE OLD AUDITOR'S PROJECTION — the mutation these pins defend against. */
const OLD_PROJECTION = ["id", "cardId", "hobbyiqCardId", "title", "source", "parallel", "setKey", "cardYear", "cardNumber", "printRun"];
const starve = (row: Row): Row =>
  Object.fromEntries(OLD_PROJECTION.filter((k) => k in row).map((k) => [k, row[k]]));

const FINEST = "hiq:baseball:2011:topps-finest:94:base:no-auto";
const base = (over: Row = {}): Row => ({
  id: "cardhedge::fixture",
  cardId: FINEST,
  hobbyiqCardId: FINEST,
  title: "2011 Topps Finest Baseball #94 Mike Trout Base",
  source: "cardhedge",
  setName: "2011 Topps Finest",
  sport: "baseball",
  parallel: "Base",
  cardYear: 2011,
  cardNumber: "94",
  isAuto: false,
  gradeCompany: null,
  gradeValue: null,
  playerName: "Mike Trout",
  ...over,
});

/** One fixture per census class, with the verdict the fleet gives it. */
const FIXTURES: { want: string; row: Row }[] = [
  // AGREE — the row is already filed where the derivation puts it.
  { want: "AGREE", row: base() },
  // IMPROVE — stored parallel blank, the title names a finish: a pure fill.
  { want: "IMPROVE", row: base({ parallel: null, title: "2011 Topps Finest Baseball #94 Mike Trout Gold Refractor" }) },
  // CONFLICT — two rival finishes; the derivation names a DIFFERENT card.
  {
    want: "CONFLICT",
    row: base({
      cardId: "hiq:baseball:2011:topps-finest:94:gold-refractor:no-auto",
      hobbyiqCardId: "hiq:baseball:2011:topps-finest:94:gold-refractor:no-auto",
      parallel: "Gold Refractor",
      title: "2011 Topps Finest Baseball #94 Mike Trout Blue Refractor",
    }),
  },
  // UNDERIVABLE — the title supports no identity that passes the slug guard.
  { want: "UNDERIVABLE", row: base({ title: "Lot of 6 baseball cards" }) },
];

describe("I9 classifies with the ONE classifier the fleet uses", () => {
  it.each(FIXTURES)("gives $want on the $want fixture", ({ want, row }) => {
    expect(classify(row).klass).toBe(want);
  });

  it("reaches every census class — not a table of one", () => {
    // The shipped auditor returned only CONFLICT and UNDERIVABLE, on every
    // corpus it was ever pointed at.
    const seen = new Set(FIXTURES.map((f) => String(classify(f.row).klass)));
    expect(seen).toEqual(new Set(["AGREE", "IMPROVE", "CONFLICT", "UNDERIVABLE"]));
  });
});

describe("MUTATION: the old auditor derivation must go red", () => {
  it("the starved projection loses AGREE entirely", () => {
    // THE DEFECT, exactly: with setName/sport/isAuto/grade absent, the row that
    // AGREES reads as a fill on setKey and sport.
    const agree = FIXTURES.find((f) => f.want === "AGREE")!.row;
    expect(classify(agree).klass).toBe("AGREE");
    const starved = classify(starve(agree));
    expect(starved.klass).not.toBe("AGREE");
    expect(INV.axisSignature(starved)).toContain("filled:");
    expect(INV.axisSignature(starved)).toContain("setKey");
  });

  it("the starved projection makes EVERY fixture claim a filled setKey and sport", () => {
    // 100% of run 34027575655's 1,178 CONFLICT rows carried this signature.
    // That is the fingerprint of the defect, and it must not reappear.
    for (const { row } of FIXTURES) {
      const sig = INV.axisSignature(classify(starve(row)));
      if (sig === "(no axis diff)") continue;
      expect(sig).toMatch(/filled:[^ ]*setKey/);
      expect(sig).toMatch(/sport/);
    }
    // Whereas the real rows, read whole, do NOT all claim that.
    const whole = FIXTURES.map((f) => INV.axisSignature(classify(f.row)));
    expect(whole.every((sig) => /filled:[^ ]*setKey/.test(sig))).toBe(false);
  });

  it("storedIdentity called WITHOUT deps throws — the second defect", () => {
    // `storedIdentity` calls deps.normalizeSetKey(row.setName). One argument
    // meant a throw on every row carrying a setName, which the auditor's
    // try/catch turned into a silently skipped row.
    expect(() => RM.storedIdentity(base())).toThrow(/normalizeSetKey/);
    expect(() => RM.storedIdentity(base(), DERIVE_DEPS)).not.toThrow();
    expect(RM.storedIdentity(base(), DERIVE_DEPS).setKey).toBe("topps-finest");
  });

  it("classifyStoredRow passes the deps through to storedIdentity", () => {
    // The fix: classifyStoredRow hands deriveDeps to storedIdentity. Without
    // it this throws rather than classifying.
    expect(() => classify(base())).not.toThrow();
    expect(RM.storedIdentity(base(), DERIVE_DEPS).setKey).toBe("topps-finest");
  });

  it("checklistBacked=false makes IMPROVE unreachable — the third defect", () => {
    const improve = FIXTURES.find((f) => f.want === "IMPROVE")!.row;
    expect(classify(improve, true).klass).toBe("IMPROVE");
    // The shipped auditor hardcoded false: the same row becomes a CONFLICT
    // whose reason is the checklist gate, and no IMPROVE can ever be counted.
    const unbacked = classify(improve, false);
    expect(unbacked.klass).toBe("CONFLICT");
    expect(unbacked.reasons).toContain(INV.NEEDS_CHECKLIST_REASON);
    expect(INV.conflictKind(unbacked)).toBe("NEEDS-CHECKLIST");
  });
});

describe("the threshold reads only rows the fleet would classify", () => {
  it("PROTECTED rows are recognised by the same predicate the fleet uses", () => {
    // Report-only FOREVER for the rematch, so a disagreement on one is not a
    // corpus defect any lane could act on. The auditor excludes them by asking
    // rematch-classify's own provenanceTier — not a second copy of the rule.
    expect(CLASSIFY.provenanceTier(base()).tier).toBe(CLASSIFY.AUTO);
    expect(CLASSIFY.provenanceTier(base({ verifiedByUser: true })).tier).not.toBe(CLASSIFY.AUTO);
    expect(CLASSIFY.provenanceTier(base({ source: "manual-user-entry" })).tier).not.toBe(CLASSIFY.AUTO);
    expect(CLASSIFY.provenanceTier(base({ source: "ebay-user-purchase" })).tier).not.toBe(CLASSIFY.AUTO);
  });

  it("the starved projection could not even SEE a protected row", () => {
    // verifiedByUser / rekeyedReason / relocatedReason were never fetched, so
    // every protected row was mistaken for an ordinary AUTO-tier one and
    // counted toward the rate.
    const protectedRow = base({ verifiedByUser: true });
    expect(CLASSIFY.provenanceTier(protectedRow).tier).not.toBe(CLASSIFY.AUTO);
    expect(CLASSIFY.provenanceTier(starve(protectedRow)).tier).toBe(CLASSIFY.AUTO);
  });
});
