// CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28) --
// workflow-side pin.
//
// The ledger writes into whichever directory PLAN_OUT (or, for
// relocate-catalog-rows-by-list, LEDGER_OUT) already points at, so every
// lane that already uploads its PLAN_OUT directory wholesale picks up the
// new `deleted-docs-<lane>-<runId>.ndjson` file for FREE -- no new upload
// step needed for those lanes. This file pins that every lane wired with a
// pre-delete ledger (relocate-sold-comp.cjs's own callers that opted in,
// plus the four direct-call lanes, plus dedupe-sold-comp-copies-by-list and
// reconcile-split-identity) has an upload step whose `path:` block already
// sweeps its own PLAN_OUT directory as a directory (trailing slash), and
// that relocate-catalog-rows-by-list -- which had NO PLAN_OUT of its own --
// got its own LEDGER_OUT wiring plus a dedicated upload step, since there
// was nothing existing to extend.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

describe("delete ledger -- workflow wiring (backfill-runner.yml)", () => {
  it("stays under 512 KB", () => {
    const bytes = Buffer.byteLength(workflow, "utf8");
    expect(bytes).toBeLessThan(512 * 1024);
  });

  it("adds no new workflow_dispatch input", () => {
    const inputsBlock = workflow.slice(workflow.indexOf("workflow_dispatch:"), workflow.indexOf("jobs:"));
    const topLevelInputs = [...inputsBlock.matchAll(/^ {6}([a-z_]+):\n/gm)].map((m) => m[1]);
    const distinct = new Set(topLevelInputs);
    // Same count this repo's other lane-wiring pins already assert (see
    // repointSalesTiffanyTitleGatedLane.test.ts) -- this PR adds zero.
    expect(distinct.size).toBe(24);
  });

  it("never edits .github/actions/relaunch-on-marker/action.yml", () => {
    const actionPath = path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    // Existence + that the workflow still references it via `uses:` (not a
    // forked copy) is the pin; the action file's OWN content is untouched by
    // this PR's diff, verified separately by `git diff` at review time.
    expect(fs.existsSync(actionPath)).toBe(true);
    expect(workflow).toContain("uses: ./.github/actions/relaunch-on-marker");
  });

  /** For each already-PLAN_OUT-wired lane, the ndjson ledger lands inside
   *  that SAME directory (PLAN_OUT/deleted-docs-<lane>-<runId>.ndjson), so
   *  the existing upload step's directory-level path entry already sweeps
   *  it. Pinned here: the PLAN_OUT ternary still names each lane's fixed
   *  dir, AND that lane's own upload step path includes that dir with a
   *  trailing slash (a directory upload, not a single named file, which
   *  the artifact action expands to include every file inside — including
   *  a ledger file that did not exist when the step was written). */
  const planOutWiredLanes: Array<{ lane: string; dir: string }> = [
    { lane: "repoint-sales-isauto-flip", dir: "/tmp/repoint-sales-isauto-flip-plan/" },
    { lane: "repoint-sales-cardnumber-suffix", dir: "/tmp/repoint-sales-cardnumber-suffix-plan/" },
    { lane: "repoint-sales-tiffany-title-gated", dir: "/tmp/repoint-sales-tiffany-title-gated-plan/" },
    { lane: "repoint-sales-to-sibling-product", dir: "/tmp/repoint-sales-to-sibling-product-plan/" },
    { lane: "reconcile-split-identity", dir: "/tmp/reconcile-split-identity-plan/" },
    { lane: "dedupe-sold-comp-copies-by-list", dir: "/tmp/dedupe-sold-comp-copies-by-list-plan/" },
  ];

  for (const { lane, dir } of planOutWiredLanes) {
    it(`${lane}: PLAN_OUT ternary still names its fixed directory`, () => {
      const escapedDir = dir.replace(/\//g, "\\/");
      const re = new RegExp(`inputs\\.script == '${lane}' && '${escapedDir.replace(/\/$/, "")}'`);
      expect(workflow).toMatch(re);
    });

    it(`${lane}: its own upload step sweeps that directory (picks up the ledger file for free)`, () => {
      const escapedDir = dir.replace(/[/.]/g, (c) => `\\${c}`);
      expect(workflow).toMatch(new RegExp(escapedDir));
    });
  }

  describe("relocate-catalog-rows-by-list (no prior PLAN_OUT of its own)", () => {
    it("has a dedicated LEDGER_OUT wired to a fixed, script-guarded path", () => {
      expect(workflow).toMatch(/LEDGER_OUT: \$\{\{ inputs\.script == 'relocate-catalog-rows-by-list' && '\/tmp\/relocate-catalog-rows-by-list-ledger'/);
    });

    it("has its own dedicated upload step for the ledger directory", () => {
      expect(workflow).toMatch(/Upload the relocate-catalog-rows-by-list ledger/);
      const idx = workflow.indexOf("Upload the relocate-catalog-rows-by-list ledger");
      expect(idx).toBeGreaterThan(-1);
      const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
      const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 1200);
      expect(block).toContain("inputs.script == 'relocate-catalog-rows-by-list'");
      expect(block).toContain("/tmp/relocate-catalog-rows-by-list-ledger/");
      expect(block).toContain("/tmp/backfill.log");
      expect(block).toMatch(/name: relocate-catalog-rows-by-list-ledger-/);
    });

    it("the artifact name interpolates only colon-free inputs (apply, run_id) -- never a raw scope/titles value (SCOPE_SLUG pattern from #2481)", () => {
      const idx = workflow.indexOf("Upload the relocate-catalog-rows-by-list ledger");
      const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
      const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 1200);
      const nameLine = block.match(/name: relocate-catalog-rows-by-list-ledger-[^\n]+/)?.[0] ?? "";
      expect(nameLine.length).toBeGreaterThan(0);
      // Only `inputs.apply` (a boolean) and `github.run_id` (numeric) are
      // interpolated -- neither can ever render a colon, unlike a raw
      // `inputs.scope`/`inputs.titles` string (which is why census-sold-
      // comp-copies sanitizes THAT through SCOPE_SLUG before using it in a
      // name). This lane's scope never appears in the artifact name at all.
      expect(nameLine).toContain("inputs.apply == true && 'apply' || 'report'");
      expect(nameLine).toContain("github.run_id");
      expect(nameLine).not.toContain("inputs.scope");
      expect(nameLine).not.toContain("inputs.titles");
    });
  });
});
