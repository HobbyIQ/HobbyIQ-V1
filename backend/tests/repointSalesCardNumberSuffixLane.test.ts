/**
 * repoint-sales-cardnumber-suffix.cjs -- end-to-end against a fake sold_comps
 * + card_catalog, modelled on repointSalesParallelSuffixLane.test.ts's own
 * shim (etag-aware upsert/read/delete via relocate-sold-comp.cjs's real
 * relocateSoldComp).
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
 * COORDINATOR REVIEW (post-initial-PR): the lane moved a sale purely off a
 * strict-suffix-restore string predicate, with NO check that the destination
 * is a real, checklist-attested card whose player matches. Fixed here: every
 * candidate now requires a STRICT checklist row at the destination id AND a
 * player match (mirrors repoint-sales-parallel-suffix.cjs ~L939-972), and
 * never touches a verifiedByUser/flaggedWrong/excludedFromFmv/
 * identityUnverified row, and refuses (never overwrites) when a DIFFERENT
 * document already sits at the destination.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (parseTitleIdentity, hobbyIqCardId, catalogAuthority,
 * playerIdentityKey, splitIdentityWriteGuard, ...) loads the REAL compiled
 * dist/, so what these tests pin is what ships.
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

/** A STRICT checklist row at the given id/cardNumber/playerName -- the
 *  destination this lane now requires before it will ever move a sale. */
