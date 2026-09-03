/**
 * THE GREAT REMATCH CLASSIFIER -- what may be written, and what may never be.
 *
 * The rematch re-derives every one of 16,336,293 sold_comps rows and sorts the
 * result into four classes. Exactly ONE of them (IMPROVE, AUTO-tier) is ever
 * written, and the whole safety of the round rests on the classifier refusing
 * everything else. So the refusals are what this file pins:
 *
 *   - IMPROVE requires BOTH strictly-more-specific AND checklist-backed. Drop
 *     either and the row must fall to CONFLICT.
 *   - CONFLICT never writes. A demotion or a lateral move on any axis is a
 *     different reading of the card, and a fleet never settles that.
 *   - PROTECTED never writes, even when the row is IMPROVE-shaped. The class
 *     still reports IMPROVE (that is what the census measured); `writable` is
 *     what the apply pass reads, and it is false. The MUTATION CHECK at the
 *     bottom proves this guard is load-bearing: remove it and a test fails.
 *   - grade is part of the identity. A title stating no grade does not make a
 *     stored PSA 9 row raw.
 *
 * Two shapes here are real cards from the canary set, and they are here
 * because they are the shapes that decide whether the round is safe:
 *   Verlander  2005 Bowman Chrome DP BDP129 -- the X-Fractor-in-base-pool
 *              shape, which must classify IMPROVE toward the print run.
 *   Gonzalez   2026 Bowman CPA-JG -- base-auto-on-refractor-slug, whose
 *              stored key is ALREADY the specific one, so a terse title that
 *              re-derives to base must NOT be allowed to flatten it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null; gradeCompany?: string | null; gradeValue?: number | null;
};
type Result = {
  klass: string; tier: string; writable: boolean; reasons: string[];
  axes: { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
  // The SPLIT-IDENTITY signal (Drew 2026-09-02), carried on every class.
  splitIdentity: boolean; splitClass: string; splitSegments: string[];
};
type Classifier = {
  AGREE: string; IMPROVE: string; CONFLICT: string; UNDERIVABLE: string;
  PROTECTED: string; AUTO: string;
  SPLIT_CLASSES: {
    COHERENT: string; VENDOR_DESIGN: string; UNKNOWN_VENDOR: string;
    HIQ_SPLIT: string; MALFORMED: string;
  };
  provenanceTier: (row: Record<string, unknown>) => { tier: string; reasons: string[] };
  gradeToken: (id: Identity) => string;
  diffAxes: (a: Identity, b: Identity) => Result["axes"];
  classifyRow: (input: {
    row: Record<string, unknown>; stored: Identity; derived: Identity | null;
    checklistBacked?: boolean; derivationReasons?: string[];
  }) => Result;
};
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as Classifier;

/** A vendor row -- the AUTO tier, 16.3M of the pool. */
const vendorRow = (over: Record<string, unknown> = {}) => ({ id: "r1", cardId: "hiq:x", source: "cardhedge", ...over });

/** The identity a 2005 Bowman Chrome BDP129 row carries when the older writer
 *  could not read the parallel or the print run off the title. */
const verlanderStored: Identity = {
  sport: "baseball", cardYear: 2005, setKey: "bowman-chrome", cardNumber: "BDP129",
  parallel: "Base", isAuto: false, printRun: null, gradeCompany: "PSA", gradeValue: 10,
};

describe("IMPROVE requires strictly-more-specific AND checklist-backed", () => {
  it("fills a blank axis, checklist-backed -> IMPROVE and writable", () => {
    const derived: Identity = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.tier).toBe(K.AUTO);
    expect(r.writable).toBe(true);
    // `base` is what an older writer emitted for an unreadable title, so it is
    // blank for the specificity test -- and the checklist is what displaces it.
    expect(r.axes.filled).toContain("parallel");
    expect(r.axes.filled).toContain("printRun");
    expect(r.axes.dropped).toHaveLength(0);
    expect(r.axes.changed).toHaveLength(0);
  });

  it("the SAME fill without checklist backing is CONFLICT, never IMPROVE", () => {
    const derived: Identity = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived, checklistBacked: false });
    // A match proves nothing unless checklist-backed -- match rate is
    // self-confirming, so "the matcher matched it" is not evidence.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons).toContain("not-checklist-backed");
  });

  it("a tie writes nothing: identical identities are AGREE", () => {
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived: { ...verlanderStored }, checklistBacked: true });
    expect(r.klass).toBe(K.AGREE);
    expect(r.writable).toBe(false);
  });

  it("filling one axis while CHANGING another is CONFLICT -- specificity is per-axis, not on balance", () => {
    const derived: Identity = { ...verlanderStored, parallel: "X-Fractor", setKey: "bowman" };
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("setKey");
    expect(r.writable).toBe(false);
  });
});

