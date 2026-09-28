/**
 * revert-set-sport-repair.cjs -- CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-
 * LINE-FIRST wiring (2026-09-28, review finding #2 on PR #2498).
 *
 * relocateSoldComp's own `ledger` option is already fully unit-tested at the
 * shared-helper level (relocateSoldCompDeleteLedger.test.ts) -- this file
 * only proves that THIS lane's two call sites (the collapse branch's direct
 * `recordDeleteOrThrow` call, and the everyday relocate branch's
 * `relocateSoldComp(..., { ledger: {...} })`) wire it correctly and that a
 * ledger-write failure surfaces through this lane's own `s.ledgerWriteFailed`
 * counter and banner line.
 *
 * Reuses revertSetSportRepairLane.test.ts's own shim()/drive() helpers and
 * fixtures verbatim (same execFileSync-against-real-dist,
 * @azure/cosmos-stubbed-via-Module._load pattern) -- only LEDGER_OUT is new,
 * forwarded into the child exactly like every other env var `drive()` already
 * passes through its `...env` spread.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "revert-set-sport-repair.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revert-set-sport-repair-ledger-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

// ── Same shim as revertSetSportRepairLane.test.ts (sales-only shape; this
// suite never exercises MODE=checklist-evidence, so the catalog container is
// omitted). ──────────────────────────────────────────────────────────────────
function shim(opts: { sales?: Array<Record<string, unknown>> } = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = { sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])) };
const led = { salesUpserts: [], salesPatches: [], salesDeletes: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }

const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
    patch: async (ops) => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
      led.salesPatches.push({ id, ops });
      save();
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
      state.sales.set(salesKey(doc.id, doc.cardId), structuredClone(doc));
      led.salesUpserts.push(doc.id);
      save();
      return { resource: structuredClone(doc) };
    },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("setSportRepairedAt")) {
        resources = all.filter((d) => d.setSportRepairedAt !== undefined && d.setSportReversedAt === undefined && (!q.includes("setSportReviewedAt") || d.setSportReviewedAt === undefined));
      } else if (q.includes("c.id = @id AND c.cardId = @pk")) {
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        resources = all.filter((d) => d.id === params["@id"] && d.cardId === params["@pk"]);
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      return {
        fetchNext: async () => ({ resources, continuationToken: undefined }),
        fetchAll: async () => ({ resources }),
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

const WRONG_FLIP_RELOCATE_SHAPE = {
  id: "cardhedge::ch-fill::1",
  cardId: "hiq:baseball:1988:fleer:17:base:no-auto", // cardId === current (wrong) hobbyiqCardId
  sport: "baseball",
  hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto",
  sportBefore: "basketball",
  hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
  setSportRepairedAt: "2026-08-20T21:58:48.718Z",
  title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
  price: 250.75,
  soldAt: "2026-01-15T00:00:00.000Z",
  source: "cardhedge",
};

function ledgerLinesFor(dir: string, lane: string) {
  const p = path.join(dir, `deleted-docs-${lane}-local.ndjson`);
  expect(fs.existsSync(p)).toBe(true);
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("revert-set-sport-repair -- pre-delete ledger, relocate call site", () => {
  it("writes a full-document ledger line before the relocate's delete, carrying price/soldAt/title", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-"));
    const r = drive(
      { SCOPE: "fleer|1988", BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { sales: [WRONG_FLIP_RELOCATE_SHAPE] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESTORED \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain(WRONG_FLIP_RELOCATE_SHAPE.id);
    expect(r.led.salesDeletes).toContain(WRONG_FLIP_RELOCATE_SHAPE.id);

    const lines = ledgerLinesFor(ledgerDir, "revert-set-sport-repair");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.lane).toBe("revert-set-sport-repair");
    expect(line.action).toBe("relocate");
    expect(line.reason).toBe("sport-restore");
    expect(line.container).toBe("sold_comps");
    expect(line.doc.id).toBe(WRONG_FLIP_RELOCATE_SHAPE.id);
    expect(line.doc.cardId).toBe(WRONG_FLIP_RELOCATE_SHAPE.cardId);
    // The FULL pre-delete document -- not just id/cardId.
    expect(line.doc.price).toBe(250.75);
    expect(line.doc.soldAt).toBe("2026-01-15T00:00:00.000Z");
    expect(line.doc.title).toBe(WRONG_FLIP_RELOCATE_SHAPE.title);
  });

  it("refuses the delete when the ledger write fails: the row survives and the banner shows ledger-write-failed > 0", () => {
    // Point LEDGER_OUT at a path a pre-existing FILE occupies, so
    // delete-ledger.cjs's mkdirSync throws inside appendLedgerLineSync.
    const blockerParent = fs.mkdtempSync(path.join(tmp, "blocked-parent-"));
    const blocker = path.join(blockerParent, "blocked");
    fs.writeFileSync(blocker, "occupied");

    const r = drive(
      { SCOPE: "fleer|1988", BACKFILL_APPLY: "true", LEDGER_OUT: blocker },
      { sales: [WRONG_FLIP_RELOCATE_SHAPE] },
    );
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/of which ledger-write-failed\s+1/);
    // The relocate's delete was refused -- the row is still present at its
    // OLD address (never deleted without a recovery copy first).
    expect(r.led.salesDeletes).not.toContain(WRONG_FLIP_RELOCATE_SHAPE.id);
  });
});

describe("revert-set-sport-repair -- pre-delete ledger, collapse call site", () => {
  it("writes a full-document ledger line before the collapse's delete when the same sale (by content hash) already resides at the restore destination", () => {
    const ledgerDir = fs.mkdtempSync(path.join(tmp, "ledger-out-collapse-"));
    const moving = { ...WRONG_FLIP_RELOCATE_SHAPE, id: "same-sale", price: 100, soldAt: "2026-01-01", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null };
    const resident = {
      id: "same-sale", cardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      price: 100, soldAt: "2026-01-01", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive(
      { SCOPE: "fleer|1988", BACKFILL_APPLY: "true", LEDGER_OUT: ledgerDir },
      { sales: [moving, resident] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("same-sale");

    const lines = ledgerLinesFor(ledgerDir, "revert-set-sport-repair");
    expect(lines.length).toBe(1);
    expect(lines[0].action).toBe("collapse");
    expect(lines[0].reason).toBe("same-sale-resident");
    expect(lines[0].doc.id).toBe("same-sale");
    expect(lines[0].doc.price).toBe(100);
    expect(lines[0].doc.soldAt).toBe("2026-01-01");
  });
});
