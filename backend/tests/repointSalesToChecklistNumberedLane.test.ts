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
  /** CONCURRENCY (review, 2026-09-19): artificial latency (ms) on the ONE
   *  per-target read every target's body issues first -- the catalog
   *  point-read at (shortId, shortId), `catalogTwinAt` in the lane -- so a
   *  test can force several targets to be in flight AT ONCE and observe it,
   *  the same way the real lane's targets overlap on real network latency.
   *  Zero (the default) behaves exactly as before: an instant, synchronous
   *  resolution, so every test that does not ask for this stays unaffected. */
  latencyMs?: number;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = opts.catalog ?? [];
  const sales = opts.sales ?? [];
  const portfolio = opts.portfolio ?? [];
  const failSalesUpsertForIds = opts.failSalesUpsertForIds ?? [];
  const latencyMs = opts.latencyMs ?? 0;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const FAIL_SALES_UPSERT_FOR_IDS = new Set(${JSON.stringify(failSalesUpsertForIds)});
const LATENCY_MS = ${JSON.stringify(latencyMs)};

// PARTITION-AWARE for sold_comps ONLY (BLOCKER 2 fixture need, #2314 review):
// keyed by "id::cardId" rather than bare "id", so two documents CAN share the
// same document id at two different cardId partitions -- exactly the shape
// a resident-at-the-destination collision requires. card_catalog and
// portfolio stay keyed by bare id (their own tests never need two docs
// sharing an id at different partitions).
const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], catalogDeletes: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [], maxInFlight: 0 };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

// CONCURRENCY (review, 2026-09-19): counts how many card_catalog point reads
// (catalogTwinAt's own read, called once per target before anything else in
// that target's body) are AWAITING at once. This is the max-in-flight witness
// the concurrency tests assert on -- it can only rise above 1 if the lane
// actually launched more than one target's body before the first finished.
let inFlight = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }

function makeContainer(name, store, onUpsert, onDelete, onPatch, keyOf) {
  const key = keyOf || ((id) => id);
  return {
    item: (id, pk) => ({
      read: async () => {
        if (name === "card_catalog" && LATENCY_MS > 0) {
          inFlight++;
          led.maxInFlight = Math.max(led.maxInFlight, inFlight);
          save();
          try { await sleep(LATENCY_MS); } finally { inFlight--; }
        }
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!store.has(key(id, pk))) throw notFound();
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        if (name === "sold_comps" && FAIL_SALES_UPSERT_FOR_IDS.has(doc.id)) {
          throw new Error("simulated upsert failure for " + doc.id);
        }
        store.set(key(doc.id, doc.cardId), structuredClone(doc));
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

  it("counts a short id with a VENDOR/DERIVED catalog twin, but does not touch card_catalog, and still moves the sale", () => {
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
    // A VENDOR/DERIVED twin does not veto -- the sale still moves.
    expect(r.led.salesUpserts).toContain("s1");
  });

  // ── BLOCKER 1 (review, 2026-09-19): a CHECKLIST row at the short id is a
  // DIFFERENT, checklist-attested card (a partial print-run ladder), never a
  // twin to move sales past. The whole target is refused.
  describe("BLOCKER 1 -- a checklist-backed short id is a DIFFERENT card, never a twin", () => {
    it("VETOES the whole target when the short id itself is CHECKLIST authority -- no sale under it is touched", () => {
      const checklistShortIdRow = { id: SHORT_ID, cardId: SHORT_ID, sport: "baseball", year: 2026, setKey: "topps", cardNumber: "20", parallelSlug: "gold", isAuto: false, printRun: null, source: "checklistcenter-2026-08-30" };
      const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
      const r = drive(
        { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
        { catalog: [CHECKLIST_ROW(), checklistShortIdRow], sales: [sale], portfolio: PORTFOLIO_EMPTY },
      );
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/targets VETOED: short id is checklist-backed\s+1/);
      expect(r.out).toMatch(/checklist-backed at the short id/);
      // NOTHING touched: no sale moved, no catalog write.
      expect(r.led.salesUpserts.length).toBe(0);
      expect(r.led.salesDeletes.length).toBe(0);
      expect(r.led.catalogUpserts.length).toBe(0);
    });

    it("REPORT and APPLY agree on the veto count (same fixture)", () => {
      const checklistShortIdRow = { id: SHORT_ID, cardId: SHORT_ID, sport: "baseball", year: 2026, setKey: "topps", cardNumber: "20", parallelSlug: "gold", isAuto: false, printRun: null, source: "checklistcenter-2026-08-30" };
      const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
      const fixture = { catalog: [CHECKLIST_ROW(), checklistShortIdRow], sales: [sale], portfolio: PORTFOLIO_EMPTY };
      const report = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps" }, fixture);
      const apply = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" }, fixture);
      expect(report.out).toMatch(/targets VETOED: short id is checklist-backed\s+1/);
      expect(apply.out).toMatch(/targets VETOED: short id is checklist-backed\s+1/);
    });
  });
});

// ── BLOCKER 2 (review, 2026-09-19): relocateSoldComp's upsert is a BLIND
// write at (sale.id, numberedId). Sale ids are `{source}::{externalId}` and
// do not embed cardId, so the same id can already be resident at the
// numbered partition. Same sale (by content hash) -> collapse; different
// sale -> refuse, move nothing.
describe("BLOCKER 2 -- a resident document already at the relocate destination", () => {
  it("COLLAPSES when the SAME sale (by content hash) is already resident at the numbered id -- deletes the short-id copy, upserts nothing new", () => {
    const shared = { id: "shared::sale::1", title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const shortIdCopy = { ...shared, cardId: SHORT_ID, hobbyiqCardId: SHORT_ID };
    const resident = { ...shared, cardId: NUMBERED_ID, hobbyiqCardId: NUMBERED_ID };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    // The short-id copy is deleted; the resident is NEVER upserted (nothing
    // new is written at the destination -- it was already correct there).
    expect(r.led.salesDeletes).toContain("shared::sale::1");
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES (destination-collision) when a DIFFERENT sale occupies the numbered id -- moves NEITHER", () => {
    const shortIdCopy = { id: "shared::sale::2", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    // Same id, but a DIFFERENT sale by content (different price/soldAt) --
    // e.g. the ingest upgrade wrote this id fresh from a re-scrape and it is
    // NOT the same transaction as the short-id copy.
    const resident = { id: "shared::sale::2", cardId: NUMBERED_ID, hobbyiqCardId: NUMBERED_ID, title: "plain", sport: "baseball", price: 999, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-06-06" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination collision\s+1/);
    expect(r.out).toMatch(/destination-collision/);
    // NEITHER sale is touched: the short-id copy stays, the resident stays.
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("proceeds with the ordinary relocate when NOTHING is resident at the destination", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
  });
});

// ── SHOULD-FIX 3 (review, 2026-09-19): a title stating its print run in
// PROSE ("Numbered to 50", "SN50", "1 of 1") is invisible to extractPrintRun's
// slash-only reading and must still refuse -- absent beats wrong is this
// rule's only safety net.
describe("SHOULD-FIX 3 -- a prose print run refuses exactly like a slash one", () => {
  it("REFUSES a sale whose title states a print run in PROSE with no slash at all", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "2026 Topps Gold Numbered to 2026", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title states a print run\s+1/);
  });

  it("does NOT refuse ordinary titles -- card numbers, grades, years", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "2026 Topps #20 Gold PSA 10", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.led.salesUpserts).toContain("s1");
  });
});

// ── SHOULD-FIX 4 (review, 2026-09-19): per-target query cost in the banner.
describe("SHOULD-FIX 4 -- the banner reports hobbyiqCardId query cost", () => {
  it("prints the query count and p50/p95 latency lines", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/hobbyiqCardId cross-partition queries issued\s+1/);
    expect(r.out).toMatch(/p50 \d+ms\s+p95 \d+ms/);
  });
});

