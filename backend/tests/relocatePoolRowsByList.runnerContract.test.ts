/**
 * D-07 (R3) -- the contract between relocate-pool-rows-by-list.cjs and the
 * backfill runner, plus the scope refusal that D-06 was missing.
 *
 * The runner execs this lane generically:
 *
 *     node "backend/scripts/${{ inputs.script }}.cjs"
 *
 * There is no per-script `run:` step to review, so the `script` DROPDOWN is the
 * only gate that exists. A script absent from that list cannot be dispatched at
 * all; a script present on it can be dispatched by anyone with the workflow.
 * That makes the dropdown membership a real contract and not a formality --
 * exactly the reason D33 pinned its own.
 *
 * The other half is the one the R2 review caught (D-06): this lane's scope is a
 * committed list of row ids, and `scope` is a runner input SHARED with lanes
 * whose vocabulary is nothing like a file path. Silently substituting the
 * default when the value did not name a list turned "I typed the wrong scope"
 * into a live APPLY against a population the dispatcher never named. A
 * whole-scope write refuses without its scope.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..");
const runner = readFileSync(join(repoRoot, ".github", "workflows", "backfill-runner.yml"), "utf8");
const scriptPath = join(__dirname, "..", "scripts", "relocate-pool-rows-by-list.cjs");
const script = readFileSync(scriptPath, "utf8");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_LIST } = require("../scripts/relocate-pool-rows-by-list.cjs");

describe("the runner can dispatch this script", () => {
  it("is on the script whitelist", () => {
    // The exact dropdown line, indentation included -- this is the gate.
    // Line endings are normalized: the workflow is committed CRLF, and the
    // assertion is about dropdown membership, not about EOL style.
    expect(runner.replace(/\r\n/g, "\n")).toContain("          - relocate-pool-rows-by-list\n");
  });

  it("the exec really is generic, which is what makes the dropdown the gate", () => {
    // If this ever stops being true, this lane needs its own reviewed run step
    // and the dropdown assertion above stops being sufficient on its own.
    expect(runner).toContain('node "backend/scripts/${{ inputs.script }}.cjs"');
  });

  it("the runner passes SCOPE through, so the list path is dispatchable", () => {
    expect(runner).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
  });

  it("adds no new runner input -- the lane rides the 24 that exist", () => {
    // CF-THE-RUNNER-HAS-24-INPUTS: workflow_dispatch caps at 25 and the ladder
    // is already at 24. A lane that needed a 25th would be a different PR.
    const dispatchBlock = runner.slice(runner.indexOf("  workflow_dispatch:"), runner.indexOf("jobs:"));
    const inputNames = [...dispatchBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputNames.length).toBeLessThanOrEqual(25);
    expect(inputNames).toContain("scope");
    expect(inputNames).toContain("apply");
  });
});

describe("a whole-scope write refuses without its scope (D-06)", () => {
  it("a SCOPE that does not name a .json list exits non-zero, never defaults", () => {
    // The defect: `RAW_SCOPE.endsWith(".json") ? RAW_SCOPE : DEFAULT_LIST`.
    expect(script).not.toMatch(/RAW_SCOPE\.endsWith\("\.json"\)\s*\?\s*RAW_SCOPE\s*:\s*DEFAULT_LIST/);
    expect(script).toContain('if (RAW_SCOPE && !RAW_SCOPE.endsWith(".json"))');
    expect(script).toContain("does not name a list file");
    // A scope refusal exits 1 (a refusal), not 3 (a crash).
    const refusal = script.slice(script.indexOf("does not name a list file"), script.indexOf("const SCOPE ="));
    expect(refusal).toContain("process.exit(1)");
  });

  it("really exits 1 on another lane's vocabulary, and 0 is never the answer", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    for (const bad of ["all", "refractor", "bowman-chrome"]) {
      const r = spawnSync(process.execPath, [scriptPath], {
        // No COSMOS_CONNECTION_STRING: the scope refusal must come FIRST, so a
        // bad scope can never reach a connected client even by accident.
        env: { ...process.env, SCOPE: bad, COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(String(r.stderr)).toContain("does not name a list file");
      expect(String(r.stderr)).not.toContain(DEFAULT_LIST + "\n  entries");
    }
  });

  it("an ABSENT scope still means the one committed, reviewed default", () => {
    expect(script).toContain("const SCOPE = RAW_SCOPE || DEFAULT_LIST;");
    expect(DEFAULT_LIST).toBe("data/pool-relocations/2026-09-01-four-values.json");
  });

  it("a missing or empty list is a refusal too", () => {
    expect(script).toContain("FATAL: scope list not found");
    expect(script).toContain("names no entries — nothing is in scope.");
  });
});

describe("report-first, and the banner names what it will touch", () => {
  it("APPLY comes from BACKFILL_APPLY as well as APPLY -- the runner exports the former", () => {
    // CF-RUNNER-EXPORTS-BACKFILL-APPLY.
    expect(script).toContain('String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true"');
  });

  it("without APPLY the summary says so in as many words", () => {
    expect(script).toContain('APPLY ? "APPLY" : "REPORT ONLY — nothing written"');
  });

  it("the banner prints the scope file, the entry count and the exclusions", () => {
    expect(script).toContain("scope file");
    expect(script).toContain("entries in scope");
    expect(script).toContain("excluded by the audit");
    expect(script).toContain("duplicates left in pool");
  });

  it("every partition move goes through relocateSoldComp, never a hand-rolled delete", () => {
    // CF-A-SALE-IS-NEVER-LOST (D19) owns the upsert-verify-delete ordering.
    expect(script).toContain("relocateSoldComp");
    expect(script).not.toMatch(/pool\.item\([^)]*\)\.delete\(/);
  });
});

describe("the committed list is well formed and says why it excludes what it excludes", () => {
  const list = JSON.parse(readFileSync(join(__dirname, "..", DEFAULT_LIST), "utf8"));

  it("every entry names an id and a source partition", () => {
    expect(list.entries.length).toBeGreaterThan(0);
    for (const e of list.entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      // A relocate names a destination; a repoint names a new hobbyiqCardId.
      expect(Boolean(e.toCardId) || Boolean(e.repointHobbyiqCardId)).toBe(true);
      expect(String(e.evidence ?? "")).not.toBe("");
    }
  });

  it("every exclusion states a reason -- silence is not a disposition", () => {
    for (const x of list.excluded) {
      expect(String(x.id ?? "")).not.toBe("");
      expect(String(x.reason ?? "").length).toBeGreaterThan(20);
    }
  });

  it("no id is both moved and excluded", () => {
    const moved = new Set(list.entries.map((e: { id: string }) => e.id));
    for (const x of list.excluded) expect(moved.has(x.id)).toBe(false);
  });

  it("the X-Fractor /250 row is addressed rather than passed over in silence (D-03)", () => {
    // R2 left tca-ebay::227476163462 in neither list. A read of Cosmos showed
    // why it is not a relocate: TWO documents share that id, in the
    // base:no-auto and base:no-auto:num-250 partitions, with cardId and
    // hobbyiqCardId mirror-swapped -- the same $199.99 sale counted twice. This
    // lane moves one row per id and has no collapse semantics, and the title's
    // true X-Fractor address has no catalog row to land on.
    const x = list.excluded.find((e: { id: string }) => e.id === "tca-ebay::227476163462");
    expect(x).toBeDefined();
    expect(x.reason).toMatch(/duplicate pair/i);
    const moved = new Set(list.entries.map((e: { id: string }) => e.id));
    expect(moved.has("tca-ebay::227476163462")).toBe(false);
  });

  it("the BNR-VGJ Black Prism 1/1 is a relocate, and it names the NSCC product (D5-NSCC)", () => {
    // Drew-flagged, and the row no automated lane reaches: the title-exclusivity
    // pass refuses it as sameProduct, because inferSetKeyFromTitle reads
    // "Bowman Chrome" out of "Bowman Chrome National Wrapper Redemption" -- the
    // row's own setKey. A scoped 2018,2019 report run moves 0 of 15,195 rows.
    // It is an ENTRY and not an exclusion because the destination partition was
    // read live and holds no document with this id (the V-01 lesson: a
    // relocation onto an occupied id silently collapses two docs into one).
    const id = "tca-ebay::goldin_202301-3118-3115-83fa4718-53b0-4a58-a0ee-1cd0a283ec0e";
    const e = list.entries.find((x: { id: string }) => x.id === id);
    expect(e).toBeDefined();
    expect(e.fromCardId).toBe("hiq:baseball:2019:bowman-chrome:bnr-vgj:prism-refractor:no-auto:num-1");
    // CF-BOWMAN-NSCC-IS-ITS-OWN-PRODUCT: the destination is the NSCC ladder,
    // and BLACK Prism is a different parallel from the flagship Prism it sat on.
    expect(e.toCardId).toBe("hiq:baseball:2019:bowman-chrome-nscc:bnr-vgj:black-prism-refractor:no-auto:num-1");
    expect(e.toCardId).not.toBe(e.fromCardId);
    // A 1/1 keeps its print run across the move.
    expect(e.fromCardId).toContain(":num-1");
    expect(e.toCardId).toContain(":num-1");
    // The grade caveat is load-bearing: the title states BGS 9.5 while the
    // stored grade fields are empty. This lane moves identity only.
    expect(e.evidence).toMatch(/BGS GEM MINT 9\.5/);
    expect(e.evidence).toMatch(/identity only/i);
    expect(list.excluded.some((x: { id: string }) => x.id === id)).toBe(false);
  });
});
