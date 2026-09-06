import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { droppedSpecificityAxes, GRADED_SUFFIX } from "../scripts/comp-quality/recheck-holding-identity.js";

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
    //
    // The GATE 1b widening (#1849) adds a FOURTH call — the title-product
    // re-ask, made when the destination's player contradicts the holding's. It
    // states the run as a ternary over both sources at once, because it fires
    // whether or not recovery ran and must carry the claim either way. Same
    // intent, a third spelling.
    const calls = src.split("await canonicalize(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
    const withStoredRun = src.split("printRun: typeof h.printRun").length - 1;
    const withRecoveredRun = src.split("printRun: typeof rec.fields.printRun").length - 1;
    const withEitherRun = src.split("printRun: recovery").length - 1;
    expect(withStoredRun + withRecoveredRun + withEitherRun).toBe(calls);
  });
});

/**
 * CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW (Drew, 2026-09-05).
 *
 * Run 33998562094 reported AGREE on nine of ten withheld-holding cells, and
 * seven of those holdings were STILL withheld by the pricing gate after the
 * reprice. Both readings were of the same rows. AGREE compared two SLUG
 * STRINGS (`to === from`) and returned before GATE 1 — the gate that asks
 * whether a destination is a real checklist row — so a holding sitting on a
 * row we minted from its owner's own eBay import reported as "already right".
 *
 * Measured on prod, 2026-09-05, the exact rows behind those verdicts:
 *
 *   437f010d, 5979f485  Drew's two 1997 Bowman's Best BBP4 Jeter Atomic
 *                       Refractors. One catalog row at the slug, source
 *                       `ebay-user-purchase`. identityBackingOf ->
 *                       self-derived-only. No checklist row transcribes the
 *                       Atomic Refractor at BBP4 at all: the 17 sibling rows
 *                       are baseballcardpedia's `45-mark-mcgwire`,
 *                       `82-derek-jeter`, `9-chipper-jone` … a scrape of the
 *                       card's BACK. ACQUISITION, not a matcher fix.
 *   bba3b7ad            2005 Bowman Chrome BDP129 Verlander, `user-verified`,
 *                       zero checklist rows anywhere on the card.
 *   9d88f672            2023 Bowman Chrome CPAFC Celesten, `ebay-user-purchase`,
 *                       the ONLY row on the card.
 *   206b648f            2026 Bowman #10 Sio X-Fractor /10, `ebay-user-purchase`.
 *   2b62a93f            2022 Topps Chrome #221 Witt Jr., `ebay-user-purchase`.
 *   4a82faed, 25bc5079  2025 Bowman Chrome CPA-DT `refractor-auto-499`,
 *                       `ebay-user-purchase` — the parallel segment is a
 *                       LISTING TITLE, and checklistcenter's real `refractor`
 *                       row is the twin.
 *
 * The pins below are on what the branch must ASK, not on a live catalog.
 */
