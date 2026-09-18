/**
 * CF-A-SCOPE-MUST-ARM-THE-CLASS-IT-NAMES (R33 zero-write, 2026-09-15).
 *
 * THE DEFECT. `applyKindOf` maps a classifier result to the apply KIND the
 * queue is built on. It knows the 2026-09-06 trio (grade/year/sport) and the
 * 2026-09-13 trio (R26/R27/R28) — and it does NOT know the 2026-09-14 trio
 * (R31/R32/R33). Those three fall through to the bare `IMPROVE` fallback.
 *
 * So under `scope=r33` the driver arms R33-TITLE-CARD-NUMBER-WINS, classifies
 * an R33 row, asks `applyKindOf` for its kind, is told `IMPROVE`, finds
 * IMPROVE disarmed, and counts the row as `not-armed-by-scope:IMPROVE`. The
 * row is never queued and never written.
 *
 * MEASURED on the terminal R33 wave (slot 3, run 35037780923):
 *
 *     of which R33-TITLE-CARD-NUMBER-WINS   610  AUTO  <- writable under audit
 *     APPLY CLASS SCOPE: scope="r33" -> R33-TITLE-CARD-NUMBER-WINS
 *       R33-TITLE-CARD-NUMBER-WINS ARMED
 *     APPLY-IMPROVE  APPLYING  candidates 0 (... R33-TITLE-CARD-NUMBER-WINS 0)
 *     4,101  not-armed-by-scope:IMPROVE
 *
 * 610 writable rows, the class armed by name, zero candidates queued — and the
 * held-back count filed under IMPROVE, which is the fingerprint. All 29
 * terminal slots reported the same shape (census writable 131–2,639 per slot,
 * `APPLYING candidates 0` on every one).
 *
 * R31 and R32 have the identical defect and are pinned here too, so the next
 * scoped wave does not rediscover it one scope at a time.
 *
 * WHY IT IS NOT CAUGHT BY THE OTHER GUARDS. `writable` is set correctly, the
 * scope parses correctly, the banner prints ARMED correctly, and the prefilter
 * is null for these kinds (so it refuses nothing). Every part reads right in
 * isolation; only the mapping between the classifier's subclass and the
 * queue's kind is missing, and nothing asserted it.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

/** The three 2026-09-14 scopes, by the name their scope string arms. */
const RULED_2026_09_14: Array<[string, string]> = [
  ["r31", K.TITLE_FILLS_THE_BLANK],
  ["r32", K.SPLIT_MOVES_TO_THE_NAMED_SIDE],
  ["r33", K.TITLE_CARD_NUMBER_WINS],
];

