/**
 * CF-THE-PR-BODY-MUST-BE-TRUE-OF-THE-BRANCH-ALONE (2026-09-20, review fix;
 * updated 2026-09-20 after #2342 MERGED to main).
 *
 * An independent review of #2337 found the PR body's "final planner tables"
 * were measured with #2342's key registrations applied (at the time, a
 * SEPARATE, still-open PR) -- so the body claimed PASS for Illusions and
 * Mosaic when the #2337 branch by itself, with no other PR merged, still
 * REFUSEd both (2 and 18 unregistered keys respectively). A PASS claim that
 * is only true once a sibling PR merges is not true of the branch being
 * reviewed.
 *
 * #2342 has since MERGED to main (commit 7c9568a2): the 20 keys (Illusions'
 * 2 + Mosaic's 18) are registered on main now. This branch was merged
 * forward from current main (not rebased -- a sibling acquisition-wave
 * branch is stacked on top of this one, and merging preserves this
 * branch's existing commit ids for that descendant instead of rewriting
 * them), so "this branch" now legitimately includes those registrations.
 * This test's job stays the same: pin what is HONESTLY true of the branch
 * AS COMMITTED, not a hoped-for post-merge state -- it is just that the
 * honest answer for Illusions/Mosaic has flipped from REFUSE to PASS now
 * that the registrations are actually present on this branch's own main
 * ancestor, not merely claimed. Select stays REFUSE + held either way --
 * its held rows never depended on #2342 and still await a separate owner
 * naming ruling.
 *
 * This test runs the sanctioned ingester's own `planStagedDirectory`
 * (offline, no Cosmos) against each of the three package directories
 * committed IN THIS PR, using nothing but what #2337 itself ships --
 * modelled on zenithLiveAcquisitionRefusalIsFixed.test.ts's own
 * "replanned offline, no longer refused" pattern. If a future commit to
 * this PR (or a merge of a newer main) changes what the branch alone can
 * prove, this test fails immediately instead of leaving a stale claim in a
 * PR body.
 *
 * Illusions and Mosaic: PASS on this branch (0 unregistered, 0 unexplained
 * collisions) now that #2342's registrations are on main and this branch
 * has merged main forward.
 *
 * Select: REFUSE (unregistered-set-keys via `heldRows` at the ingest layer
 * -- planStagedDirectory itself does not read `heldRows`, so it still
 * REPORTS a numeric verdict for the staged rows; the manifest's `heldRows`
 * gate is what keeps `ingest-checklist-csv-to-catalog.cjs`'s real run from
 * ever writing them). This test pins BOTH facts: the manifest carries
 * `heldRows` (so a real ingest never writes this file), AND the offline
 * planner's own verdict on the staged CSV, so neither claim can drift
 * silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  // Every package in this PR ships exactly one CSV.
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

function manifestFor(dirName: string, csvName: string) {
  const path = join(SCRAPED_ROOT, dirName, csvName.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2024 Panini Illusions Football (Beckett S3) — PASS on this branch, #2342 now on main", () => {
  it("planStagedDirectory reports PASS: 0 unregistered, 0 collisions", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-illusions-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.reason).toBeNull();
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("carries no heldRows gate — these rows genuinely belong to this product and are now registered", () => {
    const m = manifestFor("acq-2026-09-19-beckett-panini-illusions-fb", "2024-panini-illusions-football.csv");
    expect(m.heldRows).toBeUndefined();
  });
});

describe("2024 Panini Mosaic Football (Beckett S3) — PASS on this branch, #2342 now on main", () => {
  it("planStagedDirectory reports PASS: 0 unregistered, 0 collisions", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-mosaic-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.reason).toBeNull();
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("11,468 staged rows resolve to 11,382 distinct ids -- 86 are the SOURCE WORKBOOK'S OWN duplication, not a defect", () => {
    // `idCollisions` (scripts/lib/insert-set-key.cjs) only folds a same-id
    // group into one row when BOTH: (a) every row in the group has an
    // identical identity tuple (player, cardNumber, parallel, isAuto,
    // printRun), AND (b) every row's EFFECTIVE subset (after this file's
    // own rung-folding) is the same root subset. That is
    // CF-A-DUPLICATE-IS-NOT-A-COLLISION (insert-set-key.cjs, Drew
    // 2026-09-19): two rows that are the SAME card, spelled under two
    // category headers the workbook itself printed for the one subset, are
    // the source's own duplication, collapsed to one -- never a defect
    // this guard should refuse over. A genuine two-different-cards clash
    // (different player/number/parallel) still reports as a `collisions`
    // entry and still refuses; this test's own PASS assertion above
    // already proves collisions.length is 0 for this file.
    //
    // Example (verified directly against the staged CSV,
    // 2024-panini-mosaic-football.csv): card #1's "Rookie Scripts" auto is
    // listed TWICE under the file's own "No Huddle" parallel rung, once
    // under category `auto-rookie-scripts-black` and once under
    // `auto-rookie-scripts-gold` -- same player (Michael Penix Jr.), same
    // card number (1), same parallel text ("No Huddle"), same auto flag,
    // no print run stated on either row. Both category spellings fold to
    // the same effective subset root ("rookie-scripts") via this file's
    // own rung-folding, so they collapse to the single id
    // `hiq:football:2024:panini-mosaic-rookie-scripts:1:no-huddle:auto`
    // instead of colliding. The same shape repeats 86 times across the
    // file (mostly the "-black"/"-gold" Scripts and Rookie Scripts autos,
    // and a handful of Inserts-sheet subset spellings), all independently
    // re-derivable by the mechanism this comment documents -- not something
    // this test needs to enumerate row-by-row.
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-mosaic-fb");
    expect(entry.plan.rows).toBe(11468);
    expect(entry.plan.duplicatesFolded).toBe(86);
    expect(entry.plan.ids).toBe(11382);
    expect(entry.plan.rows - entry.plan.duplicatesFolded).toBe(entry.plan.ids);
  });

  it("carries no heldRows gate — these rows genuinely belong to this product and are now registered", () => {
    const m = manifestFor("acq-2026-09-19-beckett-panini-mosaic-fb", "2024-panini-mosaic-football.csv");
    expect(m.heldRows).toBeUndefined();
  });
});

describe("2024 Panini Select Football (Beckett S3) — HELD, pending an owner naming ruling", () => {
  it("the manifest carries heldRows with the stated reason", () => {
    const m = manifestFor("acq-2026-09-19-beckett-panini-select-fb", "2024-panini-select-football.csv");
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.reason).toMatch(/Score Select Throwback/);
    expect(m.heldRows.reason).toMatch(/Snapshots/);
    expect(m.heldRows.reason).toMatch(/owner ruling/);
  });

  it("planStagedDirectory itself still reports the staged rows' own verdict (it does not read heldRows — the real ingester's main() does)", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-select-fb");
    expect(entry.product).not.toBeNull();
    // Two placeholder split keys were deliberately NOT registered (owner
    // ruling pending) -- so this branch alone refuses on exactly those two,
    // with the collision count that follows from both falling back to
    // their unsuffixed sibling's address.
    expect(entry.plan.verdict).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual(["panini-select-score-select-throwback-2", "panini-select-snapshots-2"]);
  });

  it("the real ingester's main() would never write this file: heldRows is checked BEFORE planStagedDirectory-shaped work runs", () => {
    // Documents the mechanism `heldRows` relies on (main()'s own
    // CF-A-HELD-FILE-IS-NOT-THIS-PRODUCT'S filter, ingest-checklist-csv-
    // to-catalog.cjs), rather than re-deriving it: a manifest with
    // `heldRows.reason` set causes main() to filter the file out of `files`
    // before either measurement pass runs, logging it as HELD and never
    // reaching a write. planStagedDirectory (used above, and by the offline
    // acquisition tooling) is a DIFFERENT entry point that intentionally
    // does not apply this filter, so it can still report what the staged
    // rows WOULD resolve to -- which is exactly why this file's own tests
    // assert BOTH facts separately rather than expecting one to imply the
    // other.
    const source = readFileSync(
      join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"),
      "utf8",
    );
    expect(source).toMatch(/CF-A-HELD-FILE-IS-NOT-THIS-PRODUCT'S/);
    expect(source).toMatch(/m\.heldRows\.reason/);
  });
});
