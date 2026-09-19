/**
 * CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD -- rekey-catalog-id-to-setkey.cjs's
 * own contract, driven end-to-end against fake card_catalog / sold_comps /
 * portfolio containers.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (catalogRowOps, catalogAuthority, productSetKeys,
 * relocate-sold-comp) loads the REAL compiled dist/, so what these tests pin
 * is what ships, not a re-implementation of it.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "rekey-catalog-id-to-setkey.cjs");
const RUNNER = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rekey-id-setkey-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  // The lane requires dist/ at runtime; skip gracefully if this checkout has
  // not built it (CI always does via `npm run build` before tests).
  const built = fs.existsSync(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const UMBRELLA_ROW = (n: string, over: Record<string, unknown> = {}) => ({
  id: `hiq:hockey:2024:upper-deck:${n}:base:no-auto`,
  cardId: `hiq:hockey:2024:upper-deck:${n}:base:no-auto`,
  hobbyiqCardId: `hiq:hockey:2024:upper-deck:${n}:base:no-auto`,
  sport: "hockey", year: 2024, cardYear: 2024,
  setKey: "upper-deck-extended-series", setName: "Upper Deck Extended Series",
  cardNumber: n, parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null,
  playerName: "Connor Bedard", playerSlug: "connor-bedard",
  vendorIds: {}, source: "checklistinsider-2026-08-27", confidence: 0.9,
  observedAt: "2026-08-27T00:00:00.000Z", lastSeenAt: "2026-08-27T00:00:00.000Z",
  searchTokens: [], searchText: "", displayName: "",
  gradeTier: undefined,
  ...over,
});

const NEW_ID = (n: string) => `hiq:hockey:2024:upper-deck-extended-series:${n}:base:no-auto`;
const OLD_ID = (n: string) => `hiq:hockey:2024:upper-deck:${n}:base:no-auto`;

/**
 * A minimal in-memory Cosmos-shaped store shared across card_catalog,
 * sold_comps, portfolio -- keyed by (container name, id, pk). Query dispatch
 * is pattern-matched on the query TEXT, which is brittle but exactly mirrors
 * how the repo's own fake containers work (see catalogRowOps.test.ts).
 */
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  portfolio?: Array<Record<string, unknown>>;
  /** Sale ROW IDS whose sold_comps upsert must throw -- deterministically
   *  simulating a relocation failure (a network error, a throttled write)
   *  without depending on the real guard's exact malformed-input behaviour. */
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
        if (name === "card_catalog" && q.includes("STARTSWITH(c.id, @prefix)") && q.includes("c.setKey = @target")) {
          resources = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@target"] && String(d.id).startsWith(params["@prefix"]));
        } else if (q.includes("SELECT VALUE COUNT(1) FROM (")) {
          // The verify-by-read wraps candidateSpec's own query text; reuse the
          // same predicate rather than re-deriving it.
          const inner = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@target"] && String(d.id).startsWith(params["@prefix"]));
          resources = [inner.length];
        } else if (q.includes("STARTSWITH(c.id, @p)") && q.includes("IS_DEFINED(c.gradeTier)")) {
          resources = all.filter((d) => String(d.id).startsWith(params["@p"]) && d.gradeTier !== undefined)
            .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
        } else if (q.includes("c.hobbyiqCardId = @s")) {
          resources = all.filter((d) => d.hobbyiqCardId === params["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
        } else if (name === "sold_comps" && q.includes("c.cardId = @o")) {
          resources = all.filter((d) => d.cardId === params["@o"]);
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

describe("rekey-catalog-id-to-setkey -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: "upper-deck-extended-series" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.catalogUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const s of ["refractor", "all"]) {
      const r = drive({ SCOPE: s, SET_KEYS: "upper-deck-extended-series" });
      expect(r.code).toBe(2);
    }
  });

  it("REFUSES an empty SET_KEYS", () => {
    const r = drive({ SCOPE: "hockey:2024", SET_KEYS: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
  });

  it("REFUSES a wildcard SET_KEYS ('all' or '*')", () => {
    for (const v of ["all", "*"]) {
      const r = drive({ SCOPE: "hockey:2024", SET_KEYS: v });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
    }
  });

  it("REFUSES an unregistered target setKey", () => {
    const r = drive({ SCOPE: "hockey:2024", SET_KEYS: "not-a-real-product-key" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unregistered product key/);
  });

  it("accepts the pilot's exact scope and target", () => {
    const r = drive({ SCOPE: "hockey:2024,hockey:2025", SET_KEYS: "upper-deck-extended-series" }, { portfolio: [{ id: "p1", userId: "u1", holdings: {} }] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scope \(2 cells\)/);
    expect(r.out).toMatch(/upper-deck-extended-series \(umbrella upper-deck\)/);
  });
});

describe("rekey-catalog-id-to-setkey -- REPORT writes nothing", () => {
  it("finds the umbrella row and reports a move, but writes zero", () => {
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series" },
      { catalog: [UMBRELLA_ROW("12")], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    // SHOULD-FIX 4: REPORT never contains the APPLY-only relaunch count line.
    expect(r.out).not.toMatch(/^\s*MOVED\s+\d/m);
    expect(r.led.catalogUpserts.length).toBe(0);
    expect(r.led.catalogDeletes.length).toBe(0);
  });

  // CF-REPORT-MUST-PREDICT-APPLY (2026-09-19). The hockey pilot's own REPORT
  // printed "sales relocated 0" while its APPLY, run minutes later, relocated
  // 1,192 partition-keyed sales -- a structural zero (moveCatalogRow never
  // invoked the relocateSales hook under dryRun), never a real forecast. This
  // pins the fix end-to-end: a REPORT run against a partition-keyed sale
  // (cardId === the old id) must count it under "sales would relocate" and
  // still upsert/patch/delete NOTHING anywhere.
  it("counts a partition-keyed sale as 'sales would relocate' and writes zero -- REPORT now predicts APPLY", () => {
    const parent = UMBRELLA_ROW("12");
    // Partitioned AT the old id (cardId === oldId) -- this is the population
    // moveCatalogRow's own salesContainer patch cannot reach at all, and the
    // one the pilot's REPORT structurally under-counted. It also happens to
    // carry hobbyiqCardId === oldId (both addressing schemes can name the
    // same sale, per CF-CARDHEDGE-DUAL-ID), so this row legitimately counts
    // under BOTH "would re-point" (the hobbyiqCardId-keyed patch, which reads
    // regardless of dryRun) and "would relocate" (this lane's own hook).
    const saleRow = { id: "s2", cardId: OLD_ID("12"), hobbyiqCardId: OLD_ID("12"), price: 10, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series" },
      { catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/sales would re-point \(patch, moveCatalogRow\)\s+1/);
    expect(r.out).toMatch(/sales would relocate \(re-key, partition-keyed\)\s+1/);
    // Nothing was written anywhere -- catalog, sales, or portfolio.
    expect(r.led.catalogUpserts.length).toBe(0);
    expect(r.led.catalogDeletes.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.led.portfolioPatches.length).toBe(0);
  });

  it("counts a hobbyiqCardId-keyed sale as 'sales would re-point' and writes zero", () => {
    const parent = UMBRELLA_ROW("12");
    const saleRow = { id: "s1", cardId: "pool-s1", hobbyiqCardId: OLD_ID("12"), price: 10 };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series" },
      { catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sales would re-point \(patch, moveCatalogRow\)\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("a REPORT run's relocation-would-fail case is labelled WOULD FAIL, not FAILED, and still writes zero", () => {
    const parent = UMBRELLA_ROW("12");
    const saleRow = { id: "s-broken", cardId: OLD_ID("12"), hobbyiqCardId: OLD_ID("12"), price: 10, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series" },
      {
        catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }],
        failSalesUpsertForIds: ["s-broken"],
      },
    );
    // relocateSoldComp's own dryRun branch returns before the upsert step, so
    // FAIL_SALES_UPSERT_FOR_IDS never fires under REPORT -- there is no upsert
    // to fail. This confirms the read-only path really is read-only: the
    // deterministic-failure fixture is inert here, proving nothing this
    // function does under dryRun can throw the way the APPLY path can.
    expect(r.out).toMatch(/sales would relocate \(re-key, partition-keyed\)\s+1/);
    expect(r.led.catalogDeletes.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("rekey-catalog-id-to-setkey -- APPLY moves the row", () => {
  it("moves the umbrella row's id onto its own setKey field", () => {
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [UMBRELLA_ROW("12")], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED 1/);
    expect(r.led.catalogUpserts).toContain(NEW_ID("12"));
    expect(r.led.catalogDeletes).toContain(OLD_ID("12"));
  });

  it("moves the row's graded children with it", () => {
    const parent = UMBRELLA_ROW("12");
    const child = {
      id: `${OLD_ID("12")}:psa-10`, cardId: `${OLD_ID("12")}:psa-10`,
      parentSlug: OLD_ID("12"), gradeTier: "psa-10", source: "checklistinsider-2026-08-27-graded",
    };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [parent, child], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.led.catalogDeletes).toContain(`${OLD_ID("12")}:psa-10`);
    expect(r.out).toMatch(/graded children retired \(parent's cascade\)\s+1/);
  });

  it("re-points a sale keyed by hobbyiqCardId (moveCatalogRow's own in-place patch)", () => {
    const parent = UMBRELLA_ROW("12");
    const saleRow = { id: "s1", cardId: "pool-s1", hobbyiqCardId: OLD_ID("12"), price: 10 };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s1")).toBe(true);
    expect(r.out).toMatch(/sales re-pointed \(patch, moveCatalogRow\)\s+1/);
  });

  it("relocates a sale partitioned AT the old id (cardId === oldId) via the upsert-verify-delete primitive", () => {
    const parent = UMBRELLA_ROW("12");
    const saleRow = { id: "s2", cardId: OLD_ID("12"), hobbyiqCardId: OLD_ID("12"), price: 10, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    // relocate-sold-comp keeps the sale's OWN row id ("s2") and rewrites its
    // cardId/hobbyiqCardId fields -- the upsert ledger records the row id,
    // never the card slug, because sold_comps partitions on /cardId and the
    // document id is the sale, not the card.
    expect(r.led.salesUpserts).toContain("s2");
    expect(r.led.salesDeletes).toContain("s2");
    expect(r.out).toMatch(/sales relocated \(re-key, partition-keyed\)\s+1/);
  });

  it("re-points a holding referencing the old id", () => {
    const parent = UMBRELLA_ROW("12");
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: OLD_ID("12"), hobbyiqCardId: OLD_ID("12") } } };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [parent], portfolio: [holdingDoc] },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.some((p: any) => p.id === "p1")).toBe(true);
    expect(r.out).toMatch(/holdings re-pointed\s+1/);
  });

  // ── SHOULD-FIX 3 (review): a real `:sub-<name>:` id, only segment 3 changes.
  it("moves a row with a `:sub-<name>:` segment, preserving it and every later segment byte-for-byte", () => {
    const SUB_OLD = "hiq:hockey:2024:upper-deck:sub-young-guns:201:base:no-auto";
    const SUB_NEW = "hiq:hockey:2024:upper-deck-extended-series:sub-young-guns:201:base:no-auto";
    const row = UMBRELLA_ROW("201", { id: SUB_OLD, cardId: SUB_OLD, hobbyiqCardId: SUB_OLD });
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [row], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.led.catalogUpserts).toContain(SUB_NEW);
    expect(r.led.catalogDeletes).toContain(SUB_OLD);
  });

  // ── BLOCKER 1 (review): a failed partition-keyed relocation keeps the old
  // row -- moveCatalogRow refuses the delete, and this lane counts it FAILED.
  it("counts a failed sale relocation as FAILED and keeps the old catalog row (never deletes it)", () => {
    const parent = UMBRELLA_ROW("12");
    const saleRow = { id: "s-broken", cardId: OLD_ID("12"), hobbyiqCardId: OLD_ID("12"), price: 10, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      {
        catalog: [parent], sales: [saleRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }],
        // Deterministically fail the relocation's upsert step -- simulating a
        // crash/network error mid-relocation without depending on the real
        // guard's malformed-input behaviour.
        failSalesUpsertForIds: ["s-broken"],
      },
    );
    expect(r.code).not.toBe(0);
    // The old catalog row must NOT have been deleted -- moveCatalogRow itself
    // refused the delete because relocateSales reported failure.
    expect(r.led.catalogDeletes).not.toContain(OLD_ID("12"));
    // Nor was the survivor's upsert wasted: the catalog row still exists at
    // the new address (safe on its own), it is only the delete that was held.
    expect(r.led.catalogUpserts).toContain(NEW_ID("12"));
    expect(r.out).toMatch(/FAILED sale relocation/);
  });
});

describe("rekey-catalog-id-to-setkey -- refusals, listed by reason", () => {
  it("refuses target-exists (a fold, out of scope) and writes nothing for that row", () => {
    const parent = UMBRELLA_ROW("12");
    const incumbent = { ...UMBRELLA_ROW("12", { id: NEW_ID("12"), cardId: NEW_ID("12"), hobbyiqCardId: NEW_ID("12"), source: "beckett-scraped-2026-08-19" }) };
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [parent, incumbent], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/target-exists.*\s+1/);
    expect(r.led.catalogDeletes).not.toContain(OLD_ID("12"));
    expect(r.out).toMatch(/REFUSED \(target-exists\)/);
  });

  it("refuses a row whose source is not checklist authority", () => {
    const vendorRow = UMBRELLA_ROW("13", { source: "cardhedge" });
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: [vendorRow], portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not checklist authority\s+1/);
    expect(r.led.catalogDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED \(not-checklist-authority\)/);
  });

  it("a row already matching its own setKey is never even selected (the candidate query requires the umbrella prefix)", () => {
    // A row whose id already stems from its own setKey field cannot match
    // `STARTSWITH(c.id, umbrella-prefix)` -- the umbrella and the target
    // setKey are never the same string (productParentOf(target) != target),
    // so `already-matches` in planRow is defensive code for a shape the real
    // selection query cannot produce. Pinned directly against planRow instead
    // of the end-to-end lane, which cannot construct this candidate at all.
    const { planRow, idParts } = require(LANE);
    const alreadyRow = {
      id: NEW_ID("14"), cardId: NEW_ID("14"), setKey: "upper-deck-extended-series",
      source: "checklistinsider-2026-08-27",
    };
    const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
    const { productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const plan = planRow(alreadyRow, { catalogAuthorityOf, registeredSetKeys: new Set(productSetKeys()) });
    expect(plan.action).toBe("skip");
    expect(plan.reason).toBe("already-matches");
    expect(idParts(NEW_ID("14"))![3]).toBe("upper-deck-extended-series");
  });

  // ── SHOULD-FIX 5 (review): a one-level-drift-only lane refuses (rather than
  // silently moves) a row whose id segment is neither the target nor its
  // registered parent. The real candidate query cannot produce this shape
  // either (STARTSWITH already pins segment 3 to the umbrella), so this is
  // pinned directly against planRow -- the same reasoning as the
  // already-matches test immediately above.
  it("refuses (not-one-level-drift) a row whose id segment is neither the target nor its registered parent", () => {
    const { planRow } = require(LANE);
    const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
    const { productSetKeys, productParentOf } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const deps = {
      catalogAuthorityOf, registeredSetKeys: new Set(productSetKeys()),
      expectedIdSegment: productParentOf("upper-deck-extended-series"), // "upper-deck"
    };
    // A row whose id segment names some THIRD product -- not the target
    // ("upper-deck-extended-series") and not the target's parent ("upper-deck").
    const driftedRow = {
      id: "hiq:hockey:2024:o-pee-chee:12:base:no-auto",
      cardId: "hiq:hockey:2024:o-pee-chee:12:base:no-auto",
      setKey: "upper-deck-extended-series",
      source: "checklistinsider-2026-08-27",
    };
    const plan = planRow(driftedRow, deps);
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("not-one-level-drift");
    expect(plan.detail).toMatch(/neither the target .* nor its registered parent/);
  });

  it("planRow without expectedIdSegment (no deps.expectedIdSegment) does not apply the one-level-drift check -- callers that supply it opt in", () => {
    const { planRow } = require(LANE);
    const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
    const { productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const driftedRow = {
      id: "hiq:hockey:2024:o-pee-chee:12:base:no-auto",
      cardId: "hiq:hockey:2024:o-pee-chee:12:base:no-auto",
      setKey: "upper-deck-extended-series",
      source: "checklistinsider-2026-08-27",
    };
    const plan = planRow(driftedRow, { catalogAuthorityOf, registeredSetKeys: new Set(productSetKeys()) });
    expect(plan.action).toBe("move");
  });
});

describe("rekey-catalog-id-to-setkey -- idempotent re-run", () => {
  it("a second run after APPLY finds nothing left to move (the selection no longer matches)", () => {
    const parent = UMBRELLA_ROW("15");
    const catalogAfterFirstRun = [{ ...parent, id: NEW_ID("15"), cardId: NEW_ID("15"), hobbyiqCardId: NEW_ID("15") }];
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      { catalog: catalogAfterFirstRun, portfolio: [{ id: "p1", userId: "u1", holdings: {} }] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED 0/);
    expect(r.led.catalogUpserts.length).toBe(0);
  });
});

describe("rekey-catalog-id-to-setkey -- reconcile balances", () => {
  it("intended = written + skipped + failed", () => {
    const r = drive(
      { SCOPE: "hockey:2024", SET_KEYS: "upper-deck-extended-series", BACKFILL_APPLY: "true" },
      {
        catalog: [UMBRELLA_ROW("16"), UMBRELLA_ROW("17", { source: "cardhedge" })],
        portfolio: [{ id: "p1", userId: "u1", holdings: {} }],
      },
    );
    const m = r.out.match(/reconciled: intended ([\d,]+) = written ([\d,]+) \+ skipped ([\d,]+) \+ failed ([\d,]+)/);
    expect(m).toBeTruthy();
    const [, intended, written, skipped, failed] = (m as RegExpMatchArray).map((x) => Number(String(x).replace(/,/g, "")));
    expect(intended).toBe(written + skipped + failed);
  });
});

describe("the runner can actually dispatch it", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("is whitelisted in the script dropdown", () => {
    expect(YML).toContain("- rekey-catalog-id-to-setkey");
  });

  it("the generic run step carries SCOPE and BACKFILL_APPLY, which this lane reads", () => {
    expect(YML).toMatch(/^\s+SCOPE: \$\{\{ inputs\.scope \}\}/m);
    expect(YML).toMatch(/^\s+BACKFILL_APPLY: /m);
  });

  it("claims no new workflow_dispatch input", () => {
    const block = YML.slice(YML.indexOf("workflow_dispatch:"), YML.indexOf("jobs:"));
    const inputs = [...block.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "dispatch inputs are frozen at 24 of GitHub's 25").toBeLessThanOrEqual(24);
  });

  it("has a self-relaunch step keyed on the MOVED marker", () => {
    const block = YML.slice(YML.indexOf("rekey-catalog-id-to-setkey"));
    expect(block).toMatch(/MOVED \+\[0-9,\]\+/);
  });

  it("has a log-upload step", () => {
    expect(YML).toMatch(/Upload the id-follows-setkey-field rekey log/);
  });

  it("the workflow file is under GitHub's 512 KB dispatch ceiling", () => {
    const bytes = fs.statSync(RUNNER).size;
    expect(bytes).toBeLessThan(512 * 1024);
  });

  // ── SHOULD-FIX 4 (review): confirm the relaunch DECISION keys only on the
  // budget-stop marker, never on the MOVED/WOULD MOVE count line -- so a
  // REPORT run's WOULD MOVE wording (which the dispatch step's own preamble
  // cannot match) cannot silently change whether the runner re-dispatches.
  it("the relaunch action's actual decision greps only the budget-stop / finishLane lines, never a MOVED count", () => {
    const actionSrc = fs.readFileSync(
      path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml"),
      "utf8",
    );
    const decisionBlock = actionSrc.slice(actionSrc.indexOf("LOG=\"$RELAUNCH_LOG\""));
    expect(decisionBlock).toMatch(/grep -aqE "stopped at the \.\*budget"/);
    expect(decisionBlock).toMatch(/grep -aqE "finishLane: exiting code/);
    // The decision block itself never conditions on a per-lane count line
    // (MOVED, REPAIRED, ...) -- only this lane's OWN dispatch-step preamble
    // (tested above) reads MOVED, purely to populate the notice text.
    expect(decisionBlock).not.toMatch(/MOVED/);
  });
});
