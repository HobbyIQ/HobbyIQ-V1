/**
 * repoint-sales-to-sibling-product.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-
 * DOCUMENT-LEDGER-LINE-FIRST (2026-09-28), pinned at BOTH of this lane's own
 * self-collapse delete sites -- lane "repoint-sales-to-sibling-product",
 * action "collapse", reason "same-sale-at-destination":
 *   1. the base/default mode (runByPlayerMode's sibling, ~L1667)
 *   2. MODE=by-player (~L2208)
 *
 * Reuses repointSalesToSiblingProductLane.test.ts's own `shim()`/`drive()`
 * helpers verbatim, and its own base-mode collapse fixture ("collapses
 * instead when the resident is PROVEN the same sale by content hash",
 * ~L985) plus the by-player worked example (BP_* fixtures, ~L370-428) for
 * the second site, which has no existing end-to-end collapse test of its
 * own. `drive()`'s env is spread directly into the child process's
 * environment, so LEDGER_OUT passed via `env` already reaches the lane.
 *
 * Ledger failures at both sites are caught by an OUTER per-sale try/catch
 * (s.salesFailed++, and `if (isLedgerWriteFailure(e)) s.ledgerWriteFailed++`)
 * -- unlike the four single-collapse lanes, there is no dedicated inner
 * catch, so a ledger-write failure here surfaces as a FAILED plan row, not
 * a REFUSED one.
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
const LANE = path.join(backend, "scripts", "repoint-sales-to-sibling-product.cjs");
const DL = require_(path.join(backend, "scripts", "lib", "delete-ledger.cjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-sibling-product-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
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

// ── THE PILOT CELL (base mode): baseball 2025, topps > topps-update-series ──
const SPORT = "baseball";
const YEAR = 2025;
const FROM = "topps";
const TO = "topps-update-series";
const NUMBER = "US200";
const PLAYER = "Shohei Ohtani";
const FROM_HIQ = `hiq:${SPORT}:${YEAR}:${FROM}:us200:base:no-auto`;
const TO_HIQ = `hiq:${SPORT}:${YEAR}:${TO}:us200:base:no-auto`;

const TO_ROW = (over: Record<string, unknown> = {}) => ({
  id: TO_HIQ, cardId: TO_HIQ, sport: SPORT, year: YEAR, cardYear: YEAR, setKey: TO,
  cardNumber: NUMBER, playerName: PLAYER, source: "checklistinsider-2025-08-01",
  parallel: "Base", parallelSlug: "base", isAuto: false,
  ...over,
});

const SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: FROM_HIQ, hobbyiqCardId: FROM_HIQ,
  sport: SPORT, cardYear: YEAR, cardNumber: NUMBER, playerName: PLAYER,
  parallel: "Base", isAuto: false,
  title: "2025 Topps Shohei Ohtani #US200",
  source: "tca-ebay", price: 12, soldAt: "2025-09-01",
  ...over,
});

// ── MODE=by-player worked example (Ohtani #52, bowman-chrome -> bowman) ────
const BP_SPORT = "baseball";
const BP_YEAR = 2026;
const BP_FROM = "bowman-chrome";
const BP_SIBLING = "bowman";
const BP_NUMBER = "52";
const BP_WRONG_PLAYER = "JJ Wetherholt";
const BP_SALE_PLAYER = "Shohei Ohtani";
const BP_FROM_HIQ = `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:mojo-refractor:no-auto`;
const BP_SIBLING_HIQ = `hiq:${BP_SPORT}:${BP_YEAR}:${BP_SIBLING}:${BP_NUMBER}:mega-chrome-mojo:no-auto`;

const BP_FROM_ROW = (over: Record<string, unknown> = {}) => ({
  id: `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:base:no-auto`, cardId: `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:base:no-auto`,
  sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: BP_FROM,
  cardNumber: BP_NUMBER, playerName: BP_WRONG_PLAYER, source: "checklistcenter-2026-08-29",
  parallel: "Base", parallelSlug: "base", isAuto: false,
  ...over,
});

const BP_SIBLING_ROW = (over: Record<string, unknown> = {}) => ({
  id: BP_SIBLING_HIQ, cardId: BP_SIBLING_HIQ, sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: BP_SIBLING,
  cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER, source: "checklistcenter-2026-08-29",
  parallel: "Mega Chrome Mojo", parallelSlug: "mega-chrome-mojo", isAuto: false,
  ...over,
});

const BP_SALE = (over: Record<string, unknown> = {}) => ({
  id: "bp1", cardId: BP_FROM_HIQ, hobbyiqCardId: BP_FROM_HIQ,
  sport: BP_SPORT, cardYear: BP_YEAR, cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER,
  parallel: "Mojo Refractor", isAuto: false,
  title: "2026 Bowman Chrome Shohei Ohtani Mojo Refractor #52",
  source: "tca-ebay", price: 45, soldAt: "2026-09-01",
  ...over,
});

// ── shim(): verbatim from repointSalesToSiblingProductLane.test.ts ──────
let etagCounter = 0;
const nextEtag = () => `"etag-${++etagCounter}"`;

function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = (opts.catalog ?? []).map((d) => ({ ...d }));
  const sales = (opts.sales ?? []).map((d) => ({ ...d, _etag: (d as any)._etag ?? nextEtag() }));

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;
const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
};
const led = { catalogUpserts: [], salesUpserts: [], salesPatches: [], salesDeletes: [], etagMismatches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function preconditionFailed() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }
let etagSeq = 1000;
function bumpEtag(d) { d._etag = '"etag-bump-' + (etagSeq++) + '"'; }

function makeContainer(name, store, onUpsert, onDelete, onPatch, keyOf) {
  const key = keyOf || ((id) => id);
  return {
    item: (id, pk) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops, patchOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        if (ops.length > 10) throw new Error("fake " + name + ": patch exceeds the 10-operation Cosmos limit (" + ops.length + ")");
        if (patchOpts && patchOpts.accessCondition && String(d._etag) !== String(patchOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "patch" }); save();
          throw preconditionFailed();
        }
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        bumpEtag(d);
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async (delOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        if (delOpts && delOpts.accessCondition && String(d._etag) !== String(delOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "delete" }); save();
          throw preconditionFailed();
        }
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        const withEtag = { ...doc, _etag: doc._etag ?? '"etag-new"' };
        bumpEtag(withEtag);
        store.set(key(doc.id, doc.cardId), structuredClone(withEtag));
        if (onUpsert) onUpsert(doc);
        return { resource: structuredClone(withEtag) };
      },
      query: (spec) => {
        const q = typeof spec === "string" ? spec : spec.query;
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...store.values()];
        let resources;
        if (name === "card_catalog" && q.includes("STARTSWITH(c.id, @prefix)")) {
          const prefix = params["@prefix"];
          resources = all.filter((d) =>
            String(d.id ?? "").startsWith(prefix)
            && d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("STARTSWITH(c.hobbyiqCardId, @p)")) {
          const prefix = params["@p"];
          resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(prefix));
        } else if (name === "sold_comps" && q.includes("c.id = @id AND c.cardId = @pk")) {
          resources = all.filter((d) => d.id === params["@id"] && d.cardId === params["@pk"]);
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
  (doc) => { led.catalogUpserts.push(doc.id); save(); });
const salesContainer = makeContainer("sold_comps", state.sales,
  (doc) => { led.salesUpserts.push(doc.id); save(); },
  (id) => { led.salesDeletes.push(id); save(); },
  (id, ops) => { led.salesPatches.push({ id, ops }); save(); },
  salesKey);

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

const SCOPE = `${SPORT}:${YEAR}`;
const PAIR = `${FROM}>${TO}`;
const num = (out: string, re: RegExp) => Number((out.match(re)?.[1] ?? "").replace(/,/g, ""));

describe("repoint-sales-to-sibling-product (base mode) -- delete ledger on self-collapse", () => {
  it("writes a full-document ledger line BEFORE the collapse delete", () => {
    const resident = { ...SALE(), cardId: TO_HIQ, hobbyiqCardId: TO_HIQ };
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { catalog: [TO_ROW()], sales: [SALE(), resident] },
    );
    expect(r.code, r.out).toBe(0);
    expect(num(r.out, /COLLAPSED onto a resident \(same sale, by hash\)\s+([\d,]+)/)).toBe(1);
    expect(r.led.salesDeletes).toContain("s1");

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("repoint-sales-to-sibling-product");
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("repoint-sales-to-sibling-product");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-at-destination");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(TO_HIQ);
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe(FROM_HIQ);
    expect(line.doc.price).toBe(12);
    expect(line.doc.soldAt).toBe("2025-09-01");
    expect(line.doc.playerName).toBe(PLAYER);
    expect(line.doc.title).toBe(SALE().title);
  });

  it("a ledger-write failure refuses the delete: the sale survives, and the outer catch counts salesFailed/ledgerWriteFailed", () => {
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = SALE({ id: "s2" });
    const resident = { ...sale, cardId: TO_HIQ, hobbyiqCardId: TO_HIQ };
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { catalog: [TO_ROW()], sales: [sale, resident] },
    );
    expect(r.led.salesDeletes).not.toContain("s2");
    // The ledger-write failure throws inside the try block guarding the
    // collapse delete; the OUTER per-sale catch (not a dedicated inner one,
    // unlike the four single-collapse lanes) counts it as a failed sale.
    expect(num(r.out, /failed\s+([\d,]+)/)).toBeGreaterThanOrEqual(1);
  });
});

describe("repoint-sales-to-sibling-product MODE=by-player -- delete ledger on self-collapse", () => {
  const BP_SCOPE = `${BP_SPORT}:${BP_YEAR}`;

  it("writes a full-document ledger line BEFORE the collapse delete", () => {
    const resident = { ...BP_SALE(), cardId: BP_SIBLING_HIQ, hobbyiqCardId: BP_SIBLING_HIQ };
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true", LEDGER_OUT: tmp },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW()], sales: [BP_SALE(), resident] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesDeletes).toContain("bp1");

    process.env.LEDGER_OUT = tmp;
    const ledgerPath = DL.ledgerPathFor("repoint-sales-to-sibling-product");
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    // This lane's TWO collapse sites share one lane name/ledger file --
    // the base-mode test above already wrote one line to this same tmp dir
    // in a SEPARATE test (its own beforeEach resets LEDGER_OUT/closes fds,
    // but the ndjson FILE persists across tests sharing `tmp`), so assert
    // on the LAST line rather than assuming exactly one total.
    const line = JSON.parse(lines[lines.length - 1]);
    expect(line.lane).toBe("repoint-sales-to-sibling-product");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-at-destination");
    expect(line.container).toBe("sold_comps");
    expect(line.toId).toBe(BP_SIBLING_HIQ);
    expect(line.doc.id).toBe("bp1");
    expect(line.doc.cardId).toBe(BP_FROM_HIQ);
    expect(line.doc.price).toBe(45);
    expect(line.doc.soldAt).toBe("2026-09-01");
    expect(line.doc.playerName).toBe(BP_SALE_PLAYER);
    expect(line.doc.title).toBe(BP_SALE().title);
  });

  it("a ledger-write failure refuses the delete: the sale survives, and the outer catch counts it", () => {
    const blocker = path.join(tmp, `blocked-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blocker, "occupied");

    const sale = BP_SALE({ id: "bp2" });
    const resident = { ...sale, cardId: BP_SIBLING_HIQ, hobbyiqCardId: BP_SIBLING_HIQ };
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW()], sales: [sale, resident] },
    );
    expect(r.led.salesDeletes).not.toContain("bp2");
    expect(num(r.out, /failed\s+([\d,]+)/)).toBeGreaterThanOrEqual(1);
  });
});