describe("CONFLICT never writes", () => {
  it("a demotion -- stored names a parallel, derived falls back to base", () => {
    const stored: Identity = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };
    const derived: Identity = { ...verlanderStored, parallel: "Base", printRun: null };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.dropped).toContain("parallel");
    expect(r.axes.dropped).toContain("printRun");
    expect(r.writable).toBe(false);
  });

  it("Gonzalez: a terse title must not flatten a stored refractor-auto-/499 key", () => {
    // The stored key is ALREADY the specific one -- hiq:baseball:2026:bowman:
    // cpa-jg:refractor:auto:num-499, direct match on 55 sales of this exact
    // card. A re-derivation from "2026 Bowman Justin Gonzalez CPA-JG" that
    // yields base / no-auto / no print run is LESS specific, three times over.
    const stored: Identity = { sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG", parallel: "Refractor", isAuto: true, printRun: 499 };
    const derived: Identity = { sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG", parallel: "Base", isAuto: false, printRun: null };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.axes.dropped).toEqual(expect.arrayContaining(["parallel", "printRun"]));
    expect(r.axes.changed).toContain("isAuto");
  });

  it("a different card -- same number, different product -- is CONFLICT, not an improvement", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG", parallel: "Refractor", isAuto: true };
    const derived: Identity = { sport: "baseball", cardYear: 2026, setKey: "bowman-chrome", cardNumber: "CPA-JG", parallel: "Refractor", isAuto: true };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    // bowman-vs-chrome are DIFFERENT cards; the fleet never settles which.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("setKey");
  });
});

describe("grade is part of the identity, and lives in the fields + the child slug", () => {
  it("a stored PSA 9 that arrives at the classifier as raw is a CONFLICT, never a silent re-grade", () => {
    // Two guards stand between a silent re-grade and the pool, and this is the
    // second one. The FIRST is in deriveIdentity: when a title states no grade
    // the STORED grade is carried forward, so this shape should not normally
    // reach here at all. If some future derivation does hand the classifier a
    // raw reading of a graded row, it must still refuse -- raw is an ANSWER,
    // so this is two contradictory answers, which is Drew's call, not a fleet's.
    const stored: Identity = { ...verlanderStored, gradeCompany: "PSA", gradeValue: 9 };
    const derived: Identity = { ...verlanderStored, gradeCompany: null, gradeValue: null };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.axes.changed).toContain("grade");
  });

  it("raw is an ANSWER, not a blank: raw vs raw agrees on the grade axis", () => {
    expect(K.gradeToken({ gradeCompany: null, gradeValue: null })).toBe("RAW");
    const raw: Identity = { ...verlanderStored, gradeCompany: null, gradeValue: null };
    const d = K.diffAxes(raw, { ...raw });
    expect(d.same).toContain("grade");
    expect(d.filled).not.toContain("grade");
  });

  it("a stored raw row whose title states PSA 10 is an IMPROVE on the grade axis", () => {
    const stored: Identity = { ...verlanderStored, gradeCompany: null, gradeValue: null };
    const derived: Identity = { ...verlanderStored, gradeCompany: "PSA", gradeValue: 10 };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    // "RAW" -> "PSA|10" is a CHANGE, not a fill: raw is a real answer, so a
    // title contradicting it is a conflict for Drew, not a silent re-grade.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("grade");
  });
});

describe("UNDERIVABLE: absent beats wrong", () => {
  it("no derived identity -> UNDERIVABLE, never written, reasons carried", () => {
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived: null, derivationReasons: ["no-title"] });
    expect(r.klass).toBe(K.UNDERIVABLE);
    expect(r.writable).toBe(false);
    expect(r.reasons).toContain("no-title");
  });
});

