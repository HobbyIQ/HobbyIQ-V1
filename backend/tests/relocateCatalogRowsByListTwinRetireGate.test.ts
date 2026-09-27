/**
 * CF-A-RETIRE-REQUIRES-ITS-TWIN (2026-09-27).
 *
 * PR #2466 justifies each of its 1,869 empty `:no-auto` retires by the
 * presence of a checklist-grade `:auto` twin -- today that justification
 * lives only in the PR description, never checked by the lane itself. This
 * change adds an optional, per-entry `requireTwinId` to the plain `retire`
 * action: when present, the lane point-reads that twin AT THE DELETE CALL
 * (after the existing salesAt dual-check gate passes, before
 * retireCatalogRow is ever reached) and refuses rather than deletes when the
 * twin is absent or not checklist-grade. "Present ≠ checklist-grade" -- a
 * VENDOR or DERIVED row at the twin's address does not justify the retire.
 *
 * This file spawns the REAL script against a fake container, exactly as
 * tests/relocateCatalogRowsByListSalesGate.test.ts does, so the gate is
 * proven end to end -- including that retireCatalogRow is never called on a
 * refusal -- rather than against a unit stub of classifyEntry alone.
 *
 * PINNED, against the real script:
 *
 *   (i)   twin present, checklist-grade  -> RETIRED (APPLY), retireCatalogRow called.
 *   (ii)  twin absent                    -> REFUSED twin-absent, never retired.
 *   (iii) twin present, DERIVED source   -> REFUSED twin-not-checklist-grade, never retired.
 *   (iv)  twin present, VENDOR source    -> REFUSED twin-not-checklist-grade, never retired.
 *   (v)   REPORT mode runs the SAME reads and prints the SAME refusal for
 *         the same fixture as (ii) -- writes nothing (retireCatalogRow never
 *         called either way).
 *   (vi)  an entry with no requireTwinId behaves exactly as before this
 *         change -- twin present or absent is never even read.
 *   (vii) twin lives under Cosmos's own None partition key (no `cardId`,
 *         2.53M live rows) -- a bare (id, id) read must 404 there and the
 *         gate must retry at the None sentinel (lib/catalog-none-pk.cjs)
 *         before calling the twin absent -> RETIRED, found by the retry.
 *   (viii) the twin read THROWS (an unanswered check) -> FAILED, never
 *         reported as twin-absent, retireCatalogRow never called -- the same
 *         rule the pre-existing sales check already enforces.
 *
 * classifyEntry-level pins (loader validation): requireTwinId must be a
 * well-formed hiq id, must not equal the entry's own id, and is refused on a
 * non-retire action.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(backend, "scripts", "relocate-catalog-rows-by-list.cjs");

const L = require_(SCRIPT) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string; to?: string; requireTwinId?: string | null };
};

const RETIRE_ID = "hiq:baseball:2025:bowman-chrome:100:no-auto";
const TWIN_ID = "hiq:baseball:2025:bowman-chrome:100:auto";

// ── classifyEntry (loader) pins ──────────────────────────────────────────

describe("requireTwinId: entry shape is stated, never inferred", () => {
  it("a retire with a well-formed requireTwinId classifies ok and carries it through", () => {
    const r = L.classifyEntry({ id: RETIRE_ID, action: "retire", reason: "empty unsigned twin", requireTwinId: TWIN_ID });
    expect(r.ok).toBe(true);
    expect(r.requireTwinId).toBe(TWIN_ID);
  });

  it("a retire with no requireTwinId classifies ok with requireTwinId null", () => {
    const r = L.classifyEntry({ id: RETIRE_ID, action: "retire", reason: "plain retire" });
    expect(r.ok).toBe(true);
    expect(r.requireTwinId).toBeNull();
  });

  it("requireTwinId must be a well-formed hiq slug", () => {
    const r = L.classifyEntry({ id: RETIRE_ID, action: "retire", reason: "why", requireTwinId: "not-a-hiq-slug" });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/requireTwinId is not a hiq slug/);
  });

  it("requireTwinId must not equal the entry's own id", () => {
    const r = L.classifyEntry({ id: RETIRE_ID, action: "retire", reason: "why", requireTwinId: RETIRE_ID });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/requireTwinId equals the entry's own id/);
  });

  it("requireTwinId is refused on a non-retire action", () => {
    const r = L.classifyEntry({
      id: RETIRE_ID, action: "park", reason: "why", requireTwinId: TWIN_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/requireTwinId is only meaningful on a retire entry/);
  });

  it("an empty-string requireTwinId is treated as absent, not as a malformed slug", () => {
    const r = L.classifyEntry({ id: RETIRE_ID, action: "retire", reason: "why", requireTwinId: "" });
    expect(r.ok).toBe(true);
    expect(r.requireTwinId).toBeNull();
  });
});

// ── end-to-end gate, against the real script + a fake container ─────────

type CatalogRow = { id: string; cardId?: string; playerName?: string; setName?: string; sport?: string; source?: string };

function makeList(dir: string, entries: Array<Record<string, unknown>>): string {
  const file = path.join(dir, "probe-list.json");
  fs.writeFileSync(file, JSON.stringify({ generatedAt: "2026-09-27", forLane: "probe", rulings: [], entries, excluded: [] }));
  return file;
}

/**
 * `twinShape` controls what a point-read of TWIN_ID answers, and now HONOURS
 * the `pk` argument the way a real card_catalog container does -- this is
 * the fix for the finding that the original fake ignored `pk` entirely, so
 * it could never have caught a bare `(id, id)` read misreporting a live
 * None-partition twin as absent:
 *   - "absent": 404 at every pk (no row anywhere)
 *   - "checklist": row lives at (TWIN_ID, TWIN_ID) -- an ordinary cardId'd row
 *   - "derived": as "checklist", but source is a DERIVED source
 *   - "vendor": as "checklist", but source is a VENDOR source
 *   - "none-partition": row does NOT exist at (TWIN_ID, TWIN_ID) -- it 404s
 *     there, exactly like a real cardId-less row -- and exists ONLY at the
 *     SDK's None sentinel pk, checklist-grade. This is the 2.53M-row live
 *     population the finding named: a bare (id, id) guess must fail here,
 *     and the None-pk retry must be what finds it.
 *   - "throws": the FIRST read (at (TWIN_ID, TWIN_ID)) throws a non-404
 *     error -- an unanswered check, which must surface as FAILED, never as
 *     a false "absent".
 * RETIRE_ID itself always resolves at (id, id) (the row being considered for
 * retire) and always shows zero sales by both forms of the dual check, so
 * every case here isolates the twin gate, never the sales gate.
 */