describe("applyKindOf knows every ruled subclass the scope table can arm", () => {
  it.each(RULED_2026_09_14)(
    "scope=%s: the subclass maps to ITS OWN kind, not to bare IMPROVE",
    (_scope, subclass) => {
      const kind = K.applyKindOf({ klass: K.IMPROVE, subclass, writable: true });
      // THE ASSERTION. Falling through to IMPROVE is the defect: it files the
      // row under a kind the scope did not arm.
      expect(kind, `${subclass} must not fall through to the IMPROVE fallback`)
        .not.toBe(K.IMPROVE);
      expect(kind).toBe(subclass);
    },
  );

  it.each(RULED_2026_09_14)(
    "scope=%s: a writable row of that subclass IS writable under its own scope",
    (scope, subclass) => {
      // The end-to-end shape the driver asks: parse the scope, classify a row,
      // and see whether the queue would take it.
      //
      // `parseApplyScope` is the ONLY scope parser — an earlier draft of this
      // test reached for a `K.scopeToKinds` that does not exist, so the
      // fallback branch ran and the assertion tested a hand-built Set instead
      // of the real table. A scope table this test never actually reads is a
      // scope table this test cannot pin.
      const parsed = K.parseApplyScope(scope);
      expect(parsed.ok, `scope=${scope} must parse: ${parsed.reason}`).toBe(true);
      const res = { klass: K.IMPROVE, subclass, writable: true, tier: K.AUTO };
      expect(K.writableUnderScope(res, parsed.classes),
        `a writable ${subclass} row must be queueable under scope=${scope}`).toBe(true);
    },
  );

  it("the earlier trios still map to themselves — this widens, it does not move", () => {
    for (const subclass of [
      K.GRADE_FROM_TITLE, K.YEAR_FROM_TITLE_VINTAGE, K.SPORT_FROM_PRODUCT,
      K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT, K.POKEMON_SET_CODE, K.FINISH_IS_A_PARALLEL,
      K.BASE_EVICTION,
    ]) {
      expect(K.applyKindOf({ klass: K.IMPROVE, subclass, writable: true })).toBe(subclass);
    }
  });

  it("a plain IMPROVE with no subclass still maps to IMPROVE", () => {
    // The fallback must survive: `scope=improve` has to keep arming exactly
    // what it armed yesterday.
    expect(K.applyKindOf({ klass: K.IMPROVE, subclass: null, writable: true })).toBe(K.IMPROVE);
    expect(K.applyKindOf({ klass: K.AGREE, subclass: null, writable: false })).toBeNull();
  });

  it("every kind the scope table can arm is a kind applyKindOf can return", () => {
    // The GENERAL form of the defect, so the next ruled scope cannot repeat it:
    // a scope that arms a kind no result can ever carry is a wave that writes
    // nothing and reports success.
    //
    // The table is `APPLY_SCOPE_ALIASES` — scope word -> kinds. An earlier
    // draft read a `K.SCOPE_TO_KINDS` that does not exist, so `armable` was
    // empty and the whole check returned before asserting anything.
    const armable = new Set<string>();
    for (const kinds of K.APPLY_SCOPE_ALIASES.values()) {
      for (const k of kinds) armable.add(k);
    }
    expect(armable.size, "the scope table must arm at least one kind").toBeGreaterThan(0);
    const reachable = new Set<string>();
    for (const subclass of armable) {
      const kind = K.applyKindOf({ klass: K.IMPROVE, subclass, writable: true });
      if (kind) reachable.add(kind);
    }
    const unreachable = [...armable].filter((k) => k !== K.IMPROVE && !reachable.has(k));
    expect(unreachable,
      "these kinds can be ARMED by a scope but no classifier result maps to them, "
      + "so a scoped wave would queue nothing and report success").toEqual([]);
  });
});

/**
 * THE CONTAINMENT, ASSERTED ON REAL CLASSIFIED ROWS.
 *
 * The tests above pin the MAPPING (subclass -> kind) on hand-built results.
 * These two pin the CONSEQUENCE on rows that go through `classifyRow`, which
 * is where the defect would actually bite:
 *
 *   1. `scope=improve` arms IMPROVE and nothing else. R31 is HELD by ruling,
 *      so an `improve` dispatch that silently reaches an R31 row is the hole,
 *      not the feature — and the e2e fixture proved this is not theoretical:
 *      it was an R31-shaped row that `scope=improve` armed by accident for as
 *      long as applyKindOf mapped R31 to the bare IMPROVE kind.
 *   2. `scope=r31` / `scope=r33` arm their own rows when the destination is
 *      checklist-backed, and refuse the SAME row when it is not. Absent beats
 *      wrong: unbacked means the destination was never proven to exist, and a
 *      confident write onto an unproven address is worse than no write.
 */
