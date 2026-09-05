/**
 * The driver's demoted-lane NOTE, and the one thing that could go wrong with it.
 *
 * CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
 * 2026-09-05). The universe driver refuses a lane whose stamped source is not a
 * checklist at all, and hobbymonitor's IS one — so a demoted lane still
 * ingests. The driver says so in a NOTE rather than guessing, because at that
 * point in a run no row exists yet: the fetch has not happened and the identity
 * cell the corroboration read needs is not knowable. Asking the question there
 * would be asking it of nothing.
 *
 * WHY THE DRIVER CARRIES A LITERAL LIST AND THIS TEST EXISTS. Requiring the
 * corroboration bridge in the driver costs a `dist/` load on EVERY spawn —
 * measured at +43s across ingestUniverseDriverReconcilesReportMode's own suite
 * (87s -> 130s), enough to blow a 30s per-test budget under a parallel run, and
 * it did. The banner is cosmetic; the demotion is enforced at pricing and
 * rematch time where the ONE predicate genuinely runs. So the driver compares
 * strings instead, and THIS pin is what keeps the two lists from drifting.
 *
 * The drift is harmless by construction — a stale driver list costs a missing
 * NOTE line and classifies nothing — but "harmless" is exactly how a second
 * copy of a list survives long enough to be mistaken for the real one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CORROBORATION_REQUIRED_SOURCES, requiresCorroboration } from "../src/services/catalog/sourceCorroboration.js";

const DRIVER = readFileSync(path.resolve(__dirname, "..", "scripts", "ingest-universe-driver.cjs"), "utf8");

/** The literal the driver compares lane names against. */
function driverList(): string[] {
  const m = DRIVER.match(/const DEMOTED_LANE_NAMES = \[([^\]]*)\];/);
  expect(m, "the driver must declare DEMOTED_LANE_NAMES").toBeTruthy();
  return m![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

describe("the driver's demoted-lane list tracks the one definition", () => {
  it("names exactly the sources sourceCorroboration demotes", () => {
    expect(driverList().sort()).toEqual([...CORROBORATION_REQUIRED_SOURCES].sort());
  });

  it("every name it carries really is demoted by the shared predicate", () => {
    for (const n of driverList()) expect(requiresCorroboration(n), n).toBe(true);
  });

  it("matches a DATED re-scrape, which is how the lane's source is actually stamped", () => {
    // LANE_SOURCE stamps `hobbymonitor` and the ingest appends the run date, so
    // an equality-only comparison would print the NOTE in a unit test and never
    // in production — the silent no-op this check exists to catch.
    const m = DRIVER.match(/const laneStem = [^\n]*\n\s*if \(DEMOTED_LANE_NAMES\.some\(\(n\) => ([^)]*)\)\)/);
    expect(m, "the lane comparison must strip the date and prefix-match").toBeTruthy();
    expect(m![1]).toContain("startsWith");
    expect(DRIVER).toContain("replace(/-\\d{4}-\\d{2}-\\d{2}.*$/, \"\")");
  });
});

describe("the driver does NOT pay for the demotion it only reports", () => {
  it("never requires the corroboration bridge — a dist/ load on every spawn", () => {
    expect(DRIVER).not.toContain("source-corroboration.cjs");
  });

  it("still REFUSES a lane that is not a checklist at all — that gate is untouched", () => {
    expect(DRIVER).toContain("which catalogAuthority classifies as");
    expect(DRIVER).toContain("process.exit(2);");
  });

  it("the NOTE is a note: a demoted lane ingests, it is not refused", () => {
    const note = DRIVER.slice(DRIVER.indexOf("DEMOTED_LANE_NAMES"), DRIVER.indexOf("if (!process.env.COSMOS_CONNECTION_STRING)"));
    expect(note).toContain("console.log(`NOTE:");
    expect(note).not.toContain("process.exit");
  });
});