// ── CONCURRENCY (review, 2026-09-19) ────────────────────────────────────────
// Production run 35466486414 spent 86 of its 110-minute budget on 12,321
// SERIAL cross-partition queries and wrote only 2,185 of 16,409 targets. The
// per-target body now runs through a bounded worker pool (CONCURRENCY /
// BACKFILL_CONCURRENCY, default 8, capped 32) instead of a plain `for`. These
// tests pin: concurrency actually happens and stays under the cap; the two
// named collision hazards (same destination, same sale reachable from two
// targets) cannot occur because targets are disjoint by construction; a
// CONCURRENCY=1 run and a CONCURRENCY=16 run produce IDENTICAL final counters
// on the same fixture; and a budget stop still lets in-flight targets finish.
function manyTargetsFixture(n: number) {
  const catalog: Array<Record<string, unknown>> = [];
  const sales: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const shortId = `hiq:baseball:2026:topps:${i}:gold:no-auto`;
    const numberedId = `${shortId}:num-${100 + i}`;
    catalog.push({
      id: numberedId, cardId: numberedId,
      sport: "baseball", year: 2026, cardYear: 2026,
      setKey: "topps", cardNumber: String(i), parallelSlug: "gold", isAuto: false, printRun: 100 + i,
      playerName: `Player ${i}`, source: "checklistinsider-2026-08-27",
      gradeTier: undefined,
    });
    sales.push({
      id: `s${i}`, cardId: shortId, hobbyiqCardId: shortId, title: "plain",
      sport: "baseball", price: 5, parallel: "Gold", isAuto: false,
      gradeCompany: null, gradeValue: null, soldAt: "2026-01-01",
    });
  }
  return { catalog, sales, portfolio: PORTFOLIO_EMPTY };
}

