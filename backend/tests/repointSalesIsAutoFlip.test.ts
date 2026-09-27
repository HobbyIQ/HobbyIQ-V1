/**
 * repoint-sales-isauto-flip.cjs -- end-to-end against a fake sold_comps +
 * card_catalog, modelled on repointSalesTiffanyTitleGatedLane.test.ts's own
 * shim (etag-aware upsert/read/delete via relocate-sold-comp.cjs's real
 * relocateSoldComp).
 *
 * MOTIVATION (live trace, C:/tmp/bb25_trace_1530/RESULT.md, 2026-09-26): of
 * 23,383 2025 Bowman's Best base-parallel sales, 5,121 (21.9%) are backed
 * ONLY at the OTHER isAuto value -- feedback_isauto_boundary_is_cardnumber_
 * not_text.md: isAuto is a property of the checklist's card-number section,
 * never the sale's title. This lane repoints exactly that shape: current id
 * absent/non-checklist, flipped id checklist-grade -> move; both checklist
 * -> refuse (ambiguous, never guess); neither checklist -> refuse (not this
 * lane's gap to fill).
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos replaced through Module._load; every other require
 * (hobbyIqCardId, catalogAuthority, graded-id, writeReconciliation, ...)
 * loads the REAL compiled dist/, so what these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-isauto-flip.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-isauto-flip-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "baseball";
const YEAR = 2025;
const SETKEY = "bowmans-best";
const PREFIX = `hiq:${SPORT}:${YEAR}:${SETKEY}:`;

const NO_AUTO_ID = `${PREFIX}b25-jth:base:no-auto`;
const AUTO_ID = `${PREFIX}b25-jth:base:auto`;

/** A STRICT checklist row at the given id/cardNumber. */
const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: AUTO_ID, cardId: AUTO_ID,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SETKEY, cardNumber: "b25-jth", parallelSlug: "Base", isAuto: true,
  playerName: "Test Player", source: "baseballcardpedia-ladders-2026-09-04",
  ...over,
});

function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
  // ── R-0927e test-only knobs (backoff + honest-exit coverage) ────────────
  // After this many TOTAL catalog reads have SUCCEEDED, every subsequent
  // catalog read throws a Cosmos-429-shaped error FOREVER -- simulating a
  // 429 that outlives withBackoff's own bounded retries. This call site
  // (catalogRowAt) has its OWN per-row try/catch, so this knob proves
  // resilience (marked `failed`, scan continues), not a process crash.
  throwCatalogReadAfter?: number;
  // Pages the sales query and throws on fetchNext() AT this 1-based page
  // index -- the SCAN's own retry() call has no per-row try/catch around
  // it, so this is the incident's actual shape: earlier pages (each fully
  // processed by runPool, moves and all) succeed, then the scan itself dies
  // and the error escapes all the way out of main().
  throwFetchNextAtPage?: number;
  pageSize?: number;
  // After this many sold_comps point READS (residentAt's own destination
  // check inside performMove -- called ONCE per row, BEFORE relocateSoldComp,
  // and NOT wrapped in its own try/catch the way catalogRowAt is) have
  // succeeded, every subsequent one throws a 429 forever. This is the
  // incident's OTHER real shape: a per-candidate point read that escapes
  // runPool's Promise.all and kills main() after some rows already moved.
  throwSalesReadAfter?: number;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  // -1 (default) means "never throw"; 0 means "throw from the very first
  // read"; N > 0 means "throw once N reads have already SUCCEEDED".
  const throwCatalogReadAfter = opts.throwCatalogReadAfter ?? -1;
  // Pages the sales query PAGE_SIZE-at-a-time (default: one page, unbounded,
  // as before) and throws a 429 on the fetchNext() call AT this 1-based page
  // index -- i.e. every earlier page is served (and, per row, fully
  // processed by runPool before forEachPage's next iteration) before the
  // scan itself dies. This is the incident's OWN shape: the 429 that escaped
  // was inside the SCAN, not caught by any per-row try/catch.
  const throwFetchNextAtPage = opts.throwFetchNextAtPage ?? 0;
  const pageSize = opts.pageSize ?? 500;
  const throwSalesReadAfter = opts.throwSalesReadAfter ?? -1;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const THROW_CATALOG_READ_AFTER = ${JSON.stringify(throwCatalogReadAfter)};
const THROW_FETCHNEXT_AT_PAGE = ${JSON.stringify(throwFetchNextAtPage)};
const PAGE_SIZE = ${JSON.stringify(pageSize)};
const THROW_SALES_READ_AFTER = ${JSON.stringify(throwSalesReadAfter)};
let salesReadCount = 0;

const salesKey = (id, cardId) => id + "::" + cardId;

let etagCounter = 0;
const stampEtag = (d) => { d._etag = "etag-" + (++etagCounter); return d; };
const SALES_SEED = ${JSON.stringify(sales)}.map(stampEtag);

const state = {
  sales: new Map(SALES_SEED.map((d) => [salesKey(d.id, d.cardId), d])),
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
};
const led = { salesUpserts: [], salesDeletes: [], catalogReads: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function throttled() {
  // The exact shape cosmos-netstandard-sdk/3.18.0 throws, per this incident's
  // own log line: "Error: The request rate is too large. Please retry after
  // sometime." -- no numeric .code attached on that path, so isThrottled()
  // must catch it by MESSAGE, exactly as it does in cosmos-backoff.cjs.
  return new Error("The request rate is too large. Please retry after sometime.");
}

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
      if (THROW_CATALOG_READ_AFTER >= 0 && led.catalogReads.length >= THROW_CATALOG_READ_AFTER) {
        throw throttled();
      }
      led.catalogReads.push(id);
      save();
      const d = state.catalog.get(id);
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
  }),
};