function preload(
  dir: string,
  twinShape: "absent" | "checklist" | "derived" | "vendor" | "not-read" | "none-partition" | "throws",
): { preloadFile: string; callLog: string; twinReadLog: string } {
  const callLog = path.join(dir, "retire-calls.json");
  const twinReadLog = path.join(dir, "twin-reads.json");
  fs.writeFileSync(callLog, "[]");
  fs.writeFileSync(twinReadLog, "[]");
  const file = path.join(dir, "preload.cjs");
  fs.writeFileSync(file, `
const Module = require("node:module");
const fs = require("node:fs");
const realResolve = Module._resolveFilename;

const CALL_LOG = ${JSON.stringify(callLog)};
const TWIN_READ_LOG = ${JSON.stringify(twinReadLog)};
const TWIN_SHAPE = ${JSON.stringify(twinShape)};
const RETIRE_ID = ${JSON.stringify(RETIRE_ID)};
const TWIN_ID = ${JSON.stringify(TWIN_ID)};
// The lane's own None sentinel -- loaded for real (pure logic, no Cosmos
// dependency) so the fake agrees with the lane on exactly which pk value
// means "None partition", the same way a real card_catalog container would.
const { pkOf } = require(${JSON.stringify(path.join(backend, "scripts", "lib", "catalog-none-pk.cjs"))});
const NONE_PK = pkOf({});
function isNonePk(pk) {
  return JSON.stringify(pk) === JSON.stringify(NONE_PK);
}

const twinSource = {
  checklist: "checklistinsider",
  derived: "sold-comps-stub",
  vendor: "cardhedge",
  "none-partition": "checklistinsider",
  absent: null,
  "not-read": null,
  throws: null,
}[TWIN_SHAPE];

const gone = new Set();

function logTwinRead(id) {
  const reads = JSON.parse(fs.readFileSync(TWIN_READ_LOG, "utf8"));
  reads.push(id);
  fs.writeFileSync(TWIN_READ_LOG, JSON.stringify(reads));
}

const container = (name) => ({
  item(id, pk) {
    return {
      read: async () => {
        if (id === TWIN_ID) {
          logTwinRead(id);
          if (TWIN_SHAPE === "throws") {
            throw new Error("probe: twin read threw (simulated Cosmos failure)");
          }
          if (TWIN_SHAPE === "absent" || TWIN_SHAPE === "not-read") {
            const err = new Error("404: not found");
            err.code = 404;
            throw err;
          }
          if (TWIN_SHAPE === "none-partition") {
            // Lives ONLY at the None sentinel -- a bare (id, id) guess (any
            // pk that is NOT the sentinel, including id === pk) must 404.
            if (!isNonePk(pk)) {
              const err = new Error("404: not found");
              err.code = 404;
              throw err;
            }
            return { resource: { id, playerName: "Twin Player", setName: "Twin Set", sport: "baseball", source: twinSource } };
          }
          // Ordinary cardId'd row: lives at (TWIN_ID, TWIN_ID) only.
          if (isNonePk(pk)) {
            const err = new Error("404: not found");
            err.code = 404;
            throw err;
          }
          return { resource: { id, cardId: id, playerName: "Twin Player", setName: "Twin Set", sport: "baseball", source: twinSource } };
        }
        if (gone.has(id)) {
          const err = new Error("404: not found");
          err.code = 404;
          throw err;
        }
        return { resource: { id, cardId: pk, playerName: "Probe", setName: "Probe Set", sport: "baseball", source: "checklistinsider" } };
      },
    };
  },
  items: {
    query: (spec, feedOptions) => {
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => { done = true; return { resources: [] }; },
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
const fakeAuthority = {
  catalogAuthorityOf: (source) => {
    const s = String(source || "").toLowerCase();
    if (s === "cardhedge") return "vendor";
    if (s === "sold-comps-stub") return "derived";
    if (s === "checklistinsider") return "checklist";
    return "unknown";
  },
};
const fakeReconcile = { reportWrites: () => {} };

Module._resolveFilename = function (request, ...rest) {
  if (request === "@azure/cosmos") return "FAKE_COSMOS";
  if (request.includes("catalogRowOps.service")) return "FAKE_OPS";
  if (request.includes("catalogAuthority.service")) return "FAKE_AUTHORITY";
  if (request.includes("writeReconciliation")) return "FAKE_RECONCILE";
  return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/cosmos") return fakeCosmos;
  if (request.includes("catalogRowOps.service")) return fakeOps;
  if (request.includes("catalogAuthority.service")) return fakeAuthority;
  if (request.includes("writeReconciliation")) return fakeReconcile;
  return realLoad.call(this, request, ...rest);
};
`);
  return { preloadFile: file, callLog, twinReadLog };
}

