/**
 * CF-A-SOURCE-THAT-CONTRADICTS-ITSELF-MINTS-NO-IDENTITIES (Drew, 2026-09-05,
 * ruling A) -- the panini-score orphans, pinned.
 *
 * THE RULING. `rekey-product-setkey MODE=catalog` has three outcomes, and
 * #1795 measured all three against the live `panini-score` rows:
 *
 *   FOLD    2,807  a `score` row is already there and wins -> SAFE, proceed
 *   REPLACE     4  the hobbymonitor row wins, same player both sides -> SAFE
 *   MOVE      891  nothing at the destination, so the row MINTS an identity
 *                  on one unreliable source's word alone -> RETIRE instead
 *
 * A fold and a replace were adjudicated against a rival. A MOVE was not
 * adjudicated at all, and 310 of the 500 sampled movers name a player `score`
 * already holds at a DIFFERENT number -- so the move mints a duplicate identity
 * for a card that already exists (CF-ONE-CARD-ONE-ROW-ONE-POOL).
 *
 * These pins are on the SCRIPT'S CONTRACT -- its refusals, its source scoping
 * and the shape of the marker it writes -- rather than on a live Cosmos run.
 * The script is a CJS ops script with a Cosmos client in its main(); what is
 * testable without prod is exactly what a mis-dispatch would get wrong, and a
 * mis-dispatch is the failure this lane is guarding against.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "rekey-product-setkey.cjs");
const SRC = readFileSync(SCRIPT, "utf8");

/** Run the script with an env and capture what it said before it exited. A
 *  refusal happens before any Cosmos client is built, which is the point:
 *  a bad dispatch must die on its own arguments, not after a page of reads. */