const CATALOG_ROW = (over: Record<string, unknown> = {}) => ({
  id: `${PREFIX}b24-cmo:base:auto`, cardId: `${PREFIX}b24-cmo:base:auto`,
  sport: SPORT, year: YEAR, cardYear: YEAR,
  setKey: SET_KEY, cardNumber: "B24-CMO", parallelSlug: "Base", isAuto: true,
  playerName: "Colson Montgomery", source: "checklistinsider-2026-08-27",
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

  it("is false for a PARTIAL suffix -- 'b24-c' does not extend to 'b24-cmo'", () => {
    // A sale stuck at "b24-c" (some earlier partial-parse artifact) must
    // never be treated as restorable onto "b24-cmo" -- "b24-c" is not a
    // prefix-with-hyphen of "b24-cmo" in the required shape (oldSeg + "-"),
    // it already HAS its own (wrong) suffix.
    expect(lane.isSuffixRestore("b24-c", "b24-cmo")).toBe(false);
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
  it("relocates a sale stuck at the bare 'b24' address onto the suffix-restored, checklist-attested 'b24-cmo' address", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best - Best of 2024 Autographs Colson Montgomery #B24-CMO (AU, RC)",
      sport: SPORT, cardYear: YEAR, price: 50, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/RELOCATED\s+1/);
  });

  it("REPORT mode finds the same candidate, checks the SAME catalog/player guards, and writes nothing", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "Brayden Taylor 2024 Bowman's Best #B24-BT Refractor Best of Auto",
      sport: SPORT, cardYear: YEAR, price: 50, isAuto: true, playerName: "Brayden Taylor",
      soldAt: "2026-05-22T02:05:00.000Z", source: "cardsight",
    };
    const catalogRow = CATALOG_ROW({
      id: `${PREFIX}b24-bt:refractor:auto`, cardId: `${PREFIX}b24-bt:refractor:auto`,
      cardNumber: "B24-BT", parallelSlug: "Refractor", playerName: "Brayden Taylor",
    });
    const r = drive(DEFAULT_ENV, { sales: [sale], catalog: [catalogRow] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RELOCATE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("collapses several different players correctly onto their OWN distinct, checklist-attested addresses, ending the one-pool collision", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sales = [
      { id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox", sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery", soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight" },
      { id: "s2", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Cam Smith Auto #B24-CS Cubs", sport: SPORT, cardYear: YEAR, price: 25, isAuto: true, playerName: "Cam Smith", soldAt: "2026-07-02T01:44:51.000Z", source: "cardsight" },
      { id: "s3", cardId: collapsedId, hobbyiqCardId: collapsedId, title: "2024 Bowman's Best Felix Morrobel Auto Autograph Refractor #B24-FM Angels", sport: SPORT, cardYear: YEAR, price: 40, isAuto: true, playerName: "Felix Morrobel", soldAt: "2026-07-06T00:00:00.000Z", source: "cardsight" },
    ];
    const catalog = [
      CATALOG_ROW({ id: `${PREFIX}b24-cmo:base:auto`, cardId: `${PREFIX}b24-cmo:base:auto`, cardNumber: "B24-CMO", parallelSlug: "Base", playerName: "Colson Montgomery" }),
      CATALOG_ROW({ id: `${PREFIX}b24-cs:base:auto`, cardId: `${PREFIX}b24-cs:base:auto`, cardNumber: "B24-CS", parallelSlug: "Base", playerName: "Cam Smith" }),
      CATALOG_ROW({ id: `${PREFIX}b24-fm:refractor:auto`, cardId: `${PREFIX}b24-fm:refractor:auto`, cardNumber: "B24-FM", parallelSlug: "Refractor", playerName: "Felix Morrobel" }),
    ];
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales, catalog });
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
    const catalogRow = CATALOG_ROW({ id: `${PREFIX}b24-cs:base:auto`, cardId: `${PREFIX}b24-cs:base:auto`, cardNumber: "B24-CS", parallelSlug: "Base", playerName: "Cam Smith" });
    const first = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [catalogRow] });
    expect(first.led.salesUpserts).toContain("s1");
    const newId = `${PREFIX}b24-cs:base:auto`;
    const movedSale = { ...sale, id: "s1", cardId: newId, hobbyiqCardId: newId };
    const second = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [movedSale], catalog: [catalogRow] });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/RELOCATED\s+0/);
    expect(second.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-cardnumber-suffix -- destination must be a STRICT checklist row, player-matched", () => {
  it("REFUSES (destination-not-on-checklist) when no catalog row exists at the suffix-restored address", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    // No catalog rows seeded at all -- the destination is unattested.
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination-not-on-checklist\s+1/);
    expect(r.out).toMatch(/destination-not-on-checklist/);
  });

  it("REFUSES (destination-not-on-checklist) when the destination row exists but its SOURCE is not a strict checklist authority", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    // A vendor-sourced (non-checklist) row happens to sit at that id -- never
    // strict, and this lane must not mint an identity from a sale.
    const vendorRow = CATALOG_ROW({ source: "cardsight" });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [vendorRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination-not-on-checklist\s+1/);
  });

  it("REFUSES (different-player) when the checklist row at the destination names a DIFFERENT player, even with a correct-looking suffix", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    // Title states #B24-CMO, but this sale's own playerName field says a
    // DIFFERENT person (a mislabeled/mismatched sale) -- the destination
    // checklist row is Colson Montgomery's, so this must refuse rather than
    // move a stranger's sale onto his pool.
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best #B24-CMO Auto White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "A Totally Different Player",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: different-player\s+1/);
    expect(r.out).toMatch(/different-player/);
  });
});

describe("repoint-sales-cardnumber-suffix -- never touches a pinned/flagged/verified/excluded row", () => {
  for (const [field, label] of [
    ["verifiedByUser", "verifiedByUser"],
    ["flaggedWrong", "flaggedWrong"],
    ["excludedFromFmv", "excludedFromFmv"],
    ["identityUnverified", "identityUnverified (parked)"],
  ] as const) {
    it(`REFUSES a sale carrying ${label}`, () => {
      const collapsedId = `${PREFIX}b24:base:auto`;
      const sale: Record<string, unknown> = {
        id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
        title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
        sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
        soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
        [field]: true,
      };
      const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
      expect(r.code).toBe(0);
      expect(r.led.salesUpserts.length).toBe(0);
      expect(r.out).toMatch(/REFUSED: pinned\/flagged\/verified\/excl\.\s+1/);
      expect(r.out).toMatch(/pinned-or-flagged/);
    });
  }
});

