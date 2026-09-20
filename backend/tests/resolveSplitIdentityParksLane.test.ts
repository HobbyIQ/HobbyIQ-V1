/**
 * resolve-split-identity-parks.cjs -- end-to-end against fake sold_comps /
 * card_catalog.
 *
 * Executed as the COMMITTED FILE via execFileSync, with @azure/cosmos and
 * writeReconciliation replaced through Module._load; every other require
 * (splitIdentityWriteGuard, relocate-sold-comp, catalogAuthority,
 * playerIdentityKey, the title machinery) loads the REAL compiled dist/ or
 * committed .cjs -- same discipline as revertSetSportRepairLane.test.ts.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "resolve-split-identity-parks.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-split-identity-parks-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
  catalogFailIds?: string[];
  /** REVIEW #3: ids whose sale is seeded with a "planning" etag that
   *  ALREADY differs from what a fresh `.item().read()` returns -- i.e.
   *  the document was already mutated (by a concurrent lane, or a prior
   *  partial run) by the time THIS run's page-walk query captured its own
   *  copy. The page-walk query itself hands the lane the STALE ("v1")
   *  snapshot (so `doc._etag` inside handleRow is "v1"); every subsequent
   *  `.item().read()` -- the lane's own re-read-before-write -- returns
   *  the CURRENT, different ("v2") value, and a write conditioned on "v1"
   *  is refused 412. */
  staleAfterFirstReadIds?: string[];
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  const catalogFailIds = opts.catalogFailIds ?? [];
  const staleAfterFirstReadIds = opts.staleAfterFirstReadIds ?? [];

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;

const STALE_IDS = new Set(${JSON.stringify(staleAfterFirstReadIds)});
// Every seeded sale gets an initial _etag ("v1") so the lane's own
// re-read-before-write has something real to compare against. A doc named
// in STALE_IDS is stored with the CURRENT etag already bumped to "v2" --
// simulating a concurrent mutation that landed BEFORE this run even
// started its page-walk -- while the page-walk QUERY (below) hands the
// lane the STALE "v1" snapshot it captured a moment "earlier."
const seeded = ${JSON.stringify(sales)}.map((d) => ({ ...d, _etag: d._etag ?? (STALE_IDS.has(d.id) ? '"v2"' : '"v1"') }));
const state = { sales: new Map(seeded.map((d) => [salesKey(d.id, d.cardId), d])) };
const catalogState = new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d]));
const CATALOG_FAIL_IDS = new Set(${JSON.stringify(catalogFailIds)});
const led = { salesUpserts: [], salesPatches: [], salesDeletes: [], catalogReads: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function preconditionFailed() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }

const salesContainer = {
  item: (id, pk) => ({
    read: async () => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      return { resource: structuredClone(d) };
    },
    patch: async (ops, options) => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      const cond = options && options.accessCondition;
      if (cond && cond.type === "IfMatch" && cond.condition !== d._etag) throw preconditionFailed();
      for (const o of ops) {
        if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value;
        else if (o.op === "remove") delete d[o.path.slice(1)];
      }
      d._etag = '"' + (Math.random().toString(36).slice(2)) + '"';
      led.salesPatches.push({ id, ops, accessCondition: cond ?? null });
      save();
      return { resource: structuredClone(d) };
    },
    delete: async (options) => {
      const d = state.sales.get(salesKey(id, pk));
      if (!d) throw notFound();
      const cond = options && options.accessCondition;
      if (cond && cond.type === "IfMatch" && cond.condition !== d._etag) throw preconditionFailed();
      state.sales.delete(salesKey(id, pk));
      led.salesDeletes.push(id);
      save();
      return {};
    },
  }),
  items: {
    upsert: async (doc) => {
      const withEtag = { ...doc, _etag: '"' + (Math.random().toString(36).slice(2)) + '"' };
      state.sales.set(salesKey(doc.id, doc.cardId), withEtag);
      led.salesUpserts.push(doc.id);
      save();
      return { resource: structuredClone(withEtag) };
    },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("identityUnverified")) {
        resources = all.filter((d) =>
          d.identityUnverified === true
          && typeof d.cardId === "string" && d.cardId.startsWith("hiq:")
          && typeof d.hobbyiqCardId === "string" && d.hobbyiqCardId.startsWith("hiq:")
          && d.cardId !== d.hobbyiqCardId
          && (d.identityUnverifiedReason === "split-identity" || String(d.identityUnverifiedReason ?? "").startsWith("PARK. cardId vertical"))
        // REVIEW #3 fixture hook: the page-walk's OWN query -- the lane's
        // planning read -- hands back the STALE "v1" etag for a doc named
        // in STALE_IDS, even though the CURRENT stored state (and every
        // subsequent .item().read()) already carries "v2". This is what
        // makes doc._etag inside handleRow disagree with a fresh re-read.
        ).map((d) => STALE_IDS.has(d.id) ? { ...d, _etag: '"v1"' } : d);
      } else if (q.includes("c.id = @id AND c.cardId = @pk")) {
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        resources = all.filter((d) => d.id === params["@id"] && d.cardId === params["@pk"]);
      } else if (q.includes("c.cardId = @dest AND c.price = @p AND STARTSWITH(c.soldAt, @day)")) {
        // REVIEW #1: the physical-sale-signature scan at the destination
        // partition -- single-partition (cardId equality), filtered by
        // price + soldAt day, exactly the query resolve-split-identity-
        // parks.cjs's own physicalTwinAtPartition issues.
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        resources = all.filter((d) =>
          d.cardId === params["@dest"]
          && Number(d.price) === Number(params["@p"])
          && String(d.soldAt ?? "").startsWith(params["@day"])
        );
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

const catalogContainer = {
  item: (id, pk) => ({
    read: async () => {
      led.catalogReads.push(id);
      save();
      if (CATALOG_FAIL_IDS.has(id)) {
        throw new Error("simulated persistent catalog read failure (non-retryable in this test)");
      }
      const d = catalogState.get(id);
      if (!d || d.id !== pk) throw notFound();
      return { resource: structuredClone(d) };
    },
  }),
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

// The task's own worked example: Wembanyama 2023 Topps Now #VW3.
const VW3_SALE = {
  id: "tca-ebay::vw3-1",
  cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
  hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
  sport: "baseball",
  identityUnverified: true,
  identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
  identityUnverifiedBy: "relocate-pool-rows-by-list",
  identityUnverifiedReason: 'PARK. cardId vertical "baseball" vs hobbyiqCardId "basketball"; all other slug segments identical',
  identityUnverifiedDetail: "no source attests either side",
  // "Topps Basketball" (not "Topps Now") so inferSetKeyFromTitle's own
  // product parse ("Topps" -> normalizeSetKey "topps") agrees with this
  // fixture's own catalog setKey segment ("topps") -- the title veto is
  // deliberately strict about a genuine product mismatch, so a fixture
  // whose title names a DIFFERENT real product than its own slug would (and
  // should) be vetoed; that scenario gets its own dedicated title-veto test.
  title: "2023 Topps Basketball Victor Wembanyama Rookie #VW3",
  playerName: "Victor Wembanyama",
  price: 12.5,
  soldAt: "2026-06-02T00:00:00.000Z",
  parallel: "base",
  isAuto: false,
  gradeCompany: null,
  gradeValue: null,
  source: "tca-ebay",
};
const VW3_CHECKLIST_BASKETBALL = {
  id: "hiq:basketball:2023:topps:vw3:base:no-auto",
  cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
  source: "checklistcenter",
  playerName: "Victor Wembanyama",
};

describe("resolve-split-identity-parks -- scope refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const scope of ["refractor", "all"]) {
      const r = drive({ SCOPE: scope });
      expect(r.code).toBe(2);
    }
  });

  it("accepts the explicit literal 'all-splits'", () => {
    const r = drive({ SCOPE: "all-splits" }, { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
  });

  it("REFUSES a malformed cell (not sport:year)", () => {
    const r = drive({ SCOPE: "basketball-2023" }); // hyphen, not colon
    expect(r.code).toBe(2);
  });

  it("REFUSES an unrecognised MODE", () => {
    const r = drive({ SCOPE: "basketball:2023", MODE: "checklist-evidence" }, { sales: [VW3_SALE] });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/MODE .* is not recognised/);
  });
});

