/**
 * The two defects of Backfill Runner 33997480307 (clc, SPORTS=hockey,soccer,
 * YEARS=2019..2022, BACKFILL_APPLY=true), which reconciled against ITSELF:
 *
 *   [2/85] under source checklistcenter-2026-09-05: 417 rows (of 25,200 ...)
 *          SHORT INGEST — 103 of 1,017 staged identities missing (914 present)
 *   ...
 *   rows created        0   (verified by catalog read, not claimed)
 *   [ingest-universe-driver] reconciled: intended 85 = written 0 + skipped 67 + failed 18
 *
 * Twelve entries each named thousands of landed rows and every one was counted
 * `failed`, while the summary said zero rows were created.
 *
 * A. CF-A-COLLAPSED-KEY-IS-A-DIFFERENT-PRODUCT. `setKeyCandidates` added the
 *    NORMALIZED form of every stated key, and normalizeSetKey is a product-
 *    family resolver: with no vocabulary row for the specialization it answers
 *    with the flagship. So the verification of a 65-row Juventus team set also
 *    read `2021/topps` — 147,149 rows of eighty other products (Cosmos,
 *    2026-09-06) — and `after - before` became a difference of two six-figure
 *    numbers, while the identity diff found staged identities "present" in a
 *    pool this run never wrote to.
 *
 *    The fix is NOT a revert of #1738: a key someone STATED still stays, and so
 *    does a normalization that resolves a SPELLING (`finest` -> `topps-finest`).
 *    What is dropped is a key nothing stated, invented by collapsing a stated
 *    one onto its own prefix.
 *
 * B. CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE. A shortfall in the staged-
 *    identity diff was filed under the same word as a severed pipe. An entry
 *    that landed 5,636 rows and is missing 176 rungs is a different finding and
 *    needs its own word, or the banner cannot say which happened — and as
 *    `failed` it was also non-terminal, so the entry would be re-attempted
 *    forever over rows already in the catalog.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const driver = require_("../scripts/ingest-universe-driver.cjs");
const DRIVER_SRC = path.join(__dirname, "..", "scripts", "ingest-universe-driver.cjs");
const FIX = path.join(__dirname, "fixtures", "collapsed-key");
const fix = (n: string) => path.join(FIX, n);

/** The real clc entries of the run, as backend/data/ingest-universe.json names them. */
const JUVENTUS = { lane: "clc", year: 2021, sport: "soccer", setName: "topps juventus team set soccer" };
const BUNDESLIGA = { lane: "clc", year: 2021, sport: "soccer", setName: "topps chrome bundesliga soccer" };

describe("A. a collapsed key is a different product", () => {
  it("the fixtures state the narrow key the child wrote under", () => {
    const cases = [
      { f: "juventus", key: "topps-juventus-team-set", n: 65 },
      { f: "bundesliga", key: "topps-chrome-bundesliga", n: 2213 },
    ];
    for (const c of cases) {
      const m = JSON.parse(fs.readFileSync(fix(c.f + ".manifest.json"), "utf8"));
      expect(m.setKey).toBe(c.key);
      expect(m.rowCount).toBe(c.n);
    }
  });

  it("never offers the flagship a specialization collapses onto", () => {
    // Cosmos, 2026-09-06: 2021/topps holds 147,149 rows and ZERO of them came
    // from this run; 2021/topps-chrome holds 31,898, likewise zero.
    const juve = driver.setKeyCandidates(JUVENTUS, [fix("juventus.csv")]);
    expect(juve).toContain("topps-juventus-team-set");
    expect(juve).not.toContain("topps");

    const bund = driver.setKeyCandidates(BUNDESLIGA, [fix("bundesliga.csv")]);
    expect(bund).toContain("topps-chrome-bundesliga");
    expect(bund).not.toContain("topps-chrome");
  });

  it("still leads with the manifest key, and still answers without one", () => {
    // #1739 stands: the manifest is the writer's own statement of where the
    // rows went, so it leads and never becomes a precondition.
    const keys = driver.setKeyCandidates(JUVENTUS, [fix("juventus.csv")]);
    expect(keys[0]).toBe("topps-juventus-team-set");
    const noManifest = driver.setKeyCandidates(JUVENTUS, []);
    expect(noManifest.length).toBeGreaterThan(0);
  });

  it("WITHOUT a manifest the collapsed key stays — nothing stated where rows went", () => {
    // The rule is scoped to a STATED key. #1739's hobbymonitor entries have no
    // manifest, the child may itself have resolved the name through
    // normalizeSetKey, and a product whose manifest omitted a setKey must still
    // be counted rather than reported wholly missing. A wrong guess there costs
    // a false `failed`; dropping it costs a real ingest reported as zero rows.
    const noManifest = driver.setKeyCandidates({ lane: "hobbymonitor", setName: "2025/26 Topps Three Basketball", year: 2025 });
    expect(noManifest).toContain("topps-three");
    expect(noManifest).toContain("topps");
    // and the SAME entry, once a manifest states the key, drops the collapse.
    const withManifest = driver.setKeyCandidates(JUVENTUS, [fix("juventus.csv")]);
    expect(withManifest).not.toContain("topps");
  });

  it("collapsesToParent tells an alias from a family collapse", () => {
    // A collapse shrinks a key onto its own leading segments; an alias does not.
    expect(driver.collapsesToParent("topps-chrome-bundesliga", "topps-chrome")).toBe(true);
    expect(driver.collapsesToParent("topps-juventus-team-set", "topps")).toBe(true);
    // `finest` -> `topps-finest` is the alias #1738 exists for and must survive.
    expect(driver.collapsesToParent("finest", "topps-finest")).toBe(false);
    expect(driver.collapsesToParent("topps", "topps")).toBe(false);
  });

  it("both ends of the delta read the same key", () => {
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    // `before` was read before acquisition, when no manifest existed to read,
    // so it resolved a different candidate list than `after`.
    expect(src).toMatch(/before = await countCatalogRows\(entry, csvPaths\);/);
    expect(src).not.toMatch(/const before = await countCatalogRows\(entry\);/);
  });
});

