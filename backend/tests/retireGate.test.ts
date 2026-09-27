/**
 * LANE-SAFETY (2026-09-27) -- gates every remaining catalog RETIRE (hard
 * delete) path on the dual sales check, matching #2436's gate on
 * relocate-catalog-rows-by-list.cjs's `retire` action.
 *
 * TWO THINGS ARE PINNED HERE:
 *
 *   1. scripts/lib/assert-retire-legal.cjs -- the shared helper every
 *      one-off retire-*.cjs script's future callers can reach for: (a) a
 *      checklist-grade twin must exist at the canonical id (a derived twin
 *      is refused; doctrine: never retire a checklist row in favour of a
 *      derived one), and (b) zero sales by BOTH read forms (lib/sales-at-id
 *      .cjs's dual cross-partition + partition-scoped union).
 *
 *   2. relocate-catalog-rows-by-list.cjs's COMPLETE MOVE retire path -- the
 *      retire that follows a successful move, previously the one branch in
 *      this file that called retireCatalogRow with NO gate at all (neither
 *      the sales check the sibling `retire` action runs, nor a twin-
 *      authority check on the destination it is completing onto). Spawned
 *      against a fake container exactly as
 *      tests/relocateCatalogRowsByListSalesGate.test.ts does for the
 *      sibling `retire` action, so the fix is proven end to end.
 *
 * MUTATION CHECKS (last describe in each half): re-run the same fixture with
 * the new gate short-circuited, and assert the row is retired anyway -- i.e.
 * each pin fails against the code as it was before this PR.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const SCRIPT = path.join(backend, "scripts", "relocate-catalog-rows-by-list.cjs");

// ── PART 1: scripts/lib/assert-retire-legal.cjs, unit level ────────────────

type Row = { id: string; cardId?: string; hobbyiqCardId?: string };
type QuerySpec = { query: string; parameters?: Array<{ name: string; value: unknown }> };
type FeedOptions = { maxItemCount?: number; maxDegreeOfParallelism?: number; partitionKey?: unknown };

type AssertRetireLegal = (
  containers: { cat: unknown; pool: unknown },
  opts: {
    id: string;
    canonicalId?: string;
    canonicalPk?: string;
    requireTwin?: boolean;
    catalogAuthorityOf?: (source: string | null | undefined) => string;
    retry?: (fn: () => unknown) => unknown;
  },
) => Promise<{ ok: boolean; reason: string; salesCount: number | null; twinAuthority?: string }>;

const lib = require_(path.join(backend, "scripts", "lib", "assert-retire-legal.cjs")) as {
  assertRetireLegal: AssertRetireLegal;
};

/** A trivial classifier standing in for catalogAuthorityOf, so the unit
 *  tests below do not depend on the built dist/ tree existing. */
const fakeAuthorityOf = (source: string | null | undefined): string => {
  const s = String(source ?? "");
  if (s === "checklist-source") return "checklist";
  if (s === "derived-source") return "derived";
  return "unknown";
};

function fakePool(opts: { crossPartitionVisible: Row[]; partitionScopedVisible: Row[] }) {
  const query = (spec: QuerySpec, feedOptions?: FeedOptions) => {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const target = p["@id"];
    const source = feedOptions && feedOptions.partitionKey !== undefined
      ? opts.partitionScopedVisible
      : opts.crossPartitionVisible;
    const rows = source.filter((r) => r.hobbyiqCardId === target || r.cardId === target).map((r) => ({ id: r.id }));
    let done = false;
    return {
      hasMoreResults: () => !done,
      fetchNext: async () => { done = true; return { resources: rows }; },
    };
  };
  return { items: { query } };
}

function fakeCat(rowsById: Record<string, { source: string } | null>) {
  return {
    item(id: string, _pk?: string) {
      return {
        read: async () => {
          const row = rowsById[id];
          if (!row) { const e: any = new Error("404"); e.code = 404; throw e; }
          return { resource: row };
        },
      };
    },
  };
}

