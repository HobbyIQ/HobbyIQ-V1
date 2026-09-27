/**
 * reconcile-split-identity.cjs -- end-to-end against a fake sold_comps +
 * card_catalog, modelled on repointSalesIsAutoFlip.test.ts's own shim
 * (etag-aware upsert/read/delete via relocate-sold-comp.cjs's real
 * relocateSoldComp).
 *
 * MOTIVATION (tonight's census, 2026-09-27 ~00:00Z, "SPLIT-IDENTITY"
 * diagnostic; 73,567 such rows in 2026 baseball slot 5 alone). A sold_comps
 * row whose cardId and hobbyiqCardId both name DIFFERENT hiq: cards is read
 * into BOTH cards' pools by the exact pool reader's OR. This lane settles
 * the split onto whichever address the CHECKLIST attests: exactly one side
 * checklist-grade -> move; both checklist -> refuse (ambiguous, never
 * guess); neither checklist -> refuse (the rematch's job).
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos replaced through Module._load; every other require
 * (hobbyIqCardId, catalogAuthority, graded-id, split-identity,
 * writeReconciliation, ...) loads the REAL compiled dist/ or the real
 * lib/*.cjs, so what these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "reconcile-split-identity.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-split-identity-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "baseball";
const YEAR = 2026;
const SETKEY = "topps";

const ID_A = `hiq:${SPORT}:${YEAR}:${SETKEY}:1:base:no-auto`;
const ID_B = `hiq:${SPORT}:${YEAR}:${SETKEY}:2:base:no-auto`;

/** A STRICT checklist row at the given id. */
const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: ID_A, cardId: ID_A,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SETKEY, cardNumber: "1", parallelSlug: "Base", isAuto: false,
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
  // writeReconciliation and split-identity are left to load the REAL
  // compiled dist/ / real lib/*.cjs so these end-to-end tests exercise the
  // actual classification and reconciliation, not a no-op.
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

/** A HIQ-SPLIT sale: cardId and hobbyiqCardId are both hiq: slugs and they
 *  differ -- the shape this whole lane exists to settle. */
const SPLIT_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: ID_B, hobbyiqCardId: ID_A,
  title: "2026 Topps Test Player #1", sport: SPORT, cardYear: YEAR,
  price: 40, isAuto: false, playerName: "Test Player",
  soldAt: "2026-09-06T18:23:27.000Z", source: "cardhedge",
  ...over,
});

describe("reconcile-split-identity -- scope refusals", () => {
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

describe("reconcile-split-identity -- reconcile to hobbyiqCardId", () => {
  it("moves a split sale onto hobbyiqCardId when ONLY that side is checklist-grade", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/-> to hobbyiqCardId\s+1/);
  });

  it("REPORT finds the same candidate and writes nothing", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RECONCILE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("reconcile-split-identity -- reconcile to cardId", () => {
  it("patches a split sale's hobbyiqCardId onto cardId when ONLY that side is checklist-grade", () => {
    // The winning id (cardId) is ALREADY the row's own partition -- only the
    // stale hobbyiqCardId field is wrong, so this is a PATCH IN PLACE
    // (upsert, no delete), never a relocate.
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/-> to cardId\s+1/);
  });
});

describe("reconcile-split-identity -- REFUSAL: both checklist (ambiguous)", () => {
  it("NEVER moves when BOTH addresses carry a checklist row", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const rowA = CATALOG_ROW({ id: ID_A, cardId: ID_A, cardNumber: "1" });
    const rowB = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [rowA, rowB] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: ambiguous-both-checklist\s+1/);
  });

  it("REPORT mode runs the SAME ambiguous check and refuses identically", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const rowA = CATALOG_ROW({ id: ID_A, cardId: ID_A, cardNumber: "1" });
    const rowB = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [rowA, rowB] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: ambiguous-both-checklist\s+1/);
  });
});

describe("reconcile-split-identity -- REFUSAL: neither checklist", () => {
  it("does not move when neither address has a checklist row (acquisition gap, not this lane's defect)", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: neither-checklist\s+1/);
  });
});