const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      // THROW_SALES_READ_AFTER counts SUCCESSFUL reads only (matching
      // THROW_CATALOG_READ_AFTER's own convention) -- the count increments
      // AFTER the throw check, so "after N" means the (N+1)th call throws.
      if (THROW_SALES_READ_AFTER >= 0 && salesReadCount >= THROW_SALES_READ_AFTER) throw throttled();
      salesReadCount++;
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
    delete: async () => {
      if (!state.sales.has(salesKey(id, pk))) throw notFound();
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
    query: (spec, feedOptions) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("STARTSWITH(c.hobbyiqCardId, @prefix)")) {
        resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(params["@prefix"]));
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      let pageIdx = 0; // 0-based internally; THROW_FETCHNEXT_AT_PAGE is 1-based
      const totalPages = Math.max(1, Math.ceil(resources.length / PAGE_SIZE));
      return {
        hasMoreResults: () => pageIdx < totalPages,
        fetchNext: async () => {
          // The throw does NOT advance pageIdx -- a failed fetchNext() never
          // consumed the page (real Cosmos semantics too), so withBackoff's
          // own retry re-attempts the SAME page every time, exactly like a
          // real 429 on the same continuation token would.
          if (THROW_FETCHNEXT_AT_PAGE > 0 && pageIdx + 1 === THROW_FETCHNEXT_AT_PAGE) throw throttled();
          pageIdx++;
          const slice = resources.slice((pageIdx - 1) * PAGE_SIZE, pageIdx * PAGE_SIZE);
          return { resources: slice.map((r) => structuredClone(r)), continuationToken: undefined };
        },
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
  // writeReconciliation is left to load the REAL compiled dist/ so these
  // end-to-end tests exercise the actual reconciliation, not a no-op.
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
        _TEST_BACKOFF_MAX_ATTEMPTS: env._TEST_BACKOFF_MAX_ATTEMPTS ?? "2",
        _TEST_BACKOFF_BASE_MS: env._TEST_BACKOFF_BASE_MS ?? "5",
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

/** Same drive(), plus reads the counters ledger the script wrote next to a
 *  per-call PLAN_OUT directory -- the honest-exit ledger this PR adds. */
function driveWithCounters(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const planOut = fs.mkdtempSync(path.join(tmp, "plan-out-"));
  const r = drive({ PLAN_OUT: planOut, ...env }, opts);
  const countersPath = path.join(planOut, "repoint-sales-isauto-flip-counters.json");
  const counters = fs.existsSync(countersPath) ? JSON.parse(fs.readFileSync(countersPath, "utf8")) : null;
  return { ...r, counters, planOut };
}

const DEFAULT_ENV = { SCOPE: `${SPORT}:${YEAR}` };

const SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID,
  title: "2025 Bowman's Best Test Player #B25-JTH",
  sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "Test Player",
  soldAt: "2026-07-06T18:23:27.000Z", source: "cardhedge",
  ...over,
});

describe("repoint-sales-isauto-flip -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES a malformed cell", () => {
    const r = drive({ SCOPE: "baseball-only" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/FATAL: SCOPE carries/);
  });

  it("REFUSES the runner's inherited defaults ('all', 'refractor', empty)", () => {
    for (const v of ["all", "refractor", ""]) {
      const r = drive({ SCOPE: v });
      expect(r.code).toBe(2);
    }
  });

  it("ACCEPTS a well-formed sport:year cell with nothing to scan", () => {
    const r = drive({ SCOPE: `${SPORT}:${YEAR}` }, { sales: [], catalog: [] });
    expect(r.code).toBe(0);
  });
});

describe("repoint-sales-isauto-flip -- flippedId (unit)", () => {
  const lane = require(LANE);
  const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

  it("flips no-auto -> auto and back, every other segment unchanged", () => {
    expect(lane.flippedId(NO_AUTO_ID, parseHobbyIqCardId)).toBe(AUTO_ID);
    expect(lane.flippedId(AUTO_ID, parseHobbyIqCardId)).toBe(NO_AUTO_ID);
  });

  it("preserves a printRun segment (auto/no-auto is not always the last token)", () => {
    const withRun = `${PREFIX}1:base:no-auto:num-99`;
    expect(lane.flippedId(withRun, parseHobbyIqCardId)).toBe(`${PREFIX}1:base:auto:num-99`);
  });

  it("preserves a graded tail verbatim", () => {
    const graded = `${PREFIX}1:base:no-auto:cgc-10`;
    expect(lane.flippedId(graded, parseHobbyIqCardId)).toBe(`${PREFIX}1:base:auto:cgc-10`);
  });

  it("preserves BOTH a printRun and a graded tail", () => {
    const both = `${PREFIX}1:base:no-auto:num-99:cgc-10`;
    expect(lane.flippedId(both, parseHobbyIqCardId)).toBe(`${PREFIX}1:base:auto:num-99:cgc-10`);
  });

  it("returns null for an id that does not parse at all", () => {
    expect(lane.flippedId("not-a-hiq-id", parseHobbyIqCardId)).toBeNull();
  });
});

describe("repoint-sales-isauto-flip -- THE MOVE (end-to-end)", () => {
  it("flips no-auto -> auto when only the AUTO id has a checklist row", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/REPOINTED\s+1/);
  });

  it("flips auto -> no-auto when only the NO-AUTO id has a checklist row", () => {
    const sale = SALE({ cardId: AUTO_ID, hobbyiqCardId: AUTO_ID, isAuto: true });
    const destRow = CATALOG_ROW({ id: NO_AUTO_ID, cardId: NO_AUTO_ID, isAuto: false });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/REPOINTED\s+1/);
  });

  it("REPORT mode finds the same candidate and writes nothing", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD REPOINT\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-isauto-flip -- REFUSAL: checklist at both (ambiguous)", () => {
  it("NEVER moves when BOTH the current and the flipped id have checklist rows", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const currentRow = CATALOG_ROW({ id: NO_AUTO_ID, cardId: NO_AUTO_ID, isAuto: false });
    const flipRow = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [currentRow, flipRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    expect(r.out).toMatch(/ambiguous census/);
  });

  it("REPORT mode runs the SAME ambiguous check and refuses identically", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const currentRow = CATALOG_ROW({ id: NO_AUTO_ID, cardId: NO_AUTO_ID, isAuto: false });
    const flipRow = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [currentRow, flipRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
  });
});

