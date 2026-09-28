/**
 * dedupe-sold-comp-copies-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for stray
 * DUPLICATE COPIES of a sale (Drew, 2026-09-27 ~23:56Z: "Build lane +
 * census; REPORT first"). sold_comps ids (`${source}::${externalId}`) are
 * unique only WITHIN a partition (pk /cardId); today's audits found the
 * same sale stored as 2+ physical documents under different cardIds. This
 * lane DELETES a stray copy only when it is PROVABLY the same sale
 * ("collision is not a duplicate") -- gated per row, at the delete call,
 * never from a batch snapshot.
 *
 * Modeled on repointSalesByList.test.ts's own shape: the lane is
 * require()'d directly (its dist/ requires live inside main(), so the
 * module loads with no built tree) and its pure gate function
 * (classifyEntry) is pinned against malformed and well-formed list entries.
 * An in-memory Cosmos fake -- mirroring that file's own shim -- drives the
 * per-entry gates end-to-end via spawnSync, so the REAL compiled dist/
 * (catalogAuthority, writeReconciliation) is exercised, not a stub of it.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as os from "node:os";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "dedupe-sold-comp-copies-by-list.cjs");
const backend = join(__dirname, "..");
const runner = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");

const LIST_DIR = join(__dirname, "..", "data", "sold-comp-dedupes");
const LISTS = [
  "2026-09-27-twins-lane-strays.json",
  "2026-09-27-fb2025-isauto-strays.json",
  "2026-09-27-bb2026-isauto-strays.json",
];

type Entry = { saleId: string; keepCardId: string; deleteCardId: string; reason?: string };
type ListDoc = { forLane: string; entries: Entry[]; finding?: string; census?: unknown };

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree -- its dist/ requires live
// inside main(), exactly as every sibling list lane does it.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean; why?: string; saleId?: string; keepCardId?: string;
    deleteCardId?: string; reason?: string;
  };
  IDENTITY_FIELDS: string[];
};

// ── the runner contract ──────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    // Line-ending agnostic: the checkout is CRLF on Windows and LF in CI.
    expect(readFileSync(runner, "utf8")).toMatch(/^ {10}- dedupe-sold-comp-copies-by-list\r?$/m);
  });

  it("rides the existing SCOPE passthrough -- no new workflow_dispatch input", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
    // GitHub caps workflow_dispatch at 25 inputs and 24 are used. A new one
    // here would be the input that broke the cap.
    expect(yml).not.toContain("dedupe_list:");
    expect(yml).not.toContain("stray_list:");
  });

  it("and BACKFILL_APPLY is what arms it, not APPLY", () => {
    expect(readFileSync(runner, "utf8")).toMatch(/BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply/);
    expect(readFileSync(lane, "utf8")).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
  });

  it("has a relaunch step modeled on repoint-sales-by-list's own block", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toContain("inputs.script == 'dedupe-sold-comp-copies-by-list'");
    expect(yml).toContain("uses: ./.github/actions/relaunch-on-marker");
    expect(yml).toMatch(
      /gh workflow run backfill-runner\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f script=dedupe-sold-comp-copies-by-list -f apply="\$\{\{ inputs\.apply \}\}" -f scope="\$\{\{ inputs\.scope \}\}"/,
    );
  });

  it("the shared relaunch action exists and is not itself edited by this change", () => {
    const action = join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(existsSync(action)).toBe(true);
  });

  it("the workflow stays under GitHub's 512 KB dispatch limit", () => {
    const bytes = Buffer.byteLength(readFileSync(runner, "utf8"), "utf8");
    expect(bytes).toBeLessThan(512 * 1024);
  });
});

// ── the scope refusal ────────────────────────────────────────────────────

describe("the scope must name a committed list", () => {
  it("REFUSES an empty scope -- no default list", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("if (!RAW_SCOPE) {");
    expect(src).toContain("has no default list");
  });

  it("REFUSES another lane's vocabulary", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('if (!RAW_SCOPE.endsWith(".json"))');
  });

  it("and a missing or empty list file is fatal, never a silent no-op", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("FATAL: scope list not found");
    expect(src).toContain("names no entries — nothing is in scope");
  });
});

// ── list loader validation ───────────────────────────────────────────────

describe("classifyEntry validates the list schema", () => {
  it("accepts a well-formed entry", () => {
    const r = L.classifyEntry({
      saleId: "tca-ebay::318499154523",
      keepCardId: "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50",
      deleteCardId: "hiq:baseball:2024:bowman-chrome:player-victor-hurtado:gold-refractor:auto:num-50",
      reason: "twins-lane audit",
    });
    expect(r.ok).toBe(true);
    expect(r.keepCardId).toContain("cpa-vh");
    expect(r.deleteCardId).toContain("player-victor-hurtado");
  });

  it("refuses a missing saleId", () => {
    const r = L.classifyEntry({ keepCardId: "hiq:a:1:b:1:base:no-auto", deleteCardId: "hiq:a:1:b:2:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no saleId");
  });

  it("refuses a missing keepCardId", () => {
    const r = L.classifyEntry({ saleId: "src::1", deleteCardId: "hiq:a:1:b:2:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no keepCardId");
  });

  it("refuses keepCardId that is not a hiq slug", () => {
    const r = L.classifyEntry({ saleId: "src::1", keepCardId: "cardhedge::123", deleteCardId: "hiq:a:1:b:2:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses a missing deleteCardId", () => {
    const r = L.classifyEntry({ saleId: "src::1", keepCardId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no deleteCardId");
  });

  it("refuses deleteCardId == keepCardId", () => {
    const id = "hiq:a:1:b:1:base:no-auto";
    const r = L.classifyEntry({ saleId: "src::1", keepCardId: id, deleteCardId: id, reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("deleteCardId equals keepCardId");
  });

  it("refuses an entry with no reason -- an unexplained delete is not reviewable", () => {
    const r = L.classifyEntry({ saleId: "src::1", keepCardId: "hiq:a:1:b:1:base:no-auto", deleteCardId: "hiq:a:1:b:2:base:no-auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no reason");
  });
});

// ── the content-identity field list ──────────────────────────────────────

describe("the content-identity comparison excludes address fields", () => {
  it("never compares cardId, hobbyiqCardId or parallel as identity", () => {
    expect(L.IDENTITY_FIELDS).not.toContain("cardId");
    expect(L.IDENTITY_FIELDS).not.toContain("hobbyiqCardId");
    expect(L.IDENTITY_FIELDS).not.toContain("parallel");
  });

  it("compares the sale-content fields relocate-sold-comp.cjs's own contentHashOf treats as identity", () => {
    for (const f of ["source", "price", "soldAt", "gradeCompany", "gradeValue"]) {
      expect(L.IDENTITY_FIELDS).toContain(f);
    }
  });

  it("reuses the shared varianceOf helper, never a bespoke compare", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"))');
    expect(src).toContain("varianceOf([keeper, stray], IDENTITY_FIELDS)");
  });

  it("requires pkOf/None-pk awareness for the catalog read, and the shared cosmos backoff", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "catalog-none-pk.cjs"))');
    expect(src).toContain('require(path.join(__dirname, "lib", "cosmos-backoff.cjs"))');
    expect(src).toContain("withBackoff(fn,");
  });

  it("never relocates -- this lane only deletes the stray, never moves the keeper", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).not.toContain("relocateSoldComp(");
    expect(src).not.toContain("items.upsert(");
  });
});

// ── REPORT writes nothing ─────────────────────────────────────────────────

describe("REPORT computes the same gates APPLY would, and writes nothing", () => {
  it("the delete call is the ONLY branch point between REPORT and APPLY", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("if (!APPLY) {");
    expect(src).toContain("WOULD DELETE the stray");
    // Every gate above the `if (!APPLY)` branch runs identically regardless
    // of mode -- pinned by counting the delete call site occurs exactly
    // once, inside the APPLY-only branch.
    expect((src.match(/pool\.item\(saleId, deleteCardId\)\.delete\(\)/g) ?? []).length).toBe(1);
  });
});

// ── reconcile mismatch fails the run ──────────────────────────────────────

describe("the reconcile identity fails the run on mismatch", () => {
  it("sets process.exitCode = 4 and prints RECONCILE MISMATCH on a mismatch", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("RECONCILE MISMATCH");
    expect(src).toContain("process.exitCode = 4;");
  });

  it("the budget marker is a literal string, not assembled from variables", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("stopped at the ${CLOCK.RUN_MINUTES}-minute budget");
  });
});

// ── the committed lists load through the real loader and are well-formed ─

describe("the three committed lists", () => {
  for (const file of LISTS) {
    describe(file, () => {
      const p = join(LIST_DIR, file);

      it("exists and loads as JSON", () => {
        expect(existsSync(p)).toBe(true);
        expect(() => readList(p)).not.toThrow();
      });

      it("is shaped the way this lane requires", () => {
        const doc = readList(p);
        expect(doc.forLane).toBe("dedupe-sold-comp-copies-by-list");
        expect(Array.isArray(doc.entries)).toBe(true);
        expect(doc.entries.length).toBeGreaterThan(0);
        for (const e of doc.entries) {
          const c = L.classifyEntry(e);
          expect(c.ok, `entry failed classifyEntry: ${JSON.stringify(e)} -- ${c.why}`).toBe(true);
        }
      });

      it("carries a header census with generatedAt and finding", () => {
        const doc = readList(p);
        expect(doc.finding).toBeTruthy();
        expect((doc as unknown as { generatedAt?: string }).generatedAt).toBeTruthy();
        expect(doc.census).toBeTruthy();
      });

      it("has no entry naming itself (keepCardId !== deleteCardId)", () => {
        const doc = readList(p);
        for (const e of doc.entries) expect(e.keepCardId).not.toBe(e.deleteCardId);
      });

      it("has no duplicate (saleId, deleteCardId) pair -- each stray named once", () => {
        const doc = readList(p);
        const seen = new Set<string>();
        for (const e of doc.entries) {
          const k = `${e.saleId}::${e.deleteCardId}`;
          expect(seen.has(k), `duplicate entry for ${k}`).toBe(false);
          seen.add(k);
        }
      });

      it("byte-scans clean (no 0x08/0x00)", () => {
        const raw = readFileSync(p);
        expect(raw.includes(0x08)).toBe(false);
        expect(raw.includes(0x00)).toBe(false);
      });
    });
  }

  it("681 entries total across the three lists (165 + 282 + 234)", () => {
    const total = LISTS.reduce((sum, file) => sum + readList(join(LIST_DIR, file)).entries.length, 0);
    expect(total).toBe(681);
  });
});

// ── end-to-end against an in-memory Cosmos fake ──────────────────────────

function assertNoUncaughtError(r: { code: number; out: string }) {
  expect(r.out).not.toMatch(/FATAL:/);
  expect(r.out).not.toMatch(/ReferenceError/);
  expect(r.out).not.toMatch(/TypeError/);
}

const tmp = mkdtempSync(join(os.tmpdir(), "dedupe-sold-comp-copies-by-list-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SALE_ID = "tca-ebay::318499154523";
const KEEP_ID = "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50";
const DELETE_ID = "hiq:baseball:2024:bowman-chrome:player-victor-hurtado:gold-refractor:auto:num-50";

const KEEPER_CATALOG_ROW = { id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: "Victor Hurtado" };
const KEEPER_SALE = { id: SALE_ID, cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, source: "tca-ebay", title: "Victor Hurtado Gold Refractor Auto", price: 25, soldAt: "2026-01-05" };

function writeList(entries: Entry[], tag: string): string {
  const p = join(tmp, `list-${tag}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ forLane: "dedupe-sold-comp-copies-by-list", entries }));
  return p;
}

function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
  /** When true, the cross-partition verify query (GATE e, run AFTER the
   *  delete) throws instead of answering -- simulating a network error on
   *  the read-back, never "found nothing". The delete itself still
   *  succeeds; only the verify that follows it fails. */
  throwOnVerifyQuery?: boolean;
} = {}): { requirePath: string; ledger: string } {
  const ledger = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  const throwOnVerifyQuery = opts.throwOnVerifyQuery ?? false;

  writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const THROW_ON_VERIFY_QUERY = ${JSON.stringify(throwOnVerifyQuery)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
};
const led = { deletes: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify({ ...led, finalSales: [...state.sales.values()] }));
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
      led.deletes.push(id);
      save();
      return {};
    },
  }),
  items: {
    query: (spec) => {
      const id = spec.parameters.find((p) => p.name === "@id").value;
      const resources = [...state.sales.values()]
        .filter((d) => d.id === id)
        .map((d) => ({ id: d.id, cardId: d.cardId }));
      return {
        fetchAll: async () => {
          // This lane calls items.query ONLY for the post-delete
          // cross-partition verify (GATE e) -- so a throw here is always
          // that call, never some other query this shim would need to
          // distinguish.
          if (THROW_ON_VERIFY_QUERY) throw new Error("simulated network error on cross-partition verify");
          return { resources: resources.map((r) => structuredClone(r)) };
        },
      };
    },
  },
};

