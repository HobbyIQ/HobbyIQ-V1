// CF-NAME-THE-ROWS-BEFORE-CALLING-DAMAGE (2026-09-13).
//
// The 2026-09-13 defect: six of sixteen APPLY shards of
// retire-self-derived-identities.cjs printed
//
//   VERIFY BY READ baseball: verified 85 of 87 written *** 2 MISSING THE MARKER ***
//   VERIFY RECONCILE  written 87 = verified 85 + mismatched 2 + unconfirmed 0
//
// and exited 7 without ever naming which two ids mismatched or why. A
// mismatch nobody can point at is a mismatch nobody can act on
// (feedback_never_dismiss_small_numbers_as_noise: a targeted query, not an
// aggregate explanation). The lane's own main() connects to Cosmos and cannot
// be required by a test, so the decision it makes at verify time --
// "does this point-read confirm the write" -- was pulled out to
// scripts/lib/write-ledger-verify.cjs, where it can be exercised against a
// MOCKED read result with no Cosmos client anywhere in the path.
//
// These pins cover:
//   1. classifyLedgerRead's four outcomes (ok, 404, present-without-marker,
//      different-value), including the UNVERIFIED field's boolean-only shape
//      and the cross-sport retire's `expect`-carrying marker.
//   2. createLedger's dedupe -- the graded-child double-ledger defect this
//      investigation found while tracing the false-mismatch reports: a kid
//      row is reachable both as its own self-derived entry and as a member of
//      its parent's `kids` list, and used to be pushed to the ledger twice.
//   3. THE WIRING -- the lane's source actually calls classifyLedgerRead and
//      createLedger (not a re-implementation that can drift), prints one
//      MISMATCH line per bad entry, prints a reason tally, and writes the
//      ledger + verify outcome to WRITE_LEDGER_OUT.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const LANE = path.join(BACKEND, "scripts/retire-self-derived-identities.cjs");

const lib = require_(path.join(BACKEND, "scripts/lib/write-ledger-verify.cjs"));
const { classifyLedgerRead, createLedger } = lib as {
  classifyLedgerRead: (
    entry: { id: string; pk: string; field: string; expect?: string },
    resource: Record<string, unknown> | undefined | null,
    retiredDefault: string,
  ) => { ok: boolean; reason?: string; found?: unknown };
  createLedger: () => {
    push: (entry: Record<string, unknown>) => boolean;
    entries: Array<Record<string, unknown>>;
    duplicates: number;
    length: number;
  };
};

const laneSrc = fs.readFileSync(LANE, "utf8").replace(/\r\n/g, "\n");
const RETIRED = "superseded-by-checklist";
const UNVERIFIED = "identityUnverified";

describe("classifyLedgerRead — the verify decision, isolated from Cosmos", () => {
  it("A REAL 404: resource undefined is named 404, never folded into 'mismatched' silently", () => {
    const v = classifyLedgerRead({ id: "row1", pk: "row1", field: "retiredReason" }, undefined, RETIRED);
    expect(v).toEqual({ ok: false, reason: "404", found: "ABSENT" });
  });

  it("A REAL VALUE MISMATCH: the field carries a DIFFERENT value than this write meant to leave", () => {
    const v = classifyLedgerRead(
      { id: "row2", pk: "row2", field: "retiredReason" },
      { retiredReason: "some-other-writer-touched-this" },
      RETIRED,
    );
    expect(v).toEqual({ ok: false, reason: "different-value", found: "some-other-writer-touched-this" });
  });

  it("the row exists but the field was never set at all -- the write did not land", () => {
    const v = classifyLedgerRead({ id: "row3", pk: "row3", field: "retiredReason" }, { id: "row3" }, RETIRED);
    expect(v).toEqual({ ok: false, reason: "present-without-marker", found: "ABSENT" });
  });

  it("a plain retire matches the RETIRED default when the entry carries no `expect`", () => {
    const v = classifyLedgerRead(
      { id: "row4", pk: "row4", field: "retiredReason" },
      { retiredReason: RETIRED },
      RETIRED,
    );
    expect(v).toEqual({ ok: true });
  });

  it("a cross-sport retire is verified against the marker IT actually wrote, not the plain default", () => {
    // Hard-coding RETIRED here is exactly the defect the lane's own comment on
    // `const want = e.expect || RETIRED` guards against: a
    // sport-contaminated:twin-in-baseball write would read as a mismatch.
    const reason = "sport-contaminated:twin-in-baseball";
    const v = classifyLedgerRead(
      { id: "row5", pk: "row5", field: "retiredReason", expect: reason },
      { retiredReason: reason },
      RETIRED,
    );
    expect(v).toEqual({ ok: true });
  });

  it("UNVERIFIED is boolean-only: true is ok, anything else is a mismatch with no `expect` fallback", () => {
    expect(classifyLedgerRead({ id: "r6", pk: "r6", field: UNVERIFIED }, { identityUnverified: true }, RETIRED))
      .toEqual({ ok: true });
    // The field IS present, just not `true` -- a real value, so "different-value".
    expect(classifyLedgerRead({ id: "r7", pk: "r7", field: UNVERIFIED }, { identityUnverified: false }, RETIRED))
      .toEqual({ ok: false, reason: "different-value", found: false });
    // The field was never set at all -- the write did not land.
    expect(classifyLedgerRead({ id: "r8", pk: "r8", field: UNVERIFIED }, {}, RETIRED))
      .toEqual({ ok: false, reason: "present-without-marker", found: "ABSENT" });
  });
});