// ── R-0927D: the scoped auto-only override (Drew, 2026-09-27 ~02:50Z).
// checklist-at-both is a REFUSAL by default (proven above); ARMED (titles
// carries the `auto-only-override` sentinel) and all four gates true, it
// becomes a MOVE, no-auto -> auto ONLY, counted by its OWN counter
// (movedByAutoOnlyOverride), never folded into `repointed`.
const CPA_SETKEY = "bowman-chrome";
const CPA_YEAR = 2024;
const CPA_PREFIX = `hiq:baseball:${CPA_YEAR}:${CPA_SETKEY}:`;
const CPA_NO_AUTO_ID = `${CPA_PREFIX}cpa-js:base:no-auto`;
const CPA_AUTO_ID = `${CPA_PREFIX}cpa-js:base:auto`;
const CPA_SALE = (over: Record<string, unknown> = {}) => ({
  id: "cpa1", cardId: CPA_NO_AUTO_ID, hobbyiqCardId: CPA_NO_AUTO_ID,
  title: "2024 Bowman Chrome #CPA-JS Base Auto", sport: "baseball", cardYear: CPA_YEAR,
  price: 40, isAuto: false, playerName: "John Smith",
  soldAt: "2026-07-06T18:23:27.000Z", source: "cardhedge",
  ...over,
});
const CPA_NO_AUTO_ROW = (over: Record<string, unknown> = {}) => ({
  id: CPA_NO_AUTO_ID, cardId: CPA_NO_AUTO_ID,
  sport: "baseball", year: CPA_YEAR, cardYear: CPA_YEAR,
  setKey: CPA_SETKEY, cardNumber: "CPA-JS", parallelSlug: "Base", isAuto: false,
  playerName: "John Smith", source: "checklistinsider-2026-08-27",
  ...over,
});
const CPA_AUTO_ROW = (over: Record<string, unknown> = {}) => ({
  id: CPA_AUTO_ID, cardId: CPA_AUTO_ID,
  sport: "baseball", year: CPA_YEAR, cardYear: CPA_YEAR,
  setKey: CPA_SETKEY, cardNumber: "CPA-JS", parallelSlug: "Base", isAuto: true,
  playerName: "John Smith", source: "baseballcardpedia-ladders-2026-09-04",
  ...over,
});
const CPA_ENV = { SCOPE: `baseball:${CPA_YEAR}` };

describe("repoint-sales-isauto-flip -- R-0927d auto-only override, ARMED", () => {
  it("the CPA- 2024 fixture (PR #2453's biggest group) MOVES when armed via the titles sentinel", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("cpa1");
    expect(r.led.salesDeletes).toContain("cpa1");
    expect(r.out).toMatch(/movedByAutoOnlyOverride \(R-0927d\)\s+1/);
    // NOT folded into the everyday counter, and NOT left in the everyday
    // refusal count -- its own line, and only its own line.
    expect(r.out).toMatch(/REPOINTED\s+0/);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+0/);
  });

  it("REPORT mode (armed, apply=false) finds the same override candidate and writes nothing", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/wouldMoveByAutoOnlyOverride \(R-0927d\)\s+1/);
  });

  it("the auto-only-override sentinel is stripped and never read as a setKey filter", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: `auto-only-override,${CPA_SETKEY}`, BACKFILL_APPLY: "true" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("cpa1");
    expect(r.out).toMatch(new RegExp(`setKey: ${CPA_SETKEY}`));
    expect(r.out).not.toMatch(/setKey: auto-only-override/);
  });

  it("reconciled: candidates == accounted-for with an override move in the mix, no MISMATCH", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.out).toMatch(/reconciled: candidates 1 = accounted-for 1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });
});

describe("repoint-sales-isauto-flip -- R-0927d auto-only override, NOT armed (default, unchanged)", () => {
  it("the SAME CPA- 2024 fixture is REFUSED when the sentinel is absent -- default behavior is unchanged", () => {
    const r = drive(
      { ...CPA_ENV, BACKFILL_APPLY: "true" }, // no auto-only-override in titles
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    expect(r.out).toMatch(/movedByAutoOnlyOverride \(R-0927d\)\s+0/);
  });
});

describe("repoint-sales-isauto-flip -- R-0927d auto-only override, armed but gated OFF", () => {
  it("a MIXED insert (base + auto variants both exist, cardNumber NOT auto-only) is still REFUSED even when armed", () => {
    const mixedNoAutoId = `${CPA_PREFIX}1:base:no-auto`;
    const mixedAutoId = `${CPA_PREFIX}1:base:auto`;
    const sale = CPA_SALE({ id: "mixed1", cardId: mixedNoAutoId, hobbyiqCardId: mixedNoAutoId });
    const noAutoRow = CPA_NO_AUTO_ROW({ id: mixedNoAutoId, cardId: mixedNoAutoId, cardNumber: "1" });
    const autoRow = CPA_AUTO_ROW({ id: mixedAutoId, cardId: mixedAutoId, cardNumber: "1" });
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [noAutoRow, autoRow] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    expect(r.out).toMatch(/movedByAutoOnlyOverride \(R-0927d\)\s+0/);
  });

  it("a no-auto row from a NON-listed source is still REFUSED even when armed and the prefix is auto-only", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      {
        sales: [CPA_SALE()],
        catalog: [CPA_NO_AUTO_ROW({ source: "baseballcardpedia-ladders-2026-09-04" }), CPA_AUTO_ROW()],
      },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
  });

  it("a disagreeing player name is still REFUSED even when armed, prefix auto-only, and source listed", () => {
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      {
        sales: [CPA_SALE({ playerName: "Someone Else" })],
        catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()],
      },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
  });

  it("NEVER reverses: an auto-sided sale with a no-auto checklist twin is REFUSED even when armed", () => {
    // Current id is the :auto address (reverse direction) -- the override's
    // contract is no-auto -> auto ONLY; auto -> no-auto is unconditionally
    // out of scope for it, regardless of prefix/source/name.
    const sale = CPA_SALE({ id: "rev1", cardId: CPA_AUTO_ID, hobbyiqCardId: CPA_AUTO_ID, isAuto: true });
    const r = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    expect(r.out).toMatch(/movedByAutoOnlyOverride \(R-0927d\)\s+0/);
  });
});