describe("assertRetireLegal -- the shared gate", () => {
  it("refuses when sales are present via the cross-partition form alone", async () => {
    const pool = fakePool({ crossPartitionVisible: [{ id: "s1", cardId: "victim" }], partitionScopedVisible: [] });
    const cat = fakeCat({ canon: { source: "checklist-source" } });
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sales-present");
    expect(res.salesCount).toBe(1);
  });

  it("refuses when sales are present via the partition-scoped form alone", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [{ id: "s1", cardId: "victim" }] });
    const cat = fakeCat({ canon: { source: "checklist-source" } });
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sales-present");
    expect(res.salesCount).toBe(1);
  });

  it("refuses when there is no twin row at the canonical id", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const cat = fakeCat({}); // canon 404s
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-twin-at-canonical-id");
  });

  it("refuses when the twin at the canonical id is DERIVED, not checklist-grade", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const cat = fakeCat({ canon: { source: "derived-source" } });
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("twin-not-checklist-grade");
    expect(res.twinAuthority).toBe("derived");
  });

  it("allows the retire when a checklist-grade twin exists AND zero sales by both forms", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const cat = fakeCat({ canon: { source: "checklist-source" } });
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("clear");
    expect(res.salesCount).toBe(0);
    expect(res.twinAuthority).toBe("checklist");
  });

  it("skips the twin check when requireTwin is false (a junk-row purge with no canonical destination)", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const cat = fakeCat({}); // would 404 if read -- must never be reached
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", requireTwin: false, catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(true);
    expect(res.twinAuthority).toBeUndefined();
  });

  it("never swallows a sales-check throw into a green light", async () => {
    const pool = {
      items: {
        query: () => ({
          hasMoreResults: () => true,
          fetchNext: async () => { throw new Error("probe: sales query threw"); },
        }),
      },
    };
    const cat = fakeCat({ canon: { source: "checklist-source" } });
    const res = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sales-check-threw");
  });

  it("MUTATION: a gate that skips the twin check entirely would wrongly license a derived-twin retire", async () => {
    const pool = fakePool({ crossPartitionVisible: [], partitionScopedVisible: [] });
    const cat = fakeCat({ canon: { source: "derived-source" } });
    const withTwinCheck = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", catalogAuthorityOf: fakeAuthorityOf,
    });
    const withoutTwinCheck = await lib.assertRetireLegal({ cat, pool }, {
      id: "victim", canonicalId: "canon", requireTwin: false, catalogAuthorityOf: fakeAuthorityOf,
    });
    expect(withTwinCheck.ok).toBe(false);
    expect(withoutTwinCheck.ok).toBe(true);
    expect(withTwinCheck.ok).not.toBe(withoutTwinCheck.ok);
  });
});

// ── PART 2: relocate-catalog-rows-by-list.cjs's COMPLETE MOVE retire ───────

const SOURCE_ID = "hiq:baseball:2026:topps:base:no-auto";
const DEST_ID = "hiq:baseball:2026:topps-chrome:base:no-auto";
const ANOMALY_SALE_ID = "ebay-user-purchase::147344007201-10082410797719";

function makeReslugList(dir: string): string {
  const entries = [{ id: SOURCE_ID, to: DEST_ID, action: "reslug", reason: "probe: complete-move gate", evidence: "probe" }];
  const file = path.join(dir, "probe-list.json");
  fs.writeFileSync(file, JSON.stringify({ generatedAt: "2026-09-27", forLane: "probe", rulings: [], entries, excluded: [] }));
  return file;
}

type SalesShape = "pk-only" | "xp-only" | "both-zero" | "throws";
type DestAuthority = "checklist" | "derived";

/**
 * Preloads a fake @azure/cosmos, catalogRowOps, catalogAuthority and
 * writeReconciliation module so the real script runs end to end against a
 * scripted world: `to` already holds a row stamped movedFrom = SOURCE_ID
 * (the COMPLETE MOVE precondition), whose `source` field drives the twin
 * check, and whose sales-at-the-source visibility is controlled exactly the
 * way relocateCatalogRowsByListSalesGate.test.ts does for the `retire`
 * action.
 */
