import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The three defects of Backfill Runner 33839532087 (bcp, SCOPE=recheck,
 * LIMIT=20, apply=true, titles="2011 Topps Chrome,2015 Bowman Chrome,2019
 * Topps Chrome,2021 Topps Chrome"). It wrote 0 rows, aborted the lane on a
 * 3-streak, and the canary acceptance -- 2011 topps-chrome isAuto=true > 1 --
 * was never tested.
 *
 *   [1/20] 2011 Topps Chrome  FAILED "Command failed: node .../ingest-checklist-csv-"
 *   [2/20] 2015 Bowman Chrome REFUSED "zero base cards (600 rows, all carry a parallel)"
 *   [3/20] 2019 Topps Chrome  FAILED, same way
 *
 * 1. CF-THE-LANE-NAME-IS-NOT-THE-SOURCE-NAME. The driver stamped
 *    source=`bcp-<date>`, which catalogAuthority classifies UNKNOWN (its
 *    CHECKLIST regex spells the site `cardpedia`/`bccp`, never `bcp`), so the
 *    ingest child refused it and exited 2. Entries 1 and 3, and every bcp and
 *    clc entry the driver has ever attempted.
 *
 * 2. CF-A-SCOPE-FILE-IS-NOT-THE-PAGE. The driver took `csvs[0]` off a raw
 *    readdirSync. Since the scraper writes one CSV per SCOPE, csvs[0] for 2015
 *    Bowman Chrome is the Prospects Light Blue Refractors parallel scope --
 *    600 rows, no base cards, because the page's base set is in the bare-stem
 *    file that sorts LAST. Entry 2.
 *
 * 3. CF-A-COMMAND-FAILED-IS-NOT-A-DIAGNOSIS. The child printed its reason on
 *    stderr; the driver threw the pipe away and reported execFileSync's own
 *    argv, truncated. That is why a one-line naming defect cost a whole
 *    dispatch to diagnose.
 *
 * These drive the COMMITTED script through a stubbed lane child and a stubbed
 * Cosmos -- never a reimplementation of the loop.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const driver = require_(script);
const { gateStagedCsv, gateStagedEntry, stagedCsvs, sourceLabelFor, LANE_SOURCE, LANE_ALIASES } = driver;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-bcp-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

function stageDir(files: Record<string, string[]>): string {
  const d = fs.mkdtempSync(path.join(tmp, "stage-"));
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), [HEADER, ...rows].join("\n") + "\n");
  }
  return d;
}

/** The real shape of the 2015 Bowman Chrome staging directory. */
function bowmanChrome2015(): string {
  const base: string[] = [], lightBlue: string[] = [], wave: string[] = [];
  for (let i = 1; i <= 50; i++) {
    base.push(`base,${i},,false,,Player ${i} Name`);
    base.push(`base,${i},Gold Refractor,false,50,Player ${i} Name`);
    // The two scopes the page routes to their OWN files: all parallel, by
    // design, because the base cards they attach to are the page's.
    lightBlue.push(`base,BCP${i},Prospects Light Blue Refractor,false,150,Player ${i} Name`);
    wave.push(`base,BCP${i},Prospects Wave Refractor,false,,Player ${i} Name`);
  }
  return stageDir({
    // Lexical order puts the two suffixed scope files BEFORE the bare stem,
    // which is the whole mechanism of the defect.
    "2015-bowman-chrome-baseball--prospects-light-blue-refractors.csv": lightBlue,
    "2015-bowman-chrome-baseball--prospects-wave-refractors.csv": wave,
    "2015-bowman-chrome-baseball.csv": base,
  });
}

// ── PIN 1: the lane stamps a source the catalog will accept ──────────────────