describe("resolve-split-identity-parks -- the VW3 worked example, both write shapes", () => {
  it("REPORT finds it and reports WOULD RESOLVE-TO-H (relocate), writing zero", () => {
    const r = drive({ SCOPE: "basketball:2023" }, { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("APPLY relocates: new partition at hobbyiqCardId, old cardId partition deleted, park fields cleared, ledger stamped", () => {
    const r = drive({ SCOPE: "basketball:2023", BACKFILL_APPLY: "true" }, { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain(VW3_SALE.id);
    expect(r.led.salesDeletes).toContain(VW3_SALE.id);
  });

  it("scoping by EITHER side's sport:year cell reaches the same row (cardId's own baseball:2023 cell)", () => {
    const r = drive({ SCOPE: "baseball:2023" }, { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WOULD RESOLVE-TO-H \(relocate\)\s+1/);
  });

  it("REPORT's counts equal APPLY's on the same fixture", () => {
    const fixture = { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] };
    const report = drive({ SCOPE: "all-splits" }, fixture);
    const apply = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, fixture);
    expect(report.out.match(/WOULD RESOLVE-TO-H \(relocate\)\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/RESOLVE-TO-H \(relocate\)\s+(\d+)/)?.[1]).toBe("1");
    expect(report.led.catalogReads.sort()).toEqual(apply.led.catalogReads.sort());
  });
});

describe("resolve-split-identity-parks -- RESOLVE-TO-C, patch shape (cardId never moves)", () => {
  it("Barry Sanders shape: cardId (football) has the checklist row, hobbyiqCardId (baseball) has none", () => {
    const sale = {
      id: "tca-ebay::sanders-1",
      cardId: "hiq:football:1989:score:257:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1989:score:257:base:no-auto",
      sport: "baseball",
      identityUnverified: true,
      identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
      identityUnverifiedBy: "relocate-pool-rows-by-list",
      identityUnverifiedReason: "split-identity",
      identityUnverifiedDetail: "no source attests either side",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257",
      playerName: "Barry Sanders",
      price: 40,
      soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base",
      isAuto: false,
      gradeCompany: null,
      gradeValue: null,
      source: "cardhedge",
      cardNumber: "257",
    };
    const catalogFootball = {
      id: "hiq:football:1989:score:257:base:no-auto",
      cardId: "hiq:football:1989:score:257:base:no-auto",
      source: "checklistcenter",
      playerName: "Barry Sanders",
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [catalogFootball] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-C \(patch\)\s+1/);
    expect(r.led.salesUpserts.length).toBe(0); // patch only, never an upsert
    expect(r.led.salesDeletes.length).toBe(0);
    const patchCall = r.led.salesPatches.find((p: any) => p.id === sale.id);
    expect(patchCall).toBeTruthy();
    const setPaths = Object.fromEntries(patchCall.ops.filter((o: any) => o.op === "set").map((o: any) => [o.path, o.value]));
    const removedPaths = patchCall.ops.filter((o: any) => o.op === "remove").map((o: any) => o.path);
    expect(setPaths["/hobbyiqCardId"]).toBe("hiq:football:1989:score:257:base:no-auto");
    expect(setPaths["/cardId"]).toBe("hiq:football:1989:score:257:base:no-auto");
    expect(setPaths["/sport"]).toBe("football");
    expect(setPaths["/splitResolvedTo"]).toBe("cardId");
    expect(setPaths["/splitResolvedFrom"]).toEqual({ cardId: sale.cardId, hobbyiqCardId: sale.hobbyiqCardId });
    expect(typeof setPaths["/splitResolvedAt"]).toBe("string");
    expect(removedPaths.sort()).toEqual([
      "/identityUnverified", "/identityUnverifiedAt", "/identityUnverifiedBy",
      "/identityUnverifiedDetail", "/identityUnverifiedReason",
    ].sort());
  });
});

describe("resolve-split-identity-parks -- LEAVE buckets", () => {
  it("LEAVEs (both-sides-name-the-player) when both checklists have a row for this player", () => {
    const sale = { ...VW3_SALE, id: "both-1" };
    const catalogBaseball = { id: "hiq:baseball:2023:topps:vw-3:base:no-auto", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", source: "checklistcenter", playerName: "Victor Wembanyama" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL, catalogBaseball] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: both-sides-name-the-player\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("LEAVEs (neither-side-names-the-player) when neither checklist has a row", () => {
    const sale = { ...VW3_SALE, id: "neither-1" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: neither-side-names-the-player\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("LEAVEs (neither-side-names-the-player) when a candidate row exists but names a DIFFERENT player -- the cell-collision case", () => {
    const sale = { ...VW3_SALE, id: "collision-1" };
    const differentPlayer = { ...VW3_CHECKLIST_BASKETBALL, playerName: "Someone Else" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [differentPlayer] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: neither-side-names-the-player\s+1/);
  });

  it("LEAVEs (two-sport-athlete) when the checklist evidence backs one side only via absence, and the player is on the gazetteer", () => {
    // title is player-neutral (no name at all) so the REAL title-player
    // veto (review #2) never fires ahead of the two-sport-athlete bound
    // this test means to exercise.
    const sale = { ...VW3_SALE, id: "bo-jackson-1", playerName: "Bo Jackson", title: "2023 Topps Basketball #VW3 rookie card" };
    const catalog = [{ ...VW3_CHECKLIST_BASKETBALL, playerName: "Bo Jackson" }]; // H matches, C is no-row
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: two-sport-athlete\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
  });

  it("RESOLVEs a two-sport athlete when the OTHER side has POSITIVE counter-evidence (different-card)", () => {
    const sale = { ...VW3_SALE, id: "bo-jackson-2", playerName: "Bo Jackson", title: "2023 Topps Basketball #VW3 rookie card" };
    const catalogBaseball = { id: "hiq:baseball:2023:topps:vw-3:base:no-auto", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", source: "checklistcenter", playerName: "Someone Else" };
    const catalog = [{ ...VW3_CHECKLIST_BASKETBALL, playerName: "Bo Jackson" }, catalogBaseball];
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.out).not.toMatch(/LEAVE: two-sport-athlete/);
  });

  it("LEAVEs (title-contradicts-winner) when the title's own third-sport evidence contradicts the winning candidate", () => {
    const sale = {
      ...VW3_SALE, id: "third-sport-1",
      title: "2018 Topps Chrome UEFA Champions League Lightning Strike Gold #LSKM Kylian Mbappe",
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: title-contradicts-winner\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("resolve-split-identity-parks -- REVIEW #5: pinned-or-flagged rows are never resolved", () => {
  it("LEAVEs (pinned-or-flagged) a verifiedByUser row even with unambiguous checklist evidence for H", () => {
    const sale = { ...VW3_SALE, id: "pinned-verified", verifiedByUser: true };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: pinned-or-flagged\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("LEAVEs (pinned-or-flagged) a flaggedWrong row", () => {
    const sale = { ...VW3_SALE, id: "pinned-flagged", flaggedWrong: true };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: pinned-or-flagged\s+1/);
  });

  it("LEAVEs (pinned-or-flagged) an excludedFromFmv row", () => {
    const sale = { ...VW3_SALE, id: "pinned-excluded", excludedFromFmv: true };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: pinned-or-flagged\s+1/);
  });

  it("LEAVEs (pinned-or-flagged) a USER_SEED_SOURCES row (user-verified)", () => {
    const sale = { ...VW3_SALE, id: "pinned-source", source: "user-verified" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEAVE: pinned-or-flagged\s+1/);
  });

  it("does NOT leave an ordinary vendor row with none of these flags -- the ordinary resolve still runs", () => {
    const sale = { ...VW3_SALE, id: "not-pinned", verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.out).not.toMatch(/LEAVE: pinned-or-flagged/);
  });
});

describe("resolve-split-identity-parks -- multi-player row", () => {
  it("RESOLVEs when the sale's player is ANY name listed on the winning checklist row", () => {
    const sale = {
      ...VW3_SALE, id: "multi-1", playerName: "Cal Ripken Jr.",
      cardId: "hiq:baseball:1988:donruss:1:base:no-auto",
      hobbyiqCardId: "hiq:basketball:1988:donruss:1:base:no-auto",
      title: "1988 Donruss #1 no team words at all",
    };
    const multiPlayerRow = { id: "hiq:basketball:1988:donruss:1:base:no-auto", cardId: "hiq:basketball:1988:donruss:1:base:no-auto", source: "checklistcenter", playerName: "Eddie Murray / Cal Ripken Jr." };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [multiPlayerRow] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
  });
});

describe("resolve-split-identity-parks -- collapse / refuse on relocate destination", () => {
  it("COLLAPSES when the SAME sale (by content hash) already resides at the destination", () => {
    const moving = { ...VW3_SALE, id: "same-sale" };
    const resident = {
      id: "same-sale", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      price: 12.5, soldAt: "2026-06-02T00:00:00.000Z", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, resident], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("same-sale");
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES (destination-collision) when a DIFFERENT sale already resides at the destination", () => {
    const moving = { ...VW3_SALE, id: "shared-id", price: 12.5, soldAt: "2026-06-02T00:00:00.000Z" };
    const resident = {
      id: "shared-id", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      price: 999, soldAt: "2026-01-01T00:00:00.000Z", parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, resident], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination-collision\s+1/);
    expect(r.led.salesDeletes.length).toBe(0);
  });
});

describe("resolve-split-identity-parks -- REVIEW #1 (HIGH, delta review 2026-09-20): physical-sale twins need PROVEN shared listing identity before a collapse deletes anything", () => {
  // A CardHedge dual-id twin of ONE physical sale: same price, same sold
  // day, same title -- but a DIFFERENT id (a tca-ebay id vs a cardhedge
  // id), and here already resident at H under its OWN id. `residentAt`
  // (same-id check) never sees this, because it only ever probes
  // `(doc.id, destCardId)` -- a DIFFERENT id at that exact address.
  //
  // contentHashOf (cardId, parallel, isAuto, grade, price-cents, soldAt-day)
  // matching is NOT proof of "same listing" -- two DISTINCT real sales (many
  // $1.99 raw copies, templated CardHedge titles) match it too. Collapse
  // (delete) is allowed ONLY when both docs additionally share a non-empty
  // external listing id (sourceExternalId, or the same shape parsed from
  // `id`). Cross-vendor pairs with no shared listing id must PARK, named
  // `possible-twin-at-destination`, never collapse.
  const TWIN_PRICE = 12.5;
  const TWIN_SOLD_AT = "2026-06-02T02:59:03.000Z";
  const TWIN_TITLE = "Pikachu V - Holo Promo SWSH061";

  it("RELOCATE: two DISTINCT sales (same card/price/day, different ids & sources, NO shared listing id) are NEITHER deleted -- the mover is left PARKED, named possible-twin-at-destination", () => {
    const moving = {
      ...VW3_SALE, id: "cardhedge::twin-moving", source: "cardhedge", sourceExternalId: "ch-daily::555001",
      price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const resident = {
      id: "tca-ebay::twin-resident-999", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      source: "tca-ebay", sourceExternalId: "168568127039",
      price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, resident], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
    expect(r.out).not.toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    // NEITHER row is touched -- absent beats wrong, no delete without proof.
    expect(r.led.salesDeletes).not.toContain("cardhedge::twin-moving");
    expect(r.led.salesDeletes).not.toContain("tca-ebay::twin-resident-999");
    expect(r.led.salesUpserts.length).toBe(0);
    // The banner sample names both docs' id + source + title.
    expect(r.out).toMatch(/cardhedge::twin-moving.*source=cardhedge.*Pikachu V/);
    expect(r.out).toMatch(/twin-resident-999.*source=tca-ebay.*Pikachu V/);
  });

  it("RELOCATE: the SAME listing id under two id shapes (sourceExternalId shared) COLLAPSES -- exactly one document survives at H, the moving copy is deleted", () => {
    const moving = {
      ...VW3_SALE, id: "cardhedge::twin-moving-proven", source: "cardhedge", sourceExternalId: "168568127039",
      price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const residentTwin = {
      id: "tca-ebay::168568127039", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      source: "tca-ebay",
      price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, residentTwin], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    // The MOVING copy is deleted; the pre-existing twin (different id) is
    // never touched -- exactly one survivor remains at H.
    expect(r.led.salesDeletes).toContain("cardhedge::twin-moving-proven");
    expect(r.led.salesDeletes).not.toContain("tca-ebay::168568127039");
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("RELOCATE: a coincidental price+day match that FAILS the full content-hash compare is NOT collapsed -- falls through to an ordinary relocate", () => {
    const moving = { ...VW3_SALE, id: "cardhedge::not-a-twin", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null };
    // Same price + same day, but a DIFFERENT parallel -- contentHashOf
    // disagrees, so this is a coincidence, not a twin.
    const coincidence = {
      id: "tca-ebay::coincidence-1", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE,
      parallel: "refractor", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, coincidence], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain("cardhedge::not-a-twin");
    expect(r.led.salesDeletes).toContain("cardhedge::not-a-twin"); // the OLD (C) copy, deleted by the successful relocate
    expect(r.led.salesDeletes).not.toContain("tca-ebay::coincidence-1"); // the coincidence is untouched
  });

  it("PATCH (RESOLVE-TO-C): two distinct sales sharing this row's OWN (unmoving) partition, NO shared listing id, are left PARKED named possible-twin-at-destination -- never patched, never deleted", () => {
    const sale = {
      id: "cardhedge::patch-twin-moving",
      cardId: "hiq:football:1989:score:257:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1989:score:257:base:no-auto",
      sport: "baseball",
      identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
      identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity",
      identityUnverifiedDetail: "no source attests either side",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257",
      playerName: "Barry Sanders", price: 40, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", sourceExternalId: "ch-daily::777123", cardNumber: "257",
    };
    // A DIFFERENT id, a DIFFERENT vendor listing, but the SAME price+day+
    // contentHash, already resident at cardId's OWN (unmoving) partition --
    // no shared listing id proves this is the same physical sale rather
    // than two distinct $40 raw copies sold the same day.
    const resident = {
      id: "tca-ebay::patch-twin-resident", cardId: "hiq:football:1989:score:257:base:no-auto",
      sport: "football", hobbyiqCardId: "hiq:football:1989:score:257:base:no-auto",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257",
      playerName: "Barry Sanders", price: 40, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
      source: "tca-ebay", sourceExternalId: "271998887766",
    };
    const catalogFootball = { id: "hiq:football:1989:score:257:base:no-auto", cardId: "hiq:football:1989:score:257:base:no-auto", source: "checklistcenter", playerName: "Barry Sanders" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale, resident], catalog: [catalogFootball] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
    expect(r.out).not.toMatch(/RESOLVE-TO-C \(patch\)\s+1/);
    expect(r.led.salesPatches.some((p: any) => p.id === "cardhedge::patch-twin-moving")).toBe(false);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("PATCH (RESOLVE-TO-C): a PROVEN twin (shared listing id) ALREADY resident at this row's OWN (unmoving) partition is left PARKED, named duplicate-of-resolved-resident -- never patched (a patch never deletes either way)", () => {
    const sale = {
      id: "cardhedge::patch-proven-twin-moving",
      cardId: "hiq:football:1989:score:258:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1989:score:258:base:no-auto",
      sport: "baseball",
      identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
      identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity",
      identityUnverifiedDetail: "no source attests either side",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #258",
      playerName: "Barry Sanders", price: 41, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", sourceExternalId: "310998887799", cardNumber: "258",
    };
    // Same listing id (an eBay item id CardHedge also recorded), a
    // DIFFERENT id shape, already resident at cardId's OWN partition.
    const resident = {
      id: "tca-ebay::310998887799", cardId: "hiq:football:1989:score:258:base:no-auto",
      sport: "football", hobbyiqCardId: "hiq:football:1989:score:258:base:no-auto",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #258",
      playerName: "Barry Sanders", price: 41, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
      source: "tca-ebay",
    };
    const catalogFootball = { id: "hiq:football:1989:score:258:base:no-auto", cardId: "hiq:football:1989:score:258:base:no-auto", source: "checklistcenter", playerName: "Barry Sanders" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale, resident], catalog: [catalogFootball] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: duplicate-of-resolved-resident\s+1/);
    expect(r.out).not.toMatch(/RESOLVE-TO-C \(patch\)\s+1/);
    expect(r.led.salesPatches.some((p: any) => p.id === "cardhedge::patch-proven-twin-moving")).toBe(false);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("does NOT collapse two DIFFERENT sales that merely share the day (different price)", () => {
    const moving = { ...VW3_SALE, id: "cardhedge::genuine-1", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, title: TWIN_TITLE, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null };
    const differentSale = {
      id: "tca-ebay::genuine-2", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      price: 999.99, soldAt: TWIN_SOLD_AT, title: "an unrelated different sale",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null,
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [moving, differentSale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesDeletes).not.toContain("tca-ebay::genuine-2");
  });

  it("CONCURRENCY: two movers racing the SAME destination with NO shared listing id yield no duplicate write and no delete without listing proof", () => {
    const twinA = { id: "cardhedge::conc-a", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto", sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x", title: TWIN_TITLE, playerName: "Victor Wembanyama", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", sourceExternalId: "ch-daily::900111" };
    const twinB = { id: "tca-ebay::conc-b-dup", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto", sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x", title: TWIN_TITLE, playerName: "Victor Wembanyama", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "tca-ebay", sourceExternalId: "900222333444" };
    const first = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true", CONCURRENCY: "16" }, { sales: [twinA, twinB], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(first.code).toBe(0);
    // Neither twin proves a shared listing id against the other -- one
    // relocates to H (there is no resident yet when it runs first in the
    // lock queue), the other finds it there under a different id at the
    // SAME price+day and, lacking listing proof, PARKS rather than
    // collapsing or double-writing.
    expect(first.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(first.out).toMatch(/REFUSED: possible-twin-at-destination\s+1/);
    expect(first.out).not.toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(first.out).toMatch(/RECONCILE BALANCES/);
    // Exactly one survivor at the destination -- no duplicate write.
    const survivingIds = new Set(first.led.salesUpserts as string[]);
    expect(survivingIds.size).toBe(1);
    // Exactly one delete: the successful relocate's OWN old-partition
    // cleanup (its mover, now living at H under its own id, still upserted
    // above). The PARKED twin -- whichever one lost the lock race and found
    // the other already at the destination with no shared listing id -- is
    // NEVER deleted without listing proof.
    const deletedIds = new Set(first.led.salesDeletes as string[]);
    expect(deletedIds.size).toBe(1);
    const relocatedId = [...survivingIds][0];
    expect(deletedIds).toEqual(new Set([relocatedId]));
  });

  it("CONCURRENCY: two twins PROVING a shared listing id still resolve to exactly one survivor at H (collapse legitimately fires under the race)", () => {
    const twinA = { id: "cardhedge::conc-proven-a", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto", sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x", title: TWIN_TITLE, playerName: "Victor Wembanyama", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", sourceExternalId: "555666777888" };
    const twinB = { id: "tca-ebay::555666777888", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto", sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x", title: TWIN_TITLE, playerName: "Victor Wembanyama", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT, parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "tca-ebay" };
    const first = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true", CONCURRENCY: "16" }, { sales: [twinA, twinB], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(first.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(first.out).toMatch(/RECONCILE BALANCES/);
    const survivingIds = new Set(first.led.salesUpserts as string[]);
    expect(survivingIds.size).toBe(1);
    const deletedIds = new Set(first.led.salesDeletes as string[]);
    expect(deletedIds.size).toBe(2); // one old-partition delete (the relocate) + one collapse delete
  });

  it("CONCURRENCY (MEDIUM follow-up): two movers to DIFFERENT destinations at the SAME price+day run concurrently -- both resolve independently, neither waits on the other's lock", () => {
    // Same price + same day as TWIN_* (the shared signature every other
    // test in this block uses), but for TWO UNRELATED cards resolving to
    // TWO DIFFERENT destinations. Before the destination was added to the
    // lock key, every same-price/same-day row nationwide serialised through
    // ONE queue regardless of destination; this proves that is fixed.
    const cardA = {
      id: "cardhedge::unrelated-a", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list",
      identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x",
      title: TWIN_TITLE, playerName: "Victor Wembanyama", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge",
    };
    const barrySandersCatalog = { id: "hiq:football:1989:score:257:base:no-auto", cardId: "hiq:football:1989:score:257:base:no-auto", source: "checklistcenter", playerName: "Barry Sanders" };
    const cardB = {
      id: "tca-ebay::unrelated-b", cardId: "hiq:baseball:1989:score:257:base:no-auto", hobbyiqCardId: "hiq:football:1989:score:257:base:no-auto",
      sport: "baseball", identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z", identityUnverifiedBy: "relocate-pool-rows-by-list",
      identityUnverifiedReason: "split-identity", identityUnverifiedDetail: "x",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257", playerName: "Barry Sanders", price: TWIN_PRICE, soldAt: TWIN_SOLD_AT,
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "tca-ebay", cardNumber: "257",
    };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true", CONCURRENCY: "16" }, { sales: [cardA, cardB], catalog: [VW3_CHECKLIST_BASKETBALL, barrySandersCatalog] });
    expect(r.code).toBe(0);
    // Both resolve to their OWN distinct destination -- neither is parked
    // or refused by the other's presence in the same price+day bucket.
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+2/);
    expect(r.out).not.toMatch(/possible-twin-at-destination/);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+0/);
    expect(r.out).toMatch(/RECONCILE BALANCES/);
    expect(r.led.salesUpserts.sort()).toEqual(["cardhedge::unrelated-a", "tca-ebay::unrelated-b"].sort());
  });
});

describe("resolve-split-identity-parks -- guard refusal", () => {
  it("REFUSES (guard-parked) when the winning candidate id is malformed enough for the write-door guard to re-park it", () => {
    const sale = {
      ...VW3_SALE, id: "malformed-1",
      cardId: "hiq:baseball:2023:topps::base:no-auto", // empty cardNumber segment
      hobbyiqCardId: "hiq:basketball:2023:topps::base:no-auto",
    };
    const malformedChecklistRow = { id: "hiq:basketball:2023:topps::base:no-auto", cardId: "hiq:basketball:2023:topps::base:no-auto", source: "checklistcenter", playerName: "Victor Wembanyama" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [malformedChecklistRow] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: guard-parked\s+1/);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("resolve-split-identity-parks -- idempotent re-run", () => {
  it("a resolved row (park fields cleared, cardId===hobbyiqCardId) drops out of the next run's selection", () => {
    const first = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [VW3_SALE], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(first.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);

    const resolvedRow = {
      ...VW3_SALE,
      cardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto",
      sport: "basketball",
      splitResolvedAt: "2026-09-19T00:00:00.000Z",
      splitResolvedTo: "hobbyiqCardId",
      splitResolvedFrom: { cardId: VW3_SALE.cardId, hobbyiqCardId: VW3_SALE.hobbyiqCardId },
      splitResolvedBy: "resolve-split-identity-parks",
    };
    delete (resolvedRow as any).identityUnverified;
    delete (resolvedRow as any).identityUnverifiedAt;
    delete (resolvedRow as any).identityUnverifiedBy;
    delete (resolvedRow as any).identityUnverifiedReason;
    delete (resolvedRow as any).identityUnverifiedDetail;

    const second = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [resolvedRow] });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/scanned \(parked split-identity, not yet resolved\)\s+0/);
    expect(second.led.salesUpserts.length).toBe(0);
    expect(second.led.salesPatches.length).toBe(0);
    expect(second.led.salesDeletes.length).toBe(0);
  });
});

describe("resolve-split-identity-parks -- persistent catalog read failure isolates ONE row", () => {
  it("does not kill the run; RECONCILE still balances; the failed row gets no verdict", () => {
    const restoreRow = { ...VW3_SALE, id: "batch-restore", cardId: "hiq:baseball:2024:topps:1:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:1:base:no-auto" };
    const leaveRow = { ...VW3_SALE, id: "batch-leave", cardId: "hiq:baseball:2024:topps:2:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:2:base:no-auto" };
    const failRow = { ...VW3_SALE, id: "batch-fail", cardId: "hiq:baseball:2024:topps:3:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:3:base:no-auto" };
    const catalog = [
      { id: "hiq:basketball:2024:topps:1:base:no-auto", cardId: "hiq:basketball:2024:topps:1:base:no-auto", source: "checklistcenter", playerName: "Victor Wembanyama" },
      // batch-leave: no catalog rows at all on either side.
    ];
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, {
      sales: [restoreRow, leaveRow, failRow],
      catalog,
      catalogFailIds: ["hiq:basketball:2024:topps:3:base:no-auto"],
    });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.out).toMatch(/LEAVE: neither-side-names-the-player\s+1/);
    expect(r.out).toMatch(/failed\s+1/);
    expect(r.out).toMatch(/FAILED catalog read batch-fail/);
    expect(r.out).toMatch(/RECONCILE BALANCES/);
    expect(r.out).not.toMatch(/A row is unaccounted for/);
    expect(r.led.salesPatches.some((p: any) => p.id === "batch-fail")).toBe(false);
    expect(r.led.salesUpserts).not.toContain("batch-fail");
  });

  it("REPORT/APPLY parity holds for the failed count too", () => {
    const failRow = { ...VW3_SALE, id: "fail-report", cardId: "hiq:baseball:2024:topps:5:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:5:base:no-auto" };
    const fixture = { sales: [failRow], catalog: [], catalogFailIds: ["hiq:basketball:2024:topps:5:base:no-auto"] };
    const report = drive({ SCOPE: "all-splits" }, fixture);
    const apply = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, fixture);
    expect(report.code).toBe(4);
    expect(apply.code).toBe(4);
    expect(report.out).toMatch(/failed\s+1/);
    expect(apply.out).toMatch(/failed\s+1/);
    expect(report.out).toMatch(/RECONCILE BALANCES/);
    expect(apply.out).toMatch(/RECONCILE BALANCES/);
  });

  it("REVIEW #4: REPORT==APPLY parity under a MIXED batch with a catalog-read failure -- identical catalogReads AND identical failed counts in both modes", () => {
    // Three rows on one page: a clean resolve, a clean leave, and one whose
    // candidateBefore (H) id is wired to throw persistently. The catalog
    // reads that run BEFORE the failure (for the other two rows) must be
    // byte-for-byte the same set in REPORT and APPLY -- the only difference
    // between the two modes is whether a write lands, never what is read.
    const resolveRow = { ...VW3_SALE, id: "parity-resolve", cardId: "hiq:baseball:2024:topps:10:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:10:base:no-auto" };
    const leaveRow = { ...VW3_SALE, id: "parity-leave", cardId: "hiq:baseball:2024:topps:11:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:11:base:no-auto" };
    const failRow = { ...VW3_SALE, id: "parity-fail", cardId: "hiq:baseball:2024:topps:12:base:no-auto", hobbyiqCardId: "hiq:basketball:2024:topps:12:base:no-auto" };
    const catalog = [
      { id: "hiq:basketball:2024:topps:10:base:no-auto", cardId: "hiq:basketball:2024:topps:10:base:no-auto", source: "checklistcenter", playerName: "Victor Wembanyama" },
      // parity-leave: no catalog rows at all on either side.
    ];
    const fixture = { sales: [resolveRow, leaveRow, failRow], catalog, catalogFailIds: ["hiq:basketball:2024:topps:12:base:no-auto"] };
    const report = drive({ SCOPE: "all-splits" }, fixture);
    const apply = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(4);
    expect(apply.code).toBe(4);
    expect(report.out).toMatch(/failed\s+1/);
    expect(apply.out).toMatch(/failed\s+1/);
    expect(report.led.catalogReads.sort()).toEqual(apply.led.catalogReads.sort());
    expect(report.out.match(/WOULD RESOLVE-TO-H \(relocate\)\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/RESOLVE-TO-H \(relocate\)\s+(\d+)/)?.[1]).toBe("1");
    expect(report.out).toMatch(/LEAVE: neither-side-names-the-player\s+1/);
    expect(apply.out).toMatch(/LEAVE: neither-side-names-the-player\s+1/);
    expect(report.out).toMatch(/RECONCILE BALANCES/);
    expect(apply.out).toMatch(/RECONCILE BALANCES/);
  });
});

describe("resolve-split-identity-parks -- IfMatch 412 refuses the delete without losing the sale", () => {
  it("relocateSoldComp's own conditional-delete primitive: a drop carrying a stale ifMatchEtag is refused stale-since-plan, never counted as a duplicate", () => {
    // Exercises relocate-sold-comp.cjs's own shared primitive directly
    // (its own unit-level contract), separate from the end-to-end
    // REVIEW #3 tests below that drive the actual resolve-split-identity-
    // parks.cjs lane -- which DOES now wire `ifMatchEtag` on every relocate
    // drop (review #3, 2026-09-19).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { relocateSoldComp } = require("../scripts/lib/relocate-sold-comp.cjs");
    const calls: Array<{ id: string; options: unknown }> = [];
    const pool = {
      item: (id: string, cardId: string) => ({
        read: async () => {
          if (id === "moving-id" && cardId === "hiq:basketball:2023:topps:vw3:base:no-auto") {
            return { resource: { id, cardId, hobbyiqCardId: cardId, sport: "basketball" } };
          }
          throw Object.assign(new Error("not found"), { code: 404 });
        },
        delete: async (options: unknown) => {
          calls.push({ id, options });
          throw Object.assign(new Error("etag mismatch"), { code: 412 });
        },
      }),
      items: { upsert: async (doc: unknown) => ({ resource: doc }) },
    };
    const keep = { id: "moving-id", cardId: "hiq:basketball:2023:topps:vw3:base:no-auto", hobbyiqCardId: "hiq:basketball:2023:topps:vw3:base:no-auto", sport: "basketball" };
    return relocateSoldComp(pool, {
      keep,
      drop: [{ id: "moving-id", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto", ifMatchEtag: "\"stale-etag\"" }],
      retry: (fn: () => unknown) => fn(),
      verifyFields: ["cardId", "hobbyiqCardId", "sport"],
      guard: () => ({ verdict: "ok" }),
    }).then((res: any) => {
      expect(res.ok).toBe(false);
      expect(res.staleSincePlan.length).toBe(1);
      expect(res.staleSincePlan[0].error).toMatch(/412/);
      expect(res.duplicatesLeft.length).toBe(0);
      expect(calls.length).toBe(1);
    });
  });
});

describe("resolve-split-identity-parks -- REVIEW #3 (MEDIUM): end-to-end conditional writes against the lane itself", () => {
  it("PATCH shape: a document mutated between this run's planning read and its own write is REFUSED stale-since-plan, never patched", () => {
    // WRONG_FLIP-style RESOLVE-TO-C fixture (Barry Sanders), reused from
    // the earlier PATCH-shape test. `staleAfterFirstReadIds` bumps the
    // stored _etag on the SECOND `.item().read()` call for this id -- the
    // lane's own review-#3 re-read-before-write IS that second read (the
    // first `.item().read()` in this whole run for this id), so by the
    // time the lane compares its planning etag against the fresh one, they
    // already disagree.
    const sale = {
      id: "cardhedge::stale-patch",
      cardId: "hiq:football:1989:score:257:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1989:score:257:base:no-auto",
      sport: "baseball",
      identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
      identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity",
      identityUnverifiedDetail: "no source attests either side",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257",
      playerName: "Barry Sanders", price: 40, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", cardNumber: "257",
    };
    const catalogFootball = { id: "hiq:football:1989:score:257:base:no-auto", cardId: "hiq:football:1989:score:257:base:no-auto", source: "checklistcenter", playerName: "Barry Sanders" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [catalogFootball], staleAfterFirstReadIds: ["cardhedge::stale-patch"] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: stale-since-plan\s+1/);
    expect(r.out).not.toMatch(/RESOLVE-TO-C \(patch\)\s+1/);
    expect(r.led.salesPatches.some((p: any) => p.id === "cardhedge::stale-patch")).toBe(false);
    expect(r.out).toMatch(/RECONCILE BALANCES/);
  });

  it("PATCH shape: an UNCHANGED document (etag still matches the plan) writes normally -- the conditional check is not a blanket refusal", () => {
    const sale = {
      id: "cardhedge::fresh-patch",
      cardId: "hiq:football:1989:score:258:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1989:score:258:base:no-auto",
      sport: "baseball",
      identityUnverified: true, identityUnverifiedAt: "2026-09-07T00:00:00.000Z",
      identityUnverifiedBy: "relocate-pool-rows-by-list", identityUnverifiedReason: "split-identity",
      identityUnverifiedDetail: "no source attests either side",
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #258",
      playerName: "Barry Sanders", price: 41, soldAt: "2026-06-02T00:00:00.000Z",
      parallel: "base", isAuto: false, gradeCompany: null, gradeValue: null, source: "cardhedge", cardNumber: "258",
    };
    const catalogFootball = { id: "hiq:football:1989:score:258:base:no-auto", cardId: "hiq:football:1989:score:258:base:no-auto", source: "checklistcenter", playerName: "Barry Sanders" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [catalogFootball] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-C \(patch\)\s+1/);
    expect(r.led.salesPatches.some((p: any) => p.id === "cardhedge::fresh-patch")).toBe(true);
  });

  it("RELOCATE shape: a document mutated between this run's planning read and its own write is REFUSED stale-since-plan, never relocated", () => {
    const sale = { ...VW3_SALE, id: "cardhedge::stale-relocate" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL], staleAfterFirstReadIds: ["cardhedge::stale-relocate"] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: stale-since-plan\s+1/);
    expect(r.out).not.toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts).not.toContain("cardhedge::stale-relocate");
    expect(r.led.salesDeletes).not.toContain("cardhedge::stale-relocate");
    expect(r.out).toMatch(/RECONCILE BALANCES/);
  });

  it("RELOCATE shape: an UNCHANGED document relocates normally", () => {
    const sale = { ...VW3_SALE, id: "cardhedge::fresh-relocate" };
    const r = drive({ SCOPE: "all-splits", BACKFILL_APPLY: "true" }, { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESOLVE-TO-H \(relocate\)\s+1/);
    expect(r.led.salesUpserts).toContain("cardhedge::fresh-relocate");
    expect(r.led.salesDeletes).toContain("cardhedge::fresh-relocate");
  });

  it("REPORT never re-reads for the conditional check (no write to protect) -- REPORT/APPLY still agree on the eventual verdict once unstaled", () => {
    const sale = { ...VW3_SALE, id: "cardhedge::report-no-stale-check" };
    const fixture = { sales: [sale], catalog: [VW3_CHECKLIST_BASKETBALL] };
    const report = drive({ SCOPE: "all-splits" }, fixture);
    expect(report.code).toBe(0);
    expect(report.out).toMatch(/WOULD RESOLVE-TO-H \(relocate\)\s+1/);
  });
});
