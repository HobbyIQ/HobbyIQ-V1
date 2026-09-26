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
  /** CONCURRENCY / RULING (review, 2026-09-19): artificial latency (ms) on
   *  sold_comps WRITE paths -- upsert, patch, delete -- so a test can widen
   *  the window between the lane's re-read-before-write (`residentAt`) and
   *  the actual upsert, the exact window the last-line _etag defence exists
   *  to close. Distinct from `latencyMs` (which only ever delayed the
   *  card_catalog read) because the split-identity / stale-write tests need
   *  the RACE to be on the write side, not the target-dispatch side. */
  writeLatencyMs?: number;
  /** LAST-LINE DEFENCE (review, 2026-09-19): an OUT-OF-BAND mutation the
   *  store applies to `mutateSaleId`'s document on its OWN timer
   *  (`setTimeout`, independent of anything the lane calls), simulating a
   *  concurrent writer -- a different repair lane, a re-scrape -- touching
   *  the SAME document between this lane's planning read (the cardId-shape
   *  query) and the point it re-reads immediately before the upsert. Bumps
   *  the doc's `_etag` exactly as a real external write would; the lane's
   *  own re-read-before-write must see the NEW etag and refuse rather than
   *  overwrite. */
  mutateSaleId?: string;
  mutateAfterMs?: number;
  /** LAST-LINE DEFENCE (review, 2026-09-19): instead of bumping the etag,
   *  the out-of-band mutation DELETES `mutateSaleId`'s doc from its planned
   *  address -- simulating it having already been moved or removed by
   *  something else entirely before this lane's re-read-before-write. */
  deleteSaleAfterMutate?: boolean;
  /** CONDITIONAL WRITES (review, 2026-09-19): a DETERMINISTIC alternative to
   *  the wall-clock `mutateAfterMs` timer, for a race this lane's own
   *  SECOND window (between the last-line re-read and the actual delete/
   *  patch) needs to land in exactly -- node startup overhead makes a
   *  fixed-ms timer's landing point too variable run to run to hit that
   *  narrow a window reliably. Mutates `mutateSaleId`'s doc the instant the
   *  Nth sold_comps container call (read, patch, delete OR upsert, counted
   *  together in call order) RETURNS -- so "mutate after call 2" always
   *  lands between call 2 and call 3, on every run, regardless of timing. */
  mutateAfterNthSoldCompsCall?: number;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = opts.catalog ?? [];
  const sales = opts.sales ?? [];
  const portfolio = opts.portfolio ?? [];
  const failSalesUpsertForIds = opts.failSalesUpsertForIds ?? [];
  const latencyMs = opts.latencyMs ?? 0;
  const writeLatencyMs = opts.writeLatencyMs ?? 0;
  const mutateSaleId = opts.mutateSaleId ?? null;
  const mutateAfterMs = opts.mutateAfterMs ?? 0;
  const deleteSaleAfterMutate = opts.deleteSaleAfterMutate ?? false;
  const mutateAfterNthSoldCompsCall = opts.mutateAfterNthSoldCompsCall ?? 0;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const FAIL_SALES_UPSERT_FOR_IDS = new Set(${JSON.stringify(failSalesUpsertForIds)});
const LATENCY_MS = ${JSON.stringify(latencyMs)};
const WRITE_LATENCY_MS = ${JSON.stringify(writeLatencyMs)};

// PARTITION-AWARE for sold_comps ONLY (BLOCKER 2 fixture need, #2314 review):
// keyed by "id::cardId" rather than bare "id", so two documents CAN share the
// same document id at two different cardId partitions -- exactly the shape
// a resident-at-the-destination collision requires. card_catalog and
// portfolio stay keyed by bare id (their own tests never need two docs
// sharing an id at different partitions).
const salesKey = (id, cardId) => id + "::" + cardId;