describe("reconcile-split-identity -- DERIVED / VENDOR at one side is treated as non-checklist", () => {
  it("does not move when the only backed side is DERIVED", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const derivedRow = CATALOG_ROW({ id: ID_A, cardId: ID_A, source: "sold-comps-stub" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [derivedRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: neither-checklist\s+1/);
  });

  it("does not move when the only backed side is VENDOR", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const vendorRow = CATALOG_ROW({ id: ID_A, cardId: ID_A, source: "cardhedge" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [vendorRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: neither-checklist\s+1/);
  });

  it("DERIVED at the current cardId and checklist at hobbyiqCardId still moves (derived never counts)", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const derivedAtB = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2", source: "sold-comps-stub" });
    const checklistAtA = CATALOG_ROW({ id: ID_A, cardId: ID_A, cardNumber: "1" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [derivedAtB, checklistAtA] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/-> to hobbyiqCardId\s+1/);
  });
});

describe("reconcile-split-identity -- graded ids preserve the grade segment", () => {
  it("moves a graded split sale, preserving its own grade tier on the winning id", () => {
    const gradedA = `${ID_A}:cgc-10`;
    const gradedB = `${ID_B}:cgc-10`;
    const sale = SPLIT_SALE({ id: "s1", cardId: gradedB, hobbyiqCardId: gradedA });
    const destRow = CATALOG_ROW({ id: gradedA, cardId: gradedA, cardNumber: "1" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/-> to hobbyiqCardId\s+1/);
  });
});

describe("reconcile-split-identity -- possible-twin-at-destination", () => {
  it("REFUSES rather than overwrites when a DIFFERENT document already resides at the winning address", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const differentResident = {
      id: "s1", cardId: ID_A, hobbyiqCardId: ID_A,
      title: "totally unrelated listing", sport: SPORT, cardYear: YEAR,
      price: 9999, isAuto: true, playerName: "Someone Else",
      soldAt: "2020-01-01T00:00:00.000Z", source: "cardhedge",
    };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale, differentResident], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
  });
});

describe("reconcile-split-identity -- titles (setKey) filter", () => {
  it("with titles naming a DIFFERENT setKey, the candidate is out of scope and untouched", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, SET_KEYS: "bowman", BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+0/);
  });

  it("with titles naming the SAME setKey (BCP_TITLES alias), the candidate is found and moved", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BCP_TITLES: SETKEY, BACKFILL_APPLY: "true" },
      { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
  });
});

describe("reconcile-split-identity -- REPORT performs identical guard evaluation to APPLY", () => {
  it("same counters, zero writes, across a mixed batch", () => {
    const moved = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const ambiguousA = `hiq:${SPORT}:${YEAR}:${SETKEY}:3:base:no-auto`;
    const ambiguousB = `hiq:${SPORT}:${YEAR}:${SETKEY}:4:base:no-auto`;
    const ambiguous = SPLIT_SALE({ id: "s2", cardId: ambiguousB, hobbyiqCardId: ambiguousA });
    const gapA = `hiq:${SPORT}:${YEAR}:${SETKEY}:5:base:no-auto`;
    const gapB = `hiq:${SPORT}:${YEAR}:${SETKEY}:6:base:no-auto`;
    const noGap = SPLIT_SALE({ id: "s3", cardId: gapB, hobbyiqCardId: gapA });

    const catalog = [
      CATALOG_ROW({ id: ID_A, cardId: ID_A, cardNumber: "1" }),
      CATALOG_ROW({ id: ambiguousA, cardId: ambiguousA, cardNumber: "3" }),
      CATALOG_ROW({ id: ambiguousB, cardId: ambiguousB, cardNumber: "4" }),
    ];

    const report = drive(DEFAULT_ENV, { sales: [moved, ambiguous, noGap], catalog });
    const apply = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [moved, ambiguous, noGap], catalog });

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(report.led.salesUpserts.length).toBe(0);

    const extractCounters = (out: string) => ({
      candidates: out.match(/candidates \(HIQ-SPLIT rows\)\s+([\d,]+)/)?.[1],
      both: out.match(/REFUSED: ambiguous-both-checklist\s+([\d,]+)/)?.[1],
      neither: out.match(/REFUSED: neither-checklist\s+([\d,]+)/)?.[1],
    });
    expect(extractCounters(report.out)).toEqual(extractCounters(apply.out));
    expect(report.out).toMatch(/reconciled: candidates 3 = accounted-for 3/);
    expect(apply.out).toMatch(/reconciled: candidates 3 = accounted-for 3/);
  });
});

