// CF-TCA-TCGPLAYER-PAUSE-REVERT (Drew, 2026-09-12).
//
// DECISION: pause the TCGplayer platform on the SCHEDULED (cron) TCA firehose
// pulls for 5 days -- 2026-09-13 through 2026-09-18 -- so its ~100K rows/day
// of the 200K/day TCA quota goes to an eBay-only back-fill of feed days
// 2026-09-04..09-12 instead. Manual dispatches are UNCHANGED: `platforms`
// still defaults to 'eBay,TCGplayer' so the steward can pull TCGplayer
// explicitly on demand; only the schedule's effective platforms became
// 'eBay' for this window.
//
// This is a "forget to revert" trap by construction -- a temporary quota
// reallocation that nobody is paged about once the 5 days pass. This test
// is the page: it goes red the day after the stated revert date if the
// schedule branch of the PLATFORMS ternary is still pausing TCGplayer.
//
// On 2026-09-18, revert by restoring the single-literal fallback:
//   PLATFORMS="${{ inputs.platforms || 'eBay,TCGplayer' }}"
// and deleting the TEMPORARY comment block above it. Once that lands, this
// test (and the two "manual-dispatch fallback" tests it forced a rename on
// in tcaQuotaWindowAndBudget.test.ts) should be reverted or deleted too.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FIREHOSE = fs
  .readFileSync(
    path.join(__dirname, "..", "..", ".github", "workflows", "tca-firehose-ingest.yml"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

const REVERT_BY = new Date("2026-09-18T00:00:00Z");

/** Matches the schedule-paused PLATFORMS ternary this decision introduced. */
const PAUSE_PATTERN =
  /PLATFORMS="\$\{\{ inputs\.platforms \|\| \(github\.event_name == 'schedule' && 'eBay' \|\| '[^']+'\) \}\}"/;

describe("TCGplayer schedule pause (2026-09-13 -> 2026-09-18) has a revert deadline", () => {
  it("documents the temporary pause with a dated comment while it is present", () => {
    if (!PAUSE_PATTERN.test(FIREHOSE)) return; // already reverted -- nothing to check
    expect(FIREHOSE).toMatch(/TEMPORARY 2026-09-13.+2026-09-18/);
    expect(FIREHOSE).toMatch(/TCGplayer paused to free quota[\s\S]*?eBay back-fill/);
  });

  it("FAILS once the revert date has passed and the pause is still in the workflow", () => {
    const now = new Date();
    const stillPaused = PAUSE_PATTERN.test(FIREHOSE);
    if (now > REVERT_BY) {
      expect(
        stillPaused,
        "TCGplayer's scheduled-run pause was due to revert on 2026-09-18 and is still present. " +
          "Restore: PLATFORMS=\"${{ inputs.platforms || 'eBay,TCGplayer' }}\" " +
          "and remove the TEMPORARY 2026-09-13 -> 2026-09-18 comment block in " +
          ".github/workflows/tca-firehose-ingest.yml.",
      ).toBe(false);
    } else {
      // Before the deadline this is a no-op assertion -- the test file's job
      // is to exist and be wired into the suite, not to fail early.
      expect(typeof stillPaused).toBe("boolean");
    }
  });

  it("manual dispatch keeps its own platforms input untouched by the pause", () => {
    // The decision explicitly keeps manual dispatch on 'eBay,TCGplayer' (or
    // whatever the operator passes) so the steward can still pull TCGplayer
    // on demand during the pause window.
    const formDefault = FIREHOSE.match(/platforms:[\s\S]*?default:\s*'([^']+)'/);
    expect(formDefault, "the platforms input must still carry a default").not.toBeNull();
    const defaults = formDefault![1].split(",").map((s) => s.trim().toLowerCase());
    expect(defaults).toContain("ebay");
    expect(defaults).toContain("tcgplayer");
  });
});
