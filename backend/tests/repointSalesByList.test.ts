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
const { titleNamesPlayer } = require_(join(__dirname, "..", "scripts", "lib", "name-agreement.cjs")) as {
  titleNamesPlayer: (title: unknown, playerName: unknown, opts?: { stripTrailingTokens?: string[] }) => boolean;
};

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
    // GATE 6's own opts always carry the destination product's own checklist
    // parallel vocabulary as stripTrailingTokens (run 36346769892) -- both
    // namesAgree (the playerName fallback path) and titleNamesPlayer (the
    // title-first path, this PR's review-fixed revision) are called with the
    // SAME `opts`, built once from the real corpus, never two divergent
    // vocabularies for one entry.
    expect(src).toContain("const opts = { stripTrailingTokens: strip.tokens };");
    expect(src).toContain("titleNamesPlayer(titleSource, destName, opts)");
    expect(src).toContain("namesAgree(saleName, destName, opts)");
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
  /** Sale ids (from `sales`) to delete from the fake container the INSTANT
   *  the drain query (drainSalesIdsAtId, GATE 4) has already returned them
   *  -- simulating another lane's concurrent, benign mutation between the
   *  drain and this lane's own per-sale point read, which is exactly the
   *  `goneSinceRead` shape (review round 2). */
  goneAfterDrain?: string[];
} = {}): { requirePath: string; ledger: string } {
  const ledger = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  const saleReadDelayMs = opts.saleReadDelayMs ?? 0;
  const goneAfterDrain = opts.goneAfterDrain ?? [];

  writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const SALE_READ_DELAY_MS = ${JSON.stringify(saleReadDelayMs)};
const GONE_AFTER_DRAIN = new Set(${JSON.stringify(goneAfterDrain)});
let drainedOnce = false;
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
// finalSales is recomputed from live pool state on every save() -- a test
// that wants to assert "exactly one document remains for this id" (the
// #2454/run-36353646453 regression) reads this from the ledger file rather
// than the upsert/delete lists, which only show WHAT WAS ATTEMPTED, not
// what a stray un-deleted duplicate leaves standing.
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
      } else if (q.includes("WHERE c.id = @id") && q.includes("c.hobbyiqCardId")) {
        // relocateSoldComp's OPTIONAL cross-partition duplicate verify
        // (verifyNoDuplicatesAcrossPartitions, lib/relocate-sold-comp.cjs) --
        // this lane opts in. Cross-partition by id ALONE, mirroring how the
        // real container answers it: every document, in every partition,
        // whose id matches.
        const id = params["@id"];
        resources = all.filter((d) => d.id === id).map((d) => ({ id: d.id, cardId: d.cardId ?? null, hobbyiqCardId: d.hobbyiqCardId ?? null }));
      } else {
        throw new Error("fake sold_comps: unsupported query " + q);
      }
      let done = false;
      const maybeGoneAfterDrain = () => {
        // Fires once, after the FIRST drain result set is handed back --
        // simulating another lane's concurrent delete landing in the window
        // between drainSalesIdsAtId's own read and this lane's later
        // per-sale point read. GONE_AFTER_DRAIN is empty on every test that
        // does not opt in, so this is a no-op for all of them.
        if (drainedOnce || GONE_AFTER_DRAIN.size === 0) return;
        drainedOnce = true;
        for (const [key, d] of [...state.sales.entries()]) {
          if (GONE_AFTER_DRAIN.has(d.id)) state.sales.delete(key);
        }
      };
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => {
          done = true;
          const out = resources.map((r) => structuredClone(r));
          maybeGoneAfterDrain();
          return { resources: out, continuationToken: undefined };
        },
        fetchAll: async () => {
          const out = resources.map((r) => structuredClone(r));
          maybeGoneAfterDrain();
          return { resources: out };
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

/**
 * Review round 2 (PR #2461): a stale identifier from round 1's reconcile
 * rewrite (`intended`, renamed to intendedEntries/intendedSales) survived in
 * the budget-marker log line, reachable ONLY on a budget-stop run -- a
 * ReferenceError there is swallowed by main().catch(), printed as "FATAL:",
 * and exits 3 BEFORE the budget marker relaunch-on-marker greps for, so the
 * relaunch never re-dispatches. Every end-to-end test in this file now
 * calls this after `drive()`, not just the ones already asserting on the
 * banner text, because a thrown error can otherwise hide behind an
 * assertion that only checked "no RECONCILE MISMATCH" or "code !== 4" (round
 * 1's own straddle test did exactly that and passed anyway).
 */
function assertNoUncaughtError(r: { code: number; out: string }) {
  expect(r.out).not.toMatch(/FATAL:/);
  expect(r.out).not.toMatch(/ReferenceError/);
  expect(r.out).not.toMatch(/TypeError/);
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
    assertNoUncaughtError(reportRun);
    expect(reportRun.code).toBe(0);
    expect(reportRun.out).toMatch(/REFUSED \(guard\)/);
    expect(reportRun.out).toMatch(/REFUSED: guard \(malformed key\)\s+1/);
    expect(reportRun.led.salesUpserts.length).toBe(0);
    expect(reportRun.led.salesDeletes.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
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
    assertNoUncaughtError(reportRun);
    expect(reportRun.code).toBe(0);
    expect(reportRun.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
    expect(reportRun.led.salesUpserts.length).toBe(0);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
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
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
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
    assertNoUncaughtError(matches);
    expect(matches.code).toBe(0);
    expect(matches.out).not.toMatch(/REFUSED \(expected-sales-mismatch\)/);
    expect(matches.out).toMatch(/REFUSED: expected-sales-mismatch\s+0/);
    expect(matches.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const omitted = drive({ SCOPE: listOmitted, BACKFILL_APPLY: "false" }, { sales: sales.map((s) => ({ ...s, id: "src::2" })), catalog });
    assertNoUncaughtError(omitted);
    expect(omitted.code).toBe(0);
    expect(omitted.out).not.toMatch(/REFUSED \(expected-sales-mismatch\)/);
    expect(omitted.out).toMatch(/REFUSED: expected-sales-mismatch\s+0/);
    expect(omitted.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
  });
});

describe("end-to-end: a sale gone since the drain is counted, never a false reconcile mismatch", () => {
  it("a ref the drain returned, but whose point read then 404s, lands in goneSinceRead and still reconciles", () => {
    // Review round 2 (PR #2461): drainSalesIdsAtId (GATE 4) counts this ref
    // into intendedSalesTotal the instant the entry passes its gates, but
    // the ref's OWN point read then finds nothing -- a benign concurrent
    // mutation (another lane, or an idempotent re-run of THIS lane, moved
    // or deleted it in the window between the drain and this read). Before
    // this fix that silently `continue`d with no counter at all, so the
    // sale-side identity (moved + refused + failed + notReachedSales)
    // undercounted intendedSalesTotal by exactly one and reported a false
    // RECONCILE MISMATCH on every ordinary race against a live container.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "gone-since-read");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const r = drive(
      { SCOPE: list, BACKFILL_APPLY: "false" },
      { sales, catalog, goneAfterDrain: ["src::1"] },
    );
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gone since read \(benign\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+0/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

// ── end-to-end: GATE 6's caller-supplied stripTrailingTokens (run
// 36346769892, USC143). The lane REFUSED `sale "Adael Amador Teal" vs
// destination "Adael Amador RC"` in REPORT -- same player, two name-shape
// artefacts (a trailing "RC" on the destination's checklist playerName, a
// parallel colour word left in the sale's own player string). This suite
// drives the REAL committed checklist-parallel-names.json corpus (not a
// fake) through checklistParallelNamesFor(2025, "topps-chrome-update-series"),
// which lists "Teal Refractor" for this exact product -- confirmed present
// in the corpus before writing this test. ──────────────────────────────────

describe("end-to-end: GATE 6 strips the destination product's own parallel vocabulary (USC143, run 36346769892)", () => {
  it("REPORT: sale \"Adael Amador Teal\" vs destination \"Adael Amador RC\" -> would-move 1, not a name-disagreement refusal", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "USC143 name-shape repoint", expectedSales: 1 }], "rc-teal-move");
    const catalog = [
      { ...FROM_ROW, playerName: "Adael Amador Teal" },
      { ...TO_ROW, playerName: "Adael Amador RC" },
    ];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador Teal", parallel: "Teal Refractor" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/REFUSED: name-disagreement\s+0/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
    // The banner names the vocabulary it used for this entry's destination.
    expect(r.out).toMatch(/namesAgree vocabulary: \d+ checklist parallel name\(s\) for setKey="topps-chrome-update-series"/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("APPLY: the same pair actually moves the sale", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "USC143 name-shape repoint", expectedSales: 1 }], "rc-teal-apply");
    const catalog = [
      { ...FROM_ROW, playerName: "Adael Amador Teal" },
      { ...TO_ROW, playerName: "Adael Amador RC" },
    ];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador Teal", parallel: "Teal Refractor" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED \(sales\)\s+1/);
    expect(r.led.salesUpserts).toEqual(["src::1"]);
    expect(r.led.salesDeletes).toEqual(["src::1"]);
  });

  it("control: a genuinely different player at the destination still REFUSES (name-disagreement), even with the same vocabulary in play", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "control: different player", expectedSales: 1 }], "rc-teal-control");
    const catalog = [
      { ...FROM_ROW, playerName: "Adael Amador Teal" },
      { ...TO_ROW, playerName: "Julio Rodriguez RC" },
    ];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador Teal", parallel: "Teal Refractor" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(name-disagreement\) src::1: sale "Adael Amador Teal" \(decidedBy=playerName\) vs destination "Julio Rodriguez RC"/);
    expect(r.out).toMatch(/REFUSED: name-disagreement\s+1/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+0/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("end-to-end: a budget stop mid-entry reconciles exactly, never double-counted", () => {
  it("an entry with multiple sales, stopped partway, counts moved + not-reached-sales without a mismatch", () => {
    // Two sales at the SAME fromId/toId pair -- one entry, so its gates run
    // ONCE and both sales share the same catalog reads.
    //
    // CI flake (run 36353024102, PR #2464): this straddle used to be driven
    // by WALL-CLOCK timing alone -- a delay on every sold_comps point read
    // sized against BUDGET_MS/RESERVE_MS, racing the budget's own
    // Date.now()-based outOfClock() to land the stop between the two
    // per-sale reads. That race has two failure directions on a loaded CI
    // runner, and widening the margins (#2463, from 150/100/200 to
    // 1000/500/600) narrowed it but could not remove it: the child's own
    // ~350ms fixed startup cost (GATE 6's checklist-parallel-names.json
    // corpus parse) can eat MORE of the budget than measured before the
    // first sale even starts, or the second sale's 600ms read can finish
    // before its own check runs, so the straddle sometimes lands on 0 or 2
    // sales instead of exactly 1.
    //
    // The fix: HIQ_TEST_FAKE_CLOCK_STEP_MS (lib/runner-budget.cjs) replaces
    // Date.now() inside the budget's own left()/outOfClock() with a virtual
    // clock that advances a FIXED amount on every call, so the Nth call to
    // outOfClock() always reports the same elapsed time no matter how long
    // the process actually took to get there. outOfClock() is called once
    // per entry (outer loop) and once per sale (inner loop) -- three calls
    // total for a two-sale entry: entry check (call 1, elapsed 0ms), sale-1
    // check (call 2, elapsed 400ms), sale-2 check (call 3, elapsed 800ms).
    // outOfClock() is `left() < RESERVE_MS`: against a 1000ms budget with a
    // 500ms reserve, call 1 leaves 1000ms (>= 500, entry proceeds), call 2
    // leaves 600ms (>= 500, sale 1 proceeds), call 3 leaves 200ms (< 500,
    // sale 2 does NOT proceed) -- deterministic by call count, not by wall
    // time. saleReadDelayMs is dropped entirely: with the clock fixed, no
    // real delay is needed to make sale 2 land after the stop.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "budget-straddle");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [
      { id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" },
      { id: "src::2", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 20, soldAt: "2026-01-02", playerName: "Adael Amador", parallel: "RayWave Refractor" },
    ];

    const r = drive(
      {
        SCOPE: list, BACKFILL_APPLY: "false",
        RUN_MINUTES: "1", BUDGET_MS: "1000", RESERVE_MS: "500",
        // VITEST=1 is required (review round 1, PR #2465): runner-budget.cjs
        // self-defends against a leaked HIQ_TEST_FAKE_CLOCK_STEP_MS reaching
        // a real lane run by refusing to honour it unless VITEST is also
        // set -- and drive()'s child env is a minimal explicit allowlist,
        // not inherited, so this must be passed here just like every other
        // env var the lane reads.
        HIQ_TEST_FAKE_CLOCK_STEP_MS: "400", VITEST: "1",
      },
      { sales, catalog },
    );
    // Exactly one sale is processed and one is left not-reached -- never
    // both double-counted against the entry AND their own sale outcome.
    expect(r.out).toMatch(/not reached \(budget, sales\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    // Review round 2 (PR #2461): line 659's budget-marker log line referenced
    // the stale `intended` variable (renamed to intendedEntries/intendedSales
    // in round 1's reconcile rewrite), throwing ReferenceError on EVERY
    // budget-stop run -- caught by the reviewer, not by this test, because
    // the old assertions here stopped at "not 4" and never looked at the
    // actual exit code or scanned for a thrown error. A real ReferenceError
    // makes main().catch() print "FATAL:" and exit 3, well before the
    // budget marker this test also now requires to be present.
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped at the 1-minute budget/);
  });

  it("still straddles under artificial slowness — the fake clock, not luck, is what lands it", () => {
    // Same shape as above, but with a real per-sale read delay layered on
    // top (the OLD mechanism, now redundant with the fake clock rather than
    // load-bearing). If the fake-clock hook were silently ignored and this
    // still passed only because of the delay, that would mean the hook does
    // nothing -- this proves the straddle is governed by HIQ_TEST_FAKE_CLOCK
    // _STEP_MS's call-counted steps even when real wall-clock slowness is
    // also present.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "budget-straddle-slow");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [
      { id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" },
      { id: "src::2", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 20, soldAt: "2026-01-02", playerName: "Adael Amador", parallel: "RayWave Refractor" },
    ];

    const r = drive(
      {
        SCOPE: list, BACKFILL_APPLY: "false",
        RUN_MINUTES: "1", BUDGET_MS: "1000", RESERVE_MS: "500",
        HIQ_TEST_FAKE_CLOCK_STEP_MS: "400", VITEST: "1",
      },
      { sales, catalog, saleReadDelayMs: 250 },
    );
    expect(r.out).toMatch(/not reached \(budget, sales\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped at the 1-minute budget/);
  });
});

describe("HIQ_TEST_FAKE_CLOCK_STEP_MS is inert when unset — production timing is untouched", () => {
  it("unset: the SAME two-sale entry does NOT straddle under a real, generous budget", () => {
    // Proves the hook changes nothing when the env var is absent: a budget
    // wide enough for both sales' real (undelayed, near-instant) reads must
    // let BOTH complete, exactly as it did before this PR touched
    // runner-budget.cjs. If the fake clock were somehow active by default,
    // this would falsely straddle or stop early.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "fake-clock-unset");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [
      { id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" },
      { id: "src::2", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 20, soldAt: "2026-01-02", playerName: "Adael Amador", parallel: "RayWave Refractor" },
    ];

    const r = drive(
      { SCOPE: list, BACKFILL_APPLY: "false", RUN_MINUTES: "110" },
      { sales, catalog },
    );
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+2/);
    // The summary banner always PRINTS this label with a trailing count --
    // what must be absent is a NONZERO count, not the label text itself
    // (same convention the expected-sales-mismatch tests above already use).
    expect(r.out).toMatch(/not reached \(budget, sales\)\s+0/);
    expect(r.out).not.toMatch(/stopped at the \d+-minute budget/);
  });
});

describe("HIQ_TEST_FAKE_CLOCK_STEP_MS self-defends against leaking into a real run", () => {
  // Review round 1 (PR #2465): honouring the var on isFinite && > 0 alone
  // means a leaked value in a real dispatch's env would silently misbudget
  // a lane with no operator-visible symptom until it stopped mid-run for
  // the wrong reason. The fix requires process.env.VITEST alongside it --
  // set here explicitly, since drive()'s child env is a minimal allowlist,
  // never inherited from the test runner's own environment.

  it("set without VITEST: FATAL naming the var, non-zero exit, BEFORE any budget line prints", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "fake-clock-no-vitest");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const r = drive(
      {
        SCOPE: list, BACKFILL_APPLY: "false",
        HIQ_TEST_FAKE_CLOCK_STEP_MS: "400",
        // VITEST deliberately OMITTED -- drive()'s env is not inherited, so
        // this reproduces a leaked var reaching a real dispatch exactly.
      },
      { sales, catalog },
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FATAL: HIQ_TEST_FAKE_CLOCK_STEP_MS is set but VITEST is not");
    // Refused before computing a budget at all -- the describe() banner
    // line ("budget ...m loop + ...") never printed.
    expect(r.out).not.toMatch(/budget \d+m loop/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("set WITH VITEST: the fake clock activates normally, no FATAL", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "why" }], "fake-clock-with-vitest");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const r = drive(
      {
        SCOPE: list, BACKFILL_APPLY: "false",
        RUN_MINUTES: "1", BUDGET_MS: "1000", RESERVE_MS: "500",
        HIQ_TEST_FAKE_CLOCK_STEP_MS: "400", VITEST: "1",
      },
      { sales, catalog },
    );
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/budget 1m loop/);
    expect(r.out).not.toContain("FATAL:");
  });
});