// RULING (review, 2026-09-19): every sold_comps doc gets an _etag so the
// last-line-defence re-read-before-write can compare one. A bare counter,
// not a real Cosmos etag shape -- the lane only ever compares it for
// equality, never parses it. Stamped on the SAME array literal the sales Map
// below is built from (one parse of the embedded JSON, not two independent
// ones) so the stamp is visible through the Map's own values.
let etagCounter = 0;
const stampEtag = (d) => { d._etag = "etag-" + (++etagCounter); return d; };
const SALES_SEED = ${JSON.stringify(sales)}.map(stampEtag);

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(SALES_SEED.map((d) => [salesKey(d.id, d.cardId), d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], catalogDeletes: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [], maxInFlight: 0 };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

// LAST-LINE DEFENCE (review, 2026-09-19): an out-of-band mutation, on its
// OWN timer, simulating a concurrent writer touching the mutateSaleId
// document between the lane's planning read and its re-read-before-write.
const MUTATE_SALE_ID = ${JSON.stringify(mutateSaleId)};
const MUTATE_AFTER_MS = ${JSON.stringify(mutateAfterMs)};
const DELETE_SALE_AFTER_MUTATE = ${JSON.stringify(deleteSaleAfterMutate)};
function applyMutation() {
  for (const [key, d] of [...state.sales.entries()]) {
    if (d.id === MUTATE_SALE_ID) {
      if (DELETE_SALE_AFTER_MUTATE) { state.sales.delete(key); }
      else { stampEtag(d); d.title = "mutated by another writer"; }
    }
  }
}
if (MUTATE_SALE_ID && MUTATE_AFTER_MS > 0) {
  setTimeout(applyMutation, MUTATE_AFTER_MS);
}

// CONDITIONAL WRITES (review, 2026-09-19): a DETERMINISTIC alternative to the
// wall-clock timer above -- mutates the instant the Nth sold_comps container
// call (read, patch, delete, upsert, counted together in call order)
// RETURNS, so the mutation always lands in the gap between call N and call
// N+1 regardless of process startup timing. Counted here, once, and checked
// at the end of EVERY sold_comps call below.
const MUTATE_AFTER_NTH_SOLD_COMPS_CALL = ${JSON.stringify(mutateAfterNthSoldCompsCall)};
let soldCompsCallCount = 0;
function noteSoldCompsCallAndMaybeMutate() {
  soldCompsCallCount++;
  if (MUTATE_SALE_ID && MUTATE_AFTER_NTH_SOLD_COMPS_CALL > 0 && soldCompsCallCount === MUTATE_AFTER_NTH_SOLD_COMPS_CALL) {
    applyMutation();
  }
}

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
        // WRITE_LATENCY_MS also delays sold_comps READS (residentAt's own
        // point read: the destination-collision check AND the last-line
        // re-read-before-write) -- both are part of the write-side critical
        // section this option exists to widen, per the LAST-LINE DEFENCE
        // tests, which need the out-of-band mutation timer to land before
        // this read runs.
        if (name === "sold_comps" && WRITE_LATENCY_MS > 0) await sleep(WRITE_LATENCY_MS);
        const d = store.get(key(id, pk));
        // The clone is taken BEFORE the mutation hook -- d is the LIVE
        // stored object (never copied on the way in), so a mutation hook
        // that ran before this clone would mutate d in place and this
        // call would return the ALREADY-mutated snapshot to its caller,
        // defeating the whole point of "mutate after THIS call returns".
        const resultDoc = d ? structuredClone(d) : null;
        // noteSoldCompsCallAndMaybeMutate() fires AFTER this call's own data
        // access, right before it returns -- so THIS call sees the
        // pre-mutation state, and only the NEXT sold_comps call (whichever
        // one it is) can observe the mutation. That is what makes "mutate
        // after call N" land deterministically in the gap between call N
        // and call N+1, never inside call N itself.
        if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
        if (!resultDoc) throw notFound();
        return { resource: resultDoc };
      },
      patch: async (ops, options) => {
        if (name === "sold_comps" && WRITE_LATENCY_MS > 0) await sleep(WRITE_LATENCY_MS);
        const d = store.get(key(id, pk));
        if (!d) { if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate(); throw notFound(); }
        // CONDITIONAL WRITES (review, 2026-09-19): IfMatch on the patch
        // shape -- a 412-shaped error, same as real Cosmos, when the
        // caller's etag no longer matches what is actually stored.
        const cond = options?.accessCondition;
        if (cond && cond.type === "IfMatch" && String(d._etag ?? "") !== String(cond.condition ?? "")) {
          if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
          throw Object.assign(new Error("etag mismatch"), { code: 412 });
        }
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        if (name === "sold_comps") stampEtag(d);
        if (onPatch) onPatch(id, ops);
        const resultDoc = structuredClone(d);
        if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
        return { resource: resultDoc };
      },
      delete: async (options) => {
        if (name === "sold_comps" && WRITE_LATENCY_MS > 0) await sleep(WRITE_LATENCY_MS);
        if (!store.has(key(id, pk))) { if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate(); throw notFound(); }
        // CONDITIONAL WRITES (review, 2026-09-19): IfMatch on the delete --
        // relocateSoldComp's own conditional-delete path (an OPTIONAL
        // ifMatchEtag per drop item).
        const cond = options?.accessCondition;
        if (cond && cond.type === "IfMatch") {
          const d = store.get(key(id, pk));
          if (String(d._etag ?? "") !== String(cond.condition ?? "")) {
            if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
        }
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        if (name === "sold_comps" && WRITE_LATENCY_MS > 0) await sleep(WRITE_LATENCY_MS);
        if (name === "sold_comps" && FAIL_SALES_UPSERT_FOR_IDS.has(doc.id)) {
          if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
          throw new Error("simulated upsert failure for " + doc.id);
        }
        const stored = structuredClone(doc);
        if (name === "sold_comps") stampEtag(stored);
        store.set(key(doc.id, doc.cardId), stored);
        if (onUpsert) onUpsert(doc);
        const resultDoc = structuredClone(stored);
        if (name === "sold_comps") noteSoldCompsCallAndMaybeMutate();
        return { resource: resultDoc };
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
          fetchNext: async () => ({ resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }),
          fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
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

  it("HAZARD 2 (non-split case) -- a sale is reachable from exactly one target's two queries (cardId-shape XOR hobbyiqCardId-shape), never both: a cardId-shape hit at target A's shortId is not also patched as target B's hobbyiqCardId hit", () => {
    // Two targets sharing NOTHING but proximity in the same setKey/cell: A's
    // sale sits AT its own short id (cardId-shape); B's sale is vendor-keyed
    // but carries B's OWN short id as hobbyiqCardId (hobbyiqCardId-shape).
    // If the two queries ever overlapped, B's sale could double-match A's
    // shape-1 scan (it does not, because A's query filters cardId = A's
    // shortId, and B's sale's cardId is a vendor id, not A's shortId). This
    // is the case where the OLD "disjoint by field" proof was correct --
    // neither sale's two fields disagree, so each can only ever satisfy ONE
    // target. See the SPLIT-IDENTITY describe block below for the shape the
    // old proof missed: a sale whose two fields deliberately disagree,
    // naming two DIFFERENT live targets.
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

// ── SPLIT-IDENTITY ACROSS TWO LIVE TARGETS (blocking review, 2026-09-19) ────
// The gap the first version of #2339 missed: a sale whose cardId names one
// LIVE target's shortId and whose hobbyiqCardId names ANOTHER live target's
// shortId is reachable from BOTH -- target A's cardId-shape query finds it
// and would relocate it (stamping hobbyiqCardId = numberedA, destroying the
// fact it used to name a different card); target B's hobbyiqCardId-shape
// query finds the SAME document and would patch hobbyiqCardId = numberedB.
// That is a torn write on a document that was never an un-numbered twin --
// pre-existing SERIAL defect, not only a concurrency one. classifySaleFor
// Relocation now refuses this shape from EITHER side; these tests pin the
// refusal with write-path latency injected so the two targets' writes would
// have genuinely raced under the OLD code, and confirm the reconcile line
// still balances with the refusal counted once, not twice.
describe("SPLIT IDENTITY ACROSS TWO LIVE TARGETS -- the decision fix, not just the race", () => {
  function twoLiveTargetsFixture() {
    const shortA = "hiq:baseball:2026:topps:1:gold:no-auto";
    const numberedA = `${shortA}:num-101`;
    const shortB = "hiq:baseball:2026:topps:2:gold:no-auto";
    const numberedB = `${shortB}:num-102`;
    const catalog = [
      { id: numberedA, cardId: numberedA, sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", cardNumber: "1", parallelSlug: "gold", isAuto: false, printRun: 101, source: "checklistinsider-2026-08-27", gradeTier: undefined },
      { id: numberedB, cardId: numberedB, sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", cardNumber: "2", parallelSlug: "gold", isAuto: false, printRun: 102, source: "checklistinsider-2026-08-27", gradeTier: undefined },
    ];
    // THE SPLIT SALE: cardId names A's shortId, hobbyiqCardId names B's
    // shortId -- both hiq: slugs, both LIVE targets in THIS dispatch.
    const splitSale = { id: "split1", cardId: shortA, hobbyiqCardId: shortB, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    return { shortA, numberedA, shortB, numberedB, catalog, splitSale };
  }

  it("refuses the split sale from BOTH targets, writes nothing to it, even with write-path latency and CONCURRENCY=16 (the shape that would have raced under the old code)", () => {
    const { catalog, splitSale } = twoLiveTargetsFixture();
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog, sales: [splitSale], portfolio: PORTFOLIO_EMPTY, latencyMs: 15, writeLatencyMs: 30 },
    );
    expect(r.code).toBe(0);
    // Neither a relocate nor a patch happened to the split doc: zero writes
    // of ANY kind to sold_comps.
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/RELOCATED 0/);
    expect(r.out).toMatch(/PATCHED 0/);
    // Counted and listed as a split-identity refusal.
    expect(r.out).toMatch(/REFUSED: pre-existing split identity\s+1/);
    expect(r.out).toMatch(/split-identity/);
    expect(r.out).toMatch(/cardId=hiq:baseball:2026:topps:1:gold:no-auto hobbyiqCardId=hiq:baseball:2026:topps:2:gold:no-auto/);
  });

  it("counts the split sale ONCE in the reconciliation, not twice, even though it is found by two targets' queries", () => {
    const { catalog, splitSale } = twoLiveTargetsFixture();
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog, sales: [splitSale], portfolio: PORTFOLIO_EMPTY, latencyMs: 15, writeLatencyMs: 30 },
    );
    expect(r.code).toBe(0);
    // "sales at short ids before" is DEDUPED to 1 distinct document, not 2
    // raw query hits, and the banner names the dedup explicitly.
    expect(r.out).toMatch(/sales at short ids before\s+1/);
    expect(r.out).toMatch(/2 raw query hits, 1 were the SAME split-identity document/);
    // The reconcile still balances: 1 before = 0 relocated + 0 patched + 0
    // collapsed + 1 refused + 0 failed + 0 left.
    expect(r.out).toMatch(/matched -- every sale at a short id is relocated, patched, refused/);
    expect(r.code).not.toBe(4); // exit 4 is CF-A-SALE-IS-NEVER-LOST's own "unaccounted for"
  });

  it("REPORT and APPLY agree on the split refusal (same fixture)", () => {
    const { catalog, splitSale } = twoLiveTargetsFixture();
    const fixture = { catalog, sales: [splitSale], portfolio: PORTFOLIO_EMPTY, latencyMs: 15, writeLatencyMs: 30 };
    const report = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps", CONCURRENCY: "16" }, fixture);
    const apply = drive({ SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" }, fixture);
    expect(report.out).toMatch(/REFUSED: pre-existing split identity\s+1/);
    expect(apply.out).toMatch(/REFUSED: pre-existing split identity\s+1/);
    expect(report.led.salesUpserts.length).toBe(0);
    expect(apply.led.salesUpserts.length).toBe(0);
  });

  it("refuses a split HOLDING (cardId names one live target, hobbyiqCardId names another) from both targets, and does not overwrite either field", () => {
    const { catalog, shortA, shortB } = twoLiveTargetsFixture();
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: shortA, hobbyiqCardId: shortB } } };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog, sales: [], portfolio: [holdingDoc], latencyMs: 10 },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.length).toBe(0);
    expect(r.out).toMatch(/holdings REFUSED: split identity\s+1/);
    expect(r.out).toMatch(/holdings re-pointed\s+0/);
  });

  it("a NON-split holding under the same two-target fixture still repoints normally (the split guard does not over-refuse)", () => {
    const { catalog, shortA, numberedA } = twoLiveTargetsFixture();
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: shortA, hobbyiqCardId: shortA } } };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog, sales: [], portfolio: [holdingDoc], latencyMs: 10 },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.some((p: any) => p.id === "p1")).toBe(true);
    const setOps = r.led.portfolioPatches.find((p: any) => p.id === "p1").ops;
    expect(setOps.some((o: any) => o.path === "/holdings/h1/cardId" && o.value === numberedA)).toBe(true);
    expect(r.out).toMatch(/holdings re-pointed\s+1/);
  });
});

