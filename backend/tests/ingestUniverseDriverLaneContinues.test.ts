import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-REFUSED-ENTRY-IS-NOT-A-BROKEN-LANE (2026-09-04).
 *
 * Backfill Runner 33837346045 (bcp, SCOPE=recheck, LIMIT=20, apply=true) died on
 * its FIRST entry -- "[1/20] bcp/Baseball Wit — FAILED — bcp scrape produced no
 * CSV", then "Process completed with exit code 3" -- with 2,637 eligible and
 * universe_entries_done=0. Two separate defects, both pinned here.
 *
 * These drive the COMMITTED script through a stubbed lane child and a stubbed
 * Cosmos, never a reimplementation of the loop: the assertions are about what
 * the real driver does with a refusal.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const { cosmosSafeId, controlId, orderQueue, SYSTEMIC_FAILURE_STREAK } = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── the harness ──────────────────────────────────────────────────────────────
//
// The driver shells out to the lane child with execFileSync and talks to Cosmos
// through @azure/cosmos. Both are replaced by a shim injected with NODE_OPTIONS
// --require, so the script under test is the committed file, unmodified: the
// shim intercepts the module boundary, not the logic.

type EntrySpec = { setName: string; year: number; yields: "csv" | "nothing" | "throw" };

function manifestOf(specs: EntrySpec[], lane = "bcp"): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      // The id form that broke: it embeds the whole URL, slashes and all.
      id: `${lane}::http://www.baseballcardpedia.com/index.php/${s.year}_${s.setName.replace(/ /g, "_")}`,
      lane,
      sourceRef: `http://www.baseballcardpedia.com/index.php/${s.year}_${s.setName.replace(/ /g, "_")}`,
      sport: "baseball",
      year: s.year,
      setName: s.setName,
      seededStatus: "partial",
    })),
    unreachable: [],
  }));
  return p;
}

function shimOf(specs: EntrySpec[], opts: { failControlWrites?: boolean } = {}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const behaviour: Record<string, string> = {};
  for (const s of specs) behaviour[`${s.year}_${s.setName.replace(/ /g, "_")}`] = s.yields;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const BEHAVIOUR = ${JSON.stringify(behaviour)};
const FAIL_CONTROL = ${opts.failControlWrites ? "true" : "false"};
const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

// A clean staged CSV: base cards plus a ladder carrying print runs, so the
// cleanliness gate passes and the verdict turns on the ACQUISITION, which is
// what these pins are about.
function cleanCsv() {
  const rows = [HEADER];
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",,false,,Player " + i + " Name");
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",Gold Refractor,false,/50,Player " + i + " Name");
  return rows.join("\\n") + "\\n";
}

// ── the lane child ──
const cp = require("node:child_process");
const realExecFileSync = cp.execFileSync;
cp.execFileSync = function (file, args, options) {
  const joined = (args || []).join(" ");
  const titleArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titleArg) {
    const title = String(titleArg).slice("--titles=".length);
    const outArg = (args || []).find((a) => String(a).startsWith("--outDir="));
    const outDir = String(outArg).slice("--outDir=".length);
    const mode = BEHAVIOUR[title] || "csv";
    if (mode === "throw") { const e = new Error("fetch failed ENOTFOUND baseballcardpedia.com"); throw e; }
    if (mode === "csv") { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, title + ".csv"), cleanCsv()); }
    // "nothing": the scraper exits 0 having written no CSV -- the Baseball Wit
    // shape (base cards, zero rungs). The driver must see the empty directory.
    return "";
  }
  // The ingest child. It lands nothing here; the catalog stub below reports the
  // rows instead, because these pins are about the LOOP, not the ingest.
  if (String(file).includes("node") || true) return "";
  return realExecFileSync.apply(this, arguments);
};

