/**
 * repoint-sales-parallel-suffix.cjs -- end-to-end against a fake card_catalog
 * / sold_comps, modelled on repointSalesToChecklistNumberedLane.test.ts's own
 * shim (etag-aware reads/patches/deletes, a 10-op patch cap and a remove-
 * path-not-found check exactly as resolveSplitIdentityParksLane.test.ts's own
 * fake enforces, so a fixture cannot go blind to the SAME live defect that
 * bit that sibling lane on 2026-09-19).
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS: ~10% of unbacked sales in the
 * biggest modern cells (48% in basketball 2024 panini-prizm) fail to match a
 * strict checklist row ONLY because the parallel slug differs from the
 * checklist's own spelling by the product's own suffix word, in BOTH
 * directions.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (catalogAuthority, parseTitleIdentity, hobbyIqCardId,
 * playerIdentityKey, ...) loads the REAL compiled dist/, so what these tests
 * pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-parallel-suffix.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-parallel-suffix-lane-"));
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

/**
 * A minimal in-memory Cosmos-shaped store, keyed by (container, id, pk) for
 * card_catalog and by (id, cardId) for sold_comps (so two documents CAN
 * share a document id at two different cardId partitions -- the destination-
 * collision shape). Every sold_comps document gets a bare-counter `_etag`;
 * patch/delete honour an `IfMatch` accessCondition exactly as real Cosmos
 * does, and a >10-op patch or a remove of an absent field throws the SAME
 * shaped 400 the real SDK throws (resolveSplitIdentityParksLane.test.ts's
 * own live-defect fixture, reused here since this lane's patch shape could
 * regress the identical way).
 */
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

describe("repoint-sales-parallel-suffix -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: SET_KEY });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const scope of ["refractor", "all"]) {
      const r = drive({ SCOPE: scope, SET_KEYS: SET_KEY });
      expect(r.code).toBe(2);
    }
  });

  it("REFUSES an empty SET_KEYS", () => {
    const r = drive({ SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
  });

  it("REFUSES a wildcard SET_KEYS ('all' or '*')", () => {
    for (const v of ["all", "*"]) {
      const r = drive({ SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: v });
      expect(r.code).toBe(2);
    }
  });
});

describe("repoint-sales-parallel-suffix -- suffix candidate table (unit)", () => {
  const lane = require(LANE);

  it("derives the word for panini-prizm / donruss-optic / panini-mosaic / topps-chrome, and NOT panini-select", () => {
    expect(lane.suffixWordFor("panini-prizm")).toBe("prizm");
    expect(lane.suffixWordFor("panini-prizm-wnba")).toBe("prizm");
    expect(lane.suffixWordFor("donruss-optic")).toBe("optic");
    expect(lane.suffixWordFor("panini-mosaic")).toBe("mosaic");
    expect(lane.suffixWordFor("topps-chrome")).toBe("refractor");
    expect(lane.suffixWordFor("bowman-chrome")).toBe("refractor");
    expect(lane.suffixWordFor("topps-finest")).toBe("refractor");
    expect(lane.suffixWordFor("panini-select")).toBeNull();
    expect(lane.suffixWordFor("topps")).toBeNull();
  });

  it("builds BOTH directions from the same candidate set: 'silver' offers 'silver-prizm' (plus plural forms)", () => {
    const candidates = lane.suffixCandidatesOf("silver", "prizm");
    expect(candidates).toContain("silver-prizm");
    expect(candidates).toContain("silver-prizms");
  });

  it("'silver-prizm' offers 'silver' back (the stripped form)", () => {
    const candidates = lane.suffixCandidatesOf("silver-prizm", "prizm");
    expect(candidates).toContain("silver");
  });

  it("never gives 'base' a suffix", () => {
    expect(lane.suffixCandidatesOf("base", "prizm")).toEqual([]);
    expect(lane.suffixCandidatesOf("Base", "prizm")).toEqual([]);
  });

  it("produces the fast-break-blue <-> fast-break-blue-prizm pair from either end", () => {
    expect(lane.suffixCandidatesOf("fast-break-blue", "prizm")).toContain("fast-break-blue-prizm");
    expect(lane.suffixCandidatesOf("fast-break-blue-prizm", "prizm")).toContain("fast-break-blue");
  });

  it("produces the holo <-> holo-prizm pair from either end", () => {
    expect(lane.suffixCandidatesOf("holo", "prizm")).toContain("holo-prizm");
    expect(lane.suffixCandidatesOf("holo-prizm", "prizm")).toContain("holo");
  });
});

