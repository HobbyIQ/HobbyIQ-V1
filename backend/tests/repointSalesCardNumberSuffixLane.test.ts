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
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-cardnumber-suffix.cjs");
const LANE_SRC = fs.readFileSync(LANE, "utf8");

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
  // writeReconciliation is left to load the REAL compiled dist/ (not
  // stubbed) -- the counters-mismatch defect (run 35625031826, exit 4 "OVER
  // by 237") only shows up when the lane's reportWrites() call runs for
  // real, so these end-to-end tests must exercise the actual reconciliation,
  // not a no-op.
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

// ── COORDINATOR FIX: this lane must repair ONLY the cardNumber segment. The
// original PR re-derived parallel/isAuto from a fresh title re-parse via
// `parsed.parallel ?? sale.parallel ?? "Base"` -- a title reading "Gold Auto
// /50" (color word stated WITHOUT "Refractor") re-parses to the truthy
// string parallel:"Base" (parseListingIdentity's own fallback, flagged by
// `parallelIsUnconfirmed:true`), so `??` never falls through to the sale's
// OWN stored "Gold Refractor" -- and if a plain Base row for that number
// happens to exist on the checklist (unlike the 237 sampled cases, where it
// did not), the sale would be APPLIED onto the WRONG card: a graded/numbered
// parallel silently downgraded to Base. Fixed with the SAME doctrine
// scripts/lib/rematch-derive-identity.cjs already uses (storedIdentity /
// CF-THE-CHECKLIST-SPELLS-ITS-OWN-RUNGS): a rung the parser NAMES with
// confidence still wins, but `parallelIsUnconfirmed` means the sale's own
// stored parallel is better evidence than a manufactured Base. isAuto never
// downgrades either direction (true beats false regardless of source) --
// covers the bare "(AU)"/"AU" abbreviation this parser does not tokenize as
// an auto marker.
describe("repoint-sales-cardnumber-suffix -- resolveParallelAndAuto / isParallelOrAutoDowngrade (unit)", () => {
  const lane = require(LANE);
  const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

  it("real shape: '#B25-CCA Gold Auto /50' (color word stated WITHOUT 'Refractor') keeps the sale's own 'Gold Refractor', never evicts to Base", () => {
    const parsed = parseListingIdentity("2025 Bowman's Best of 2025 Cole Carrigg #B25-CCA Gold Auto /50 Colorado");
    expect(parsed.parallel).toBe("Base"); // the parser's own fallback -- NOT a confident read
    expect(parsed.parallelIsUnconfirmed).toBe(true);
    const sale = { parallel: "Gold Refractor", isAuto: true };
    const resolved = lane.resolveParallelAndAuto(parsed, sale);
    expect(resolved.parallel).toBe("Gold Refractor");
    expect(resolved.isAuto).toBe(true);
    expect(lane.isParallelOrAutoDowngrade(resolved, sale)).toBe(false);
  });

  it("real shape: '#B25-JTH (AU)' (bare abbreviation, not tokenized as an auto marker) keeps the sale's own isAuto:true", () => {
    const parsed = parseListingIdentity("2025 Bowman's Best - Jared Thomas Colorado Rockies #B25-JTH (AU)");
    expect(parsed.isAuto).toBe(false); // the parser does not read "(AU)" as an auto marker
    const sale = { parallel: "Base", isAuto: true };
    const resolved = lane.resolveParallelAndAuto(parsed, sale);
    expect(resolved.isAuto).toBe(true);
    expect(lane.isParallelOrAutoDowngrade(resolved, sale)).toBe(false);
  });

  it("a title-NAMED rung still wins over the sale's own stored value -- this lane still realizes a genuine improvement", () => {
    const resolved = lane.resolveParallelAndAuto({ parallel: "Gold Refractor", parallelIsUnconfirmed: false, isAuto: true }, { parallel: "Base", isAuto: false });
    expect(resolved.parallel).toBe("Gold Refractor");
    expect(resolved.isAuto).toBe(true);
    expect(lane.isParallelOrAutoDowngrade(resolved, { parallel: "Base", isAuto: false })).toBe(false);
  });

  it("isParallelOrAutoDowngrade: true when a NAMED sale parallel would be evicted to Base", () => {
    expect(lane.isParallelOrAutoDowngrade({ parallel: "Base", isAuto: true }, { parallel: "Gold Refractor", isAuto: true })).toBe(true);
  });

  it("isParallelOrAutoDowngrade: true when sale.isAuto:true would be evicted to false", () => {
    expect(lane.isParallelOrAutoDowngrade({ parallel: "Gold Refractor", isAuto: false }, { parallel: "Gold Refractor", isAuto: true })).toBe(true);
  });

  it("isParallelOrAutoDowngrade: false when the candidate is the SAME or MORE specific than the sale (never fires on an improvement)", () => {
    expect(lane.isParallelOrAutoDowngrade({ parallel: "Base", isAuto: false }, { parallel: "Base", isAuto: false })).toBe(false);
    expect(lane.isParallelOrAutoDowngrade({ parallel: "Gold Refractor", isAuto: true }, { parallel: "Base", isAuto: false })).toBe(false);
    expect(lane.isParallelOrAutoDowngrade({ parallel: "Gold Refractor", isAuto: true }, { parallel: "Gold Refractor", isAuto: true })).toBe(false);
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

describe("repoint-sales-cardnumber-suffix -- end-to-end: never downgrades the sale's own parallel/isAuto (coordinator fix)", () => {
  it("real shape: '#B24-CMO Gold Auto /50' with sale.parallel already 'Gold Refractor' relocates onto the GOLD-REFRACTOR checklist row, never the Base row -- even though a Base row ALSO exists at the same number (the exact shape that would have silently mis-filed a sale under the pre-fix code)", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      // Deliberately a "color word without 'Refractor'" title -- this is the
      // shape that re-parses to parallel:"Base" (parallelIsUnconfirmed:true).
      title: "2024 Bowman's Best Colson Montgomery #B24-CMO Gold Auto /50 White Sox",
      sport: SPORT, cardYear: YEAR, price: 300, isAuto: true, parallel: "Gold Refractor",
      playerName: "Colson Montgomery", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const baseRow = CATALOG_ROW({ parallelSlug: "Base" }); // exists at b24-cmo:base:auto -- the WRONG destination if downgraded
    const goldRow = CATALOG_ROW({
      id: `${PREFIX}b24-cmo:gold-refractor:auto:num-50`, cardId: `${PREFIX}b24-cmo:gold-refractor:auto:num-50`,
      parallelSlug: "Gold Refractor",
    });
    const r = drive({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [baseRow, goldRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.out).toMatch(/RELOCATED\s+1/);
    expect(r.out).not.toMatch(/REFUSED: parallel-or-auto-downgrade\s+1/);
  });

  // `isParallelOrAutoDowngrade` is a BELT-AND-SUSPENDERS invariant check:
  // `resolveParallelAndAuto` is built so its own output can never be weaker
  // than the sale's stored value, so the guard should be structurally
  // unreachable through the normal call site -- exactly the same doctrine
  // as this file's own L397-399 cardNumber re-check ("belt and suspenders
  // against a parallel/isAuto re-derivation quietly changing the target").
  // To prove the GUARD itself (not just resolveParallelAndAuto's honesty) is
  // what stands between a regression and a bad write, these two tests run a
  // TEMP COPY of the committed lane with `resolveParallelAndAuto`'s body
  // patched back to the EXACT pre-fix expression
  // (`parsed.parallel ?? sale.parallel ?? "Base"`,
  // `Boolean(parsed.isAuto ?? sale.isAuto)`) -- simulating a future
  // regression that reintroduces the original bug -- while leaving the
  // `isParallelOrAutoDowngrade` guard call itself untouched, and assert the
  // guard refuses rather than writes onto the wrong (Base / no-auto) row.
  // Written as a SIBLING of the committed lane (not into `tmp`) so its
  // __dirname-relative requires (lib/runner-shard-scope.cjs etc.) resolve
  // exactly as they do for the real file.
  const REGRESSED_LANE = path.join(backend, "scripts", `.repoint-sales-cardnumber-suffix.REGRESSED.${process.pid}.cjs`);
  afterAll(() => { try { fs.rmSync(REGRESSED_LANE, { force: true }); } catch { /* best effort */ } });
  function regressedResolveSrc() {
    const patched = LANE_SRC.replace(
      /function resolveParallelAndAuto\(parsed, sale\) \{[\s\S]*?\n\}/,
      `function resolveParallelAndAuto(parsed, sale) {
  return { parallel: parsed.parallel ?? sale.parallel ?? "Base", isAuto: Boolean(parsed.isAuto ?? sale.isAuto) };
}`,
    );
    expect(patched, "resolveParallelAndAuto patch point not found").not.toBe(LANE_SRC);
    return patched;
  }
  function driveRegressed(env, opts) {
    fs.writeFileSync(REGRESSED_LANE, regressedResolveSrc());
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
    } catch (e) {
      code = e.status; out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
    return { code, out, led };
  }

  it("REGRESSION SIMULATION: with resolveParallelAndAuto patched back to the pre-fix expression, the downgrade GUARD (not resolveParallelAndAuto) is what refuses the Gold-Refractor-to-Base eviction rather than writing it", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery #B24-CMO Gold Auto /50 White Sox",
      sport: SPORT, cardYear: YEAR, price: 300, isAuto: true, parallel: "Gold Refractor",
      playerName: "Colson Montgomery", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    // ONLY the Base row exists -- under the regressed resolveParallelAndAuto
    // this is exactly the shape that would have silently relocated a Gold
    // Refractor /50 sale onto a plain Base row (the PR #2402 finding).
    const baseRow = CATALOG_ROW({ parallelSlug: "Base" });
    const r = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [baseRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: parallel-or-auto-downgrade\s+1/);
  });

  it("REGRESSION SIMULATION: with resolveParallelAndAuto patched back to the pre-fix expression, the guard refuses the isAuto:true-to-false eviction on a bare '(AU)' title", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery #B24-CMO (AU) White Sox",
      sport: SPORT, cardYear: YEAR, price: 300, isAuto: true, parallel: "Base",
      playerName: "Colson Montgomery", soldAt: "2026-07-06T18:23:27.000Z", source: "cardsight",
    };
    const noAutoRow = CATALOG_ROW({
      id: `${PREFIX}b24-cmo:base:no-auto`, cardId: `${PREFIX}b24-cmo:base:no-auto`,
      isAuto: false,
    });
    const r = driveRegressed({ ...DEFAULT_ENV, BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [noAutoRow] });
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/REFUSED: parallel-or-auto-downgrade\s+1/);
  });

  // MUTATION-CHECKED BY HAND (see PR body): removing the
  // `isParallelOrAutoDowngrade` guard call from `processSale` (leaving
  // `resolveParallelAndAuto`'s fix in place) is caught by exactly these two
  // REGRESSION SIMULATION tests -- both fail (the sale relocates onto the
  // wrong Base / no-auto row instead of refusing) while the other 41 tests
  // stay green, confirming these two are what pin the guard call itself.
  // Separately, reverting `resolveParallelAndAuto` to the pre-fix expression
  // (leaving the guard call in place) is caught by the unit tests above plus
  // the FIRST end-to-end test in this block ("relocates onto the
  // GOLD-REFRACTOR ... never the Base row").
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

// ── FOLLOW-UP: APPLY run 35810708478 (baseball:2025 bowmans-best) ended
// "failed 4" / exit 4 -- reconcile balanced (4,629 = 4,379 written + 246
// refused + 4 failed) but the log printed NO per-sale line for the 4
// failures: every REFUSED class prints examples via its own `refusals[...]`
// list, `failed` never had an equivalent. Fixed: a `failures` array (mirrors
// repoint-sales-parallel-suffix.cjs's own `failures`/FAILURES banner),
// printed in full (never truncated to 20, since `failed` is expected to be
// rare), one line per failure naming the sale id, from-id, to-id, and the
// underlying error code/message -- plus a PLAN_OUT record
// (action:"failed") carrying the same `error` field.
describe("repoint-sales-cardnumber-suffix -- FAILED logging (follow-up: run 35810708478 printed no per-sale failure line)", () => {
  it("a catalog-read failure prints a FAILED line naming the sale id, from-id, to-id, and the error, and is recorded in PLAN_OUT with action:failed", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const { requirePath, ledger } = shim({ sales: [sale], catalog: [CATALOG_ROW()] });
    const shimSrc = fs.readFileSync(requirePath, "utf8");
    const throwingShimSrc = shimSrc.replace(
      "const catalogContainer = {\n  item: (id, pk) => ({\n    read: async () => {\n      const d = state.catalog.get(id);\n      if (!d) throw notFound();\n      return { resource: structuredClone(d) };\n    },\n  }),\n};",
      'const catalogContainer = {\n  item: (id, pk) => ({\n    read: async () => {\n      throw Object.assign(new Error("simulated Cosmos 503"), { code: 503 });\n    },\n  }),\n};',
    );
    expect(throwingShimSrc, "catalogContainer.item().read() patch point not found").not.toBe(shimSrc);
    fs.writeFileSync(requirePath, throwingShimSrc);

    const planDir = fs.mkdtempSync(path.join(tmp, "plan-"));
    let code = 0; let out = "";
    try {
      out = execFileSync(process.execPath, [LANE], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          ...DEFAULT_ENV, BACKFILL_APPLY: "true", PLAN_OUT: planDir,
        },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (e: any) {
      code = e.status as number;
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    expect(out).toMatch(/FAILURES \(1\), every one listed:/);
    expect(out).toMatch(/FAILED catalog-read s1@hiq:baseball:2024:bowmans-best:b24:base:auto -> hiq:baseball:2024:bowmans-best:b24-cmo:base:auto: \[503\] simulated Cosmos 503/);
    expect(out).toMatch(/nothing written, sale untouched at its old address/);

    const planFile = path.join(planDir, "plan-slot-0.ndjson");
    const planRows = fs.readFileSync(planFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failedRow = planRows.find((r: any) => r.action === "failed");
    expect(failedRow).toBeTruthy();
    expect(failedRow.reason).toBe("catalog-read");
    expect(failedRow.id).toBe("s1");
    expect(failedRow.cardId).toBe(collapsedId);
    expect(failedRow.target).toBe(`${PREFIX}b24-cmo:base:auto`);
    expect(failedRow.error).toMatch(/\[503\] simulated Cosmos 503/);
  });

  it("a relocate verify-mismatch (duplicatesLeft) prints a DUPLICATE LEFT line -- the sale is resident at BOTH the old and new address, not a no-op failure", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const { requirePath, ledger } = shim({ sales: [sale], catalog: [CATALOG_ROW()] });
    // Force relocateSoldComp's own read-back (readBackKeptRow) to NEVER show
    // the write: the point-read at the KEEPER's address always 404s (as if
    // a lagging replica never catches up within the retry budget) and the
    // query fallback returns nothing either. The upsert itself still
    // succeeds -- so this reproduces relocate-sold-comp.cjs's own documented
    // `stage:"verify"` mismatch: keeper written, old row's delete never
    // attempted, sale now resident at BOTH addresses (`duplicatesLeft`).
    const shimSrc = fs.readFileSync(requirePath, "utf8");
    const patchedSrc = shimSrc
      .replace(
        `const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },`,
        `const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      // Always 404 for the NEW (keeper) address specifically -- simulates a
      // read-back that never shows the write within the retry budget.
      if (id === "s1" && pk === "hiq:baseball:2024:bowmans-best:b24-cmo:base:auto") throw notFound();
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },`,
      )
      .replace(
        'throw new Error("fake sold_comps: unsupported query " + q);',
        `if (q.includes("c.id = @id AND c.cardId = @pk")) return { fetchAll: async () => ({ resources: [] }) };
      throw new Error("fake sold_comps: unsupported query " + q);`,
      );
    expect(patchedSrc, "salesContainer read/query patch points not found").not.toBe(shimSrc);
    fs.writeFileSync(requirePath, patchedSrc);

    let code = 0; let out = "";
    try {
      out = execFileSync(process.execPath, [LANE], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          ...DEFAULT_ENV, BACKFILL_APPLY: "true",
        },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (e: any) {
      code = e.status as number;
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
    // The upsert DID happen -- this is the load-bearing proof that a
    // duplicate is left in the pool, not that nothing was written.
    expect(led.salesUpserts).toContain("s1");
    expect(led.salesDeletes.length).toBe(0);
    expect(out).toMatch(/FAILURES \(1\), every one listed:/);
    expect(out).toMatch(/FAILED relocate s1@hiq:baseball:2024:bowmans-best:b24:base:auto -> hiq:baseball:2024:bowmans-best:b24-cmo:base:auto/);
    expect(out).toMatch(/DUPLICATE LEFT -- keeper upserted\+verified at hiq:baseball:2024:bowmans-best:b24-cmo:base:auto, old row at hiq:baseball:2024:bowmans-best:b24:base:auto was NOT deleted; sale now resident at BOTH addresses/);
  });
});

// ── INCIDENT: REPORT runs 35624948034 / 35625031826 / 35625113831 (baseball
// 2023/2024/2025 bowmans-best) each ended `finishLane: exiting code 4` on
// "COUNTERS DO NOT ADD UP". The 2025 run's own numbers: candidates 4,618;
// WOULD RELOCATE 4,381; refused not-a-suffix-restore 1 (pre-candidate, never
// counted in `candidates`), pinned/flagged 53 (also pre-candidate), refused
// destination-not-on-checklist 237, different-player 0, twin 0, stale 0;
// failed 0; not reached 0. Its OWN "reconciled: candidates 4,618 =
// accounted-for 4,618" line two lines above balanced -- but the shipped
// reportWrites() call passed `intended: planned` (only the 4,381 candidates
// that reached the write stage, i.e. relocated+collapsed+stale+failed here)
// while `skipped: s.candidates - s.relocated - s.failed` (237) folded in
// `refusedDestinationNotOnChecklist`, a class that never became `planned` in
// the first place -- a denominator `intended` never owned. `written(4,381) +
// skipped(237) = 4,618`, all measured against `intended=4,381`, over by
// exactly 237. Same class of bug as PR #2400
// (resolve-disagreeing-sale-twins.cjs): `intended` must be the FULL
// population every outcome is drawn from -- fixed to `s.candidates`, with
// every refusal class now landing in `refused` and only budget-truncation
// (`notReached`) landing in `skipped`, guarded by `if (APPLY)` matching
// repoint-sales-parallel-suffix.cjs's own convention.
describe("reportWrites: intended must be the SAME population skipped/refused/written/failed are drawn from (REPORT runs 35624948034/35625031826/35625113831, exit 4 OVER by 237)", () => {
  it("the shipped call passes s.candidates as intended, not the narrower `planned` (write-stage-reached) subset", () => {
    const call = /reportWrites\(\{\s*job:\s*"repoint-sales-cardnumber-suffix",([\s\S]*?)\}\);/.exec(LANE_SRC);
    expect(call, "the reportWrites call was not found").toBeTruthy();
    expect(call![1]).toMatch(/intended:\s*s\.candidates/);
    expect(call![1]).not.toMatch(/intended:\s*planned/);
  });

  it("every refusal class lands in `refused`; `skipped` covers only budget-truncated rows (notReached), never a refusal class", () => {
    const call = /reportWrites\(\{\s*job:\s*"repoint-sales-cardnumber-suffix",([\s\S]*?)\}\);/.exec(LANE_SRC);
    expect(call![1]).toMatch(/refused:\s*refusedTotal/);
    expect(call![1]).toMatch(/skipped:\s*s\.notReached/);
    expect(LANE_SRC).toMatch(/const refusedTotal = s\.refusedDestinationNotOnChecklist \+ s\.refusedDifferentPlayer\s*\n\s*\+ s\.refusedPossibleTwinAtDestination \+ s\.refusedParallelOrAutoDowngrade \+ s\.refusedEtagChanged;/);
  });

  it("the reportWrites() call itself is guarded by `if (APPLY)`, matching repoint-sales-parallel-suffix.cjs's own convention -- a REPORT run's correctness signal is its own 'reconciled: candidates = accounted-for' line, not an exit-4 gate meant for confirmed writes", () => {
    expect(LANE_SRC).toMatch(/if \(APPLY\) \{\s*\n\s*reportWrites\(\{\s*\n\s*job: "repoint-sales-cardnumber-suffix",/);
  });

  it("behavioral: reproduces the 2025 run's OWN numbers (candidates 4,618 / would-relocate 4,381 / refused-not-suffix-restore 1 / pinned-or-flagged 53 / destination-not-on-checklist 237) -- the OLD call shape over-accounts by exactly 237, the FIXED shape balances to zero", () => {
    const run2025 = {
      candidates: 4618, relocated: 4381, collapsedOntoResident: 0,
      refusedDestinationNotOnChecklist: 237, refusedDifferentPlayer: 0,
      refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 0,
      failed: 0, notReached: 0,
    };
    // `planned` under the old code == every candidate that reached the
    // write stage: relocated + collapsedOntoResident + refusedEtagChanged +
    // failed (destination-not-on-checklist and different-player return
    // BEFORE planned++, so they were never part of it).
    const planned = run2025.relocated + run2025.collapsedOntoResident + run2025.refusedEtagChanged + run2025.failed;
    expect(planned).toBe(4381);

    // OLD (buggy) shape, byte-for-byte the pre-fix call.
    const oldResult = reconcileWrites({
      job: "t", intended: planned,
      written: run2025.relocated,
      skipped: run2025.candidates - run2025.relocated - run2025.failed,
      failed: run2025.failed,
    });
    expect(oldResult.ok).toBe(false);
    expect(oldResult.overAccounted).toBe(237); // the EXACT "OVER by 237" the run printed

    // FIXED shape.
    const refusedTotal = run2025.refusedDestinationNotOnChecklist + run2025.refusedDifferentPlayer
      + run2025.refusedPossibleTwinAtDestination + run2025.refusedEtagChanged;
    const fixedResult = reconcileWrites({
      job: "t", intended: run2025.candidates,
      written: run2025.relocated + run2025.collapsedOntoResident,
      refused: refusedTotal,
      skipped: run2025.notReached,
      failed: run2025.failed,
    });
    expect(fixedResult.ok).toBe(true);
    expect(fixedResult.overAccounted).toBe(0);
    expect(fixedResult.unaccounted).toBe(0);
  });

  it("behavioral: also reproduces the 2023 and 2024 runs' shapes cleanly under the fix (any candidates/refusals/failed/notReached split reconciles to zero over-accounted)", () => {
    // Representative shapes for the other two failing runs (35624948034,
    // 35624948034 baseball/2023 and baseball/2024) -- exact per-run counts
    // are not required to pin this, only that the FIXED call's arithmetic
    // is invariant to which bucket absorbed the difference.
    for (const run of [
      { candidates: 1200, relocated: 1100, collapsedOntoResident: 5, refusedDestinationNotOnChecklist: 80, refusedDifferentPlayer: 3, refusedPossibleTwinAtDestination: 2, refusedEtagChanged: 0, failed: 0, notReached: 10 },
      { candidates: 300, relocated: 250, collapsedOntoResident: 0, refusedDestinationNotOnChecklist: 40, refusedDifferentPlayer: 0, refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 5, failed: 5, notReached: 0 },
    ]) {
      const refusedTotal = run.refusedDestinationNotOnChecklist + run.refusedDifferentPlayer
        + run.refusedPossibleTwinAtDestination + run.refusedEtagChanged;
      const result = reconcileWrites({
        job: "t", intended: run.candidates,
        written: run.relocated + run.collapsedOntoResident,
        refused: refusedTotal,
        skipped: run.notReached,
        failed: run.failed,
      });
      expect(result.ok).toBe(true);
      expect(result.overAccounted).toBe(0);
    }
  });

  it("APPLY: a thrown write lands in `failed`, and the fixed reportWrites() call still balances", () => {
    const collapsedId = `${PREFIX}b24:base:auto`;
    const sale = {
      id: "s1", cardId: collapsedId, hobbyiqCardId: collapsedId,
      title: "2024 Bowman's Best Colson Montgomery Auto Autograph #B24-CMO White Sox",
      sport: SPORT, cardYear: YEAR, price: 30, isAuto: true, playerName: "Colson Montgomery",
      soldAt: "2026-06-28T20:48:59.000Z", source: "cardsight",
    };
    const { requirePath, ledger } = shim({ sales: [sale], catalog: [CATALOG_ROW()] });
    // Wrap the shim so relocateSoldComp's own items.upsert() throws --
    // relocateSoldComp upserts the KEEPER before it ever attempts the DROP's
    // delete (scripts/lib/relocate-sold-comp.cjs L357-361: a failed upsert
    // returns `{ ok: false, stage: "upsert" }` with NOTHING written), so this
    // is the write-failure shape that actually lands zero upserts. The
    // lane's own catch around relocateSoldComp (L390-409) then counts this
    // as `s.failed`, and the fixed reportWrites() call must still balance
    // (candidates 1 = written 0 + refused 0 + skipped 0 + failed 1) rather
    // than exit on a counters mismatch.
    const shimSrc = fs.readFileSync(requirePath, "utf8");
    const throwingShimSrc = shimSrc.replace(
      "upsert: async (doc) => {\n      const stored = structuredClone(doc);",
      "upsert: async (doc) => {\n      throw new Error(\"simulated write failure\");\n      const stored = structuredClone(doc);",
    );
    expect(throwingShimSrc, "items.upsert() patch point not found in shim").not.toBe(shimSrc);
    fs.writeFileSync(requirePath, throwingShimSrc);

    let code = 0; let out = "";
    try {
      out = execFileSync(process.execPath, [LANE], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          ...DEFAULT_ENV, BACKFILL_APPLY: "true",
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
    expect(led.salesUpserts.length).toBe(0);
    expect(out).toMatch(/failed\s+1/);
    // The thrown relocate lands in `s.failed`, which the fixed call passes
    // straight through as `failed` -- candidates(1) == written(0) +
    // refused(0) + skipped(0) + failed(1), so the run must NOT exit on a
    // counters mismatch (any non-zero exit here is caused by the deliberate
    // relocate throw itself being surfaced as ::error::, never COUNTERS DO
    // NOT ADD UP).
    expect(out).not.toMatch(/COUNTERS DO NOT ADD UP/);
    expect(code).toBe(4); // s.failed > 0 -> the lane's own explicit failed-count gate (L… `if (s.failed) ... exitCode = 4`), NOT a reconcile mismatch
  });
});
