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
    // The holding says printRun 50 AND parallel "Gold Refractor", and the base
    // auto row states neither, so the move is refused. The GATE is right.
    //
    // ITS ORIGINAL RATIONALE WAS NOT, and it is corrected here rather than
    // deleted, because the wrong reason was load-bearing for two agents.
    // ca7a150b is NOT a PackFractor (Drew, 2026-09-05). It is a standard Gold
    // Refractor Autograph /50, its ladder IS published, and the destination it
    // should reach is the :num-50 rung pinned in the next describe block --
    // never this base row. "No ladder source, unpriceable" was a defect in the
    // rederive script's own matcher call, not a fact about the card.
    expect(droppedSpecificityAxes(
      { printRun: 50, parallel: "Gold Refractor" },
      "hiq:baseball:2026:bowman-chrome:cpa-mg:base:auto",
    )).toEqual(["printRun", "parallel"]);
  });

  it("ALLOWS ca7a150b onto its real destination: the Gold Refractor /50 rung", () => {
    // The rung that actually exists in card_catalog, source `checklist`,
    // printRun 50, player Marconi German. Nothing is dropped, so GATE 2 lets
    // the re-derivation through and the holding gains its :num-50 segment.
    expect(droppedSpecificityAxes(
      { printRun: 50, parallel: "Gold Refractor" },
      "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50",
    )).toEqual([]);
  });

  it("refuses a /1500 Diamond Dominance insert onto the base D24 (Drew's 6f4f079b)", () => {
    // Measured on the holding itself 2026-09-04: the eBay aspects state
    // "Insert Set: Diamond Dominance", "Print Run: 1500" and "Features:
    // Serial Numbered, Insert", and the sale title is "...Diamond Dominance
    // #D24 Ken Griffey Jr /1500". The base row is NOT this card, and the move
    // is refused rather than fusing a serial-numbered insert into the base
    // pool. The GATE is unchanged and still right.
    //
    // ITS ORIGINAL RATIONALE IS CORRECTED HERE (2026-09-05), because the
    // wrong reason was load-bearing. This comment used to read "No 1999 D24
    // catalog row carries a printRun at all -- the /1500 in the checklist
    // belongs to the Triple Diamond tier." That was true when written and is
    // not true now: #1787 ingested
    // `hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500`
    // (source baseballcardpedia, printRun 1500, Ken Griffey Jr.), verified
    // present in card_catalog 2026-09-05. The holding's real destination
    // EXISTS; what kept it unreachable was that this pass asked the matcher
    // for `parallel: "Base"` at /1500, a card that does not exist. Field
    // recovery reads the insert off the holding's own aspects and the same
    // question then returns that row at exact/0.98 -- see
    // holdingFieldRecovery.test.ts.
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

/**
 * CF-THE-REDERIVE-PASS-MUST-ASK-THE-WAY-PRODUCTION-ASKS (Drew, 2026-09-05).
 *
 * ca7a150b priced at $182.50 on an exact-pool-last-sale at confidence 0.23,
 * flagged "we could not identify this card", while the catalog held its exact
 * checklist-backed row the whole time. Two agents concluded the card had no
 * ladder. Both were wrong, and the defect was in how THIS SCRIPT asked:
 *
 *   1. it sent `product` where production sends `setName`. The holding stores
 *      product="Bowman" and setName="Bowman Chrome"; normalizeSetKey maps
 *      those to `bowman` and `bowman-chrome`. Asking as `bowman` made the
 *      matcher find the right row and then reject it through its own setKey
 *      invariant -- askedSetKey=bowman vs returnedSlug=...bowman-chrome...
 *      That is the #1180 shape exactly: a right guard fed a wrong question.
 *
 *   2. it never sent printRun, so the matcher could not reach a :num-N rung.
 *
 * These pins are on the ARGUMENT SHAPE, because that is what was wrong. The
 * matcher and the gate are both left untouched.
 */
describe("the rederive pass asks with the holding's set name and print run", () => {
  const src = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"),
    "utf8",
  );

  it("prefers setName over product, exactly as production does", () => {
    // ebayReviewQueue.service.ts:523 is the production spelling.
    expect(src).toContain('setName: String(h.setName ?? h.product ?? "")');
    // The inverted precedence is what sent `bowman` and must never come back.
    expect(src).not.toContain('setName: String(h.product ?? h.setName ?? "")');
  });

  it("passes printRun on every canonicalize call it makes", () => {
    // The pin is on the INTENT — every call states a print run — not on one
    // spelling of it. Field recovery added a third call that states the
    // RECOVERED run (`rec.fields.printRun`), which is the same claim read from
    // a wider source; counting only the `h.printRun` spelling would fail on a
    // call that is more correct, not less.
    const calls = src.split("await canonicalize(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
    const withStoredRun = src.split("printRun: typeof h.printRun").length - 1;
    const withRecoveredRun = src.split("printRun: typeof rec.fields.printRun").length - 1;
    expect(withStoredRun + withRecoveredRun).toBe(calls);
  });
});
