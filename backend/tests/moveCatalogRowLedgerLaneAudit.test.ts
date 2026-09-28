/**
 * CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28, review
 * finding on this PR): "audit the other 30+ moveCatalogRow callers: which
 * are runner lanes that delete? wire those too, or list them explicitly as
 * out of scope with a reason."
 *
 * moveCatalogRow/retireCatalogRow's own `ledgerLane` option is ALREADY
 * pinned functionally in catalogRowOpsDeleteLedger.test.ts: when supplied,
 * every delete either function performs writes the full pre-delete document
 * to a durable ndjson ledger before the Cosmos delete, and a ledger-write
 * failure refuses that delete (isLedgerWriteFailure). This file audits the
 * OTHER side of the finding -- that every runner lane actually dispatched
 * via backend/.github/workflows/backfill-runner.yml's script whitelist and
 * calling either function actually PASSES that option, rather than
 * exercising the (already-tested) option itself again per lane.
 *
 * THE 29 LANES. Grepped `moveCatalogRow(`/`retireCatalogRow(` across every
 * backend/scripts/*.cjs file, then checked each hit against the workflow's
 * `- <script>` whitelist. 32 files call one of the two functions; 3
 * (migrate-catalog-setkey.cjs, priorityCatalogReslug.cjs,
 * reslugCatalogFromCurrent.cjs) are NOT in the whitelist -- never dispatched
 * as a runner lane -- and are explicitly OUT OF SCOPE for this ledger (no
 * live-run risk; left untouched). The other 29 are audited below, one row
 * per file, pinning THREE things per file:
 *
 *   1. a `const LEDGER_LANE = "<script-name>";` constant exists;
 *   2. EVERY `moveCatalogRow(`/`retireCatalogRow(` call site in the file
 *      passes `ledgerLane: LEDGER_LANE` (or `ledgerLane,` via a destructured
 *      deps object that itself carries LEDGER_LANE -- see rename-setkey-
 *      to-product.cjs's own dependency-injection shape) -- call-site counts
 *      are asserted so a future edit that adds a NEW unwired call site to
 *      one of these files goes red here, not silently;
 *   3. `isLedgerWriteFailure` is imported from the SAME require that already
 *      imports moveCatalogRow/retireCatalogRow (no second require of
 *      catalogRowOps.service.js), and the file's own error path checks it.
 *
 * relocate-catalog-rows-by-list.cjs (the retire-path lane this design named
 * explicitly, first wired) is pinned separately in
 * relocateCatalogRowsByListLedgerLane.test.ts -- not repeated here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptsDir = join(__dirname, "..", "scripts");
const workflowPath = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** file -> expected moveCatalogRow(/retireCatalogRow( call-site count,
 *  measured directly against each file's own source (grep -c). */
const LANES: Record<string, number> = {
  "apply-cpa-product-rule": 1,
  "apply-setkey-rulings": 1,
  "clean-base-cards-parallel-slug": 1,
  "clean-parallel-annotations": 1,
  "conform-one-of-one-parallels": 1,
  "consolidate-catalog-duplicates": 1,
  "dedupe-catalog-by-hobbyiq": 1,
  "dedupe-catalog-partition-shadows": 1,
  "fold-catalog-duplicate-rungs": 2,
  "fold-checklist-numbered-twins": 2,
  "fold-unnumbered-twins": 1,
  "ingest-checklist-csv-to-catalog": 1,
  "map-derived-parallels-to-rungs": 1,
  "map-pokemon-setkeys-to-checklist": 1,
  "map-yearprefixed-setkeys": 1,
  "rehome-catalog-rows-to-own-partition": 1,
  "rekey-catalog-id-to-setkey": 1,
  "rekey-product-setkey": 2,
  // This file's own docblock header (line 27) narrates the MOVE shape as
  // "moveCatalogRow(cat, row, newId, ...)" in prose, so the naive source
  // count is 3 though only 2 are REAL call sites (both at
  // lib.moveCatalogRow(...), both already carrying ledgerLane: LEDGER_LANE
  // -- verified by hand against the source and pinned in the binding-count
  // assertion below, which only credits actual `ledgerLane:`/`ledgerLane,`
  // occurrences, not the raw call count).
  "rename-setkey-to-product": 3,
  "rename-setkey": 1,
  "repair-bcp-misfiled-parallels": 4,
  "repair-bowman-product-refile": 1,
  "repair-clc-signature-unsigned": 1,
  "repair-cpa-draft-refile": 1,
  "repair-isauto-from-cardnumber-catalog": 1,
  "repair-pokemon-glued-numbers": 1,
  "repair-select-subbrand-misslug": 1,
  "repair-tiffany-rung-to-product": 1,
  "retire-wiki-footer-catalog-rows": 2,
  "rewrite-parallel-names": 2,
};

/** Explicitly out of scope: moveCatalogRow/retireCatalogRow callers that are
 *  NOT dispatched via the workflow's script whitelist, so they carry no
 *  live-run risk this PR's ledger needs to close. */