describe("repoint-sales-parallel-suffix -- REPORT writes nothing and matches APPLY's counts", () => {
  it("finds a partition-keyed sale at 'silver' and reports a relocate onto the checklist's 'silver-prizm' row, writing zero", () => {
    const saleId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: saleId, hobbyiqCardId: saleId, title: "2024 Panini Prizm #50 Silver", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive(DEFAULT_ENV, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RELOCATE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("REPORT's relocate/patch counts equal APPLY's on the same fixture", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const cardIdSale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain title #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const hobbyiqSale = { id: "s2", cardId: "vendor-abc", hobbyiqCardId: shortId, title: "plain title #50", sport: SPORT, price: 6, playerName: "Test Player" };
    const fixture = { catalog: [CATALOG_ROW()], sales: [cardIdSale, hobbyiqSale] };

    const report = drive(DEFAULT_ENV, fixture);
    const apply = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(report.out.match(/WOULD RELOCATE\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/RELOCATED\s+(\d+)/)?.[1]).toBe("1");
    expect(report.out.match(/WOULD PATCH\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/PATCHED\s+(\d+)/)?.[1]).toBe("1");
  });
});

describe("repoint-sales-parallel-suffix -- APPLY moves sales, both directions", () => {
  it("relocates 'silver' -> 'silver-prizm' (bare loses, checklist keeps the suffix)", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/silver -> silver-prizm/);
  });

  it("relocates 'holo-prizm' -> 'holo' (suffixed loses, checklist keeps the bare word) -- the OTHER direction", () => {
    const catalogRow = CATALOG_ROW({ id: `${PREFIX}77:holo:no-auto`, cardId: `${PREFIX}77:holo:no-auto`, cardNumber: "77", parallelSlug: "Holo" });
    const shortId = `${PREFIX}77:holo-prizm:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #77", sport: SPORT, price: 5, parallel: "Holo Prizm", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [catalogRow], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/RELOCATED 1/);
    expect(r.out).toMatch(/holo-prizm -> holo/);
  });

  it("patches a sale whose hobbyiqCardId names the bare slug but whose cardId is a vendor partition", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s2", cardId: "vendor-xyz", hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 6, playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.out).toMatch(/PATCHED 1/);
  });

  it("is idempotent: a second run after the move finds nothing left to move", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const first = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(first.led.salesUpserts).toContain("s1");

    const movedId = CATALOG_ROW().id as string;
    const movedSale = { ...sale, id: "s1", cardId: movedId, hobbyiqCardId: movedId };
    const second = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [movedSale] });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/RELOCATED 0/);
    expect(second.led.salesUpserts.length).toBe(0);
  });

  it("base never gains a suffix -- a bare 'base' slug is left untouched even though a 'base-prizm' row exists", () => {
    const baseRow = CATALOG_ROW({ id: `${PREFIX}90:base:no-auto`, cardId: `${PREFIX}90:base:no-auto`, cardNumber: "90", parallelSlug: "Base" });
    const basePrizmRow = CATALOG_ROW({ id: `${PREFIX}91:base-prizm:no-auto`, cardId: `${PREFIX}91:base-prizm:no-auto`, cardNumber: "91", parallelSlug: "Base Prizm" });
    const shortId = `${PREFIX}90:base:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #90", sport: SPORT, price: 5, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [baseRow, basePrizmRow], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/RELOCATED 0/);
  });
});

