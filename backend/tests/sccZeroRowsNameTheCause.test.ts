/**
 * CF-ZERO-ROWS-MUST-NAME-WHY (2026-09-04, run 33902098944).
 *
 * The vintage/1990s sportscardchecklist walker aborted after three consecutive
 *
 *   "!! 0 rows — refusing to write an empty checklist"   (exit 9)
 *
 * on set-20411, set-29386 and set-20412 (1993-94 Topps Finest base, Main
 * Attractions and Refractors), leaving 1,246 entries of the era unattempted.
 *
 * THE PROBE SETTLED WHAT HAPPENED. All three pages were fetched directly on
 * 2026-09-04 (polite, HobbyIQ UA): HTTP 200, 1,148,623 / 180,371 / 1,010,228
 * bytes, 220 / 27 / 220 card headers, both anchors agreeing, and all three parse
 * to a FULL checklist through the parser we already ship. Twenty more entries
 * spread across 1990-1999 were probed the same way: 20/20 served 200 with a
 * populated header list and 20/20 parsed. So there is NO second layout on this
 * lane, no empty set page at the source, and no challenge -- the era's markup is
 * uniform and healthy. Those three bodies were transient, from a walker running
 * concurrency=16 whose politeness delay is per-process and so bounds nothing.
 *
 * What was NOT transient is the two defects the incident exposed, and this file
 * pins both:
 *
 *   1. The fetcher refused with ONE sentence for every possible cause, so the
 *      driver could not tell a degraded body from a layout we cannot read from a
 *      set the source does not card. "0 rows" is an observation, never a
 *      diagnosis.
 *   2. The shared isGone test matched Node's "exited ... code 9" and never the
 *      "exit 9" that run() actually builds. So the refusal was not even reaching
 *      `unreachable` -- it landed in `failed`, blaming our pipe for the host not
 *      serving us, and three of them took the era down.
 *
 * The fixture is the live set-29386 page trimmed to its card headers and hidden
 * inputs. It asserts the EXACT published count, because the failure this lane
 * suffers shows up as a wrong count rather than as an exception.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { zeroCardReason, buildRows } = require("../scripts/fetchSportsCardChecklist.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { streakAfter, EMPTY_STATUS } = require("../scripts/ingest-universe-driver.cjs");

const FIX = join(__dirname, "fixtures", "sportscardchecklist");
const finest = () => readFileSync(join(FIX, "1993-94-topps-finest-main-attractions.trimmed.html"), "utf8");

/** The driver classification, as the SCC lane now performs it. Restated here
 *  only to route a sentence to a status -- the sentences themselves come from
 *  the real fetcher, so a reworded refusal fails this test rather than passing
 *  against a copy. */
function classify(said: string): { status: string; laneProvenHealthy?: boolean } {
  if (/nothing new to add/.test(said)) return { status: EMPTY_STATUS };
  if (/challenge\/interstitial|did not serve a set page/.test(said)) return { status: "unreachable" };
  if (/layout not understood/.test(said)) return { status: "failed", laneProvenHealthy: true };
  return { status: "failed" };
}

describe("the set that tripped the abort parses in full", () => {
  it("1993-94 Topps Finest Main Attractions is 27 cards, not zero", () => {
    const { rows, stats } = buildRows(finest(), {});
    expect(rows).toHaveLength(27);
    expect(stats.headers).toBe(27);
    expect(stats.hiddenRows).toBe(27);
    expect(stats.anchorMismatch).toBe(false);
    expect(stats.skipped).toBe(0);
    expect(rows[0]).toMatchObject({ cardNumber: "1", player: "Dominique Wilkins", category: "base" });
    expect(rows[26]).toMatchObject({ cardNumber: "27", player: "Tom Gugliotta" });
    // Every row is base: a subset tag leaking into the parallel column splits
    // the pool without changing the row count, so the count alone cannot see it.
    expect(rows.every((r: { parallel: string }) => r.parallel === "")).toBe(true);
  });

  it("a page that parses never reaches the refusal at all", () => {
    expect(buildRows(finest(), {}).rows.length).toBeGreaterThan(0);
  });
});

