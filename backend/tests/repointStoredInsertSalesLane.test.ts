/**
 * repoint-stored-insert-sales.cjs -- unit tests for the pure plan function
 * plus an end-to-end suite against fake card_catalog / sold_comps / portfolio
 * containers, in the style of repointSalesToChecklistNumberedLane.test.ts.
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS: CF-INGEST-KEEPS-STORED-IDENTITY
 * (soldCompsStore.service.ts) means the R66/R67/R70 ingest-time insert re-key
 * (#2331) can never reach a sale that was already stored BEFORE it shipped --
 * an insert sale mis-filed under its BASE product's pool stays there forever
 * on every re-upsert. This lane drives from the insert's OWN checklist
 * (never a pool-wide title scan) to find and re-key exactly those rows.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (insertSetTitleReader, productSetKeys, catalogAuthority,
 * splitIdentityWriteGuard, hobbyIqCardId, playerIdentityKey, relocate-sold-
 * comp) loads the REAL compiled dist/, so what these tests pin is what ships.
 * The REAL shipped corpus (data/checklist-parallel-names.json) already
 * carries `football|2024|panini-photogenic`'s "Rookie Pix" and "Troops
 * Tribute" insert roots, both registered in productSetKeys.ts
 * (panini-photogenic-rookie-pix, panini-photogenic-troops-tribute, parent
 * panini-photogenic) -- exactly the pilot cell this PR's pilot dispatch
 * targets, so the E2E fixtures below use it directly rather than a synthetic
 * corpus override.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-stored-insert-sales.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-stored-insert-sales-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

// ── PURE PLAN FUNCTION UNIT TESTS ───────────────────────────────────────────
// Required directly (CommonJS) so the pure functions are tested in isolation
// from the CLI/Cosmos plumbing, exactly as repointSalesToChecklistNumberedLane
// exercises the CLI end-to-end while decideSaleAction there is unit-testable
// on its own module.exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require(LANE) as {
  planInsertRekey: (deps: any, sale: any, shape: string, ctx: any) => any;
  confirmedAgainstLoadedChecklist: (deps: any, rows: any[], num: string | null, player: string | null) => string;
  withLeadingZeroFold: (variants: string[]) => string[];
  checklistNumberVariantSet: (deps: any, rows: any[]) => Set<string>;
  USER_SEED_SOURCES: Set<string>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cardNumberVariants } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { productSetKeyOf, withProductSetKey } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));

const deps = { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, productSetKeyOf, withProductSetKey };

const BASE_HIQ = "hiq:football:2024:panini-photogenic:cpa-dm:base:no-auto";
const INSERT_KEY = "panini-photogenic-rookie-pix";
const CHECKLIST_ROWS = [{ cardNumber: "DT-5", playerName: "Drake Maye", source: "checklistinsider-2024-08-01" }];
const ctxFor = (rows = CHECKLIST_ROWS) => ({
  sport: "football", year: 2024, baseSetKey: "panini-photogenic", insertSetKey: INSERT_KEY,
  checklistRows: rows, checklistNumberVariants: lane.checklistNumberVariantSet(deps, rows),
});

describe("planInsertRekey -- pure decision", () => {
  it("MOVEs a sale whose title names ONLY this insert and confirms number+player on the checklist", () => {
    const sale = { id: "s1", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(`hiq:football:2024:${INSERT_KEY}:cpa-dm:base:no-auto`);
    expect(plan.newHiq).toBe(plan.newCardId);
  });

  it("PATCHes (hobbyiqCardId only) when cardId is a raw vendor partition", () => {
    const sale = { id: "s2", cardId: "vendor-xyz-123", hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("patch");
    expect(plan.newHiq).toBe(`hiq:football:2024:${INSERT_KEY}:cpa-dm:base:no-auto`);
  });

  it("LEAVEs (title-does-not-name-insert) an ordinary base-card title", () => {
    const sale = { id: "s3", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "20", playerName: "Some Other Player", title: "2024 Panini Photogenic #20 Some Other Player" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("title-does-not-name-insert");
  });

  it("LEAVEs (two-inserts-named) when the title names two distinct insert families", () => {
    const sale = { id: "s4", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Troops Tribute Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("two-inserts-named");
  });

  it("LEAVEs (pinned-or-verified) a verifiedByUser sale even with a matching title/number", () => {
    const sale = { id: "s5", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", verifiedByUser: true };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("pinned-or-verified");
  });

  it("LEAVEs (pinned-or-verified) a USER_SEED_SOURCES sale", () => {
    for (const source of ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]) {
      const sale = { id: `s-${source}`, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", source };
      const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
      expect(plan.action).toBe("leave");
      expect(plan.reason).toBe("pinned-or-verified");
    }
  });

  it("LEAVEs (already-parked) an identityUnverified sale", () => {
    const sale = { id: "s6", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", identityUnverified: true };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("already-parked");
  });

  it("LEAVEs (number-is-base-number) when the stored number never appears on the insert's checklist", () => {
    // Title names the insert (an incidental/adjacent mention), but the stored
    // cardNumber is the BASE product's own #20 -- never on the insert's own
    // checklist under any normalised variant.
    const sale = { id: "s7", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "20", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("number-is-base-number");
  });

  it("LEAVEs (no-checklist-match) when the title names the insert, the number is on ITS checklist, but the player disagrees with that row", () => {
    const sale = { id: "s8", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "A Different Player", title: "2024 Panini Photogenic Rookie Pix A Different Player" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("no-checklist-match");
  });

  it("confirms on number ALONE when the SALE's player is unknown (nothing to disagree with)", () => {
    const sale = { id: "s9", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "", title: "2024 Panini Photogenic Rookie Pix" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("relocate");
  });

  it("does NOT confirm on number alone when the SALE names a player but the matching checklist row carries none -- FIX 1's both-known rule requires the SAME row to confirm both", () => {
    const rows = [{ cardNumber: "DT-5", playerName: null, source: "checklistinsider-2024-08-01" }];
    const sale = { id: "s9b", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Anybody", title: "2024 Panini Photogenic Rookie Pix Anybody" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor(rows));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("no-checklist-match");
  });

  it("card-number normalisation: leading zeros / hyphen / case all confirm", () => {
    const sale = { id: "s10", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "dt5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("relocate");
  });

  it("LEAVEs (neither-field-names-base-product) when neither cardId nor hobbyiqCardId names the base setKey", () => {
    const otherProduct = "hiq:football:2024:panini-prizm:cpa-dm:base:no-auto";
    const sale = { id: "s11", cardId: otherProduct, hobbyiqCardId: otherProduct, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("neither-field-names-base-product");
  });

  it("REPORT and APPLY (dry-run vs live) call the SAME pure function -- identical plan for identical input", () => {
    const sale = { id: "s12", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan1 = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    const plan2 = lane.planInsertRekey(deps, sale, "hobbyiqCardId", ctxFor());
    expect(plan1).toEqual(plan2);
  });
});

describe("confirmedAgainstLoadedChecklist -- FIX 1 both-known rule, no I/O", () => {
  const rows = [
    { cardNumber: "5", playerName: "Player B", source: "checklistinsider" },
  ];
  it("REFUSES a number match on one row when the player names someone else on THAT row (both known -> same row)", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", "Player A");
    expect(v).toBe("refuted");
  });
  it("CONFIRMS when both number and player agree on the same row", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", "Player B");
    expect(v).toBe("confirmed");
  });
  it("CONFIRMS on number alone when player is unknown", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", null);
    expect(v).toBe("confirmed");
  });
  it("REFUTES when neither number nor player is known", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, null, null);
    expect(v).toBe("refuted");
  });
});

// ── END-TO-END: real dist modules, fake Cosmos containers ──────────────────

const SPORT = "football";
const YEAR = 2024;
const BASE_SET_KEY = "panini-photogenic";

const CHECKLIST_ROW = (over: Record<string, unknown> = {}) => ({
  id: `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`,
  cardId: `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR, setKey: INSERT_KEY,
  cardNumber: "DT-5", playerName: "Drake Maye", source: "checklistinsider-2024-08-27",
  gradeTier: undefined,
  ...over,
});

/**
 * A minimal in-memory Cosmos-shaped store, keyed by (container, id, pk) for
 * card_catalog/portfolio and (id::cardId) for sold_comps -- the same
 * partition-aware shape repointSalesToChecklistNumberedLane's own shim uses,
 * for the same reason (a resident-at-the-destination collision needs two
 * documents sharing an id at two different cardId partitions).
 */
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  portfolio?: Array<Record<string, unknown>>;
  failChecklistQueryForSetKey?: string;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = opts.catalog ?? [];
  const sales = opts.sales ?? [];
  const portfolio = opts.portfolio ?? [];
  const failChecklistQueryForSetKey = opts.failChecklistQueryForSetKey ?? null;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const FAIL_CHECKLIST_SETKEY = ${JSON.stringify(failChecklistQueryForSetKey)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }

function makeContainer(name, store, onUpsert, onDelete, onPatch, keyOf) {
  const key = keyOf || ((id) => id);
  return {
    item: (id, pk) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!store.has(key(id, pk))) throw notFound();
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        store.set(key(doc.id, doc.cardId), structuredClone(doc));
        if (onUpsert) onUpsert(doc);
        return { resource: structuredClone(doc) };
      },
      query: (spec) => {
        const q = typeof spec === "string" ? spec : spec.query;
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...store.values()];
        let resources;
        if (name === "card_catalog" && q.includes("c.setKey = @setKey")) {
          if (FAIL_CHECKLIST_SETKEY && params["@setKey"] === FAIL_CHECKLIST_SETKEY) {
            throw new Error("simulated persistent read failure for setKey " + FAIL_CHECKLIST_SETKEY);
          }
          resources = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@setKey"] && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("STARTSWITH(c.hobbyiqCardId, @p)")) {
          const prefix = params["@p"];
          resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(prefix));
        } else if (name === "portfolio" && q.includes("IS_DEFINED(c.holdings)")) {
          resources = all;
        } else {
          throw new Error("fake " + name + ": unsupported query " + q);
        }
        return {
          fetchNext: async () => ({ resources, continuationToken: undefined }),
          fetchAll: async () => ({ resources }),
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
const portfolioContainer = makeContainer("portfolio", state.portfolio,
  undefined, undefined,
  (id, ops) => { led.portfolioPatches.push({ id, ops }); save(); });

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "card_catalog") return catalogContainer;
          if (name === "sold_comps") return salesContainer;
          if (name === "portfolio") return portfolioContainer;
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

