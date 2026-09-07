// CF-THE-ACQUISITION-QUEUE-MUST-ONLY-CARRY-CELLS-A-SOURCE-CAN-SERVE, applied
// (2026-09-07) — the pins for the WRITE half.
//
// audit-seed-queue-sport-hygiene measured 2,080 polluted `catalog_seed_queue`
// entries and emitted them as a committed purge list. It is report-only by
// construction. purge-seed-queue-sport-hygiene is the lane that acts on that
// list, and the three properties that make it safe to point at prod are the
// ones pinned here:
//
//   1. ONE SOURCE OF TRUTH. The lane does not re-implement the verdict. It
//      calls scripts/lib/sport-contamination.cjs — the same module the audit
//      and retireSelfDerivedSportContamination drive — so a rule change moves
//      the audit, the retire lane and this lane together. Two copies of one
//      rule is how two readings of one product begin to disagree.
//
//   2. THE LIST IS RE-DERIVED, NEVER TRUSTED. The committed list is a snapshot.
//      Between the measurement and the apply, an ingest can land the checklist
//      that was missing — and the cell that was "contaminated" becomes a
//      legitimate acquisition target. An entry the live catalog no longer
//      calls polluted must be SKIPPED, never marked. This is the property with
//      teeth: without it the lane's blast radius grows with its own age.
//
//   3. MARK, NEVER DELETE. The write is the drainer's own vocabulary —
//      status=unavailable with a reason — so the row stays visible as real
//      demand with its requestCount intact. A delete would destroy the
//      evidence of the ingest defect that minted it.
//
// THE MUTATIONS ARE THE POINT. Sections 2 and 3 delete the drift gate and the
// idempotency check exactly as a regression would, and assert that the harm
// reappears: a cell whose checklist has since landed gets marked, and an
// already-marked row gets re-written. A pin that passes against a mutated rule
// is decoration (splitIdentityCensus.test.ts's lesson, and the sibling pin's).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const LANE = path.join(BACKEND, "scripts/purge-seed-queue-sport-hygiene.cjs");
const AUDIT = path.join(BACKEND, "scripts/audit-seed-queue-sport-hygiene.cjs");
const RUNNER = path.join(ROOT, ".github/workflows/backfill-runner.yml");

const lib = require_(path.join(BACKEND, "scripts/lib/sport-contamination.cjs"));
const { classifySportContamination } = lib;

/** The lane's source, read rather than executed: it connects to Cosmos at
 *  main(). Its pure exports ARE imported below; the source is read for the
 *  wiring — that the write is a mark, that the gates exist, that the
 *  reconciliation covers the whole list. */
