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
  /**
   * WAS six greps for the source text of RUNNER_SCOPE_VARS, of the delete loop
   * and of the spawn's `env:` -- every one of them satisfiable by dead code and
   * every one of them one rename away from a meaningless red. The behavioural
   * mutation test below already kills an emptied RUNNER_SCOPE_VARS (verified),
   * so this states the part it does NOT cover: the FULL list, and that the
   * scrub is a deletion rather than an allowlist that lets a var through by
   * another door.
   */
  it("every runner fan-out name is stripped — the whole list, not just the three that bit", () => {
    // The names the workflow exports for its OWN fan-out, which mean something
    // entirely different one level down. Asked of the module, so a rename of
    // the constant moves this pin with it instead of reddening it.
    const { RUNNER_SCOPE_VARS } = require_(script);
    expect(new Set(RUNNER_SCOPE_VARS))
      .toEqual(new Set(["LIMIT", "SLOT", "SLOTS", "SCAN_LIMIT", "MAX_ROWS"]));
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
//
// REWRITTEN 2026-09-04. This pin used to assert four of its five rules by
// GREPPING THE DRIVER'S SOURCE TEXT -- `emptyAtSource = true` inside a sliced
// `case "bcp"` block, the `e?.emptyAtSource ? EMPTY_STATUS` ternary, and the
// three reconciliation sums. The driver has been refactored six times since
// (#1741, #1742, #1743, #1746, #1749, #1750), and a slice keyed on
// `src.indexOf('case "bcp": {')` in particular breaks on any restructuring of
// the acquisition switch without a single behaviour having changed. Each rule
// now DRIVES the committed script -- the real bcp acquisition through a stubbed
// scraper that says what the wiki says, and the real reconciliation banner.

const { streakAfter, EMPTY_STATUS, SYSTEMIC_FAILURE_STREAK, setKeyFor } = require_(script);

/**
 * The same shim the other driver pins use, narrowed to what this one needs: the
 * bcp scraper stages nothing and prints ONE of its two nothings on stdout while
 * exiting 0. Which of the two it printed is the whole question.
 *
 *   "base ok (109) but 0 rungs — nothing new to add"  -> the page is fine and
 *      has nothing more to give. EMPTY: a verdict about the SET.
 *   "" (says nothing)                                 -> a broken pipe. FAILED.
 */
function driveBcp(says: string[], env: Record<string, string> = {}, opts: { unreachable?: number } = {}) {
  const sink = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  const behaviour: Record<string, string> = {};
  const entries = says.map((s, i) => ({
    title: `${1990 + i}_Oddball_${i}`, says: s, year: 1990 + i, setName: `Oddball ${i}`,
  }));
  for (const e of entries) behaviour[e.title] = e.says;

  const shim = path.join(tmp, `shim3-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(shim, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const SAYS = ${JSON.stringify(behaviour)};
const cp = require("node:child_process");
cp.execFileSync = function (file, args, options) {
  const titleArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titleArg) {
    const title = String(titleArg).slice("--titles=".length);
    const outDir = String((args || []).find((a) => String(a).startsWith("--outDir="))).slice("--outDir=".length);
    // Stage NOTHING, and say what the wiki said. Exit 0 either way.
    fs.mkdirSync(outDir, { recursive: true });
    return SAYS[title] === undefined ? "" : SAYS[title];
  }
  return "";
};
const CONTROL = [];
const RECON = [];
const stub = {
  CosmosClient: class {
    database() {
      return { container(name) {
        return {
          item(id) { return { read: async () => ({ resource: null }) }; },
          items: {
            query() { return { fetchAll: async () => ({ resources: name === "card_catalog" ? [40] : [] }) }; },
            upsert: async (doc) => {
              CONTROL.push(doc);
              fs.writeFileSync(process.env.CONTROL_SINK, JSON.stringify(CONTROL));
              return { resource: doc };
            },
          },
        };
      } };
    }
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  // Capture what the driver hands the reconciliation reporter, so "skipped,
  // never written" is read off the CALL rather than grepped for.
  if (String(request).includes("writeReconciliation")) {
    return { reportWrites: (r) => { RECON.push(r); fs.writeFileSync(process.env.RECON_SINK, JSON.stringify(RECON)); } };
  }
  return realLoad.apply(this, arguments);
};
`);

  const manifest = path.join(tmp, `man3-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(manifest, JSON.stringify({
    entries: entries.map((e) => ({
      id: `bcp::http://www.baseballcardpedia.com/index.php/${e.title}`,
      lane: "bcp",
      sourceRef: `http://www.baseballcardpedia.com/index.php/${e.title}`,
      sport: "baseball", year: e.year, setName: e.setName, seededStatus: "partial",
    })),
    // Entries the manifest's own 404 probe already settled. Report mode counts
    // these in `verdicts.unreachable` and NEVER in `inspected`, which is the
    // only way to make that half of `accounted` load-bearing.
    unreachable: entries.slice(0, opts.unreachable ?? 0).map((e) => ({
      sport: "baseball", year: e.year, setKey: setKeyFor({ setName: e.setName }),
      lane: "bcp", sourceRef: `http://www.baseballcardpedia.com/index.php/${e.title}`,
    })),
  }));
  const reconSink = path.join(tmp, `recon-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(reconSink, "[]");

  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifest,
        CONTROL_SINK: sink,
        RECON_SINK: reconSink,
        SOURCES: "bcp", SCOPE: "recheck", BACKFILL_APPLY: "true",
        WORKDIR: path.join(tmp, `wd3-${Math.random().toString(36).slice(2)}`),
        RUN_MINUTES: "60",
        LIMIT: String(entries.length),
        BCP_TITLES: entries.map((e) => `${e.year} ${e.setName}`).join(","),
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  return {
    code, out,
    control: JSON.parse(fs.readFileSync(sink, "utf8")) as any[],
    recon: JSON.parse(fs.readFileSync(reconSink, "utf8")) as any[],
  };
}

const NOTHING_TO_ADD = "base ok (109) but 0 rungs — nothing new to add";

describe("ingest-universe-driver — a bcp page with nothing left to give is settled", () => {
  it("DRIVEN: 'nothing new to add' is EMPTY; silence is FAILED", () => {
    // WAS: two greps -- `/nothing new to add/` anywhere in the file, and
    // `/emptyAtSource = true/` inside a slice of the `case "bcp"` block. Both
    // could be satisfied by a dead code path, and the slice breaks on any
    // restructuring of the switch.
    //
    // MUTATION RED: drop `e.emptyAtSource = true` from the bcp "nothing new to
    // add" throw and the first entry's verdict becomes `failed`.
    const r = driveBcp([NOTHING_TO_ADD, ""]);
    const [settled, broken] = ["1990_Oddball_0", "1991_Oddball_1"]
      .map((t) => r.control.find((d) => String(d.entryId).includes(t)));
    expect(settled.status).toBe(EMPTY_STATUS);
    expect(String(settled.reason)).toMatch(/no rungs|nothing/i);
    // The other nothing keeps its vote: a broken pipe is not a settled set.
    expect(broken.status).toBe("failed");
    expect(String(broken.reason)).toMatch(/no CSV/i);
  });

  it("DRIVEN: a whole lane of empty sets never trips the tripwire — RED on the old code", () => {
    // WAS: greps for the `e?.emptyAtSource ? EMPTY_STATUS` ternary and for the
    // literal `STREAK_STATUSES = new Set(["failed", "unreachable"])`. This
    // drives the consequence: more empties in a row than the streak allows.
    //
    // MUTATION RED: add EMPTY_STATUS to STREAK_STATUSES, or route emptyAtSource
    // to "failed", and the lane aborts before the last two entries.
    const says = Array.from({ length: SYSTEMIC_FAILURE_STREAK + 2 }, () => NOTHING_TO_ADD);
    const r = driveBcp(says);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(0);
    expect(r.control.length).toBe(says.length);
    expect(r.control.every((d) => d.status === EMPTY_STATUS)).toBe(true);
  });

  it("the streak arithmetic itself, called rather than grepped", () => {
    expect(streakAfter(0, { status: "failed" })).toBe(1);
    expect(streakAfter(1, { status: "unreachable" })).toBe(2);
    let s = 0;
    for (let i = 0; i < SYSTEMIC_FAILURE_STREAK + 2; i++) s = streakAfter(s, { status: EMPTY_STATUS });
    expect(s).toBeLessThan(SYSTEMIC_FAILURE_STREAK);
    // `empty` does not RESET either -- a real outage interrupted by one empty
    // set still trips on its own run.
    expect(streakAfter(2, { status: EMPTY_STATUS })).toBe(2);
  });

  it("DRIVEN: an empty entry reconciles as accounted for, in BOTH modes", () => {
    // WAS: three greps for the shapes of `written`, `accounted` and `skipped`.
    // Those are arithmetic, and arithmetic has an answer -- so ask for it. A
    // lane of nothing but empties must reconcile YES, or the runner refuses to
    // relaunch a lane that did nothing wrong.
    //
    // MUTATION RED: drop `+ verdicts[EMPTY_STATUS]` from `written` and APPLY
    // reconciles NO; drop it from `accounted` and report mode reconciles NO.
    const apply = driveBcp([NOTHING_TO_ADD, NOTHING_TO_ADD]);
    expect(apply.out).toMatch(/RECONCILED\s+yes/);
    expect(apply.out).not.toMatch(/RECONCILED\s+NO/);

    // Report mode never ACQUIRES, so it can never reach an `empty` verdict of
    // its own; the entry it settles without inspecting is the UNREACHABLE one,
    // and that is the term of `accounted` this half exercises. Run
    // 33841276495 printed "intended 20 / inspected 19 / unreachable 1" and
    // RECONCILED NO, exiting 4 -- the runner refused to relaunch a lane that
    // had done nothing wrong.
    //
    // MUTATION RED: drop `+ verdicts.unreachable` from `accounted` and this
    // reconciles NO again.
    const report = driveBcp([NOTHING_TO_ADD, NOTHING_TO_ADD, NOTHING_TO_ADD],
      { BACKFILL_APPLY: "" }, { unreachable: 1 });
    expect(report.out).toMatch(/REPORT ONLY/);
    expect(report.out).toMatch(/unreachable\s+1/);
    expect(report.out).toMatch(/inspected\s+2/);
    expect(report.out).toMatch(/RECONCILED\s+yes/);
    expect(report.out).not.toMatch(/RECONCILED\s+NO/);
  });

  it("DRIVEN: an empty entry is SKIPPED in the write reconciliation, never written or failed", () => {
    // It landed no rows and claims none. Read off the reportWrites CALL, which
    // is the thing the ops reconciler actually consumes.
    //
    // MUTATION RED: move verdicts[EMPTY_STATUS] from `skipped` into `written`
    // or into `failed` and this reads the wrong bucket.
    const r = driveBcp([NOTHING_TO_ADD, NOTHING_TO_ADD]);
    expect(r.recon.length).toBe(1);
    const [rep] = r.recon;
    expect(rep.intended).toBe(2);
    expect(rep.written).toBe(0);
    expect(rep.failed).toBe(0);
    expect(rep.skipped).toBe(2);
  });
});
