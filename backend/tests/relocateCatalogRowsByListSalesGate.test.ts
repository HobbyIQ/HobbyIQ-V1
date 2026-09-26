/**
 * CF-A-RETIRE-NEEDS-ZERO-SALES-BY-BOTH-FORMS (review finding, 2026-09-26).
 *
 * PR #2436 added the dual cross-partition + partition-scoped sales check
 * (lib/sales-at-id.cjs) but the retire action only used its count for a log
 * line and the `salesUnplaced` stat -- `retireCatalogRow` ran regardless,
 * and `salesAt` swallowed a query throw into `null`. This file pins the fix:
 * the sales check is now a real GATE on the retire branch, spawning the real
 * lane against a fake container exactly as
 * tests/relocateCatalogRowsByListBudget.test.ts does, so the gate is proven
 * end to end rather than against a unit stub.
 *
 * WHAT IS PINNED, against the real script under a fake container:
 *
 *   (i)   sales visible ONLY to the partition-scoped form -> REFUSED, never
 *         retired -- reproduces the PR's own anomaly (a real sold_comps doc
 *         a bare cross-partition query missed).
 *   (ii)  sales visible ONLY cross-partition -> REFUSED, never retired.
 *   (iii) both forms answer zero -> RETIRED.
 *   (iv)  the sales query THROWS -> FAILED, and retireCatalogRow is never
 *         called (proven by the fake's own call-count assertion, not just
 *         by the entry's outcome).
 *
 * MUTATION CHECK (last describe): the SAME fixture as (i), run with the
 * pre-fix gate removed (a probe that goes straight to retireCatalogRow the
 * way the code was before this fix), retires the row anyway -- i.e. this
 * pin fails against the code as it was when PR #2436 first went up.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(backend, "scripts", "relocate-catalog-rows-by-list.cjs");

const RETIRE_ID = "hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto";
const ANOMALY_SALE_ID = "ebay-user-purchase::147344007201-10082410797719";

function makeList(dir: string, id: string): string {
  const entries = [{ id, action: "retire", reason: "probe: sales gate", evidence: "probe" }];
  const file = path.join(dir, "probe-list.json");
  fs.writeFileSync(file, JSON.stringify({ generatedAt: "2026-09-26", forLane: "probe", rulings: [], entries, excluded: [] }));
  return file;
}

/**
 * `salesShape` controls what each of the two query forms answers for
 * RETIRE_ID:
 *   - "pk-only": partition-scoped finds the anomaly row, cross-partition finds nothing
 *   - "xp-only": cross-partition finds a row, partition-scoped finds nothing
 *   - "both-zero": neither form finds anything
 *   - "throws": the query throws before either form answers
 *
 * A call-count file tracks whether retireCatalogRow was ever invoked, so
 * "never retired" is proven by the fake's own record, not only by the
 * absence of a RETIRED line in stdout.
 */
function preload(dir: string, salesShape: "pk-only" | "xp-only" | "both-zero" | "throws", legacyNoGate: boolean): string {
  const callLog = path.join(dir, "retire-calls.json");
  fs.writeFileSync(callLog, "[]");
  const file = path.join(dir, "preload.cjs");
  fs.writeFileSync(file, `
const Module = require("node:module");
const fs = require("node:fs");
const realResolve = Module._resolveFilename;

const CALL_LOG = ${JSON.stringify(callLog)};
const SALES_SHAPE = ${JSON.stringify(salesShape)};
const RETIRE_ID = ${JSON.stringify(RETIRE_ID)};

const container = (name) => ({
  item(id, pk) {
    return { read: async () => ({ resource: { id, cardId: pk, playerName: "Probe", setName: "Probe Set", sport: "baseball" } }) };
  },
  // Distinguishes the cross-partition form (no partitionKey in feedOptions)
  // from the partition-scoped form (partitionKey present) -- exactly the
  // two forms lib/sales-at-id.cjs issues.
  items: {
    query: (spec, feedOptions) => {
      const scoped = Boolean(feedOptions && feedOptions.partitionKey !== undefined);
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => {
          done = true;
          if (SALES_SHAPE === "throws") {
            throw new Error("probe: sales query threw (simulated Cosmos failure)");
          }
          if (SALES_SHAPE === "both-zero") return { resources: [] };
          if (SALES_SHAPE === "pk-only") return { resources: scoped ? [{ id: "${ANOMALY_SALE_ID}" }] : [] };
          if (SALES_SHAPE === "xp-only") return { resources: scoped ? [] : [{ id: "sale-xp-1" }] };
          return { resources: [] };
        },
        // confirmRetired's id-lookup query (post-delete verify) -- the row
        // is always gone by the time this fires in the (iii) case, since
        // retireCatalogRow below deletes synchronously into \`gone\`.
        fetchAll: async () => {
          const p = (spec && spec.parameters) || [];
          const q = String((spec && spec.query) || "");
          if (/SELECT c\\.id FROM c WHERE c\\.id = @id/.test(q)) {
            const id = (p.find((x) => x.name === "@id") || {}).value;
            return { resources: gone.has(id) ? [] : [{ id }] };
          }
          return { resources: [] };
        },
      };
    },
  },
});
const gone = new Set();
const fakeCosmos = {
  CosmosClient: class {
    constructor() {}
    database() { return { container: (n) => container(n) }; }
    dispose() {}
  },
};
const fakeOps = {
  retireCatalogRow: async (c, id) => {
    const calls = JSON.parse(fs.readFileSync(CALL_LOG, "utf8"));
    calls.push(id);
    fs.writeFileSync(CALL_LOG, JSON.stringify(calls));
    gone.add(id);
    return { action: "retire", rowDeleted: true, gradedChildrenRetired: 0 };
  },
  moveCatalogRow: async () => { throw new Error("fakeOps.moveCatalogRow: not exercised by this probe"); },
  patchCatalogRowFields: async () => { throw new Error("fakeOps.patchCatalogRowFields: not exercised by this probe"); },
  rebuildSearchFields: (row) => ({ searchText: "", searchTokens: [], displayName: String(row && row.playerName || "") }),
  parseSlugWithGrade: () => null,
};
const fakeReconcile = { reportWrites: () => {} };

${legacyNoGate ? `
// ── THE MUTATION: pre-fix behaviour ─────────────────────────────────────
// salesAtId still answers correctly, but the retire branch's gate is
// removed by making salesAt's caller ignore the count entirely -- the
// shape of the defect this PR fixes (count computed, never consulted).
const salesAtIdLib = require(require("node:path").join(${JSON.stringify(backend)}, "scripts", "lib", "sales-at-id.cjs"));
const realSalesAtId = salesAtIdLib.salesAtId;
salesAtIdLib.salesAtId = async (...args) => {
  const res = await realSalesAtId(...args);
  return { ...res, total: 0, xp: 0, pk: 0 }; // pre-fix: the caller never saw the real count
};
` : ""}

Module._resolveFilename = function (request, ...rest) {
  if (request === "@azure/cosmos") return "FAKE_COSMOS";
  if (request.includes("catalogRowOps.service")) return "FAKE_OPS";
  if (request.includes("writeReconciliation")) return "FAKE_RECONCILE";
  return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/cosmos") return fakeCosmos;
  if (request.includes("catalogRowOps.service")) return fakeOps;
  if (request.includes("writeReconciliation")) return fakeReconcile;
  return realLoad.call(this, request, ...rest);
};
`);
  return { preloadFile: file, callLog };
}