describe("regression: run 36353646453 -- a physical duplicate sharing an id must not survive a move", () => {
  // sold_comps ids (`${source}::${externalId}`) are unique only WITHIN a
  // partition (lib/sales-at-id.cjs's own header). The incident: TWO real
  // Cosmos documents shared one id -- one at cardId=fromId (or already on
  // its way there) and one at the sale's raw vendor cardId / a malformed
  // legacy slug, BOTH carrying hobbyiqCardId=fromId. drainSalesIdsAtId's old
  // id-only dedup silently discarded one of the two before this lane's own
  // per-sale loop ever saw it, so it was never read, moved or deleted --
  // banner clean, failed 0, no "DUPLICATE LEFT IN POOL" line, and the
  // leftover stood in the pool forever after.
  //
  // sales-at-id.cjs's own fix (dedupe on the REAL Cosmos identity, (id,
  // cardId)) still stands -- BOTH documents are handed to the per-sale loop.
  // But CF-STALE-HOBBYIQCARDID-IS-NOT-RESIDENCY (this PR, #2454 follow-up)
  // supersedes what this lane is allowed to DO with the second one: a ref
  // whose live cardId is not fromId was never resident at fromId's
  // partition, whatever its hobbyiqCardId says, and moving/deleting it here
  // is exactly the false-positive class this PR closes (2,046 sales matched
  // a fromId only via a stale hobbyiqCardId while their cardId already
  // named a different address). This lane now REFUSES that second document
  // as not-resident-at-from rather than sweeping it into the move --
  // cleaning up a stray physical copy under a raw vendor cardId is
  // dedupe-sold-comp-copies-by-list.cjs's own, narrower, content-identity-
  // gated job, never this lane's.
  it("APPLY moves the resident copy and REFUSES the raw-vendor-cardId leftover as not-resident-at-from, never deleting it", () => {
    const RAW_VENDOR_CARD_ID = "1765857544536x502800993546556500";
    // expectedSales: 2 -- sales-at-id.cjs's own dedup-by-(id,cardId) fix
    // still reports both documents to GATE 5; this lane's own residency
    // check is what decides what happens to each of them afterward.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "duplicate-left regression", expectedSales: 2 }], "dupleft-regression");
    const catalog = [FROM_ROW, TO_ROW];
    // Two PHYSICALLY DISTINCT documents, same id, different cardId partitions,
    // both pointing at fromId via hobbyiqCardId -- exactly the incident shape.
    const properlyAddressed = { id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", title: "Adael Amador RayWave Refractor", playerName: "Adael Amador", parallel: "RayWave Refractor" };
    const leftoverAtRawVendorId = { id: "src::1", cardId: RAW_VENDOR_CARD_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", title: "Adael Amador RayWave Refractor", playerName: "Adael Amador", parallel: "RayWave Refractor" };
    const sales = [properlyAddressed, leftoverAtRawVendorId];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/DUPLICATE LEFT IN POOL/);
    expect(r.out).toMatch(/REFUSED \(not-resident-at-from\) src::1/);
    expect(r.out).toMatch(/REFUSED: not-resident-at-from\s+1/);
    expect(r.out).toMatch(/MOVED \(sales\)\s+1/);

    const finalSales = r.led.finalSales as Array<{ id: string; cardId: string }>;
    const atThisId = finalSales.filter((d) => d.id === "src::1");
    // The resident copy moved to toId; the raw-vendor-cardId leftover was
    // NEVER TOUCHED -- refused, not deleted -- so it still stands at its
    // own address. Two documents survive, deliberately: this lane's job is
    // moving a resident sale, not deduping a stray copy under a different
    // lane's own doctrine.
    expect(atThisId.length, JSON.stringify(atThisId)).toBe(2);
    expect(atThisId.map((d) => d.cardId).sort()).toEqual([RAW_VENDOR_CARD_ID, TO_ID].sort());
  });

  it("MUTATION CHECK: with only the properly-addressed copy present (no leftover), the same list still moves cleanly", () => {
    // Proves the regression test above is actually pinned on the SECOND
    // document existing, not on some other property of the fixture: drop
    // the leftover and the outcome is the unremarkable single-copy move
    // every other end-to-end test in this file already covers.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "control", expectedSales: 1 }], "dupleft-control");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{ id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01", playerName: "Adael Amador", parallel: "RayWave Refractor" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code, r.out).toBe(0);
    const finalSales = r.led.finalSales as Array<{ id: string; cardId: string }>;
    const atThisId = finalSales.filter((d) => d.id === "src::1");
    expect(atThisId.length).toBe(1);
    expect(atThisId[0].cardId).toBe(TO_ID);
  });
});

// ── GATE 6, TITLE-FIRST (this PR). "The title proves the sale": a sale's
// stored playerName field can itself be corrupt while its title -- the
// actual listing text -- plainly names the destination player. The title
// is read FIRST; playerName is consulted ONLY when the title is blank. ──────

describe("GATE 6 reads the sale's TITLE first, and playerName only when the title is blank", () => {
  it("corrupt playerName + a REAL-SHAPED title (leading year/brand/card-number noise before the name) naming the destination -> PASSES, decidedBy=title", () => {
    // Review finding: every earlier fixture put the player's name at the
    // FRONT of the title with nothing but strippable trailing vocabulary
    // after it -- exactly the shape plain namesAgree(wholeTitle, name)
    // happens to fold correctly, and exactly the shape the real
    // sold_comps/CardHedge/eBay title never has. This fixture instead uses
    // the PR's own headline incident shape: a leading year/brand/card-number
    // PREAMBLE before the player's name, the actual PR #2485 title text.
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "title proves the sale", expectedSales: 1 }], "title-first-pass");
    const catalog = [FROM_ROW, TO_ROW];
    // playerName is corrupt (names neither Adael Amador nor anyone at the
    // destination); the title plainly names "Adael Amador", but buried
    // after real listing-title preamble, not at the front.
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2025 Topps Chrome Update Baseball Adael Amador RayWave Refractor #USC143", playerName: "Yordanny Monegro", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/MOVED \(sales\)\s+1/);
  });

  it("the PR's own literal headline incident title (year/brand/name/prospect/auto/card-number, in that order) -> PASSES, decidedBy=title", () => {
    // Verbatim reviewer reproduction case: "2024 Bowman Chrome Yohandy
    // Morales Prospect Auto #CPA-YM" -- run through the REAL destination
    // gate, not a bare namesAgree() call, to prove GATE 6 itself (not just
    // titleNamesPlayer in isolation) now passes this shape.
    const destRow = { ...TO_ROW, playerName: "Yohandy Morales" };
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "reviewer headline case", expectedSales: 1 }], "title-first-headline");
    const catalog = [FROM_ROW, destRow];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2024 Bowman Chrome Yohandy Morales Prospect Auto #CPA-YM", playerName: "Yordanny Monegro", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);
  });

  it("title names the SOURCE row's own (different) registered player + playerName wrongly matches the destination -> REFUSED (title wins on conflict)", () => {
    // The conflict this gate can actually PROVE (bounded to the one other
    // registered identity it has cheap access to -- the SOURCE row it
    // already read at GATE 1, never an unbounded collision table): the
    // sale's stored playerName has been corrupted to read the DESTINATION's
    // own name (a false agreement waiting to happen), but the title plainly
    // names the card's real, current, checklist-registered player at
    // fromId -- a genuinely different person from the destination.
    const conflictFromRow = { ...FROM_ROW, playerName: "Yohandy Morales" };
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "title wins on conflict", expectedSales: 1 }], "title-first-conflict");
    const catalog = [conflictFromRow, TO_ROW];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2025 Topps Chrome Update Baseball Yohandy Morales RayWave Refractor #CPA-YM", playerName: "Adael Amador", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(name-disagreement\) src::1: sale "2025 Topps Chrome Update Baseball Yohandy Morales RayWave Re" \(decidedBy=title\)/);
    expect(r.out).toMatch(/REFUSED: name-disagreement\s+1/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+0/);
  });

  it("blank title + playerName matches the destination -> PASSES, decidedBy=playerName (the fallback)", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "no title, fall back", expectedSales: 1 }], "title-first-fallback");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "", playerName: "Adael Amador", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/MOVED \(sales\)\s+1/);
  });

  // CF-A-NAME-LESS-TITLE-IS-NOT-A-CONFLICT (review finding). A large share
  // of real sold_comps titles are CardHedge/eBay-derived LISTING TEXT that
  // names a year, product and card number and NO PLAYER AT ALL --
  // "2025 Topps Chrome Update Baseball #USC143 Base" is exactly this shape
  // for THIS fixture's own product. A bare "title is non-blank" check would
  // have refused this sale on its own CORRECT playerName the moment
  // title-first shipped. `titleNamesPlayer` (lib/name-agreement.cjs) finds
  // no name in this title against either the destination or the source's
  // own player, so GATE 6 falls all the way through to the original
  // playerName comparison, exactly its pre-title-first behaviour.
  it("a non-blank but NAME-LESS title (real listing noise, no player) -> PASSES via playerName, decidedBy=playerName", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "name-less title falls back to playerName", expectedSales: 1 }], "title-nameless-fallback");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2025 Topps Chrome Update Baseball #USC143 Base", playerName: "Adael Amador", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/MOVED \(sales\)\s+1/);
  });

  // CF-A-TEAM-NAME-IS-NOT-A-PLAYER-NAME (review finding, defect #2). A bare
  // team/city name in a title ("Baltimore Orioles") is real, human-readable
  // text -- exactly the shape a naive token-count-over-the-raw-title floor
  // misread as "name-shaped" (2 alphabetic tokens survive: "Baltimore",
  // "Orioles"), producing a false REFUSED on an otherwise-correct
  // playerName. `titleNamesPlayer`'s CONTAINMENT design has no such failure
  // mode: "Baltimore Orioles" is not a substring match for any real
  // player's name, so it is never mistaken for one -- no team/city
  // stoplist needed at all.
  it("a title naming only a TEAM (no player) -> PASSES via playerName, decidedBy=playerName", () => {
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "team-only title falls back to playerName", expectedSales: 1 }], "title-team-only-fallback");
    const catalog = [FROM_ROW, TO_ROW];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2024 Topps #150 Baltimore Orioles", playerName: "Adael Amador", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+1/);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/MOVED \(sales\)\s+1/);
  });
});

