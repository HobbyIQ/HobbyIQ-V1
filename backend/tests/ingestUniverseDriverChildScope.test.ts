import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The three defects of Backfill Runner 33845791358 (bcp, SCOPE=recheck,
 * LIMIT=20, SLOT=0, SLOTS=16, apply=true, titles="2011 Topps Chrome,2015
 * Bowman Chrome,2019 Topps Chrome,2021 Topps Chrome").
 *
 * The run looked almost healthy -- 4 entries INGESTED, a green reconciliation,
 * "rows created 6 (verified by catalog read, not claimed)" -- and it was a
 * near-total loss. It created ELEVEN catalog rows, every one isAuto=false and
 * every one card #1, #2 or #3, from an autograph re-scrape whose staged CSVs
 * held 290 autographs for 2011 Topps Chrome alone.
 *
 *   [1/20] 2011 Topps Chrome  "INGESTED — 3 rows created"     <- of 2,980 staged
 *   [2/20] 2015 Bowman Chrome "INGESTED — 0 rows created"     <- 1 of 3 files seen
 *   [7/20] 1990 Bowman        "REFUSED — zero base cards ... all carry a parallel"
 *   [5,6]  1990 Wit / Bazooka "FAILED — bcp scrape produced no CSV"
 *                             -> 3-streak -> ABORTED THE LANE
 *
 * 1. CF-THE-RUNNER-FANOUT-IS-NOT-THE-CHILD'S. `run()` handed the ingest child
 *    `{...process.env}`, and the workflow exports LIMIT/SLOT/SLOTS for its own
 *    fan-out. One level down those names mean rows-written and staged-file
 *    shard: SLOTS=16 kept 1 file in 16, LIMIT=20 stopped after 20 rows. The
 *    driver's own before/after catalog read then reported the truncation as a
 *    successful ingest.
 *
 * 2. CF-THE-LITERAL-BASE-IS-A-BASE-CARD. The gate counted a base card as an
 *    EMPTY parallel column, but the bcp scraper states the base set with the
 *    literal "Base". 1990_Bowman staged 1,058 correct rows (529 Base + 529
 *    Tiffany) and was refused as having none.
 *
 * 3. CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE, the bcp side. A
 *    page with a base set but no rungs stages no CSV and says so on stdout
 *    while exiting 0. That read as `failed`, so two 1990 oddballs with nothing
 *    to give became two thirds of the streak that took a working lane down.
 *    #1717 ruled exactly this for tcgdex on the same day, so the wiki raises
 *    that same `emptyAtSource` flag rather than a parallel status of its own.
 *
 * These drive the COMMITTED scripts -- the real gate, the real driver loop
 * through a stubbed lane child and a stubbed Cosmos -- never a copy of them.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const ingestChild = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");
const require_ = createRequire(import.meta.url);
const { gateStagedCsv, gateStagedEntry, stagedCsvs } = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-scope-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

function stageDir(files: Record<string, string[]>): string {
  const d = fs.mkdtempSync(path.join(tmp, "stage-"));
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), [HEADER, ...rows].join("\n") + "\n");
  }
  return d;
}

// ── PIN 1: the runner's fan-out never reaches the child ──────────────────────

