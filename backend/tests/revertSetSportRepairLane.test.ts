/**
 * revert-set-sport-repair.cjs -- end-to-end against fake sold_comps.
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS (R76): repair-set-sport.cjs
 * (2026-08-20) flipped 183,248 sold_comps rows' sport by set-level checklist
 * dominance, vetoed only by five literal substring words; a census judged
 * 69,598 of those flips WRONG because the substring veto missed titles that
 * name a team/league rather than the sport word itself. This lane restores
 * them.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (sport-title-evidence, splitIdentityWriteGuard,
 * relocate-sold-comp) loads the REAL compiled dist/ / committed .cjs, so
 * what these tests pin is what ships -- same discipline as
 * repointSalesToChecklistNumberedLane.test.ts.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "revert-set-sport-repair.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revert-set-sport-repair-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

/** A minimal in-memory Cosmos-shaped sold_comps container, keyed by
 *  (id, cardId) so two documents CAN share a document id at two different
 *  cardId partitions -- exactly the shape a relocate-destination collision
 *  requires. Query dispatch is pattern-matched on the query TEXT, the
 *  repo's own convention (see repointSalesToChecklistNumberedLane.test.ts). */
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
        resources = all.filter((d) => d.setSportRepairedAt !== undefined && d.setSportReversedAt === undefined);
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
      return { container: (name) => { if (name === "sold_comps") return salesContainer; throw new Error("unknown container " + name); } };
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

const WRONG_FLIP_PATCH_SHAPE = {
  id: "cardhedge::ch-daily::1",
  cardId: "1649639019826x860979551007433600", // vendor partition, untouched by the repair
  sport: "baseball",
  hobbyiqCardId: "hiq:baseball:1988:fleer:8:base:no-auto",
  sportBefore: "basketball",
  hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:8:base:no-auto",
  setSportRepairedAt: "2026-08-20T21:57:21.352Z",
  title: "1988-89 Fleer Danny Ainge Celtics #8  MINT F3593 - Raw 10",
  source: "cardhedge",
};

const WRONG_FLIP_RELOCATE_SHAPE = {
  id: "cardhedge::ch-fill::1",
  cardId: "hiq:baseball:1988:fleer:17:base:no-auto", // cardId === current (wrong) hobbyiqCardId
  sport: "baseball",
  hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto",
  sportBefore: "basketball",
  hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
  setSportRepairedAt: "2026-08-20T21:58:48.718Z",
  title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
  source: "cardhedge",
};

describe("revert-set-sport-repair -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope (there is no bare 'all' synonym)", () => {
    for (const s of ["refractor", "all"]) {
      const r = drive({ SCOPE: s });
      expect(r.code).toBe(2);
    }
  });

  it("accepts the explicit literal 'all-repaired'", () => {
    const r = drive({ SCOPE: "all-repaired" }, { sales: [WRONG_FLIP_PATCH_SHAPE] });
    expect(r.code).toBe(0);
  });

  it("REFUSES a malformed cell (not setKey|year)", () => {
    const r = drive({ SCOPE: "fleer:1988" }); // colon, not pipe
    expect(r.code).toBe(2);
  });
});

describe("revert-set-sport-repair -- REPORT writes nothing and matches APPLY's counts", () => {
  it("finds the patch-shape row and reports it, writing zero", () => {
    const r = drive({ SCOPE: "fleer|1988" }, { sales: [WRONG_FLIP_PATCH_SHAPE] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RESTORE \(patch\)\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("REPORT's restore counts equal APPLY's on the same fixture (both shapes)", () => {
    const fixture = { sales: [WRONG_FLIP_PATCH_SHAPE, WRONG_FLIP_RELOCATE_SHAPE] };
    const report = drive({ SCOPE: "fleer|1988" }, fixture);
    const apply = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    const reportPatch = report.out.match(/WOULD RESTORE \(patch\)\s+(\d+)/);
    const applyPatch = apply.out.match(/RESTORED \(patch\)\s+(\d+)/);
    const reportRelocate = report.out.match(/WOULD RESTORE \(relocate\)\s+(\d+)/);
    const applyRelocate = apply.out.match(/RESTORED \(relocate\)\s+(\d+)/);
    expect(reportPatch?.[1]).toBe("1");
    expect(applyPatch?.[1]).toBe("1");
    expect(reportRelocate?.[1]).toBe("1");
    expect(applyRelocate?.[1]).toBe("1");
  });
});

describe("revert-set-sport-repair -- APPLY restores both shapes", () => {
  it("PATCH shape: restores sport + hobbyiqCardId in place, stamps setSportReversedAt/Reason", () => {
    const r = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [WRONG_FLIP_PATCH_SHAPE] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESTORED \(patch\)\s+1/);
    const patchCall = r.led.salesPatches.find((p: any) => p.id === WRONG_FLIP_PATCH_SHAPE.id);
    expect(patchCall).toBeTruthy();
    const opsByPath = Object.fromEntries(patchCall.ops.map((o: any) => [o.path, o.value]));
    expect(opsByPath["/sport"]).toBe("basketball");
    expect(opsByPath["/hobbyiqCardId"]).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
    expect(opsByPath["/setSportReversedReason"]).toBe("R76");
    expect(typeof opsByPath["/setSportReversedAt"]).toBe("string");
  });

  it("RELOCATE shape: cardId === current hobbyiqCardId -- moves the partition via upsert-verify-delete", () => {
    const r = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [WRONG_FLIP_RELOCATE_SHAPE] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESTORED \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain(WRONG_FLIP_RELOCATE_SHAPE.id);
    expect(r.led.salesDeletes).toContain(WRONG_FLIP_RELOCATE_SHAPE.id);
  });

  it("is idempotent: a restored row (setSportReversedAt stamped) drops out of the next run's selection", () => {
    const first = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [WRONG_FLIP_PATCH_SHAPE] });
    expect(first.out).toMatch(/RESTORED \(patch\)\s+1/);

    const reversedRow = { ...WRONG_FLIP_PATCH_SHAPE, sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:8:base:no-auto", setSportReversedAt: "2026-09-19T00:00:00.000Z", setSportReversedReason: "R76" };
    const second = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [reversedRow] });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/scanned \(setSportRepairedAt, not yet reversed\)\s+0/);
    expect(second.led.salesUpserts.length).toBe(0);
    expect(second.led.salesPatches.length).toBe(0);
  });
});