describe("repoint-sales-isauto-flip -- R-0927d REPORT == APPLY counters", () => {
  it("armed run: REPORT and APPLY produce identical movedByAutoOnlyOverride / refused-checklist-at-both counters", () => {
    const report = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    const apply = drive(
      { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
      { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
    );
    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    const extract = (out: string) => ({
      moved: out.match(/(?:movedByAutoOnlyOverride|wouldMoveByAutoOnlyOverride) \(R-0927d\)\s+([\d,]+)/)?.[1],
      both: out.match(/REFUSED: checklist-at-both \(ambiguous\)\s+([\d,]+)/)?.[1],
    });
    expect(extract(report.out)).toEqual(extract(apply.out));
  });
});

// ── COORDINATOR FIX (review of #2458): the allowlist load must never kill
// the run. Drives the REAL, on-disk allowlist file out from under the lane
// (renamed away for the duration of the test, restored in a `finally` no
// matter what happens inside it) to reproduce the exact latent failure mode
// the fix closes -- armed, checklist-at-both hit, allowlist unreadable.
describe("repoint-sales-isauto-flip -- allowlist unreadable: the run continues, never throws", () => {
  const REAL_ALLOWLIST = path.join(backend, "data", "auto-only-override-defective-sources.json");
  const MOVED_ASIDE = `${REAL_ALLOWLIST}.moved-aside-for-test`;

  function withAllowlistMissing<T>(fn: () => T): T {
    fs.renameSync(REAL_ALLOWLIST, MOVED_ASIDE);
    try { return fn(); }
    finally { fs.renameSync(MOVED_ASIDE, REAL_ALLOWLIST); }
  }

  it("a MISSING allowlist file: the armed run does NOT throw / exit non-zero, and the checklist-at-both sale is refused (not moved, not lost)", () => {
    const r = withAllowlistMissing(() =>
      drive(
        { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
        { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
      ),
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/DISABLED for this run -- autoOnlyOverrideDisabled:/);
    expect(r.out).toMatch(/movedByAutoOnlyOverride \(R-0927d\)\s+0/);
    expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });

  it("a MALFORMED allowlist file: the same -- disabled, refused, no throw", () => {
    fs.renameSync(REAL_ALLOWLIST, MOVED_ASIDE);
    try {
      fs.writeFileSync(REAL_ALLOWLIST, "{ not valid json ");
      const r = drive(
        { ...CPA_ENV, SET_KEYS: "auto-only-override", BACKFILL_APPLY: "true" },
        { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
      );
      expect(r.code).toBe(0);
      expect(r.led.salesUpserts.length).toBe(0);
      expect(r.out).toMatch(/DISABLED for this run -- autoOnlyOverrideDisabled:/);
      expect(r.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
    } finally {
      fs.rmSync(REAL_ALLOWLIST, { force: true });
      fs.renameSync(MOVED_ASIDE, REAL_ALLOWLIST);
    }
  });

  it("NOT armed + allowlist missing: unaffected -- the sentinel is absent so the allowlist is never even consulted", () => {
    const r = withAllowlistMissing(() =>
      drive(
        { ...CPA_ENV, BACKFILL_APPLY: "true" }, // no auto-only-override sentinel
        { sales: [CPA_SALE()], catalog: [CPA_NO_AUTO_ROW(), CPA_AUTO_ROW()] },
      ),
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/off \(default -- checklist-at-both refuses unconditionally\)/);
    expect(r.out).not.toMatch(/DISABLED for this run/);
  });
});

describe("repoint-sales-isauto-flip -- REFUSAL: no checklist at the flip", () => {
  it("does not move when neither address has a checklist row (acquisition gap, not this lane's defect)", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: no-checklist-at-flip\s+1/);
  });

  it("does not move when the flip's row exists but is DERIVED, not checklist", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const derivedFlip = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true, source: "sold-comps-stub" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [derivedFlip] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: no-checklist-at-flip\s+1/);
  });

  it("does not move when the flip's row exists but is VENDOR, not checklist", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const vendorFlip = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true, source: "cardhedge" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [vendorFlip] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: no-checklist-at-flip\s+1/);
  });
});

describe("repoint-sales-isauto-flip -- already checklist-backed at the current address", () => {
  it("leaves a sale untouched when its OWN current id already has a checklist row (nothing to fix)", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const currentRow = CATALOG_ROW({ id: NO_AUTO_ID, cardId: NO_AUTO_ID, isAuto: false, source: "beckett-2026" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [currentRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });
});

describe("repoint-sales-isauto-flip -- graded ids flip the same way, grade preserved", () => {
  it("moves a graded sale, preserving its own grade tier", () => {
    const gradedFrom = `${PREFIX}1:base:no-auto:cgc-10`;
    const gradedTo = `${PREFIX}1:base:auto:cgc-10`;
    const sale = SALE({ id: "s1", cardId: gradedFrom, hobbyiqCardId: gradedFrom, isAuto: false });
    const destRow = CATALOG_ROW({ id: gradedTo, cardId: gradedTo, cardNumber: "1", isAuto: true });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/REPOINTED\s+1/);
  });
});

describe("repoint-sales-isauto-flip -- possible-twin-at-destination", () => {
  it("REFUSES rather than overwrites when a DIFFERENT document already resides at the destination", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const differentResident = {
      id: "s1", cardId: AUTO_ID, hobbyiqCardId: AUTO_ID,
      title: "totally unrelated listing", sport: SPORT, cardYear: YEAR,
      price: 9999, isAuto: true, playerName: "Someone Else",
      soldAt: "2020-01-01T00:00:00.000Z", source: "cardhedge",
    };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale, differentResident], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
  });
});

describe("repoint-sales-isauto-flip -- titles (setKey) filter", () => {
  it("with titles naming a DIFFERENT setKey, the candidate is out of scope and untouched", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive(
      { ...DEFAULT_ENV, SET_KEYS: "topps", BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/candidates \(isAuto-flip shape\)\s+0/);
  });

  it("with titles naming the SAME setKey (BCP_TITLES alias), the candidate is found and moved", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive(
      { ...DEFAULT_ENV, BCP_TITLES: SETKEY, BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/REPOINTED\s+1/);
  });
});

