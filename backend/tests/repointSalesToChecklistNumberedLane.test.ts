/**
 * repoint-sales-to-checklist-numbered.cjs -- end-to-end against fake
 * card_catalog / sold_comps / portfolio containers.
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS: fold-checklist-numbered-twins.cjs
 * (R1) drives from card_catalog and can only fold a CATALOG TWIN row onto
 * the checklist's numbered row -- a short id with NO catalog row is never a
 * candidate in that lane's pass 1, so its sales are never reached. This
 * lane's fixture for "no catalog twin at the short id" (the common case) and
 * "a catalog twin DOES exist" (report only, not touched) both prove the gap
 * this lane closes and the boundary it respects.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (foldTwinRuleChecklistNumbered, catalogAuthority,
 * parseTitleIdentity, relocate-sold-comp) loads the REAL compiled dist/, so
 * what these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-to-checklist-numbered.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-checklist-numbered-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/catalog/foldTwinRuleChecklistNumbered.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SHORT_ID = "hiq:baseball:2026:topps:20:gold:no-auto";
const NUMBERED_ID = `${SHORT_ID}:num-2026`;

const CHECKLIST_ROW = (over: Record<string, unknown> = {}) => ({
  id: NUMBERED_ID, cardId: NUMBERED_ID,
  sport: "baseball", year: 2026, cardYear: 2026,
  setKey: "topps", cardNumber: "20", parallelSlug: "gold", isAuto: false, printRun: 2026,
  playerName: "Test Player", source: "checklistinsider-2026-08-27",
  gradeTier: undefined,
  ...over,
});

/**
 * A minimal in-memory Cosmos-shaped store, keyed by (container, id, pk).
 * Query dispatch is pattern-matched on the query TEXT -- the repo's own
 * convention (see rekeyCatalogIdToSetKeyLane.test.ts).
 */
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  portfolio?: Array<Record<string, unknown>>;
  failSalesUpsertForIds?: string[];
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = opts.catalog ?? [];
  const sales = opts.sales ?? [];
  const portfolio = opts.portfolio ?? [];
  const failSalesUpsertForIds = opts.failSalesUpsertForIds ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const FAIL_SALES_UPSERT_FOR_IDS = new Set(${JSON.stringify(failSalesUpsertForIds)});

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [d.id, d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], catalogDeletes: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }

function makeContainer(name, store, onUpsert, onDelete, onPatch) {
  return {
    item: (id, pk) => ({
      read: async () => {
        const d = store.get(id);
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops) => {
        const d = store.get(id);
        if (!d) throw notFound();
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!store.has(id)) throw notFound();
        store.delete(id);
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        if (name === "sold_comps" && FAIL_SALES_UPSERT_FOR_IDS.has(doc.id)) {
          throw new Error("simulated upsert failure for " + doc.id);
        }
        store.set(doc.id, structuredClone(doc));
        if (onUpsert) onUpsert(doc);
        return { resource: structuredClone(doc) };
      },
      query: (spec) => {
        const q = typeof spec === "string" ? spec : spec.query;
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...store.values()];
        let resources;
        if (name === "card_catalog" && q.includes("CONTAINS(c.id, \\":num-\\")")) {
          resources = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@setKey"] && String(d.id).includes(":num-") && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("c.cardId = @s") && !q.includes("hobbyiqCardId")) {
          resources = all.filter((d) => d.cardId === params["@s"]);
        } else if (name === "sold_comps" && q.includes("c.hobbyiqCardId = @s")) {
          resources = all.filter((d) => d.hobbyiqCardId === params["@s"] && d.cardId !== params["@s"]);
        } else if (name === "portfolio" && q.includes("IS_DEFINED(c.holdings)")) {
          resources = all;
        } else {
          throw new Error("fake " + name + ": unsupported query " + q);
        }
        return {
          fetchNext: async () => ({ resources, continuationToken: undefined }),
          fetchAll: async () => ({ resources }),
        };
      },
    },
  };
}

const catalogContainer = makeContainer("card_catalog", state.catalog,
  (doc) => { led.catalogUpserts.push(doc.id); save(); },
  (id) => { led.catalogDeletes.push(id); save(); });
const salesContainer = makeContainer("sold_comps", state.sales,
  (doc) => { led.salesUpserts.push(doc.id); save(); },
  (id) => { led.salesDeletes.push(id); save(); },
  (id, ops) => { led.salesPatches.push({ id, ops }); save(); });
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

describe("repoint-sales-to-checklist-numbered -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: "topps" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const s of ["refractor", "all"]) {
      const r = drive({ SCOPE: s, SET_KEYS: "topps" });
      expect(r.code).toBe(2);
    }
  });

  it("REFUSES an empty SET_KEYS", () => {
    const r = drive({ SCOPE: "baseball:2026", SET_KEYS: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
  });

  it("REFUSES a wildcard SET_KEYS ('all' or '*')", () => {
    for (const v of ["all", "*"]) {
      const r = drive({ SCOPE: "baseball:2026", SET_KEYS: v });
      expect(r.code).toBe(2);
    }
  });
});