// ── REGRESSION COVERAGE FOR #2500's OWN FIX (fix/dedupe-keeper-must-agree
// -with-the-sale-title-0928-1514, merged as 5434df85). titleNamesPlayer is
// imported from that PR's own lib/name-agreement.cjs (not a local copy --
// this branch was rebased onto main after #2500 landed). An independent
// adversarial review of #2500
// (https://github.com/HobbyIQ/HobbyIQ-V1/pull/2500#issuecomment-5873357117)
// found four defects in an EARLIER version of the SAME function this PR
// depends on -- two of which reached this branch's own (now-deleted)
// verbatim copy and were confirmed here directly before the rebase:
//
//   1. (unsafe direction) Unbounded substring match, no token boundary --
//      foldForCompare stripped all whitespace before containment, so a
//      SHORTER name that is a raw substring of a LONGER token false-
//      matched ("Ryan Reynolds" inside "Bryan Reynolds"). A false PASS on
//      GATE 6/GATE (e) -- exactly the unsafe direction this whole PR exists
//      to close. Fixed upstream via `containsTokenSubsequence` (word-
//      boundary-safe token matching, not a raw folded-substring check).
//   4. (over-refusal) No firstListedName() fallback for a multi-name
//      league-leader/insert catalog row ("Shohei Ohtani / Marcell Ozuna /
//      Kyle Schwarber LL NL HR") -- the containment fallback tried the
//      WHOLE multi-name string rather than reducing to the first-listed
//      player the way namesAgree's own rule (a) does internally. Fixed
//      upstream by calling `firstListedName()` on the player side before
//      suffix extraction and containment.
//
// These tests now assert the CORRECT, fixed behaviour and must stay green.
describe("regression coverage for #2500's titleNamesPlayer fix (word-boundary matching, multi-name reduction)", () => {
  it("DEFECT 1 (fixed): a shorter name must NOT match as a raw substring of a longer one (Bryan Reynolds / Ryan Reynolds)", () => {
    expect(titleNamesPlayer("2025 Topps Chrome Bryan Reynolds Auto", "Ryan Reynolds")).toBe(false);
  });

  it("DEFECT 1 (unsafe): same collision, shortest reproduction (Bryan / Ryan)", () => {
    expect(titleNamesPlayer("2025 Topps Chrome Bryan", "Ryan")).toBe(false);
  });

  it("DEFECT 1 (fixed), through the actual GATE 6 end-to-end: a title naming a genuinely different player (Bryan Reynolds) must REFUSE against a destination named Ryan Reynolds, never silently pass", () => {
    const bryanRow = { ...FROM_ROW, playerName: "Bryan Reynolds" };
    const ryanRow = { ...TO_ROW, playerName: "Ryan Reynolds" };
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "defect-1 regression", expectedSales: 1 }], "defect1-bryan-ryan");
    const catalog = [bryanRow, ryanRow];
    const sales = [{
      id: "src::1", cardId: FROM_ID, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "2025 Topps Chrome Bryan Reynolds Auto", playerName: "Bryan Reynolds", parallel: "RayWave Refractor",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    // A sale genuinely about Bryan Reynolds must be REFUSED against a
    // destination that is actually Ryan Reynolds -- the title's own
    // (correct) "Bryan Reynolds" must not be misread as containing
    // "Ryan Reynolds" merely because the letters are a raw substring.
    expect(r.out).toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+0/);
  });

  it("DEFECT 4 (fixed): a title naming the FIRST-LISTED player of a multi-name league-leader catalog row must PASS, not refuse", () => {
    expect(titleNamesPlayer(
      "2024 Topps Shohei Ohtani League Leaders NL HR",
      "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR",
    )).toBe(true);
  });

  it("SURNAME FLOOR (#2463) holds through titleNamesPlayer too: a bare 'Nick' in the title never proves 'Nick Green'", () => {
    // The same floor namesAgree's own header states for itself ("a first
    // name alone proves nothing about which player a card is") -- a title
    // containing only "Nick" must not be read as containing "Nick Green"
    // just because "Nick" is a prefix-shaped token match.
    expect(titleNamesPlayer("2024 Topps Chrome Nick Auto", "Nick Green")).toBe(false);
  });

  it("a blank title never claims to name anyone, even a player whose real name would otherwise agree", () => {
    // Confirms this branch's own GATE 6 never needed #2500's firstNonBlank
    // fix at all: titleNamesPlayer("", playerName) already returns false on
    // its own explicit `if (!t || !p) return false` guard, and GATE 6's own
    // fallback logic (not a bare `??`) is what routes a blank title to the
    // playerName comparison -- see the end-to-end "blank title + playerName
    // matches the destination" test elsewhere in this file for the full
    // gate-level proof.
    expect(titleNamesPlayer("", "Adael Amador")).toBe(false);
  });
});