describe("repoint-sales-cardnumber-suffix -- possible-twin-at-destination", () => {
  it("REFUSES rather than overwrites when a DIFFERENT document already resides at the destination", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const destId = `${PREFIX}b24-cmo:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    // A DIFFERENT sale (different id, different price/soldAt) already sits
    // at (s1, destId) -- a byte-different resident, never safe to overwrite.
    const differentResident = {
      id: "s1", cardId: destId, hobbyiqCardId: destId,
      title: "totally unrelated listing", sport: SPORT, cardYear: YEAR,
      price: 9999, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2020-01-01T00:00:00.000Z", source: "cardhedge",
    };
    const r = drive(
      { ...DEFAULT_ENV, BACKFILL_APPLY: "true" },
      { sales: [sale, differentResident], catalog: [CATALOG_ROW()] },
    );
    expect(r.code).toBe(0);
    // Neither the source nor the resident is touched.
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
    expect(r.out).toMatch(/possible-twin-at-destination/);
  });

  it("COLLAPSES (never a REFUSED count) when the resident at the destination is a byte-identical twin of the SAME sale", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const destId = `${PREFIX}b24-cmo:base:auto`;
    const baseSale = {
      id: "s1", title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const sale = { ...baseSale, cardId: collapsedId, hobbyiqCardId: collapsedId };
    // The SAME sale (identical content, only the address differs) already
    // sits at the destination -- e.g. a prior partial run relocated it and
    // the source row is a leftover duplicate.
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

describe("repoint-sales-cardnumber-suffix -- refuses out-of-scope shapes", () => {
  it("does NOT touch a sale whose cardNumber segment is not the bare year-coded shape", () => {
    const id = `${PREFIX}50:silver-prizm:no-auto`;
    const sale = {
      id: "s1", cardId: id, hobbyiqCardId: id,
      title: "2024 Bowman's Best #50 Silver Prizm",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
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
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
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
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("does not move a title naming TWO card numbers when they are for the SAME distinct prefixed number (never ambiguous here, but never a guess either)", () => {
    // A title with two DIFFERENT prefixed numbers is refused by
    // preferPrefixedCardNumber itself (returns null, ambiguous) -- covered
    // indirectly here: the sale is simply left alone (no cardNumber wins).
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best #B24-CMO / #B24-CS lot of two cards",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("does not falsely restore on a graded title carrying a hyphenated CERT number, not a card-number suffix", () => {
    // "#B24-CMO" is the card number; "PSA 10 Cert# 12345678-A" must never be
    // read as extending the card number's own suffix. The parser's own
    // DEFAULT_CARD_NUMBER_RE only reads the FIRST #-prefixed token, so this
    // is really pinning that this lane inherits that same discipline rather
    // than re-deriving its own (weaker) card-number reader.
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto #B24-CMO PSA 10 Cert #12345678-A",
      sport: SPORT, cardYear: YEAR, price: 500, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/RELOCATED\s+1/);
  });

  it("does not move on a title stating only a PARTIAL prefix, e.g. bare '#B24' with no suffix at all", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best #B24 Auto White Sox",
      sport: SPORT, cardYear: YEAR, price: 10, isAuto: false, playerName: "Test Player",
      soldAt: "2026-07-02T00:00:00.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    // "b24" -> "b24" is not a suffix restore (same value) -- refused by the
    // predicate before any catalog read is even attempted.
    expect(r.out).toMatch(/REFUSED: not a suffix restore\s+1/);
  });
});

describe("repoint-sales-cardnumber-suffix -- reconcile", () => {
  it("reconciles: candidates == accounted-for", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [CATALOG_ROW()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reconciled: candidates \d+ = accounted-for \d+/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
  });
});
