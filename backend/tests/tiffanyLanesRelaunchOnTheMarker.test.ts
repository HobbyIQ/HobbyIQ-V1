/**
 * CF-RELAUNCH-ONLY-ON-BUDGET, for the two Tiffany repair lanes.
 *
 * #1745 (repair-tiffany-rung-to-product) and #1752
 * (repair-tiffany-pool-enumeration) both shipped a budget stop that PRINTS
 *
 *     stopped at the 140-minute budget — the relaunch continues from here
 *
 * and neither shipped the relaunch step that makes the second half of that
 * sentence true. A slot that ran out of budget stopped after one cycle,
 * exited 0, reconciled honestly, and left the rest of its shard unswept with
 * nothing in the run saying so — the exact "green run is not a data flow"
 * shape, one level up: the arithmetic closed, the FLEET did not.
 *
 * everyWriteJobReconciles pins the CONTRACT statically (a marker-printer has a
 * marker-keyed relaunch step). This file pins the two halves that a static
 * grep cannot see, by driving the COMMITTED scripts through a stubbed Cosmos:
 *
 *   1. the script really does print the marker when it runs out of budget,
 *      and really does NOT print it when it finishes inside one — a relaunch
 *      keyed on a marker that always printed would loop forever, and one
 *      keyed on a marker that never printed would never fire;
 *   2. the marker is MODE-BLIND and mode-blind in report mode too
 *      (CF-REPORT-RELAUNCHES-AS-A-REPORT, D34), because the runner's gate
 *      carries no `inputs.apply` and a report that stops at its budget must be
 *      able to finish;
 *   3. the counter the relaunch step greps for its ::notice:: is on stdout in
 *      the shape the step's regex reads.
 *
 * Nothing here writes: both lanes are driven REPORT-ONLY (no *_APPLY), so the
 * stub's write verbs are never reached and the assertions are about the two
 * things the runner actually consumes — the marker and the counter.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
const SCRIPTS: Record<Lane, string> = {
  rung: path.join(backend, "scripts", "repair-tiffany-rung-to-product.cjs"),
  pool: path.join(backend, "scripts", "repair-tiffany-pool-enumeration.cjs"),
};
type Lane = "rung" | "pool";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiffany-relaunch-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A Tiffany rung row, in both containers' shapes. The slug carries the
 *  `:tiffany:` segment that makes it a rung, and the title STATES Tiffany so
 *  the lane's own title guard does not classify it away before it is counted. */
const rungRow = (n: number) => ({
  id: `hiq:baseball:1987:topps:${n}:tiffany:no-auto`,
  cardId: `hiq:baseball:1987:topps:${n}:tiffany:no-auto`,
  hobbyiqCardId: `hiq:baseball:1987:topps:${n}:tiffany:no-auto`,
  sport: "baseball", year: 1987, setKey: "topps", cardNumber: String(n),
  parallel: "Tiffany", title: `1987 Topps Baseball #${n} Tiffany`,
  price: 10, soldAt: "2026-05-01T00:00:00Z",
  gradeCompany: null, gradeValue: null, isAuto: false,
  source: "test-fixture",
});

/**
 * Just enough @azure/cosmos for both lanes, injected with --require so the
 * COMMITTED script is what runs. Every query the lanes issue is a COUNT or a
 * SELECT *; a COUNT answers 1 so the sibling gates pass and the rows reach the
 * budget check, which is the only thing under test.
 */
