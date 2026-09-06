/**
 * CF-A-DISCARDED-BANNER-IS-A-LOST-DIAGNOSIS (2026-09-06, run 34018058461).
 *
 * `run()` returns the child's stdout and the ingest call site threw it away.
 * The child ingester prints an accounting banner — rows read, rows written, of
 * which KEPT THE EXISTING ROW, rows skipped, subset clashes, failures — and
 * none of it ever reached a driver log.
 *
 * That cost a whole investigation. Run 34018058461 reported only:
 *
 *   SHORT INGEST — compared 2,747 staged identities against
 *   2020/topps-chrome-uefa-champions-league: 1,944 present, 803 missing
 *
 * The child had ALREADY counted the answer. 803 rows landed on ids two other
 * 2020 soccer products held (their setKeys collapse to one `topps-chrome`
 * namespace), so the merge kept each incumbent and `keptExisting` was 803 —
 * printed on a line nobody could see. Reading it would have named the cause
 * immediately instead of requiring a staged-CSV re-derivation.
 *
 * These tests pin the SURFACE, in both directions:
 *   - a child that reports keptExisting=N puts N in the driver's log;
 *   - the two lines that are load-bearing to a machine elsewhere — the child's
 *     own budget marker and its reconciliation JSON — never appear verbatim.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const driver = require_("../scripts/ingest-universe-driver.cjs") as {
  childBannerLines: (stdout: string | null | undefined) => string[];
  CHILD_BANNER_LINES: number;
  CHILD_BANNER_PATTERNS: RegExp[];
};

/** A realistic child banner: the shape run 34018058461's ingest actually printed. */
const CHILD_STDOUT = [
  "1 files  source=checklistcenter-2026-09-06 (checklist)  APPLY",
  "",
  "APPLY",
  "  files ingested         1",
  "  files already done     0   <- resumed past these",
  "  files with no manifest 0   <- could not name the product",
  "  categories REFUSED, exploded 0 (0 rows)   <- >150 rungs or >2,000 card numbers inside ONE category; a cross-join, not a checklist",
  "  files with nothing left 0   <- every category refused",
  "  rows with card-line parallel 0   <- \"100 Mike Trout\" is not a rung; skipped",
  "  rows with player-name parallel 0   <- a roster line, not a rung; skipped",
  "  csv rows read          2,747",
  "  catalog rows written   2,747",
  "  ingested 2,747 rows (0 signed)   <- signed = isAuto, from a section the page attested",
  "    of which kept the existing row 803   <- same id already held by another source at equal/higher authority and confidence; only lastSeenAt moved, the row does NOT carry source=checklistcenter-2026-09-06",
  "  throughput             1,200 rows/min",
  "  rows skipped           0   <- no card number, no player, or unslugable",
  "  subset clashes RESOLVED   0   <- same (cardNumber, rung) under a DIFFERENT subset",
  "  subset collisions REFUSED 0   <- the clash is real but ONE SIDE OF IT HAS NO SUBSET NAME",
  "  numbered, parallel blank 0   <- NOT written as Base; the name is unknown",
  "  rows not reached       0   <- the budget stopped before these",
  "  failed                 0",
  "",
  "stopped at the 59-minute budget — the relaunch continues from here",
  "{\"event\":\"write_reconciliation\",\"job\":\"ingest-checklist-csv-to-catalog\",\"intended\":2747,\"written\":2747,\"ok\":true}",
].join("\n");

describe("CF-A-DISCARDED-BANNER-IS-A-LOST-DIAGNOSIS", () => {
  it("surfaces keptExisting — the number that explained run 34018058461", () => {
    const lines = driver.childBannerLines(CHILD_STDOUT);
    const kept = lines.find((l) => /kept the existing row/.test(l));
    // THE WHOLE POINT: the 803 must be visible, as a number, in the log.
    expect(kept).toBeDefined();
    expect(kept).toContain("803");
    // And it must reach a reader as ONE line, not as a paragraph of rationale.
    expect(kept).toBe("of which kept the existing row 803");
  });

  it("carries every accounting line a verdict is argued from", () => {
    const lines = driver.childBannerLines(CHILD_STDOUT);
    const joined = lines.join("\n");
    for (const want of [
      "csv rows read",
      "catalog rows written",
      "kept the existing row",
      "rows skipped",
      "rows not reached",
      "subset collisions REFUSED",
      "failed",
    ]) {
      expect(joined).toContain(want);
    }
  });

  it("never repeats the child's budget marker — it would re-dispatch the lane", () => {
    // MUTATION-RELEVANT GUARD. The workflow greps the WHOLE log for
    // /stopped at the .*budget/ and re-dispatches when it matches. A CHILD
    // hitting its per-entry budget says nothing about the driver's, so passing
    // that line through invents a budget stop the driver never had.
    const lines = driver.childBannerLines(CHILD_STDOUT);
    expect(lines.some((l) => /stopped at the .*budget/.test(l))).toBe(false);
  });

  it("never repeats the child's reconciliation JSON", () => {
    // The workflow's other steps grep for {"event":...} objects. A second copy
    // under a different job's name is a false reading of a job that did not run.
    const lines = driver.childBannerLines(CHILD_STDOUT);
    expect(lines.some((l) => l.includes("write_reconciliation"))).toBe(false);
    expect(lines.some((l) => l.trimStart().startsWith("{"))).toBe(false);
  });

  it("is bounded, and answers empty for an unreadable stream", () => {
    // A surface that cannot be produced costs a quieter log, never an
    // exception on the ingest path.
    expect(driver.childBannerLines(null)).toEqual([]);
    expect(driver.childBannerLines(undefined)).toEqual([]);
    expect(driver.childBannerLines("")).toEqual([]);
    expect(driver.childBannerLines("nothing here matches")).toEqual([]);
    // Bounded even against a pathological stream.
    const flood = Array.from({ length: 500 }, () => "  failed                 1").join("\n");
    expect(driver.childBannerLines(flood).length).toBeLessThanOrEqual(driver.CHILD_BANNER_LINES);
  });

  it("keeps the exploded-category refusal, which names a file the gate dropped", () => {
    const lines = driver.childBannerLines([
      "!! EXPLODED category refused: 2012-topps.csv [base]  rows=99,994 distinct parallels=612 distinct cardNumbers=99,994",
      "  catalog rows written   0",
    ].join("\n"));
    expect(lines.some((l) => l.startsWith("!! EXPLODED category refused:"))).toBe(true);
  });
});