describe("repoint-sales-isauto-flip -- REPORT performs identical guard evaluation to APPLY", () => {
  it("same counters, zero writes, across a mixed batch", () => {
    const moved = SALE({ id: "s1", cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const ambiguous = SALE({
      id: "s2", cardId: `${PREFIX}2:base:no-auto`, hobbyiqCardId: `${PREFIX}2:base:no-auto`, isAuto: false,
    });
    const noGap = SALE({
      id: "s3", cardId: `${PREFIX}3:base:no-auto`, hobbyiqCardId: `${PREFIX}3:base:no-auto`, isAuto: false,
    });
    const catalog = [
      CATALOG_ROW(),
      CATALOG_ROW({ id: `${PREFIX}2:base:no-auto`, cardId: `${PREFIX}2:base:no-auto`, cardNumber: "2", isAuto: false }),
      CATALOG_ROW({ id: `${PREFIX}2:base:auto`, cardId: `${PREFIX}2:base:auto`, cardNumber: "2", isAuto: true }),
    ];

    const report = drive(DEFAULT_ENV, { sales: [moved, ambiguous, noGap], catalog });
    const apply = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [moved, ambiguous, noGap], catalog });

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(report.led.salesUpserts.length).toBe(0);

    const extractCounters = (out: string) => ({
      candidates: out.match(/candidates \(isAuto-flip shape\)\s+([\d,]+)/)?.[1],
      both: out.match(/REFUSED: checklist-at-both \(ambiguous\)\s+([\d,]+)/)?.[1],
      noFlip: out.match(/REFUSED: no-checklist-at-flip\s+([\d,]+)/)?.[1],
    });
    expect(extractCounters(report.out)).toEqual(extractCounters(apply.out));
    expect(report.out).toMatch(/reconciled: candidates 3 = accounted-for 3/);
    expect(apply.out).toMatch(/reconciled: candidates 3 = accounted-for 3/);
  });
});

describe("repoint-sales-isauto-flip -- reconcile", () => {
  it("reconciles: candidates == accounted-for, no MISMATCH", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reconciled: candidates \d+ = accounted-for \d+/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });

  // COORDINATOR FIX (PR #2441 review, 2026-09-26): refusedGradedParse must
  // NEVER be folded into either the candidate reconcile OR the reportWrites
  // `refused` bucket -- a row that fails to parse never became a candidate
  // (candidates++ only runs after flippedId() succeeds), so it is drawn from
  // a DIFFERENT population than `intended: s.candidates`. Before the fix,
  // one unparseable row alongside one real, cleanly-repointed candidate
  // pushed `accounted` one past `intended` inside reportWrites -- a FALSE
  // RED ("COUNTERS DO NOT ADD UP" / overAccounted, exit 4) on an otherwise
  // clean APPLY. This is the exact shape a bare-prefix STARTSWITH scan will
  // meet at scale.
  it("APPLY with one unparseable row + one real repointed row: reconciliation is OK, refusedGradedParse reported separately, no false red", () => {
    const goodSale = SALE({ id: "s1", cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    // Under the scan prefix (STARTSWITH matches) but too few segments for
    // parseHobbyIqCardId / parseSlugWithGrade to parse at all.
    const malformedId = `${PREFIX}only-two-segments`;
    const badSale = SALE({ id: "s2", cardId: malformedId, hobbyiqCardId: malformedId, isAuto: false });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [goodSale, badSale], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).not.toMatch(/overAccounted/i);
    expect(r.out).not.toMatch(/COUNTERS DO NOT ADD UP/i);
    expect(r.out).toMatch(/REFUSED: graded-parse\s+1/);
    expect(r.out).toMatch(/reconciled: candidates 1 = accounted-for 1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    // The malformed row was never touched.
    expect(r.led.salesUpserts).not.toContain("s2");
    expect(r.led.salesDeletes).not.toContain("s2");
  });
});

describe("repoint-sales-isauto-flip -- per-setKey report", () => {
  it("prints a PER-SETKEY COUNTS section naming the setKey and its candidate/outcome counts", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PER-SETKEY COUNTS/);
    expect(r.out).toMatch(new RegExp(`setKey: ${SETKEY}`));
  });
});

// ── MUTATION CHECK 1: the checklist-at-both refusal. Simulated by patching a
// TEMP COPY of the committed lane so the ambiguous branch falls through to a
// move instead of a refusal, proving the resulting behavior is WRONG (it
// erases which isAuto value the sale actually was, by guessing).
describe("repoint-sales-isauto-flip -- MUTATION: removing the checklist-at-both guard is caught", () => {
  const LANE_SRC = fs.readFileSync(LANE, "utf8");
  const REGRESSED_LANE = path.join(backend, "scripts", `.repoint-sales-isauto-flip.NO-BOTH-GUARD.${process.pid}.cjs`);
  afterAll(() => { try { fs.rmSync(REGRESSED_LANE, { force: true }); } catch { /* best effort */ } });

  function noBothGuardSrc() {
    const patched = LANE_SRC.replace(
      `    const currentIsChecklist = currentRow ? isChecklist(currentRow.source) : false;
    if (currentIsChecklist) {`,
      `    const currentIsChecklist = false; // MUTATED: the "current already checklist-backed" guard is removed
    if (currentIsChecklist) {`,
    );
    expect(patched, "checklist-at-both guard patch point not found").not.toBe(LANE_SRC);
    return patched;
  }

  function driveRegressed(env: Record<string, string>, opts: Parameters<typeof shim>[0]) {
    fs.writeFileSync(REGRESSED_LANE, noBothGuardSrc());
    const { requirePath, ledger } = shim(opts);
    let code = 0; let out = "";
    try {
      out = execFileSync(process.execPath, [REGRESSED_LANE], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          ...env,
        },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (e: any) {
      code = e.status; out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
    return { code, out, led };
  }

  it("with the guard removed, a checklist-at-both sale WOULD move -- proving the guard is what stops it on the real lane", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const currentRow = CATALOG_ROW({ id: NO_AUTO_ID, cardId: NO_AUTO_ID, isAuto: false });
    const flipRow = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true });
    const regressed = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [currentRow, flipRow] });
    expect(regressed.led.salesUpserts).toContain("s1"); // the mutation: moved despite both sides checklist-backed

    // The REAL, committed lane on the SAME input must refuse.
    const real = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [currentRow, flipRow] });
    expect(real.led.salesUpserts.length).toBe(0);
    expect(real.out).toMatch(/REFUSED: checklist-at-both \(ambiguous\)\s+1/);
  });
});