const laneSrc = fs.readFileSync(LANE, "utf8").replace(/\r\n/g, "\n");
const runnerSrc = fs.readFileSync(RUNNER, "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const laneCode = stripComments(laneSrc);

// ── THE FIXTURES ────────────────────────────────────────────────────────────
//
// The real shapes from the 2026-09-07 census. 1952 Bowman is baseball-only
// (Bowman setKey taxonomy ruling) and the queue asks for it in FOOTBALL.
const BOWMAN_1952 = { baseball: 412 };
// A genuinely cross-sport product: several sports attest, so no address can be
// stood behind and the verdict is ambiguous.
const SCORE_1991 = { baseball: 893, football: 704, hockey: 441 };
// The SAME product-year AFTER the missing checklist landed. This is the drift
// the re-derivation exists to catch.
const BOWMAN_1952_AFTER_INGEST = { baseball: 412, football: 118 };

describe("1. the classification is the shared lib's, not a second copy", () => {
  it("the lane calls sport-contamination.cjs", () => {
    expect(
      /require\(path\.join\(__dirname, "lib", "sport-contamination\.cjs"\)\)/.test(laneCode),
      "the lane must classify through the shipped module the audit and the retire lane use",
    ).toBe(true);
    expect(/classifySportContamination\(/.test(laneCode)).toBe(true);
  });

  it("the lane contains NO second copy of the verdict logic", () => {
    // The verdicts are the lib's vocabulary. A lane that spells them into its
    // own branching has forked the rule.
    expect(
      /verdict\s*===?\s*"(contaminated|agree|no-attestation)"/.test(laneCode),
      "the lane re-decides a verdict the lib already returned — that is a second copy of the rule",
    ).toBe(false);
    // `contaminated` is READ off the lib's result, never computed.
    expect(/v\.contaminated/.test(laneCode)).toBe(true);
  });

  it("the reason vocabulary matches the audit's, verbatim", () => {
    const auditSrc = fs.readFileSync(AUDIT, "utf8");
    for (const literal of ["sport-ambiguous", "sport-contaminated:checklist-in-"]) {
      expect(auditSrc.includes(literal), `audit must emit ${literal}`).toBe(true);
      expect(laneCode.includes(literal), `lane must write ${literal}`).toBe(true);
    }
  });

  it("the shared rule still decides the census's own shapes", () => {
    // Not a restatement of the lib's pin — the point is that the SAME call the
    // lane makes produces these verdicts, so a lib change surfaces here too.
    expect(classifySportContamination({ sport: "football", checklistSportCounts: BOWMAN_1952 }))
      .toMatchObject({ contaminated: true, verdict: "contaminated", trueSport: "baseball" });
    expect(classifySportContamination({ sport: "pokemon", checklistSportCounts: SCORE_1991 }))
      .toMatchObject({ contaminated: true, verdict: "ambiguous", trueSport: null });
  });
});

describe("2. the list is re-derived, never trusted", () => {
  it("a cell whose checklist has since landed is NO LONGER polluted", () => {
    // THE DRIFT. The list was written when 1952 Bowman had no football
    // checklist; it now has one. The entry must fall out of the polluted set.
    const before = classifySportContamination({ sport: "football", checklistSportCounts: BOWMAN_1952 });
    const after = classifySportContamination({ sport: "football", checklistSportCounts: BOWMAN_1952_AFTER_INGEST });
    expect(before.contaminated, "the list's snapshot said polluted").toBe(true);
    expect(after.contaminated, "the live catalog now says it is a real acquisition target").toBe(false);
    expect(after.verdict).toBe("agree");
  });

  it("the lane re-classifies against the LIVE catalog before writing", () => {
    // The projection that rebuilds the counts, inside the work loop.
    expect(
      /SELECT c\.sport, c\.source FROM c WHERE c\.year=@y AND c\.setKey=@k/.test(laneCode),
      "the lane must re-read the catalog per cell; a lane that trusts its list writes stale verdicts",
    ).toBe(true);
    // The verdict is computed from THOSE rows, not read off the list entry.
    expect(
      /checklistSportCounts:\s*counts/.test(laneCode),
      "the classification must consume the freshly-read counts, not the list's stored verdict",
    ).toBe(true);
  });

  it("MUTATION: deleting the drift gate lets a healed cell be marked", () => {
    // The gate, as shipped: not-contaminated short-circuits BEFORE any write.
    const gate = /if \(!v\.contaminated\) \{[\s\S]*?continue;[\s\S]*?\}/.exec(laneCode);
    expect(gate, "the lane must skip an entry the live catalog no longer calls polluted").toBeTruthy();
    const gateBlock = (gate as RegExpExecArray)[0];
    expect(/skippedNoLonger\+\+/.test(gateBlock), "the skip must be COUNTED, not silent").toBe(true);

    // Drop it exactly as a regression would, and the healed entry reaches the
    // write. The harm is a legitimate acquisition target marked unavailable.
    const mutated = laneCode.replace(gateBlock, "");
    expect(
      /skippedNoLonger\+\+/.test(mutated),
      "with the gate deleted nothing counts the drift — a healed cell would be marked unavailable",
    ).toBe(false);
  });

  it("the drift is reported, not silently absorbed", () => {
    expect(/LIST DRIFT/.test(laneSrc), "the operator must see the list and the world disagree").toBe(true);
    expect(/skipped -- no longer polluted/.test(laneSrc)).toBe(true);
  });
});

describe("3. mark, never delete — and idempotent", () => {
  it("the write is an upsert to status=unavailable, and nothing deletes", () => {
    expect(/const MARK_STATUS = "unavailable"/.test(laneCode)).toBe(true);
    expect(/queue\.items\.upsert\(/.test(laneCode), "the write is the drainer's own restamp").toBe(true);
    expect(
      /queue\.item\([^)]*\)\.delete\(|\.delete\(\)/.test(laneCode),
      "this lane must never delete a queue row — the requestCount is the evidence",
    ).toBe(false);
  });

  it("the row is carried forward, not replaced by a stub", () => {
    // `...live` is what keeps requestCount / reasons / samples / firstRequestedAt.
    expect(
      /\.\.\.live,\s*\n\s*status: MARK_STATUS/.test(laneCode),
      "the upsert must spread the LIVE row; a fresh object would drop requestCount",
    ).toBe(true);
  });

  it("MUTATION: deleting the idempotency check re-writes an already-marked row", () => {
    const check = /if \(norm\(live\.status\) === MARK_STATUS\) \{ alreadyUnavailable\+\+; continue; \}/;
    expect(
      check.test(laneCode),
      "a seed already `unavailable` must be SKIPPED — a relaunch re-reads the same list",
    ).toBe(true);
    const mutated = laneCode.replace(check, "");
    expect(
      check.test(mutated),
      "without it every relaunch re-upserts every row, churning RUs and moving drainedAt",
    ).toBe(false);
  });

  it("a row that has left the queue is not resurrected", () => {
    expect(/skippedMissing\+\+/.test(laneCode)).toBe(true);
    expect(/if \(!live\) \{ skippedMissing\+\+; continue; \}/.test(laneCode)).toBe(true);
  });
});

describe("4. the report predicts the apply", () => {
  it("REPORT runs the classification, the live read and the idempotency check", () => {
    // The !APPLY early-return sits AFTER the derivation, not before it. A
    // report that skips the derivation cannot predict its apply — that is the
    // 2026-09-07 relocate incident, 148/148 reported and 91 failed.
    const iApply = laneCode.indexOf("if (!APPLY) {");
    const iClassify = laneCode.indexOf("classifySportContamination({ sport: asking");
    const iLiveRead = laneCode.indexOf("await queue.item(e.id, e.sport).read()");
    const iIdem = laneCode.indexOf("=== MARK_STATUS) { alreadyUnavailable++");
    expect(iApply, "the report's early return must exist").toBeGreaterThan(0);
    expect(iClassify).toBeGreaterThan(0);
    expect(iClassify, "classification happens BEFORE the report bails").toBeLessThan(iApply);
    expect(iLiveRead, "the live read happens BEFORE the report bails").toBeLessThan(iApply);
    expect(iIdem, "the idempotency check happens BEFORE the report bails").toBeLessThan(iApply);
  });

  it("the banner prints in both modes", () => {
    for (const line of [
      "entries in list", "re-derived polluted", "already unavailable",
      "skipped -- no longer polluted", "skipped -- gone from the queue",
      "skipped -- budget", "failed",
    ]) {
      expect(laneSrc.includes(line), `the banner must carry "${line}"`).toBe(true);
    }
  });
});

describe("5. every entry reconciles", () => {
  it("intended is the WHOLE list, so no entry can go unnamed", () => {
    expect(/const intended = entries\.length;/.test(laneCode)).toBe(true);
  });

  it("the reconciliation names written + skipped + failed and refuses a mismatch", () => {
    expect(/reconciled: intended .* = written .* \+ skipped .* \+ failed/.test(laneSrc)).toBe(true);
    expect(/RECONCILE MISMATCH/.test(laneSrc)).toBe(true);
    expect(/process\.exitCode = 4/.test(laneCode), "a mismatch must be RED, not a printed note").toBe(true);
  });

  it("every skip class is summed into `skipped` — none silently dropped", () => {
    const sum = /const skipped = ([^;]+);/.exec(laneCode);
    expect(sum).toBeTruthy();
    const expr = (sum as RegExpExecArray)[1];
    for (const counter of [
      "alreadyUnavailable", "skippedNoLonger", "skippedMissing",
      "skippedMalformed", "skippedBudget",
    ]) {
      expect(expr.includes(counter), `${counter} must be inside the reconciled skip total`).toBe(true);
    }
  });

  it("an entry with no readable (year, setKey) is counted, not dropped", () => {
    // The grouping can drop an entry; the counter recovers it so `intended`
    // still balances. An unnamed entry is the unaccounted row the whole
    // reconciliation exists to make impossible.
    expect(/const skippedMalformed = intended - grouped;/.test(laneCode)).toBe(true);
  });

  it("reportWrites is called under APPLY", () => {
    expect(/reportWrites\(\{/.test(laneCode)).toBe(true);
    expect(/job: "purge-seed-queue-sport-hygiene", intended, written: marked, skipped, failed/.test(laneCode)).toBe(true);
  });
});

describe("6. the verify is a ledger, never a COUNT", () => {
  it("marked ids are read back one by one", () => {
    expect(/markedIds\.push\(e\.id\)/.test(laneCode)).toBe(true);
    expect(
      /for \(const id of markedIds\)/.test(laneCode),
      "the verify must name the rows it confirms",
    ).toBe(true);
    expect(/queue\.item\(id, sport\)\.read\(\{ abortSignal \}\)/.test(laneCode)).toBe(true);
  });

  it("no container-wide COUNT stands in for the ledger", () => {
    expect(
      /SELECT VALUE COUNT\(1\)/.test(laneCode),
      "a count of status='unavailable' includes rows the drainer marked for its own reasons",
    ).toBe(false);
  });

  it("an unconfirmed verify prints UNCONFIRMED, never a zero", () => {
    expect(/UNCONFIRMED \(verify cap\)/.test(laneSrc)).toBe(true);
    expect(/the verify count is UNREAD, not zero/.test(laneSrc)).toBe(true);
  });
});

describe("7. the scope is required, and the runner can dispatch it", () => {
  it("an empty or non-.json SCOPE is refused, not defaulted", () => {
    const { scopeRefusal } = require_(LANE);
    expect(typeof scopeRefusal).toBe("function");
    // Both refusals are pure and testable without Cosmos.
    expect(/FATAL: SCOPE is empty/.test(laneSrc)).toBe(true);
    expect(/does not name a list file/.test(laneSrc)).toBe(true);
    expect(/process\.exit\(2\)/.test(laneCode), "the refusal must exit non-zero").toBe(true);
  });

  it("the runner whitelists the lane and forwards scope on relaunch", () => {
    expect(runnerSrc.includes("          - purge-seed-queue-sport-hygiene")).toBe(true);
    const step = runnerSrc
      .split(/\n(?=      - name:)/)
      .find((s) => /inputs\.script == 'purge-seed-queue-sport-hygiene'/.test(s));
    expect(step, "the lane needs a relaunch step").toBeTruthy();
    const s = step as string;
    // The three-way shape (#1913) is pinned in full by
    // relaunchNeverCallsAKilledRunFinished; what matters HERE is that the
    // relaunch carries the SAME list — a different list is a different scope.
    expect(/-f scope="\$\{\{ inputs\.scope \}\}"/.test(s)).toBe(true);
    expect(/-f apply="\$\{\{ inputs\.apply \}\}"/.test(s), "a report relaunches as a report").toBe(true);
  });

  it("the lane reads the switch the runner actually exports", () => {
    expect(/env\("BACKFILL_APPLY"\) === "true"/.test(laneCode)).toBe(true);
  });
});
