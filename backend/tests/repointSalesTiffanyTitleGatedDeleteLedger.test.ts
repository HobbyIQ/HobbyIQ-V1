/**
 * repoint-sales-tiffany-title-gated.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-
 * DOCUMENT-LEDGER-LINE-FIRST (2026-09-28), pinned at THIS lane's own
 * self-collapse delete site (lane "repoint-sales-tiffany-title-gated",
 * action "collapse", reason "same-sale-resident").
 *
 * Reuses repointSalesTiffanyTitleGatedLane.test.ts's own `shim()`/`drive()`
 * helpers verbatim, and its own "COLLAPSES (never a REFUSED count)" fixture
 * shape (byte-identical twin at the Tiffany destination) -- see that file's
 * header and its own collapse test around line 518. `drive()`'s env is
 * spread directly into the child process's environment, so LEDGER_OUT
 * passed via `env` already reaches the lane.
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
const LANE = path.join(backend, "scripts", "repoint-sales-tiffany-title-gated.cjs");
const DL = require_(path.join(backend, "scripts", "lib", "delete-ledger.cjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-tiffany-title-gated-ledger-"));
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
const YEAR = 1989;
const TOPPS_PREFIX = `hiq:${SPORT}:${YEAR}:topps:`;
const TIFFANY_PREFIX = `hiq:${SPORT}:${YEAR}:topps-tiffany:`;

const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: `${TIFFANY_PREFIX}1:base:no-auto`, cardId: `${TIFFANY_PREFIX}1:base:no-auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: "topps-tiffany", cardNumber: "1", parallelSlug: "Base", isAuto: false,
  playerName: "George Bell", source: "sportscardchecklist-2026-08",
  gradeTier: undefined,
  ...over,
});

// ── shim(): verbatim from repointSalesTiffanyTitleGatedLane.test.ts ─────
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
const led = { salesUpserts: [], salesDeletes: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
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
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("STARTSWITH(c.cardId, @prefix) OR STARTSWITH(c.hobbyiqCardId, @prefix)")) {
        resources = all.filter((d) =>
          String(d.cardId ?? "").startsWith(params["@prefix"]) || String(d.hobbyiqCardId ?? "").startsWith(params["@prefix"]));
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

const FROM_ID = `${TOPPS_PREFIX}1:base:no-auto`;
const DEST_ID = `${TIFFANY_PREFIX}1:base:no-auto`;

const BASE_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", title: "1989 Topps Tiffany #1 George Bell",
  sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
  soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
  ...over,
});

describe("repoint-sales-tiffany-title-gated -- delete ledger on self-collapse", () => {
  it("writes a full-document ledger line BEFORE the collapse delete", () => {
    const sale = { ...BASE_SALE(), cardId: FROM_ID, hobbyiqCardId: FROM_ID };
    const twin = { ...BASE_SALE(), cardId: DEST_ID, hobbyiqCardId: DEST_ID };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { sales: [sale, twin], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesDeletes).toContain("s1");

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("repoint-sales-tiffany-title-gated");
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("repoint-sales-tiffany-title-gated");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-resident");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(DEST_ID);
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(FROM_ID);
    expect(line.doc.price).toBe(40);
    expect(line.doc.soldAt).toBe("2026-07-06T18:23:27.000Z");
    expect(line.doc.playerName).toBe("George Bell");
    expect(line.doc.title).toBe(sale.title);
  });

  it("a ledger-write failure refuses the delete: the sale survives, and ledgerWriteFailed is reported", () => {
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = { ...BASE_SALE({ id: "s2" }), cardId: FROM_ID, hobbyiqCardId: FROM_ID };
    const twin = { ...BASE_SALE({ id: "s2" }), cardId: DEST_ID, hobbyiqCardId: DEST_ID };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [sale, twin], catalog: [CATALOG_ROW()] },
    );
    expect(r.led.salesDeletes).not.toContain("s2");
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
  });
});
