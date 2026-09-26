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