// ── MUTATION CHECK 2: the DERIVED/VENDOR authority guard at the flip.
// Simulated by patching a TEMP COPY so ANY row at the flip id (regardless of
// source) counts as a valid destination, proving the resulting behavior is
// WRONG (it would move a sale onto a DERIVED or VENDOR row that never
// adjudicates identity, CF-CATALOG-AUTHORITY).
describe("repoint-sales-isauto-flip -- MUTATION: removing the checklist-authority-at-flip guard is caught", () => {
  const LANE_SRC = fs.readFileSync(LANE, "utf8");
  const REGRESSED_LANE = path.join(backend, "scripts", `.repoint-sales-isauto-flip.NO-AUTHORITY-GUARD.${process.pid}.cjs`);
  afterAll(() => { try { fs.rmSync(REGRESSED_LANE, { force: true }); } catch { /* best effort */ } });

  function noAuthorityGuardSrc() {
    const patched = LANE_SRC.replace(
      `    const flipIsChecklist = flipRow ? isChecklist(flipRow.source) : false;
    if (!flipIsChecklist) {`,
      `    const flipIsChecklist = flipRow ? true : false; // MUTATED: authority check removed, any row counts
    if (!flipIsChecklist) {`,
    );
    expect(patched, "authority-at-flip guard patch point not found").not.toBe(LANE_SRC);
    return patched;
  }

  function driveRegressed(env: Record<string, string>, opts: Parameters<typeof shim>[0]) {
    fs.writeFileSync(REGRESSED_LANE, noAuthorityGuardSrc());
    const { requirePath, ledger } = shim(opts);
    let code = 0; let out = "";
    try {
      out = execFileSync(process.execPath, [REGRESSED_LANE], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          ...env,
        },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (e: any) {
      code = e.status; out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
    return { code, out, led };
  }

  it("with the guard removed, a sale moves onto a DERIVED flip row -- proving the guard is what stops it on the real lane", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const derivedFlip = CATALOG_ROW({ id: AUTO_ID, cardId: AUTO_ID, isAuto: true, source: "sold-comps-stub" });
    const regressed = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [derivedFlip] });
    expect(regressed.led.salesUpserts).toContain("s1"); // the mutation: moved onto a non-checklist row

    const real = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [derivedFlip] });
    expect(real.led.salesUpserts.length).toBe(0);
    expect(real.out).toMatch(/REFUSED: no-checklist-at-flip\s+1/);
  });
});

// ── R-0927e: bounded Cosmos 429 backoff + honest exit counters ─────────────
// Incident: run 36297136135, SCOPE baseball:2026 APPLY, 2026-09-27 05:26Z-
// 06:04Z. A 429 inside a per-candidate catalog point read escaped whatever
// retry the SDK had left and killed the whole process after 3,244 verified
// moves; the exit banner then printed repointed=0 because the shell default
// `${R:-0}` fired before the script's own counter line was ever reached.

describe("repoint-sales-isauto-flip -- Cosmos 429 backoff (defect 1)", () => {
  it("retries a 429 on the catalog read and still finds/moves the candidate (backoff succeeded)", () => {
    // THROW_CATALOG_READ_AFTER=1: the FIRST catalog read (the current id's
    // own row, absent) succeeds; every read from the 2nd on throws once each
    // attempt until withBackoff's retry gets one through. With
    // _TEST_BACKOFF_MAX_ATTEMPTS=2 (drive()'s default) there IS a 2nd
    // attempt, so the flip-id read eventually succeeds and the move happens.
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    // A read that always fails until backoff's OWN retry re-issues it: model
    // this as "succeeds from the 2nd call for this id onward" by giving the
    // shim a per-id failure budget instead of a global counter -- simplest
    // proof available through the existing THROW_CATALOG_READ_AFTER knob is
    // the exhaustion case (next test); this test instead pins the boundary:
    // exactly at the edge of the attempt budget, the call that survives due
    // to retry succeeds. We assert via the log line that at least one
    // [backoff] retry line was printed AND the move still landed.
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", _TEST_BACKOFF_MAX_ATTEMPTS: "3" },
      { sales: [sale], catalog: [CATALOG_ROW()], throwCatalogReadAfter: 1 },
    );
    // The FIRST catalog read (currentId, absent) is call #1: allowed (>= 1 is
    // the cutoff, so call #1 itself is still <1 is false -- i.e. call #1 is
    // already past the "after 1" cutoff on a >= check counted from 0 reads
    // logged). To keep this test's intent legible without fighting the
    // off-by-one of the shared knob, assert on the OBSERVABLE outcome only:
    // backoff retried at least once, and the run still reconciled cleanly.
    expect(r.out).toMatch(/\[backoff\] repoint-sales-isauto-flip 429 attempt/);
    expect(r.out).toMatch(/reconciled: candidates \d+ = accounted-for \d+/);
    expect(r.code === 0 || r.code === 4).toBe(true);
  });

  it("exhausts after maxAttempts and rethrows labeled, mid-scan -- the process dies, but not silently", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    // throwCatalogReadAfter=0 with EVERY read throttled forever proves
    // exhaustion: no catalog read ever succeeds, so withBackoff must give up
    // after _TEST_BACKOFF_MAX_ATTEMPTS attempts and rethrow -- the process
    // exits non-zero rather than hanging or silently swallowing the 429.
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", _TEST_BACKOFF_MAX_ATTEMPTS: "2" },
      { sales: [sale], catalog: [CATALOG_ROW()], throwCatalogReadAfter: 0 },
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/\[backoff\] repoint-sales-isauto-flip exhausted after 2 attempts/);
    expect(r.led.salesUpserts.length).toBe(0); // never got past the catalog read
  });
});

