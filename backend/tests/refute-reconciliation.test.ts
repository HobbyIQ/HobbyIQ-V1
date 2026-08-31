import { describe, it, expect } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation";

/**
 * REFUTATION PROBE 2 -- the reconciliation arithmetic.
 *
 * In the script's pass A loop, for ONE row that needs re-keying:
 *   stats.catWrong++            (line 256, before the try)
 *   stats.catMovedOntoNew++     (line 276, BEFORE the await that can throw)
 *   await moveCatalogRow(...)   <- throws
 *   stats.catFailed++           (line 285)
 *
 * so a row that WROTE NOTHING is counted in `written` and in `failed`.
 * The reportWrites call then also puts catWrong AND catFailed into
 * `intended`, so intended inflates by exactly the same 1 and the
 * overAccounted guard -- which exists precisely to catch a counter
 * incremented on a path it does not own -- reports ok.
 */
describe("repair-finest-sport-conflation reportWrites arithmetic", () => {
  it("reports OK when every single re-key failed and nothing was written", () => {
    // 10 rows needed re-keying. Every one threw inside moveCatalogRow.
    const catWrong = 10;
    const catMovedOntoNew = 10; // incremented before the throwing await
    const catMergedIntoExisting = 0;
    const catFailed = 10;
    const printRunBlanked = 0, printRunFailed = 0;
    const catAgree = 0, catAmbiguous = 0, catNoEvidence = 0;

    const r = reconcileWrites({
      job: "repair-finest-sport-conflation",
      intended: catWrong + printRunBlanked + printRunFailed + catFailed
        + catAgree + catAmbiguous + catNoEvidence,
      written: catMovedOntoNew + catMergedIntoExisting + printRunBlanked,
      skipped: catAgree + catAmbiguous + catNoEvidence,
      failed: catFailed + printRunFailed,
    });

    // eslint-disable-next-line no-console
    console.log("RECONCILE VERDICT (0 rows actually written):", JSON.stringify(r));

    // The job wrote NOTHING. A correct reconciliation must not be ok.
    expect(r.written ?? (catMovedOntoNew + catMergedIntoExisting)).toBe(10); // claims 10 written
    expect(r.ok).toBe(true); // ...and passes. THIS IS THE DEFECT.
    expect(r.overAccounted).toBe(0); // the double-count guard is blind
  });

  it("the same shape without the double count would be caught", () => {
    // What it SHOULD look like: 10 intended, 0 written, 10 failed.
    const r = reconcileWrites({
      job: "control",
      intended: 10, written: 0, skipped: 0, failed: 10,
    });
    // correct accounting: failed accounts for them, ok -- but `written` is
    // honestly 0, so the banner does not claim work that did not happen.
    // eslint-disable-next-line no-console
    console.log("CONTROL (honest counters):", JSON.stringify(r));
    expect(r.ok).toBe(true);
  });
});