describe("reconcile-split-identity -- reconcile with zero writes", () => {
  it("REPORT: candidates == accounted-for, no MISMATCH, zero writes", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reconciled: candidates \d+ = accounted-for \d+/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  // Mutation check: neither refusal path may write anything, ever.
  it("MUTATION: ambiguous-both-checklist writes nothing even in APPLY", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const rowA = CATALOG_ROW({ id: ID_A, cardId: ID_A, cardNumber: "1" });
    const rowB = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [rowA, rowB] });
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("MUTATION: neither-checklist writes nothing even in APPLY", () => {
    const sale = SPLIT_SALE({ cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });
});

// COORDINATOR LESSON (#2441, repoint-sales-isauto-flip.cjs review): a row
// that never became a candidate (here, a non-split coherent row, or a
// malformed slug that the setKey-bucketing outer loop cannot parse) must
// NEVER be folded into the candidate reconcile -- doing so produces a FALSE
// RED the instant a real candidate sits alongside one such row.
describe("reconcile-split-identity -- pre-candidate rows are not reconciled against candidates", () => {
  it("a COHERENT row (cardId === hobbyiqCardId) is not a candidate and does not break reconciliation", () => {
    const coherent = SPLIT_SALE({ id: "s0", cardId: ID_A, hobbyiqCardId: ID_A });
    const splitSale = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [coherent, splitSale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+1/);
    expect(r.out).toMatch(/not-hiq-split \(not this lane's shape\)\s+1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesUpserts).not.toContain("s0");
  });

  it("a malformed slug (unparseable) alongside one real candidate: no false RECONCILE MISMATCH", () => {
    const malformedId = `hiq:${SPORT}:${YEAR}:${SETKEY}:onlyfoursegments`;
    const badSale = SPLIT_SALE({ id: "s0", cardId: `${malformedId}-x`, hobbyiqCardId: malformedId });
    const goodSale = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [badSale, goodSale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).not.toMatch(/overAccounted/i);
    expect(r.out).not.toMatch(/COUNTERS DO NOT ADD UP/i);
    expect(r.out).toMatch(/reconciled: candidates 1 = accounted-for 1/);
    expect(r.led.salesUpserts).toContain("s1");
  });
});

// COORDINATOR REVIEW (#2449, 2026-09-27), item 1: CONFIRMED DEFECT -- no
// player gate. A sale of "2026 Topps Mike Trout #1" whose hobbyiqCardId is
// ID_B (checklist-grade Shohei Ohtani, no other evidence) must NEVER move
// onto Ohtani's identity just because the checklist attests Ohtani exists
// at that slug -- the checklist proves a CARD lives there, not that THIS
// SALE is that card.
describe("reconcile-split-identity -- THE PLAYER GATE (coordinator fixture: Trout sale, Ohtani catalog row)", () => {
  const TROUT_SALE = () => SPLIT_SALE({
    id: "s1", cardId: ID_A, hobbyiqCardId: ID_B,
    title: "2026 Topps Mike Trout #1", playerName: "Mike Trout",
  });
  const OHTANI_ROW = () => CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2", playerName: "Shohei Ohtani" });

  it("REFUSES player-disagrees rather than moving the Trout sale onto the Ohtani row", () => {
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [TROUT_SALE()], catalog: [OHTANI_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: player-disagrees\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });

  it("REPORT mode runs the SAME player gate and refuses identically", () => {
    const r = drive(DEFAULT_ENV, { sales: [TROUT_SALE()], catalog: [OHTANI_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: player-disagrees\s+1/);
  });

  it("MOVES when the winning row's player agrees with the sale (Trout catalog row, Trout sale)", () => {
    const troutRow = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2", playerName: "Mike Trout" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [TROUT_SALE()], catalog: [troutRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/-> to hobbyiqCardId\s+1/);
  });

  // SECOND-ROUND COORDINATOR REVIEW (#2449, 2026-09-27): no title fallback.
  // namesAgree compares NAME-shaped strings; a whole sale TITLE never folds
  // down to equal a bare playerName, so a title fallback would have
  // refused EVERY blank-playerName sale as player-disagrees regardless of
  // whether the title corroborated the winning row -- strictly worse than
  // the honest no-sale-player refusal. So a blank playerName refuses
  // no-sale-player EVEN WHEN the title plainly names the winning player.
  it("a BLANK playerName refuses no-sale-player, even when the title plainly names the winning player (no title fallback)", () => {
    const troutRow = CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2", playerName: "Mike Trout" });
    const blankPlayerButTroutTitle = SPLIT_SALE({
      id: "s1", cardId: ID_A, hobbyiqCardId: ID_B,
      title: "2026 Topps Mike Trout #1", playerName: "",
    });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [blankPlayerButTroutTitle], catalog: [troutRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: no-sale-player\s+1/);
    expect(r.out).not.toMatch(/REFUSED: player-disagrees\s+1/);
  });

  it("REFUSES no-sale-player (its OWN class, distinct from player-disagrees) when the sale has a blank playerName", () => {
    const blankPlayer = SPLIT_SALE({ id: "s1", cardId: ID_A, hobbyiqCardId: ID_B, title: "", playerName: "" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [blankPlayer], catalog: [OHTANI_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: no-sale-player\s+1/);
    expect(r.out).not.toMatch(/REFUSED: player-disagrees\s+1/);
  });

  it("MUTATION: removing the player gate would move the Trout sale onto Ohtani's identity -- this pins that it does not", () => {
    // Direct proof against the shipped lane's own behavior: the destination
    // catalog row's playerName ("Shohei Ohtani") never matches the sale's
    // player ("Mike Trout") under namesAgree, and the fixture drives the
    // COMMITTED file -- so this red/green boundary is the gate itself, not
    // a mock of it.
    const { namesAgree } = require(path.join(backend, "scripts", "lib", "name-agreement.cjs"));
    expect(namesAgree("Shohei Ohtani", "Mike Trout")).toBe(false);
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [TROUT_SALE()], catalog: [OHTANI_ROW()] });
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });
});

// COORDINATOR REVIEW (#2449, 2026-09-27), item 2: the scan was STARTSWITH on
// hobbyiqCardId only, so a split row whose hobbyiqCardId is OFF-SCOPE (wrong
// sport/year -- the exact damage class this lane exists for) but whose
// cardId IS in-scope was never a candidate. Fixed with a second STARTSWITH
// pass on cardId, deduped against the first by the (id, cardId) pair --
// the container's own point-read key, never the sale's own `id` alone
// (second-round coordinator review: sold_comps ids are NOT unique across
// partitions, and an id-only dedup would silently drop a genuinely
// distinct document that merely shares an id -- CF-COLLISION-IS-NOT-A-
// DUPLICATE).
describe("reconcile-split-identity -- SECOND PASS closes the off-scope-hobbyiqCardId blind spot", () => {
  const OFF_SCOPE_HOBBYIQ_ID = `hiq:football:2019:panini:1:base:no-auto`; // wrong sport AND wrong year
  const IN_SCOPE_CARD_ID = ID_B; // in-scope: baseball:2026:topps

  it("a split row whose hobbyiqCardId is OFF-SCOPE but whose cardId IS in-scope is found and reconciled", () => {
    // hobbyiqCardId names a football:2019 card (off this lane's dispatched
    // scope=baseball:2026); cardId names an in-scope baseball:2026:topps
    // card that IS checklist-grade. A hobbyiqCardId-only scan would never
    // see this row at all -- it has to be caught by the cardId pass.
    const sale = SPLIT_SALE({
      id: "s1", cardId: IN_SCOPE_CARD_ID, hobbyiqCardId: OFF_SCOPE_HOBBYIQ_ID,
      title: "2026 Topps Test Player #2", playerName: "Test Player",
    });
    const winningRow = CATALOG_ROW({ id: IN_SCOPE_CARD_ID, cardId: IN_SCOPE_CARD_ID, cardNumber: "2" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [winningRow] });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).toMatch(/scan pass 2 \(STARTSWITH cardId\)\s+1 row/);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/-> to cardId\s+1/);
  });

  it("prints both pass counts in the banner, and a row seen by BOTH passes is counted once, not twice", () => {
    // An ordinary in-scope split: hobbyiqCardId=ID_A and cardId=ID_B share
    // the SAME baseball:2026:topps: prefix, so both passes' STARTSWITH
    // queries match it -- pass 1 claims it (net-new), and pass 2's own query
    // finds the SAME sale id again (its cardId now reads ID_A, since pass 1
    // already reconciled it under APPLY) and dedupes it rather than
    // reprocessing it, so pass 2's net-new count is 0 and the dedup counter
    // is 1.
    const sale = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scan pass 1 \(STARTSWITH hobbyiqCardId\)\s+1 row/);
    expect(r.out).toMatch(/scan pass 2 \(STARTSWITH cardId\)\s+0 row/);
    expect(r.out).toMatch(/same doc rediscovered \(own address\)\s+1/);
    expect(r.out).toMatch(/distinct docs sharing an id\s+0/);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+1/);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesUpserts.length).toBe(1);
  });

  it("REPORT mode: both passes independently match the SAME row (nothing moved, no write to observe) -- pass 2 still dedupes it", () => {
    // Cleaner evidence of the dedup than the APPLY case above: in REPORT
    // mode nothing is written between the two passes, so pass 2's own
    // STARTSWITH(cardId) query genuinely re-finds the identical, unchanged
    // row pass 1 already claimed -- and it is still counted once, as
    // sameDocRediscovered (the exact (id,cardId) pair pass 1 already saw),
    // never as distinctDocsSharingId.
    const sale = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scan pass 1 \(STARTSWITH hobbyiqCardId\)\s+1 row/);
    expect(r.out).toMatch(/scan pass 2 \(STARTSWITH cardId\)\s+0 row/);
    expect(r.out).toMatch(/same doc rediscovered \(own address\)\s+1/);
    expect(r.out).toMatch(/distinct docs sharing an id\s+0/);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("a row RELOCATED by pass 1 (APPLY) is not double-counted when pass 2 re-reads it at its NEW address", () => {
    // Regression pin for the sequencing hazard the two-pass design
    // introduces: in APPLY mode, pass 1 can already have MOVED a row by the
    // time pass 2's own STARTSWITH(cardId) query runs against the same live
    // container. The row resurfaces under a NEW cardId pass 1's own
    // (id, cardId) pair never recorded -- `relocatedTo` is what lets this
    // lane recognise it as the SAME document at its new address (rather
    // than reprocessing it as though it were new) without conflating it
    // with a genuinely distinct document that happens to share the id.
    const coherentDecoy = SPLIT_SALE({ id: "s0", cardId: ID_A, hobbyiqCardId: ID_A });
    const splitSale = SPLIT_SALE({ id: "s1", cardId: ID_B, hobbyiqCardId: ID_A });
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [coherentDecoy, splitSale], catalog: [CATALOG_ROW({ id: ID_A, cardId: ID_A })] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+1/);
    expect(r.led.salesUpserts).toEqual(["s1"]);
    expect(r.led.salesUpserts.length).toBe(1);
  });

  // COORDINATOR REVIEW (#2449, second round, 2026-09-27): BLOCKING fixture.
  // docX and docY are TWO DIFFERENT DOCUMENTS that happen to share the same
  // sale `id` under two different cardId partitions
  // (CF-COLLISION-IS-NOT-A-DUPLICATE -- sold_comps ids are
  // `${source}::${externalId}`, unique only WITHIN a partition;
  // lib/duplicate-sale-ids.cjs's own census measured this shape live). An
  // id-only dedup would read docY as "already seen" the instant pass 1
  // touches docX and silently drop it -- a MISS, not a wrong move, but it
  // defeats pass 2's whole purpose. Both must be found and processed.
  it("docX and docY share the SAME sale id under DIFFERENT cardId partitions -- BOTH are found and processed, neither is silently dropped", () => {
    const ID_C = `hiq:${SPORT}:${YEAR}:${SETKEY}:3:base:no-auto`;
    const ID_D = `hiq:${SPORT}:${YEAR}:${SETKEY}:4:base:no-auto`;
    // docX: cardId=ID_B (checklist-grade), hobbyiqCardId=ID_A -- pass 1
    // (hobbyiqCardId STARTSWITH) claims it via ID_A's prefix and reconciles
    // it onto cardId (patch in place, since ID_B is already docX's own
    // partition).
    const docX = SPLIT_SALE({ id: "dup-id-1", cardId: ID_B, hobbyiqCardId: ID_A, title: "2026 Topps Test Player #2" });
    // docY: SAME id ("dup-id-1"), but cardId=ID_D (checklist-grade),
    // hobbyiqCardId=ID_C -- a totally different sale/card pair, coincident
    // only on the id string. Pass 1's own hobbyiqCardId-prefix query never
    // sees it (ID_C's prefix is the same cell, so it WOULD be found by
    // pass 1 too under a bare cell scan -- seeded here at a DIFFERENT
    // cardId than docX's own address or docX's relocation target, so it
    // must be counted as a distinct document, never deduped away).
    const docY = SPLIT_SALE({ id: "dup-id-1", cardId: ID_D, hobbyiqCardId: ID_C, title: "2026 Topps Test Player #4" });
    const catalog = [
      CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" }),
      CATALOG_ROW({ id: ID_D, cardId: ID_D, cardNumber: "4" }),
    ];
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [docX, docY], catalog });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    // Both are HIQ-SPLIT candidates -- neither silently dropped.
    expect(r.out).toMatch(/candidates \(HIQ-SPLIT rows\)\s+2/);
    expect(r.out).toMatch(/distinct docs sharing an id\s+1/);
    // Both were reconciled to cardId (patch in place -- each doc's winning
    // id is already its own cardId).
    expect(r.out).toMatch(/-> to cardId\s+2/);
    // The ledger's upsert list has TWO entries for "dup-id-1" -- one per
    // document -- never collapsed into one.
    const upsertCountForId = r.led.salesUpserts.filter((id: string) => id === "dup-id-1").length;
    expect(upsertCountForId).toBe(2);
  });

  it("MUTATION: deduping by id alone would drop docY -- this pins that the shipped lane dedupes by the (id, cardId) pair instead", () => {
    // Direct proof against the shipped source: an id-only Set could not
    // distinguish docX's (dup-id-1, ID_B) from docY's (dup-id-1, ID_D) --
    // the moment either is added to an id-only seen-set, the other reads
    // as "already seen" and is dropped without ever being processed. The
    // committed file must NOT contain that shape.
    const laneSrc = fs.readFileSync(LANE, "utf8");
    expect(laneSrc).toContain("seenPairs");
    expect(laneSrc).not.toMatch(/const\s+seenIds\s*=\s*new Set/);
    // And the end-to-end behavior: re-run the docX/docY fixture and confirm
    // BOTH documents survive as two separate upserts, not one.
    const ID_C = `hiq:${SPORT}:${YEAR}:${SETKEY}:3:base:no-auto`;
    const ID_D = `hiq:${SPORT}:${YEAR}:${SETKEY}:4:base:no-auto`;
    const docX = SPLIT_SALE({ id: "dup-id-1", cardId: ID_B, hobbyiqCardId: ID_A, title: "2026 Topps Test Player #2" });
    const docY = SPLIT_SALE({ id: "dup-id-1", cardId: ID_D, hobbyiqCardId: ID_C, title: "2026 Topps Test Player #4" });
    const catalog = [
      CATALOG_ROW({ id: ID_B, cardId: ID_B, cardNumber: "2" }),
      CATALOG_ROW({ id: ID_D, cardId: ID_D, cardNumber: "4" }),
    ];
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [docX, docY], catalog });
    const upsertCountForId = r.led.salesUpserts.filter((id: string) => id === "dup-id-1").length;
    expect(upsertCountForId).toBe(2);
  });
});