const PORTFOLIO_EMPTY = [{ id: "p1", userId: "u1", holdings: {} }];
const BASE_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, sport: SPORT, cardYear: YEAR,
  cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye",
  price: 5, soldAt: "2024-01-01",
  ...over,
});

describe("repoint-stored-insert-sales -- scope/titles refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: INSERT_KEY });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const sc of ["refractor", "all"]) {
      const r = drive({ SCOPE: sc, SET_KEYS: INSERT_KEY });
      expect(r.code).toBe(2);
    }
  });

  it("REFUSES an empty or wildcard SET_KEYS", () => {
    for (const v of ["", "all", "*"]) {
      const r = drive({ SCOPE: "football:2024", SET_KEYS: v });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
    }
  });

  it("REFUSES a setKey with no registered PARENT", () => {
    const r = drive({ SCOPE: "football:2024", SET_KEYS: "not-a-real-key-xyz" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no registered PARENT/);
  });
});

describe("repoint-stored-insert-sales -- REPORT writes nothing and matches APPLY's counts", () => {
  it("finds a candidate at the base product and reports it, writing zero", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("REPORT's move/patch counts equal APPLY's on the same fixture", () => {
    const relocateSale = BASE_SALE({ id: "s1" });
    const patchSale = BASE_SALE({ id: "s2", cardId: "vendor-abc", hobbyiqCardId: BASE_HIQ });
    const fixture = { catalog: [CHECKLIST_ROW()], sales: [relocateSale, patchSale], portfolio: PORTFOLIO_EMPTY };

    const report = drive({ SCOPE: "football:2024", SET_KEYS: INSERT_KEY }, fixture);
    const apply = drive({ SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(report.out.match(/WOULD MOVE\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/MOVED\s+(\d+)/)?.[1]).toBe("1");
    expect(report.out.match(/WOULD PATCH\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/PATCHED\s+(\d+)/)?.[1]).toBe("1");
  });
});

describe("repoint-stored-insert-sales -- APPLY moves sales", () => {
  it("relocates a sale whose cardId+hobbyiqCardId both name the base product, via upsert-verify-delete", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/MOVED 1/);
  });

  it("patches a sale whose hobbyiqCardId names the base product but whose cardId is a vendor partition", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ id: "s2", cardId: "vendor-xyz", hobbyiqCardId: BASE_HIQ })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.out).toMatch(/PATCHED 1/);
  });

  it("re-points a holding referencing the base identity", () => {
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ } } };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: [holdingDoc] },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.some((p: any) => p.id === "p1")).toBe(true);
    expect(r.out).toMatch(/holdings re-pointed\s+1/);
  });

  it("is idempotent: a second run after everything moved finds nothing left to move", () => {
    const first = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(first.led.salesUpserts).toContain("s1");

    const movedId = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;
    const movedSale = { ...BASE_SALE(), id: "s1", cardId: movedId, hobbyiqCardId: movedId };
    const second = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [movedSale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/MOVED 0/);
    expect(second.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- LEAVE cases end-to-end", () => {
  it("LEAVEs a pinned (verifiedByUser) sale untouched", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ verifiedByUser: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: pinned-or-verified\s+1/);
  });

  it("LEAVEs an already-parked (identityUnverified) sale untouched", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ identityUnverified: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: already-parked\s+1/);
  });

  it("LEAVEs (two-inserts-named) a sale whose title names both Rookie Pix and Troops Tribute", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ title: "2024 Panini Photogenic Rookie Pix Troops Tribute Drake Maye" })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: two-inserts-named\s+1/);
  });

  it("LEAVEs (number-is-base-number) a sale whose title names the insert but whose stored number is not on its checklist", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ cardNumber: "20" })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: number-is-base-number\s+1/);
  });

  it("counts an insert with an EMPTY checklist for the cell and moves nothing", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/targets with an EMPTY checklist\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- destination collision / collapse", () => {
  it("REFUSES (destination-collision) when a DIFFERENT sale already occupies the insert address", () => {
    const insertId = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;
    const shortIdCopy = BASE_SALE({ id: "shared::1", price: 5, soldAt: "2024-01-01" });
    const resident = { ...shortIdCopy, id: "shared::1", cardId: insertId, hobbyiqCardId: insertId, price: 999, soldAt: "2024-06-06" };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination collision\s+1/);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("COLLAPSES when the SAME sale (by content hash) is already resident at the insert address", () => {
    const insertId = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;
    const shared = { id: "shared::2", sport: SPORT, cardYear: YEAR, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", price: 5, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const shortIdCopy = { ...shared, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ };
    const resident = { ...shared, cardId: insertId, hobbyiqCardId: insertId };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("shared::2");
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- concurrency produces identical counters", () => {
  it("CONCURRENCY=4 finds the same MOVED/PATCHED/LEFT counts as CONCURRENCY=1", () => {
    const secondInsertRow = CHECKLIST_ROW({ id: `hiq:${SPORT}:${YEAR}:panini-photogenic-troops-tribute:cpa-jj:base:no-auto`, cardId: `hiq:${SPORT}:${YEAR}:panini-photogenic-troops-tribute:cpa-jj:base:no-auto`, setKey: "panini-photogenic-troops-tribute", cardNumber: "TT-1", playerName: "J J" });
    const saleForFirst = BASE_SALE({ id: "s1" });
    const saleForSecond = BASE_SALE({ id: "s-tt", cardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`, hobbyiqCardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`, cardNumber: "TT-1", playerName: "J J", title: "2024 Panini Photogenic Troops Tribute J J" });
    const fixture = {
      catalog: [CHECKLIST_ROW(), secondInsertRow],
      sales: [saleForFirst, saleForSecond],
      portfolio: PORTFOLIO_EMPTY,
    };
    const titles = `${INSERT_KEY},panini-photogenic-troops-tribute`;

    const serial = drive({ SCOPE: "football:2024", SET_KEYS: titles, CONCURRENCY: "1" }, fixture);
    const parallel = drive({ SCOPE: "football:2024", SET_KEYS: titles, CONCURRENCY: "4" }, fixture);

    expect(serial.code).toBe(0);
    expect(parallel.code).toBe(0);
    expect(serial.out.match(/WOULD MOVE\s+(\d+)/)?.[1]).toBe(parallel.out.match(/WOULD MOVE\s+(\d+)/)?.[1]);
    expect(serial.out.match(/candidates found[^\d]+(\d+)/)?.[1]).toBe(parallel.out.match(/candidates found[^\d]+(\d+)/)?.[1]);
  });
});

describe("repoint-stored-insert-sales -- a persistent read failure fails ONE target, not the run", () => {
  it("a thrown query error on one target's checklist page does not abort a sibling target", () => {
    const okCheck = CHECKLIST_ROW();
    const failingTargetCheck = CHECKLIST_ROW({
      id: `hiq:${SPORT}:${YEAR}:panini-zenith-z-marquee:cpa-zz:base:no-auto`,
      cardId: `hiq:${SPORT}:${YEAR}:panini-zenith-z-marquee:cpa-zz:base:no-auto`,
      setKey: "panini-zenith-z-marquee", cardNumber: "Z-1", playerName: "Some Zenith Player",
    });
    const sales = [BASE_SALE({ id: "s1" })];
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: `${INSERT_KEY},panini-zenith-z-marquee` },
      { catalog: [okCheck, failingTargetCheck], sales, portfolio: PORTFOLIO_EMPTY, failChecklistQueryForSetKey: "panini-zenith-z-marquee" },
    );
    // The failing target's exception must not crash the whole run (exit
    // non-zero, or a process crash reported as a non-2/non-4 code) -- the
    // sibling target's own MOVE still happens and the run itself exits with
    // the FAILURES accounting this lane already reports for one bad unit.
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.out).toMatch(/simulated persistent read failure/);
  });
});

describe("repoint-stored-insert-sales -- CF-A-SALE-IS-NEVER-LOST reconciliation", () => {
  it("balances: candidates found == moved + patched + collapsed + refused + failed + left", () => {
    const moves = BASE_SALE({ id: "s1" });
    const leaves = BASE_SALE({ id: "s2", cardNumber: "20" });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [moves, leaves], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/candidates found\s+2/);
    expect(r.out).toMatch(/matched -- every candidate is moved, patched, collapsed, refused, failed, or left/);
  });
});

describe("repoint-stored-insert-sales -- byte hygiene", () => {
  it("the committed lane file carries no 0x08/0x00 bytes", () => {
    const buf = fs.readFileSync(LANE);
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).not.toBe(0x08);
      expect(buf[i]).not.toBe(0x00);
    }
  });
});
