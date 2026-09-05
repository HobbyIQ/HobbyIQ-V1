import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { droppedSpecificityAxes } from "../scripts/comp-quality/recheck-holding-identity.js";

/**
 * CF-A-WRONG-IDENTITY-IS-NOT-A-MISSING-ONE (Drew, 2026-09-04, ruling R2).
 *
 * `recheck-holding-identity`'s original sweep re-derives only holdings with NO
 * identity. The holdings that price a user's card wrong are the ones that HAVE
 * an identity and have the WRONG one, and nothing in the product re-derived
 * those. MODE=rederive is that pass.
 *
 * The danger it uniquely creates is replacing one confident wrong identity
 * with another, so the pins here are all about what it REFUSES. Drew's four
 * holdings are the canary, and two of them are refusals by design.
 */
describe("GATE 2 — a re-derivation may never silently drop a claimed axis", () => {
  it("refuses a /50 Gold Refractor onto the base auto (Drew's ca7a150b)", () => {
    // The holding says printRun 50 AND parallel "Gold Refractor". The 2026
    // Bowman "Chrome Prospect PackFractor Autographs" checklist staged by
    // #1774 states 39 identities and NO ladder at all -- hobbymonitor
    // publishes a `variations` ladder for 25 of the release's cardSets and
    // PackFractor is not one of them. Borrowing the neighbouring Chrome
    // Prospect Autograph's Gold /50 rung would be a synthetic parallel
    // (feedback_no_synthetic_parallels_only_actuals), so the holding stays
    // identityUnverified rather than collapsing a /50 onto base.
    expect(droppedSpecificityAxes(
      { printRun: 50, parallel: "Gold Refractor" },
      "hiq:baseball:2026:bowman-chrome:cpa-mg:base:auto",
    )).toEqual(["printRun", "parallel"]);
  });

  it("refuses a /1500 Diamond Dominance insert onto the base D24 (Drew's 6f4f079b)", () => {
    // Measured on the holding itself 2026-09-04: the eBay aspects state
    // "Insert Set: Diamond Dominance", "Print Run: 1500" and "Features:
    // Serial Numbered, Insert", and the sale title is "...Diamond Dominance
    // #D24 Ken Griffey Jr /1500". No 1999 D24 catalog row carries a printRun
    // at all -- the /1500 in the checklist belongs to the Triple Diamond tier.
    // So the base row is NOT this card, and the move is refused rather than
    // fusing a serial-numbered insert into the base pool.
    expect(droppedSpecificityAxes(
      { printRun: 1500, parallel: "Base" },
      "hiq:baseball:1999:upper-deck-black-diamond:d24:base:no-auto",
    )).toEqual(["printRun"]);
  });

  it("ALLOWS the move when the destination states the same serial", () => {
    // The gate refuses a DROP, not a move. A destination whose slug carries
    // the print run is the same card and the re-derivation may proceed.
    expect(droppedSpecificityAxes(
      { printRun: 1500, parallel: "Base" },
      "hiq:baseball:1999:upper-deck-black-diamond:d24:base:no-auto:num-1500",
    )).toEqual([]);
  });

  it("ALLOWS the Bellingham move — nothing is claimed that is dropped (Drew's c8949bb0)", () => {
    // The one of Drew's four that writes. `parallel: "Base"` is the absence of
    // a claim, not a claim, and the holding asserts no serial.
    expect(droppedSpecificityAxes(
      { parallel: "Base", printRun: null, serialNumber: null },
      "hiq:baseball:1987:bellingham-mariners:15:base:no-auto",
    )).toEqual([]);
  });

  it("treats `Base` as the absence of a claim, in any casing", () => {
    for (const p of ["Base", "base", "BASE"]) {
      expect(droppedSpecificityAxes({ parallel: p }, "hiq:baseball:1987:x:15:base:no-auto"), p).toEqual([]);
    }
  });

  it("refuses a named parallel the destination slug does not spell", () => {
    expect(droppedSpecificityAxes(
      { parallel: "Gold Refractor" },
      "hiq:baseball:2026:topps-chrome:ra-kg:base:auto",
    )).toEqual(["parallel"]);
    // ...and allows it when the slug does spell it.
    expect(droppedSpecificityAxes(
      { parallel: "Gold Refractor" },
      "hiq:baseball:2026:topps-chrome:ra-kg:gold-refractor:auto",
    )).toEqual([]);
  });

  it("MUTATION: a gate that always returns [] would write both of Drew's refusals", () => {
    // The revert this pin exists to catch, stated as the damage it does. If
    // GATE 2 stops refusing, the /50 lands on base auto and the /1500 insert
    // lands in the base pool -- two pool fusions, which is exactly the defect
    // the rest of this PR removes.
    const refusals = [
      droppedSpecificityAxes({ printRun: 50, parallel: "Gold Refractor" }, "hiq:baseball:2026:bowman-chrome:cpa-mg:base:auto"),
      droppedSpecificityAxes({ printRun: 1500, parallel: "Base" }, "hiq:baseball:1999:upper-deck-black-diamond:d24:base:no-auto"),
    ];
    for (const r of refusals) expect(r.length).toBeGreaterThan(0);
  });
});

describe("the mode refuses to run unscoped", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf-8");

  it("exits rather than sweeping every holding when no scope is given", () => {
    // CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME read onto a re-derivation: this
    // mode can overwrite an identity that is already RIGHT, so "every holding"
    // must not be reachable by forgetting an input.
    expect(SRC).toMatch(/if \(!HOLDING_IDS\.length && !USER_ID\)/);
    expect(SRC).toMatch(/MODE=rederive needs a scope/);
  });

  it("reads BACKFILL_APPLY as well as APPLY", () => {
    // feedback_runner_exports_backfill_apply: the runner exports
    // BACKFILL_APPLY, and a script reading only APPLY reports a dry run as if
    // it had written.
    expect(SRC).toMatch(/process\.env\.BACKFILL_APPLY === "true"/);
  });

  it("never seeds the catalog — both belts, plus the read-back gate", () => {
    expect(SRC).toMatch(/CATALOG_MATCH_ONLY_ENABLED/);
    expect(SRC).toMatch(/source: "unknown"/);
    // GATE 1: the destination must be a real catalog row, read back by id.
    expect(SRC).toMatch(/no catalog row backs the derived slug/);
  });

  it("verifies every write by reading the document back", () => {
    // feedback_green_workflow_is_not_data_flow. A green run is not a written
    // row, so the apply re-reads and exits non-zero on a mismatch.
    expect(SRC).toMatch(/RECONCILIATION: re-reading/);
    expect(SRC).toMatch(/if \(wrong\) process\.exit\(5\)/);
  });

  it("records where a re-derived identity came from", () => {
    for (const field of [
      "identityRederivedFrom", "identityRederivedAt",
      "identityRederivedBy", "identityRederivedBackedBy",
    ]) expect(SRC, field).toContain(field);
  });
});
