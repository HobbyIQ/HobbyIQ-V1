import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-STAGED-FILE-WINS (2026-09-04).
 *
 * #1719 committed eight Topps Traded Tiffany checklists -- 1984-1990 from
 * sportscardchecklist, 1991 from baseballcardpedia -- as CSVs with manifest
 * sidecars under backend/data/checklists/scraped/. #1717 taught the QUEUE to
 * put staged entries first. Nothing taught the driver to USE them: the
 * acquisition re-fetched every one, and a re-fetch is not the staged file.
 *
 * Measured in card_catalog on 2026-09-04, after run 33854416984:
 *
 *   1984-1990  setKey topps-traded-tiffany  132/yr  sportscardchecklist-2026-09-04
 *   1991       setKey topps-traded          396     baseballcardpedia-ladders-2026-09-04
 *
 * The 1991 row is the whole argument, and its 396 = 132 x 3 says exactly what
 * the re-fetch did. The staged CSV is 132 rows, setKey `topps-traded-tiffany`,
 * parallel BLANK. scrape-bcp-ladders.cjs instead:
 *
 *   - derived the key from the PAGE TITLE ("1991_Topps_Traded" ->
 *     normalizeSetKeyLocal -> `topps-traded`), filing the rows under the Traded
 *     product rather than the Tiffany one;
 *   - emitted the literal "Base" in the parallel column, which the CSV contract
 *     forbids (blank means plain; "Base" is a rung name);
 *   - returned Tiffany as a PARALLEL of Topps Traded -- parallels measured
 *     {"Base":132,"Topps Traded Tiffany":132,"Grey Backs":132} -- so a
 *     132-card product became a rung of another product, which is the
 *     split-pool shape (memory: one card, one row, one pool).
 *
 * These drive the COMMITTED script through a stubbed lane child and a stubbed
 * Cosmos -- never a reimplementation of the loop.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const { stagedFilesFor, isStaged } = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-staged-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

/** The 1991 entry as the manifest actually holds it. */
const BCP_1991 = {
  id: "bcp::https://baseballcardpedia.com/index.php/1991_Topps_Traded",
  lane: "bcp",
  sourceRef: "https://baseballcardpedia.com/index.php/1991_Topps_Traded",
  sport: "baseball",
  year: 1991,
  setName: "1991 Topps Traded Tiffany",
  setKey: "topps-traded-tiffany",
  seededStatus: "pending",
};

/**
 * A staging root holding ONE page's committed CSV + manifest, shaped exactly
 * like backend/data/checklists/scraped/1991-topps-traded-tiffany-baseball.*:
 * 132 base rows, parallel BLANK, setKey topps-traded-tiffany.
 */
function stagingRoot(): string {
  const root = fs.mkdtempSync(path.join(tmp, "checklists-"));
  const dir = path.join(root, "scraped");
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 132 }, (_, i) => `base,${i + 1}T,,false,,Player ${i + 1} Name`);
  fs.writeFileSync(path.join(dir, "1991-topps-traded-tiffany-baseball.csv"), [HEADER, ...rows].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "1991-topps-traded-tiffany-baseball.manifest.json"), JSON.stringify({
    source: "baseballcardpedia",
    sourceUrl: BCP_1991.sourceRef,
    sport: "baseball",
    year: 1991,
    setName: "1991 Topps Traded Tiffany",
    setKey: "topps-traded-tiffany",
    rowCount: 132,
    parallelColumnAuthoritative: true,
  }, null, 1));
  return root;
}

function manifestOf(entries: object[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ entries, unreachable: [] }));
  return p;
}

/**
 * The shim. Cosmos is stubbed, and so is the LANE CHILD: a run that reaches
 * scrape-bcp-ladders.cjs writes a file spelled the way the real scraper spells
 * it -- setKey `topps-traded`, parallel "Base" -- so a test can tell a fetch
 * from a staged ingest by what landed, not by a log line. The ingest child is
 * stubbed to a no-op that records the DIR it was handed.
 */
