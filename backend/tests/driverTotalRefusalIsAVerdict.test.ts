/**
 * CF-A-TOTAL-REFUSAL-IS-NOT-A-GREEN-INGEST (2026-09-06, run 34038740849).
 *
 * The SCC baseball 1970-1999 walk logged eight consecutive entries as
 *
 *   FAILED — green ingest, 0 rows landed
 *
 * and the child's own banner, printed directly above each one, had already
 * said what happened. Entry [3], 1998 SP Authentic Sheer Dominance:
 *
 *   child: csv rows read          42
 *   child: catalog rows written   0
 *   child: subset collisions REFUSED 42
 *   child: failed                 0
 *
 * Every staged row was REFUSED, deliberately, by the subset-collision guard
 * (#1741): the stored baseballcardpedia rows at those rungs carry subsetName
 * "Inserts", the SCC insert page states no subset, and blank is unknown and is
 * never invented. Verified in prod card_catalog — 1998/1999 `sp-authentic`
 * hold 56 and 130 rows tagged subsetName "Inserts" from baseballcardpedia, and
 * NO rows for any of the eight products landed under any key, by any source.
 *
 * The refusal is CORRECT. What was wrong is the sentence written about it:
 * "green ingest, 0 rows landed" claims the ingest was green (it refused every
 * row and counted them) and that the cause is unknown (the child named it).
 * It sent an operator hunting a broken pipe or a mis-derived setKey — the two
 * causes that sentence has always meant (#1738, #1739) — when nothing was lost.
 *
 * These tests pin the verdict in BOTH directions, because the value of the
 * rule is entirely in where it stops:
 *   - a child that refused every row it read is `refused`: terminal, so the
 *     entry leaves the pending queue instead of re-buying the same decision,
 *     and streak-NEUTRAL, because fetching/parsing/staging/ingesting the page
 *     is positive proof the lane is UP;
 *   - a child that wrote rows, refused only some, reported a failure, or read
 *     nothing is NOT refused — every one of those stays exactly as it was;
 *   - three real failures still abort the lane.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const driver = require_("../scripts/ingest-universe-driver.cjs") as {
  childCounters: (stdout: string | null | undefined) => Record<string, number> | null;
  childRefusedEverything: (counters: Record<string, number> | null) => boolean;
  streakAfter: (streak: number, verdict: unknown) => number;
  TERMINAL_STATUSES: Set<string>;
  STREAK_STATUSES: Set<string>;
  REFUSED_STATUS: string;
  SYSTEMIC_FAILURE_STREAK: number;
};

/** Entry [3] of run 34038740849, verbatim: read 42, wrote 0, refused 42. */
const TOTAL_REFUSAL = [
  "  files with no manifest 0",
  "  categories REFUSED, exploded 0 (0 rows)",
  "  csv rows read          42",
  "  catalog rows written   0",
  "    of which kept the existing row 0",
  "  rows skipped           0",
  "  subset clashes RESOLVED   0",
  "  subset collisions REFUSED 42   <- the clash is real but ONE SIDE OF IT HAS NO SUBSET NAME",
  "  rows not reached       0",
  "  failed                 0",
].join("\n");

/** Entry [2] of the same run: the child wrote 6 rows. Not a refusal. */
const WROTE_ROWS = [
  "  csv rows read          6",
  "  catalog rows written   6",
  "    of which kept the existing row 0",
  "  rows skipped           0",
  "  subset collisions REFUSED 0",
  "  rows not reached       0",
  "  failed                 0",
].join("\n");

const banner = (over: Record<string, string | number>) =>
  [
    `  csv rows read          ${over.read ?? 42}`,
    `  catalog rows written   ${over.written ?? 0}`,
    `  rows skipped           ${over.skipped ?? 0}`,
    `  subset collisions REFUSED ${over.subsetRefused ?? 42}`,
    `  rows not reached       ${over.notReached ?? 0}`,
    `  failed                 ${over.failed ?? 0}`,
  ].join("\n");

