/**
 * heal-sold-comp-hobbyiqcardid-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for
 * a sale whose cardId already carries the CORRECT checklist partition
 * address but whose hobbyiqCardId is STALE, still pointing at a retired
 * address (PR #2485 finding, 2026-09-28). This lane PATCHES hobbyiqCardId
 * in place -- the sale never changes partition -- gated per entry on the
 * live hobbyiqCardId matching the list's own expectedStaleHobbyiqCardId,
 * toHobbyiqCardId equaling cardId, the cardId's own card_catalog row being
 * checklist-grade, and namesAgree against that row's playerName -- TITLE
 * FIRST (follow-up PR, mirrors repoint-sales-by-list.cjs's own GATE 6): the
 * sale's title is read before its (possibly corrupt) playerName field, and
 * wins on a real conflict.
 *
 * Modeled on dedupeSoldCompCopiesByList.test.ts's own shape: the lane is
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

const lane = join(__dirname, "..", "scripts", "heal-sold-comp-hobbyiqcardid-by-list.cjs");
const backend = join(__dirname, "..");
const runner = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");

const LIST_PATH = join(
  __dirname, "..", "data", "sold-comp-hobbyiqcardid-heals",
  "2026-09-28-cpa-2024-bowman-chrome-stale-hobbyiqcardid.json",
);

type Entry = {
  saleId: string; cardId: string; expectedStaleHobbyiqCardId: string; toHobbyiqCardId: string;
};
type ListDoc = { forLane: string; entries: Entry[]; finding?: string; census?: unknown };

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree -- its dist/ requires live
// inside main(), exactly as every sibling list lane does it.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean; why?: string; saleId?: string; cardId?: string;
    expectedStaleHobbyiqCardId?: string; toHobbyiqCardId?: string;
  };
};

// ── the runner contract ──────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    // Line-ending agnostic: the checkout is CRLF on Windows and LF in CI.
    expect(readFileSync(runner, "utf8")).toMatch(/^ {10}- heal-sold-comp-hobbyiqcardid-by-list\r?$/m);
  });

  it("rides the existing SCOPE passthrough -- no new workflow_dispatch input", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
    // GitHub caps workflow_dispatch at 25 inputs and 24 are used. A new one
    // here would be the input that broke the cap.
    expect(yml).not.toContain("heal_list:");
    expect(yml).not.toContain("hobbyiqcardid_list:");
  });

  it("and BACKFILL_APPLY is what arms it, not APPLY", () => {
    expect(readFileSync(runner, "utf8")).toMatch(/BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply/);
    expect(readFileSync(lane, "utf8")).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
  });

  it("has a relaunch step modeled on dedupe-sold-comp-copies-by-list's own block", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toContain("inputs.script == 'heal-sold-comp-hobbyiqcardid-by-list'");
    expect(yml).toContain("uses: ./.github/actions/relaunch-on-marker");
    expect(yml).toMatch(
      /gh workflow run backfill-runner\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f script=heal-sold-comp-hobbyiqcardid-by-list -f apply="\$\{\{ inputs\.apply \}\}" -f scope="\$\{\{ inputs\.scope \}\}"/,
    );
  });

  it("the shared relaunch action exists and is not itself edited by this change", () => {
    const action = join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(existsSync(action)).toBe(true);
  });

  it("the upload-artifact name carries no raw scope (no colon risk) -- keyed on apply/run_id only", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toContain(
      "name: heal-sold-comp-hobbyiqcardid-by-list-${{ inputs.apply == true && 'apply' || 'report' }}-${{ github.run_id }}",
    );
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
  const SALE_ID = "cardsight::7f92af3bddc61b38fc6ab6df";
  const CARD_ID = "hiq:baseball:2024:bowman:cpa-aca:refractor:auto:num-499";
  const STALE = "hiq:baseball:2024:bowman-chrome:cpa-aca:blue-refractor:auto:num-499";

  it("accepts a well-formed entry", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID });
    expect(r.ok).toBe(true);
    expect(r.cardId).toBe(CARD_ID);
    expect(r.toHobbyiqCardId).toBe(CARD_ID);
  });

  it("refuses a missing saleId", () => {
    const r = L.classifyEntry({ cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no saleId");
  });

  it("refuses a missing cardId", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no cardId");
  });

  it("refuses cardId that is not a hiq slug", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: "cardsight::123", expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses a missing expectedStaleHobbyiqCardId", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: CARD_ID, toHobbyiqCardId: CARD_ID });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no expectedStaleHobbyiqCardId");
  });

  it("refuses a missing toHobbyiqCardId", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no toHobbyiqCardId");
  });

  it("refuses toHobbyiqCardId that is not a hiq slug", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: "not-a-slug" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses toHobbyiqCardId != cardId -- this lane only ALIGNS identity to the partition address", () => {
    const r = L.classifyEntry({ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: "hiq:baseball:2024:bowman:cpa-other:base:auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("toHobbyiqCardId does not equal cardId");
  });
});

// ── the committed list loads through the real loader and is well-formed ─

describe("the committed list", () => {
  it("exists and loads as JSON", () => {
    expect(existsSync(LIST_PATH)).toBe(true);
    expect(() => readList(LIST_PATH)).not.toThrow();
  });

  it("is shaped the way this lane requires", () => {
    const doc = readList(LIST_PATH);
    expect(doc.forLane).toBe("heal-sold-comp-hobbyiqcardid-by-list");
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
    for (const e of doc.entries) {
      const c = L.classifyEntry(e);
      expect(c.ok, `entry failed classifyEntry: ${JSON.stringify(e)} -- ${c.why}`).toBe(true);
    }
  });

  it("carries a header census with generatedAt and finding", () => {
    const doc = readList(LIST_PATH);
    expect(doc.finding).toBeTruthy();
    expect((doc as unknown as { generatedAt?: string }).generatedAt).toBeTruthy();
    expect(doc.census).toBeTruthy();
  });

  it("every toHobbyiqCardId equals its own cardId", () => {
    const doc = readList(LIST_PATH);
    for (const e of doc.entries) expect(e.toHobbyiqCardId).toBe(e.cardId);
  });

  it("has no duplicate saleId -- each sale named once", () => {
    const doc = readList(LIST_PATH);
    const seen = new Set<string>();
    for (const e of doc.entries) {
      expect(seen.has(e.saleId), `duplicate entry for ${e.saleId}`).toBe(false);
      seen.add(e.saleId);
    }
  });

  it("includes the two named docs from the task (Allan Castro, Arjun Nimmala)", () => {
    const doc = readList(LIST_PATH);
    const ids = new Set(doc.entries.map((e) => e.saleId));
    expect(ids.has("cardsight::7f92af3bddc61b38fc6ab6df")).toBe(true);
    expect(ids.has("cardsight::6d03ef2658a5ab8828ad59d4")).toBe(true);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(LIST_PATH);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });
});

// ── REPORT writes nothing ─────────────────────────────────────────────────

describe("REPORT computes the same gates APPLY would, and writes nothing", () => {
  it("the patch call is the ONLY branch point between REPORT and APPLY", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("if (!APPLY) {");
    expect(src).toContain("WOULD PATCH hobbyiqCardId");
    // Every gate above the `if (!APPLY)` branch runs identically regardless
    // of mode -- pinned by counting the patch call site occurs exactly
    // once, inside the APPLY-only branch.
    expect((src.match(/pool\.item\(saleId, cardId\)\.patch\(/g) ?? []).length).toBe(1);
  });

  it("never relocates or deletes -- a PATCH only, the sale's partition never changes", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).not.toContain("relocateSoldComp(");
    expect(src).not.toContain(".delete(");
    expect(src).not.toContain("items.upsert(");
  });

  it("stamps hobbyiqCardIdBefore, the shared reversible-patch shadow convention", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('{ op: "add", path: "/hobbyiqCardIdBefore"');
    expect(src).toContain('{ op: "set", path: "/hobbyiqCardId"');
  });

  it("patches under an IfMatch access condition on the sale's own etag", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('accessCondition: { type: "IfMatch", condition: sale._etag }');
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

// ── end-to-end against an in-memory Cosmos fake ──────────────────────────

function assertNoUncaughtError(r: { code: number; out: string }) {
  expect(r.out).not.toMatch(/FATAL:/);
  expect(r.out).not.toMatch(/ReferenceError/);
  expect(r.out).not.toMatch(/TypeError/);
}

const tmp = mkdtempSync(join(os.tmpdir(), "heal-sold-comp-hobbyiqcardid-by-list-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SALE_ID = "cardsight::7f92af3bddc61b38fc6ab6df";
const CARD_ID = "hiq:baseball:2024:bowman:cpa-aca:refractor:auto:num-499";
const STALE = "hiq:baseball:2024:bowman-chrome:cpa-aca:blue-refractor:auto:num-499";

const CATALOG_ROW = { id: CARD_ID, cardId: CARD_ID, source: "checklistinsider-2026-08-27", playerName: "Allan Castro", setKey: "bowman", year: 2024 };
const SALE = { id: SALE_ID, cardId: CARD_ID, hobbyiqCardId: STALE, source: "cardsight", title: "Allan Castro Blue Refractor Auto", playerName: "Allan Castro", price: 40, soldAt: "2026-02-01", _etag: '"etag-1"' };

function writeList(entries: Entry[], tag: string): string {
  const p = join(tmp, `list-${tag}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ forLane: "heal-sold-comp-hobbyiqcardid-by-list", entries }));
  return p;
}

function shim(opts: {
  sales?: Array<Record<string, unknown>>;
  catalog?: Array<Record<string, unknown>>;
  /** When true, the patch call throws a 412 (etag precondition failed) --
   *  simulating the sale having changed since this entry's own read. */
  throwOnPatch412?: boolean;
} = {}): { requirePath: string; ledger: string } {
  const ledger = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const sales = opts.sales ?? [];
  const catalog = opts.catalog ?? [];
  const throwOnPatch412 = opts.throwOnPatch412 ?? false;

  writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const THROW_ON_PATCH_412 = ${JSON.stringify(throwOnPatch412)};

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
};
const led = { patches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify({ ...led, finalSales: [...state.sales.values()] }));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function precondition() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }

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
    patch: async (ops, options) => {
      if (THROW_ON_PATCH_412) throw precondition();
      const key = salesKey(id, pk);
      const d = state.sales.get(key);
      if (!d) throw notFound();
      for (const op of ops) {
        const field = op.path.replace(/^\\//, "");
        d[field] = op.value;
      }
      state.sales.set(key, d);
      led.patches.push({ id, pk, ops });
      save();
      return {};
    },
  }),
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
  it("REPORT computes the patch and writes nothing; APPLY patches exactly the one sale", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "happy-path");
    const catalog = [CATALOG_ROW];
    const sales = [SALE];

    const reportRun = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(reportRun);
    expect(reportRun.code).toBe(0);
    expect(reportRun.out).toMatch(/WOULD PATCH\s+1/);
    expect(reportRun.led.patches.length).toBe(0);
    expect(reportRun.led.finalSales[0].hobbyiqCardId).toBe(STALE);

    const applyRun = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(applyRun);
    expect(applyRun.code).toBe(0);
    expect(applyRun.out).toMatch(/PATCHED\s+1/);
    expect(applyRun.led.patches.length).toBe(1);
    expect(applyRun.led.finalSales[0].hobbyiqCardId).toBe(CARD_ID);
    expect(applyRun.led.finalSales[0].hobbyiqCardIdBefore).toBe(STALE);
    // The sale's cardId (its partition) never changed -- a PATCH, not a move.
    expect(applyRun.led.finalSales[0].cardId).toBe(CARD_ID);
  });

  it("REFUSES (gone-since-read) when the sale is absent at (saleId, cardId), in both modes", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "gone-since-read");
    const catalog = [CATALOG_ROW];
    const sales: Array<Record<string, unknown>> = []; // no document at all

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(gone-since-read\)/);
    expect(r.out).toMatch(/gone-since-read \(benign\)\s+1/);
    expect(r.led.patches.length).toBe(0);
  });

  it("REFUSES (stale-mismatch) when the live hobbyiqCardId disagrees with the list's own expectedStaleHobbyiqCardId", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "stale-mismatch");
    const catalog = [CATALOG_ROW];
    // The sale's hobbyiqCardId already reads something else -- another lane
    // (or this one's own earlier idempotent pass) already touched it.
    const sales = [{ ...SALE, hobbyiqCardId: CARD_ID }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(stale-mismatch\)/);
    expect(r.out).toMatch(/stale-mismatch\s+1/);
    expect(r.led.patches.length).toBe(0);
  });

  it("REFUSES (to-differs-from-cardid) -- classifyEntry catches this at parse time as MALFORMED", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: "hiq:baseball:2024:bowman:cpa-other:base:auto" }], "to-differs");
    const catalog = [CATALOG_ROW];
    const sales = [SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/MALFORMED/);
    expect(r.led.patches.length).toBe(0);
  });

  it("REFUSES (destination-not-checklist-grade) when cardId has no card_catalog row", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "no-catalog-row");
    const catalog: Array<Record<string, unknown>> = [];
    const sales = [SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(destination-not-checklist-grade\)/);
    expect(r.led.patches.length).toBe(0);
  });

  it("REFUSES (destination-not-checklist-grade) when cardId's catalog row is vendor/derived, never checklist", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "not-checklist-grade");
    const catalog = [{ ...CATALOG_ROW, source: "cardhedge" }];
    const sales = [SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(destination-not-checklist-grade\)/);
    expect(r.led.patches.length).toBe(0);
  });

  it("REFUSES (name-disagreement) when the sale's own title/playerName disagrees with the checklist row", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "name-disagreement");
    const catalog = [CATALOG_ROW];
    const sales = [{ ...SALE, playerName: "Someone Else Entirely", title: "Someone Else Entirely Blue Refractor Auto" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.out).toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.led.patches.length).toBe(0);
  });

  // ── GATE (e), TITLE-FIRST (follow-up PR). "The title proves the sale":
  // the same doctrine repoint-sales-by-list.cjs's GATE 6 carries. ─────────

  it("PASSES, decidedBy=title, when playerName is corrupt but the title plainly names the checklist row's player", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "title-first-pass");
    const catalog = [CATALOG_ROW];
    // playerName is corrupt (names nobody real); the title plainly names
    // "Allan Castro", the checklist row's own playerName.
    const sales = [{ ...SALE, playerName: "Yordanny Monegro", title: "Allan Castro Blue Refractor Auto" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/PATCHED\s+1/);
    expect(r.led.patches.length).toBe(1);
  });

  it("REFUSES (title wins on conflict) when the title names a DIFFERENT player even though playerName matches the checklist row", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "title-first-conflict");
    const catalog = [CATALOG_ROW];
    // playerName agrees with the destination ("Allan Castro"), but the
    // title plainly names a different player -- the title wins.
    const sales = [{ ...SALE, playerName: "Allan Castro", title: "Someone Else Entirely Blue Refractor Auto" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "false" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(name-disagreement\): sale "Someone Else Entirely Blue Refractor Auto" \(decidedBy=title\)/);
    expect(r.led.patches.length).toBe(0);
  });

  it("PASSES, decidedBy=playerName, when the title is blank (the fallback)", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "title-first-fallback");
    const catalog = [CATALOG_ROW];
    const sales = [{ ...SALE, playerName: "Allan Castro", title: "" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/PATCHED\s+1/);
    expect(r.led.patches.length).toBe(1);
  });

  // CF-A-NAME-LESS-TITLE-IS-NOT-A-CONFLICT (review finding). Real
  // CardHedge/eBay titles frequently name a year, product and card number
  // with NO PLAYER AT ALL -- this lane's own real committed list (2,022
  // sales) is CardHedge/eBay/cardsight-sourced. A bare "title is non-blank"
  // check would have refused this sale on its own CORRECT playerName the
  // moment title-first shipped; lib/title-has-name-tokens.cjs strips the
  // destination's own setKey/sport/cardNumber (parsed off `cardId` here)
  // before counting, so this title correctly reduces to zero name tokens.
  it("PASSES, decidedBy=playerName, when the title is non-blank but NAME-LESS (real listing noise, no player)", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "title-nameless-fallback");
    const catalog = [CATALOG_ROW];
    const sales = [{ ...SALE, playerName: "Allan Castro", title: "2024 Bowman Baseball #CPA-ACA Refractor Auto" }];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REFUSED \(name-disagreement\)/);
    expect(r.out).toMatch(/PATCHED\s+1/);
    expect(r.led.patches.length).toBe(1);
  });

  it("FAILS (etag-conflict, REFUSED) when the patch is rejected with a 412 -- never retried, never written", () => {
    const list = writeList([{ saleId: SALE_ID, cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID }], "etag-conflict");
    const catalog = [CATALOG_ROW];
    const sales = [SALE];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog, throwOnPatch412: true });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED \(etag-conflict\)/);
    expect(r.out).toMatch(/etag-conflict\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.patches.length).toBe(0);
    expect(r.led.finalSales[0].hobbyiqCardId).toBe(STALE);
  });

  it("reconciles cleanly across a mixed batch of outcomes -- patched, stale-mismatch, name-disagreement, gone", () => {
    const A = { saleId: "src::A", cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID };
    const B_CARD = "hiq:baseball:2024:bowman:cpa-an:base:auto";
    const B = { saleId: "src::B", cardId: B_CARD, expectedStaleHobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-an:base:auto", toHobbyiqCardId: B_CARD };
    const C_CARD = "hiq:baseball:2024:bowman:cpa-an:refractor:auto:num-499";
    const C = { saleId: "src::C", cardId: C_CARD, expectedStaleHobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-an:refractor:auto:num-499", toHobbyiqCardId: C_CARD };
    const D = { saleId: "src::D", cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID };
    const list = writeList([A, B, C, D], "mixed-batch");
    const catalog = [
      CATALOG_ROW,
      { id: B_CARD, cardId: B_CARD, source: "checklistinsider-2026-08-27", playerName: "Arjun Nimmala" },
      { id: C_CARD, cardId: C_CARD, source: "checklistinsider-2026-08-27", playerName: "Arjun Nimmala" },
    ];
    const sales = [
      { ...SALE, id: "src::A", cardId: CARD_ID, hobbyiqCardId: STALE },
      // B: already healed by an earlier pass -- stale-mismatch.
      { ...SALE, id: "src::B", cardId: B_CARD, hobbyiqCardId: B_CARD, playerName: "Arjun Nimmala" },
      // C: name disagreement.
      { ...SALE, id: "src::C", cardId: C_CARD, hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-an:refractor:auto:num-499", playerName: "A Totally Different Person" },
      // D: gone (no document at all) -- see below, D is omitted entirely.
    ];

    const r = drive({ SCOPE: list, BACKFILL_APPLY: "true" }, { sales, catalog });
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PATCHED\s+1/);
    expect(r.out).toMatch(/stale-mismatch\s+1/);
    expect(r.out).toMatch(/name-disagreement\s+1/);
    expect(r.out).toMatch(/gone-since-read \(benign\)\s+1/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.patches.length).toBe(1);
  });
});