// ── LAST-LINE DEFENCE: re-read-before-write on the relocate path (review,
// 2026-09-19) ────────────────────────────────────────────────────────────
describe("LAST-LINE DEFENCE -- a source doc that changed since the planning read is refused, not overwritten", () => {
  it("refuses a relocate when the source doc's _etag changed between the planning read and the write (simulated by an out-of-band mutation mid-flight)", () => {
    // An ordinary un-numbered-twin candidate (would relocate under shape
    // (1)), but its title is rewritten IN THE STORE, on an independent
    // timer, between the plan and the write -- simulating some OTHER writer
    // (a re-scrape, a different repair lane) touching it in that window.
    // WRITE_LATENCY_MS on the resident-check point read (residentAt, used as
    // BOTH the destination-collision check and the last-line re-read) gives
    // the mutation time to land before the lane's re-read-before-write runs.
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY, writeLatencyMs: 40, mutateSaleId: "s1", mutateAfterMs: 10 },
    );
    expect(r.code).toBe(0);
    // Refused, not relocated: no upsert, no delete of the stale copy.
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/RELOCATED 0/);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+1/);
    expect(r.out).toMatch(/stale-since-plan/);
    expect(r.out).toMatch(/_etag changed since the planning read/);
  });

  it("does NOT false-positive on an untouched document -- the ordinary relocate still succeeds with no interference", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+0/);
  });

  it("the doc GONE from its planned address by write time (deleted/moved by something else) is refused, not treated as a silent no-op", () => {
    // Simulated by mutating the sale's cardId itself out from under the
    // plan -- residentAt(sale.id, shortId) then finds nothing at that
    // address, which the defence treats the same as an etag mismatch: gone
    // since the plan, refuse rather than guess.
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY, writeLatencyMs: 40, mutateSaleId: "s1", mutateAfterMs: 10, deleteSaleAfterMutate: true },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+1/);
    expect(r.out).toMatch(/gone from .* since the planning read/);
  });
});