function runLane(
  entries: Array<Record<string, unknown>>,
  twinShape: "absent" | "checklist" | "derived" | "vendor" | "not-read" | "none-partition" | "throws",
  apply: boolean,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-twingate-"));
  const list = makeList(dir, entries);
  const { preloadFile, callLog, twinReadLog } = preload(dir, twinShape);
  const r = spawnSync(process.execPath, ["--require", preloadFile, SCRIPT], {
    encoding: "utf8",
    timeout: 30000,
    killSignal: "SIGKILL",
    cwd: backend,
    env: {
      ...process.env,
      SCOPE: list,
      BACKFILL_APPLY: apply ? "true" : "",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://probe/;AccountKey=probe==;",
    },
  });
  const retireCalls: string[] = JSON.parse(fs.readFileSync(callLog, "utf8"));
  const twinReads: string[] = JSON.parse(fs.readFileSync(twinReadLog, "utf8"));
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { stdout, stderr, output: `${stdout}\n${stderr}`, status: r.status, retireCalls, twinReads };
}

function entry(requireTwinId?: string) {
  const e: Record<string, unknown> = { id: RETIRE_ID, action: "retire", reason: "probe: twin gate", evidence: "probe" };
  if (requireTwinId !== undefined) e.requireTwinId = requireTwinId;
  return e;
}

