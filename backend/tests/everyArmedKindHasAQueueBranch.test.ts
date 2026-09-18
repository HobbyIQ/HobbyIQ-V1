/**
 * CF-AN-ARMED-KIND-MUST-HAVE-SOMEWHERE-TO-GO (R33 zero-write, part 2).
 *
 * THE DEFECT, AND WHY IT SURVIVED THE FIRST FIX. #2233 taught `applyKindOf`
 * the 2026-09-14 trio, so an R33 row stopped being mis-filed as IMPROVE and
 * started reaching the queue under its own kind. It then hit this, in
 * rematch-sold-comps.cjs:
 *
 *     if (kind === K.GRADE_FROM_TITLE)            { ... }
 *     else if (kind === K.YEAR_FROM_TITLE_VINTAGE || ... ) { ... }
 *     else if (kind === K.IMPROVE)                { ... }
 *     else if (kind === K.BASE_EVICTION)          { ... }
 *                                             // <- and nothing else
 *
 * R31, R32 and R33 matched no branch. The chain had no `else`, so those rows
 * fell out of the block entirely: never queued, never written, and never
 * counted as held back. The banner's arithmetic balanced perfectly, because
 * rows that are counted nowhere cannot unbalance anything.
 *
 * MEASURED on run 35391563906 (main 932e86ba, scope=r33, apply=false, slot 3):
 *
 *     R33-TITLE-CARD-NUMBER-WINS ARMED
 *     of which R33-TITLE-CARD-NUMBER-WINS   664  AUTO  <- writable under audit
 *     APPLY-IMPROVE REPORT ONLY  candidates 0 (... R33-TITLE-CARD-NUMBER-WINS 0)
 *     3,905 not-armed-by-scope:R31  319 not-armed-by-scope:IMPROVE  20 SPORT  ...
 *     PER CLASS  R33-TITLE-CARD-NUMBER-WINS ARMED  intended 0
 *
 * 664 writable rows of the ARMED class, zero candidates, and NO
 * `not-armed-by-scope:R33` line either — the fingerprint that separates this
 * defect from the one #2233 fixed. (R31's 3,905 ARE counted there, because
 * under scope=r33 R31 is disarmed and the disarmed branch runs first.)
 *
 * The census artifact for that slot says the same thing twice over:
 *   subclasses["IMPROVE/R33-TITLE-CARD-NUMBER-WINS/AUTO"] = 664
 *   counts.r33 = 0
 *
 * TWO INDEPENDENT HOLES ON ONE PATH. `applyKindOf` knowing the kind was
 * necessary and not sufficient. This file pins the second one in the general
 * form, so the next ruled scope cannot repeat either.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));
const DRIVER = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");

/** The queue dispatch: from the `MODE === "apply-improve" && res.writable`
 *  test down to the end of its block. Sliced by source text because the
 *  dispatch is inside the classify loop and cannot be imported. */
function queueDispatchSource(): string {
  const start = DRIVER.indexOf('if (MODE === "apply-improve" && res.writable)');
  expect(start, "the queue dispatch must still be findable in the driver").toBeGreaterThan(-1);
  const end = DRIVER.indexOf("MID-UNIT PAGE CHECKPOINT", start);
  expect(end, "the dispatch's end marker must still be findable").toBeGreaterThan(start);
  return DRIVER.slice(start, end);
}

/** Every kind the driver's APPLY_KINDS list carries, read from its source. */
function applyKindsInDriver(): string[] {
  const m = DRIVER.match(/const APPLY_KINDS = \[([\s\S]*?)\n\];/);
  expect(m, "APPLY_KINDS must still be a literal array in the driver").toBeTruthy();
  const names = [...m![1].matchAll(/K\.([A-Z_]+)/g)].map((x) => x[1]);
  return names.map((n) => {
    expect(K[n], `K.${n} must exist`).toBeTruthy();
    return K[n] as string;
  });
}

