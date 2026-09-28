/**
 * dedupe-sold-comp-copies-by-list.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-
 * DOCUMENT-LEDGER-LINE-FIRST (2026-09-28), pinned at THIS lane's own delete
 * gate (lane "dedupe-sold-comp-copies-by-list", action "delete", reason =
 * the entry's own `reason` field).
 *
 * Reuses dedupeSoldCompCopiesByList.test.ts's own `shim()`/`drive()`/
 * `writeList()` helpers verbatim, and its own "clean-delete" end-to-end
 * fixture (SALE_ID/KEEP_ID/DELETE_ID/KEEPER_CATALOG_ROW/KEEPER_SALE) -- see
 * that file's "REPORT computes the delete and writes nothing; APPLY deletes
 * exactly the stray" test. `drive()`'s env is spread directly into the
 * child process's environment, so LEDGER_OUT passed via `env` already
 * reaches the lane.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as os from "node:os";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "dedupe-sold-comp-copies-by-list.cjs");
const backend = join(__dirname, "..");
const DL = require_(join(backend, "scripts", "lib", "delete-ledger.cjs"));

type Entry = { saleId: string; keepCardId: string; deleteCardId: string; reason?: string };

const tmp = mkdtempSync(join(os.tmpdir(), "dedupe-sold-comp-copies-ledger-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

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

const SALE_ID = "tca-ebay::318499154523";
const KEEP_ID = "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50";
const DELETE_ID = "hiq:baseball:2024:bowman-chrome:player-victor-hurtado:gold-refractor:auto:num-50";

const KEEPER_CATALOG_ROW = { id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: "Victor Hurtado" };
const KEEPER_SALE = { id: SALE_ID, cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, source: "tca-ebay", title: "Victor Hurtado Gold Refractor Auto", price: 25, soldAt: "2026-01-05" };

function writeList(entries: Entry[], tag: string): string {
  const p = join(tmp, `list-${tag}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ forLane: "dedupe-sold-comp-copies-by-list", entries }));
  return p;
}

// ── shim(): verbatim from dedupeSoldCompCopiesByList.test.ts ────────────
function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];

  writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
};
const led = { deletes: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify({ ...led, finalSales: [...state.sales.values()] }));
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
      led.deletes.push(id);
      save();
      return {};
    },
  }),
  items: {
    query: (spec) => {
      const id = spec.parameters.find((p) => p.name === "@id").value;
      const resources = [...state.sales.values()]
        .filter((d) => d.id === id)
        .map((d) => ({ id: d.id, cardId: d.cardId }));
      return {
        fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
      };
    },
  },
};

const stub = {
  CosmosClient: class {
    dispose() {}
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
  const res = spawnSync(process.execPath, [lane], {
    cwd: backend,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
      NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const code = res.status ?? -1;
  const out = String(res.stdout ?? "") + String(res.stderr ?? "");
  const led = JSON.parse(readFileSync(ledger, "utf8"));
  return { code, out, led };
}

describe("dedupe-sold-comp-copies-by-list -- delete ledger", () => {
  it("writes a full-document ledger line BEFORE the delete", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "twins-lane audit" }], "clean-delete-ledger");
    const catalog = [KEEPER_CATALOG_ROW];
    const strayDoc = { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID };
    const sales = [KEEPER_SALE, strayDoc];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true", LEDGER_OUT: tmp }, { sales, catalog });
    expect(r.out).not.toMatch(/FATAL:/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.led.deletes).toEqual([SALE_ID]);
    expect(r.led.finalSales.length).toBe(1);

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("dedupe-sold-comp-copies-by-list");
    expect(existsSync(ledgerPath)).toBe(true);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("dedupe-sold-comp-copies-by-list");
    expect(line.action).toBe("delete");
    expect(line.reason).toBe("twins-lane audit");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(KEEP_ID);
    // The FULL pre-delete document -- id/cardId AND price/soldAt/title, not
    // a plan-line summary.
    expect(line.doc.id).toBe(SALE_ID);
    expect(line.doc.cardId).toBe(DELETE_ID);
    expect(line.doc.hobbyiqCardId).toBe(DELETE_ID);
    expect(line.doc.price).toBe(25);
    expect(line.doc.soldAt).toBe("2026-01-05");
    expect(line.doc.title).toBe(strayDoc.title);
  });

  it("a ledger-write failure refuses the delete: the stray survives, and ledgerWriteFailed is reported", () => {
    const blocker = join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    writeFileSync(blocker, "occupied");

    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "twins-lane audit" }], "ledger-fail");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [KEEPER_SALE, { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true", LEDGER_OUT: blocker }, { sales, catalog });
    expect(r.out).not.toMatch(/FATAL:/);
    // The stray was NEVER deleted -- the ledger write failed first.
    expect(r.led.deletes.length).toBe(0);
    expect(r.led.finalSales.length).toBe(2);
    expect(r.out).toMatch(/FAILED\s+1/);
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
  });
});