describe("end-to-end: a budget stop reconciles exactly, never double-counted", () => {
  it("stops before the reserve, prints the marker, and the reconcile still balances", () => {
    const A = { saleId: "src::A", cardId: CARD_ID, expectedStaleHobbyiqCardId: STALE, toHobbyiqCardId: CARD_ID };
    const B_CARD = "hiq:baseball:2024:bowman:cpa-an:base:auto";
    const B = { saleId: "src::B", cardId: B_CARD, expectedStaleHobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-an:base:auto", toHobbyiqCardId: B_CARD };
    const list = writeList([A, B], "budget-stop");
    const catalog = [CATALOG_ROW, { id: B_CARD, cardId: B_CARD, source: "checklistinsider-2026-08-27", playerName: "Arjun Nimmala" }];
    const sales = [
      { ...SALE, id: "src::A", cardId: CARD_ID, hobbyiqCardId: STALE },
      { ...SALE, id: "src::B", cardId: B_CARD, hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-an:base:auto", playerName: "Arjun Nimmala" },
    ];

    const r = drive(
      { SCOPE: list, BACKFILL_APPLY: "false", RUN_MINUTES: "1", BUDGET_MS: "0", RESERVE_MS: "1" },
      { sales, catalog },
    );
    assertNoUncaughtError(r);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped at the 1-minute budget/);
    expect(r.out).not.toMatch(/RECONCILE MISMATCH/);
    expect(r.led.patches.length).toBe(0);
  });
});