describe("ingest-universe-driver — a driver's own scope is not its child's scope", () => {
  it("LIMIT, SLOT and SLOTS are stripped from the child environment", () => {
    const src = fs.readFileSync(script, "utf8");
    // The names the workflow exports for its OWN fan-out, which mean something
    // entirely different one level down.
    expect(src).toMatch(/RUNNER_SCOPE_VARS\s*=\s*\[[^\]]*"LIMIT"[^\]]*\]/);
    expect(src).toMatch(/RUNNER_SCOPE_VARS\s*=\s*\[[^\]]*"SLOT"[^\]]*\]/);
    expect(src).toMatch(/RUNNER_SCOPE_VARS\s*=\s*\[[^\]]*"SLOTS"[^\]]*\]/);
    // And they are DELETED, not merely absent from an allowlist.
    expect(src).toMatch(/for \(const k of RUNNER_SCOPE_VARS\).*delete childEnv\[k\]/s);
    // The spawn must use the scrubbed env, not a fresh inline merge.
    expect(src).toMatch(/env: childEnv,/);
    expect(src).not.toMatch(/env: \{ \.\.\.process\.env, \.\.\.env \},/);
  });

  /**
   * The mutation test: this is the assertion that goes RED on the old code.
   * The driver is run with the exact environment of run 33845791358 and the
   * ingest child is replaced by one that REPORTS the LIMIT/SLOT/SLOTS it was
   * given. Reading them back as undefined is the whole fix.
   */
  it("drives the committed driver: the child inherits no bound and no shard", () => {
    const seen = path.join(tmp, `childenv-${Math.random().toString(36).slice(2)}.json`);
    const shim = path.join(tmp, `shimA-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(shim, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const HEADER = ${JSON.stringify(HEADER)};
const cp = require("node:child_process");
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, options) {
  const titleArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titleArg) {
    const outDir = String((args || []).find((a) => String(a).startsWith("--outDir="))).slice("--outDir=".length);
    fs.mkdirSync(outDir, { recursive: true });
    const base = [HEADER];
    for (let i = 1; i <= 50; i++) {
      base.push("base," + i + ",Base,false,,Player " + i + " Name");
      base.push("base," + i + ",Gold Refractor,false,50,Player " + i + " Name");
    }
    fs.writeFileSync(path.join(outDir, "2011-topps-chrome-baseball.csv"), base.join("\\n") + "\\n");
    return "";
  }
  // The ingest child: record exactly what scope it was handed.
  const e = (options && options.env) || {};
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    LIMIT: e.LIMIT === undefined ? null : e.LIMIT,
    SLOT: e.SLOT === undefined ? null : e.SLOT,
    SLOTS: e.SLOTS === undefined ? null : e.SLOTS,
    DIR: e.DIR === undefined ? null : e.DIR,
    BACKFILL_APPLY: e.BACKFILL_APPLY === undefined ? null : e.BACKFILL_APPLY,
  }));
  return "";
};
const stub = {
  CosmosClient: class {
    database() {
      return { container(name) {
        return {
          item(id) { return { read: async () => ({ resource: null }) }; },
          items: {
            query() { return { fetchAll: async () => ({ resources: name === "card_catalog" ? [40] : [] }) }; },
            upsert: async (doc) => ({ resource: doc }),
          },
        };
      } };
    }
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  if (String(request).includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
    const manifest = path.join(tmp, `man-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(manifest, JSON.stringify({
      entries: [{
        id: "bcp::http://www.baseballcardpedia.com/index.php/2011_Topps_Chrome",
        lane: "bcp",
        sourceRef: "http://www.baseballcardpedia.com/index.php/2011_Topps_Chrome",
        sport: "baseball", year: 2011, setName: "Topps Chrome", seededStatus: "partial",
      }],
      unreachable: [],
    }));

    try {
      execFileSync(process.execPath, [script], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          MANIFEST_PATH: manifest,
          SOURCES: "bcp", SCOPE: "recheck", BACKFILL_APPLY: "true",
          WORKDIR: path.join(tmp, `wdA-${Math.random().toString(36).slice(2)}`),
          RUN_MINUTES: "60",
          // THE EXACT ENVIRONMENT OF RUN 33845791358.
          LIMIT: "20", SLOT: "0", SLOTS: "16",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* the verdict is the recorded env, not the exit code */ }

    const got = JSON.parse(fs.readFileSync(seen, "utf8"));
    // RED on the old code: it read LIMIT="20", SLOT="0", SLOTS="16".
    expect(got.LIMIT).toBeNull();
    expect(got.SLOT).toBeNull();
    expect(got.SLOTS).toBeNull();
    // The scope the driver DOES mean to hand over still arrives.
    expect(got.BACKFILL_APPLY).toBe("true");
    expect(String(got.DIR ?? "")).not.toBe("");
  });

  /**
   * The consequence, measured on the REAL ingest child rather than argued
   * about: with SLOTS=16 in the environment it takes one staged file in
   * sixteen, and the file it keeps for 2015 Bowman Chrome is a parallel scope.
   */
  it("the real ingest child, handed SLOTS=16, sees one of three staged files", { timeout: 60000 }, () => {
    const dir = stageDir({
      "2015-bowman-chrome-baseball--prospects-light-blue-refractors.csv":
        Array.from({ length: 5 }, (_, i) => `base,BCP${i + 1},Prospects Light Blue Refractor,false,150,Player ${i + 1} Name`),
      "2015-bowman-chrome-baseball--prospects-wave-refractors.csv":
        Array.from({ length: 5 }, (_, i) => `base,BCP${i + 1},Prospects Wave Refractor,false,,Player ${i + 1} Name`),
      "2015-bowman-chrome-baseball.csv":
        Array.from({ length: 5 }, (_, i) => `base,${i + 1},Base,false,,Player ${i + 1} Name`),
    });
    // The shard banner is printed before the child touches Cosmos, so the run
    // is capped rather than left to exhaust the SDK's retry budget against a
    // stub endpoint. Whatever it printed by then is the evidence.
    let out = "";
    try {
      out = execFileSync(process.execPath, [ingestChild], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
          DIR: dir, SOURCE: "baseballcardpedia-ladders-2026-09-04",
          SLOT: "0", SLOTS: "16",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
    } catch (e: any) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
    // The child says the denominator out loud -- that banner is why this is
    // diagnosable at all, and it names the loss precisely.
    expect(out).toMatch(/SHARD 0\/16 — this run owns 1 of 3 files/);
  });
});

// ── PIN 2: the literal "Base" is a base card ─────────────────────────────────

describe("ingest-universe-driver — a page that says Base out loud still has a base set", () => {
  /** 1990_Bowman as the committed scraper actually stages it: 529 x {Base, Tiffany}. */
  function bowman1990(): string[] {
    const rows: string[] = [];
    for (let i = 1; i <= 529; i++) {
      rows.push(`base,${i},Base,false,,Player ${i} Name`);
      rows.push(`base,${i},Tiffany,false,,Player ${i} Name`);
    }
    return rows;
  }

  it("1990 Bowman is not 'zero base cards' — RED on the old gate", () => {
    const dir = stageDir({ "1990-bowman-baseball.csv": bowman1990() });
    const r = gateStagedCsv(path.join(dir, "1990-bowman-baseball.csv"));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    // 529 Base rows are base cards; only Tiffany is a rung.
    expect(r.stats.rows).toBe(1058);
    expect(r.stats.base).toBe(529);
    expect(r.stats.ladder).toBe(529);
  });

  it("a BLANK parallel is still a base card — #1324 is untouched", () => {
    // "blank means unknown, never Base" governs what the INGEST writes; the
    // gate's floor has always counted those rows as cards, and still does.
    const rows = Array.from({ length: 30 }, (_, i) => `base,${i + 1},,false,,Player ${i + 1} Name`);
    const dir = stageDir({ "a.csv": rows });
    const r = gateStagedCsv(path.join(dir, "a.csv"));
    expect(r.ok).toBe(true);
    expect(r.stats.base).toBe(30);
    expect(r.stats.ladder).toBe(0);
  });

  it("a REAL cross-join is still refused — the rule keeps its teeth", () => {
    // No base rows by either spelling: this is the shape the rule exists for.
    const rows = Array.from({ length: 40 }, (_, i) => `base,${i + 1},Gold Refractor,false,50,Player ${i + 1} Name`);
    const dir = stageDir({ "a.csv": rows });
    const r = gateStagedCsv(path.join(dir, "a.csv"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zero base cards/i);
  });

  it("'Base' is not a substring match — 'Base Refractor' stays a rung", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => `base,${i + 1},Base,false,,Player ${i + 1} Name`),
      ...Array.from({ length: 10 }, (_, i) => `base,${i + 1},Base Refractor,false,50,Player ${i + 1} Name`),
    ];
    const dir = stageDir({ "a.csv": rows });
    const r = gateStagedCsv(path.join(dir, "a.csv"));
    expect(r.stats.base).toBe(10);
    expect(r.stats.ladder).toBe(10);
    expect(r.stats.withPrintRun).toBe(10);
  });

  it("the ladder statistics that decide partial-vs-ingested are unchanged", () => {
    // A page mixing both spellings: withPrintRun must describe the RUNGS only,
    // because a zero there is what marks an entry `partial`.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => `base,${i + 1},Base,false,,Player ${i + 1} Name`),
      ...Array.from({ length: 10 }, (_, i) => `base,${i + 1},,false,,Player ${i + 1} Name`),
      ...Array.from({ length: 10 }, (_, i) => `base,${i + 1},Gold Refractor,false,50,Player ${i + 1} Name`),
    ];
    const dir = stageDir({ "a.csv": rows });
    const r = gateStagedCsv(path.join(dir, "a.csv"));
    expect(r.stats.base).toBe(20);
    expect(r.stats.ladder).toBe(10);
    expect(r.stats.withPrintRun).toBe(10);
  });
});

