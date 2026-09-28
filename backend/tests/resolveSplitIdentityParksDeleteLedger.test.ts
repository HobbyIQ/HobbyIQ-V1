/**
 * resolve-split-identity-parks.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-
 * LEDGER-LINE-FIRST wiring (2026-09-28, review finding #2 on PR #2498).
 *
 * relocateSoldComp's own `ledger` option is already fully unit-tested at the
 * shared-helper level (relocateSoldCompDeleteLedger.test.ts) -- this file
 * only proves that THIS lane's three call sites (two direct
 * `recordDeleteOrThrow` collapse calls, and the everyday relocate branch's
 * `relocateSoldComp(..., { ledger: {...} })`) wire it correctly and that a
 * ledger-write failure surfaces through this lane's own `s.ledgerWriteFailed`
 * counter and banner line.
 *
 * Reuses resolveSplitIdentityParksLane.test.ts's own shim()/drive() helpers
 * and the VW3 worked-example fixture verbatim (same execFileSync-against-
 * real-dist, @azure/cosmos-stubbed-via-Module._load pattern, same 10-op patch
 * cap / IfMatch enforcement) -- only LEDGER_OUT is new, forwarded exactly
 * like every other env var `drive()` already passes through its `...env`
 * spread.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "resolve-split-identity-parks.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-split-identity-parks-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

// ── Same shim as resolveSplitIdentityParksLane.test.ts. ─────────────────────
function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

const seeded = ${JSON.stringify(sales)}.map((d) => ({ ...d, _etag: d._etag ?? '"v1"' }));
const state = { sales: new Map(seeded.map((d) => [salesKey(d.id, d.cardId), d])) };
const catalogState = new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d]));
const led = { salesUpserts: [], salesPatches: [], salesDeletes: [], catalogReads: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function preconditionFailed() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }
function patchOpLimitExceeded() { return Object.assign(new Error("The number of patch operations cannot exceed '10'."), { code: 400 }); }
function removePathNotFound(path) { return Object.assign(new Error("For step 0, no field or value specified in the operation: remove " + path), { code: 400 }); }

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
      if (cond && cond.type === "IfMatch" && cond.condition !== d._etag) throw preconditionFailed();
      for (const o of ops) {
        const key = o.path.slice(1);
        if (o.op === "set" || o.op === "add") d[key] = o.value;
        else if (o.op === "remove") {
          if (!(key in d)) throw removePathNotFound(o.path);
          delete d[key];
        }
      }
      d._etag = '"' + (Math.random().toString(36).slice(2)) + '"';
      led.salesPatches.push({ id, ops, accessCondition: cond ?? null });
      save();
      return { resource: structuredClone(d) };
    },
    delete: async (options) => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      const cond = options && options.accessCondition;
      if (cond && cond.type === "IfMatch" && cond.condition !== d._etag) throw preconditionFailed();
      state.sales.delete(salesKey(id, pk));
      led.salesDeletes.push(id);
      save();
      return {};
    },
  }),
  items: {
    upsert: async (doc) => {
      const withEtag = { ...doc, _etag: '"' + (Math.random().toString(36).slice(2)) + '"' };
      state.sales.set(salesKey(doc.id, doc.cardId), withEtag);
      led.salesUpserts.push(doc.id);
      save();
      return { resource: structuredClone(withEtag) };
    },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("identityUnverified")) {
        resources = all.filter((d) =>
          d.identityUnverified === true
          && typeof d.cardId === "string" && d.cardId.startsWith("hiq:")
          && typeof d.hobbyiqCardId === "string" && d.hobbyiqCardId.startsWith("hiq:")
          && d.cardId !== d.hobbyiqCardId
          && (d.identityUnverifiedReason === "split-identity" || String(d.identityUnverifiedReason ?? "").startsWith("PARK. cardId vertical"))
        );
      } else if (q.includes("c.id = @id AND c.cardId = @pk")) {
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        resources = all.filter((d) => d.id === params["@id"] && d.cardId === params["@pk"]);
      } else if (q.includes("c.cardId = @dest AND c.price = @p AND STARTSWITH(c.soldAt, @day)")) {
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        resources = all.filter((d) =>
          d.cardId === params["@dest"]
          && Number(d.price) === Number(params["@p"])
          && String(d.soldAt ?? "").startsWith(params["@day"])
        );
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      return {
        fetchNext: async () => ({ resources, continuationToken: undefined }),
        fetchAll: async () => ({ resources }),
      };
    },
  },
};

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
      led.catalogReads.push(id);
      save();
      const d = catalogState.get(id);
      if (!d || d.id !== pk) throw notFound();
      return { resource: structuredClone(d) };
    },
  }),
};

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "sold_comps") return salesContainer;
          if (name === "card_catalog") return catalogContainer;
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

// The task's own worked example: Wembanyama 2023 Topps Now #VW3.
const VW3_SALE = {
  id: "tca-ebay::vw3-1",
  cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
  hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
  sport: "baseball",
  identityUnverified: true,
  identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
  identityUnverifiedBy: "relocate-pool-rows-by-list",
  identityUnverifiedReason: 'PARK. cardId vertical "baseball" vs hobbyiqCardId "basketball"; all other slug segments identical',
  identityUnverifiedDetail: "no source attests either side",
  title: "2023 Topps Basketball Victor Wembanyama Rookie #VW3",
  playerName: "Victor Wembanyama",
  price: 12.5,
  soldAt: "2026-06-02T00:00:00.000Z",
  parallel: "base",
  isAuto: false,
  gradeCompany: null,
  gradeValue: null,
  source: "tca-ebay",
};
const VW3_CHECKLIST_BASKETBALL = {
  id: "hiq:basketball:2023:topps:vw3:base:no-auto",
  cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
  source: "checklistcenter",
  playerName: "Victor Wembanyama",
};

function ledgerLinesFor(dir: string, lane: string) {
  const p = path.join(dir, `deleted-docs-${lane}-local.ndjson`);
  expect(fs.existsSync(p)).toBe(true);
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("resolve-split-identity-parks -- pre-delete ledger, relocate call site", () => {
  it("writes a full-document ledger line before the relocate's delete, carrying price/soldAt/title", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-"));
    const r = drive(
      { SCOPE: "basketball:2023", BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain(VW3_SALE.id);
    expect(r.led.salesDeletes).toContain(VW3_SALE.id);

    const lines = ledgerLinesFor(ledgerDir, "resolve-split-identity-parks");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.lane).toBe("resolve-split-identity-parks");
    expect(line.action).toBe("relocate");
    expect(line.reason).toBe("split-resolve");
    expect(line.container).toBe("sold_comps");
    expect(line.doc.id).toBe(VW3_SALE.id);
    expect(line.doc.cardId).toBe(VW3_SALE.cardId);
    expect(line.doc.price).toBe(12.5);
    expect(line.doc.soldAt).toBe("2026-06-02T00:00:00.000Z");
    expect(line.doc.title).toBe(VW3_SALE.title);
  });

  it("refuses the delete when the ledger write fails: the row survives and the banner shows ledger-write-failed > 0", () => {
    const blockerParent = fs.mkdtempSync(path.join(tmp, "blocked-parent-"));
    const blocker = path.join(blockerParent, "blocked");
    fs.writeFileSync(blocker, "occupied");

    const r = drive(
      { SCOPE: "basketball:2023", BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] },
    );
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
    expect(r.led.salesDeletes).not.toContain(VW3_SALE.id);
  });
});

describe("resolve-split-identity-parks -- pre-delete ledger, collapse call site", () => {
  it("writes a full-document ledger line before the collapse's delete when the SAME sale (by content hash) already resides at the destination", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-collapse-"));
    const moving = { ...VW3_SALE, id: "same-sale" };
    const resident = {
      id: "same-sale", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      price: 12.5, soldAt: "2026-06-02T00:00:00.000Z", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive(
      { SCOPE: "all-splits", BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { sales: [moving, resident], catalog: [VW3_CHECKLIST_BASKETBALL] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("same-sale");

    const lines = ledgerLinesFor(ledgerDir, "resolve-split-identity-parks");
    expect(lines.length).toBe(1);
    expect(lines[0].action).toBe("collapse");
    expect(lines[0].reason).toBe("same-id-resident");
    expect(lines[0].doc.id).toBe("same-sale");
    expect(lines[0].doc.cardId).toBe(moving.cardId);
    expect(lines[0].doc.price).toBe(12.5);
    expect(lines[0].doc.title).toBe(moving.title);
  });
});
