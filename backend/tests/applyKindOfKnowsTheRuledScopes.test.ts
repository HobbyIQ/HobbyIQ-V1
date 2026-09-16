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
      const armed = K.scopeToKinds ? K.scopeToKinds(scope) : new Set([subclass]);
      const res = { klass: K.IMPROVE, subclass, writable: true, tier: K.AUTO };
      expect(K.writableUnderScope(res, armed instanceof Set ? armed : new Set(armed)),
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
    const armable = new Set<string>();
    for (const kinds of (K.SCOPE_TO_KINDS ?? new Map()).values()) {
      for (const k of kinds) armable.add(k);
    }
    if (!armable.size) return;   // table not exported in this shape; covered above
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
