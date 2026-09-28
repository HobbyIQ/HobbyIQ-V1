/**
 * reconcile-split-identity.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-
 * LEDGER-LINE-FIRST (2026-09-28), pinned at THIS lane's own self-collapse
 * delete site (lane "reconcile-split-identity", action "collapse", reason
 * "same-sale-resident").
 *
 * Reuses reconcileSplitIdentity.test.ts's own `shim()`/`drive()` helpers
 * verbatim, and its own SPLIT_SALE fixture shape (cardId and hobbyiqCardId
 * both hiq: slugs, disagreeing) -- see that file's header. `drive()`'s env
 * is spread directly into the child process's environment, so LEDGER_OUT
 * passed via `env` already reaches the lane.
 *
 * To reach the collapse branch: exactly one side (hobbyiqCardId, here) is
 * checklist-grade, so winningId = hobbyiqCardId (ID_A) -- and a resident
 * already sits at (sale.id, ID_A), byte-identical in content to the
 * incoming sale once relocated (only cardId/hobbyiqCardId move).
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
const LANE = path.join(backend, "scripts", "reconcile-split-identity.cjs");
const DL = require_(path.join(backend, "scripts", "lib", "delete-ledger.cjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-split-identity-ledger-"));
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
const YEAR = 2026;
const SETKEY = "topps";

const ID_A = `hiq:${SPORT}:${YEAR}:${SETKEY}:1:base:no-auto`;
const ID_B = `hiq:${SPORT}:${YEAR}:${SETKEY}:2:base:no-auto`;

const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: ID_A, cardId: ID_A,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SETKEY, cardNumber: "1", parallelSlug: "Base", isAuto: false,
  playerName: "Test Player", source: "baseballcardpedia-ladders-2026-09-04",
  ...over,
});

// ── shim(): verbatim from reconcileSplitIdentity.test.ts ────────────────
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
      } else if (q.includes("STARTSWITH(c.cardId, @prefix)")) {
        resources = all.filter((d) => String(d.cardId ?? "").startsWith(params["@prefix"]));
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      let served = false;
      return {
        hasMoreResults: () => !served,
        fetchNext: async () => {
          served = true;
          return { resources: resources.map((r) => structuredClone(r)), continuationToken: undefined };
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

const SPLIT_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: ID_B, hobbyiqCardId: ID_A,
  title: "2026 Topps Test Player #1", sport: SPORT, cardYear: YEAR,
  price: 40, isAuto: false, playerName: "Test Player",
  soldAt: "2026-09-06T18:23:27.000Z", source: "cardhedge",
  ...over,
});

describe("reconcile-split-identity -- delete ledger on self-collapse", () => {
  it("writes a full-document ledger line BEFORE the collapse delete", () => {
    const sale = SPLIT_SALE();
    const resident = { ...sale, cardId: ID_A, hobbyiqCardId: ID_A };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesDeletes).toContain("s1");

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("reconcile-split-identity");
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("reconcile-split-identity");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-resident");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(ID_A);
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(ID_B);
    expect(line.doc.hobbyiqCardId).toBe(ID_A);
    expect(line.doc.price).toBe(40);
    expect(line.doc.soldAt).toBe("2026-09-06T18:23:27.000Z");
    expect(line.doc.playerName).toBe("Test Player");
    expect(line.doc.title).toBe(sale.title);
  });

  it("a ledger-write failure refuses the delete: the sale survives, and ledgerWriteFailed is reported", () => {
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = SPLIT_SALE({ id: "s2" });
    const resident = { ...sale, cardId: ID_A, hobbyiqCardId: ID_A };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    expect(r.led.salesDeletes).not.toContain("s2");
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
  });
});