describe("the ruled scopes are contained: improve never reaches them, they never skip the backing gate", () => {
  const IMPROVE_SCOPE = K.parseApplyScope("improve").classes;

  /** An R31 row: the stored parallel is BLANK and the title names the rung. */
  function r31Row(checklistBacked: boolean) {
    const stored = {
      sport: "baseball", cardYear: 2021, setKey: "topps-chrome",
      cardNumber: "27", parallel: "", isAuto: false, printRun: null,
    };
    const slug = "hiq:baseball:2021:topps-chrome:27:base:no-auto";
    return K.classifyRow({
      row: { title: "2021 Topps Chrome Mike Trout #27 Refractor", id: "r31", cardId: slug },
      stored, derived: { ...stored, parallel: "Refractor" },
      checklistBacked, derivationReasons: [], storedSlug: slug,
      // R31's two catalog reads: the checklist lists the title's rung for this
      // cell, and the phrase reads as a rung rather than prose.
      checklistListsTitleParallel: true, titleParallelIsARungPhrase: true,
    });
  }

  /** An R33 row: the stored number DISAGREES with the title's literal `#N`. */
  function r33Row(checklistBacked: boolean) {
    const stored = {
      sport: "baseball", cardYear: 2021, setKey: "topps-chrome",
      cardNumber: "99", parallel: "Refractor", isAuto: false, printRun: null,
    };
    const slug = "hiq:baseball:2021:topps-chrome:99:refractor:no-auto";
    return K.classifyRow({
      row: { title: "2021 Topps Chrome Mike Trout #27 Refractor", id: "r33", cardId: slug },
      stored, derived: { ...stored, cardNumber: "27" },
      checklistBacked, derivationReasons: [], storedSlug: slug,
      // R33's catalog reads: the title's number is a real row of this
      // checklist, and the derived address as a whole is backed.
      titleNumberIsChecklistRow: checklistBacked, derivedBackedR33: checklistBacked,
    });
  }

  it("scope=improve writes ZERO R31- and R33-shaped rows, even though both classify writable", () => {
    const r31 = r31Row(true);
    const r33 = r33Row(true);

    // Precondition — if these stopped being the ruled subclasses the test
    // below would pass vacuously, which is exactly how the e2e fixture hid
    // this for two waves.
    expect(r31.subclass, "the R31 fixture must really be R31").toBe(K.TITLE_FILLS_THE_BLANK);
    expect(r33.subclass, "the R33 fixture must really be R33").toBe(K.TITLE_CARD_NUMBER_WINS);
    expect(r31.writable, "the R31 fixture must be writable, or containment is untested").toBe(true);
    expect(r33.writable, "the R33 fixture must be writable, or containment is untested").toBe(true);

    // THE ASSERTION. Writable under their OWN scope, and not under `improve`.
    expect(K.writableUnderScope(r31, IMPROVE_SCOPE),
      "scope=improve must NOT arm an R31 row — R31 is held by ruling").toBe(false);
    expect(K.writableUnderScope(r33, IMPROVE_SCOPE),
      "scope=improve must NOT arm an R33 row — R33 is held by ruling").toBe(false);
  });

  it("a plain IMPROVE row IS still armed by scope=improve — the containment does not disarm the ordinary case", () => {
    // The mirror of the test above, and the reason the e2e fixture had to
    // change rather than the mapping: `scope=improve` must keep writing what
    // it wrote yesterday. The improvement here is the SET KEY — strictly more
    // specific, and an axis none of R31 (blank parallel / print run), R32
    // (split identity) or R33 (the title's card number) owns.
    const stored = {
      sport: "baseball", cardYear: 2021, setKey: "unknown",
      cardNumber: "27", parallel: "Refractor", isAuto: false, printRun: null,
    };
    const slug = "hiq:baseball:2021:unknown:27:refractor:no-auto";
    const res = K.classifyRow({
      row: { title: "2021 Topps Chrome Mike Trout #27 Refractor", id: "imp", cardId: slug },
      stored, derived: { ...stored, setKey: "topps-chrome" },
      checklistBacked: true, derivationReasons: [], storedSlug: slug,
    });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass, "a plain IMPROVE carries no ruled subclass").toBeFalsy();
    expect(K.applyKindOf(res)).toBe(K.IMPROVE);
    expect(K.writableUnderScope(res, IMPROVE_SCOPE),
      "scope=improve must still arm an ordinary improvement").toBe(true);
  });

  it.each([
    ["r31", "R31", r31Row, K.TITLE_FILLS_THE_BLANK],
    ["r33", "R33", r33Row, K.TITLE_CARD_NUMBER_WINS],
  ] as const)(
    "scope=%s queues its own row when checklist-backed, and refuses the SAME row when it is not",
    (scope, label, build, subclass) => {
      const parsed = K.parseApplyScope(scope);
      expect(parsed.ok, `scope=${scope} must parse: ${parsed.reason}`).toBe(true);

      // BACKED: the destination is proven to exist, so the row is queueable.
      const backed = build(true);
      expect(backed.subclass, `${label} backed must classify as ${subclass}`).toBe(subclass);
      expect(K.writableUnderScope(backed, parsed.classes),
        `a backed ${label} row must be queueable under scope=${scope}`).toBe(true);

      // UNBACKED: the SAME row, one fact removed. Absent beats wrong — the
      // destination was never proven, so nothing is written and the refusal is
      // named in the reasons rather than swallowed.
      const unbacked = build(false);
      expect(unbacked.writable,
        `an unbacked ${label} row must never be writable`).toBe(false);
      expect(K.writableUnderScope(unbacked, parsed.classes),
        `scope=${scope} must NOT queue an unbacked ${label} row`).toBe(false);
      expect(unbacked.reasons.join(" "),
        `the refusal must NAME the backing gate, not vanish`).toMatch(/not-checklist-backed|destination-not-checklist-backed/);
    },
  );
});