describe("B. an entry that landed rows is not a failure", () => {
  it("short-ingest is its own status, and terminal", () => {
    expect(driver.SHORT_STATUS).toBe("short-ingest");
    // Terminal: the rows ARE in the catalog, so re-running re-ingests what is
    // already there.
    expect(driver.TERMINAL_STATUSES.has(driver.SHORT_STATUS)).toBe(true);
    // and it is NOT `failed`, the bucket for an entry that could not land.
    expect(driver.SHORT_STATUS).not.toBe("failed");
  });

  it("never advances the systemic streak", () => {
    // The streak may conclude exactly one thing: the host is down. Reaching a
    // short ingest means we fetched, parsed, staged, ingested and read back.
    expect(driver.STREAK_STATUSES.has(driver.SHORT_STATUS)).toBe(false);
    expect(driver.streakAfter(2, { status: driver.SHORT_STATUS, laneProvenHealthy: true })).toBe(0);
  });

  it("the verdict NAMES what it compared", () => {
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    // "short ingest — N of N staged identities" never said which two things
    // disagreed, and the whole defect was a comparison against a wrong address.
    expect(src).toMatch(/compared the \$\{f\(shortIngest\.staged\)\} distinct identities staged/);
    expect(src).toMatch(/cardNumber\|parallel\|isAuto\|printRun/);
    expect(src).toMatch(/rows landed under \$\{sourceLabelFor\(lane\)\}/);
    expect(src).toMatch(/status: SHORT_STATUS/);
  });

  it("counts as written, never as loss, and keeps the reconcile contract", () => {
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    expect(src).toMatch(/written: verdicts\.ingested \+ verdicts\.partial \+ verdicts\[SHORT_STATUS\]/);
    // intended = written + skipped + failed still balances: the new bucket is
    // inside `written`, not beside it.
    expect(src).toMatch(/skipped: verdicts\.unreachable \+ verdicts\[EMPTY_STATUS\] \+ notReached/);
    expect(src).toMatch(/failed: verdicts\.failed/);
    // and the banner's own sum accounts for it too.
    expect(src).toMatch(/verdicts\[EMPTY_STATUS\] \+ verdicts\[SHORT_STATUS\]/);
  });

  it("rows created is a BY-SOURCE delta, and both ends read the same key", () => {
    const src = fs.readFileSync(DRIVER_SRC, "utf8");
    // The banner said 0 under twelve lines each naming thousands, because it
    // summed a WHOLE-PRODUCT delta across a collapsed key. #1856 reached the
    // same defect from the SCC Bowman's Best incident ("4,003 rows created"
    // for 200 staged cards) and landed the stronger instrument: a delta of two
    // BY-SOURCE counts, null when either end is unreadable rather than a
    // whole-product number wearing the by-source label. That is the one
    // implementation; this pin holds it, and adds the half it needs from here.
    expect(src).toMatch(/const created = \(rowsUnderSource === null \|\| beforeUnderSource === null\)/);
    expect(src).toMatch(/: rowsUnderSource - beforeUnderSource;/);
    expect(src).not.toMatch(/const created = \(after \?\? 0\) - \(before \?\? 0\);/);
    // BOTH ends of that delta must resolve the key the same way, so
    // `beforeUnderSource` is read from the same csvPaths `rowsUnderSource` is
    // -- a delta whose ends name two products measures nothing.
    expect(src).toMatch(/const beforeUnderSource = await countCatalogRowsBySource\(entry, sourceLabelFor\(lane\), csvPaths\)/);
    expect(src).not.toMatch(/countCatalogRowsBySource\(entry, sourceLabelFor\(lane\)\)\.catch/);
  });
});

describe("the reconcile contract still closes on the real run's numbers", () => {
  it("85 = 12 short-ingest + 67 not reached + 6 failed", async () => {
    const { reconcileWrites } = await import("../src/services/ops/writeReconciliation");
    const r = reconcileWrites({ job: "ingest-universe-driver", intended: 85, written: 12, skipped: 67, failed: 6 });
    expect(r.ok).toBe(true);
    expect(r.overAccounted).toBe(0);
    expect(r.message).toContain("intended 85 = written 12 + skipped 67 + failed 6");
  });
});