const stub = {
  CosmosClient: class {
    dispose() {}
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
  return realLoad.apply(this, arguments);
};
`);
  return { requirePath: p, ledger };
}

function drive(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const { requirePath, ledger } = shim(opts);
  const res = spawnSync(process.execPath, [lane], {
    cwd: backend,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
      NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const code = res.status ?? -1;
  const out = String(res.stdout ?? "") + String(res.stderr ?? "");
  const led = JSON.parse(readFileSync(ledger, "utf8"));
  return { code, out, led };
}

describe("end-to-end: every gate, driven against the real compiled dist/", () => {
  it("REPORT computes the delete and writes nothing; APPLY deletes exactly the stray", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "twins-lane audit" }], "clean-delete");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(reportRun);
    expect(reportRun.code).toBe(0);
    expect(reportRun.out).toMatch(/WOULD DELETE\s+1/);
    expect(reportRun.led.deletes.length).toBe(0);
    expect(reportRun.led.finalSales.length).toBe(2);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/DELETED\s+1/);
    expect(applyRun.led.deletes).toEqual([SALE_ID]);
    expect(applyRun.led.finalSales.length).toBe(1);
    expect(applyRun.led.finalSales[0].cardId).toBe(KEEP_ID);
  });

  it("REFUSES (no-keeper) when the keeper is absent, in both modes, and writes nothing", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "no-keeper");
    const catalog = [KEEPER_CATALOG_ROW];
    // Only the stray exists -- no keeper document at all.
    const sales = [{ ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(no-keeper\)/);
    expect(r.out).toMatch(/REFUSED: no-keeper\s+1/);
    expect(r.led.deletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.out).toMatch(/REFUSED: no-keeper\s+1/);
    expect(applyRun.led.deletes.length).toBe(0);
  });

  it("REFUSES (keeper-not-settled) when the keeper's own cardId disagrees with keepCardId", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "keeper-not-settled");
    const catalog = [KEEPER_CATALOG_ROW];
    // The keeper document exists at KEEP_ID's partition, but its OWN
    // hobbyiqCardId still points somewhere else -- mid-move, not settled.
    const sales = [
      { ...KEEPER_SALE, cardId: KEEP_ID, hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50-STALE" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(keeper-not-settled\)/);
    expect(r.out).toMatch(/REFUSED: keeper-not-settled\s+1/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("REFUSES (no-catalog-row) when keepCardId has no card_catalog row", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "no-catalog-row");
    const catalog: Array<Record<string, unknown>> = []; // no catalog row at all
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(no-catalog-row\)/);
    expect(r.out).toMatch(/REFUSED: no-catalog-row\s+1/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("REFUSES (not-checklist-grade) when keepCardId's catalog row is vendor/derived, never checklist", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "not-checklist-grade");
    const catalog = [{ ...KEEPER_CATALOG_ROW, source: "cardhedge" }]; // vendor, not checklist
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(not-checklist-grade\)/);
    expect(r.out).toMatch(/REFUSED: not-checklist-grade\s+1/);
    expect(r.led.deletes.length).toBe(0);
  });

  // ── CF-COLLISION-IS-NOT-A-DUPLICATE at write time (PR #2490 review,
  // https://github.com/HobbyIQ/HobbyIQ-V1/pull/2490#issuecomment-5871669672).
  // A stale list committed before the generator's own fix (or a hand-built
  // one) must not be able to delete through this lane either -- the SAME
  // keeper-name check runs again, fresh, at the delete call.

  it("REFUSES (keeper-name-disagrees) when the keeper's own sale title names a different player than its catalog row -- NEVER deleted, in either mode", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "keeper-name-disagrees");
    const catalog = [KEEPER_CATALOG_ROW]; // playerName: "Victor Hurtado"
    // The keeper's own stored sale is a completely different player's title
    // -- a stale/hand-built list entry the generator's own fix would never
    // have minted, but this lane must refuse it too, never trusting the
    // list's say-so.
    const wrongPlayerSale = { ...KEEPER_SALE, title: "2025 Panini Rookies & Stars Cam Skattebo Crusade Silver #21 Giants Rookie RC" };
    const sales = [
      wrongPlayerSale,
      { ...wrongPlayerSale, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(reportRun);
    expect(reportRun.out).toMatch(/REFUSED \(keeper-name-disagrees\)/);
    expect(reportRun.out).toMatch(/REFUSED: keeper-name-disagrees\s+1/);
    expect(reportRun.led.deletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.out).toMatch(/REFUSED \(keeper-name-disagrees\)/);
    expect(applyRun.out).toMatch(/REFUSED: keeper-name-disagrees\s+1/);
    // The count is IDENTICAL in both modes, and APPLY still wrote nothing --
    // a keeper-name-disagrees refusal never reaches the delete call.
    expect(applyRun.led.deletes.length).toBe(0);
    expect(applyRun.led.finalSales.length).toBe(2);
  });

  it("still DELETES cleanly when the keeper's own title genuinely names its catalog row's player (control)", () => {
    // Proves the new gate is not a blanket refusal: the ordinary clean-delete
    // shape (already covered above) still works when the keeper's title
    // agrees with its own row -- restated here as an explicit control next to
    // the disagreement test above.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "keeper-name-agrees-control");
    const catalog = [KEEPER_CATALOG_ROW]; // playerName: "Victor Hurtado"
    const sales = [
      KEEPER_SALE, // title: "Victor Hurtado Gold Refractor Auto" -- agrees
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).not.toMatch(/REFUSED \(keeper-name-disagrees\)/);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("SKIPS (already-gone) when the stray is absent -- never a failure, never retried as a delete", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "already-gone");
    const catalog = [KEEPER_CATALOG_ROW];
    // Only the keeper exists -- the stray is already gone.
    const sales = [KEEPER_SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/SKIPPED \(already-gone\)/);
    expect(r.out).toMatch(/SKIPPED: already-gone\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.deletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.out).toMatch(/SKIPPED: already-gone\s+1/);
    expect(applyRun.led.deletes.length).toBe(0);
  });

  it("REFUSES (content-differs) when price disagrees between keeper and stray -- NEVER deleted, in either mode", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "content-differs");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, price: 999 }, // different price -- NOT the same sale
    ];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(reportRun);
    expect(reportRun.out).toMatch(/REFUSED \(content-differs\)/);
    expect(reportRun.out).toMatch(/REFUSED: content-differs\s+1/);
    expect(reportRun.led.deletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.out).toMatch(/REFUSED: content-differs\s+1/);
    // The count is IDENTICAL in both modes, and APPLY still wrote nothing --
    // a content-differs refusal never reaches the delete call.
    expect(applyRun.led.deletes.length).toBe(0);
    expect(applyRun.led.finalSales.length).toBe(2);
  });

  it("REFUSES (content-differs) when soldAt disagrees -- title/price alone matching is not enough", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "content-differs-date");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, soldAt: "2020-01-01" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(content-differs\)/);
    expect(r.led.deletes.length).toBe(0);
  });

  // ── 2026-09-28 dedupe census: title/soldAt NORMALIZATION ────────────────
  //
  // content-differs.csv found 154/155 refused "duplicate" pairs differing
  // ONLY in a doubled leading product year, and one differing only in
  // soldAt string SHAPE (+00:00 vs .000Z, same instant). varianceOf now
  // normalizes `title` and `soldAt`/`date` before comparing -- these tests
  // pin that the normalized cases now MATCH, while every other kind of
  // disagreement (grade, a genuinely different title, price, a soldAt that
  // is actually a different second) still REFUSES exactly as before.

  it("MATCHES the exact doubled-leading-year twin from the census (AC-AB) -- DELETES, was previously a false REFUSE", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "doubled-year-title");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, cardYear: 2025, title: "2025 2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, cardYear: 2025, title: "2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).not.toMatch(/REFUSED \(content-differs\)/);
    expect(r.out).toMatch(/normalized comparison on: title/);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("MATCHES a hyphen-joined doubled leading year ('2025-2025 ...') -- same parity dedupeYearPrefix already has (review follow-up)", () => {
    // PR #2474 review: normalizeTitleForVariance's first cut used a
    // space-only regex and missed this shape even though dedupeYearPrefix
    // (the move-side healer) already handled it. Both now share one
    // pattern via dedupeYearPrefix itself.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "doubled-year-title-hyphen");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, cardYear: 2025, title: "2025-2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, cardYear: 2025, title: "2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).not.toMatch(/REFUSED \(content-differs\)/);
    expect(r.out).toMatch(/normalized comparison on: title/);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("CONTROL: still REFUSES when the two leading 4-digit tokens actually DIFFER -- not every doubled-looking title matches", () => {
    // "2024-2025 ..." is not a doubled year -- it is two DIFFERENT years
    // (e.g. a split-year season product misfiled), and must not be folded
    // into a match by a normalizer that only checks "starts with two
    // 4-digit tokens" without checking they're the SAME token.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "different-leading-years");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, cardYear: 2025, title: "2024-2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, cardYear: 2025, title: "2025 Topps Chrome Update Baseball Victor Hurtado #AC-AB Base" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(content-differs\)/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("MATCHES the exact soldAt-format twin from the census (+00:00 vs .000Z, same instant) -- DELETES", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "soldat-format-twin");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, soldAt: "2026-07-18T03:36:00+00:00" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, soldAt: "2026-07-18T03:36:00.000Z" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).not.toMatch(/REFUSED \(content-differs\)/);
    expect(r.out).toMatch(/normalized comparison on:.*soldAt/);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("still REFUSES (content-differs) when soldAt is a genuinely different second, not just a different format", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "soldat-one-second-apart");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, soldAt: "2026-07-18T03:36:00.000Z" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, soldAt: "2026-07-18T03:36:01.000Z" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(content-differs\)/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("still REFUSES (content-differs) when gradeCompany/gradeValue disagree -- graded vs raw is never the same sale", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "graded-vs-raw");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, gradeCompany: "PSA", gradeValue: 10 },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, gradeCompany: null, gradeValue: null },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(content-differs\)/);
    expect(r.out).toMatch(/gradeCompany|gradeValue/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("still REFUSES (content-differs) for a real vendor-title vs checklist-title pair -- not a formatting difference", () => {
    // A genuinely different description, not a doubled-year artifact: the
    // vendor's paraphrase vs the checklist's own canonical wording for a
    // DIFFERENT-shaped title. Normalization must not blur this into a match.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "vendor-vs-checklist-title");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, title: "2024 Bowman Chrome Victor Hurtado Gold Refractor Auto /50 #CPA-VH" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, title: "VICTOR HURTADO RC AUTO GOLD REFRACTOR /50 PSA BGS SGC INVEST" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(content-differs\)/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("ignores a parallel-spelling difference alone -- the isauto-twins population's whole point", () => {
    // The committed lists' own population: a no-auto/auto or spelling-drift
    // parallel pair is the SAME sale mis-filed onto the wrong address, not a
    // different sale. `parallel` must NOT gate content identity.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "parallel-ignored");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, parallel: "Gold Refractor" },
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID, parallel: "GoldRefractor" },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.out).not.toMatch(/REFUSED \(content-differs\)/);
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("REFUSES (same-id) when deleteCardId equals keepCardId -- a list defect, never a silent skip", () => {
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: KEEP_ID, reason: "why" }], "same-id");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [KEEPER_SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/MALFORMED/);
    expect(r.led.deletes.length).toBe(0);
  });

  it("FAILS (extra-copies-remain) when a THIRD physical copy survives the delete, never reported as clean", () => {
    // A third document this lane's own entry never named still answers to
    // this id after the delete -- the cross-partition verify (GATE e) must
    // catch it and FAIL, never report a clean DELETED.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "extra-copies-remain");
    const catalog = [KEEPER_CATALOG_ROW];
    const THIRD_ID = "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50-STRAY2";
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
      { ...KEEPER_SALE, cardId: THIRD_ID, hobbyiqCardId: THIRD_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/FAILED \(extra-copies-remain\)/);
    expect(r.out).toMatch(/EXTRA COPY: cardId=/);
    // The named delete DID happen (deleteCardId's own document is gone) --
    // what failed is the VERIFY, because a copy this entry never named is
    // still present. `deleted` must not count this as a clean success.
    expect(r.led.deletes).toEqual([SALE_ID]);
    expect(r.led.finalSales.length).toBe(2);
    expect(r.out).not.toMatch(/^  DELETED\s+1/m);
  });

  it("FAILS (verify-threw) when the post-delete cross-partition verify query THROWS -- never reported as clean", () => {
    // A thrown read-back is FAILED, never clean -- the same rule
    // relocateSoldComp's own verify applies (lib/relocate-sold-comp.cjs).
    // The delete itself already succeeded (deleteCardId's own document is
    // gone), but this run does not know the true post-delete state of the
    // pool, so it must not report success on a guess -- reviewer-requested
    // regression coverage alongside the extra-copies-remain case above.
    const list = writeList([{ saleId: SALE_ID, keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" }], "verify-threw");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      KEEPER_SALE,
      { ...KEEPER_SALE, cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog, throwOnVerifyQuery: true });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FAILED: post-delete verify threw/);
    expect(r.out).toMatch(/FAILED\s+1/);
    expect(r.out).not.toMatch(/^\s*DELETED\s+1/m);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    // The delete call itself DID run and succeed -- the ledger shows the
    // stray gone -- but the lane must count this as FAILED, not DELETED,
    // because the verify that was supposed to confirm it never answered.
    expect(r.led.deletes).toEqual([SALE_ID]);
  });

  it("reconciles cleanly across a mixed batch of outcomes -- deleted, skipped, refused, failed", () => {
    const A = { saleId: "src::A", keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "clean delete" };
    const B_DELETE = "hiq:baseball:2024:bowman-chrome:player-b:gold-refractor:auto:num-51";
    const B = { saleId: "src::B", keepCardId: KEEP_ID, deleteCardId: B_DELETE, reason: "already gone" };
    const C_DELETE = "hiq:baseball:2024:bowman-chrome:player-c:gold-refractor:auto:num-52";
    const C = { saleId: "src::C", keepCardId: KEEP_ID, deleteCardId: C_DELETE, reason: "content differs" };
    const list = writeList([A, B, C], "mixed-batch");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, id: "src::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { ...KEEPER_SALE, id: "src::A", cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
      { ...KEEPER_SALE, id: "src::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }, // B's stray already gone
      { ...KEEPER_SALE, id: "src::C", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { ...KEEPER_SALE, id: "src::C", cardId: C_DELETE, hobbyiqCardId: C_DELETE, price: 12345 }, // differs
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DELETED\s+1/);
    expect(r.out).toMatch(/SKIPPED: already-gone\s+1/);
    expect(r.out).toMatch(/REFUSED: content-differs\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.deletes).toEqual(["src::A"]);
  });
});

describe("end-to-end: a budget stop reconciles exactly, never double-counted", () => {
  it("stops before the reserve, prints the marker, and the reconcile still balances", () => {
    const A = { saleId: "src::A", keepCardId: KEEP_ID, deleteCardId: DELETE_ID, reason: "why" };
    const B_DELETE = "hiq:baseball:2024:bowman-chrome:player-b:gold-refractor:auto:num-51";
    const B = { saleId: "src::B", keepCardId: KEEP_ID, deleteCardId: B_DELETE, reason: "why" };
    const list = writeList([A, B], "budget-stop");
    const catalog = [KEEPER_CATALOG_ROW];
    const sales = [
      { ...KEEPER_SALE, id: "src::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { ...KEEPER_SALE, id: "src::A", cardId: DELETE_ID, hobbyiqCardId: DELETE_ID },
      { ...KEEPER_SALE, id: "src::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { ...KEEPER_SALE, id: "src::B", cardId: B_DELETE, hobbyiqCardId: B_DELETE },
    ];

    const r = drive(
      { SCOPE: list, BACKFILL_APPLY: "false", RUN_MINUTES: "1", BUDGET_MS: "0", RESERVE_MS: "1" },
      { sales, catalog },
    );
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped at the 1-minute budget/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.deletes.length).toBe(0);
  });
});
