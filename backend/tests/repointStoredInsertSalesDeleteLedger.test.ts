/**
 * repoint-stored-insert-sales.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-
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
 * Reuses repointStoredInsertSalesLane.test.ts's own shim()/drive() helpers
 * and fixtures verbatim (same execFileSync-against-real-dist,
 * @azure/cosmos-stubbed-via-Module._load pattern, same panini-photogenic
 * pilot cell) -- only LEDGER_OUT is new, forwarded exactly like every other
 * env var `drive()` already passes through its `...env` spread.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-stored-insert-sales.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-stored-insert-sales-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "football";
const YEAR = 2024;
const BASE_SET_KEY = "panini-photogenic";
const INSERT_KEY = "panini-photogenic-rookie-pix";
const BASE_HIQ = `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-dm:base:no-auto`;
const INSERT_HIQ = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;

const CHECKLIST_ROW = (over: Record<string, unknown> = {}) => ({
  id: INSERT_HIQ, cardId: INSERT_HIQ,
  sport: SPORT, year: YEAR, cardYear: YEAR, setKey: INSERT_KEY,
  cardNumber: "DT-5", playerName: "Drake Maye", source: "checklistinsider-2024-08-27",
  parallelSlug: "base", parallel: "Base", isAuto: false,
  gradeTier: undefined,
  ...over,
});

// ── Same shim as repointStoredInsertSalesLane.test.ts. ──────────────────────
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  portfolio?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = (opts.catalog ?? []).map((d) => ({ ...d }));
  const sales = (opts.sales ?? []).map((d) => ({ ...d, _etag: (d as any)._etag ?? `"etag-${Math.random().toString(36).slice(2)}"` }));
  const portfolio = (opts.portfolio ?? []).map((d) => ({ ...d }));

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [], etagMismatches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function preconditionFailed() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }
let etagSeq = 1000;
function bumpEtag(d) { d._etag = '"etag-bump-' + (etagSeq++) + '"'; }

function makeContainer(name, store, onUpsert, onDelete, onPatch, keyOf) {
  const key = keyOf || ((id) => id);
  return {
    item: (id, pk) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops, patchOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        if (patchOpts && patchOpts.accessCondition && String(d._etag) !== String(patchOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "patch" }); save();
          throw preconditionFailed();
        }
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        bumpEtag(d);
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async (delOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        if (delOpts && delOpts.accessCondition && String(d._etag) !== String(delOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "delete" }); save();
          throw preconditionFailed();
        }
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        const withEtag = { ...doc, _etag: doc._etag ?? '"etag-new"' };
        bumpEtag(withEtag);
        store.set(key(doc.id, doc.cardId), structuredClone(withEtag));
        if (onUpsert) onUpsert(doc);
        return { resource: structuredClone(withEtag) };
      },
      query: (spec) => {
        const q = typeof spec === "string" ? spec : spec.query;
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...store.values()];
        let resources;
        if (name === "card_catalog" && q.includes("c.setKey = @setKey")) {
          resources = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@setKey"] && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("STARTSWITH(c.hobbyiqCardId, @p)")) {
          const prefix = params["@p"];
          resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(prefix));
        } else if (name === "portfolio" && q.includes("IS_DEFINED(c.holdings)")) {
          resources = all;
        } else {
          throw new Error("fake " + name + ": unsupported query " + q);
        }
        return {
          fetchNext: async () => ({ resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }),
          fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
        };
      },
    },
  };
}

const catalogContainer = makeContainer("card_catalog", state.catalog,
  (doc) => { led.catalogUpserts.push(doc.id); save(); });
const salesContainer = makeContainer("sold_comps", state.sales,
  (doc) => { led.salesUpserts.push(doc.id); save(); },
  (id) => { led.salesDeletes.push(id); save(); },
  (id, ops) => { led.salesPatches.push({ id, ops }); save(); },
  salesKey);
const portfolioContainer = makeContainer("portfolio", state.portfolio,
  undefined, undefined,
  (id, ops) => { led.portfolioPatches.push({ id, ops }); save(); });

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "card_catalog") return catalogContainer;
          if (name === "sold_comps") return salesContainer;
          if (name === "portfolio") return portfolioContainer;
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

const PORTFOLIO_EMPTY = [{ id: "p1", userId: "u1", holdings: {} }];
const BASE_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, sport: SPORT, cardYear: YEAR,
  cardNumber: "DT-5", playerName: "Drake Maye", parallel: "Base", isAuto: false,
  title: "2024 Panini Photogenic Rookie Pix Drake Maye",
  price: 5, soldAt: "2024-01-01",
  ...over,
});

function ledgerLinesFor(dir: string, lane: string) {
  const p = path.join(dir, `deleted-docs-${lane}-local.ndjson`);
  expect(fs.existsSync(p)).toBe(true);
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("repoint-stored-insert-sales -- pre-delete ledger, relocate call site", () => {
  it("writes a full-document ledger line before the relocate's delete, carrying price/soldAt/title", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-"));
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED 1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");

    const lines = ledgerLinesFor(ledgerDir, "repoint-stored-insert-sales");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.lane).toBe("repoint-stored-insert-sales");
    expect(line.action).toBe("relocate");
    expect(line.reason).toBe("insert-rekey");
    expect(line.container).toBe("sold_comps");
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(BASE_HIQ);
    expect(line.doc.price).toBe(5);
    expect(line.doc.soldAt).toBe("2024-01-01");
    expect(line.doc.title).toBe("2024 Panini Photogenic Rookie Pix Drake Maye");
  });

  it("refuses the delete when the ledger write fails: the row survives and the banner shows ledger-write-failed > 0", () => {
    const blockerParent = fs.mkdtempSync(path.join(tmp, "blocked-parent-"));
    const blocker = path.join(blockerParent, "blocked");
    fs.writeFileSync(blocker, "occupied");

    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
    expect(r.led.salesDeletes).not.toContain("s1");
  });
});

describe("repoint-stored-insert-sales -- pre-delete ledger, collapse call site", () => {
  it("writes a full-document ledger line before the collapse's delete when the SAME sale (by content hash) already resides at the insert address", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-collapse-"));
    const shared = { id: "shared::2", sport: SPORT, cardYear: YEAR, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", price: 5, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const shortIdCopy = { ...shared, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ };
    const resident = { ...shared, cardId: INSERT_HIQ, hobbyiqCardId: INSERT_HIQ };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("shared::2");

    const lines = ledgerLinesFor(ledgerDir, "repoint-stored-insert-sales");
    expect(lines.length).toBe(1);
    expect(lines[0].action).toBe("collapse");
    expect(lines[0].reason).toBe("same-sale-resident");
    expect(lines[0].doc.id).toBe("shared::2");
    expect(lines[0].doc.cardId).toBe(BASE_HIQ);
    expect(lines[0].doc.price).toBe(5);
    expect(lines[0].doc.soldAt).toBe("2024-01-01");
    expect(lines[0].doc.title).toBe("2024 Panini Photogenic Rookie Pix Drake Maye");
  });
});