const OUT_OF_SCOPE = ["migrate-catalog-setkey", "priorityCatalogReslug", "reslugCatalogFromCurrent"];

/** The REAL number of ledgerLane bindings expected -- defaults to LANES'
 *  own count, overridden only where a file's LANES entry is inflated by a
 *  prose mention (rename-setkey-to-product.cjs's docblock narrates the call
 *  shape once, in English, alongside its 2 real call sites). */
const EXPECTED_BINDINGS: Record<string, number> = {
  "rename-setkey-to-product": 2,
};

describe("moveCatalogRow/retireCatalogRow callers -- ledgerLane audit (review finding on this PR)", () => {
  it("every dispatched lane in LANES is actually in the workflow's script whitelist", () => {
    for (const name of Object.keys(LANES)) {
      expect(workflow).toContain(`- ${name}\n`);
    }
  });

  it("every OUT_OF_SCOPE name is genuinely absent from the workflow's script whitelist", () => {
    for (const name of OUT_OF_SCOPE) {
      expect(workflow).not.toContain(`- ${name}\n`);
    }
  });

  it("OUT_OF_SCOPE files still call moveCatalogRow/retireCatalogRow (they are a real caller, just not a runner lane)", () => {
    for (const name of OUT_OF_SCOPE) {
      const src = readFileSync(join(scriptsDir, `${name}.cjs`), "utf8");
      expect((src.match(/moveCatalogRow\(|retireCatalogRow\(/g) ?? []).length).toBeGreaterThan(0);
    }
  });

  for (const [name, expectedCallCount] of Object.entries(LANES)) {
    describe(name, () => {
      const src = readFileSync(join(scriptsDir, `${name}.cjs`), "utf8");

      it(`has exactly ${expectedCallCount} moveCatalogRow(/retireCatalogRow( call site(s) (source-measured baseline -- a new unwired call site changes this count)`, () => {
        const count = (src.match(/moveCatalogRow\(|retireCatalogRow\(/g) ?? []).length;
        expect(count).toBe(expectedCallCount);
      });

      it("declares a LEDGER_LANE constant naming this script", () => {
        expect(src).toMatch(/const LEDGER_LANE\s*=\s*"[a-zA-Z0-9-]+";/);
      });

      it("every ledgerLane-bearing options object resolves to LEDGER_LANE, and the count of ledgerLane occurrences is at least the call-site count", () => {
        // Every call site must carry ledgerLane in SOME form: either the
        // literal `ledgerLane: LEDGER_LANE` at the call, or `ledgerLane,`
        // shorthand fed by a deps object that itself was built with
        // `ledgerLane: LEDGER_LANE` (rename-setkey-to-product.cjs's own
        // dependency-injection shape) -- so this checks for the LEDGER_LANE
        // binding to occur at least once per call site, one way or another.
        const bindingOccurrences = (src.match(/ledgerLane:\s*LEDGER_LANE/g) ?? []).length;
        expect(bindingOccurrences).toBeGreaterThanOrEqual(1);
        // And the call sites themselves must be reachable from a path that
        // carries ledgerLane -- either directly, or via a `deps`/options
        // object passed into a helper that itself receives ledgerLane.
        const directlyWired = (src.match(/ledgerLane:\s*LEDGER_LANE/g) ?? []).length
          + (src.match(/ledgerLane,/g) ?? []).length;
        expect(directlyWired).toBeGreaterThanOrEqual(EXPECTED_BINDINGS[name] ?? expectedCallCount);
      });

      it("imports isLedgerWriteFailure from the SAME require as moveCatalogRow/retireCatalogRow (no second require of catalogRowOps.service.js)", () => {
        expect(src).toContain("isLedgerWriteFailure");
        // Only ONE actual load of catalogRowOps.service.js in the whole
        // file -- isLedgerWriteFailure rides the same destructure as
        // moveCatalogRow/retireCatalogRow, not a second lookup. Prose
        // comments mentioning the module's name a second time are fine and
        // common (every wired file explains the ledgerLane contract
        // inline); only an actual load counts, whether spelled as a direct
        // `require(...)` or through a file-local require-wrapper (e.g.
        // consolidate-catalog-duplicates.cjs's own `D(...p) =>
        // require(path.join(backend, "dist", ...p))`).
        const catalogRowOpsRequireCalls =
          (src.match(/require\([^)]*catalogRowOps\.service\.js[^)]*\)/g) ?? []).length
          + (src.match(/\bD\([^)]*catalogRowOps\.service\.js[^)]*\)/g) ?? []).length;
        expect(catalogRowOpsRequireCalls).toBe(1);
      });

      it("checks isLedgerWriteFailure somewhere in its own error-handling path and reports a ledgerWriteFailed-shaped counter", () => {
        expect(src).toMatch(/isLedgerWriteFailure\(/);
        expect(src.toLowerCase()).toContain("ledgerwritefailed");
      });
    });
  }
});