describe("ingest-universe-driver — the lane name is not the source name", () => {
  it("every lane stamps a source catalogAuthority classifies as checklist", () => {
    const { catalogAuthorityOf } = require_(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
    const lanes = [...new Set(Object.values(LANE_ALIASES as Record<string, string>))].filter((l) => l !== "tcdb");
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      const label = sourceLabelFor(lane, "2026-09-04");
      // THE ASSERTION THAT WAS MISSING. `bcp-2026-09-04` and `clc-2026-09-04`
      // both fail here; the ingest child refused them one fetch at a time.
      expect(`${lane} -> ${label} -> ${catalogAuthorityOf(label)}`)
        .toBe(`${lane} -> ${label} -> checklist`);
    }
  });

  it("the bcp lane keeps its wiki-family provenance, so D29/R2 still applies to its rows", () => {
    const { isBcpFamily, isDedicatedChecklist } = require_(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
    const label = sourceLabelFor("bcp", "2026-09-04");
    // A row stamped `bcp-...` would have escaped the product-filing rule as
    // well as the authority one: isBcpFamily is anchored on the site name.
    expect(isBcpFamily(label)).toBe(true);
    expect(isDedicatedChecklist(label)).toBe(false);
  });

  it("it is the SAME name the sibling end-to-end wrapper already ingests bcp under", () => {
    const sibling = fs.readFileSync(path.join(backend, "scripts", "ingest-checklists-end-to-end.cjs"), "utf8");
    expect(sibling).toContain("baseballcardpedia-ladders-");
    expect(LANE_SOURCE.bcp).toBe("baseballcardpedia-ladders");
    expect(sibling).toContain("checklistcenter-");
    expect(LANE_SOURCE.clc).toBe("checklistcenter");
  });

  it("an undeclared lane refuses rather than inventing a name", () => {
    expect(() => sourceLabelFor("nosuchlane")).toThrow(/LANE_SOURCE/);
  });
});

// ── PIN 2: a scope file is not the page ──────────────────────────────────────

describe("ingest-universe-driver — a page whose base set is in another scope is not all-parallel", () => {
  it("2015 Bowman Chrome: csvs[0] is the parallel scope, and the ENTRY still passes", () => {
    const dir = bowmanChrome2015();
    const files = stagedCsvs(dir);
    expect(files.length).toBe(3);

    // The precise defect: the first file in readdir order has zero base rows.
    const first = gateStagedCsv(files[0]);
    expect(path.basename(files[0])).toMatch(/light-blue-refractors/);
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/zero base cards/i);

    // Judged as an ENTRY, the page is fine -- the base cards are in the
    // bare-stem file, which is exactly where the page puts them.
    const entry = gateStagedEntry(files);
    expect(entry.ok).toBe(true);
    expect(entry.reason).toBeNull();
  });

  it("the entry's stats are the SUM over every scope file, not one file's", () => {
    const entry = gateStagedEntry(stagedCsvs(bowmanChrome2015()));
    // 100 base-file rows + 50 light blue + 50 wave.
    expect(entry.stats.rows).toBe(200);
    expect(entry.stats.base).toBe(50);
    // ladder/withPrintRun decide partial-vs-ingested downstream, so they must
    // describe the page: 50 Gold + 50 light blue carry runs, the 50 wave do not.
    expect(entry.stats.ladder).toBe(150);
    expect(entry.stats.withPrintRun).toBe(100);
  });

  it("a page where NO scope has a base card is still refused — the cross-join shape", () => {
    const rows: string[] = [];
    for (let i = 1; i <= 40; i++) rows.push(`base,${i},Gold Refractor,false,50,Player ${i} Name`);
    const dir = stageDir({ "a--one.csv": rows, "a--two.csv": rows });
    const entry = gateStagedEntry(stagedCsvs(dir));
    expect(entry.ok).toBe(false);
    expect(entry.reason).toMatch(/zero base cards across all 2 staged file\(s\)/i);
  });

  it("a defect that is NOT zero-base still condemns the entry, and names the file", () => {
    const good: string[] = [];
    for (let i = 1; i <= 20; i++) good.push(`base,${i},,false,,Player ${i} Name`);
    // A players-as-rungs leak in one scope file is a defect no sibling excuses.
    const dirty = [...good, "base,21,Player 3 Name,false,,Player 21 Name"];
    const dir = stageDir({ "a--dirty.csv": dirty, "a.csv": good });
    const entry = gateStagedEntry(stagedCsvs(dir));
    expect(entry.ok).toBe(false);
    expect(entry.reason).toMatch(/a--dirty\.csv:/);
    expect(entry.reason).toMatch(/player name from this same file/i);
  });

  it("stagedCsvs is sorted and complete — a re-run reads the same files in the same order", () => {
    const dir = stageDir({ "c.csv": ["base,1,,false,,A B"], "a.csv": ["base,1,,false,,A B"], "b.csv": ["base,1,,false,,A B"] });
    expect(stagedCsvs(dir).map((p) => path.basename(p))).toEqual(["a.csv", "b.csv", "c.csv"]);
  });
});

// ── PIN 3: a child failure prints the child's own words ──────────────────────
//
// Driven end to end through the COMMITTED driver: a real bcp entry whose
// ingest child fails loudly. The assertion is on what the LOG says, because
// the log is the only artifact a dispatch leaves behind -- run 33839532087
// left "Command failed: node .../ingest-checklist-csv-" and nothing else, and
// diagnosing a one-line naming defect from that cost a whole dispatch.

type EntrySpec = { setName: string; year: number };

function manifestOf(specs: EntrySpec[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      id: `bcp::http://www.baseballcardpedia.com/index.php/${s.year}_${s.setName.replace(/ /g, "_")}`,
      lane: "bcp",
      sourceRef: `http://www.baseballcardpedia.com/index.php/${s.year}_${s.setName.replace(/ /g, "_")}`,
      sport: "baseball", year: s.year, setName: s.setName, seededStatus: "partial",
    })),
    unreachable: [],
  }));
  return p;
}

/**
 * The shim: the scraper stages the REAL multi-scope shape, and the ingest
 * child fails the way it actually failed -- 40 lines of noise, then FATAL on
 * the last line, exit 2.
 */