/**
 * R32 is the ONE kind that is legitimately unroutable. `split-scope.cjs` is
 * report-only by ruling, so R32 has no apply path at all and must NOT be given
 * a destination. It is listed in APPLY_KINDS so the banner and the per-class
 * reconcile can see it; it is absent from the dispatch on purpose.
 */
const NO_APPLY_PATH_BY_RULING = new Set<string>([K.SPLIT_MOVES_TO_THE_NAMED_SIDE]);

describe("every apply kind that can be armed has a queue branch to route it", () => {
  it("the dispatch routes every APPLY_KINDS entry except the one ruled report-only", () => {
    const dispatch = queueDispatchSource();
    const unrouted = applyKindsInDriver().filter((kind) => {
      if (NO_APPLY_PATH_BY_RULING.has(kind)) return false;
      // The dispatch tests kinds by their K.<NAME> constant, so look for any
      // `kind === K.X` whose X resolves to this kind string.
      const names = [...dispatch.matchAll(/kind === K\.([A-Z_]+)/g)].map((m) => m[1]);
      return !names.some((n) => K[n] === kind);
    });
    expect(unrouted,
      "these kinds can be ARMED and classified writable, but the queue dispatch "
      + "has no branch giving them a destination — they would fall through, be "
      + "queued nowhere, and be counted nowhere (run 35391563906: 664 R33 rows)")
      .toEqual([]);
  });

  it("the dispatch ends in an else that COUNTS what it cannot route", () => {
    // The structural half. Even with every kind routed today, the next ruled
    // scope arrives before its branch does — and the failure must be loud.
    const dispatch = queueDispatchSource();
    expect(dispatch,
      "the kind dispatch must end in an `else`, so an unroutable armed kind is "
      + "counted rather than silently dropped").toMatch(/}\s*else\s*{/);
    expect(dispatch).toMatch(/armed-kind-has-no-queue-branch/);
    expect(dispatch).toMatch(/unroutable\[kind\]/);
  });

  it("an unroutable armed kind fails the run — it never reports a clean zero", () => {
    // The banner must exit nonzero, because "wrote 0" and "could not route a
    // single row of the class you armed" are not the same result and a fleet
    // dispatcher reads the exit code.
    expect(DRIVER).toMatch(/DISPATCH DEFECT/);
    expect(DRIVER).toMatch(/process\.exitCode = 7/);
  });

  it("R32 stays unrouted, and that is the ruling — not an oversight", () => {
    const dispatch = queueDispatchSource();
    const names = [...dispatch.matchAll(/kind === K\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(names.some((n) => K[n] === K.SPLIT_MOVES_TO_THE_NAMED_SIDE),
      "R32 has no apply path (split-scope.cjs is report-only); giving it a "
      + "destination here would be a write the ruling never authorized").toBe(false);
    // And the reason is written down where the next reader will look.
    expect(dispatch).toMatch(/R32-SPLIT-MOVES-TO-THE-NAMED-SIDE is deliberately NOT here|report-only/);
  });
});

describe("the two writing scopes of 2026-09-14 carry their evidence to the row", () => {
  // Every other ruled subclass writes a `rekeyedReason` naming what was seen,
  // so the row is auditable from the row alone. R31 and R33 had no branch and
  // would have fallen to the generic IMPROVE reason, which names neither the
  // ruling nor the evidence.
  it.each([
    ["R31-TITLE-FILLS-THE-BLANK", "TITLE_FILLS_THE_BLANK", "titleFillsTheBlankEvidence"],
    ["R33-TITLE-CARD-NUMBER-WINS", "TITLE_CARD_NUMBER_WINS", "titleCardNumberWinsEvidence"],
  ])("%s writes its own rekeyedReason and attaches its evidence", (label, konst, evidenceField) => {
    expect(DRIVER).toMatch(new RegExp(`cand\\.kind === K\\.${konst}`));
    expect(DRIVER).toContain(label);
    expect(DRIVER).toMatch(new RegExp(`keep\\.${evidenceField} = e`));
  });
});
