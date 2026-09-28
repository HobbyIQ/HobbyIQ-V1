/**
 * repoint-sales-cardnumber-suffix.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-
 * DOCUMENT-LEDGER-LINE-FIRST (2026-09-28), pinned at THIS lane's own
 * self-collapse delete site (lane "repoint-sales-cardnumber-suffix",
 * action "collapse", reason "same-sale-resident").
 *
 * Reuses repointSalesCardNumberSuffixLane.test.ts's own `shim()`/`drive()`
 * helpers verbatim -- see that file's header. `drive()`'s env object is
 * spread directly into the child process's environment, so LEDGER_OUT
 * passed via `env` already reaches the lane; no shim change needed.
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
const LANE = path.join(backend, "scripts", "repoint-sales-cardnumber-suffix.cjs");
const DL = require_(path.join(backend, "scripts", "lib", "delete-ledger.cjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-cardnumber-suffix-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
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
const YEAR = 2024;
const SET_KEY = "bowmans-best";
const PREFIX = `hiq:${SPORT}:${YEAR}:${SET_KEY}:`;

const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: `${PREFIX}b24-cmo:base:auto`, cardId: `${PREFIX}b24-cmo:base:auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SET_KEY, cardNumber: "B24-CMO", parallelSlug: "Base", isAuto: true,
  playerName: "Colson Montgomery", source: "checklistinsider-2026-08-27",
  gradeTier: undefined,
  ...over,
});

// ── shim(): verbatim from repointSalesCardNumberSuffixLane.test.ts ──────
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

const DEFAULT_ENV = { SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: SET_KEY };

const COLLAPSED_ID = `${PREFIX}b24:base:auto`;
const DEST_ID = `${PREFIX}b24-cmo:base:auto`;

const SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: COLLAPSED_ID, hobbyiqCardId: COLLAPSED_ID,
  title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
  sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
  soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
  ...over,
});

/** A resident already sitting at the suffix-restored destination, content-
 *  identical to the incoming sale (only cardId/hobbyiqCardId differ). */
const RESIDENT_TWIN = (sale: Record<string, unknown>) => ({
  ...sale, cardId: DEST_ID, hobbyiqCardId: DEST_ID,
});

describe("repoint-sales-cardnumber-suffix -- delete ledger on self-collapse", () => {
  it("writes a full-document ledger line BEFORE the collapse delete", () => {
    const sale = SALE();
    const resident = RESIDENT_TWIN(sale);
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident.*\s+1/i);
    expect(r.led.salesDeletes).toContain("s1");

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("repoint-sales-cardnumber-suffix");
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("repoint-sales-cardnumber-suffix");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-resident");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(DEST_ID);
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(COLLAPSED_ID);
    expect(line.doc.price).toBe(30);
    expect(line.doc.soldAt).toBe("2026-06-28T20:48:59.000Z");
    expect(line.doc.playerName).toBe("Colson Montgomery");
    expect(line.doc.title).toBe(sale.title);
  });

  it("a ledger-write failure refuses the delete: the sale survives, and ledgerWriteFailed is reported", () => {
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = SALE({ id: "s2" });
    const resident = RESIDENT_TWIN(sale);
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [sale, resident], catalog: [CATALOG_ROW()] },
    );
    expect(r.led.salesDeletes).not.toContain("s2");
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
  });
});