function shim(rows: number): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const ROWS = ${JSON.stringify(Array.from({ length: rows }, (_, i) => rungRow(i + 1)))};
const isCount = (q) => /COUNT\\(1\\)/i.test(q);
const container = (name) => ({
  item: (id) => ({
    read: async () => ({ resource: ROWS.find((r) => r.id === id) ?? null }),
    patch: async () => ({ resource: {} }),
    delete: async () => ({}),
  }),
  items: {
    upsert: async (doc) => ({ resource: doc }),
    create: async (doc) => ({ resource: doc }),
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      // A COUNT is a gate (does the sibling product exist / how many rows):
      // answering 1 keeps every row on the path that reaches the budget check.
      const resources = isCount(q) ? [1] : ROWS;
      return {
        fetchAll: async () => ({ resources }),
        fetchNext: async () => ({ resources, continuationToken: undefined }),
      };
    },
  },
});
const stub = { CosmosClient: class { database() { return { container }; } } };
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  if (String(request).includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

function drive(lane: Lane, env: Record<string, string>, rows = 40) {
  try {
    const out = execFileSync(process.execPath, [SCRIPTS[lane]], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim(rows))}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

/** The runner's own gate, read off the yml rather than restated here, so this
 *  file cannot drift from the step it is pinning. */
const MARKER_GREP = /stopped at the .*budget/;
/** The runner's ::notice:: counter, as the step greps it. */
const COUNTER_GREP = /^ {2}rows scanned \(this slot\) +[\d,]+/m;

const LANES: Array<{ lane: Lane; script: string; mode: string }> = [
  { lane: "rung", script: "repair-tiffany-rung-to-product", mode: "catalog" },
  { lane: "pool", script: "repair-tiffany-pool-enumeration", mode: "pool" },
];

describe("the Tiffany lanes print the marker the runner relaunches on", () => {
  for (const { lane, script, mode } of LANES) {
    // RUN_MINUTES=0 makes the budget expire on the first batch: the script
    // stops for the one reason the relaunch exists to continue from.
    it(`${script}: a budget stop prints the marker`, () => {
      const r = drive(lane, { MODE: mode, RUN_MINUTES: "0" });
      expect(r.code, r.out.slice(-600)).toBe(0);
      expect(r.out, "the runner relaunches on this line and on nothing else").toMatch(MARKER_GREP);
      // Mode-blind (D34): a REPORT that runs out of budget must be able to
      // finish, so the marker is printed with no *_APPLY set.
      expect(r.out).toMatch(/REPORT ONLY/);
    });

    it(`${script}: finishing inside the budget prints NO marker — the loop terminates`, () => {
      // The other half of the gate, and the one a marker printed
      // unconditionally would break: an always-marker relaunches forever.
      const r = drive(lane, { MODE: mode, RUN_MINUTES: "600" });
      expect(r.code, r.out.slice(-600)).toBe(0);
      expect(r.out, "a lane that drained inside its budget must not re-dispatch").not.toMatch(MARKER_GREP);
    });

    it(`${script}: prints the scanned counter the relaunch step greps`, () => {
      const r = drive(lane, { MODE: mode, RUN_MINUTES: "600" });
      expect(r.out, "the ::notice:: reads this line; a moved counter makes it print scanned=0").toMatch(COUNTER_GREP);
    });
  }
});

describe("the runner has a marker-keyed relaunch step for each Tiffany lane", () => {
  const yml = () => fs.readFileSync(RUNNER, "utf8");
  /** The step block that fires for `script`, split the way the runner's own
   *  pins split it. */
  function stepFor(script: string): string | undefined {
    return yml().split(/\n(?=      - name:)/)
      .find((s) => /gh workflow run backfill-runner\.yml/.test(s) && s.includes(`inputs.script == '${script}'`));
  }

  for (const { script, mode } of LANES) {
    it(`${script}: relaunches, keyed on the marker and never on a count`, () => {
      const step = stepFor(script);
      expect(step, `no relaunch step re-dispatches ${script} — a budget stop ends the fleet, green`).toBeDefined();
      expect(step!, "the gate must be the marker").toMatch(MARKER_GREP);
      expect(step!, "#1361: never relaunch a cancel").toContain("!cancelled()");
      // D34: mode-blind. A report that stops at its budget can never finish if
      // its relaunch is gated on apply.
      const gate = /^\s*if:\s*(.*)$/m.exec(step!)?.[1] ?? "";
      expect(gate, "a report that runs out of budget must relaunch too").not.toMatch(/inputs\.apply/);
    });

    it(`${script}: forwards apply verbatim — a report comes back a report`, () => {
      const forwards = [...stepFor(script)!.matchAll(/-f apply=("[^"]*"|\S+)/g)].map((m) => m[1]);
      expect(forwards, "#1578: a hardcoded apply turns a report into a write nobody dispatched")
        .toEqual(['"${{ inputs.apply }}"']);
    });

    it(`${script}: forwards MODE, which the script REQUIRES and never defaults`, () => {
      // Both lanes exit 2 without a MODE rather than choosing a population, so
      // a continuation that dropped it would die at once instead of resuming.
      expect(drive(mode === "catalog" ? "rung" : "pool", { RUN_MINUTES: "600" }).code)
        .toBe(2);
      expect(stepFor(script)!).toContain('-f mode="${{ inputs.mode }}"');
    });

    it(`${script}: forwards parents_only, which carries the shard opt-in`, () => {
      // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756): SHARD rides
      // `parents_only` for exactly these two scripts. Dropping it on the
      // continuation silently widens a 1/16th shard into a full sweep.
      expect(yml(), "the opt-in still rides parents_only for this lane")
        .toMatch(new RegExp(`SHARD:[^\\n]*${script}`));
      expect(stepFor(script)!, "the continuation must keep the shard it was dispatched as")
        .toContain('-f parents_only="${{ inputs.parents_only }}"');
    });
  }
});
