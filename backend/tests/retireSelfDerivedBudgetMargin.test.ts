// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS — the retire lane, pinned.
//
// Run 33960686247 (retire-self-derived-identities, sport=baseball, APPLY):
// the script finished its budget slice, printed its counts, and printed
//
//   RECONCILE  seen 417,163 = ... => 417,163 BALANCES
//   [retire-self-derived-identities] reconciled: intended 417,638
//                                    = written 193,658 + skipped 223,980
//
// at 12:43:23 — and was then killed at 12:58:10 by
//
//   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
//
// The 887 seconds in between were the post-loop VERIFY BY READ: two unbounded
// whole-sport `SELECT VALUE COUNT(1)` scans, the exact aggregate shape the
// script's own enumeration comment records as not returning on card_catalog.
// The data was fine. The job was red. The runner still re-dispatched slot
// 0/16, so the operator saw a relaunch notice sitting next to a red step and
// read a working lane as a broken one.
//
// TWO clock defects, both pinned below:
//   (1) the budget check ran at the TOP of the product loop, so a 130-minute
//       budget bought 135.1 minutes of loop — one whole extra product, and a
//       product can be 290k rows.
//   (2) the verify had no cap at all.
//
// These pins are mutation-sensitive. Raise RUN_MINUTES back to 130, drop the
// product reserve, drop the verify cap, or shrink the workflow's
// timeout-minutes, and the margin test fails.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const SCRIPT = read("backend", "scripts", "retire-self-derived-identities.cjs");
const RUNNER = read(".github", "workflows", "backfill-runner.yml");

/** The step that actually runs the script. Its `timeout-minutes` is the
 *  ceiling every lane's budget has to live under — read from the workflow,
 *  never hard-coded here, so shrinking it turns this suite red. */
function stepCeilingMinutes(): number {
  const step = RUNNER.split(/^      - name: /m)
    .find((s) => /^Run backfill \(/.test(s));
  expect(step, "the 'Run backfill' step must exist in backfill-runner.yml").toBeTruthy();
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(step as string);
  expect(m, "the 'Run backfill' step must declare timeout-minutes").toBeTruthy();
  return Number((m as RegExpExecArray)[1]);
}

/** A `const NAME = Number(process.env.X || <literal>)` default from the script. */
function constDefault(name: string): number {
  const re = new RegExp(
    `const ${name} = Number\\(process\\.env\\.[A-Z_]+ \\|\\| ([0-9]+(?:\\s*\\*\\s*[0-9]+)*)\\)`,
  );
  const m = re.exec(SCRIPT);
  expect(m, `${name} must keep a literal default so the margin is computable`).toBeTruthy();
  return (m as RegExpExecArray)[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
}

describe("retire-self-derived-identities — the budget stops under the action ceiling", () => {
  const ceiling = stepCeilingMinutes();
  const runMinutes = constDefault("RUN_MINUTES");
  const reserveMs = constDefault("PRODUCT_RESERVE_MS");
  const verifyMs = constDefault("VERIFY_MS");

  // Measured on run 33960686247: step start 10:27:57 -> loop t0 10:28:16.
  const STARTUP_MINUTES = 1;

  it("the ceiling is read from the workflow, and it is the 150 the run hit", () => {
    expect(ceiling).toBe(150);
  });

  it("worst-case wall clock leaves >= 15 minutes of margin under the step ceiling", () => {
    // The loop can overrun its budget by at most one product, because the
    // pre-check reserves exactly that; then the capped verify; then startup.
    const worstCase =
      runMinutes + reserveMs / 60000 + verifyMs / 60000 + STARTUP_MINUTES;
    const margin = ceiling - worstCase;
    expect(
      margin,
      `worst case ${worstCase}m against a ${ceiling}m ceiling leaves ${margin}m — need >= 15`,
    ).toBeGreaterThanOrEqual(15);
  });

  it("the 130-minute budget that produced the timeout can never come back", () => {
    // 130 + one product + a verify does not fit under 150. The regression is
    // the VALUE, so the pin is on the value.
    expect(runMinutes).toBeLessThanOrEqual(120);
    expect(runMinutes + reserveMs / 60000).toBeLessThan(ceiling - verifyMs / 60000);
  });

  it("(1) the budget check STOPS BEFORE a product, reserving its wall clock", () => {
    // The defect was `if (Date.now() - t0 > BUDGET_MS)` at the top of the
    // loop: it admits one more product of unbounded size after expiry.
    expect(SCRIPT).toContain("Date.now() - t0 > BUDGET_MS - PRODUCT_RESERVE_MS");
    expect(
      SCRIPT,
      "the bare over-budget check is the defect and must not return",
    ).not.toMatch(/Date\.now\(\) - t0 > BUDGET_MS\)/);
  });

  it("(2) the post-loop VERIFY BY READ is hard-capped and reports its own failure", () => {
    expect(SCRIPT).toContain("VERIFY_MS");
    // It must not simply await the two unbounded COUNT(1) scans any more.
    expect(SCRIPT).toMatch(/verify-cap/);
    expect(SCRIPT).toMatch(/could not confirm within the cap/);
    // And an unread count must never be printed as a zero.
    expect(SCRIPT).toMatch(/UNCONFIRMED \(verify cap\)/);
    expect(SCRIPT).toMatch(/UNREAD, not zero/);
  });

  it("the budget marker the runner's relaunch greps for still prints verbatim", () => {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361): the workflow gates on this exact
    // text. Rewording it silently ends the fan-out after one slice.
    expect(SCRIPT).toContain("stopped at the clock budget with products left");
    const relaunch = RUNNER.split(/^      - name: /m)
      .find((s) => /^Self-relaunch the self-derived retire\/label lane/.test(s));
    expect(relaunch, "the retire lane's relaunch step must exist").toBeTruthy();
    expect(relaunch as string).toMatch(/grep -aqE "stopped at the \.\*budget"/);
  });

  it("a multi-budget apply documents its banner sequence, so a relaunch is not read as a failure", () => {
    // The operator gate is the reconciliation plus a green job — NOT the
    // absence of a relaunch notice.
    expect(SCRIPT).toContain("BANNER SEQUENCE OF A MULTI-BUDGET APPLY");
    expect(SCRIPT).toMatch(/GATE ON \(2\) AND \(3\) PLUS A GREEN JOB/);
  });

  it("RUN_MINUTES is spelled the way the sibling lanes spell it", () => {
    // rematch-sold-comps and repair-tiffany-pool-enumeration both read
    // RUN_MINUTES; an operator sizing a fleet should not have to remember
    // which lane wants milliseconds.
    for (const s of ["rematch-sold-comps.cjs", "repair-tiffany-pool-enumeration.cjs"]) {
      expect(read("backend", "scripts", s)).toMatch(/process\.env\.RUN_MINUTES/);
    }
    expect(SCRIPT).toMatch(/process\.env\.RUN_MINUTES/);
  });
});

