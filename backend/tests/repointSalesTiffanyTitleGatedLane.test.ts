/**
 * repoint-sales-tiffany-title-gated.cjs -- end-to-end against a fake
 * sold_comps + card_catalog, modelled on repointSalesCardNumberSuffixLane.
 * test.ts's own shim (etag-aware upsert/read/delete via relocate-sold-
 * comp.cjs's real relocateSoldComp).
 *
 * OWNER RULING (Drew, 2026-09-22): "1989 Traded -> Tiffany: move only when
 * title says Tiffany." A Topps / Topps Traded baseball sale, 1984-1991
 * (the years Tiffany actually shipped), moves onto its Tiffany sibling
 * ONLY when the sale's own title matches /\bTiffany\b/i -- never inferred
 * from card number, print run, or vendor tag, because CF-A-TIFFANY-SALE-IS-
 * A-TIFFANY-CARD (SAME_NUMBER_PARALLEL_SETS, productSetKeys.ts) already
 * establishes that Tiffany reprints its flagship's checklist card-for-card
 * on the SAME numbers -- the number carries no information here.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load;
 * every other require (hobbyIqCardId, catalogAuthority, playerIdentityKey,
 * splitIdentityWriteGuard, ...) loads the REAL compiled dist/, so what
 * these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-tiffany-title-gated.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-tiffany-title-gated-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const SPORT = "baseball";
const YEAR = 1989;
const TOPPS_PREFIX = `hiq:${SPORT}:${YEAR}:topps:`;
const TRADED_PREFIX = `hiq:${SPORT}:${YEAR}:topps-traded:`;
const TIFFANY_PREFIX = `hiq:${SPORT}:${YEAR}:topps-tiffany:`;
const TRADED_TIFFANY_PREFIX = `hiq:${SPORT}:${YEAR}:topps-traded-tiffany:`;

/** A STRICT checklist row at the given id/cardNumber/playerName. */
const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: `${TIFFANY_PREFIX}1:base:no-auto`, cardId: `${TIFFANY_PREFIX}1:base:no-auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: "topps-tiffany", cardNumber: "1", parallelSlug: "Base", isAuto: false,
  playerName: "George Bell", source: "sportscardchecklist-2026-08",
  gradeTier: undefined,
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

describe("repoint-sales-tiffany-title-gated -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES a non-baseball sport", () => {
    const r = drive({ SCOPE: "basketball:1989" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/FATAL: SCOPE carries/);
  });

  it("REFUSES a year outside 1984-1991 (Tiffany never shipped)", () => {
    for (const y of [1983, 1992, 2024]) {
      const r = drive({ SCOPE: `${SPORT}:${y}` });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/1984-1991/);
    }
  });

  it("ACCEPTS every boundary year 1984 and 1991", () => {
    for (const y of [1984, 1991]) {
      const r = drive({ SCOPE: `${SPORT}:${y}` }, { sales: [], catalog: [] });
      expect(r.code).toBe(0);
    }
  });

  it("REFUSES an unknown titles value", () => {
    const r = drive({ ...DEFAULT_ENV, SET_KEYS: "bowman" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/titles carries/);
  });

  it("REFUSES a wildcard SCOPE ('all' or 'refractor', the runner's inherited defaults)", () => {
    for (const v of ["all", "refractor", ""]) {
      const r = drive({ SCOPE: v });
      expect(r.code).toBe(2);
    }
  });
});

describe("repoint-sales-tiffany-title-gated -- titleSaysTiffany / nameContainsTiffany (unit)", () => {
  const lane = require(LANE);

  it("matches Tiffany as a whole word, case-insensitively", () => {
    expect(lane.titleSaysTiffany("1989 Topps Traded Tiffany Ken Griffey Jr")).toBe(true);
    expect(lane.titleSaysTiffany("1989 topps tiffany #1")).toBe(true);
    expect(lane.titleSaysTiffany("1989 TOPPS TIFFANY GLOSSY")).toBe(true);
  });

  it("does NOT match a title with no Tiffany token at all -- THE GATE", () => {
    expect(lane.titleSaysTiffany("1989 Topps Traded Ken Griffey Jr #41T RC")).toBe(false);
    expect(lane.titleSaysTiffany("1989 Topps #1 George Bell")).toBe(false);
    expect(lane.titleSaysTiffany("")).toBe(false);
    expect(lane.titleSaysTiffany(undefined)).toBe(false);
  });

  it("does NOT match a substring that merely contains the letters (word-bounded)", () => {
    expect(lane.titleSaysTiffany("1989 Topps Tiffanyxx special")).toBe(false);
    expect(lane.titleSaysTiffany("xTiffany 1989 Topps")).toBe(false);
  });

  // COORDINATOR FIX (PR #2426 review): a bare `\bTiffany\b` matches
  // "Tiffany's" and "Tiffany-like" too, because an apostrophe and a hyphen
  // are BOTH non-word characters, so `\b` (word-char / non-word-char
  // boundary) fires right after the "y" regardless of what follows. The
  // trailing edge is now a lookahead requiring whitespace, a digit, '#',
  // ')', or end-of-string -- never an apostrophe or a hyphen.
  it("does NOT match a possessive ('Tiffany's') -- the trailing edge is not a bare \\b", () => {
    expect(lane.titleSaysTiffany("Tiffany's Card Shop 1989 Topps #1")).toBe(false);
    expect(lane.titleSaysTiffany("1989 Topps Tiffany's Auction")).toBe(false);
  });

  it("does NOT match a compound word ('Tiffany-like') -- the trailing edge is not a bare \\b", () => {
    expect(lane.titleSaysTiffany("1989 Topps Tiffany-like glossy reprint")).toBe(false);
    expect(lane.titleSaysTiffany("1989 Topps Tiffany-style #1")).toBe(false);
  });

  it("MATCHES 'Tiffany #1' and 'Tiffany 1989' -- the token followed by '#' or a digit is a real Tiffany mention", () => {
    expect(lane.titleSaysTiffany("1989 Topps Tiffany #1 George Bell")).toBe(true);
    expect(lane.titleSaysTiffany("1989 Topps Tiffany 1989 George Bell")).toBe(true);
  });

  it("MATCHES the token at end-of-string and before a closing paren", () => {
    expect(lane.titleSaysTiffany("1989 Topps Tiffany")).toBe(true);
    expect(lane.titleSaysTiffany("1989 Topps (Tiffany) George Bell")).toBe(true);
  });

  it("nameContainsTiffany fires on a person literally named Tiffany", () => {
    expect(lane.nameContainsTiffany("Tiffany Jones")).toBe(true);
    expect(lane.nameContainsTiffany("George Bell")).toBe(false);
    expect(lane.nameContainsTiffany(null)).toBe(false);
  });
});

describe("repoint-sales-tiffany-title-gated -- THE TITLE GATE (end-to-end, mutation-tested)", () => {
  it("MOVES a Topps sale whose title says Tiffany onto the topps-tiffany checklist row", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
  });

  it("LEAVES a Topps sale whose title does NOT say Tiffany untouched -- THE GATE", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 5, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-tiffany-title\s+1/);
  });

  it("MOVES a Topps Traded sale whose title says Tiffany onto topps-traded-tiffany", () => {
    const fromId = `${TRADED_PREFIX}41t:base:no-auto`;
    const destRow = CATALOG_ROW({
      id: `${TRADED_TIFFANY_PREFIX}41t:base:no-auto`, cardId: `${TRADED_TIFFANY_PREFIX}41t:base:no-auto`,
      setKey: "topps-traded-tiffany", cardNumber: "41T", playerName: "Ken Griffey Jr",
    });
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Traded Tiffany #41T Ken Griffey Jr RC",
      sport: SPORT, cardYear: YEAR, price: 800, isAuto: false, playerName: "Ken Griffey Jr",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
  });

  it("LEAVES a Topps Traded sale whose title does not say Tiffany untouched, even though its title says 'Traded'", () => {
    const fromId = `${TRADED_PREFIX}41t:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Traded #41T Ken Griffey Jr RC PSA 10",
      sport: SPORT, cardYear: YEAR, price: 300, isAuto: false, playerName: "Ken Griffey Jr",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-tiffany-title\s+1/);
  });

  // COORDINATOR FIX (PR #2426 review): end-to-end proof that the tightened
  // trailing-edge boundary actually gates a real sale, not just the unit
  // predicate above.
  it("LEAVES a sale whose title says \"Tiffany's\" (possessive) untouched -- never read as the finish token", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps #1 George Bell -- from Tiffany's Card Shop",
      sport: SPORT, cardYear: YEAR, price: 5, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-tiffany-title\s+1/);
  });

  it("MOVES a sale whose title says \"Tiffany #1\" (token followed by '#')", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
  });

  it("MOVES a sale whose title says \"Tiffany 1989\" (token followed by a digit)", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "Topps Tiffany 1989 George Bell #1",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
  });

  it("REPORT mode finds the same candidate, checks the SAME catalog/name guards, and writes nothing", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-tiffany-title-gated -- the name guard", () => {
  it("LEAVES a sale whose OWN player name literally contains 'Tiffany' untouched, even with a Tiffany title token", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps #1 Tiffany Jones rookie",
      sport: SPORT, cardYear: YEAR, price: 5, isAuto: false, playerName: "Tiffany Jones",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW({ playerName: "Tiffany Jones" })] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: name-guard\s+1/);
  });

  it("LEAVES a sale when the DESTINATION catalog row's player name contains 'Tiffany'", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const destRow = CATALOG_ROW({ playerName: "Tiffany Someone" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: name-guard\s+1/);
  });
});