describe("PROTECTED rows never write, even when IMPROVE-shaped", () => {
  const improving: Identity = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };

  it.each([
    ["ebay-user-purchase", { source: "ebay-user-purchase" }],
    ["ebay-user-sale", { source: "ebay-user-sale" }],
    ["ebay-account", { source: "ebay-account" }],
    ["manual-user-entry", { source: "manual-user-entry" }],
    ["verifiedByUser", { source: "cardhedge", verifiedByUser: true }],
    ["a Drew ruling marker", { source: "cardhedge", drewRuling: "D31" }],
    ["a hand relocation", { source: "cardhedge", handRelocated: true }],
    ["a D19/D31 relocation reason", { source: "cardhedge", rekeyedReason: "CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19): re-keyed to the D9 order id / D12-a slug" }],
  ])("%s is PROTECTED and not writable", (_label, over) => {
    const r = K.classifyRow({ row: vendorRow(over), stored: verlanderStored, derived: improving, checklistBacked: true });
    expect(r.tier).toBe(K.PROTECTED);
    // The class still REPORTS what the census measured...
    expect(r.klass).toBe(K.IMPROVE);
    // ...and the apply pass still may not touch it.
    expect(r.writable).toBe(false);
  });

  it("the identical row on a vendor source IS writable -- so the refusals above are the guard, not an accident", () => {
    const r = K.classifyRow({ row: vendorRow(), stored: verlanderStored, derived: improving, checklistBacked: true });
    expect(r.tier).toBe(K.AUTO);
    expect(r.writable).toBe(true);
  });
});

