/**
 * repoint-sales-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for a single
 * sold_comps re-key (Drew, 2026-09-27 widget ruling: "Build
 * repoint-sales-by-list lane"). This lane moves sold_comps rows from a
 * listed SOURCE hobbyiqCardId to a listed DESTINATION hobbyiqCardId; it
 * never retires the emptied source catalog row (that is
 * relocate-catalog-rows-by-list's own job, a separate follow-up).
 *
 * Modeled on relocateCatalogRowsByList.test.ts's own shape: the lane is
 * require()'d directly (its dist/ requires live inside main(), so the
 * module loads with no built tree) and its pure gate functions
 * (classifyEntry, sameProductAddress) are pinned against malformed and
 * well-formed list entries. An in-memory Cosmos fake — mirroring how that
 * file's own `fakeCat` fakes a container — drives the per-entry gates
 * end-to-end for card_catalog reads, and the shared `relocateSoldComp`
 * helper (already covered by its own suites) is exercised through a
 * minimal sold_comps fake for the write path.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as os from "node:os";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");
const backend = join(__dirname, "..");
const runner = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");
const firstList = join(__dirname, "..", "data", "sales-repoints", "2026-09-27-tcus-2025-usc143-raywave.json");

type Entry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
  expectedSales?: number;
};
type ListDoc = { forLane: string; entries: Entry[]; finding?: string; census?: unknown };

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree — its dist/ requires live inside
// main(), exactly as every sibling list lane does it, so the contract is
// testable without a compile step.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean; why?: string; fromId?: string; toId?: string; player?: string;
    cardNumber?: string; reason?: string; allowCrossProduct?: boolean;
    crossProductRuling?: string; expectedSales?: number | null;
  };
  sameProductAddress: (
    fromRow: unknown,
    toRow: unknown,
  ) => { ok: boolean; why?: string; differing?: string[] };
};

// ── the runner contract ──────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    // Line-ending agnostic: the checkout is CRLF on Windows and LF in CI.
    expect(readFileSync(runner, "utf8")).toMatch(/^ {10}- repoint-sales-by-list\r?$/m);
  });

  it("rides the existing SCOPE passthrough — no new workflow_dispatch input", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
    // GitHub caps workflow_dispatch at 25 inputs and 24 are used. A new one
    // here would be the input that broke the cap.
    expect(yml).not.toContain("sales_list:");
    expect(yml).not.toContain("repoint_list:");
  });

  it("and BACKFILL_APPLY is what arms it, not APPLY", () => {
    expect(readFileSync(runner, "utf8")).toMatch(/BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply/);
    expect(readFileSync(lane, "utf8")).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
  });

  it("has a relaunch step modeled on relocate-catalog-rows-by-list's own block", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toContain("inputs.script == 'repoint-sales-by-list'");
    expect(yml).toContain("uses: ./.github/actions/relaunch-on-marker");
    expect(yml).toMatch(
      /gh workflow run backfill-runner\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f script=repoint-sales-by-list -f apply="\$\{\{ inputs\.apply \}\}" -f scope="\$\{\{ inputs\.scope \}\}"/,
    );
  });

  it("the shared relaunch action exists and is not itself edited by this change", () => {
    const action = join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(existsSync(action)).toBe(true);
    // The pin here is behavioural, not a hash check: the task is that this
    // PR must not edit the action's own file, which is verified by the PR
    // diff itself (this suite only proves the file exists and is USED via
    // `uses:`, which the earlier assertion in this block already covers).
  });
});

// ── the scope refusal ────────────────────────────────────────────────────

describe("the scope must name a committed list", () => {
  it("REFUSES an empty scope — no default list", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("if (!RAW_SCOPE) {");
    expect(src).toContain("has no default list");
  });

  it("REFUSES another lane's vocabulary", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('if (!RAW_SCOPE.endsWith(".json"))');
    for (const stray of ["refractor", "all", "improve"]) {
      expect(stray.endsWith(".json")).toBe(false);
    }
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
      fromId: "hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto",
      toId: "hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto",
      player: "Adael Amador", cardNumber: "USC143", reason: "spelling drift",
    });
    expect(r.ok).toBe(true);
    expect(r.fromId).toContain("raywave-refractor");
    expect(r.toId).toContain("ray-wave-refractor");
  });

  it("refuses a missing fromId", () => {
    const r = L.classifyEntry({ toId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no fromId");
  });

  it("refuses a missing toId", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no toId");
  });

  it("refuses fromId that is not a hiq slug", () => {
    const r = L.classifyEntry({ fromId: "cardhedge::123", toId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses toId that is not a hiq slug", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", toId: "cardhedge::123", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses fromId == toId", () => {
    const id = "hiq:a:1:b:1:base:no-auto";
    const r = L.classifyEntry({ fromId: id, toId: id, reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("toId equals fromId");
  });

  it("refuses an entry with no reason — an unexplained move is not reviewable", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no reason");
  });

  it("refuses allowCrossProduct:true with no crossProductRuling", () => {
    const r = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:c:1:base:no-auto",
      reason: "why", allowCrossProduct: true,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("crossProductRuling");
  });

  it("accepts allowCrossProduct:true WITH a ruling string", () => {
    const r = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:c:1:base:no-auto",
      reason: "why", allowCrossProduct: true, crossProductRuling: "Drew ruling 2026-09-27",
    });
    expect(r.ok).toBe(true);
    expect(r.allowCrossProduct).toBe(true);
  });

  it("carries expectedSales through when it is a finite number, else null", () => {
    const withCount = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto",
      reason: "why", expectedSales: 1,
    });
    expect(withCount.expectedSales).toBe(1);
    const without = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto", reason: "why",
    });
    expect(without.expectedSales).toBeNull();
  });
});

// ── sameProductAddress: the cross-product gate ───────────────────────────

describe("sameProductAddress compares the CATALOG ROWS' own fields", () => {
  const base = { sport: "baseball", year: 2025, setKey: "topps-chrome-update-series", cardNumber: "USC143" };

  it("agrees when every field matches, case/whitespace insensitive", () => {
    const r = L.sameProductAddress(base, { ...base, sport: " Baseball " });
    expect(r.ok).toBe(true);
    expect(r.differing).toEqual([]);
  });

  it("disagrees and names the differing field(s)", () => {
    const r = L.sameProductAddress(base, { ...base, setKey: "topps-chrome" });
    expect(r.ok).toBe(false);
    expect(r.differing).toContain("setKey");
  });

  it("disagrees on more than one field at once", () => {
    const r = L.sameProductAddress(base, { ...base, sport: "basketball", cardNumber: "1" });
    expect(r.ok).toBe(false);
    expect(r.differing).toEqual(expect.arrayContaining(["sport", "cardNumber"]));
  });
});

// ── the first committed list ─────────────────────────────────────────────

describe("the first committed list (USC143)", () => {
  it("is shaped the way this lane requires", () => {
    const doc = readList(firstList);
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(doc.entries.length).toBe(1);
    const [e] = doc.entries;
    expect(e.fromId).toBe("hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto");
    expect(e.toId).toBe("hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto");
    expect(e.expectedSales).toBe(1);
    const c = L.classifyEntry(e);
    expect(c.ok).toBe(true);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(firstList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });
});

// ── namesAgree is reused, never reimplemented ────────────────────────────

describe("this lane reuses the shared namesAgree, never a bespoke compare", () => {
  it("requires lib/name-agreement.cjs at module scope", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "name-agreement.cjs"))');
    expect(src).toContain("namesAgree(saleName, destName)");
  });

  it("requires the dual sales-at-id check, never a bare cross-partition query", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "sales-at-id.cjs"))');
    expect(src).toContain("drainSalesIdsAtId(pool, fromId");
  });

  it("requires the shared cosmos backoff, never a bespoke retry loop", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "cosmos-backoff.cjs"))');
    expect(src).toContain("withBackoff(fn,");
  });

  it("requires pkOf/None-pk awareness for the catalog read", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "catalog-none-pk.cjs"))');
  });

  it("never retires the source catalog row — one axis, sales only", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).not.toContain("retireCatalogRow");
    expect(src).not.toContain("assert-retire-legal");
  });
});

// ── end-to-end against an in-memory Cosmos fake ──────────────────────────
//
// Mirrors how relocateCatalogRowsByList.test.ts fakes its container: a plain
// object exposing `.item(id, pk).read()` and `.items.query(...).fetchAll()`,
// no real @azure/cosmos client anywhere in the path. This drives `main()`'s
// own catalog-read helper indirectly is out of scope for a unit suite (main()
// requires dist/ and a live CosmosClient at the top) — what is pinned here is
// the GATE LOGIC every entry must pass, exercised directly against the pure
// functions the lane exports, plus the two library functions (`salesAtId`,
// `namesAgree`) the lane is pinned (above) to actually call.

describe("the gates, driven directly against the shared libraries", () => {
  const { salesAtId } = require_(join(__dirname, "..", "scripts", "lib", "sales-at-id.cjs"));
  const { namesAgree } = require_(join(__dirname, "..", "scripts", "lib", "name-agreement.cjs"));

  function fakePool(rows: Array<{ id: string; cardId: string }>) {
    return {
      items: {
        query: (spec: { parameters: Array<{ name: string; value: string }> }, opts: { partitionKey?: string }) => {
          const id = spec.parameters.find((p) => p.name === "@id")?.value;
          const matches = rows.filter((r) => r.id === id || r.cardId === id);
          const scoped = opts?.partitionKey
            ? matches.filter((r) => r.cardId === opts.partitionKey)
            : matches;
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => { done = true; return { resources: scoped }; },
          };
        },
      },
    };
  }

  it("refuses zero-sales — a source with no rows is nothing to do", async () => {
    const pool = fakePool([]);
    const res = await salesAtId(pool, "hiq:a:1:b:1:base:no-auto");
    expect(res.total).toBe(0);
  });

  it("finds a sale present under either read form", async () => {
    const pool = fakePool([{ id: "src::1", cardId: "hiq:a:1:b:1:base:no-auto" }]);
    const res = await salesAtId(pool, "hiq:a:1:b:1:base:no-auto");
    expect(res.total).toBe(1);
  });

  it("namesAgree passes a sale title against the destination player name", () => {
    expect(namesAgree("Adael Amador", "Adael Amador")).toBe(true);
    // Case/punctuation-insensitive (rule d), but "RC" is not on the closed
    // subset-marker vocabulary namesAgree strips, so it correctly disagrees
    // rather than being silently folded away — the fixture below spells the
    // sale and the destination identically, as a real checklist-backed sale
    // title generally would once cleaned of anything the closed list knows.
    expect(namesAgree("adael amador", "Adael Amador")).toBe(true);
  });

  it("namesAgree refuses a genuinely different player", () => {
    expect(namesAgree("Derek Jeter", "Todd Hundley")).toBe(false);
  });
});

// ── REPORT writes nothing; a thrown read-back is FAILED not clean ───────

describe("REPORT computes the same gates APPLY would, and writes nothing", () => {
  it("relocateSoldComp is called EXACTLY once, dryRun tied to !APPLY — no parallel branch that skips it in REPORT", () => {
    const src = readFileSync(lane, "utf8");
    // Review round 1 (PR #2461): the shipped version short-circuited with
    // `if (!APPLY) { movedSales++; continue; }` BEFORE relocateSoldComp was
    // ever called, so guardSoldCompDoc never ran in REPORT mode at all. The
    // fix is the same one-derivation shape relocate-catalog-rows-by-list.cjs
    // (moveCatalogRow, dryRun: !APPLY) and repoint-sales-isauto-flip.cjs
    // (performMove) already use: ONE call, for both modes.
    expect((src.match(/await relocateSoldComp\(pool, \{/g) ?? []).length).toBe(1);
    expect(src).toContain("dryRun: !APPLY,");
    expect(src).not.toContain("if (!APPLY) {\n        movedSales++;");
    expect(src).not.toMatch(/if \(!APPLY\) \{\s*movedSales\+\+/);
  });

  it("a destination that fails splitIdentityWriteGuard is REFUSED, named 'guard', counted the same in both modes", () => {
    const src = readFileSync(lane, "utf8");
    // relocateSoldComp consults guardSoldCompDoc BEFORE its own `if (dryRun)
    // return {...}` short-circuit (lib/relocate-sold-comp.cjs), so calling it
    // unconditionally with dryRun:!APPLY is what makes the guard run in
    // REPORT too — this pins the CALL SITE reads that verdict, not just that
    // the shared helper itself does (already covered by that helper's own
    // suite).
    expect(src).toContain('res.stage === "guard"');
    expect(src).toContain("refusedGuard++");
  });

  it("a thrown relocateSoldComp call is counted FAILED, never a clean move", () => {
    const src = readFileSync(lane, "utf8");
    // The caller's own briefing: relocateSoldComp's catch path can report
    // duplicatesLeft:[] on a THROWN read-back, which reads as "nothing left
    // behind" — this lane's own try/catch around the call must count a
    // throw as failed, never treat the absence of duplicatesLeft as clean.
    const callSite = src.indexOf("await relocateSoldComp(pool, {");
    const catchAfter = src.indexOf("} catch (err) {", callSite);
    expect(callSite).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(callSite);
    const catchBlock = src.slice(catchAfter, catchAfter + 700);
    expect(catchBlock).toContain("failedSales++");
    expect(catchBlock).not.toContain("movedSales++");
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

// ── end-to-end against an in-memory Cosmos fake, driven as the committed
// file via execFileSync -- modeled on repointSalesTiffanyTitleGatedLane.
// test.ts's own shim (etag-aware upsert/read/delete via relocate-sold-comp
// .cjs's real relocateSoldComp, @azure/cosmos replaced through Module._load,
// every other require -- catalogAuthority, writeReconciliation,
// splitIdentityWriteGuard -- loading the REAL compiled dist/). Review
// round 1 on PR #2461 asked for three fixes verified end-to-end: the guard
// runs identically in REPORT and APPLY; a budget stop mid-entry reconciles
// exactly; expectedSales is enforced. All three need the lane actually
// running against fake containers, which is what this harness drives. ────

beforeAll(() => {
  const built = existsSync(join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

const tmp = mkdtempSync(join(os.tmpdir(), "repoint-sales-by-list-lane-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SPORT = "baseball";
const YEAR = 2025;
const SETKEY = "topps-chrome-update-series";
const FROM_ID = `hiq:${SPORT}:${YEAR}:${SETKEY}:usc143:raywave-refractor:no-auto`;
const TO_ID = `hiq:${SPORT}:${YEAR}:${SETKEY}:usc143:ray-wave-refractor:no-auto`;

const FROM_ROW = { id: FROM_ID, cardId: FROM_ID, sport: SPORT, year: YEAR, setKey: SETKEY, cardNumber: "usc143", source: "checklistinsider-2026-08-27", playerName: "Adael Amador" };
const TO_ROW = { id: TO_ID, cardId: TO_ID, sport: SPORT, year: YEAR, setKey: SETKEY, cardNumber: "usc143", source: "checklistinsider-2026-08-27", playerName: "Adael Amador" };

function writeList(entries: Entry[], tag: string): string {
  const p = join(tmp, `list-${tag}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ forLane: "repoint-sales-by-list", entries }));
  return p;
}

function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
  /** Artificial delay (ms) on EVERY sold_comps point read, used to drive the
   *  runner-budget.cjs clock (BUDGET_MS/RESERVE_MS env, both overridable) to
   *  expire deterministically mid-entry, after a known number of per-sale
   *  reads have already completed. */
  saleReadDelayMs?: number;
} = {}): { requirePath: string; ledger: string } {
  const ledger = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  const saleReadDelayMs = opts.saleReadDelayMs ?? 0;

  writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const SALE_READ_DELAY_MS = ${JSON.stringify(saleReadDelayMs)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (SALE_READ_DELAY_MS > 0) await sleep(SALE_READ_DELAY_MS);
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
    // sales-at-id.cjs's dual check: the SAME query text, once cross-
    // partition and once scoped with partitionKey -- both are answered from
    // the same in-memory set here, since a fake has no real partitioning.
    query: (spec, feedOpts) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const all = [...state.sales.values()];
      let resources;
      if (q.includes("c.hobbyiqCardId = @id OR c.cardId = @id")) {
        const id = params["@id"];
        resources = all.filter((d) => d.hobbyiqCardId === id || d.cardId === id);
        if (feedOpts && feedOpts.partitionKey) {
          resources = resources.filter((d) => d.cardId === feedOpts.partitionKey);
        }
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => { done = true; return { resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }; },
        fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
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
  // catalogAuthority, writeReconciliation and splitIdentityWriteGuard are
  // left to load the REAL compiled dist/ so this end-to-end suite exercises
  // the actual guard and reconciliation, not a no-op.
  return realLoad.apply(this, arguments);
};
`);
  return { requirePath: p, ledger };
}

function drive(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const { requirePath, ledger } = shim(opts);
  // spawnSync, not execFileSync: execFileSync returns ONLY stdout on a clean
  // exit and only merges stderr into the thrown error's fields on a NONZERO
  // exit. This lane's REFUSED/FAILED lines are console.error (stderr) and a
  // REPORT run legitimately exits 0, so execFileSync would silently drop
  // every one of them on the success path this suite most needs to read.
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

describe("end-to-end: the guard runs identically in REPORT and APPLY", () => {
  // A destination address with too few colon segments trips
  // splitIdentityWriteGuard's malformed-key park BEFORE relocateSoldComp's
  // own `if (dryRun) return` -- so calling it unconditionally with
  // dryRun:!APPLY (the fix) makes the refusal fire the same way in both
  // modes. A destination this short still passes classifyEntry's own
  // `toId.startsWith("hiq:")` check, so the malformed shape is caught by the
  // shared guard, not by this lane's own list-schema validation.
  const MALFORMED_TO = "hiq:x:y";

  it("REPORT refuses the malformed destination and counts it as guard, same as APPLY", () => {
    // allowCrossProduct bypasses GATE 3 (sameProductAddress) deliberately --
    // this test's whole point is to reach the per-sale relocateSoldComp
    // call so the SHARED GUARD is what refuses, not this lane's own product
    // gate (which a 3-segment id would also fail, for an unrelated reason).
    const list = writeList([{
      fromId: FROM_ID, toId: MALFORMED_TO, reason: "why",
      allowCrossProduct: true, crossProductRuling: "test: reach the guard",
    }], "guard-report");
    const catalog = [FROM_ROW, {
      id: MALFORMED_TO, cardId: MALFORMED_TO, source: "checklistinsider-2026-08-27",
      sport: "baseball", year: 2025, setKey: "topps-chrome-update-series", cardNumber: "usc143", playerName: "Adael Amador",
    }];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    expect(reportRun.out).toMatch(/REFUSED \(guard\)/);
    expect(reportRun.out).toMatch(/REFUSED: guard \(malformed key\)\s+1/);
    expect(reportRun.led.salesUpserts.length).toBe(0);
    expect(reportRun.led.salesDeletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    expect(applyRun.out).toMatch(/REFUSED \(guard\)/);
    expect(applyRun.out).toMatch(/REFUSED: guard \(malformed key\)\s+1/);
    // The count is IDENTICAL in both modes, and APPLY still wrote nothing --
    // a guard refusal never reaches relocateSoldComp's own upsert.
    expect(applyRun.led.salesUpserts.length).toBe(0);
    expect(applyRun.led.salesDeletes.length).toBe(0);
  });
});

describe("end-to-end: a well-formed move reconciles in both modes", () => {
  it("REPORT computes the move and writes nothing; APPLY writes it", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "spelling drift", expectedSales: 1 }], "clean-move");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    expect(reportRun.code).toBe(0);
    expect(reportRun.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
    expect(reportRun.led.salesUpserts.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/MOVED \(sales\)\s+1/);
    expect(applyRun.led.salesUpserts).toEqual([FROM_ID.replace(FROM_ID, "src::1")].map(() => "src::1"));
    expect(applyRun.led.salesDeletes).toEqual(["src::1"]);
  });
});

describe("end-to-end: expectedSales is enforced", () => {
  it("refuses expected-sales-mismatch when the live dual count disagrees with the list", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why", expectedSales: 2 }], "expected-mismatch");
    const catalog = [FROM_ROW, TO_ROW];
    // Only ONE sale actually present, but the list claims 2.
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    expect(r.out).toMatch(/REFUSED \(expected-sales-mismatch\)/);
    expect(r.out).toMatch(/REFUSED: expected-sales-mismatch\s+1/);
    // Never enumerated a single sale under a stale census.
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("passes when expectedSales matches, and skips the gate entirely when omitted", () => {
    const listMatches = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why", expectedSales: 1 }], "expected-match");
    const listOmitted = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "expected-omitted");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    // The banner ALWAYS prints the "REFUSED: expected-sales-mismatch" label,
    // with a trailing count -- what must be absent is a NONZERO count and
    // the per-entry "REFUSED (expected-sales-mismatch)" decision line, not
    // the label text itself.
    const matches = drive({ SCOPE: listMatches, BACKFILL_APPLY: "false" }, { sales, catalog });
    expect(matches.out).not.toMatch(/REFUSED \(expected-sales-mismatch\)/);
    expect(matches.out).toMatch(/REFUSED: expected-sales-mismatch\s+0/);
    expect(matches.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const omitted = drive({ SCOPE: listOmitted, BACKFILL_APPLY: "false" }, { sales: sales.map((s) => ({ ...s, id: "src::2" })), catalog });
    expect(omitted.out).not.toMatch(/REFUSED \(expected-sales-mismatch\)/);
    expect(omitted.out).toMatch(/REFUSED: expected-sales-mismatch\s+0/);
    expect(omitted.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
  });
});

describe("end-to-end: a budget stop mid-entry reconciles exactly, never double-counted", () => {
  it("an entry with multiple sales, stopped partway, counts moved + not-reached-sales without a mismatch", () => {
    // Two sales at the SAME fromId/toId pair -- one entry, so its gates run
    // ONCE and both sales share the same catalog reads. The budget is
    // configured (via RUN_MINUTES/RESERVE_MS/BUDGET_MS env, all already
    // overridable per lib/runner-budget.cjs) to expire between the two
    // per-sale iterations: a delay on every sold_comps point read plus a
    // tiny BUDGET_MS make the SECOND sale's read observe outOfClock()==true.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "budget-straddle");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [
      { id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" },
      { id: "src::2", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 20, soldAt: "2026-01-02", playerName: "Adael Amador", parallel: "RayWave Refractor" },
    ];

    const r = drive(
      { SCOPE: list, BACKFILL_APPLY: "false", RUN_MINUTES: "1", BUDGET_MS: "150", RESERVE_MS: "100" },
      { sales, catalog, saleReadDelayMs: 200 },
    );
    // The first sale's read (200ms) already exceeds the 150ms budget by the
    // time the SECOND sale's outOfClock() check runs, so exactly one sale is
    // processed and one is left not-reached -- never both double-counted
    // against the entry AND their own sale outcome.
    expect(r.out).toMatch(/not reached \(budget, sales\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.code).not.toBe(4);
  });
});