// ── TITLE-CONTRADICTION VETO (review, 2026-09-19) ───────────────────────────
// An audit of tonight's 107 serial relocations found 4 sales whose TITLE
// names a different card than the checklist address they were carried onto.
// This lane must not launder a mis-identified sale onto a checklist-backed
// address. These are the four REAL titles from that audit, pinned as
// refusals, plus 6 normal titles that must still move (no false positives).
describe("TITLE-CONTRADICTION VETO -- refuses a sale whose own title contradicts the checklist target", () => {
  const REAL_AUDIT_CASES: Array<{ title: string; target: Record<string, unknown>; rule: string }> = [
    {
      title: "Aaron Judge 2026 Donruss Elite Orange Foil #61",
      target: { setKey: "topps", cardNumber: "61", parallelSlug: "Purple Holo Foil", playerName: "Aaron Judge" },
      rule: "product", // Donruss Elite is unrelated to Topps -- caught by product, ahead of parallel
    },
    {
      title: "2025-26 Topps Match Attax Ace Bailey #125 Rare Purple SP",
      target: { setKey: "topps", cardNumber: "125", parallelSlug: "Image Variation", playerName: "Ace Bailey" },
      // "topps-match-attax-uefa" (inferSetKeyFromTitle's own reading)
      // registers as a CHILD of "topps" -- measured: productAncestry("topps-
      // match-attax-uefa") includes "topps", so the DIRECTIONAL product rule
      // (title-is-descendant-of-target) refuses it BEFORE the parallel check
      // even runs (rules run in order: card-number, product, parallel,
      // player -- the first that fires wins). "Purple" vs "Image Variation"
      // is a SECOND, independent signal that would also catch this title,
      // but the product rule fires first, so this is caught with rule:
      // "product", not "parallel" -- both signals agree, only one gets named.
      rule: "product",
    },
    {
      title: "Livvy Dunne 2025 Topps Allen & Ginter X #225",
      target: { setKey: "topps", cardNumber: "225", parallelSlug: "Image Variation", playerName: "Livvy Dunne" },
      rule: "product", // "Topps Allen Ginter" is a registered CHILD of the target ("topps") --
      // the DIRECTIONAL exemption (title-is-ancestor-of-target only) does not cover this
      // shape, so it refuses -- see titleContradictsTarget's own header for why the
      // symmetric reading in the review's prose cannot be right against this example.
    },
  ];

  it.each(REAL_AUDIT_CASES)("REFUSES the real audit title: $title", ({ title, target, rule }) => {
    const shortId = "hiq:baseball:2026:topps:99:gold:no-auto";
    const numberedId = `${shortId}:num-2026`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      printRun: 2026, source: "checklistinsider-2026-08-27", gradeTier: undefined,
      cardNumber: target.cardNumber, setKey: target.setKey, parallelSlug: target.parallelSlug, playerName: target.playerName, isAuto: false,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title, sport: "baseball", price: 5, parallel: String(target.parallelSlug), isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/title-contradicts-target/);
    expect(r.out).toMatch(new RegExp(`rule: ${rule}`));
  });

  it("case 4 (SHORT PRINTS SERIES 2) is a KNOWN, ACCEPTED gap: number and product both agree, and the finish reader cannot distinguish a bare short-print marker from image-variation -- NOT refused, pinned as today's actual behaviour", () => {
    // "2025 TOPPS #700 Kristian Campbell SHORT PRINTS SERIES 2" -- see
    // titleContradictsTarget's own header for the full measured proof
    // (statedFinishFromChecklist returns null in every phrasing tried, and
    // readVariationFromTitle's own "short-print" marker CORROBORATES an
    // image-variation tag per parallelTheTitleAllows's own D22 rule, it does
    // not contradict it). This is the review's own caveat ("if it cannot
    // [distinguish], leave (c) to number/product") landing exactly where it
    // predicted -- documented here so the gap is pinned, not silently untested.
    const shortId = "hiq:baseball:2025:topps:700:image-variation:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "700", setKey: "topps", parallelSlug: "Image Variation", playerName: "Kristian Campbell", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 TOPPS #700 Kristian Campbell SHORT PRINTS SERIES 2", sport: "baseball", price: 5, parallel: "Image Variation", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
    expect(r.out).toMatch(/RELOCATED 1/);
  });

  const NORMAL_TITLES_THAT_MUST_STILL_MOVE: Array<{ title: string; target: Record<string, unknown> }> = [
    { title: "2026 Topps #20 Gold PSA 10", target: { setKey: "topps", cardNumber: "20", parallelSlug: "Gold", playerName: "Test Player" } },
    { title: "2026 Topps Gold Refractor Aaron Judge #20", target: { setKey: "topps", cardNumber: "20", parallelSlug: "Gold", playerName: "Aaron Judge" } },
    { title: "2026 Topps Chrome #20 Refractor", target: { setKey: "topps-chrome", cardNumber: "20", parallelSlug: "Refractor", playerName: "Test Player" } },
    { title: "Aaron Judge 2026 Topps #20", target: { setKey: "topps", cardNumber: "20", parallelSlug: "Base", playerName: "Aaron Judge" } },
    // "Topps Update" is an UNREGISTERED product spelling (measured:
    // isRegisteredProduct("topps-update") === false), so the product check
    // stays silent -- this title exercises THAT silence, not the player
    // check, so the target's playerName is set to agree with what the title
    // actually names ("Judge") rather than an unrelated placeholder, which
    // would otherwise be a REAL player contradiction and refuse correctly.
    { title: "2026 Topps Update #20 Judge", target: { setKey: "topps", cardNumber: "20", parallelSlug: "Base", playerName: "Aaron Judge" } },
    { title: "2026 Bowman Chrome Prospect #20", target: { setKey: "bowman-chrome", cardNumber: "20", parallelSlug: "Base", playerName: "Test Player" } },
  ];

  it.each(NORMAL_TITLES_THAT_MUST_STILL_MOVE)("does NOT refuse an ordinary title: $title", ({ title, target }) => {
    const shortId = `hiq:baseball:2026:${target.setKey}:88:gold:no-auto`;
    const numberedId = `${shortId}:num-2026`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2026, cardYear: 2026,
      printRun: 2026, source: "checklistinsider-2026-08-27", gradeTier: undefined,
      cardNumber: target.cardNumber, setKey: target.setKey, parallelSlug: target.parallelSlug, playerName: target.playerName, isAuto: false,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title, sport: "baseball", price: 5, parallel: String(target.parallelSlug), isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      // SET_KEYS matches the TARGET's own setKey (topps, topps-chrome, or
      // bowman-chrome across this table's rows) -- candidateSpec's own query
      // filters card_catalog by `c.setKey = @setKey`, so a target row whose
      // setKey the dispatch does not name is never found at all.
      { SCOPE: "baseball:2026", SET_KEYS: String(target.setKey), BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("REPORT and APPLY agree on the title-contradiction refusal (same fixture)", () => {
    const { target, title } = REAL_AUDIT_CASES[0];
    const shortId = "hiq:baseball:2026:topps:99:gold:no-auto";
    const numberedId = `${shortId}:num-2026`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      printRun: 2026, source: "checklistinsider-2026-08-27", gradeTier: undefined,
      cardNumber: target.cardNumber, setKey: target.setKey, parallelSlug: target.parallelSlug, playerName: target.playerName, isAuto: false,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title, sport: "baseball", price: 5, parallel: String(target.parallelSlug), isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const fixture = { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY };
    const report = drive({ SCOPE: "baseball:2025", SET_KEYS: "topps" }, fixture);
    const apply = drive({ SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" }, fixture);
    expect(report.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(apply.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(report.led.salesUpserts.length).toBe(0);
    expect(apply.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES on a genuinely contradicting player (irreconcilable, confident title parse)", () => {
    const shortId = "hiq:baseball:2026:topps:20:gold:no-auto";
    const numberedId = `${shortId}:num-2026`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2026, cardYear: 2026,
      cardNumber: "20", setKey: "topps", parallelSlug: "Gold", playerName: "Aaron Judge", isAuto: false,
      printRun: 2026, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "Mike Trout 2026 Topps #20 Gold", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: player/);
  });

  it("does NOT refuse on a garbage/unparseable title (confidence 0) even though parseCardQuery's own fallback would otherwise name a 'player'", () => {
    // Regression pin for the confidence-floor fix found while writing this
    // suite: parseCardQuery("plain") returns { playerName: "Plain",
    // confidence: 0 } -- without the floor, EVERY fixture using a placeholder
    // "plain" title anywhere in this file would false-positive as an
    // irreconcilable player contradiction against any real playerName.
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });
});

// ── TITLE-CONTRADICTION VETO -- FALSE-POSITIVE PASS (review, 2026-09-20) ────
// Production run 35483730823 (baseball:2025 topps, first REPORT after the
// veto merged) refused 575 sales as title-contradicts-target: 312
// card-number, 126 product, 76 parallel, 61 player. The product refusals
// (Donruss Elite / A&G / Cosmic Chrome vs a plain Topps target) are CORRECT
// and stay refused -- already pinned above. This block pins the three false
// classes so they now pass through, and re-pins each rule's true positives
// so the fix does not overcorrect into silence.
describe("TITLE-CONTRADICTION VETO false-positive pass -- card-number: a boundary-prefix is the SAME ladder, not a different card", () => {
  const UNDER_SPECIFIED_CARD_NUMBER_CASES: Array<{ title: string; targetCardNumber: string }> = [
    // The title states only the parent code of a hyphenated insert number --
    // the checklist's own more specific rung, not a different card.
    { title: "2025 Topps Rare Insert #90ASC Refractor Auto", targetCardNumber: "90ASC-3" },
    { title: "2025 Topps Rare Insert #90B2 The Real One", targetCardNumber: "90B2-39" },
    { title: "2025 Topps Base Card #BCP Chrome", targetCardNumber: "BCP-12" },
    // The title carries an extra suffix (-SP) the checklist's bare number
    // does not -- same ladder, finer grain on the title's side.
    { title: "2025 Topps #19-SP Image Variation", targetCardNumber: "19" },
    { title: "2025 Topps #71-SP Image Variation", targetCardNumber: "71" },
  ];

  it.each(UNDER_SPECIFIED_CARD_NUMBER_CASES)("does NOT refuse '$title' against target #$targetCardNumber (boundary prefix)", ({ title, targetCardNumber }) => {
    const shortId = "hiq:baseball:2025:topps:88:image-variation:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: targetCardNumber, setKey: "topps", parallelSlug: "Image Variation", playerName: "Test Player", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title, sport: "baseball", price: 5, parallel: "Image Variation", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("STILL REFUSES a genuinely different card number (#61 vs target #125 -- no boundary-prefix relationship at all)", () => {
    const shortId = "hiq:baseball:2025:topps:99:purple-holo-foil:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "125", setKey: "topps", parallelSlug: "Purple Holo Foil", playerName: "Test Player", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2026 Topps Purple Holo Foil #61", sport: "baseball", price: 5, parallel: "Purple Holo Foil", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: card-number/);
  });

  it("STILL REFUSES an unrelated non-boundary prefix ('6' is not a boundary-safe prefix of '61' -- both digits)", () => {
    const shortId = "hiq:baseball:2025:topps:99:gold:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "61", setKey: "topps", parallelSlug: "Gold", playerName: "Test Player", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2026 Topps Gold #6", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: card-number/);
  });
});

describe("TITLE-CONTRADICTION VETO false-positive pass -- player: a checklist marker or parser noise is not a different person", () => {
  const UNDER_SPECIFIED_PLAYER_CASES: Array<{ title: string; targetPlayerName: string }> = [
    // The catalog's stored playerName still carries a checklist marker the
    // title never states -- cleanPlayerName strips it on both sides.
    { title: "2025 Topps Mason Montgomery Big Apple", targetPlayerName: "Mason Montgomery RC" },
    { title: "2025 Topps Andy Pages Big Apple", targetPlayerName: "Andy Pages FS" },
    { title: "2025 Topps Masyn Winn Big Apple", targetPlayerName: "Masyn Winn RCup" },
    // The title-side guess is a loose parse that grabbed an EXTRA trailing
    // token the vendor's structured field never had -- title is the
    // superset here, target the subset.
    { title: "2025 Topps Roki Sasaki Ff Nyc Big Apple", targetPlayerName: "Roki Sasaki RC" },
    // The title-side guess is a BARE first name -- a subset of the target's
    // fuller name, not a different player.
    { title: "2025 Topps James Big Apple", targetPlayerName: "James Wood RC" },
    // Accent difference (Jasson Domínguez / Jasson Dominguez) folds through
    // playerIdentityKey's own NFD accent strip.
    { title: "2025 Topps Jasson Dominguez Big Apple", targetPlayerName: "Jasson Domínguez FS" },
    // Initials punctuation: "J.T." vs "Jt" -- one person, two conventions.
    { title: "2025 Topps Jt Realmuto Big Apple", targetPlayerName: "J.T. Realmuto" },
    { title: "2025 Topps Jt Ginn Big Apple", targetPlayerName: "J.T. Ginn RC" },
  ];

  it.each(UNDER_SPECIFIED_PLAYER_CASES)("does NOT refuse '$title' against target playerName '$targetPlayerName'", ({ title, targetPlayerName }) => {
    const shortId = "hiq:baseball:2025:topps:77:big-apple:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "77", setKey: "topps", parallelSlug: "Big Apple", playerName: targetPlayerName, isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title, sport: "baseball", price: 5, parallel: "Big Apple", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("does NOT refuse when the title agrees with ANY listed name on a multi-player target row", () => {
    const shortId = "hiq:baseball:2025:topps:66:gold:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "66", setKey: "topps", parallelSlug: "Gold", playerName: "Eddie Murray / Cal Ripken Jr.", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Cal Ripken Gold", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("STILL REFUSES a genuine mismatch sharing no surname token (Clayton Kershaw vs target Mookie Betts)", () => {
    const shortId = "hiq:baseball:2025:topps:55:gold:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "55", setKey: "topps", parallelSlug: "Gold", playerName: "Mookie Betts", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Clayton Kershaw Gold", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: player/);
  });

  it("STILL REFUSES a multi-player target row when the title agrees with NEITHER listed name", () => {
    const shortId = "hiq:baseball:2025:topps:66:gold:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "66", setKey: "topps", parallelSlug: "Gold", playerName: "Eddie Murray / Cal Ripken Jr.", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Mike Trout Gold", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: player/);
  });

  // PIN (2026-09-20 false-positive pass, its own real audit line, run
  // 35483730823): "Salvador Ff Nyc" vs target "Salvador Perez" -- ONLY the
  // first token matches ("salvador"); the title's remaining tokens ("ff",
  // "nyc") share NO surname with the target's own last token ("perez"). This
  // is NOT the same shape as "Roki Sasaki Ff Nyc" ⊃ "Roki Sasaki" (there,
  // BOTH of the target's tokens are a prefix of the title's) -- here only
  // ONE of the target's two tokens is present, so neither key contains the
  // other as a whole-token subset, and per the review's own floor
  // ("contradict only when the two keys share NO surname token AND the
  // title guess has >= 2 name tokens and confidence above the floor") this
  // one legitimately stays refused: a genuinely different-looking name, not
  // an under-specification of the same one. Pinned as a TRUE positive this
  // fix does NOT release, not silently dropped from the suite.
  it("STILL REFUSES 'Salvador Ff Nyc' against target 'Salvador Perez' -- only the first token matches, no shared surname", () => {
    const shortId = "hiq:baseball:2025:topps:508:image-variation:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "508", setKey: "topps", parallelSlug: "Image Variation", playerName: "Salvador Perez", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Salvador Ff Nyc Image Variation", sport: "baseball", price: 5, parallel: "Image Variation", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: player/);
  });
});

describe("TITLE-CONTRADICTION VETO false-positive pass -- parallel: a terse CardHedge title stating only a bare colour is under-specified, not wrong", () => {
  it("does NOT refuse a bare 'Gold' CardHedge-style title against a 'gold-diamante-foil' target WHEN the card number has only that one gold-family rung", () => {
    const shortId = "hiq:baseball:2025:topps:520:gold-diamante-foil:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "520", setKey: "topps", parallelSlug: "gold-diamante-foil", playerName: "Aaron Judge", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "cardhedge::ch-daily::1", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Aaron Judge Gold #520", sport: "baseball", price: 5, parallel: "gold-diamante-foil", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("does NOT refuse a bare 'Orange' CardHedge-style title against an 'orange-diamante-foil' target under the same single-rung condition", () => {
    const shortId = "hiq:baseball:2025:topps:485:orange-diamante-foil:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "485", setKey: "topps", parallelSlug: "orange-diamante-foil", playerName: "Aaron Judge", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "cardhedge::ch-daily::2", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Aaron Judge Orange #485", sport: "baseball", price: 5, parallel: "orange-diamante-foil", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("bare 'Gold' on baseball|2025|topps: the veto's OWN ambiguity check no longer runs, and the write is still safe (2026-09-25 corpus rebuild)", () => {
    // PIN UPDATED (checklist-parallel-names corpus rebuild, 660 -> 943
    // products). This test's title ("2025 Topps Aaron Judge Gold #520") was
    // built to exercise titleContradictsTarget's own "same card number, a
    // sibling plain-'gold' rung too" ambiguity check (the `siblingRungs`/
    // `onlyOneRungOnThisLadder` code in repoint-sales-to-checklist-
    // numbered.cjs) -- but that check is gated behind
    // statedFinishFromChecklist returning a non-null `titleFinish` first
    // ("Silence... never reaches this call at all", per that function's own
    // comment). Traced with a debug print directly on both corpora:
    //
    //   - On the 09-19 corpus (660 products), baseball|2025|topps did not
    //     exist at all -- the only candidate for `(2025, "topps")` was
    //     basketball's "Gold Rainbow", and with only a HANDFUL of topps
    //     names total, "rainbow" cleared the 60% STOCK_WORD_SHARE floor
    //     (elidableStockWords) and was elided, so "Gold Rainbow" matched a
    //     bare "Gold" title and respelled down to "Gold" -- the value this
    //     test used to pin.
    //   - On this rebuild, baseball|2025|topps's real ~60-name checklist
    //     (Aqua/Black/Gold/Green/Orange/... Rainbow Foil, etc.) dilutes that
    //     ratio far below 60%: "rainbow" is no longer elidable, so "Gold
    //     Rainbow" requires the title to literally say "rainbow" to match --
    //     which "...Gold #520" does not -- and NO candidate matches at all.
    //     `best` is `null` (confirmed via direct instrumentation of
    //     statedFinishFromChecklist), not a downstream refusal.
    //
    // This is the SAME "never guess" doctrine working correctly one level
    // up: the fuller, correct checklist reveals "rainbow" is a REAL,
    // distinguishing colour-family qualifier for this product, not
    // boilerplate -- so a title that says only "Gold" is honestly
    // unresolvable at this reader, and this lane's OWN documented rule is
    // "silence never reaches the ambiguity check", not "silence refuses".
    //
    // THE WRITE REMAINS SAFE. The sale's own `parallel` field
    // ("gold-diamante-foil") already agrees with the target it relocates
    // onto; the title's bare "Gold" was only ever a SECOND, belt-and-
    // suspenders check, and this specific scenario has no actual
    // disagreement to catch -- the card_catalog row genuinely is
    // "gold-diamante-foil" and the sale's own classification already says so.
    const shortId = "hiq:baseball:2025:topps:520:gold-diamante-foil:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const plainGoldShortId = "hiq:baseball:2025:topps:520:gold:no-auto";
    const plainGoldNumberedId = `${plainGoldShortId}:num-2025`;
    const catalog = [
      {
        id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
        cardNumber: "520", setKey: "topps", parallelSlug: "gold-diamante-foil", playerName: "Aaron Judge", isAuto: false,
        printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
      },
      // A SIBLING checklist row at the SAME card number, a DIFFERENT rung on
      // the same ladder (plain "gold") -- kept for provenance; no longer the
      // mechanism that decides this specific test (see comment above).
      {
        id: plainGoldNumberedId, cardId: plainGoldNumberedId, sport: "baseball", year: 2025, cardYear: 2025,
        cardNumber: "520", setKey: "topps", parallelSlug: "gold", playerName: "Aaron Judge", isAuto: false,
        printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
      },
    ];
    const sale = { id: "cardhedge::ch-daily::3", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Aaron Judge Gold #520", sport: "baseball", price: 5, parallel: "gold-diamante-foil", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    // Relocated, not refused -- the sale's own parallel field already
    // agreed with the target, and the title-contradiction veto's parallel
    // leg does not fire on silence.
    expect(r.led.salesUpserts.length).toBe(1);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+0/);
  });

  it("STILL REFUSES a title naming an UNRELATED finish family (a real disagreement, not under-specification)", () => {
    const shortId = "hiq:baseball:2025:topps:520:purple-holo-foil:no-auto";
    const numberedId = `${shortId}:num-2025`;
    const catalog = [{
      id: numberedId, cardId: numberedId, sport: "baseball", year: 2025, cardYear: 2025,
      cardNumber: "520", setKey: "topps", parallelSlug: "purple-holo-foil", playerName: "Aaron Judge", isAuto: false,
      printRun: 2025, source: "checklistinsider-2026-08-27", gradeTier: undefined,
    }];
    const sale = { id: "cardhedge::ch-daily::4", cardId: shortId, hobbyiqCardId: shortId, title: "2025 Topps Aaron Judge Orange Foil #520", sport: "baseball", price: 5, parallel: "purple-holo-foil", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2025", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog, sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title contradicts the target\s+1/);
    expect(r.out).toMatch(/rule: parallel/);
  });
});

// ── CONDITIONAL WRITES (review, 2026-09-19) ─────────────────────────────────
// The reviewer's own follow-up: the _etag re-read still leaves a window,
// because relocateSoldComp's upsert and delete were unconditional. The
// planning-read etag is now passed as an IfMatch access condition on the
// source DELETE (relocate shape) and on the PATCH (patch shape) -- a 412
// refuses (stale-since-plan), no retry. These tests force a mutation to land
// in the SECOND window specifically -- AFTER this lane's own last-line
// re-read confirms a match, but BEFORE the conditional delete/patch actually
// runs -- which the etag re-read alone cannot close (two round trips), and
// which the IfMatch condition closes because Cosmos itself, not another
// round trip on this lane's side, evaluates the match atomically with the
// write.
describe("CONDITIONAL WRITES -- IfMatch closes the window the etag re-read alone cannot", () => {
  it("relocate: a mutation landing between the last-line re-read and the actual DELETE is caught by the IfMatch condition (412), not silently missed", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      // DETERMINISTIC race, not wall-clock: the relocate sequence issues
      // sold_comps calls in a fixed order -- (1) destination-collision check
      // read, (2) THIS lane's own last-line re-read, (3) relocateSoldComp's
      // own existedBefore read, (4) upsert, (5) verify read-back, (6) the
      // conditional delete. Mutating right after call 2 returns means call 2
      // itself still sees the ORIGINAL etag (passes the first-window check),
      // but call 6's IfMatch condition -- built from call 2's now-stale
      // snapshot -- sees the container's post-mutation etag and is refused
      // with a 412. Verified empirically against the real lane's own call
      // sequence, not assumed.
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY, writeLatencyMs: 10, mutateSaleId: "s1", mutateAfterNthSoldCompsCall: 2 },
    );
    expect(r.code).toBe(0);
    // The keeper WAS upserted (relocateSoldComp's own order: upsert, verify,
    // THEN delete -- the mutation lands too late to stop the upsert, which
    // already ran before the delete this test targets), but the OLD row's
    // delete was refused -- so the short-id copy is NOT deleted.
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+1/);
    expect(r.out).toMatch(/delete refused \(412\)/);
  });

  it("patch: a mutation landing between the last-line re-read and the actual PATCH is caught by the IfMatch condition (412), not silently missed", () => {
    const sale = { id: "s2", cardId: "vendor-xyz", hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 6 };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true", CONCURRENCY: "1" },
      // The patch shape issues exactly ONE sold_comps call before the patch
      // itself -- the last-line re-read (call 1) -- so mutating right after
      // call 1 returns lands the mutation between that re-read (which still
      // sees the original etag) and the patch call (whose IfMatch condition
      // then sees the container's post-mutation etag and is refused).
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY, writeLatencyMs: 10, mutateSaleId: "s2", mutateAfterNthSoldCompsCall: 1 },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+1/);
    expect(r.out).toMatch(/patch refused \(412\)/);
  });

  it("relocate: no interference means no 412 -- the ordinary conditional delete still succeeds", () => {
    const sale = { id: "s1", cardId: SHORT_ID, hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 5, parallel: "Gold", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2026-01-01" };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+0/);
  });

  it("patch: no interference means no 412 -- the ordinary conditional patch still succeeds", () => {
    const sale = { id: "s2", cardId: "vendor-xyz", hobbyiqCardId: SHORT_ID, title: "plain", sport: "baseball", price: 6 };
    const r = drive(
      { SCOPE: "baseball:2026", SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PATCHED 1/);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.out).toMatch(/REFUSED: stale since the planning read\s+0/);
  });
});

describe("relocateSoldComp (scripts/lib/relocate-sold-comp.cjs) -- conditional delete is OPTIONAL and additive", () => {
  it("every existing caller (no ifMatchEtag on any drop) is unaffected: unconditional delete, no accessCondition built at all", async () => {
    const relocateSoldCompModule = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
    const calls: Array<{ id: string; cardId: string; options: unknown }> = [];
    const fakePool = {
      item: (id: string, cardId: string) => ({
        read: async () => ({ resource: { id, cardId, _etag: "e1" } }),
        delete: async (options: unknown) => { calls.push({ id, cardId, options }); return {}; },
      }),
      items: { upsert: async (doc: any) => ({ resource: doc }) },
    };
    const keep = { id: "k1", cardId: "hiq:new", hobbyiqCardId: "hiq:new" };
    const res = await relocateSoldCompModule.relocateSoldComp(fakePool, {
      keep,
      drop: [{ id: "k1", cardId: "hiq:old" }], // NO ifMatchEtag -- every existing caller's shape
      guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(res.staleSincePlan).toEqual([]);
    expect(calls.length).toBe(1);
    // The delete was called with NO options at all (undefined) -- proving no
    // accessCondition object is built when the caller supplies no etag.
    expect(calls[0].options).toBeUndefined();
  });

  it("a drop WITH ifMatchEtag builds an IfMatch accessCondition, and a 412 lands in staleSincePlan, never duplicatesLeft", async () => {
    const relocateSoldCompModule = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
    const fakePool = {
      item: (id: string, cardId: string) => ({
        read: async () => ({ resource: { id, cardId, _etag: "e1" } }),
        delete: async (options: any) => {
          if (options?.accessCondition?.type === "IfMatch") {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
          return {};
        },
      }),
      items: { upsert: async (doc: any) => ({ resource: doc }) },
    };
    const keep = { id: "k1", cardId: "hiq:new", hobbyiqCardId: "hiq:new" };
    const res = await relocateSoldCompModule.relocateSoldComp(fakePool, {
      keep,
      drop: [{ id: "k1", cardId: "hiq:old", ifMatchEtag: "e1" }],
      guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(false);
    expect(res.staleSincePlan.length).toBe(1);
    expect(res.duplicatesLeft).toEqual([]);
    expect(res.deleted).toEqual([]);
  });

  it("is412 is exported and recognises a Cosmos-shaped 412 by code or statusCode", () => {
    const { is412 } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
    expect(is412({ code: 412 })).toBe(true);
    expect(is412({ statusCode: 412 })).toBe(true);
    expect(is412({ code: 404 })).toBe(false);
    expect(is412(new Error("plain"))).toBe(false);
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