describe("MUTATION CHECK: the protected-row guard is load-bearing", () => {
  // A guard nothing tests is a guard that gets deleted. Remove the tier check
  // from `writable` in the real source and re-evaluate: a protected row must
  // become writable, which is exactly the damage the guard prevents. If this
  // test ever passes with the mutation IN PLACE, the guard has stopped working.
  it("removing the tier check from `writable` makes a PROTECTED row writable", () => {
    const file = path.join(backend, "scripts", "lib", "rematch-classify.cjs");
    const src = fs.readFileSync(file, "utf8");
    const guard = "writable: prov.tier === AUTO";
    expect(src).toContain(guard);

    // The SAME guard expression now appears twice -- once for IMPROVE and once
    // for the BASE-EVICTION subclass (Drew 2026-09-02), which is evaluated
    // FIRST and so is the earlier occurrence in the file. A bare replace()
    // would mutate the subclass's guard and leave IMPROVE's intact, and this
    // test would then be quietly checking the wrong thing while still passing
    // for the wrong reason. IMPROVE's is the LAST occurrence; pin that one.
    // (rematchBaseEviction.test.ts mutates the subclass's guard on its own.)
    const at = src.lastIndexOf(guard);
    expect(at).toBeGreaterThan(-1);
    const mutated = src.slice(0, at) + "writable: true" + src.slice(at + guard.length);
    expect(mutated).not.toBe(src);
    // The IMPROVE return is the one that follows the checklist-backed gate.
    expect(src.slice(0, at)).toContain("not-checklist-backed");

    // Load the mutated module in isolation, without touching the real file.
    const tmp = path.join(backend, "scripts", "lib", `.rematch-classify.mutant-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const mutant = require_(tmp) as Classifier;
      const row = vendorRow({ source: "ebay-user-purchase" });
      const derived: Identity = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };

      const real = K.classifyRow({ row, stored: verlanderStored, derived, checklistBacked: true });
      const broken = mutant.classifyRow({ row, stored: verlanderStored, derived, checklistBacked: true });

      expect(real.tier).toBe(K.PROTECTED);
      expect(broken.tier).toBe(K.PROTECTED);
      // The guard is the ONLY thing standing between these two answers.
      expect(real.writable).toBe(false);
      expect(broken.writable).toBe(true);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});

describe("provenanceTier", () => {
  it("a plain vendor row is AUTO with no reasons", () => {
    const t = K.provenanceTier(vendorRow());
    expect(t.tier).toBe(K.AUTO);
    expect(t.reasons).toHaveLength(0);
  });

  it("verifiedByUser=false is NOT protection -- only true is", () => {
    expect(K.provenanceTier(vendorRow({ verifiedByUser: false })).tier).toBe(K.AUTO);
    expect(K.provenanceTier(vendorRow({ verifiedByUser: true })).tier).toBe(K.PROTECTED);
  });

  it("every reason is reported, so the banner can break the tier down", () => {
    const t = K.provenanceTier(vendorRow({ source: "ebay-user-purchase", verifiedByUser: true }));
    expect(t.tier).toBe(K.PROTECTED);
    expect(t.reasons).toEqual(expect.arrayContaining(["source:ebay-user-purchase", "verifiedByUser"]));
  });
});

describe("D2 -- a source that NAMES a Drew ruling is protected", () => {
  it("source='drew-ruling-*' is PROTECTED, not a fleet-writable AUTO row", () => {
    const t = K.provenanceTier(vendorRow({ source: "drew-ruling-2026-08-10" }));
    expect(t.tier).toBe(K.PROTECTED);
    expect(t.reasons.join(",")).toMatch(/source-marker/);
  });

  it("an IMPROVE-shaped diff on a ruling-named source is reported, never written", () => {
    const derived = { ...verlanderStored, parallel: "X-Fractor", printRun: 250 };
    const r = K.classifyRow({ row: vendorRow({ source: "drew-ruling-2026-08-10" }), stored: verlanderStored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.writable).toBe(false);
  });

  it("hand-relocated / d31 named sources are protected too", () => {
    for (const src of ["hand-relocated-2026-08", "d31-relocated", "D19-relocation"]) {
      expect(K.provenanceTier(vendorRow({ source: src })).tier).toBe(K.PROTECTED);
    }
  });

  it("an ordinary vendor source is still AUTO -- the guard is not a blanket refusal", () => {
    for (const src of ["cardhedge", "tca-ebay", "cardsight"]) {
      expect(K.provenanceTier(vendorRow({ source: src })).tier).toBe(K.AUTO);
    }
  });
});

describe("D1 -- the phantom-grade parser artifact is TAGGED but still contained", () => {
  const pristineStored = { sport: "baseball", cardYear: 2024, setKey: "topps-pristine", cardNumber: "131", parallel: "base", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null };

  it("stored RAW + phantom PSA 10 is CONFLICT, not writable, and carries the artifact tag", () => {
    const derived = { ...pristineStored, gradeCompany: "PSA", gradeValue: 10 };
    const r = K.classifyRow({ row: vendorRow(), stored: pristineStored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons).toContain("changed:grade/phantom-set-word");
  });

  it("a phantom grade riding along with a GENUINE fill still cannot be written", () => {
    const derived = { ...pristineStored, gradeCompany: "PSA", gradeValue: 10, parallel: "Refractor", printRun: 499 };
    const r = K.classifyRow({ row: vendorRow(), stored: pristineStored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
  });

  it("the tag never fires on a non-Pristine set, so real grade conflicts stay visible", () => {
    const stored = { ...pristineStored, setKey: "topps-chrome" };
    const derived = { ...stored, gradeCompany: "PSA", gradeValue: 9 };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.reasons).not.toContain("changed:grade/phantom-set-word");
  });

  it("a stored GRADED row losing its grade is never tagged as the artifact", () => {
    const stored = { ...pristineStored, gradeCompany: "PSA", gradeValue: 9 };
    const derived = { ...pristineStored };
    const r = K.classifyRow({ row: vendorRow(), stored, derived, checklistBacked: true });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.reasons).not.toContain("changed:grade/phantom-set-word");
  });
});

/**
 * THE SPLIT-IDENTITY SIGNAL (Drew, 2026-09-02: "we need to go back and check
 * ALL this way").
 *
 * A row's two identity fields can contradict EACH OTHER, independently of what
 * today's parser derives from its title. exactPoolReader.ts ORs `cardId` and
 * `hobbyiqCardId`, so such a row is read into both pools and prices two cards.
 *
 * The signal is therefore orthogonal to the four derivation classes, and the
 * pins below are exactly that claim: a split row surfaces the flag whatever
 * class it lands in -- INCLUDING AGREE, which is where most of them land and
 * which no other part of the census would ever look at again -- and a
 * vendor-design row does not surface it at all.
 */
describe("SPLIT-IDENTITY signal: a row that contradicts itself", () => {
  /** A real hiq-vs-hiq split sampled from the pool 2026-09-02. */
  const splitRow = (over: Record<string, unknown> = {}) => ({
    id: "sp1", source: "cardhedge",
    cardId: "hiq:baseball:2026:topps-finest:196:base:no-auto",
    hobbyiqCardId: "hiq:baseball:2026:topps-series-1:196:base:no-auto",
    ...over,
  });
  /** The designed CardHedge partition (#1650): bubble id beside our slug. */
  const vendorDesignRow = (over: Record<string, unknown> = {}) => ({
    id: "vd1", source: "cardhedge",
    cardId: "1778542173652x303328120692600800",
    hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto",
    ...over,
  });

  it("a split row surfaces the flag even when the derivation AGREES", () => {
    // THE CASE THAT MATTERS MOST. The row's fields and the title agree
    // perfectly, so every axis is `same` and the class is AGREE -- the one
    // class that means "nothing to do". Its two ADDRESSES still name different
    // cards. Hanging the signal off CONFLICT would have missed this entirely.
    const r = K.classifyRow({
      row: splitRow(), stored: verlanderStored, derived: { ...verlanderStored }, checklistBacked: true,
    });
    expect(r.klass).toBe(K.AGREE);
    expect(r.splitIdentity).toBe(true);
    expect(r.splitClass).toBe(K.SPLIT_CLASSES.HIQ_SPLIT);
    expect(r.splitSegments).toContain("setKey");
    expect(r.reasons.some((x) => x.startsWith("split-identity:"))).toBe(true);
  });

  it("the flag rides on every other class too -- IMPROVE, CONFLICT, UNDERIVABLE", () => {
    const improve = K.classifyRow({
      row: splitRow(), stored: verlanderStored,
      derived: { ...verlanderStored, parallel: "X-Fractor", printRun: 250 }, checklistBacked: true,
    });
    expect(improve.klass).toBe(K.IMPROVE);
    expect(improve.splitIdentity).toBe(true);

    const conflict = K.classifyRow({
      row: splitRow(), stored: verlanderStored,
      derived: { ...verlanderStored, setKey: "bowman" }, checklistBacked: true,
    });
    expect(conflict.klass).toBe(K.CONFLICT);
    expect(conflict.splitIdentity).toBe(true);

    const underivable = K.classifyRow({
      row: splitRow(), stored: verlanderStored, derived: null, derivationReasons: ["slug-guard"],
    });
    expect(underivable.klass).toBe(K.UNDERIVABLE);
    expect(underivable.splitIdentity).toBe(true);
    expect(underivable.reasons).toContain("slug-guard");
  });

  it("the flag does NOT make a row writable — it is a report signal", () => {
    // The apply path already lands BOTH identity fields, so a repair driven by
    // a writable class heals the split as a side effect. The flag must never
    // become its own licence to write.
    const r = K.classifyRow({
      row: splitRow(), stored: verlanderStored, derived: { ...verlanderStored }, checklistBacked: true,
    });
    expect(r.splitIdentity).toBe(true);
    expect(r.writable).toBe(false);
  });

  it("a VENDOR-DESIGN row does NOT surface the flag", () => {
    // #1650: 327 of 399 touched-set "splits" were this shape, and a control
    // read found 1242 of 1242 rows on untouched cards partitioned the same
    // way. Flagging these would drown the 72 real ones.
    const r = K.classifyRow({
      row: vendorDesignRow(), stored: verlanderStored, derived: { ...verlanderStored }, checklistBacked: true,
    });
    expect(r.klass).toBe(K.AGREE);
    expect(r.splitIdentity).toBe(false);
    expect(r.splitClass).toBe(K.SPLIT_CLASSES.VENDOR_DESIGN);
    expect(r.reasons.some((x) => x.startsWith("split-identity:"))).toBe(false);
  });

  it("an ordinary one-sided row is unaffected", () => {
    // The existing fixtures carry a cardId and no hobbyiqCardId. Nothing to
    // contradict, so no flag -- and no existing pin changes meaning.
    const r = K.classifyRow({
      row: vendorRow(), stored: verlanderStored, derived: { ...verlanderStored }, checklistBacked: true,
    });
    expect(r.splitIdentity).toBe(false);
  });
});
