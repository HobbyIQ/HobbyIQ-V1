/**
 * repoint-sales-isauto-flip.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-
 * LEDGER-LINE-FIRST (2026-09-28), pinned at THIS lane's own self-collapse
 * delete site (performMove's `same-sale-resident` branch, lane
 * "repoint-sales-isauto-flip", action "collapse").
 *
 * Reuses repointSalesIsAutoFlip.test.ts's own `shim()`/`drive()` helpers
 * verbatim (execFileSync against the committed lane, @azure/cosmos stubbed
 * via Module._load, dist/ loaded for real) rather than inventing a second
 * fixture -- see that file's header for why. `drive()`'s env object is
 * spread directly into the child process's environment, so passing
 * LEDGER_OUT in the `env` argument already reaches the lane; no shim change
 * needed.
 *
 * Two things pinned:
 *   1. the self-collapse delete writes a full-document ledger line, under
 *      lane "repoint-sales-isauto-flip" / action "collapse" / reason
 *      "same-sale-resident", BEFORE the sale is gone from the fake pool.
 *   2. a ledger-write failure (LEDGER_OUT blocked by a pre-existing file)
 *      refuses that delete: the row survives in the fake pool, and the
 *      lane's own printed counters show ledgerWriteFailed > 0 (also folded
 *      into `failed`, per the call site's own catch block).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-isauto-flip.cjs");
const DL = require_(path.join(backend, "scripts", "lib", "delete-ledger.cjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-isauto-flip-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.LEDGER_OUT = process.env.LEDGER_OUT;
  savedEnv.GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;
  delete process.env.LEDGER_OUT;
  delete process.env.GITHUB_RUN_ID;
  DL.closeAllLedgerFds();
});
afterEach(() => {
  DL.closeAllLedgerFds();
  for (const k of ["LEDGER_OUT", "GITHUB_RUN_ID"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const SPORT = "baseball";
const YEAR = 2025;
const SETKEY = "bowmans-best";
const PREFIX = `hiq:${SPORT}:${YEAR}:${SETKEY}:`;
const NO_AUTO_ID = `${PREFIX}b25-jth:base:no-auto`;
const AUTO_ID = `${PREFIX}b25-jth:base:auto`;

const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: AUTO_ID, cardId: AUTO_ID,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SETKEY, cardNumber: "b25-jth", parallelSlug: "Base", isAuto: true,
  playerName: "Test Player", source: "baseballcardpedia-ladders-2026-09-04",
  ...over,
});

// ── shim(): verbatim from repointSalesIsAutoFlip.test.ts ────────────────
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

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
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
      let pageIdx = 0;
      const totalPages = Math.max(1, Math.ceil(resources.length / 500));
      return {
        hasMoreResults: () => pageIdx < totalPages,
        fetchNext: async () => {
          pageIdx++;
          const slice = resources.slice((pageIdx - 1) * 500, pageIdx * 500);
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

const DEFAULT_ENV = { SCOPE: `${SPORT}:${YEAR}` };

const SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: NO_AUTO_ID, hobbyiqCardId: NO_AUTO_ID,
  title: "2025 Bowman's Best Test Player #B25-JTH",
  sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "Test Player",
  soldAt: "2026-07-06T18:23:27.000Z", source: "cardhedge",
  ...over,
});

/** A resident already sitting at AUTO_ID whose content-hash matches the
 *  incoming sale (isAuto is NOT flipped by performMove's own spread --
 *  only cardId/hobbyiqCardId move -- so the resident must keep the SAME
 *  isAuto, price, soldAt as the sale to collapse rather than refuse as a
 *  possible-twin). */
const RESIDENT_TWIN = (sale: Record<string, unknown>) => ({
  ...sale, cardId: AUTO_ID, hobbyiqCardId: AUTO_ID,
});

describe("repoint-sales-isauto-flip -- delete ledger on self-collapse", () => {
  it("writes a full-document ledger line (lane/action/reason + full fields) BEFORE the collapse delete", () => {
    const sale = SALE();
    const resident = RESIDENT_TWIN(sale);
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale\)\s+1/);
    // The FROM-side copy (s1 @ NO_AUTO_ID) was deleted; the resident at
    // AUTO_ID survives untouched.
    expect(r.led.salesDeletes).toContain("s1");

    // ledgerPathFor reads process.env.LEDGER_OUT in THIS (parent) process --
    // must match what was handed to the child via drive()'s env.
    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("repoint-sales-isauto-flip");
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("repoint-sales-isauto-flip");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-resident");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(AUTO_ID);
    // The FULL pre-delete document -- id/cardId AND price/soldAt/title, not
    // a plan-line summary.
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(NO_AUTO_ID);
    expect(line.doc.price).toBe(40);
    expect(line.doc.soldAt).toBe("2026-07-06T18:23:27.000Z");
    expect(line.doc.title).toBe("2025 Bowman's Best Test Player #B25-JTH");
    expect(line.doc.playerName).toBe("Test Player");
  });

  it("a ledger-write failure refuses the delete: the sale survives, and the lane's own counters report ledgerWriteFailed", () => {
    // Block LEDGER_OUT with a pre-existing file so mkdirSync throws inside
    // appendLedgerLineSync -- the exact failure mode relocateSoldCompDeleteLedger.test.ts
    // already uses for the shared helper.
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = SALE({ id: "s2" });
    const resident = RESIDENT_TWIN(sale);
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    // A nonzero exit is exactly right here -- `failed` is > 0 and the lane
    // reports that honestly rather than a clean 0. The point of this test
    // is that the delete never happened, not the exit code.
    // The FROM-side copy was NEVER deleted -- the ledger write failed first.
    expect(r.led.salesDeletes).not.toContain("s2");
    expect(r.out).toMatch(/failed\s+1/);
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
  });
});