function runLane(salesShape: "pk-only" | "xp-only" | "both-zero" | "throws", legacyNoGate = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-salesgate-"));
  const list = makeList(dir, RETIRE_ID);
  const { preloadFile, callLog } = preload(dir, salesShape, legacyNoGate);
  const r = spawnSync(process.execPath, ["--require", preloadFile, SCRIPT], {
    encoding: "utf8",
    timeout: 30000,
    killSignal: "SIGKILL",
    cwd: backend,
    env: {
      ...process.env,
      SCOPE: list,
      BACKFILL_APPLY: "true",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://probe/;AccountKey=probe==;",
    },
  });
  const retireCalls: string[] = JSON.parse(fs.readFileSync(callLog, "utf8"));
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  // REFUSED/FAILED lines are console.error (stderr); the banner and its
  // reconcile line are console.log (stdout). Assertions below check the
  // combined stream so neither channel hides the outcome.
  return { stdout, stderr, output: `${stdout}\n${stderr}`, status: r.status, retireCalls };
}

describe("the retire sales check is a GATE, not a log line", () => {
  it("(i) sales visible ONLY to the partition-scoped form -> REFUSED, retireCatalogRow never called", () => {
    const res = runLane("pk-only");
    expect(res.retireCalls, "retireCatalogRow must not run when the pk-scoped form finds a sale").toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(sales present, n=1\)/);
    expect(res.stdout).toContain("sales at id: xp=0 pk=1");
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
  });

  it("(ii) sales visible ONLY cross-partition -> REFUSED, retireCatalogRow never called", () => {
    const res = runLane("xp-only");
    expect(res.retireCalls).toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(sales present, n=1\)/);
    expect(res.stdout).toContain("sales at id: xp=1 pk=0");
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
  });

  it("(iii) both forms answer zero -> RETIRED", () => {
    const res = runLane("both-zero");
    expect(res.retireCalls).toEqual([RETIRE_ID]);
    expect(res.stdout).toContain("sales at id: xp=0 pk=0");
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
  });

  it("(iv) the sales query THROWS -> FAILED, retireCatalogRow never called", () => {
    const res = runLane("throws");
    expect(res.retireCalls, "an unanswered sales check must never be treated as a green light to delete").toHaveLength(0);
    expect(res.output).toMatch(/FAILED: sales check threw/);
    expect(res.output).not.toMatch(/REFUSED \(sales present/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 0 \+ failed 1 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
  });
});

describe("MUTATION: a gate that computes the count but never consults it retires anyway", () => {
  it("the same (i) fixture, with the gate short-circuited, retires the row -- proving the pin above is real", () => {
    const res = runLane("pk-only", /* legacyNoGate */ true);
    // This is the exact shape of the bug the review found: salesAtId is
    // still called (so a caller inspecting logs might believe it was
    // checked), but the count reaching the retire branch is forced to zero,
    // so the row is deleted despite the pk-scoped sale.
    expect(res.retireCalls).toEqual([RETIRE_ID]);
    expect(res.output).not.toMatch(/REFUSED \(sales present/);
  });
});