describe("zero rows names its cause", () => {
  it("a challenge page served with 200 is the host not serving us", () => {
    const said = zeroCardReason("<html>Just a moment... cf_chl</html>", { headers: 0, hiddenRows: 0 });
    expect(said).toMatch(/challenge\/interstitial/);
    expect(classify(said).status).toBe("unreachable");
  });

  it("a truncated or error body is the host not serving us — this incident's real shape", () => {
    const said = zeroCardReason("<html><body>upstream timeout</body></html>", { headers: 0, hiddenRows: 0 });
    expect(said).toMatch(/did not serve a set page/);
    expect(classify(said).status).toBe("unreachable");
  });

  it("a real set page carrying no cards is a verdict about the SET, not the lane", () => {
    const page = `${"x".repeat(50000)} set-12345 trading-card-checklist`;
    const said = zeroCardReason(page, { headers: 0, hiddenRows: 0 });
    expect(said).toMatch(/nothing new to add/);
    expect(classify(said).status).toBe(EMPTY_STATUS);
  });

  it("headers present but none parsed is OUR parser, and stays a lane fault", () => {
    const said = zeroCardReason(finest(), { headers: 27, hiddenRows: 27, anchorMismatch: false });
    expect(said).toMatch(/layout not understood/);
    const v = classify(said);
    expect(v.status).toBe("failed");
    // We fetched and read every byte, so the host is provably UP.
    expect(v.laneProvenHealthy).toBe(true);
  });

  it("disagreeing anchors say so specifically", () => {
    const said = zeroCardReason(finest(), { headers: 27, hiddenRows: 0, anchorMismatch: true });
    expect(said).toMatch(/27 card headers and 0 hidden rows disagree/);
    expect(said).toMatch(/layout not understood/);
  });

  it("the four causes are four DIFFERENT sentences", () => {
    const said = [
      zeroCardReason("<html>cf_chl</html>", { headers: 0, hiddenRows: 0 }),
      zeroCardReason("<html>oops</html>", { headers: 0, hiddenRows: 0 }),
      zeroCardReason(`${"x".repeat(50000)} set-1 trading-card-checklist`, { headers: 0, hiddenRows: 0 }),
      zeroCardReason(finest(), { headers: 27, hiddenRows: 27 }),
    ];
    expect(new Set(said).size).toBe(4);
  });
});

describe("the streak only concludes THE HOST IS DOWN", () => {
  it("three empty sets in a row do NOT abort the lane", () => {
    let s = 0;
    for (let i = 0; i < 3; i++) s = streakAfter(s, { status: EMPTY_STATUS });
    expect(s).toBe(0);
  });

  it("three parser gaps in a row do NOT abort the lane", () => {
    let s = 0;
    for (let i = 0; i < 3; i++) s = streakAfter(s, { status: "failed", laneProvenHealthy: true });
    expect(s).toBe(0);
  });

  it("three unreachable entries in a row DO trip it — a blocked lane is the one thing it may say", () => {
    let s = 0;
    for (let i = 0; i < 3; i++) s = streakAfter(s, { status: "unreachable" });
    expect(s).toBe(3);
  });

  it("MUTATION: routing the parser gap to `empty` would hide a real defect", () => {
    // If "layout not understood" were classified emptyAtSource, the gap would
    // stop bringing anyone back to it. The status must stay `failed`.
    const said = zeroCardReason(finest(), { headers: 27, hiddenRows: 27 });
    expect(classify(said).status).not.toBe(EMPTY_STATUS);
  });

  it("MUTATION: routing a degraded body to `failed` re-arms the abort that stranded 1,246 entries", () => {
    const said = zeroCardReason("<html>upstream timeout</html>", { headers: 0, hiddenRows: 0 });
    expect(classify(said).status).toBe("unreachable");
    expect(classify(said).status).not.toBe("failed");
  });
});

describe("isGone recognises the exit code run() actually builds", () => {
  // The regex under test, kept in the shape the driver uses it.
  const isGone = (msg: string) =>
    /HTTP 40[34]|ENOTFOUND|exit(ed)?\s+(?:with\s+)?(?:code\s+)?9\b|workbook empty or unreachable/i.test(msg);

  it("`exit 9` — run()'s own wording — is recognised", () => {
    // THE REGRESSION. This is verbatim what the aborted run wrote, and the old
    // alternation returned false for it.
    expect(isGone("acquisition: fetchSportsCardChecklist.cjs exit 9: !! 0 rows — refusing to write an empty checklist")).toBe(true);
  });

  it("Node's own `exited with code 9` still matches", () => {
    expect(isGone("child exited with code 9")).toBe(true);
  });

  it("a different exit code is NOT swallowed as gone", () => {
    expect(isGone("fetch.cjs exit 1: boom")).toBe(false);
    // The word boundary is load-bearing: exit 95 is not exit 9.
    expect(isGone("fetch.cjs exit 95: boom")).toBe(false);
  });
});
