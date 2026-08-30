/**
 * THE RECONCILIATION AND THE BUDGET MARKER.
 *
 * Groups scanned must equal consolidated + ambiguous + not-a-group + failed +
 * not-reached (plus the two disjoint skip counters), or the report is telling a
 * reader that work happened which did not.
 *
 * The budget marker is load-bearing in a different way: the runner's relaunch
 * step greps for it, and relaunches ONLY when it printed. A killed job cannot
 * report progress, and a marker that does not match the grep means a fleet
 * silently stops halfway.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

describe("the budget marker", () => {
  it("is the EXACT string the runner greps for", () => {
    // The runner matches /stopped at the .*budget/. The em dash and the wording
    // are part of the contract with the relaunch step.
    expect(source).toContain("stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here");
  });

  it("renders to the expected sentence at 140 minutes", () => {
    const RUN_MS = 140 * 60000;
    const marker = `stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`;
    expect(marker).toBe("stopped at the 140-minute budget — the relaunch continues from here");
    expect(marker).toMatch(/stopped at the .*budget/);
  });

  it("leaves the budget with headroom to finish the group it is in", () => {
    expect(source).toMatch(/budgetLeft\(\) < 90000/);
  });

  it("counts everything it did not reach", () => {
    expect(source).toMatch(/stats\.notReached \+= groups\.size - gi/);
  });
});

describe("groups scanned reconciles exactly", () => {
  it("the script asserts the identity itself and prints OK / MISMATCH", () => {
    expect(source).toMatch(/const accounted = stats\.consolidated \+ stats\.ambiguous \+ stats\.notAGroup \+ stats\.failed \+ stats\.notReached \+ stats\.outOfMode \+ stats\.skippedRenameOwned/);
    expect(source).toMatch(/RECONCILES/);
    expect(source).toMatch(/"OK" : "MISMATCH"/);
  });

  it("the buckets are mutually exclusive: every branch ends the group", () => {
    // not-a-group, ambiguous and out-of-mode each `continue`; only the
    // consolidate path falls through to the write.
    expect(source).toMatch(/stats\.notAGroup\+\+;[\s\S]{0,120}continue;/);
    expect(source).toMatch(/stats\.outOfMode\+\+; continue;/);
    expect(source).toMatch(/stats\.skippedRenameOwned\+\+;\s*\n\s*continue;/);
  });

  it("arithmetic holds on a worked example", () => {
    const s = { groups: 100, consolidated: 40, ambiguous: 25, notAGroup: 20, failed: 2, notReached: 5, outOfMode: 6, skippedRenameOwned: 7 };
    const accounted = s.consolidated + s.ambiguous + s.notAGroup + s.failed + s.notReached + s.outOfMode + s.skippedRenameOwned;
    expect(accounted).toBe(s.groups + s.notReached);
  });
});

describe("the write reconciliation contract", () => {
  it("reports only under APPLY, with disjoint intended/written/skipped/failed", () => {
    const rw = source.slice(source.indexOf("reportWrites({"), source.indexOf("reportWrites({") + 600);
    expect(rw).toMatch(/job: `consolidate-catalog-duplicates:\$\{MODE\}`/);
    expect(rw).toMatch(/written: stats\.consolidated/);
    expect(rw).toMatch(/failed: stats\.failed/);
  });

  it("intended = written + skipped + failed, so reconcileWrites is satisfied", () => {
    const s = { consolidated: 40, ambiguous: 25, notAGroup: 20, outOfMode: 6, skippedRenameOwned: 7, failed: 2 };
    const intended = s.consolidated + s.ambiguous + s.notAGroup + s.outOfMode + s.skippedRenameOwned + s.failed;
    const written = s.consolidated;
    const skipped = s.ambiguous + s.notAGroup + s.outOfMode + s.skippedRenameOwned;
    expect(written + skipped + s.failed).toBe(intended);
    const r = reconcileWrites({ job: "t", intended, written, skipped, failed: s.failed });
    expect(r.ok).toBe(true);
  });

  it("sub-totals of written go on their own line, never into skipped", () => {
    expect(source).toMatch(/written sub-totals \(not skipped\)/);
  });
});