function preload(dir: string, salesShape: SalesShape, destAuthority: DestAuthority, legacyNoGate: boolean) {
  const callLog = path.join(dir, "retire-calls.json");
  fs.writeFileSync(callLog, "[]");
  const file = path.join(dir, "preload.cjs");
  fs.writeFileSync(file, `
const Module = require("node:module");
const fs = require("node:fs");
const realResolve = Module._resolveFilename;

const CALL_LOG = ${JSON.stringify(callLog)};
const SALES_SHAPE = ${JSON.stringify(salesShape)};
const DEST_AUTHORITY = ${JSON.stringify(destAuthority)};
const SOURCE_ID = ${JSON.stringify(SOURCE_ID)};
const DEST_ID = ${JSON.stringify(DEST_ID)};

const gone = new Set();
const container = (name) => ({
  item(id, pk) {
    return {
      read: async () => {
        if (id === DEST_ID) {
          // The COMPLETE MOVE precondition: the destination already holds a
          // row stamped movedFrom = SOURCE_ID.
          return { resource: { id: DEST_ID, cardId: pk, source: DEST_AUTHORITY === "checklist" ? "checklistinsider" : "catalog-explode-actuals-2026-08-12", movedFrom: SOURCE_ID, playerName: "Probe", setName: "Probe Set", sport: "baseball" } };
        }
        return { resource: { id, cardId: pk, playerName: "Probe", setName: "Probe Set", sport: "baseball" } };
      },
    };
  },
  items: {
    query: (spec, feedOptions) => {
      const scoped = Boolean(feedOptions && feedOptions.partitionKey !== undefined);
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => {
          done = true;
          if (SALES_SHAPE === "throws") throw new Error("probe: sales query threw (simulated Cosmos failure)");
          if (SALES_SHAPE === "both-zero") return { resources: [] };
          if (SALES_SHAPE === "pk-only") return { resources: scoped ? [{ id: "${ANOMALY_SALE_ID}" }] : [] };
          if (SALES_SHAPE === "xp-only") return { resources: scoped ? [] : [{ id: "sale-xp-1" }] };
          return { resources: [] };
        },
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
  moveCatalogRow: async () => { throw new Error("fakeOps.moveCatalogRow: not exercised by this probe -- COMPLETE MOVE never reaches it"); },
  patchCatalogRowFields: async () => { throw new Error("fakeOps.patchCatalogRowFields: not exercised by this probe"); },
  rebuildSearchFields: (row) => ({ searchText: "", searchTokens: [], displayName: String(row && row.playerName || "") }),
  parseSlugWithGrade: () => null,
};
const fakeAuthority = {
  catalogAuthorityOf: (source) => {
    const s = String(source ?? "");
    return s === "checklistinsider" ? "checklist" : "derived";
  },
};
const fakeReconcile = { reportWrites: () => {} };

${legacyNoGate ? `
// ── THE MUTATION: pre-fix behaviour ─────────────────────────────────────
// Before this PR, the COMPLETE MOVE branch called retireCatalogRow with NO
// gate at all -- reproduced here by making catalogAuthorityOf always answer
// "checklist" (so the twin check can never refuse) and salesAtId always
// answer zero (so the sales check can never refuse), exactly what "no gate"
// looked like.
fakeAuthority.catalogAuthorityOf = () => "checklist";
const salesAtIdLib = require(require("node:path").join(${JSON.stringify(backend)}, "scripts", "lib", "sales-at-id.cjs"));
const realSalesAtId = salesAtIdLib.salesAtId;
salesAtIdLib.salesAtId = async (...args) => {
  const res = await realSalesAtId(...args);
  return { ...res, total: 0, xp: 0, pk: 0 };
};
` : ""}

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
  return { preloadFile: file, callLog };
}

function runLane(salesShape: SalesShape, destAuthority: DestAuthority = "checklist", legacyNoGate = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-completemove-"));
  const list = makeReslugList(dir);
  const { preloadFile, callLog } = preload(dir, salesShape, destAuthority, legacyNoGate);
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
  return { stdout, stderr, output: `${stdout}\n${stderr}`, status: r.status, retireCalls };
}

describe("relocate-catalog-rows-by-list.cjs -- the COMPLETE MOVE retire is now gated", () => {
  it("(i) sales at the source visible ONLY to the partition-scoped form -> REFUSED, retireCatalogRow never called", () => {
    const res = runLane("pk-only");
    expect(res.retireCalls, "retireCatalogRow must not run when the pk-scoped form finds a sale at the source").toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(sales present, n=1\)/);
    expect(res.stdout).toContain("sales pointing at the source: 1");
  });

  it("(ii) sales at the source visible ONLY cross-partition -> REFUSED, retireCatalogRow never called", () => {
    const res = runLane("xp-only");
    expect(res.retireCalls).toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(sales present, n=1\)/);
  });

  it("(iii) destination is NOT checklist-grade -> REFUSED, retireCatalogRow never called (twin check)", () => {
    const res = runLane("both-zero", "derived");
    expect(res.retireCalls, "retireCatalogRow must not run when the destination twin is not checklist-grade").toHaveLength(0);
    expect(res.output).toMatch(/REFUSED \(destination not checklist-grade/);
  });

  it("(iv) checklist-grade twin AND zero sales by both forms -> COMPLETED (retired)", () => {
    const res = runLane("both-zero", "checklist");
    expect(res.retireCalls).toEqual([SOURCE_ID]);
    expect(res.output).not.toContain("RECONCILE MISMATCH");
  });

  it("(v) the sales query THROWS -> FAILED, retireCatalogRow never called", () => {
    const res = runLane("throws");
    expect(res.retireCalls, "an unanswered sales check must never be treated as a green light to delete").toHaveLength(0);
    expect(res.output).toMatch(/FAILED: sales check threw/);
    expect(res.output).not.toMatch(/REFUSED \(sales present/);
  });
});

describe("MUTATION: the pre-fix COMPLETE MOVE branch (no gate) retires despite live sales at the source", () => {
  it("the same (i) fixture, with the gate short-circuited, retires the source anyway -- proving the pin above is real", () => {
    const res = runLane("pk-only", "checklist", /* legacyNoGate */ true);
    expect(res.retireCalls).toEqual([SOURCE_ID]);
    expect(res.output).not.toMatch(/REFUSED \(sales present/);
    expect(res.output).not.toMatch(/REFUSED \(destination not checklist-grade/);
  });
});