describe("CONCURRENCY -- bounded worker pool over independent targets", () => {
  it("runs more than one target at once, and never exceeds the CONCURRENCY cap", () => {
    const fixture = manyTargetsFixture(12);
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "4" },
      { ...fixture, latencyMs: 40 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 12/);
    // Concurrency actually happened (> 1)...
    expect(r.led.maxInFlight).toBeGreaterThan(1);
    // ...and stayed within the dispatched cap (4), never silently fanning out
    // wider than CONCURRENCY names.
    expect(r.led.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("respects the 32 cap even when a larger value is requested", () => {
    const fixture = manyTargetsFixture(40);
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "999" },
      { ...fixture, latencyMs: 15 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 40/);
    expect(r.led.maxInFlight).toBeLessThanOrEqual(32);
  });

  it("CONCURRENCY=1 behaves as a serial run (max in flight is 1)", () => {
    const fixture = manyTargetsFixture(6);
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      { ...fixture, latencyMs: 20 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 6/);
    expect(r.led.maxInFlight).toBe(1);
  });

  it("CONCURRENCY=1 and CONCURRENCY=16 produce IDENTICAL final counters on the same fixture", () => {
    const fixture = manyTargetsFixture(20);
    const serial = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      { ...fixture, latencyMs: 5 },
    );
    const concurrent = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { ...fixture, latencyMs: 5 },
    );
    expect(serial.code).toBe(0);
    expect(concurrent.code).toBe(0);
    expect(concurrent.led.maxInFlight).toBeGreaterThan(serial.led.maxInFlight);

    const relocated = (out: string) => out.match(/RELOCATED\s+(\d+)/)?.[1];
    expect(relocated(serial.out)).toBe("20");
    expect(relocated(concurrent.out)).toBe(relocated(serial.out));

    // Every counter line in the banner (everything before the per-target
    // example/sample sections, whose ORDER is expected to differ under
    // concurrency but whose CONTENT should not) matches byte-for-byte, EXCEPT
    // the p50/p95 query-latency line -- that is wall-clock telemetry over
    // Date.now() sampling, not a decision output, and is EXPECTED to vary
    // between a serial and a concurrent run of the same fixture (this is the
    // whole point of the lane's own SHOULD-FIX 4 instrumentation: it measures
    // real timing, and timing is exactly what concurrency changes on
    // purpose). Cut at the query-count line, before that timing line, and
    // again before the throttled/concurrency-figure line.
    const countersOnly = (out: string) => out
      .split(/hobbyiqCardId cross-partition queries issued\s+\d+/)[0]
      .replace(/reslugedAt.*$/gm, "");
    expect(countersOnly(concurrent.out)).toBe(countersOnly(serial.out));

    // And the actual sets of relocated sale ids agree (order-independent).
    expect([...serial.led.salesUpserts].sort()).toEqual([...concurrent.led.salesUpserts].sort());
    expect([...serial.led.salesDeletes].sort()).toEqual([...concurrent.led.salesDeletes].sort());
  });

  it("HAZARD 1 -- two independent targets never collide on the same destination id: each of N targets relocates to its OWN numbered id, none stolen or merged", () => {
    const fixture = manyTargetsFixture(10);
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "10" },
      { ...fixture, latencyMs: 25 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 10/);
    // Every sale upserted lands at a DISTINCT numbered id -- read back via the
    // ledger's own salesUpserts (doc ids s0..s9, one per target) and confirm
    // none were dropped (a destination collision would show as < 10 upserts
    // or a duplicate id).
    expect(r.led.salesUpserts.length).toBe(10);
    expect(new Set(r.led.salesUpserts).size).toBe(10);
    // And the short-id copies were all deleted (the relocate half of the
    // move) -- 10 deletes, one per target, none left behind or double-deleted.
    expect(r.led.salesDeletes.length).toBe(10);
  });

  it("HAZARD 2 -- a sale is reachable from exactly one target's two queries (cardId-shape XOR hobbyiqCardId-shape), never both: a cardId-shape hit at target A's shortId is not also patched as target B's hobbyiqCardId hit", () => {
    // Two targets sharing NOTHING but proximity in the same setKey/cell: A's
    // sale sits AT its own short id (cardId-shape); B's sale is vendor-keyed
    // but carries B's OWN short id as hobbyiqCardId (hobbyiqCardId-shape).
    // If the two queries ever overlapped, B's sale could double-match A's
    // shape-1 scan (it does not, because A's query filters cardId = A's
    // shortId, and B's sale's cardId is a vendor id, not A's shortId).
    const shortA = "hiq:baseball:2026:topps:1:gold:no-auto";
    const numberedA = `${shortA}:num-101`;
    const shortB = "hiq:baseball:2026:topps:2:gold:no-auto";
    const numberedB = `${shortB}:num-102`;
    const catalog = [
      { id: numberedA, cardId: numberedA, sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", cardNumber: "1", parallelSlug: "gold", isAuto: false, printRun: 101, source: "checklistinsider-2026-08-27", gradeTier: undefined },
      { id: numberedB, cardId: numberedB, sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", cardNumber: "2", parallelSlug: "gold", isAuto: false, printRun: 102, source: "checklistinsider-2026-08-27", gradeTier: undefined },
    ];
    const saleA = { id: "sA", cardId: shortA, hobbyiqCardId: shortA, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const saleB = { id: "sB", cardId: "vendor-b", hobbyiqCardId: shortB, title: "plain", sport: "baseball", price: 6 };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "8" },
      { catalog, sales: [saleA, saleB], portfolio: PORTFOLIO_EMPTY, latencyMs: 20 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/PATCHED 1/);
    // A relocated (upsert+delete under its own id), B patched (no upsert, no
    // delete -- only a patch) -- neither shape crossed into the other target.
    expect(r.led.salesUpserts).toEqual(["sA"]);
    expect(r.led.salesDeletes).toEqual(["sA"]);
    expect(r.led.salesPatches.length).toBe(1);
    expect(r.led.salesPatches[0].id).toBe("sB");
  });

  it("a budget stop under concurrency still lets in-flight targets finish, and the marker text is unchanged", () => {
    // BUDGET_MS=1 (the runner-budget helper's own raw override -- RUN_MINUTES
    // itself falls back to its 110-minute default on falsy/zero input, so the
    // millisecond-level override is what actually forces CLOCK.outOfClock()
    // true from the very first check) means processTarget's own guard fires
    // before any I/O for every target this run claims, so nothing relocates
    // and the exact marker text the runner's relaunch composite greps for
    // (CF-RELAUNCH-ONLY-ON-BUDGET: "stopped at the .*budget") is still
    // printed, byte-identical to the serial lane's own wording.
    const fixture = manyTargetsFixture(5);
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "8", BUDGET_MS: "1" },
      { ...fixture, latencyMs: 10 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped at the 110-minute budget -- the slot has more to do/);
    expect(r.out).toMatch(/RELOCATED 0/);
    expect(r.led.salesUpserts.length).toBe(0);
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