describe("GATE A — AGREE asks the pricing gate's question of its own row", () => {
  const src = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"),
    "utf8",
  );

  it("does not return on `to === from` before asking what backs `from`", () => {
    // THE MUTATION CHECK. Restoring the bare short-circuit — a `push` of AGREE
    // immediately followed by `continue` with no backing read between — is the
    // defect, and it is what this pin exists to catch.
    const branch = src.slice(src.indexOf("if (to === from) {"));
    const gateA = branch.slice(0, branch.indexOf("// GATE 1 —"));
    expect(gateA).toContain("await backingOf(from as string)");
    expect(gateA).toContain("identityBackingOf(");
    // The un-asked verdict must never be reachable again.
    expect(gateA).not.toContain('verdict: "AGREE", reason: "re-derivation agrees with the stored identity"');
  });

  it("uses the pricing gate's OWN predicate, never a local restatement", () => {
    // sourceCorroboration's header: four spellings of "is this row
    // checklist-backed" is how the rematch writes rows the gate refuses.
    expect(src).toContain('from "../../src/services/catalog/identityBacking.js"');
    expect(src).toContain("identityBackingOf");
    // A hand-rolled source regex in this file would be the drift that header
    // names. The only source-class tests here come from the imported modules.
    expect(src).not.toMatch(/ebay-user-purchase\|user-verified/);
  });

  it("splits AGREE three ways: backed, re-point, and acquire", () => {
    expect(src).toContain('verdict: "AGREE-UNBACKED"');
    expect(src).toContain('"REDERIVE" | "AGREE" | "AGREE-UNBACKED" | "UNVERIFIED" | "NO-MATCH"');
    // The Jeter case: no twin means ACQUIRE, and it must be counted as such
    // rather than folded into AGREE, which is exactly what read as progress.
    expect(src).toContain("no checklist row transcribes this card");
  });

  it("refuses to pick when several checklist twins survive the gates", () => {
    // Ambiguity is a refusal, for catalogIdentityResolver's own reason: a
    // destination chosen by sort order is a confident wrong price.
    expect(src).toContain("ambiguous, refusing to pick one");
    expect(src).toContain("twins.length === 1");
  });

  it("never overwrites a human's ruling, twin or no twin", () => {
    // GATE A4 is asked BEFORE the re-point. The standing GREAT REMATCH rule is
    // that ruled rows are report-only forever; a new gate that could move one
    // would hand this pass the power #1811 built a gate to deny it.
    const branch = src.slice(src.indexOf("if (to === from) {"));
    const gateA = branch.slice(0, branch.indexOf("// GATE 1 —"));
    const a4 = gateA.indexOf("recovery?.userAuthored");
    const repoint = gateA.indexOf("twins.length === 1");
    expect(a4).toBeGreaterThan(-1);
    expect(repoint).toBeGreaterThan(-1);
    expect(a4).toBeLessThan(repoint);
  });

  it("asks GATE 2 of the re-point, so a twin cannot fuse two pools", () => {
    // A re-point out of a self-derived row is a move like any other. Drew's
    // 4a82faed claims printRun 499 and its twin must state it.
    const branch = src.slice(src.indexOf("if (to === from) {"));
    const gateA = branch.slice(0, branch.indexOf("// GATE 1 —"));
    expect(gateA).toContain("droppedSpecificityAxes(claim, t.id).length === 0");
  });

  it("excludes graded children from the twin set", () => {
    // A self-derived row's own `:psa-7` child carries its parent's provenance
    // — counting it would let a row confirm itself one tier up. The live
    // Jeter slug has exactly such a child, `…:atomic-refractor:no-auto:psa-7`,
    // source `ebay-user-purchase-graded`.
    expect(src).toContain("GRADED_SUFFIX.test(String(r.id))");
  });
});

describe("GRADED_SUFFIX — a grade tail, not a parallel that looks like one", () => {
  it("matches the grader tails the catalog actually mints", () => {
    for (const id of [
      "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto:psa-7",
      "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto:bgs-9-5",
      "hiq:baseball:1997:bowmans-best:bbp4:45-mark-mcgwire:no-auto:bgs-10-black",
      "hiq:baseball:1997:bowmans-best:bbp4:45-mark-mcgwire:no-auto:sgc-10",
      "hiq:baseball:1997:bowmans-best:bbp4:45-mark-mcgwire:no-auto:cgc-9-5",
    ]) expect(GRADED_SUFFIX.test(id)).toBe(true);
  });

  it("does not match a parent row, nor a print run", () => {
    for (const id of [
      "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto",
      "hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499",
      // The tail is matched at the END only, so a graded parent's own parallel
      // segment cannot be read as a grade.
      "hiq:baseball:2026:bowman:10:x-fractor:auto:num-10",
    ]) expect(GRADED_SUFFIX.test(id)).toBe(false);
  });
});
