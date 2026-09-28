/**
 * CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28, review
 * finding on this PR).
 *
 * relocate-catalog-rows-by-list.cjs's RETIRE path (retireCatalogRow, both call
 * sites) already passed `ledgerLane: LEDGER_LANE` -- pinned functionally in
 * catalogRowOpsDeleteLedger.test.ts, which drives retireCatalogRow directly
 * against a fake Container and proves the full pre-delete document lands in
 * the ndjson ledger before the row/graded-children deletes. The reviewer's
 * finding was that the RESLUG/replace/fold path -- the single `moveCatalogRow`
 * call this lane also makes -- had NO `ledgerLane` at all, so its two
 * possible deletes (a replaced incumbent's foreign-pk copy, and the old row
 * once a completed move retires it) were unledgered.
 *
 * moveCatalogRow's own opt-in `ledgerLane` contract is ALREADY pinned
 * functionally in catalogRowOpsDeleteLedger.test.ts (a dedicated "moveCatalogRow"
 * describe block: ledgers the old row before deleting it on a completed
 * move, and behaves exactly as before when the option is omitted). This file
 * pins the ONE missing piece: that THIS lane's own call site actually passes
 * the option, following the same source-assertion convention
 * relocateCatalogRowsByList.test.ts already uses for this exact call
 * ("the reslug path calls moveCatalogRow in BOTH modes...").
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const laneSrc = readFileSync(lane, "utf8");

describe("relocate-catalog-rows-by-list -- ledgerLane wiring (review finding on this PR)", () => {
  it("declares one LEDGER_LANE constant naming this script", () => {
    expect(laneSrc).toMatch(/const LEDGER_LANE = "relocate-catalog-rows-by-list";/);
  });

  it("the retire path's two retireCatalogRow calls both pass ledgerLane: LEDGER_LANE", () => {
    const calls = [...laneSrc.matchAll(/await retireCatalogRow\([^;]*?\)/gs)];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call[0]).toContain("ledgerLane: LEDGER_LANE");
    }
  });

  it("the reslug/replace/fold path's moveCatalogRow call ALSO passes ledgerLane: LEDGER_LANE", () => {
    // Reviewer finding: this call had no ledgerLane at all, so the two
    // deletes moveCatalogRow can perform (a replaced incumbent's foreign-pk
    // copy; the old row on a completed move) were unledgered.
    //
    // The call spans many lines and its own comments contain parentheses,
    // so rather than trying to balance-match it, isolate the statement by
    // its start and the terminating `});` at the start of a line (the call
    // site's own closing brace, indented one level less than its body).
    const start = laneSrc.indexOf("const res = await moveCatalogRow(cat, row, to, changed, {");
    expect(start).toBeGreaterThan(-1);
    const end = laneSrc.indexOf("\n      });", start);
    expect(end).toBeGreaterThan(start);
    const callSite = laneSrc.slice(start, end);
    expect((callSite.match(/await moveCatalogRow\(/g) ?? []).length).toBe(1);
    expect(callSite).toContain("ledgerLane: LEDGER_LANE");
  });

  it("isLedgerWriteFailure is imported from the same catalogRowOps.service.js require and used in the outer catch", () => {
    expect(laneSrc).toMatch(/isLedgerWriteFailure,?\s*\n?\s*\}\s*=\s*require\(path\.join\(backend, "dist\/services\/catalog\/catalogRowOps\.service\.js"\)\)/);
    expect(laneSrc).toContain("if (isLedgerWriteFailure(err)) ledgerWriteFailed++;");
  });

  it("declares and reports a ledgerWriteFailed counter distinct from the ordinary failed counter", () => {
    expect(laneSrc).toMatch(/let retired = 0, resluged = 0, alreadyRight = 0, notFound = 0, failed = 0, ledgerWriteFailed = 0;/);
    expect(laneSrc).toContain("of which ledger-write-failed");
  });
});