describe("repoint-sales-tiffany-title-gated -- destination must be a STRICT checklist row", () => {
  it("LEFT (no-dest-row) when no catalog row exists at the resolved Tiffany address", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-dest-row\s+1/);
    expect(r.out).toMatch(/acquisition-gap census/);
  });

  it("LEFT (no-dest-row) when the destination row exists but its SOURCE is not a strict checklist authority", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const vendorRow = CATALOG_ROW({ source: "cardsight" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [vendorRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-dest-row\s+1/);
  });

  it("LEFT (no-dest-row) when the checklist row at the destination names a DIFFERENT player", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "A Totally Different Player",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: no-dest-row\s+1/);
  });
});

describe("repoint-sales-tiffany-title-gated -- possible-twin-at-destination", () => {
  it("REFUSES rather than overwrites when a DIFFERENT document already resides at the destination", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const destId = `${TIFFANY_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const differentResident = {
      id: "s1", cardId: destId, hobbyiqCardId: destId,
      title: "totally unrelated listing", sport: SPORT, cardYear: YEAR,
      price: 9999, isAuto: false, playerName: "George Bell",
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

  it("COLLAPSES (never a REFUSED count) when the resident at the destination is a byte-identical twin of the SAME sale", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const destId = `${TIFFANY_PREFIX}1:base:no-auto`;
    const baseSale = {
      id: "s1", title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const sale = { ...baseSale, cardId: fromId, hobbyiqCardId: fromId };
    const twin = { ...baseSale, cardId: destId, hobbyiqCardId: destId };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale, twin], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+0/);
    expect(r.led.salesDeletes).toContain("s1");
  });
});

describe("repoint-sales-tiffany-title-gated -- titles filter (SET_KEYS)", () => {
  it("with titles=topps-traded, a Tiffany-titled bare TOPPS sale is left untouched (out of the requested source scope)", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, SET_KEYS: "topps-traded", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/candidates \(topps\/topps-traded shape\) 0/);
  });

  it("with titles=topps (BCP_TITLES alias), the same sale IS a candidate and moves", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BCP_TITLES: "topps", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
  });
});

describe("repoint-sales-tiffany-title-gated -- reconcile", () => {
  it("reconciles: candidates == accounted-for", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reconciled: candidates \d+ = accounted-for \d+/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });

  it("reconciles across a mixed batch: moved + left(no-tiffany-title) + left(no-dest-row) + left(name-guard)", () => {
    const moved = {
      id: "s1", cardId: `${TOPPS_PREFIX}1:base:no-auto`, hobbyiqCardId: `${TOPPS_PREFIX}1:base:no-auto`,
      title: "1989 Topps Tiffany #1 George Bell", sport: SPORT, cardYear: YEAR, price: 40,
      isAuto: false, playerName: "George Bell", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const noTitle = {
      id: "s2", cardId: `${TOPPS_PREFIX}2:base:no-auto`, hobbyiqCardId: `${TOPPS_PREFIX}2:base:no-auto`,
      title: "1989 Topps #2 Wade Boggs", sport: SPORT, cardYear: YEAR, price: 5,
      isAuto: false, playerName: "Wade Boggs", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const noDest = {
      id: "s3", cardId: `${TOPPS_PREFIX}3:base:no-auto`, hobbyiqCardId: `${TOPPS_PREFIX}3:base:no-auto`,
      title: "1989 Topps Tiffany #3 Nolan Ryan", sport: SPORT, cardYear: YEAR, price: 40,
      isAuto: false, playerName: "Nolan Ryan", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const nameGuard = {
      id: "s4", cardId: `${TOPPS_PREFIX}4:base:no-auto`, hobbyiqCardId: `${TOPPS_PREFIX}4:base:no-auto`,
      title: "1989 Topps #4 Tiffany Ann Player", sport: SPORT, cardYear: YEAR, price: 5,
      isAuto: false, playerName: "Tiffany Ann Player", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [moved, noTitle, noDest, nameGuard], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reconciled: candidates 4 = accounted-for 4/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });
});

// ── MUTATION CHECK 1: remove the title gate -- every candidate would be
// treated as though its title said Tiffany. Simulated by patching a TEMP
// COPY of the committed lane's `titleSaysTiffany` to always return true,
// leaving everything else (including the name guard and dest-row check)
// untouched, and proving the resulting behavior is WRONG (moves a sale with
// no Tiffany token at all).
describe("repoint-sales-tiffany-title-gated -- MUTATION: removing the title gate is caught", () => {
  const LANE_SRC = fs.readFileSync(LANE, "utf8");
  const REGRESSED_LANE = path.join(backend, "scripts", `.repoint-sales-tiffany-title-gated.NO-GATE.${process.pid}.cjs`);
  afterAll(() => { try { fs.rmSync(REGRESSED_LANE, { force: true }); } catch { /* best effort */ } });

  function noGateSrc() {
    const patched = LANE_SRC.replace(
      "function titleSaysTiffany(title) {\n  return TIFFANY_TITLE_RE.test(String(title ?? \"\"));\n}",
      "function titleSaysTiffany(title) {\n  return true; // MUTATED: the gate is removed\n}",
    );
    expect(patched, "titleSaysTiffany patch point not found").not.toBe(LANE_SRC);
    return patched;
  }

  function driveRegressed(env: Record<string, string>, opts: Parameters<typeof shim>[0]) {
    fs.writeFileSync(REGRESSED_LANE, noGateSrc());
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

  it("with the gate removed, a NO-Tiffany-title sale WOULD move -- proving the gate is what stops it on the real lane", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps #1 George Bell", // no Tiffany token anywhere
      sport: SPORT, cardYear: YEAR, price: 5, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const regressed = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(regressed.led.salesUpserts).toContain("s1"); // the mutation: moved despite no Tiffany title

    // The REAL, committed lane on the SAME input must leave it alone.
    const real = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(real.led.salesUpserts.length).toBe(0);
    expect(real.out).toMatch(/LEFT: no-tiffany-title\s+1/);
  });
});

// ── MUTATION CHECK 2: remove the dest-row check -- a candidate would move
// even with no checklist row at the destination, minting an unattested
// Tiffany identity from a sale title alone.
describe("repoint-sales-tiffany-title-gated -- MUTATION: removing the dest-row check is caught", () => {
  const LANE_SRC = fs.readFileSync(LANE, "utf8");
  const REGRESSED_LANE = path.join(backend, "scripts", `.repoint-sales-tiffany-title-gated.NO-DEST-CHECK.${process.pid}.cjs`);
  afterAll(() => { try { fs.rmSync(REGRESSED_LANE, { force: true }); } catch { /* best effort */ } });

  function noDestCheckSrc() {
    const patched = LANE_SRC.replace(
      `    // ── THE DESTINATION MUST BE A STRICT CHECKLIST ROW, PLAYER-MATCHED, AND
    // ITS OWN PLAYER NAME MUST NOT BE A TIFFANY NAME-GUARD FALSE POSITIVE.
    let destRow;
    try {
      destRow = await catalogRowAt(newId);
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = \`FAILED catalog-read \${sale.id}@\${currentId} -> \${newId}: [\${code}] \${e?.message || e} -- nothing written, sale untouched at its old address\`;
      failures.push(\`  \${msg}\`);
      emitPlanRow(sale, "failed", "catalog-read", { fromKey, toKey, target: newId, error: \`[\${code}] \${e?.message || String(e)}\` });
      console.log(\`\\n::warning::\${msg}\`);
      return;
    }
    if (!destRow || !isChecklist(destRow.source)) {
      s.leftNoDestRow++;
      const bucketKey = \`\${fromKey}|\${segs.cardNumber}\`;
      noDestRowByCardNumber.set(bucketKey, (noDestRowByCardNumber.get(bucketKey) ?? 0) + 1);
      emitPlanRow(sale, "left", "no-dest-row", { fromKey, toKey, target: newId });
      return;
    }
    if (nameContainsTiffany(destRow.playerName)) {
      s.leftNameGuard++;
      emitPlanRow(sale, "left", "name-guard", { fromKey, toKey, target: newId });
      return;
    }
    if (!playerMatches(sale.playerName, destRow.playerName)) {
      s.leftNoDestRow++; // absent beats wrong -- filed under the same "no attested destination" bucket
      const bucketKey = \`\${fromKey}|\${segs.cardNumber}\`;
      noDestRowByCardNumber.set(bucketKey, (noDestRowByCardNumber.get(bucketKey) ?? 0) + 1);
      emitPlanRow(sale, "left", "no-dest-row", { fromKey, toKey, target: newId, error: "player-mismatch" });
      return;
    }`,
      `    // MUTATED: the entire destination-row / name-guard / player-match check is removed.`,
    );
    expect(patched, "dest-row check patch point not found").not.toBe(LANE_SRC);
    return patched;
  }

  function driveRegressed(env: Record<string, string>, opts: Parameters<typeof shim>[0]) {
    fs.writeFileSync(REGRESSED_LANE, noDestCheckSrc());
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

  it("with the dest-row check removed, a sale moves with NO checklist row at the destination -- proving the check is what stops it on the real lane", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: YEAR, price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    // No catalog rows seeded at all.
    const regressed = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(regressed.led.salesUpserts).toContain("s1"); // the mutation: moved with no attested destination

    const real = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(real.led.salesUpserts.length).toBe(0);
    expect(real.out).toMatch(/LEFT: no-dest-row\s+1/);
  });
});