function shim(refetchLog: string, ingestLog: string, priorStatus?: string): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const stub = {
  CosmosClient: class {
    database() {
      return { container(name) {
        return {
          item() { return { read: async () => ({ resource: null }) }; },
          items: {
            // Two queries run here: the card_catalog COUNT, and the
            // prior-verdict read over crawl_state. priorStatus puts the
            // entry in the TERMINAL state the real control doc is in, so a
            // test can drive the recheck filter rather than describe it.
            query(spec) {
              const q = String((spec && spec.query) || spec || "");
              if (name === "card_catalog") return { fetchAll: async () => ({ resources: [132] }) };
              if (q.includes("ingest_universe_status") && ${JSON.stringify(priorStatus || "")}) {
                return { fetchAll: async () => ({ resources: [{
                  entryId: ${JSON.stringify("bcp::https://baseballcardpedia.com/index.php/1991_Topps_Traded")},
                  status: ${JSON.stringify(priorStatus || "")},
                  attempts: 1,
                }] }) };
              }
              return { fetchAll: async () => ({ resources: [] }) };
            },
            upsert: async (doc) => {
              fs.appendFileSync(${JSON.stringify(ingestLog)}, "CONTROL " + JSON.stringify(doc) + "\\n");
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

// The lane children and the ingest child, intercepted at execFileSync.
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  const script = String((args || [])[0] || "");
  if (script.includes("scrape-bcp-ladders")) {
    // WHAT THE REAL SCRAPER PRODUCES, and the reason this rule exists.
    const outDir = String((args || []).find((a) => String(a).startsWith("--outDir=")) || "").slice(9);
    fs.mkdirSync(outDir, { recursive: true });
    const rows = [];
    for (let i = 1; i <= 132; i++) {
      rows.push("base," + i + "T,Base,false,,Player " + i + " Name");
      rows.push("base," + i + "T,Topps Traded Tiffany,false,,Player " + i + " Name");
      rows.push("base," + i + "T,Grey Backs,false,,Player " + i + " Name");
    }
    fs.writeFileSync(path.join(outDir, "1991-topps-traded-baseball.csv"),
      [${JSON.stringify(HEADER)}, ...rows].join("\\n") + "\\n");
    fs.writeFileSync(path.join(outDir, "1991-topps-traded-baseball.manifest.json"), JSON.stringify({
      year: 1991, sport: "baseball", setKey: "topps-traded",
      setName: "1991 Topps Traded", sourceUrl: ${JSON.stringify(BCP_1991.sourceRef)},
      parallelColumnAuthoritative: true,
    }));
    fs.appendFileSync(${JSON.stringify(refetchLog)}, "REFETCHED\\n");
    return "";
  }
  if (script.includes("ingest-checklist-csv-to-catalog")) {
    const dir = (opts && opts.env && opts.env.DIR) || "";
    const names = fs.readdirSync(dir).sort();
    const payload = { dir, files: names, csv: {} };
    for (const n of names) {
      if (n.endsWith(".csv")) payload.csv[n] = fs.readFileSync(path.join(dir, n), "utf8");
      if (n.endsWith(".manifest.json")) payload.csv[n] = fs.readFileSync(path.join(dir, n), "utf8");
    }
    fs.appendFileSync(${JSON.stringify(ingestLog)}, "INGEST " + JSON.stringify(payload) + "\\n");
    return "";
  }
  return realExec.apply(this, arguments);
};
`);
  return p;
}

type Run = { code: number; out: string; refetched: boolean; ingested: Array<{ dir: string; files: string[]; csv: Record<string, string> }>; controls: any[] };

function drive(entries: object[], env: Record<string, string> = {}, staging?: string, priorStatus?: string): Run {
  const refetchLog = path.join(tmp, `refetch-${Math.random().toString(36).slice(2)}.log`);
  const ingestLog = path.join(tmp, `ingest-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(refetchLog, "");
  fs.writeFileSync(ingestLog, "");
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim(refetchLog, ingestLog, priorStatus))}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifestOf(entries),
        SOURCES: "bcp",
        RUN_MINUTES: "60",
        LIMIT: "1",
        WORKDIR: path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`),
        // The staging root the driver walks. Pointing it at a fixture keeps the
        // test off the repo's real committed checklists.
        CHECKLIST_DIR: staging ?? stagingRoot(),
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const ingestLines = fs.readFileSync(ingestLog, "utf8").split("\n").filter(Boolean);
  return {
    code,
    out,
    refetched: fs.readFileSync(refetchLog, "utf8").includes("REFETCHED"),
    ingested: ingestLines.filter((l) => l.startsWith("INGEST ")).map((l) => JSON.parse(l.slice(7))),
    controls: ingestLines.filter((l) => l.startsWith("CONTROL ")).map((l) => JSON.parse(l.slice(8))),
  };
}

// ── the rule ────────────────────────────────────────────────────────────────

describe("ingest-universe-driver — a staged file wins", () => {
  it("ingests the committed CSV byte-for-byte and never fetches", () => {
    const staged = stagingRoot();
    const stagedCsv = fs.readFileSync(
      path.join(staged, "scraped", "1991-topps-traded-tiffany-baseball.csv"), "utf8");

    const r = drive([BCP_1991], { BACKFILL_APPLY: "true" }, staged);

    // THE ASSERTION THAT WAS MISSING. Run 33854416984 re-fetched every one.
    expect(r.refetched).toBe(false);
    expect(r.ingested).toHaveLength(1);

    // BYTE FOR BYTE. Not "a file with the same row count" -- the same bytes,
    // because the whole point is that a human's ruling is not re-derived.
    const handed = r.ingested[0].csv["1991-topps-traded-tiffany-baseball.csv"];
    expect(handed).toBe(stagedCsv);

    // And the manifest travels WITH it: the ingest child reads product
    // identity from the sidecar, so a CSV handed over without one would be
    // re-identified from the filename.
    expect(r.ingested[0].files).toContain("1991-topps-traded-tiffany-baseball.manifest.json");
    const m = JSON.parse(r.ingested[0].csv["1991-topps-traded-tiffany-baseball.manifest.json"]);
    expect(m.setKey).toBe("topps-traded-tiffany");
  });

  it("the three defects of the re-fetch are absent from what is ingested", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true" });
    const handed = Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".csv"))![1];

    // 1. the setKey is the Tiffany product, not the Traded one it was derived
    //    from the page slug as.
    const m = Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".manifest.json"))![1];
    expect(JSON.parse(m).setKey).toBe("topps-traded-tiffany");
    expect(JSON.parse(m).setKey).not.toBe("topps-traded");

    // 2. no row spells the parallel "Base". Blank means plain; the CSV
    //    contract forbids the word.
    expect(handed).not.toMatch(/,Base,/);

    // 3. Tiffany is not a RUNG of another product.
    expect(handed).not.toMatch(/Topps Traded Tiffany/);
    expect(handed).not.toMatch(/Grey Backs/);

    // 132 rows, every parallel blank -- the shape the staging actually has.
    const lines = handed.trim().split("\n").slice(1);
    expect(lines).toHaveLength(132);
    expect(lines.every((l) => l.split(",")[2] === "")).toBe(true);
  });

  it("records acquired: staged on the control doc", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true" });
    expect(r.out).toMatch(/STAGED — ingesting 1 committed file\(s\) as-is, no fetch/);
    const doc = r.controls.find((d) => d.docType === "ingest_universe_status");
    expect(doc).toBeTruthy();
    expect(doc.acquired).toBe("staged");
  });

  it("report mode says the staged pipe, not the fetch pipe", () => {
    const r = drive([BCP_1991], {});
    // The plan and the apply are one decision; a report that describes a
    // scrape the apply will not run is the failure #1720 was written about.
    expect(r.out).toMatch(/would drive: STAGED/);
    expect(r.out).toMatch(/no fetch/);
    expect(r.out).toMatch(/1991-topps-traded-tiffany-baseball\.csv/);
  });

  // ── the way back ──────────────────────────────────────────────────────────

  it("MODE=refetch forces the re-fetch — a staged file is not a permanent veto", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true", MODE: "refetch" });
    expect(r.refetched).toBe(true);
    const doc = r.controls.find((d) => d.docType === "ingest_universe_status");
    expect(doc.acquired).toBe("fetched");
  });

  it("an entry with nothing staged still drives its lane", () => {
    const unstaged = { ...BCP_1991, id: "bcp::x", sourceRef: "https://baseballcardpedia.com/index.php/1990_Baseball_Wit" };
    const r = drive([unstaged], { BACKFILL_APPLY: "true" });
    // The rule adds a short-circuit; it must not become one for everything.
    expect(r.refetched).toBe(true);
  });

  // ── the index ─────────────────────────────────────────────────────────────

  it("the real repo staging holds all eight Topps Traded Tiffany years", () => {
    const years = [1984, 1985, 1986, 1987, 1988, 1989, 1990, 1991];
    const universe = JSON.parse(fs.readFileSync(path.join(backend, "data", "ingest-universe.json"), "utf8"));
    const tiffany = universe.entries.filter((e: any) => e.setKey === "topps-traded-tiffany");
    expect(tiffany).toHaveLength(8);
    for (const y of years) {
      const e = tiffany.find((x: any) => x.year === y);
      expect(e, `no manifest entry for ${y}`).toBeTruthy();
      // Every one is staged, so every one takes the staged path.
      expect(isStaged(e), `${y} is not staged`).toBe(true);
      const files = stagedFilesFor(e);
      expect(files.length, `${y} stages no file`).toBe(1);
      const csv = fs.readFileSync(files[0].csv, "utf8").trim().split("\n");
      // 132 cards, 1T-132T, every parallel blank -- the slug is
      // …:<n>t:base:no-auto, which is what the goal asks the pool to key on.
      expect(csv.length - 1, `${y} is not 132 rows`).toBe(132);
      expect(csv.slice(1).every((l: string) => l.split(",")[2] === ""), `${y} has a non-blank parallel`).toBe(true);
    }
  });
});

/**
 * CF-RECHECK-IS-NOT-REFETCH (2026-09-04).
 *
 * #1737 armed the staged short-circuit off SCOPE=recheck, which is ALSO the
 * only way past the TERMINAL-verdict filter. So the one dispatch that could
 * re-attempt the 1991 Topps Traded Tiffany entry -- verdicted `ingested` by the
 * pre-#1737 run that minted its 396-row cross-join under `topps-traded` -- was
 * the same dispatch that threw the staged CSV away and re-scraped bcp. The
 * entry could not be re-run without re-running the exact mistake, and the only
 * other exit was hand-editing the control doc, which is a Cosmos write we do
 * not do.
 *
 * The two meanings are now separate signals, and this pins both:
 *
 *   scope=recheck  re-attempt a verdicted entry; the staged file STILL WINS.
 *   mode=refetch   force the live fetch; the ONLY thing that bypasses staged.
 *
 * The verdicted-entry cases drive the SAME committed script through a Cosmos
 * stub that answers the prior-verdict query with `ingested`, which is the
 * state the real control doc is in.
 */
describe("ingest-universe-driver — recheck re-attempts, refetch re-fetches", () => {
  it("recheck + staged present → acquired: staged, no fetch", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true", SCOPE: "recheck" });

    // THE BUG. Before the split this fetched, because recheck armed both jobs.
    expect(r.refetched).toBe(false);
    const doc = r.controls.find((d) => d.docType === "ingest_universe_status");
    expect(doc.acquired).toBe("staged");

    // And what landed is the human's ruling, not the cross-join.
    const m = JSON.parse(Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".manifest.json"))![1]);
    expect(m.setKey).toBe("topps-traded-tiffany");
    const handed = Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".csv"))![1];
    expect(handed.trim().split("\n").length - 1).toBe(132);
  });

  it("refetch → acquired: fetched, even with no recheck", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true", MODE: "refetch" });
    expect(r.refetched).toBe(true);
    expect(r.controls.find((d) => d.docType === "ingest_universe_status").acquired).toBe("fetched");
  });

  it("they compose: recheck + refetch is the old single-switch behaviour", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true", SCOPE: "recheck", MODE: "refetch" });
    expect(r.refetched).toBe(true);
    expect(r.controls.find((d) => d.docType === "ingest_universe_status").acquired).toBe("fetched");
  });

  it("another script's mode token is not a refetch", () => {
    // `mode` is shared across every script the runner drives (census,
    // apply-improve, product, ...). Only the literal `refetch` arms this.
    for (const mode of ["census", "apply-improve", "product", ""]) {
      const r = drive([BCP_1991], { BACKFILL_APPLY: "true", MODE: mode });
      expect(r.refetched, `MODE=${mode || "(empty)"} re-fetched`).toBe(false);
    }
  });

  // ── the terminal verdict: the case that could not be re-run at all ────────

  it("a verdicted entry needs recheck to be re-attempted, and then takes the staged file", () => {
    // Without recheck the TERMINAL filter drops it: nothing is acquired.
    const pending = drive([BCP_1991], { BACKFILL_APPLY: "true" }, undefined, "ingested");
    expect(pending.ingested).toHaveLength(0);
    expect(pending.refetched).toBe(false);

    // With recheck it is re-attempted -- from the STAGED file, which is the
    // whole point: re-running the entry no longer means re-running the fetch.
    const re = drive([BCP_1991], { BACKFILL_APPLY: "true", SCOPE: "recheck" }, undefined, "ingested");
    expect(re.ingested).toHaveLength(1);
    expect(re.refetched).toBe(false);
    expect(re.controls.find((d) => d.docType === "ingest_universe_status").acquired).toBe("staged");
  });

  it("report mode on a verdicted entry prints STAGED for it", () => {
    // The proof the goal asks for: scope=recheck limit=1 titles=<the entry>,
    // report mode, and the plan says STAGED rather than the bcp scrape.
    const r = drive([BCP_1991], { SCOPE: "recheck", TITLES: "1991 Topps Traded Tiffany" }, undefined, "ingested");
    expect(r.out).toMatch(/would drive: STAGED/);
    expect(r.out).toMatch(/no fetch/);
    expect(r.out).toMatch(/1991-topps-traded-tiffany-baseball\.csv/);
    // The scraper is NAMED on that line, but named as BYPASSED -- the plan
    // line reads "... scrape-bcp-ladders.cjs ... is bypassed". What must not
    // appear is a plan that leads with the scrape.
    expect(r.out).toMatch(/scrape-bcp-ladders\.cjs.*is bypassed/);
    expect(r.out).not.toMatch(/would drive: scrape-bcp-ladders/);
    // prior verdict is the terminal one, so recheck is what let it in at all.
    expect(r.out).toMatch(/prior=ingested/);
  });
});

// ── the mutation ────────────────────────────────────────────────────────────

/**
 * THE MUTATION THIS PINS. Re-fetching despite a staged file is the behaviour
 * that shipped, so the test proves it would now go RED: the driver is run with
 * the short-circuit disabled through the SAME switch the operator has
 * (MODE=refetch), and the assertions above are re-run against it. If they
 * passed either way, the pin would be pinning nothing.
 */
describe("ingest-universe-driver — re-fetch despite staged goes red", () => {
  it("the fetched file carries all three defects, so the staged assertions fail on it", () => {
    const r = drive([BCP_1991], { BACKFILL_APPLY: "true", MODE: "refetch" });
    expect(r.refetched).toBe(true);
    const handed = Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".csv"))![1];
    const m = JSON.parse(Object.entries(r.ingested[0].csv).find(([n]) => n.endsWith(".manifest.json"))![1]);

    // Each of these is the negation of an assertion in "the three defects"
    // above: with the short-circuit off, the ingest gets the wrong key, the
    // forbidden word, and Tiffany as a rung.
    expect(m.setKey).toBe("topps-traded");
    expect(handed).toMatch(/,Base,/);
    expect(handed).toMatch(/Topps Traded Tiffany/);
    expect(handed.trim().split("\n").length - 1).toBe(396);
  });
});
