import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-THE-SCC-APPLY-PATH-WAS-NEVER-DRIVEN (2026-09-04).
 *
 * Backfill Runner 33848115955 -- the FIRST apply of the sportscardchecklist
 * lane (script=ingest-universe-driver, sources=sportscardchecklist, apply=true,
 * limit=3) -- failed all three entries with
 *
 *     [1/3] sportscardchecklist/1979-80 O-Pee-Chee Hockey
 *           FAILED - The "path" argument must be of type string. Received undefined
 *
 * and then tripped the 3-streak systemic abort with 0 rows created. The REPORT
 * run for the very same three, 33847474466, was clean, and said
 *
 *     would drive: fetchSportsCardChecklist.cjs --url <sourceRef> (direct-URL lane)
 *
 * on every line. Two defects, both pinned here, and neither is about scraping:
 *
 *  1. THE LANE RETURNED THE WRONG KEY. #1710 wrote `return { csvPath }` --
 *     singular -- where the caller and all six other lanes speak `csvPaths`.
 *     gateStagedEntry's Array.isArray fallback wrapped the `undefined` into
 *     `[undefined]` and fs.readFileSync was handed it. The CSV had been fetched
 *     and staged perfectly; one character threw the whole lane away.
 *
 *  2. THE REPORT COULD NOT SEE IT. Report mode printed its plan from a
 *     hardcoded object literal 500 lines from the switch that runs, so the
 *     rehearsal described a pipe whose apply path had never executed once.
 *
 * These drive the COMMITTED driver against the COMMITTED fetcher -- the fetcher
 * really parses the real 1979-80 O-Pee-Chee page bytes (the 144 KB fixture, the
 * live set-12229 trimmed to its card headers) through its own --html offline
 * mode. Only the network and Cosmos are stubbed. So a green here means the
 * driver drove the fetcher, staged <stem>.csv beside <stem>.manifest.json,
 * passed the cleanliness gate on 396 cards, and reached the ingest child.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const { planFor, acquireStaged, ACQUIRE_LANES, SYSTEMIC_FAILURE_STREAK } = require_(script);

const FIXTURE = path.join(
  backend, "tests", "fixtures", "sportscardchecklist",
  "1979-80-o-pee-chee-hockey.trimmed.html",
);
const SET_URL = "https://www.sportscardchecklist.com/set-12229/1979-80-o-pee-chee-hockey-trading-card-checklist";
/** The published count for set-12229, the same number sportsCardChecklistLane.test.ts pins. */
const OPC_CARDS = 396;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-e2e-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * `copies` entries, all set-12229. One is the end-to-end proof; the streak pin
 * needs SYSTEMIC_FAILURE_STREAK of them to reach the tripwire, and repeating the
 * same set keeps the fixture the only page in play.
 */
function manifestOf(copies = 1): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  const entries = [];
  for (let i = 0; i < copies; i++) {
    entries.push({
      id: `sportscardchecklist::${SET_URL}${i ? `#${i}` : ""}`,
      lane: "sportscardchecklist",
      sourceRef: SET_URL,
      sport: "hockey",
      year: 1979,
      setName: `1979-80 O-Pee-Chee Hockey${i ? ` (${i})` : ""}`,
      setKey: "o-pee-chee",
      seededStatus: "missing",
    });
  }
  fs.writeFileSync(p, JSON.stringify({ entries, unreachable: [] }));
  return p;
}

/**
 * The shim replaces exactly two things: the NETWORK (the fetcher's --url is
 * rewritten to --html <fixture>, so the committed parser runs on real page
 * bytes) and COSMOS. The ingest child is recorded rather than run -- it is the
 * next process in the pipe and its own suites cover it; what is under test here
 * is whether the driver ever reaches it with a real staged file.
 */