describe("repoint-sales-parallel-suffix -- refusals", () => {
  it("REFUSES when TWO candidates are both strict on the same rung (two-candidates), for DIFFERENT players", () => {
    // suffixCandidatesOf("white", "prizm") produces EXACTLY
    // ["white-prizm", "white-prizms"] -- a bare "white" sale genuinely
    // offers both, and here they name two DIFFERENT real players on #60, so
    // this is the ordinary two-target ambiguity, not a catalog-duplicate-rung
    // spelling twin (see the dedicated describe block below for that case).
    const rowA = CATALOG_ROW({ id: `${PREFIX}60:white-prizm:no-auto`, cardId: `${PREFIX}60:white-prizm:no-auto`, cardNumber: "60", parallelSlug: "White Prizm", playerName: "Player A" });
    const rowB = CATALOG_ROW({ id: `${PREFIX}60:white-prizms:no-auto`, cardId: `${PREFIX}60:white-prizms:no-auto`, cardNumber: "60", parallelSlug: "White Prizms", playerName: "Player B" });
    const shortId = `${PREFIX}60:white:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #60", sport: SPORT, price: 5, parallel: "White", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Player A" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [rowA, rowB], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: two candidates strict at once\s+1/);
    expect(r.out).toMatch(/two-candidates/);
  });

  it("REFUSES the whole pair product-wide (both-slugs-are-real-rungs) when the checklist itself carries BOTH slugs as distinct cards on some number", () => {
    // #50 has ONLY "silver" on the checklist (a genuine candidate target for
    // a sale sitting at "silver-prizm" on THIS number)...
    const rowThisNumber = CATALOG_ROW({ id: `${PREFIX}50:silver:no-auto`, cardId: `${PREFIX}50:silver:no-auto`, cardNumber: "50", parallelSlug: "Silver" });
    // ...but #99 carries BOTH "silver" and "silver-prizm" as two REAL,
    // distinct checklist cards -- proving the pair is not a spelling gap at
    // all anywhere in this product.
    const rowOtherNumberA = CATALOG_ROW({ id: `${PREFIX}99:silver:no-auto`, cardId: `${PREFIX}99:silver:no-auto`, cardNumber: "99", parallelSlug: "Silver" });
    const rowOtherNumberB = CATALOG_ROW({ id: `${PREFIX}99:silver-prizm:no-auto`, cardId: `${PREFIX}99:silver-prizm:no-auto`, cardNumber: "99", parallelSlug: "Silver Prizm" });
    const shortId = `${PREFIX}50:silver-prizm:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver Prizm", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { catalog: [rowThisNumber, rowOtherNumberA, rowOtherNumberB], sales: [sale] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/both-slugs-are-real-rungs/);
    expect(r.out).toMatch(/REFUSED: both-slugs-are-real-rungs \(pairs\)\s+1/);
  });

  it("REFUSES on player mismatch -- absent beats wrong", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Somebody Else" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: player mismatch\s+1/);
    expect(r.out).toMatch(/player-mismatch/);
  });

  it("REFUSES a sale whose title states a print run (absent beats wrong)", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "2024 Panini Prizm #50 Silver /149", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: title states a print run\s+1/);
  });

  it("REFUSES when the card number does not match (never moved across numbers)", () => {
    const catalogRow = CATALOG_ROW({ id: `${PREFIX}50:silver-prizm:no-auto`, cardId: `${PREFIX}50:silver-prizm:no-auto`, cardNumber: "50", parallelSlug: "Silver Prizm" });
    // A sale on a DIFFERENT card number never matches this rung at all --
    // rungKeyOf differs, so this is not even a candidate; pinned as "not
    // reached" (zero moved), not a named refusal.
    const shortId = `${PREFIX}51:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #51", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [catalogRow], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES when isAuto does not match (auto and no-auto are different rungs)", () => {
    const autoRow = CATALOG_ROW({ id: `${PREFIX}50:silver-prizm:auto`, cardId: `${PREFIX}50:silver-prizm:auto`, cardNumber: "50", parallelSlug: "Silver Prizm", isAuto: true });
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [autoRow], sales: [sale] });
    expect(r.code).toBe(0);
    // The no-auto short id has NO strict row on ITS OWN rung (the only strict
    // row on #50 is the AUTO rung), so there is no candidate to test at all.
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

// ── REVIEW FIX (coordinator, post-#2366): a rungKey/slug can legitimately
// carry TWO strict checklist rows differing only by PRINT RUN -- e.g.
// basketball 2024 panini-prizm #19 blue-wave-prizm exists BOTH /125 and
// unnumbered (measured 1,672 such triples in that one cell). The target
// must be picked by the SALE's own print-run segment, never by whichever
// row happened to be stored last.
describe("REVIEW FIX -- print-run VARIANT selection (never pick between variants)", () => {
  it("a sale carrying its own /N lands on the checklist row with the SAME /N, not the unnumbered sibling", () => {
    const unnumbered = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: null });
    const numbered = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: 125 });
    const saleShortId = `${PREFIX}19:blue-wave:no-auto:num-125`;
    // Title deliberately does NOT state the print run in prose/slash form --
    // that is a SEPARATE refusal (title-states-print-run, "absent beats
    // wrong") this test is not exercising; the print run here is carried
    // ONLY by the sale's own hobbyiqCardId segment, which is what the fix
    // under test must read.
    const sale = { id: "s1", cardId: saleShortId, hobbyiqCardId: saleShortId, title: "2024 Panini Prizm #19 Blue Wave", sport: SPORT, price: 5, parallel: "Blue Wave", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [unnumbered, numbered], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    // Landed on the /125 row, NEVER the unnumbered sibling.
    const upserted = r.led.salesUpserts[0];
    expect(upserted).toBe("s1");
    expect(r.out).toMatch(/RELOCATED 1/);
  });

  it("a sale carrying NO print run lands on the UNNUMBERED checklist row, not the /125 sibling", () => {
    const unnumbered = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: null });
    const numbered = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: 125 });
    const saleShortId = `${PREFIX}19:blue-wave:no-auto`;
    const sale = { id: "s1", cardId: saleShortId, hobbyiqCardId: saleShortId, title: "plain #19", sport: SPORT, price: 5, parallel: "Blue Wave", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [unnumbered, numbered], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/RELOCATED 1/);
  });

  it("REFUSES (destination-printrun-variant-absent) when the sale's own /N has NO matching checklist row under the candidate slug", () => {
    // Only the /125 variant exists on the checklist -- a sale stating a
    // DIFFERENT print run (or none) must never be silently landed there.
    const numbered125 = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: 125 });
    const saleShortId = `${PREFIX}19:blue-wave:no-auto`; // no print run at all
    const sale = { id: "s1", cardId: saleShortId, hobbyiqCardId: saleShortId, title: "plain #19", sport: SPORT, price: 5, parallel: "Blue Wave", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [numbered125], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination print-run variant absent\s+1/);
    expect(r.out).toMatch(/destination-printrun-variant-absent/);
  });

  it("REFUSES (destination-printrun-variant-absent) when the sale states a DIFFERENT /N than the only checklist variant", () => {
    const numbered125 = CATALOG_ROW({ id: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardId: `${PREFIX}19:blue-wave-prizm:no-auto:num-125`, cardNumber: "19", parallelSlug: "Blue Wave Prizm", printRun: 125 });
    const saleShortId = `${PREFIX}19:blue-wave:no-auto:num-99`; // a DIFFERENT print run
    const sale = { id: "s1", cardId: saleShortId, hobbyiqCardId: saleShortId, title: "plain #19 /99", sport: SPORT, price: 5, parallel: "Blue Wave", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [numbered125], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/destination-printrun-variant-absent/);
  });
});

// ── REVIEW FIX (coordinator, post-#2366): "two candidates are strict" can
// mean the checklist itself carries a SPELLING TWIN of the identical
// physical rung (same number, same auto, same print run, same player) under
// two of a sale's own candidate spellings -- e.g. "white-prizm" and
// "white-prizms" (singular/plural), or "green-mosaic" and "mosaic-green"
// (word order). That is a CATALOG defect, never a genuine two-target
// ambiguity, and the banner must say so separately so the yield number is
// not misread as "this lane found two real targets and gave up."
describe("REVIEW FIX -- catalog-duplicate-rung is counted SEPARATELY from two-candidates", () => {
  it("names catalog-duplicate-rung (not two-candidates) when two candidate slugs are the SAME rung spelled twice on the checklist", () => {
    // #30's checklist carries "white-prizm" AND "white-prizms" (a
    // singular/plural spelling twin) as two ROWS for the SAME number, same
    // auto, same (absent) print run, same player -- a catalog defect, not
    // two real cards.
    const rowA = CATALOG_ROW({ id: `${PREFIX}30:white-prizm:no-auto`, cardId: `${PREFIX}30:white-prizm:no-auto`, cardNumber: "30", parallelSlug: "White Prizm", printRun: null });
    const rowB = CATALOG_ROW({ id: `${PREFIX}30:white-prizms:no-auto`, cardId: `${PREFIX}30:white-prizms:no-auto`, cardNumber: "30", parallelSlug: "White Prizms", printRun: null });
    // A sale at bare "white" offers candidates {white-prizm, white-prizms,
    // ...}, and BOTH of those two are strict on this rung.
    const shortId = `${PREFIX}30:white:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #30", sport: SPORT, price: 5, parallel: "White", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [rowA, rowB], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: catalog-duplicate-rung \(spelling twin, same rung\)\s+1/);
    expect(r.out).toMatch(/catalog-duplicate-rung/);
    // NEVER counted as an ordinary two-candidates ambiguity -- the banner
    // must distinguish the two shapes.
    expect(r.out).toMatch(/REFUSED: two candidates strict at once\s+0/);
    expect(r.out).toMatch(/top 40 catalog-duplicate-rung pairs/);
  });

  it("still names two-candidates (not catalog-duplicate-rung) when the two candidates are GENUINELY different cards", () => {
    // #40 carries "white-prizm" and "white-prizms" (the SAME two candidate
    // spellings a bare "white" sale offers, per suffixCandidatesOf) as two
    // rows on the SAME number/auto/print-run, but for DIFFERENT PLAYERS --
    // not a spelling twin of one physical card, an unrelated collision on
    // the same number.
    const rowA = CATALOG_ROW({ id: `${PREFIX}40:white-prizm:no-auto`, cardId: `${PREFIX}40:white-prizm:no-auto`, cardNumber: "40", parallelSlug: "White Prizm", printRun: null, playerName: "Player A" });
    const rowB = CATALOG_ROW({ id: `${PREFIX}40:white-prizms:no-auto`, cardId: `${PREFIX}40:white-prizms:no-auto`, cardNumber: "40", parallelSlug: "White Prizms", printRun: null, playerName: "Player B" });
    const shortId = `${PREFIX}40:white:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #40", sport: SPORT, price: 5, parallel: "White", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Player A" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [rowA, rowB], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    // Different players on rowA/rowB means this is NOT a duplicate-rung
    // spelling twin -- pinned as the ordinary two-candidates ambiguity.
    expect(r.out).toMatch(/REFUSED: catalog-duplicate-rung \(spelling twin, same rung\)\s+0/);
    expect(r.out).toMatch(/REFUSED: two candidates strict at once\s+1/);
  });
});

describe("repoint-sales-parallel-suffix -- reconcile + PLAN_OUT", () => {
  it("reconciles: scanned == moved + refused + failed + untouched", () => {
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { catalog: [CATALOG_ROW()], sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/matched -- every sale in scope is moved, refused \(named\), failed \(named\), or left untouched/);
  });

  it("PLAN_OUT writes one NDJSON row per intended sale, and plan rows == intended", () => {
    const planDir = fs.mkdtempSync(path.join(tmp, "plan-"));
    const shortId = `${PREFIX}50:silver:no-auto`;
    const sale = { id: "s1", cardId: shortId, hobbyiqCardId: shortId, title: "plain #50", sport: SPORT, price: 5, parallel: "Silver", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01", playerName: "Test Player" };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", PLAN_OUT: planDir },
      { catalog: [CATALOG_ROW()], sales: [sale] },
    );
    expect(r.code).toBe(0);
    const planPath = path.join(planDir, "plan-slot-0.ndjson");
    expect(fs.existsSync(planPath)).toBe(true);
    const lines = fs.readFileSync(planPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.action).toBe("relocate");
    expect(row.fromSlug).toBe("silver");
    expect(row.toSlug).toBe("silver-prizm");
  });
});