// COORDINATOR FIX (PR #2426 review): the destination's YEAR must come from
// the id the sale was actually SCANNED under (segs.year), never from
// sale.cardYear / sale.year, which can disagree with the address a sale
// lives at (a stale or mismatched field on the document). Building the
// destination from a field instead of the id could silently move a sale
// filed under one year's cell onto a DIFFERENT year's Tiffany product.
describe("repoint-sales-tiffany-title-gated -- destination year is IDENTITY-PRESERVING (from the id, never sale.cardYear)", () => {
  it("when sale.cardYear disagrees with the id's own year, the destination is still built from the ID'S year", () => {
    // The sale lives at the 1989 cell (its id's own year segment is 1989 --
    // this is also what the SCOPE=baseball:1989 STARTSWITH query selected
    // it under), but its own cardYear FIELD says 1990 -- a stale/mismatched
    // field that must never override the address the row was found at.
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`; // hiq:baseball:1989:topps:1:base:no-auto
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: 1990, year: 1990, // deliberately disagrees with the id's 1989
      price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    // A 1990-dated destination row (the WRONG target if the field won) is
    // absent; only the 1989 destination row (the id's own year) exists.
    const destRow1989 = CATALOG_ROW(); // topps-tiffany:1:base:no-auto @ YEAR=1989, matches TIFFANY_PREFIX
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [destRow1989] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/MOVED\s+1/);
    // The example line prints "<fromId> -> <newId>" -- the new id must carry
    // the ID'S year (1989), never the disagreeing field's year (1990).
    expect(r.out).toContain(`${TOPPS_PREFIX}1:base:no-auto -> ${TIFFANY_PREFIX}1:base:no-auto`);
    expect(r.out).not.toMatch(/hiq:baseball:1990:topps-tiffany/);
  });

  it("REPORT mode: same identity-preserving year, with a destination row that only exists at the id's own (1989) year", () => {
    const fromId = `${TOPPS_PREFIX}1:base:no-auto`;
    const sale = {
      id: "s1", cardId: fromId, hobbyiqCardId: fromId,
      title: "1989 Topps Tiffany #1 George Bell",
      sport: SPORT, cardYear: 1990, year: 1990,
      price: 40, isAuto: false, playerName: "George Bell",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.out).toContain(`${TOPPS_PREFIX}1:base:no-auto -> ${TIFFANY_PREFIX}1:base:no-auto`);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-tiffany-title-gated -- destination keys resolved from the live code, printed in the banner", () => {
  it("prints topps -> topps-tiffany and topps-traded -> topps-traded-tiffany", () => {
    const r = drive(DEFAULT_ENV, { sales: [], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/destination keys resolved\s+topps -> topps-tiffany, topps-traded -> topps-traded-tiffany/);
  });
});

// ── workflow wiring ──────────────────────────────────────────────────────────

describe("repoint-sales-tiffany-title-gated -- workflow wiring (backfill-runner.yml)", () => {
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
    expect(workflow).toContain("- repoint-sales-tiffany-title-gated");
  });

  it("uploads this lane's log as a durable artifact", () => {
    expect(workflow).toMatch(/Upload the repoint-sales-tiffany-title-gated log/);
    expect(workflow).toMatch(/inputs\.script == 'repoint-sales-tiffany-title-gated'/);
  });

  it("wires PLAN_OUT to a fixed, script-guarded path", () => {
    expect(workflow).toMatch(/inputs\.script == 'repoint-sales-tiffany-title-gated' && '\/tmp\/repoint-sales-tiffany-title-gated-plan'/);
  });

  it("self-relaunches on the budget marker, forwarding scope/titles/slot/slots/apply/concurrency", () => {
    const idx = workflow.indexOf("Self-relaunch the tiffany title-gated repoint");
    expect(idx).toBeGreaterThan(-1);
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain("repoint-sales-tiffany-title-gated");
    expect(block).toContain('-f scope="${{ inputs.scope }}"');
    expect(block).toContain('-f titles="${{ inputs.titles }}"');
    expect(block).toContain('-f slot="${{ inputs.slot }}"');
    expect(block).toContain('-f slots="${{ inputs.slots }}"');
    expect(block).toContain('-f apply="${{ inputs.apply }}"');
    expect(block).toContain('-f concurrency="${{ inputs.concurrency }}"');
  });

  it("does NOT touch .github/actions/relaunch-on-marker/action.yml", () => {
    // This test only pins that the workflow file uses the existing action
    // (`uses: ./.github/actions/relaunch-on-marker`) rather than a modified
    // copy -- the action file itself is a separate, untouched file in this
    // PR, verified by the diff, not by this suite.
    const idx = workflow.indexOf("Self-relaunch the tiffany title-gated repoint");
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain("uses: ./.github/actions/relaunch-on-marker");
  });
});

// ── source file byte size (mirrors the workflow's own 512 KB pin) ──────────

describe("repoint-sales-tiffany-title-gated -- lane file size", () => {
  it("the lane script stays well under 512 KB", () => {
    const bytes = fs.statSync(LANE).size;
    expect(bytes).toBeLessThan(512 * 1024);
  });
});