// ── PIN 3: a page the wiki carries no rungs for is settled, not broken ─────

describe("ingest-universe-driver — a bcp page with nothing left to give is settled", () => {
  it("the bcp lane distinguishes 'no rungs' from a broken acquisition", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/nothing new to add/);
    // It raises #1717's flag rather than inventing a parallel status: "the
    // source answered, and its answer is that it has nothing here" is ONE
    // concept whether the source is tcgdex or the wiki.
    const lane = src.slice(src.indexOf('case "bcp": {'), src.indexOf('case "beckett": {'));
    expect(lane).toMatch(/emptyAtSource = true/);
  });

  it("that flag routes to EMPTY_STATUS, which the tripwire excludes — RED on the old code", () => {
    const src = fs.readFileSync(script, "utf8");
    // The dispatcher maps the flag to the empty status...
    expect(src).toMatch(/e\?\.emptyAtSource \? EMPTY_STATUS/);
    // ...and the streak counts only genuine failure and unreachability, so a
    // run of harmless oddballs cannot take a working lane down.
    expect(src).toMatch(/STREAK_STATUSES = new Set\(\["failed", "unreachable"\]\)/);
    // The arithmetic itself, not a grep for it. It used to be inline in the run
    // loop and this pin matched that literal line; it is now the exported
    // streakAfter, so the pin CALLS it -- a behavioural assert cannot rot the
    // way a text match does when the code is refactored underneath it.
    const { streakAfter, EMPTY_STATUS: EMPTY, SYSTEMIC_FAILURE_STREAK: N } = require_(script);
    expect(streakAfter(0, { status: "failed" })).toBe(1);
    expect(streakAfter(1, { status: "unreachable" })).toBe(2);
    // A run of harmless oddballs cannot take a working lane down.
    let s2 = 0;
    for (let i = 0; i < N + 2; i++) s2 = streakAfter(s2, { status: EMPTY });
    expect(s2).toBeLessThan(N);
    // (was a text match on the same inline line; the behavioural asserts above
    // cover it, including that `empty` does not RESET either -- so a real
    // outage interrupted by one empty set still trips on its own run.)
    expect(streakAfter(2, { status: EMPTY })).toBe(2);
  });

  it("it reconciles as an accounted entry, in both modes", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/const written = [^;]*verdicts\[EMPTY_STATUS\]/);
    expect(src).toMatch(/const accounted = APPLY \? written : [^;]*verdicts\[EMPTY_STATUS\]/);
    // And it is SKIPPED, never written: it landed no rows and claims none.
    expect(src).toMatch(/skipped: [^,]*verdicts\[EMPTY_STATUS\]/);
  });
});