// ── Cosmos ──
const CONTROL = [];
const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          return {
            item(id) {
              return { read: async () => { if (String(id).includes("/")) { const e = new Error("Illegal characters ['/', '\\\\\\\\', '#'] cannot be used in Resource ID"); throw e; } return { resource: null }; } };
            },
            items: {
              query() { return { fetchAll: async () => ({ resources: name === "card_catalog" ? [40] : [] }) }; },
              upsert: async (doc) => {
                if (String(doc.id).includes("/")) throw new Error("Illegal characters ['/', '\\\\\\\\', '#'] cannot be used in Resource ID");
                if (FAIL_CONTROL) throw new Error("stubbed control-write failure");
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
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@azure/cosmos") return stub;
  // The reconciliation reporter lives in dist/, which a test run has not built.
  if (String(request).includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

function drive(specs: EntrySpec[], env: Record<string, string> = {}, opts: { failControlWrites?: boolean } = {}) {
  const sink = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  const shim = shimOf(specs, opts);
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifestOf(specs),
        CONTROL_SINK: sink,
        SOURCES: "bcp",
        SCOPE: "recheck",
        WORKDIR: path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`),
        RUN_MINUTES: "60",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, control: JSON.parse(fs.readFileSync(sink, "utf8")) };
  } catch (e: any) {
    return {
      code: e.status as number,
      out: String(e.stdout ?? "") + String(e.stderr ?? ""),
      control: JSON.parse(fs.readFileSync(sink, "utf8")),
    };
  }
}

// ── PIN 1: one refused entry is a verdict, not the end of the lane ───────────

describe("ingest-universe-driver — a refused entry is recorded and the lane continues", () => {
  it("entry 1 yields no CSV: the verdict is recorded, entries 2-3 are processed, exit 0", () => {
    // The exact shape of run 33837346045: the FIRST entry is a page whose
    // scraper writes nothing (1990 Baseball Wit -- base cards, zero rungs).
    const r = drive([
      { setName: "Baseball Wit", year: 1990, yields: "nothing" },
      { setName: "Topps Chrome", year: 2011, yields: "csv" },
      { setName: "Bowman Chrome", year: 2015, yields: "csv" },
    ], { LIMIT: "3", BACKFILL_APPLY: "true", BCP_TITLES: "1990 Baseball Wit,2011 Topps Chrome,2015 Bowman Chrome" });

    // The lane did not abort on entry 1.
    expect(r.out).toMatch(/\[1\/3\][\s\S]*Baseball Wit/);
    expect(r.out).toMatch(/\[2\/3\]/);
    expect(r.out).toMatch(/\[3\/3\]/);
    expect(r.code).toBe(0);

    // The refusal is a VERDICT on the entry, in the control doc -- the thing
    // that was missing entirely: prod held 0 bcp control docs after the failure.
    const wit = r.control.find((d: any) => String(d.entryId).includes("Baseball_Wit"));
    expect(wit).toBeTruthy();
    expect(wit.status).toBe("failed");
    expect(String(wit.reason)).toMatch(/no CSV/i);

    // And the two good entries were driven and verdicted too.
    expect(r.control.length).toBe(3);
    expect(r.control.filter((d: any) => d.status === "ingested" || d.status === "partial").length).toBe(2);
  });

  it("the refusal is LOGGED with its reason, never a silent skip", () => {
    const r = drive([
      { setName: "Baseball Wit", year: 1990, yields: "nothing" },
      { setName: "Topps Chrome", year: 2011, yields: "csv" },
    ], { LIMIT: "2", BACKFILL_APPLY: "true", BCP_TITLES: "1990 Baseball Wit,2011 Topps Chrome" });
    expect(r.out).toMatch(/FAILED — .*no CSV/i);
  });

  it("a control-doc write that fails does not take the lane down with it", () => {
    // The precise mechanism of exit 3: writeControl sat outside the per-entry
    // try, so its throw escaped to the outer handler. One failure is now
    // counted and survived; the streak below is what stops the lane.
    const r = drive([{ setName: "Topps Chrome", year: 2011, yields: "csv" }], { LIMIT: "1", BACKFILL_APPLY: "true" }, { failControlWrites: true });
    expect(r.out).toMatch(/CONTROL WRITE FAILED/);
    expect(r.out).not.toMatch(/FATAL/);
    expect(r.code).not.toBe(3);
  });
});

// ── PIN 2: the systemic tripwire still fires ─────────────────────────────────

describe("ingest-universe-driver — a systemic failure still aborts the lane", () => {
  it(`${SYSTEMIC_FAILURE_STREAK} consecutive fetch errors abort the lane rather than burning the budget`, () => {
    const specs: EntrySpec[] = [];
    for (let i = 0; i < SYSTEMIC_FAILURE_STREAK; i++) specs.push({ setName: `Down ${i}`, year: 2000 + i, yields: "throw" });
    // Entries the lane must NOT reach once it has decided the lane is down.
    specs.push({ setName: "Topps Chrome", year: 2011, yields: "csv" });
    specs.push({ setName: "Bowman Chrome", year: 2015, yields: "csv" });

    const r = drive(specs, { LIMIT: String(specs.length), BACKFILL_APPLY: "true", BCP_TITLES: specs.map((s) => `${s.year} ${s.setName}`).join(",") });

    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.out).toMatch(/consecutive entries failed or were unreachable/i);
    // Red -- a lane that is down must not report a green run.
    expect(r.code).toBe(5);
    // The entries beyond the streak were never attempted.
    expect(r.control.length).toBe(SYSTEMIC_FAILURE_STREAK);
    expect(r.control.some((d: any) => String(d.entryId).includes("Topps_Chrome"))).toBe(false);
    // And the budget marker is NOT printed: a relaunch would meet the same wall.
    expect(r.out).not.toMatch(/stopped at the .*budget/);
  });

  it("a lane where refusals are INTERLEAVED with successes keeps running — the streak is consecutive, not cumulative", () => {
    // Four refusals total, never N in a row. A lane whose every other page has
    // no ladder is a working lane; treating that as systemic would abort on the
    // most ordinary shape in the manifest.
    const specs: EntrySpec[] = [];
    for (let i = 0; i < 4; i++) {
      specs.push({ setName: `Oddball ${i}`, year: 1991 + i, yields: "nothing" });
      specs.push({ setName: `Topps Chrome ${i}`, year: 2011 + i, yields: "csv" });
    }
    const r = drive(specs, { LIMIT: String(specs.length), BACKFILL_APPLY: "true", BCP_TITLES: specs.map((s) => `${s.year} ${s.setName}`).join(",") });
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(0);
    expect(r.control.length).toBe(specs.length);
  });
});

// ── PIN 3: the control id is addressable at all ──────────────────────────────

describe("ingest-universe-driver — the control id is a legal Cosmos id", () => {
  it("escapes the characters Cosmos refuses in a resource id", () => {
    // The measured cause: ALL 7,755 manifest entries across ALL SIX lanes carry
    // a sourceRef URL in their id, so every control id had slashes and the SDK
    // threw client-side before a single verdict could land.
    const id = controlId("bcp::http://www.baseballcardpedia.com/index.php/1990_Baseball_Wit");
    expect(id).not.toMatch(/[/\\#?]/);
    expect(id).toContain("ingest_universe");
  });

  it("is INJECTIVE — two entries differing only where a slash sat stay two docs", () => {
    // Stripping instead of escaping would fold these onto one control doc, and
    // the second entry would inherit the first's verdict forever.
    expect(cosmosSafeId("a/b")).not.toBe(cosmosSafeId("ab"));
    expect(cosmosSafeId("a/b")).not.toBe(cosmosSafeId("a~sb"));
    expect(cosmosSafeId("x#y")).not.toBe(cosmosSafeId("x/y"));
    const seen = new Set<string>();
    for (const raw of ["a/b", "ab", "a~sb", "a~tb", "a\\b", "a#b", "a?b", "a~b"]) seen.add(cosmosSafeId(raw));
    expect(seen.size).toBe(8);
  });

  it("leaves an id that needs no escaping untouched", () => {
    expect(cosmosSafeId("ingest_universe::tcgdexja::sv3-obsidian-flames")).toBe("ingest_universe::tcgdexja::sv3-obsidian-flames");
  });
});

// ── PIN 4: ordering by value, not by alphabet ────────────────────────────────

describe("ingest-universe-driver — a canary hits the cards that sell", () => {
  const entriesOf = (names: Array<[number, string]>) =>
    names.map(([year, setName]) => ({
      entry: {
        id: `bcp::http://www.baseballcardpedia.com/index.php/${year}_${setName.replace(/ /g, "_")}`,
        lane: "bcp",
        sourceRef: `http://www.baseballcardpedia.com/index.php/${year}_${setName.replace(/ /g, "_")}`,
        year, setName, sport: "baseball", seededStatus: "partial",
      },
      prior: null,
    }));

  const sample = entriesOf([
    [1990, "Baseball Wit"], [1990, "Bazooka"], [1990, "Classic"],
    [2011, "Topps Chrome"], [2015, "Bowman Chrome"], [2019, "Topps Chrome"], [2021, "Topps Chrome"],
  ]);

  it("the value proxy puts the flagship chrome products ahead of the 1990 oddballs", () => {
    // The defect: manifest order is year-then-name, so LIMIT=20 took twenty
    // 1990 entries beginning with "Baseball Wit" -- a page the probe measured
    // as having no autograph section at all, in the boundary year where
    // certified autos begin.
    const { queue, mode } = orderQueue(sample, "");
    expect(mode).toMatch(/value-proxy/);
    const top4 = queue.slice(0, 4).map((q: any) => `${q.entry.year} ${q.entry.setName}`);
    expect(top4).toContain("2011 Topps Chrome");
    expect(top4).toContain("2019 Topps Chrome");
    expect(top4).toContain("2021 Topps Chrome");
    expect(top4).not.toContain("1990 Baseball Wit");
  });

  it("a flagship outranks its own specializations (product-family ladder)", () => {
    // "2020 Topps Chrome Ben Baller Edition" matches the same family regex and
    // sits in a later era, and without the flagship rule it displaced 2011
    // Topps Chrome from the head of the list.
    const q = entriesOf([[2020, "Topps Chrome Ben Baller Edition"], [2013, "Bowman Chrome Mini"], [2011, "Topps Chrome"]]);
    const { queue } = orderQueue(q, "");
    expect(`${queue[0].entry.year} ${queue[0].entry.setName}`).toBe("2011 Topps Chrome");
  });

  it("an explicit titles list wins, in the order given", () => {
    // The escape hatch the runbook documents: `titles` is an EXISTING runner
    // input (BCP_TITLES), so no new workflow_dispatch input is needed.
    const { queue, mode, named } = orderQueue(sample, "2015 Bowman Chrome,2011 Topps Chrome");
    expect(mode).toMatch(/explicit list/);
    expect(named).toBe(2);
    expect(`${queue[0].entry.year} ${queue[0].entry.setName}`).toBe("2015 Bowman Chrome");
    expect(`${queue[1].entry.year} ${queue[1].entry.setName}`).toBe("2011 Topps Chrome");
  });

  it("matches the wiki page-title form as well as the set name", () => {
    const { named, queue } = orderQueue(sample, "2011_Topps_Chrome");
    expect(named).toBe(1);
    expect(`${queue[0].entry.year} ${queue[0].entry.setName}`).toBe("2011 Topps Chrome");
  });

  it("REPORTS a title that matched nothing rather than silently ranking nothing", () => {
    // A mistyped title that quietly ranked nothing would leave the canary back
    // on alphabetical order while the banner claimed an explicit list.
    const { unmatched, named } = orderQueue(sample, "2011 Topps Chrome,No Such Set Anywhere");
    expect(named).toBe(1);
    expect(unmatched).toEqual(["No Such Set Anywhere"]);
  });

  it("never drops or duplicates an entry, whichever mechanism ordered it", () => {
    for (const list of ["", "2011 Topps Chrome,2015 Bowman Chrome", "Nothing Matches"]) {
      const { queue } = orderQueue(sample, list);
      expect(queue.length).toBe(sample.length);
      expect(new Set(queue.map((q: any) => q.entry.id)).size).toBe(sample.length);
    }
  });

  it("is stable — equal rank keeps manifest order, so a re-dispatch takes the same entries", () => {
    const q = entriesOf([[2011, "Topps Chrome"], [2012, "Topps Chrome"], [2013, "Topps Chrome"]]);
    const a = orderQueue(q, "").queue.map((x: any) => x.entry.id);
    const b = orderQueue(q, "").queue.map((x: any) => x.entry.id);
    expect(a).toEqual(b);
  });
});

