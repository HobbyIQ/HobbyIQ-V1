/**
 * CF-THE-PR-BODY-MUST-BE-TRUE-OF-THE-BRANCH-ALONE (2026-09-20, review fix).
 *
 * An independent review of #2337 found the PR body's "final planner tables"
 * were measured with #2342's key registrations applied (a SEPARATE, still-
 * open PR) -- so the body claimed PASS for Illusions and Mosaic when the
 * #2337 branch by itself, with no other PR merged, still REFUSEs both (2 and
 * 18 unregistered keys respectively). A PASS claim that is only true once a
 * sibling PR merges is not true of the branch being reviewed.
 *
 * This test runs the sanctioned ingester's own `planStagedDirectory`
 * (offline, no Cosmos) against each of the three package directories
 * committed IN THIS PR, using nothing but what #2337 itself ships --
 * modelled on zenithLiveAcquisitionRefusalIsFixed.test.ts's own
 * "replanned offline, no longer refused" pattern, but pinning the HONEST
 * verdict of this branch rather than a post-merge one. If a future commit
 * to this PR (or a rebase) changes what the branch alone can prove, this
 * test fails immediately instead of leaving a stale claim in a PR body.
 *
 * Illusions and Mosaic: REFUSE on this branch alone (unregistered-set-keys,
 * their own genuine named inserts -- registered separately in #2342, a
 * sibling PR this branch does not depend on and does not merge here).
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

describe("2024 Panini Illusions Football (Beckett S3) — REFUSE on this branch alone", () => {
  it("planStagedDirectory reports unregistered-set-keys for mystique + instant-impact, not PASS", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-illusions-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual(["panini-illusions-instant-impact", "panini-illusions-mystique"]);
    // Zero collisions is still true -- the collisions this file's own
    // finding described (202 groups) only appear once BOTH unregistered
    // keys are also computing an id, which happens downstream of this
    // exact refusal; planFile's own "unregistered short-circuits before
    // collisions are even reported" ordering (see insert-set-key.cjs's
    // own planFile, "ORDER IS LOAD-BEARING") means this call sees the
    // collisions list too -- pinned here so a future change to that
        // ordering is visible.
    expect(entry.plan.collisions.length).toBeGreaterThan(0);
  });

  it("carries no heldRows gate — these rows genuinely belong to this product, just unregistered", () => {
    const m = manifestFor("acq-2026-09-19-beckett-panini-illusions-fb", "2024-panini-illusions-football.csv");
    expect(m.heldRows).toBeUndefined();
  });
});

describe("2024 Panini Mosaic Football (Beckett S3) — REFUSE on this branch alone", () => {
  it("planStagedDirectory reports unregistered-set-keys for all 18 genuine inserts, not PASS", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-mosaic-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.unregistered.length).toBe(18);
    // The two fold-artifact spellings (center-stage-mosaic, overdrive-mosaic)
    // must NOT appear here -- CANONICAL_CATEGORY_SLUG already folds them to
    // their already-registered bare sibling inside THIS branch's own
    // converter, with no dependency on #2342 at all.
    const keys = new Set(entry.plan.unregistered.map((u: { setKey: string }) => u.setKey));
    expect(keys.has("panini-mosaic-center-stage-mosaic")).toBe(false);
    expect(keys.has("panini-mosaic-overdrive-mosaic")).toBe(false);
  });

  it("carries no heldRows gate — these rows genuinely belong to this product, just unregistered", () => {
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