describe("createLedger — the graded-child double-ledger defect", () => {
  it("a kid ledgered once via its own self-derived entry and again via its parent's `kids` list is kept ONCE", () => {
    // The exact shape from the lane: a graded child `<parent>:psa-10` mirrors
    // its parent's identity fields and can retire on its own AS `r` in the
    // `sd` loop, then reappears in `childrenOf.get(parent.id)` when the
    // parent retires and takes its children with it.
    const ledger = createLedger();
    const kidId = "hiq:baseball:2026:bowman:cpa-mg:base::psa-10";

    const firstPush = ledger.push({ id: kidId, pk: "parent-card-id", field: "retiredReason" });
    const secondPush = ledger.push({ id: kidId, pk: "parent-card-id", field: "retiredReason", extra: "graded-child-path" });

    expect(firstPush).toBe(true);
    expect(secondPush).toBe(false);
    expect(ledger.length).toBe(1);
    expect(ledger.duplicates).toBe(1);
    // The FIRST write is the one the verify checks -- never silently
    // shadowed by whatever pushed second.
    expect(ledger.entries[0]).toEqual({ id: kidId, pk: "parent-card-id", field: "retiredReason" });
  });

  it("does not dedupe DIFFERENT ids -- only a genuine re-ledger of the same id is caught", () => {
    const ledger = createLedger();
    ledger.push({ id: "a", pk: "a", field: "retiredReason" });
    ledger.push({ id: "b", pk: "b", field: "retiredReason" });
    expect(ledger.length).toBe(2);
    expect(ledger.duplicates).toBe(0);
  });
});

describe("the lane's source actually uses the shared decision, and names every mismatch", () => {
  it("requires classifyLedgerRead and createLedger from the shared lib, not a re-implementation", () => {
    expect(laneSrc).toContain(
      'require(path.join(__dirname, "lib", "write-ledger-verify.cjs"))',
    );
    expect(laneSrc).toContain("classifyLedgerRead(e, resource, RETIRED)");
    expect(laneSrc).toContain("createLedger()");
  });

  it("prints one MISMATCH line per bad entry, naming id, pk, field, expected and found", () => {
    expect(laneSrc).toContain(
      "console.log(`  MISMATCH ${m.id} pk=${m.pk} field=${m.field} expected=${JSON.stringify(m.expect)} found=",
    );
    // Printed BEFORE the aggregate banner -- the named lines are the primary
    // evidence, the count is a summary of them.
    const mismatchLinesAt = laneSrc.indexOf("for (const m of mismatches)");
    const bannerAt = laneSrc.indexOf("VERIFY BY READ  ${SPORT}: verified");
    expect(mismatchLinesAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(mismatchLinesAt);
  });

  it("prints a per-reason tally distinguishing 404 vs present-without-marker vs different-value", () => {
    expect(laneSrc).toContain("MISMATCH TALLY BY REASON");
    // The reason strings themselves are classifyLedgerRead's vocabulary
    // (checked directly against the lib above); what belongs to the lane is
    // that it renders whatever reason comes back into the tally.
    const libSrc = fs.readFileSync(
      path.join(BACKEND, "scripts/lib/write-ledger-verify.cjs"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(libSrc).toContain('reason: "404"');
    expect(libSrc).toContain('"present-without-marker"');
    expect(libSrc).toContain('"different-value"');
    expect(libSrc).not.toContain('"absent"'); // the task's own wording is "404 vs present-without-marker vs different-value"
  });

  it("persists the ledger and verify outcome to WRITE_LEDGER_OUT, next to /tmp/backfill.log", () => {
    expect(laneSrc).toContain(
      'const WRITE_LEDGER_OUT = String(process.env.WRITE_LEDGER_OUT || "/tmp/retire-self-derived-write-ledger.json").trim();',
    );
    expect(laneSrc).toContain("fs.writeFileSync(WRITE_LEDGER_OUT");
    expect(laneSrc).toContain("mismatches,");
  });

  it("a mismatch still ends the lane non-zero -- the new logging does not weaken the gate", () => {
    // CF-A-CAP-THAT-DOES-NOT-END-THE-LANE-IS-A-COMMENT: naming the rows must
    // not become a reason to let a bad run go green.
    expect(laneSrc).toContain("if (capHit || mismatched) {");
    expect(laneSrc).toContain("await finishLane(capHit ? 6 : 7, { client, budget: LANE_BUDGET });");
  });
});