describe("CF-A-TOTAL-REFUSAL-IS-NOT-A-GREEN-INGEST", () => {
  it("reads the child's counters as NUMBERS, not text", () => {
    // The counters were already printed and then discarded; that discard is
    // how the driver wrote "green ingest" over a child that had counted the
    // answer. Thousands separators are the child's own format.
    const c = driver.childCounters(TOTAL_REFUSAL);
    expect(c).not.toBeNull();
    expect(c!.read).toBe(42);
    expect(c!.written).toBe(0);
    expect(c!.subsetRefused).toBe(42);
    expect(c!.failed).toBe(0);
    expect(driver.childCounters("  csv rows read          2,747")!.read).toBe(2747);
  });

  it("THE FIXTURE: read 42, wrote 0, refused 42 is a refusal", () => {
    expect(driver.childRefusedEverything(driver.childCounters(TOTAL_REFUSAL))).toBe(true);
  });

  it("`refused` is TERMINAL — the entry leaves the pending queue", () => {
    // The guard is deterministic: given the same page and the same stored rows
    // it refuses identically on every pass. Leaving the entry pending re-buys
    // a decision already made — 8 of run 34038740849's 170 slots bought that.
    expect(driver.TERMINAL_STATUSES.has(driver.REFUSED_STATUS)).toBe(true);
  });

  it("`refused` is STREAK-NEUTRAL — reaching it proves the lane is UP", () => {
    // MUTATION-RELEVANT. The streak may conclude exactly one thing: the host
    // is down. Reaching a merge refusal required the page to be fetched,
    // parsed, staged and ingested, which is evidence against that conclusion.
    expect(driver.STREAK_STATUSES.has(driver.REFUSED_STATUS)).toBe(false);
    const verdict = { status: driver.REFUSED_STATUS, laneProvenHealthy: true };
    expect(driver.streakAfter(2, verdict)).toBe(0);
  });

  describe("where the rule STOPS — none of these is a refusal", () => {
    it("a child that WROTE rows (entry [2]) is not refused", () => {
      expect(driver.childRefusedEverything(driver.childCounters(WROTE_ROWS))).toBe(false);
    });

    it("a PARTIAL refusal leaves rows unaccounted for — still a failure", () => {
      // 42 read, 3 refused: 39 rows vanished with no stated reason, and that
      // gap is exactly the unexplained loss `failed` exists to report.
      expect(driver.childRefusedEverything(driver.childCounters(banner({ subsetRefused: 3 })))).toBe(false);
    });

    it("a child reporting its own failures is not refused, however it counted", () => {
      expect(driver.childRefusedEverything(driver.childCounters(banner({ failed: 1 })))).toBe(false);
    });

    it("a child that read nothing is not refused — that is `empty`", () => {
      expect(driver.childRefusedEverything(driver.childCounters(banner({ read: 0, subsetRefused: 0 })))).toBe(false);
    });

    it("a missing counter is an ABSENCE, never a zero", () => {
      // A zero is a measurement and an absence is not. A truncated banner must
      // not be able to masquerade as a clean refusal.
      const noWritten = ["  csv rows read          42", "  subset collisions REFUSED 42"].join("\n");
      expect(driver.childRefusedEverything(driver.childCounters(noWritten))).toBe(false);
      expect(driver.childRefusedEverything(null)).toBe(false);
      expect(driver.childCounters("")).toBeNull();
    });
  });

  it("KEEPS THE ABORT: three real failures still take the lane down", () => {
    // The 8 refusals never tripped the tripwire — entries [9] [10] [11] did,
    // three genuine `unreachable`s in a row, and that abort was correct. The
    // streak must still reach the threshold on real failures.
    let streak = 0;
    for (let i = 0; i < driver.SYSTEMIC_FAILURE_STREAK; i++) {
      streak = driver.streakAfter(streak, { status: "unreachable" });
    }
    expect(streak).toBeGreaterThanOrEqual(driver.SYSTEMIC_FAILURE_STREAK);

    let f = 0;
    for (let i = 0; i < driver.SYSTEMIC_FAILURE_STREAK; i++) {
      f = driver.streakAfter(f, { status: "failed" });
    }
    expect(f).toBeGreaterThanOrEqual(driver.SYSTEMIC_FAILURE_STREAK);
  });

  it("a refusal resets the streak, on the same proof a content refusal does", () => {
    // Honest about the shape chosen: laneProvenHealthy RESETS, which is the
    // treatment a cleanliness-gate content refusal already gets (#1855).
    // Pinned so a change to that choice is deliberate, never drift.
    const refused = { status: driver.REFUSED_STATUS, laneProvenHealthy: true };
    expect(driver.streakAfter(2, refused)).toBe(0);
  });
});