// ── PIN 5: report mode walks and writes nothing ──────────────────────────────

describe("ingest-universe-driver — report mode walks the entries and writes nothing", () => {
  it("plans every entry it took, records no verdict, and publishes what it INSPECTED", () => {
    // The preceding report run of 33837346045 printed entries=0, which read as
    // "matched nothing". It had in fact walked its queue: the marker was wired
    // to `written`, which report mode leaves at 0 by design.
    const r = drive([
      { setName: "Topps Chrome", year: 2011, yields: "csv" },
      { setName: "Bowman Chrome", year: 2015, yields: "csv" },
    ], { LIMIT: "2", BCP_TITLES: "2011 Topps Chrome,2015 Bowman Chrome" });
    // (apply defaults off -- BACKFILL_APPLY is not in the env above)
    expect(r.out).toMatch(/REPORT ONLY/);
    expect(r.out).toMatch(/would drive: scrape-bcp-ladders/);
    expect(r.out).toMatch(/\[1\/2\]/);
    expect(r.out).toMatch(/\[2\/2\]/);
    expect(r.out).toMatch(/inspected\s+2/);
    // The marker is the number the runner greps and echoes.
    expect(r.out).toMatch(/universe_entries_done=2/);
    // NOTHING was written.
    expect(r.control.length).toBe(0);
    expect(r.code).toBe(0);
  });

  it("APPLY still publishes the control-doc count, not the inspected count", () => {
    const r = drive([{ setName: "Topps Chrome", year: 2011, yields: "csv" }], { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(r.out).toMatch(/universe_entries_done=1/);
    expect(r.control.length).toBe(1);
  });
});