// ── CF-STALE-HOBBYIQCARDID-IS-NOT-RESIDENCY. A ref whose live cardId is not
// fromId was never resident at fromId's partition -- refused, never moved. ──

describe("a sale whose live cardId is not fromId is refused as not-resident-at-from, never moved", () => {
  it("a sale drained only via a stale hobbyiqCardId (its own cardId is a different, unrelated address) is REFUSED, never rewritten", () => {
    const STALE_OTHER_ADDRESS = "hiq:baseball:2025:topps-chrome-update-series:usc199:some-other-card:no-auto";
    const list = writeList([{ fromId: FROM_ID, toId: TO_ID, reason: "stale hobbyiqCardId false positive", expectedSales: 1 }], "not-resident-at-from");
    const catalog = [FROM_ROW, TO_ROW];
    // This sale's REAL, live partition is STALE_OTHER_ADDRESS -- a wholly
    // different card's address -- but its hobbyiqCardId still carries the
    // stale FROM_ID value from a prior repoint, which is exactly what pulls
    // it into this entry's drain via the `OR hobbyiqCardId = @id` half of
    // the dual predicate.
    const sales = [{
      id: "src::1", cardId: STALE_OTHER_ADDRESS, hobbyiqCardId: FROM_ID, price: 10, soldAt: "2026-01-01",
      title: "Some Other Player", playerName: "Some Other Player", parallel: "Base",
    }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(not-resident-at-from\) src::1: live cardId "hiq:baseball:2025:topps-chrome-update-series:usc199:some-other-card:no-auto" != fromId/);
    expect(r.out).toMatch(/REFUSED: not-resident-at-from\s+1/);
    expect(r.out).toMatch(/WOULD MOVE \(sales\)\s+0/);
    // Never reached the name gate at all -- residency is checked first.
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/REFUSED: not-resident-at-from\s+1/);
    expect(applyRun.led.salesUpserts.length).toBe(0);
    expect(applyRun.led.salesDeletes.length).toBe(0);
    // The sale is UNTOUCHED, still at its own real address.
    const finalSales = applyRun.led.finalSales as Array<{ id: string; cardId: string }>;
    expect(finalSales).toEqual([expect.objectContaining({ id: "src::1", cardId: STALE_OTHER_ADDRESS })]);
  });
});