describe("revert-set-sport-repair -- guards and refusals", () => {
  it("KEEPs a row whose flip was right (title backs current sport)", () => {
    const row = { ...WRONG_FLIP_PATCH_SHAPE, id: "s-keep", sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:99:base:no-auto", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:99:base:no-auto", title: "1988 Fleer Wade Boggs Red Sox #99" };
    const r = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [row] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/KEEP \(flip was right\)\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("LEAVEs a row whose title names a third sport", () => {
    const row = {
      id: "s-third", cardId: "vendor-1", sport: "basketball", hobbyiqCardId: "hiq:basketball:2018:topps-chrome:01:gold-refractor:no-auto",
      sportBefore: "hockey", hobbyiqCardIdBefore: "hiq:hockey:2018:topps-chrome:01:gold-refractor:no-auto",
      setSportRepairedAt: "2026-08-20T00:00:00.000Z",
      title: "2018 Topps Chrome UEFA Champions League Lightning Strike Gold #LSKM Kylian Mbappe",
    };
    const r = drive({ SCOPE: "topps-chrome|2018", BACKFILL_APPLY: "true" }, { sales: [row] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: third-sport\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("REFUSES (destination-collision) when a DIFFERENT sale already resides at the relocate destination", () => {
    const moving = { ...WRONG_FLIP_RELOCATE_SHAPE, id: "shared-id" };
    const resident = {
      id: "shared-id", cardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      price: 999, soldAt: "2026-01-01", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [moving, resident] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination-collision\s+1/);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("COLLAPSES when the SAME sale (by content hash) already resides at the relocate destination", () => {
    const moving = { ...WRONG_FLIP_RELOCATE_SHAPE, id: "same-sale", price: 100, soldAt: "2026-01-01", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null };
    const resident = {
      id: "same-sale", cardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:17:base:no-auto",
      price: 100, soldAt: "2026-01-01", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "fleer|1988", BACKFILL_APPLY: "true" }, { sales: [moving, resident] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("same-sale");
  });

  it("REFUSES (guard-parked) when the restored hobbyiqCardIdBefore is malformed", () => {
    const row = { ...WRONG_FLIP_PATCH_SHAPE, id: "s-malformed", hobbyiqCardIdBefore: "hiq:notasport::garbage" };
    // 'all-repaired' scope: the malformed *Before id cannot be parsed into a
    // setKey|year cell (cellOf returns null), so a cell-scoped dispatch would
    // never reach this row at all -- the whole point of this fixture is the
    // GUARD firing on a row this lane DOES reach.
    const r = drive({ SCOPE: "all-repaired", BACKFILL_APPLY: "true" }, { sales: [row] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: guard-parked\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });
});

describe("revert-set-sport-repair -- reconciliation", () => {
  it("RECONCILE BALANCES across a mixed batch (restore, keep, leave, refuse)", () => {
    const keep = { ...WRONG_FLIP_PATCH_SHAPE, id: "s-keep2", sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:50:base:no-auto", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:50:base:no-auto", title: "1988 Fleer Wade Boggs Red Sox #50" };
    const leave = { id: "s-leave2", cardId: "vendor-2", sport: "basketball", hobbyiqCardId: "hiq:basketball:2018:topps-chrome:02:gold-refractor:no-auto", sportBefore: "hockey", hobbyiqCardIdBefore: "hiq:hockey:2018:topps-chrome:02:gold-refractor:no-auto", setSportRepairedAt: "x", title: "no evidence at all here" };
    const r = drive({ SCOPE: "all-repaired", BACKFILL_APPLY: "true" }, { sales: [WRONG_FLIP_PATCH_SHAPE, WRONG_FLIP_RELOCATE_SHAPE, keep, leave] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RECONCILE BALANCES/);
  });
});