describe("the retire twin gate is a GATE, not a caveat", () => {
  it("(i) twin present, checklist-grade -> RETIRED, retireCatalogRow called", () => {
    const res = runLane([entry(TWIN_ID)], "checklist", true);
    expect(res.retireCalls).toEqual([RETIRE_ID]);
    expect(res.output).not.toMatch(/twin-absent|twin-not-checklist-grade/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  it("(ii) twin absent -> REFUSED twin-absent, retireCatalogRow never called", () => {
    const res = runLane([entry(TWIN_ID)], "absent", true);
    expect(res.retireCalls, "retireCatalogRow must not run when the twin is absent").toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(twin-absent\)/);
    expect(res.stdout).toMatch(/refused — twin absent\s+1\b/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  it("(iii) twin present but DERIVED authority -> REFUSED twin-not-checklist-grade, never retired", () => {
    const res = runLane([entry(TWIN_ID)], "derived", true);
    expect(res.retireCalls).toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(twin-not-checklist-grade, authority=derived\)/);
    expect(res.stdout).toMatch(/refused — twin not checklist-grade\s+1\b/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  it("(iii-b) twin present but VENDOR authority -> REFUSED twin-not-checklist-grade, never retired", () => {
    const res = runLane([entry(TWIN_ID)], "vendor", true);
    expect(res.retireCalls).toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(twin-not-checklist-grade, authority=vendor\)/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  it("(v) REPORT mode runs the same reads and prints the same refusal as APPLY -- writes nothing", () => {
    const report = runLane([entry(TWIN_ID)], "absent", false);
    const apply = runLane([entry(TWIN_ID)], "absent", true);
    expect(report.retireCalls).toHaveLength(0);
    expect(apply.retireCalls).toHaveLength(0);
    // The twin point-read happened in BOTH modes -- REPORT is not a no-op on
    // the read side, only on the write side. Two entries each: the (id, id)
    // guess 404s, then the gate retries once at the None sentinel before
    // calling the twin genuinely absent -- both attempts are logged.
    expect(report.twinReads).toEqual([TWIN_ID, TWIN_ID]);
    expect(apply.twinReads).toEqual([TWIN_ID, TWIN_ID]);
    expect(report.output).toMatch(/REFUSED \(twin-absent\)/);
    expect(apply.output).toMatch(/REFUSED \(twin-absent\)/);
    expect(report.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
    expect(apply.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 1 \+ failed 0 \+ not reached 0/);
    expect(report.output).not.toContain("FATAL");
    expect(apply.output).not.toContain("FATAL");
    expect(report.status).toBe(0);
    expect(apply.status).toBe(0);
  });

  it("(vi) an entry with no requireTwinId never reads the twin at all -- unchanged behaviour", () => {
    const res = runLane([entry()], "not-read", true);
    expect(res.twinReads, "no requireTwinId means the twin is never read").toHaveLength(0);
    expect(res.retireCalls).toEqual([RETIRE_ID]);
    expect(res.output).not.toMatch(/twin-absent|twin-not-checklist-grade/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  /**
   * (vii) THE FINDING THIS FILE WAS EXTENDED TO CLOSE. A bare `(id, id)`
   * point-read 404s on every one of the 2.53M live card_catalog rows that
   * carry no `cardId` -- they live at Cosmos's own None partition key
   * instead (lib/catalog-none-pk.cjs). A twin belonging to that population
   * must still be found: the gate retries at the None sentinel before
   * calling the twin absent, exactly the way repoint-sales-by-list.cjs's own
   * `catalogRowAt` already does for a blind id.
   */
  it("(vii) twin lives under the None partition (no cardId) -> RETIRED, found by the None-pk retry", () => {
    const res = runLane([entry(TWIN_ID)], "none-partition", true);
    expect(res.retireCalls).toEqual([RETIRE_ID]);
    // Both attempts are visible in the read log: the (id, id) guess that
    // 404'd, then the None-pk retry that found it.
    expect(res.twinReads).toEqual([TWIN_ID, TWIN_ID]);
    expect(res.output).not.toMatch(/twin-absent|twin-not-checklist-grade/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });

  /**
   * (viii) An unanswered twin read must never be read as "absent" -- the
   * same rule the pre-existing sales check enforces. `retireCatalogRow` must
   * never be reached on a check that never actually answered.
   */
  it("(viii) the twin read THROWS -> FAILED, retireCatalogRow never called, never reported as twin-absent", () => {
    const res = runLane([entry(TWIN_ID)], "throws", true);
    expect(res.retireCalls, "an unanswered twin read must never be a green light to delete").toHaveLength(0);
    expect(res.output).toMatch(/FAILED: twin read threw/);
    expect(res.output).not.toMatch(/REFUSED \(twin-absent\)/);
    expect(res.output).not.toMatch(/REFUSED \(twin-not-checklist-grade/);
    expect(res.stdout).toMatch(/reconciled: intended 1 = written 0 \+ skipped 0 \+ refused 0 \+ failed 1 \+ not reached 0/);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
    expect(res.output).not.toContain("FATAL");
    expect(res.status).toBe(0);
  });
});