// ── THE SHARD AXIS IS GUARANTEED AND MEASURED ──────────────────────────────
//
// feedback_shard_axis_must_be_guaranteed_and_measured. The lane shards on
// (year, setKey) with a declared djb2 hash rather than on a row count it
// cannot afford to measure, so the guarantee that has to be proven is that
// the slots PARTITION the product list: every product owned by exactly one
// slot, none owned twice, none dropped.
describe("retire-self-derived-identities — 16 slots partition the product list exactly", () => {
  /** The script's hash and assignment, copied verbatim from the source so a
   *  drift in either shows up as a test failure rather than as a silent
   *  under-sweep. */
  const hash = (str: string) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h;
  };

  it("the hash and the assignment in the test match the ones in the script", () => {
    expect(SCRIPT).toContain("let h = 5381;");
    expect(SCRIPT).toContain("h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;");
    expect(SCRIPT).toContain("hash(`${p.year}|${p.setKey}`) % SLOTS === SLOT");
  });

  // A synthetic product list the shape of the real one: run 33960686247
  // enumerated 6,804 (year, setKey) products for baseball.
  const products: { year: number; setKey: string }[] = [];
  const sets = [
    "topps", "topps-chrome", "bowman", "bowman-chrome", "bowman-draft",
    "topps-heritage", "topps-finest", "panini-prizm", "panini-optic",
    "topps-update-series", "bowman-chrome-sapphire", "topps-allen-and-ginter",
    "topps-stadium-club", "panini-select", "topps-tier-one", "unknown",
  ];
  for (let year = 1952; year <= 2026; year++) {
    for (const setKey of sets) products.push({ year, setKey });
  }

  const assign = (p: { year: number; setKey: string }, slots: number) =>
    hash(`${p.year}|${p.setKey}`) % slots;

  for (const slots of [8, 16, 32]) {
    it(`${slots} slots cover every product exactly once`, () => {
      const seen = new Map<string, number[]>();
      for (let slot = 0; slot < slots; slot++) {
        const mine = products.filter((p) => assign(p, slots) === slot);
        for (const p of mine) {
          const k = `${p.year}|${p.setKey}`;
          seen.set(k, [...(seen.get(k) ?? []), slot]);
        }
      }
      // COMPLETE: nothing dropped.
      expect(seen.size, "every product must be owned by some slot").toBe(products.length);
      // DISJOINT: nothing owned twice.
      const doubled = [...seen.entries()].filter(([, s]) => s.length !== 1);
      expect(doubled, "no product may be owned by two slots").toEqual([]);
    });
  }

  it("the slots are balanced enough that no slot is the whole job", () => {
    // Not a uniformity proof — it is the guard against a hash that collapses.
    // With 1,200 products over 16 slots the mean is 75.
    const counts = Array.from({ length: 16 }, (_, slot) =>
      products.filter((p) => assign(p, 16) === slot).length);
    const mean = products.length / 16;
    for (const c of counts) {
      expect(c, `a slot holding ${c} of ${products.length} is not a shard`).toBeGreaterThan(mean * 0.5);
      expect(c).toBeLessThan(mean * 1.6);
    }
  });

  it("slot 0 of a real fan-out needs SHARD=true, or it sweeps the whole sport", () => {
    // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1765). Without the opt-in
    // slot 0 covers everything and the other fifteen slots redo its work.
    expect(SCRIPT).toContain("SHARD=true is REQUIRED for slot 0");
    expect(SCRIPT).toMatch(/runnerShardScope\(\{ label: "retire-self-derived-identities" \}\)/);
  });
});