function shimOf(opts: { dropPath?: boolean } = {}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const DROP_PATH = ${opts.dropPath ? "true" : "false"};
const FIXTURE = ${JSON.stringify(FIXTURE)};

const realExecFileSync = cp.execFileSync;
cp.execFileSync = function (file, args, options) {
  const a = (args || []).map(String);
  const scriptArg = a[0] || "";

  // -- the SCC fetcher: run it for real, offline --
  if (scriptArg.includes("fetchSportsCardChecklist")) {
    const rewritten = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "--url") { rewritten.push("--html", FIXTURE); i++; continue; }
      rewritten.push(a[i]);
    }
    // MUTATION: strip --out, so the fetcher stages nothing and the driver is
    // left holding a path that was never written. That is the shape run
    // 33848115955 was in, and the gate must REFUSE rather than throw on it.
    if (DROP_PATH) {
      const j = rewritten.indexOf("--out");
      if (j !== -1) rewritten.splice(j, 2);
    }
    const said = realExecFileSync.call(this, file, rewritten, Object.assign({}, options, { encoding: "utf8" }));
    fs.appendFileSync(process.env.CHILD_SINK, JSON.stringify({ child: "fetchSportsCardChecklist.cjs", args: rewritten }) + "\\n");
    return said;
  }

  // -- the ingest child: recorded, not run --
  //
  // The staged directory is SNAPSHOTTED here rather than inspected after the
  // run, because the driver sweeps it (fs.rmSync) once the entry has a verdict.
  // This is the only moment the staged files exist, and it is also the exact
  // moment that matters: what the ingest child is handed.
  const dir = (options && options.env && options.env.DIR) || null;
  let staged = null;
  let csvText = null;
  if (dir) {
    try {
      staged = fs.readdirSync(dir);
      const csv = staged.filter((n) => n.endsWith(".csv"));
      if (csv.length === 1) csvText = fs.readFileSync(path.join(dir, csv[0]), "utf8");
    } catch (e) { staged = "unreadable: " + e.code; }
  }
  fs.appendFileSync(process.env.CHILD_SINK, JSON.stringify({
    child: path.basename(scriptArg),
    dir,
    staged,
    csvText,
    source: (options && options.env && options.env.SOURCE) || null,
    apply: (options && options.env && options.env.BACKFILL_APPLY) || null,
  }) + "\\n");
  return "";
};

// -- Cosmos --
const CONTROL = [];
let catalogReads = 0;
const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          return {
            item() { return { read: async () => ({ resource: null }) }; },
            items: {
              query() {
                return { fetchAll: async () => {
                  // countCatalogRows: 0 before the ingest, ${OPC_CARDS} after,
                  // so "verify by read" sees the rows the ingest would land.
                  if (name === "card_catalog") return { resources: [catalogReads++ === 0 ? 0 : ${OPC_CARDS}] };
                  return { resources: [] };
                } };
              },
              upsert: async (doc) => {
                CONTROL.push(doc);
                fs.writeFileSync(process.env.CONTROL_SINK, JSON.stringify(CONTROL));
                return { resource: doc };
              },
            },
          };
        },
      };
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

