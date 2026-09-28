/**
 * repoint-sales-parallel-suffix.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-
 * LEDGER-LINE-FIRST wiring (2026-09-28, review finding #2 on PR #2498).
 *
 * relocateSoldComp's own `ledger` option is already fully unit-tested at the
 * shared-helper level (relocateSoldCompDeleteLedger.test.ts) -- this file
 * only proves that THIS lane's two call sites (the collapse branch's direct
 * `recordDeleteOrThrow` call, and the everyday relocate branch's
 * `relocateSoldComp(..., { ledger: {...} })`) wire it correctly and that a
 * ledger-write failure surfaces through this lane's own `s.ledgerWriteFailed`
 * counter and banner line.
 *
 * Reuses repointSalesParallelSuffixLane.test.ts's own shim()/drive() helpers
 * and CATALOG_ROW fixture verbatim (same execFileSync-against-real-dist,
 * @azure/cosmos-stubbed-via-Module._load pattern, same 10-op patch cap /
 * IfMatch enforcement) -- only LEDGER_OUT is new, forwarded exactly like
 * every other env var `drive()` already passes through its `...env` spread.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-parallel-suffix.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-parallel-suffix-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "basketball";
const YEAR = 2024;
const SET_KEY = "panini-prizm";
const PREFIX = `hiq:${SPORT}:${YEAR}:${SET_KEY}:`;

const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: `${PREFIX}50:silver-prizm:no-auto`, cardId: `${PREFIX}50:silver-prizm:no-auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SET_KEY, cardNumber: "50", parallelSlug: "Silver Prizm", isAuto: false, printRun: null,
  playerName: "Test Player", source: "checklistinsider-2026-08-27",
  gradeTier: undefined,
  ...over,
});

// ── Same shim as repointSalesParallelSuffixLane.test.ts. ────────────────────
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = opts.catalog ?? [];
  const sales = opts.sales ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

let etagCounter = 0;
const stampEtag = (d) => { d._etag = "etag-" + (++etagCounter); return d; };
const SALES_SEED = ${JSON.stringify(sales)}.map(stampEtag);

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(SALES_SEED.map((d) => [salesKey(d.id, d.cardId), d])),
};
const led = { salesUpserts: [], salesPatches: [], salesDeletes: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function patchOpLimitExceeded() { return Object.assign(new Error("The number of patch operations cannot exceed '10'."), { code: 400 }); }
function removePathNotFound(pth) { return Object.assign(new Error("For step 0, no field or value specified in the operation: remove " + pth), { code: 400 }); }

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
      const d = state.catalog.get(id);
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
  }),
  items: {
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const all = [...state.catalog.values()];
      let resources;
      if (q.includes("c.setKey = @setKey")) {
        resources = all.filter((d) =>
          d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
          && d.setKey === params["@setKey"] && d.gradeTier === undefined);
      } else {
        throw new Error("fake card_catalog: unsupported query " + q);
      }
      return {
        fetchNext: async () => ({ resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }),
        fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
      };
    },
  },
};

const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
    patch: async (ops, options) => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      if (ops.length > 10) throw patchOpLimitExceeded();
      const cond = options && options.accessCondition;
      if (cond && cond.type === "IfMatch" && String(d._etag ?? "") !== String(cond.condition ?? "")) {
        throw Object.assign(new Error("etag mismatch"), { code: 412 });
      }
      for (const o of ops) {
        const key = o.path.slice(1);
        if (o.op === "set" || o.op === "add") d[key] = o.value;
        else if (o.op === "remove") {
          if (!(key in d)) throw removePathNotFound(o.path);
          delete d[key];
        }
      }
      stampEtag(d);
      led.salesPatches.push({ id, ops });
      save();
      return { resource: structuredClone(d) };
    },
    delete: async (options) => {
      if (!state.sales.has(salesKey(id, pk))) throw notFound();
      const cond = options && options.accessCondition;
      if (cond && cond.type === "IfMatch") {
        const d = state.sales.get(salesKey(id, pk));
        if (String(d._etag ?? "") !== String(cond.condition ?? "")) {
          throw Object.assign(new Error("etag mismatch"), { code: 412 });
        }
      }
      state.sales.delete(salesKey(id, pk));
      led.salesDeletes.push(id);
      save();
      return {};
    },
  }),
  items: {
    upsert: async (doc) => {
      const stored = structuredClone(doc);
      stampEtag(stored);
      state.sales.set(salesKey(doc.id, doc.cardId), stored);
      led.salesUpserts.push(doc.id);
      save();
      return { resource: structuredClone(stored) };
    },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("STARTSWITH(c.cardId, @prefix)") && !q.includes("hobbyiqCardId")) {
        resources = all.filter((d) => String(d.cardId ?? "").startsWith(params["@prefix"]));
      } else if (q.includes("STARTSWITH(c.hobbyiqCardId, @prefix)")) {
        resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(params["@prefix"]) && !String(d.cardId ?? "").startsWith(params["@prefix"]));
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      return {
        fetchNext: async () => ({ resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }),
        fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
      };
    },
  },
};

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "card_catalog") return catalogContainer;
          if (name === "sold_comps") return salesContainer;
          throw new Error("unknown container " + name);
        },
      };
    }
  },
};

const realLoad = Module._load;
Module._load = function (request) {
  const r = String(request);
  if (r === "@azure/cosmos") return stub;
  if (r.includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
  return { requirePath: p, ledger };
}

function drive(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const { requirePath, ledger } = shim(opts);
  let code = 0; let out = "";
  try {
    out = execFileSync(process.execPath, [LANE], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
        NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
  return { code, out, led };
}

const DEFAULT_ENV = { SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: SET_KEY };

function ledgerLinesFor(dir: string, lane: string) {
  const p = path.join(dir, `deleted-docs-${lane}-local.ndjson`);
  expect(fs.existsSync(p)).toBe(true);
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("repoint-sales-parallel-suffix -- pre-delete ledger, relocate call site", () => {
  it("writes a full-document ledger line before the relocate's delete, carrying price/soldAt/title", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-"));
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { catalog: [CATALOG_ROW()], sales: [sale] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");

    const lines = ledgerLinesFor(ledgerDir, "repoint-sales-parallel-suffix");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.lane).toBe("repoint-sales-parallel-suffix");
    expect(line.action).toBe("relocate");
    expect(line.reason).toBe("parallel-suffix");
    expect(line.container).toBe("sold_comps");
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(shortId);
    expect(line.doc.price).toBe(5);
    expect(line.doc.soldAt).toBe("2024-01-01");
    expect(line.doc.title).toBe("plain #50");
  });

  it("refuses the delete when the ledger write fails: the row survives and the banner shows ledger-write-failed > 0", () => {
    const blockerParent = fs.mkdtempSync(path.join(tmp, "blocked-parent-"));
    const blocker = path.join(blockerParent, "blocked");
    fs.writeFileSync(blocker, "occupied");

    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { catalog: [CATALOG_ROW()], sales: [sale] },
    );
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
    expect(r.led.salesDeletes).not.toContain("s1");
  });
});

describe("repoint-sales-parallel-suffix -- pre-delete ledger, collapse call site", () => {
  it("writes a full-document ledger line before the collapse's delete when the SAME sale (by content hash) already resides at the checklist-spelled destination", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-collapse-"));
    // Shared listing content (price/soldAt/parallel/isAuto/grade -- the exact
    // fields contentHashOf hashes on) at two addresses: the bare "silver"
    // slug (about to be relocated away) and the destination address (already
    // resident) -- the collapse shape. The relocate's own `keep` object
    // carries the MOVING sale's own `parallel` field through unchanged (only
    // cardId/hobbyiqCardId are rewritten -- see the lane's own `keep` build
    // above), so the resident must share that SAME parallel spelling
    // byte-for-byte for contentHashOf to agree; it need not match the
    // checklist row's own parallelSlug spelling.
    const shared = { sport: SPORT, price: 5, soldAt: "2024-01-01", parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, playerName: "Test Player" };
    const shortId = `${PREFIX}50:silver:no-auto`;
    const destId = CATALOG_ROW().id as string;
    const moving = { ...shared, id: "same-sale", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50" };
    const resident = { ...shared, id: "same-sale", cardId: destId, hobbyiqCardId: destId, title: "plain #50" };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { catalog: [CATALOG_ROW()], sales: [moving, resident] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("same-sale");

    const lines = ledgerLinesFor(ledgerDir, "repoint-sales-parallel-suffix");
    expect(lines.length).toBe(1);
    expect(lines[0].action).toBe("collapse");
    expect(lines[0].reason).toBe("same-sale-resident");
    expect(lines[0].doc.id).toBe("same-sale");
    expect(lines[0].doc.cardId).toBe(shortId);
    expect(lines[0].doc.price).toBe(5);
    expect(lines[0].doc.soldAt).toBe("2024-01-01");
  });
});