function shimOf(opts: { ingestFails: boolean }): string {
  const p = path.join(tmp, `shim3-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const HEADER = ${JSON.stringify(HEADER)};
const INGEST_FAILS = ${opts.ingestFails ? "true" : "false"};

const cp = require("node:child_process");
cp.execFileSync = function (file, args, options) {
  const titleArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titleArg) {
    const outDir = String((args || []).find((a) => String(a).startsWith("--outDir="))).slice("--outDir=".length);
    fs.mkdirSync(outDir, { recursive: true });
    const base = [HEADER], lightBlue = [HEADER], wave = [HEADER];
    for (let i = 1; i <= 50; i++) {
      base.push("base," + i + ",,false,,Player " + i + " Name");
      base.push("base," + i + ",Gold Refractor,false,50,Player " + i + " Name");
      lightBlue.push("base,BCP" + i + ",Prospects Light Blue Refractor,false,150,Player " + i + " Name");
      wave.push("base,BCP" + i + ",Prospects Wave Refractor,false,,Player " + i + " Name");
    }
    fs.writeFileSync(path.join(outDir, "2015-bowman-chrome-baseball--prospects-light-blue-refractors.csv"), lightBlue.join("\\n") + "\\n");
    fs.writeFileSync(path.join(outDir, "2015-bowman-chrome-baseball--prospects-wave-refractors.csv"), wave.join("\\n") + "\\n");
    fs.writeFileSync(path.join(outDir, "2015-bowman-chrome-baseball.csv"), base.join("\\n") + "\\n");
    return "";
  }
  // The ingest child.
  if (INGEST_FAILS) {
    let noise = "";
    for (let i = 1; i <= 40; i++) noise += "noise line " + i + "\\n";
    const e = new Error("Command failed: " + String(file) + " " + (args || []).join(" "));
    e.status = 2;
    e.stdout = "";
    e.stderr = noise + 'FATAL: SOURCE "bcp-2026-09-04" classifies as unknown, not checklist.\\n';
    throw e;
  }
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
            upsert: async (doc) => {
              const all = JSON.parse(fs.readFileSync(process.env.CONTROL_SINK, "utf8"));
              all.push(doc);
              fs.writeFileSync(process.env.CONTROL_SINK, JSON.stringify(all));
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
  if (String(request).includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

function drive(opts: { ingestFails: boolean }) {
  const sink = path.join(tmp, `sink3-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  const specs = [{ setName: "Bowman Chrome", year: 2015 }];
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shimOf(opts))}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifestOf(specs),
        CONTROL_SINK: sink,
        SOURCES: "bcp", SCOPE: "recheck", LIMIT: "1", BACKFILL_APPLY: "true",
        WORKDIR: path.join(tmp, `wd3-${Math.random().toString(36).slice(2)}`),
        RUN_MINUTES: "60",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, control: JSON.parse(fs.readFileSync(sink, "utf8")) };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? ""), control: JSON.parse(fs.readFileSync(sink, "utf8")) };
  }
}

describe("ingest-universe-driver — a failed child's stderr reaches the log", () => {
  it("the log carries the child's LAST stderr line, never a bare 'Command failed'", () => {
    const r = drive({ ingestFails: true });

    // THE ASSERTION THAT WAS MISSING. This is the exact string the dispatch
    // needed and did not get.
    expect(r.out).toMatch(/classifies as unknown, not checklist/);
    expect(r.out).toMatch(/exit 2/);
    // And it names the script, so the reader knows which child spoke.
    expect(r.out).toMatch(/ingest-checklist-csv-to-catalog\.cjs/);

    // The verdict recorded in the control doc carries it too -- the log is
    // ephemeral, the control doc is what a later triage reads.
    const doc = r.control.find((d: any) => String(d.entryId).includes("Bowman_Chrome"));
    expect(doc).toBeTruthy();
    expect(doc.status).toBe("failed");
    expect(String(doc.reason)).toMatch(/classifies as unknown/);
  });

  it("it is the TAIL that survives: the diagnosis is the last line, after 40 lines of noise", () => {
    const r = drive({ ingestFails: true });
    // The noise must be trimmed to CHILD_STDERR_LINES, so the early lines are
    // gone while the diagnosis stays. Keeping the HEAD would have kept
    // "noise line 1" and lost the FATAL.
    expect(r.out).not.toMatch(/noise line 1/);
    expect(r.out).toMatch(/classifies as unknown/);
  });

  it("the whole page ingests once the child is happy — three scope files, one entry", () => {
    const r = drive({ ingestFails: false });
    // The multi-scope staging is reported, not silently reduced to csvs[0].
    expect(r.out).toMatch(/3 staged scope files/);
    expect(r.out).toMatch(/prospects-light-blue-refractors\.csv/);
    expect(r.out).toMatch(/2015-bowman-chrome-baseball\.csv/);
    // And the entry is NOT refused as all-parallel.
    expect(r.out).not.toMatch(/zero base cards/);
    const doc = r.control.find((d: any) => String(d.entryId).includes("Bowman_Chrome"));
    expect(["ingested", "partial"]).toContain(doc.status);
  });
});