function drive(env: Record<string, string> = {}, opts: { dropPath?: boolean; entries?: number } = {}) {
  const control = path.join(tmp, `control-${Math.random().toString(36).slice(2)}.json`);
  const children = path.join(tmp, `children-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(control, "[]");
  fs.writeFileSync(children, "");
  const workdir = path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`);
  const common: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    NODE_OPTIONS: `--require ${JSON.stringify(shimOf(opts))}`,
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
    MANIFEST_PATH: manifestOf(opts.entries ?? 1),
    CONTROL_SINK: control,
    CHILD_SINK: children,
    SOURCES: "sportscardchecklist",
    WORKDIR: workdir,
    RUN_MINUTES: "60",
    LIMIT: "1",
    ...env,
  };
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [script], {
      cwd: backend, env: common, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  return {
    code, out, workdir,
    control: JSON.parse(fs.readFileSync(control, "utf8")),
    children: fs.readFileSync(children, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

/** The ingest child's own record of what it was handed, snapshotted before the driver swept the dir. */
const ingestOf = (r: { children: any[] }) =>
  r.children.find((c: any) => String(c.child).includes("ingest-checklist-csv-to-catalog"));

// -- PIN 1: the apply path drives the real fetcher, end to end ----------------

describe("ingest-universe-driver - the sportscardchecklist APPLY path reaches the ingest child", () => {
  const r = drive({ BACKFILL_APPLY: "true" });

  it("does not throw the undefined-path error that killed run 33848115955", () => {
    expect(r.out).not.toMatch(/must be of type string/i);
    expect(r.out).not.toMatch(/Received undefined/i);
  });

  it("stages <stem>.csv beside <stem>.manifest.json where the ingest reads them", () => {
    const staged: string[] = ingestOf(r).staged;
    const csv = staged.filter((n) => n.endsWith(".csv"));
    expect(csv).toHaveLength(1);
    const stem = csv[0].replace(/[.]csv$/, "");
    // The sidecar carries product identity; without it the ingest cannot key
    // the rows, and it must sit on the SAME stem the CSV does.
    expect(staged).toContain(`${stem}.manifest.json`);
  });

  it(`parses set-12229 to its published ${OPC_CARDS} cards`, () => {
    const lines = String(ingestOf(r).csvText)
      .split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
    expect(lines.length - 1).toBe(OPC_CARDS); // minus the header
  });

  it("passes the cleanliness gate - no REFUSED, no FAILED, no abort", () => {
    expect(r.out).not.toMatch(/REFUSED/);
    expect(r.out).not.toMatch(/FAILED/);
    expect(r.out).not.toMatch(/SYSTEMIC ABORT/);
  });

  it("drives the ingest child at the staged directory, in apply, with the lane's source stamp", () => {
    const ingest = ingestOf(r);
    expect(ingest).toBeTruthy();
    expect(ingest.apply).toBe("true");
    expect(String(ingest.source)).toMatch(/^sportscardchecklist-\d{4}-\d{2}-\d{2}$/);
    // The DIR it is pointed at is the one the CSV was staged into.
    expect(ingest.dir).toBeTruthy();
    expect(ingest.staged.some((n: string) => n.endsWith(".csv"))).toBe(true);
  });

  it("records a verdict and reconciles, exit 0", () => {
    expect(r.control).toHaveLength(1);
    expect(["ingested", "partial"]).toContain(r.control[0].status);
    expect(r.out).toMatch(/RECONCILED\s+yes/i);
    expect(r.code).toBe(0);
  });
});

// -- PIN 2: THE MUTATION. Drop the staged path and this goes red. -------------

describe("ingest-universe-driver - MUTATION: the staged path goes missing", () => {
  const r = drive({ BACKFILL_APPLY: "true" }, { dropPath: true });

  it("refuses the entry with a named reason instead of an undefined-path throw", () => {
    // The bug's own signature must NOT come back: an absent staged file is a
    // GATE REFUSAL naming the file, never fs.readFileSync(undefined).
    expect(r.out).not.toMatch(/Received undefined/i);
    expect(r.out).toMatch(/REFUSED|FAILED/);
  });

  it("never reaches the ingest child with nothing staged", () => {
    const ingest = ingestOf(r);
    expect(ingest).toBeFalsy();
  });
});

// -- PIN 3: the report plan and the apply path cannot diverge again -----------

describe("ingest-universe-driver - one function builds the plan and the apply", () => {
  it("every lane acquireEntry can dispatch has a plan (the load-time assert)", () => {
    for (const lane of ACQUIRE_LANES) {
      expect(planFor({ lane, sourceRef: "" }), `lane ${lane} has no plan`).toBeTruthy();
    }
  });

  it("the plan names the script the apply actually invokes", () => {
    // The exact divergence of 2026-09-04: the report named
    // fetchSportsCardChecklist.cjs and the apply path had never run at all.
    expect(planFor({ lane: "sportscardchecklist" })).toMatch(/fetchSportsCardChecklist\.cjs/);
    const r = drive({ BACKFILL_APPLY: "true" });
    const fetched = r.children.find((c: any) => String(c.child).includes("fetchSportsCardChecklist"));
    expect(fetched, "the plan names a fetcher the apply never invoked").toBeTruthy();
  });

  it("report mode prints that same sentence, never 'undefined'", () => {
    const r = drive({ BACKFILL_APPLY: "false" });
    expect(r.out).toMatch(/would drive: fetchSportsCardChecklist\.cjs/);
    expect(r.out).not.toMatch(/would drive: undefined/);
    expect(r.code).toBe(0);
  });

  it("acquireStaged refuses a lane whose return shape is wrong, by name", () => {
    // The literal defect: `return { csvPath }` where the caller reads csvPaths.
    // An unknown lane is the nearest reachable case of "acquireEntry did not
    // hand back a csvPaths array"; both land in acquireStaged rather than in
    // fs.readFileSync five frames down.
    expect(() => acquireStaged({ lane: "nosuchlane" }, tmp)).toThrow(/no acquisition machinery/);
  });
});

// -- PIN 4: a systemic abort must not print the relaunch's budget marker ------

describe("ingest-universe-driver - an aborted lane never re-dispatches itself", () => {
  it("suppresses the budget marker the workflow's relaunch step greps for", () => {
    const r = drive(
      { BACKFILL_APPLY: "true", LIMIT: String(SYSTEMIC_FAILURE_STREAK) },
      { dropPath: true, entries: SYSTEMIC_FAILURE_STREAK },
    );
    expect(r.out).toMatch(/SYSTEMIC ABORT/);
    // backfill-runner.yml relaunches iff /tmp/backfill.log matches
    // "stopped at the .*budget". An aborted lane must not emit it, or the
    // failure re-dispatches itself straight back into the same wall.
    expect(r.out).not.toMatch(/stopped at the .*budget/);
    expect(r.out).toMatch(/NOT printing the budget marker/);
  });
});