describe("repoint-sales-to-checklist-numbered -- REPORT writes nothing and matches APPLY's counts", () => {
  it("finds a partition-keyed sale at the short id and reports it, writing zero", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "2026 Topps Gold", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RELOCATE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("REPORT's relocate/patch counts equal APPLY's on the same fixture", () => {
    const cardIdSale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain title", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const hobbyiqSale = { id: "s2", cardId: "vendor-abc", hobbyiqCardId: SHORT_ID, title: "plain title", sport: "baseball", price: 6 };
    const fixture = { catalog: [CHECKLIST_ROW()], sales: [cardIdSale, hobbyiqSale], portfolio: PORTFOLIO_EMPTY };

    const report = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps" }, fixture);
    const apply = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    const reportRelocate = report.out.match(/WOULD RELOCATE\s+(\d+)/);
    const applyRelocate = apply.out.match(/RELOCATED\s+(\d+)/);
    const reportPatch = report.out.match(/WOULD PATCH\s+(\d+)/);
    const applyPatch = apply.out.match(/PATCHED\s+(\d+)/);
    expect(reportRelocate?.[1]).toBe("1");
    expect(applyRelocate?.[1]).toBe("1");
    expect(reportPatch?.[1]).toBe("1");
    expect(applyPatch?.[1]).toBe("1");
  });
});

describe("repoint-sales-to-checklist-numbered -- APPLY moves sales", () => {
  it("relocates a sale partitioned AT the short id (cardId === shortId) via upsert-verify-delete", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/RELOCATED 1/);
  });

  it("patches a sale whose hobbyiqCardId names the short id but whose cardId is a vendor partition", () => {
    const sale = { id: "s2", cardId: "vendor-xyz", hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 6 };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.out).toMatch(/PATCHED 1/);
  });

  it("re-points a holding referencing the short id", () => {
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: SHORT_ID, hobbyiqCardId: SHORT_ID } } };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], portfolio: [holdingDoc] },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.some((p: any) => p.id === "p1")).toBe(true);
    expect(r.out).toMatch(/holdings re-pointed\s+1/);
  });

  it("is idempotent: a second run after everything moved finds nothing left to move", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const first = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(first.led.salesUpserts).toContain("s1");

    // Re-drive against a FRESH store seeded with the row AS IT NOW STANDS
    // (moved to the numbered id) -- a real re-run would see this state.
    const movedSale = { ...sale, id: "s1", cardId: NUMBERED_ID, hobbyiqCardId: NUMBERED_ID };
    const second = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [movedSale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/RELOCATED 0/);
    expect(second.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-to-checklist-numbered -- refusals", () => {
  it("REFUSES a sale whose title states a print run (absent beats wrong), leaving it in place", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "2026 Topps Gold Card /2026", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title states a print run\s+1/);
    expect(r.out).toMatch(/title-states-print-run/);
  });

  it("skips (AMBIGUOUS) two rival checklist print runs and folds neither", () => {
    const rivalA = CHECKLIST_ROW({ id: `${SHORT_ID}:num-2026`, cardId: `${SHORT_ID}:num-2026`, printRun: 2026 });
    const rivalB = CHECKLIST_ROW({ id: `${SHORT_ID}:num-50`, cardId: `${SHORT_ID}:num-50`, printRun: 50 });
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5 };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [rivalA, rivalB], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/rival\/ambiguous \/N groups\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("counts a short id that ALSO has a catalog twin, but does not touch card_catalog", () => {
    const twin = { id: SHORT_ID, cardId: SHORT_ID, sport: "baseball", year: 2026, setKey: "topps", cardNumber: "20", parallelSlug: "gold", isAuto: false, printRun: null, source: "ingest-auto-seed" };
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW(), twin], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/short ids that ALSO have a catalog twin\s+1/);
    // The twin row itself is never touched: no catalog upsert/delete at all.
    expect(r.led.catalogUpserts.length).toBe(0);
    expect(r.led.catalogDeletes.length).toBe(0);
    // The sale still moves -- this lane's whole job.
    expect(r.led.salesUpserts).toContain("s1");
  });
});

describe("repoint-sales-to-checklist-numbered -- CF-A-SALE-IS-NEVER-LOST reconciliation", () => {
  it("balances: sales at short ids before == relocated + patched + refused + left", () => {
    const moves = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const refuses = { id: "s2", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "2026 Topps Gold /2026", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [moves, refuses], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sales at short ids before\s+2/);
    expect(r.out).toMatch(/matched -- every sale at a short id is relocated, patched, refused/);
  });
});
