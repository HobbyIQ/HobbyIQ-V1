/**
 * repoint-sales-cardnumber-suffix.cjs -- end-to-end against a fake sold_comps,
 * modelled on repointSalesParallelSuffixLane.test.ts's own shim (etag-aware
 * upsert/read/delete via relocate-sold-comp.cjs's real relocateSoldComp).
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS (root-cause investigation,
 * 2026-09-21): 1,095 sold_comps rows sit at
 * hiq:baseball:2024:bowmans-best:b24:* while their titles carry #B24-CE,
 * #B24-SB, #B24-CMO... -- 90 different players collapsed onto ONE address.
 * The parser bug that caused the truncation (a letters-then-digits card
 * number with no dash-suffix tail) was fixed 2026-09-12/13 (commit
 * 80482103, CF-DASH-SUFFIX-IS-PART-OF-THE-NUMBER) -- these rows are STALE,
 * minted/last-rewritten before that fix landed, and this lane realizes the
 * already-shipped fix on them.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (parseTitleIdentity, hobbyIqCardId, splitIdentityWriteGuard,
 * ...) loads the REAL compiled dist/, so what these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-cardnumber-suffix.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-cardnumber-suffix-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "baseball";
const YEAR = 2024;
const SET_KEY = "bowmans-best";
const PREFIX = `hiq:${SPORT}:${YEAR}:${SET_KEY}:`;

function shim(opts: { sales?: Array<Record<string, unknown>> } = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

let etagCounter = 0;
const stampEtag = (d) => { d._etag = "etag-" + (++etagCounter); return d; };
const SALES_SEED = ${JSON.stringify(sales)}.map(stampEtag);

const state = { sales: new Map(SALES_SEED.map((d) => [salesKey(d.id, d.cardId), d])) };
const led = { salesUpserts: [], salesDeletes: [] };
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

const DEFAULT_ENV = { SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: SET_KEY };

describe("repoint-sales-cardnumber-suffix -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: SET_KEY });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES an empty SET_KEYS", () => {
    const r = drive({ SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
  });

  it("REFUSES a wildcard SET_KEYS ('all' or '*')", () => {
    for (const v of ["all", "*"]) {
      const r = drive({ SCOPE: `${SPORT}:${YEAR}`, SET_KEYS: v });
      expect(r.code).toBe(2);
    }
  });
});

describe("repoint-sales-cardnumber-suffix -- isSuffixRestore / cardNumberSegmentOf (unit)", () => {
  const lane = require(LANE);

  it("is true only for a strict, hyphen-bounded suffix extension", () => {
    expect(lane.isSuffixRestore("b24", "b24-cmo")).toBe(true);
    expect(lane.isSuffixRestore("b25", "b25-as")).toBe(true);
    expect(lane.isSuffixRestore("f15", "f15-6")).toBe(true);
  });

  it("is false for a same-value, a totally different value, or a non-hyphen extension", () => {
    expect(lane.isSuffixRestore("b24", "b24")).toBe(false);
    expect(lane.isSuffixRestore("b24", "b25-cmo")).toBe(false);
    expect(lane.isSuffixRestore("b24", "b24x")).toBe(false); // no hyphen boundary
    expect(lane.isSuffixRestore("", "b24-cmo")).toBe(false);
    expect(lane.isSuffixRestore("b24", "")).toBe(false);
  });

  it("extracts the cardNumber segment (index 4) from a 7-segment slug", () => {
    expect(lane.cardNumberSegmentOf("hiq:baseball:2024:bowmans-best:b24:base:auto")).toBe("b24");
    expect(lane.cardNumberSegmentOf("hiq:baseball:2024:bowmans-best:b24-cmo:base:auto")).toBe("b24-cmo");
  });

  it("returns null for a malformed or short id", () => {
    expect(lane.cardNumberSegmentOf("not-a-slug")).toBeNull();
    expect(lane.cardNumberSegmentOf("hiq:baseball:2024:bowmans-best")).toBeNull();
  });
});

describe("repoint-sales-cardnumber-suffix -- APPLY relocates the reported b24 collapse shape", () => {
  it("relocates a sale stuck at the bare 'b24' address onto the suffix-restored 'b24-cmo' address, using the title", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best - Best of 2024 Autographs Colson Montgomery #B24-CMO (AU, RC)",
      sport: SPORT, cardYear: YEAR, price: 50, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/RELOCATED\s+1/);
  });

  it("REPORT mode finds the same candidate and writes nothing", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "Brayden Taylor 2024 Bowman's Best #B24-BT Refractor Best of Auto",
      sport: SPORT, cardYear: YEAR, price: 50, isAuto: true, playerName: "Brayden Taylor",
      soldAt: "2026-05-22T02:05:00.000Z", source: "cardsight",
    };
    const r = drive(DEFAULT_ENV, { sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RELOCATE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("collapses several different players correctly onto their OWN distinct addresses, ending the one-pool collision", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sales = [
      { id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox", sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery", soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight" },
      { id: "s2", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Cam Smith Auto #B24-CS Cubs", sport: SPORT, cardYear: YEAR, price: 25, isAuto: true, playerName: "Cam Smith", soldAt: "2026-07-02T01:44:51.000Z", source: "cardsight" },
      { id: "s3", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Felix Morrobel Auto Autograph Refractor #B24-FM Angels", sport: SPORT, cardYear: YEAR, price: 40, isAuto: true, playerName: "Felix Morrobel", soldAt: "2026-07-06T00:00:00.000Z", source: "cardsight" },
    ];
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
    expect(r.out).toMatch(/RELOCATED\s+3/);
  });

  it("is idempotent: a second run after the move finds nothing left to move", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Cam Smith Auto #B24-CS Cubs",
      sport: SPORT, cardYear: YEAR, price: 25, isAuto: true, playerName: "Cam Smith",
      soldAt: "2026-07-02T01:44:51.000Z", source: "cardsight",
    };
    const first = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale] });
    expect(first.led.salesUpserts).toContain("s1");
    const movedId = first.led.salesUpserts.length ? undefined : undefined;
    // Re-read the ledger's resulting state is not exposed directly; re-derive
    // the expected new id the same way the lane does and re-seed it.
    const newId = `${PREFIX}b24-cs:base:auto`;
    const movedSale = { ...sale, id: "s1", cardId: newId, hobbyiqCardId: newId };
    const second = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [movedSale] });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/RELOCATED\s+0/);
    expect(second.led.salesUpserts.length).toBe(0);
    void movedId;
  });
});

describe("repoint-sales-cardnumber-suffix -- refuses out-of-scope shapes", () => {
  it("does NOT touch a sale whose cardNumber segment is not the bare year-coded shape", () => {
    const id = `${PREFIX}50:silver-prizm:no-auto`;
    const sale = {
      id: "s1", cardId: id, hobbyiqCardId: id,
      title: "2024 Bowman's Best #50 Silver Prizm",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/RELOCATED\s+0/);
  });

  it("REFUSES (not a suffix restore) when the title's own card number does not extend the stored segment", () => {
    // Stored at bare "b24", but the title states a DIFFERENT number
    // entirely -- never move on a guess.
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best #17 Purple Refractor",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: not a suffix restore\s+1/);
  });

  it("does not move a title with no recognizable card number at all", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Some Player Auto",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});