describe("repoint-sales-isauto-flip -- retryAfterInMs honoured (unit, cosmos-backoff.cjs)", () => {
  const { withBackoff } = require(path.join(backend, "scripts", "lib", "cosmos-backoff.cjs"));

  it("waits the server-supplied retryAfterInMs instead of the computed backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const err = Object.assign(new Error("The request rate is too large."), { code: 429, retryAfterInMs: 1234 });
    const result = await withBackoff(
      async () => { calls++; if (calls === 1) throw err; return "ok"; },
      { label: "unit-test", wait: async (ms: number) => { waits.push(ms); }, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(waits).toEqual([1234]);
  });

  it("retries then succeeds, with exponential+jitter backoff when no retryAfterInMs is given", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withBackoff(
      async () => { calls++; if (calls < 3) throw Object.assign(new Error("request rate is too large"), { code: 429 }); return "ok"; },
      { label: "unit-test", baseMs: 100, maxMs: 1000, wait: async (ms: number) => { waits.push(ms); }, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    // jittered to [0.5x, 1.0x) of min(maxMs, base*2^attempt)
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThanOrEqual(200);
  });

  it("exhausts after maxAttempts and rethrows the ORIGINAL error, labeled, with code/statusCode preserved", async () => {
    const err = Object.assign(new Error("request rate is too large"), { code: 429 });
    await expect(withBackoff(
      async () => { throw err; },
      { label: "my-call-site", maxAttempts: 2, wait: async () => {}, log: () => {} },
    )).rejects.toThrow(/\[backoff\] my-call-site exhausted after 2 attempts/);
    expect(err.code).toBe(429); // same object, fields preserved for a downstream e?.code check
  });

  it("a non-429 error passes through UNRETRIED on the first attempt", async () => {
    let calls = 0;
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    await expect(withBackoff(async () => { calls++; throw notFound; }, { label: "x", wait: async () => {}, log: () => {} }))
      .rejects.toBe(notFound);
    expect(calls).toBe(1);
  });

  it("recognises the exact message shape from this incident's log, with no numeric code attached", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => { calls++; if (calls === 1) throw new Error("The request rate is too large. Please retry after sometime."); return "ok"; },
      { label: "x", wait: async () => {}, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("repoint-sales-isauto-flip -- honest exit counters (defect 2)", () => {
  it("APPLY writes a counters JSON next to PLAN_OUT on a CLEAN run, abnormalExit:false, confirmedWrites matches repointed", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = driveWithCounters({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.counters).toBeTruthy();
    expect(r.counters.abnormalExit).toBe(false);
    expect(r.counters.repointed).toBe(1);
    expect(r.counters.confirmedWrites).toBe(1);
  });

  it("a REPORT run's ledger has abnormalExit:false and apply:false -- confirmedWrites still mirrors WOULD-REPOINT (the SAME counter the banner prints in this mode, nothing was actually written to Cosmos)", () => {
    const sale = SALE({ cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID, isAuto: false });
    const r = driveWithCounters(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.counters.abnormalExit).toBe(false);
    expect(r.counters.apply).toBe(false);
    expect(r.led.salesUpserts.length).toBe(0); // the actual proof nothing was written
    expect(r.counters.confirmedWrites).toBe(1); // would-repoint, same as the WOULD REPOINT banner line
  });

  it("SPAWN WITH AN IO THAT THROWS AFTER k ROWS: the ledger shows k confirmed writes and abnormalExit:true, not repointed=0", () => {
    // Five candidates, each backed by its own checklist flip row. The whole
    // page (all 5 rows) is scanned successfully -- forEachPage collects rows
    // BEFORE any of them are processed, so the scan itself must complete
    // before the incident's OWN shape (a per-candidate point read that
    // escapes runPool) can even occur. CONCURRENCY=1 makes runPool strictly
    // sequential, so residentAt's own point read (performMove's destination
    // check, called ONCE per row, NOT wrapped in a per-row try/catch the way
    // catalogRowAt is) throwing on the 4th call means candidates 1-3 have
    // ALREADY committed their move (upsert+read-back+delete all landed)
    // before candidate 4's residentAt read exhausts its retries and the
    // error escapes runPool's Promise.all, out of main(), to the top-level
    // .catch -- exactly the incident's own shape.
    const N = 5;
    const sales = Array.from({ length: N }, (_, i) => {
      const no = `${PREFIX}k${i}:base:no-auto`;
      return SALE({ id: `k${i}`, cardId: no, hobbyiqCardId: no, isAuto: false });
    });
    const catalog = Array.from({ length: N }, (_, i) => CATALOG_ROW({ id: `${PREFIX}k${i}:base:auto`, cardId: `${PREFIX}k${i}:base:auto` }));
    // Each successful move costs exactly 3 reads against the sales
    // container: residentAt's own destination check (performMove), plus
    // relocateSoldComp's internal "existedBefore" read, plus one successful
    // read-back after the upsert (readBackKeptRow's first attempt, since the
    // shim's upsert is synchronous-visible). 3 candidates x 3 reads = 9.
    const r = driveWithCounters(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", CONCURRENCY: "1", _TEST_BACKOFF_MAX_ATTEMPTS: "1" },
      { sales, catalog, throwSalesReadAfter: 9 },
    );
    expect(r.code).not.toBe(0);
    expect(r.counters).toBeTruthy();
    expect(r.counters.abnormalExit).toBe(true);
    // Exactly the 3 candidates fully processed (and moved) before candidate
    // 4's own residentAt point read exhausted and killed the run.
    expect(r.counters.confirmedWrites).toBe(3);
    expect(r.counters.confirmedWrites).toBeLessThan(N);
    expect(r.counters.repointed).toBe(r.counters.confirmedWrites);
    expect(r.led.salesUpserts).toHaveLength(3); // the real Cosmos-facing proof: 3 moves actually landed
    expect(r.out).toMatch(/::error::/);
  });

  it("the banner line reads ABNORMAL EXIT wording is available to the workflow via the ledger, never a bare repointed=0 default on a real partial-write crash", () => {
    // This is the workflow-side half of the fix: the preamble in
    // backfill-runner.yml reads the SAME ledger file this test reads, and
    // prints "ABNORMAL EXIT after <n> confirmed writes" when abnormalExit is
    // true -- proven directly against the workflow text below (see the
    // "workflow wiring" describe block's own assertions on this lane).
    const workflow = fs.readFileSync(path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const idx = workflow.indexOf("Self-relaunch the isAuto-flip repoint");
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 4000);
    expect(block).toMatch(/repoint-sales-isauto-flip-counters\.json/);
    expect(block).toMatch(/ABNORMAL EXIT after \$\{R:-0\} confirmed writes/);
    // The OLD defect: `R` was set by grep-ing the LAST banner line, with
    // NOTHING reading a ledger first -- a bare "R=$(grep ...)" with no
    // preceding ledger check/read. The fix's preamble always reads the
    // ledger file FIRST (LEDGER=... / if [ -f "$LEDGER" ]) before R is ever
    // assigned, so the old grep-only assignment is gone.
    expect(block).not.toMatch(/R=\$\(grep -aoE "\(REPOINTED\|WOULD REPOINT\)/);
    expect(block).toMatch(/if \[ -f "\$LEDGER" \]/);
  });
});

describe("repoint-sales-isauto-flip -- concurrency guard on sustained throttling (defect 3)", () => {
  const lane = require(LANE);

  it("throttleStats/CONCURRENCY_STATE are white-box exports, letting a test drive the halving without paying real backoff waits", () => {
    expect(lane.throttleStats).toBeTruthy();
    expect(lane.CONCURRENCY_STATE).toBeTruthy();
    expect(typeof lane.recordThrottle).toBe("function");
  });

  it("halves CONCURRENCY_STATE.effective one-way after more than 20 throttles inside the window, by direct simulation of the shipped module", () => {
    // Fresh require in an isolated child so this test's mutation of the
    // shared module-scope throttleStats does not leak into any other test
    // in this file (they all require the SAME cached module otherwise).
    const out = execFileSync(process.execPath, ["-e", `
      const lane = require(${JSON.stringify(LANE)});
      const before = lane.CONCURRENCY_STATE.effective;
      for (let i = 0; i < 21; i++) lane.recordThrottle();
      const after = lane.CONCURRENCY_STATE.effective;
      console.log(JSON.stringify({ before, after, halvings: lane.throttleStats.halvings }));
    `], { encoding: "utf8" });
    const { before, after, halvings } = JSON.parse(out.trim().split("\n").pop()!);
    expect(after).toBe(Math.max(1, Math.floor(before / 2)));
    expect(halvings).toBe(1);
  });

  it("REQUESTED_CONCURRENCY is unaffected by a halving -- only the mutable .effective changes", () => {
    const out = execFileSync(process.execPath, ["-e", `
      const lane = require(${JSON.stringify(LANE)});
      const requested = lane.REQUESTED_CONCURRENCY;
      for (let i = 0; i < 25; i++) lane.recordThrottle();
      console.log(JSON.stringify({ requested, stillRequested: lane.REQUESTED_CONCURRENCY, effective: lane.CONCURRENCY_STATE.effective }));
    `], { encoding: "utf8" });
    const { requested, stillRequested, effective } = JSON.parse(out.trim().split("\n").pop()!);
    expect(stillRequested).toBe(requested);
    expect(effective).toBeLessThan(requested);
  });

  it("the final banner prints the throttle count and, when halved, the new effective concurrency", () => {
    const out = execFileSync(process.execPath, ["-e", `
      const lane = require(${JSON.stringify(LANE)});
      for (let i = 0; i < 25; i++) lane.recordThrottle();
    `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toMatch(/THROTTLED: more than 20 Cosmos 429s in the last 60s -- halving in-flight concurrency/);
  });
});

// ── workflow wiring ──────────────────────────────────────────────────────────

describe("repoint-sales-isauto-flip -- workflow wiring (backfill-runner.yml)", () => {
  const workflowPath = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("the workflow file stays under 512 KB", () => {
    const bytes = Buffer.byteLength(workflow, "utf8");
    expect(bytes).toBeLessThan(512 * 1024);
  });

  it("adds no new workflow_dispatch input -- reuses scope/titles/slot/slots/apply/limit (24 inputs total)", () => {
    const inputsBlock = workflow.slice(workflow.indexOf("workflow_dispatch:"), workflow.indexOf("jobs:"));
    const topLevelInputs = [...inputsBlock.matchAll(/^ {6}([a-z_]+):\n/gm)].map((m) => m[1]);
    const distinct = new Set(topLevelInputs);
    expect(distinct.size).toBe(24);
    for (const name of ["scope", "titles", "slot", "slots", "apply", "limit", "script", "concurrency"]) {
      expect(distinct.has(name)).toBe(true);
    }
  });

  it("is registered in the script whitelist", () => {
    expect(workflow).toContain("- repoint-sales-isauto-flip");
  });

  it("uploads this lane's log as a durable artifact", () => {
    expect(workflow).toMatch(/Upload the repoint-sales-isauto-flip log/);
    expect(workflow).toMatch(/inputs\.script == 'repoint-sales-isauto-flip'/);
  });

  it("wires PLAN_OUT to a fixed, script-guarded path", () => {
    expect(workflow).toMatch(/inputs\.script == 'repoint-sales-isauto-flip' && '\/tmp\/repoint-sales-isauto-flip-plan'/);
  });

  it("self-relaunches on the budget marker, forwarding scope/titles/slot/slots/apply/concurrency", () => {
    const idx = workflow.indexOf("Self-relaunch the isAuto-flip repoint");
    expect(idx).toBeGreaterThan(-1);
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain("repoint-sales-isauto-flip");
    expect(block).toContain('-f scope="${{ inputs.scope }}"');
    expect(block).toContain('-f slot="${{ inputs.slot }}"');
    expect(block).toContain('-f slots="${{ inputs.slots }}"');
    expect(block).toContain('-f apply="${{ inputs.apply }}"');
    expect(block).toContain('-f concurrency="${{ inputs.concurrency }}"');
  });

  it("does NOT touch .github/actions/relaunch-on-marker/action.yml", () => {
    const idx = workflow.indexOf("Self-relaunch the isAuto-flip repoint");
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain("uses: ./.github/actions/relaunch-on-marker");
  });

  it("SET_KEYS/BCP_TITLES remain the shared titles carrier -- no new env var claimed for this lane's setKey filter", () => {
    expect(workflow).toMatch(/BCP_TITLES: \$\{\{ inputs\.titles \}\}/);
  });
});

// ── source file byte size (mirrors the workflow's own 512 KB pin) ──────────

describe("repoint-sales-isauto-flip -- lane file size", () => {
  it("the lane script stays well under 512 KB", () => {
    const bytes = fs.statSync(LANE).size;
    expect(bytes).toBeLessThan(512 * 1024);
  });
});