function run(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe", timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** The panini-score dispatch, minus whatever the case under test omits. */
const BASE = {
  MODE: "catalog",
  SPORT: "football",
  SETKEY: "panini-score",
  TO_SETKEY: "score",
  RETIRE_UNTWINNED: "true",
  RETIRE_UNTWINNED_SOURCES: "hobbymonitor",
  RETIRE_REASON: "source-unreliable:hobbymonitor-2025-score",
  COSMOS_CONNECTION_STRING: "",
};

describe("RETIRE_UNTWINNED refuses a dispatch that cannot be audited", () => {
  it("REFUSES without the source(s) it distrusts -- a lane that trusts nothing retires everything", () => {
    const r = run({ ...BASE, RETIRE_UNTWINNED_SOURCES: "", SOURCES: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("requires the SOURCE(S) it distrusts");
  });

  it("REFUSES without a reason -- a retirement nobody can audit is a disappearance", () => {
    const r = run({ ...BASE, RETIRE_REASON: "", SCOPE: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("requires RETIRE_REASON");
  });

  it("REFUSES on MODE=pool -- segment surgery on SALES mints no identity to retire", () => {
    const r = run({ ...BASE, MODE: "pool", YEARS: "2025" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("MODE=catalog only");
  });

  it("REFUSES on MODE=holdings for the same reason", () => {
    const r = run({ ...BASE, MODE: "holdings" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("MODE=catalog only");
  });

  it("a complete dispatch gets PAST the refusals and dies on the missing connection string", () => {
    // Proof the guards above are the ONLY things stopping it -- otherwise a
    // test asserting "it refused" could be passing on an unrelated refusal.
    const r = run(BASE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
  });
});

describe("the runner carries the new inputs on EXISTING slots (24 of 25 used)", () => {
  it("the distrusted sources travel in `sources` -> SOURCES", () => {
    const r = run({ ...BASE, RETIRE_UNTWINNED_SOURCES: "", SOURCES: "hobbymonitor" });
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
    expect(r.out).not.toContain("requires the SOURCE(S)");
  });

  it("the reason travels in `scope` -> SCOPE", () => {
    const r = run({ ...BASE, RETIRE_REASON: "", SCOPE: "source-unreliable:hobbymonitor-2025-score" });
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
    expect(r.out).not.toContain("requires RETIRE_REASON");
  });

  it("no NEW workflow input is introduced -- the dispatch uses inputs that exist", () => {
    const wf = readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    for (const declared of ["SOURCES: ${{ inputs.sources }}", "SCOPE: ${{ inputs.scope }}"]) {
      expect(wf, declared).toContain(declared);
    }
    // and no new `inputs.` name was invented for the flag.
    expect(wf).not.toContain("inputs.retire_untwinned");
  });

  it("the workflow arms RETIRE_UNTWINNED from the SOURCE LIST, scoped to this one script", () => {
    const wf = readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const line = wf.split("\n").find((l) => l.trim().startsWith("RETIRE_UNTWINNED:"));
    expect(line, "RETIRE_UNTWINNED must be exported").toBeTruthy();
    // Scoped by script name, so the token cannot leak into another lane.
    expect(line).toContain("inputs.script == 'rekey-product-setkey'");
    // ...and by mode, because the script refuses it on pool/holdings anyway.
    expect(line).toContain("inputs.mode == 'catalog'");
    // ...and armed only when the operator NAMED what to distrust.
    expect(line).toContain("inputs.sources != ''");
  });
});

describe("the MOVE -> RETIRE rule, and what it deliberately leaves alone", () => {
  it("the flag is OFF by default -- no other product's re-key changes behaviour", () => {
    expect(SRC).toContain('const RETIRE_UNTWINNED = String(process.env.RETIRE_UNTWINNED || "") === "true"');
  });

  it("FOLD and REPLACE still go through moveCatalogRow -- they were never the hazard", () => {
    // Only the no-incumbent branch diverts. If someone ever guards the
    // moveCatalogRow call itself on `distrusted`, the folds stop happening and
    // the 2,807 safe rows are stranded on the wrong key.
    expect(SRC).toContain("const r = await moveCatalogRow(cat, d, newSlug, { setKey: TO }, {");
    expect(SRC).not.toMatch(/if\s*\(\s*!?distrusted\s*\)\s*\{\s*const r = await moveCatalogRow/);
  });

  it("the retired row is LABELLED, never deleted -- sold_comps rows reference these ids", () => {
    expect(SRC).toContain("identityUnverified: true");
    expect(SRC).toContain("retiredReason: RETIRE_REASON");
    // The retire branch must not reach for a delete or a move.
    const branch = SRC.slice(SRC.indexOf("if (!incumbent) {"), SRC.indexOf("s.retiredUntwinned++"));
    expect(branch).not.toContain("deleteTolerant");
    expect(branch).not.toContain("moveCatalogRow");
  });

  it("the write goes through patchCatalogRowFields, never a raw container.patch (#1614)", () => {
    expect(SRC).toContain("await patchCatalogRowFields(cat, id, d.cardId, mark,");
    expect(SRC).not.toContain("cat.item(id, d.cardId).patch(");
  });

  it("GRADED CHILDREN FOLLOW their parent, and are LABELLED rather than deleted", () => {
    expect(SRC).toContain("for (const kid of kids) {");
    expect(SRC).toContain("await patchCatalogRowFields(cat, String(kid.id), kid.cardId, mark, { retry });");
    // gradedChildrenOf LISTS; the retire path must not call the sibling that
    // DELETES (right for a move, wrong for a label -- there is no new address).
    const branch = SRC.slice(SRC.indexOf("if (!incumbent) {"), SRC.indexOf("s.retiredUntwinned++"));
    expect(branch).not.toContain("retireGradedChildren");
    expect(branch).not.toContain("retireCatalogRow");
  });

  it("nothing is written in REPORT mode -- every write sits behind APPLY", () => {
    const branch = SRC.slice(SRC.indexOf("if (!incumbent) {"), SRC.indexOf("s.retiredUntwinned++"));
    expect(branch).toContain("if (APPLY) {");
    // The counter increments OUTSIDE the APPLY guard: a report must still say
    // how many rows it would have retired.
    expect(SRC).toMatch(/\}\s*\n\s*s\.retiredUntwinned\+\+;/);
  });

  it("the labelled row counts as a WRITE in the reconciliation, its children do not", () => {
    // Its children were never scanned as candidates, so counting them would
    // claim more writes than were intended -- the same arithmetic
    // gradedRetiredCascade already documents.
    expect(SRC).toContain("s.gradedRetiredDirect + s.retiredUntwinned;");
    expect(SRC).not.toContain("+ s.retiredUntwinnedChildren;");
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────

describe("MUTATION: the MOVE->RETIRE rule", () => {
  it("a mutant that ignored the source list would retire EVERY untwinned row", () => {
    // The branch is guarded on `distrusted`, which is RETIRE_UNTWINNED *AND*
    // the row's own source. A mutant reading only the flag would retire a
    // checklistinsider row scanned by the same dispatch. Both halves are pinned
    // in the source, so deleting either turns this red.
    expect(SRC).toContain("const distrusted = RETIRE_UNTWINNED && isUntrustedSource(d.source);");
    expect(SRC).toContain("if (distrusted) {");
    expect(SRC).not.toContain("if (RETIRE_UNTWINNED) {\n                try {");
  });

  it("a mutant that dropped the prefix match would miss the dated re-scrape", () => {
    // The live rows are stamped `hobbymonitor-2026-09-04`, not `hobbymonitor`.
    // An equality-only match would retire NOTHING and report a clean run --
    // the silent-no-op failure this check exists to catch.
    const m = SRC.match(/function isUntrustedSource\(source\)[\s\S]*?\n\}/);
    expect(m, "isUntrustedSource must exist").toBeTruthy();
    expect(m![0]).toContain("s.startsWith(`${n}-`)");
  });

  it("a mutant that let the retire branch fall through would still MOVE the row", () => {
    // The branch must `return` -- without it the row is labelled AND moved,
    // which is the exact outcome the ruling forbids.
    const branch = SRC.slice(SRC.indexOf("if (!incumbent) {"), SRC.indexOf("const r = await moveCatalogRow"));
    expect(branch).toContain("return;");
  });

  it("a mutant that reported the moves as 0 without diverting them would look identical", () => {
    // So the banner says what to EXPECT, and the counters are disjoint: a run
    // whose MOVED is non-zero under this flag is a run that did not divert.
    expect(SRC).toContain("RETIRE_UNTWINNED ? \"   <- 0 expected: RETIRE_UNTWINNED diverts every move\" : \"\"");
    expect(SRC).toContain("retiredUntwinned: 0, retiredUntwinnedChildren: 0,");
  });
});
