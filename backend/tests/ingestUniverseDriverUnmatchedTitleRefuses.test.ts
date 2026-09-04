import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-AN-UNMATCHED-TITLE-REFUSES (2026-09-04, run 33872976786).
 *
 * The operator dispatched:
 *
 *   script=ingest-universe-driver sources=bcp years=1991 limit=1 apply=true
 *   titles="1991 Topps Traded Tiffany"
 *
 * and the run went GREEN having ingested nothing anyone asked for:
 *
 *   UNMATCHED     1 title(s) in the list matched no entry of this lane ...
 *                   "1991 Topps Traded Tiffany"
 *                 (check the page title against the manifest sourceRef; the run continues on the rest)
 *                   -> 1991 Bowman
 *   [1/1] bcp/Bowman
 *       EMPTY - bcp page has a base set but no parallel ladder
 *   RECONCILED    yes
 *
 * Two separate faults, pinned separately below.
 *
 * 1. A title that ranks NOTHING must REFUSE the run. The entry was in the
 *    manifest under exactly that setName -- it had simply already been verdicted
 *    `ingested`, so the TERMINAL filter dropped it from the queue before
 *    orderQueue could ever see it. "The run continues on the rest" then
 *    converted an operator error into a green no-op on an unrequested set. The
 *    run must exit non-zero with intended 0, and the banner must name the
 *    unmatched titles AND their nearest manifest neighbours, so the operator can
 *    tell "no such page" from "that page is already ingested".
 *
 * 2. `limit` must not PAD an explicit list. titles=<one page> limit=5 means that
 *    page, not that page plus four more the proxy picked.
 *
 * These drive the COMMITTED script with a stubbed Cosmos -- never a
 * reimplementation of the ordering.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-unmatched-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The 1991 Tiffany entry as the manifest actually holds it (#1719 / #1737). */
const BCP_TIFFANY = {
  id: "bcp::https://baseballcardpedia.com/index.php/1991_Topps_Traded",
  lane: "bcp",
  sourceRef: "https://baseballcardpedia.com/index.php/1991_Topps_Traded",
  sport: "baseball",
  year: 1991,
  setName: "1991 Topps Traded Tiffany",
  setKey: "topps-traded-tiffany",
  seededStatus: "pending",
};

/** The entry the fall-through actually ran. */
const BCP_BOWMAN = {
  id: "bcp::https://baseballcardpedia.com/index.php/1991_Bowman",
  lane: "bcp",
  sourceRef: "http://www.baseballcardpedia.com/index.php/1991_Bowman",
  sport: "baseball",
  year: 1991,
  setName: "Bowman",
  setKey: "bowman",
  seededStatus: "pending",
};

const BCP_STADIUM = {
  id: "bcp::https://baseballcardpedia.com/index.php/1991_Stadium_Club",
  lane: "bcp",
  sourceRef: "http://www.baseballcardpedia.com/index.php/1991_Stadium_Club",
  sport: "baseball",
  year: 1991,
  setName: "Stadium Club",
  setKey: "stadium-club",
  seededStatus: "pending",
};

function manifestOf(entries: object[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ entries, unreachable: [] }));
  return p;
}

/**
 * Cosmos is stubbed, and so is every lane child: a run that reaches acquisition
 * APPENDS what it drove, so a test tells "refused" from "ran something else" by
 * what was attempted rather than by a log line.
 *
 * `prior` seeds the control-doc read, which is how the real defect arose: the
 * named entry was already `ingested` and therefore never reached the queue.
 */
function shim(attemptLog: string, prior: string): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const cp = require("node:child_process");

const PRIOR = ${JSON.stringify(prior)};
const stub = {
  CosmosClient: class {
    database() {
      return { container(name) {
        return {
          item() { return { read: async () => ({ resource: null }) }; },
          items: {
            query(spec) {
              const q = String((spec && spec.query) || "");
              // The control-doc read the driver does before building the queue.
              if (q.includes("ingest_universe_status")) {
                return { fetchAll: async () => ({ resources: PRIOR ? JSON.parse(PRIOR) : [] }) };
              }
              return { fetchAll: async () => ({ resources: name === "card_catalog" ? [0] : [] }) };
            },
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

// Any acquisition at all is recorded. A refusal must produce NONE.
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  const s = String((args || [])[0] || "");
  if (s.includes("scrape-") || s.includes("ingest-checklist-csv-to-catalog")) {
    const t = String((args || []).find((a) => String(a).startsWith("--titles=")) || "");
    fs.appendFileSync(${JSON.stringify(attemptLog)}, "ATTEMPT " + s + " " + t + "\\n");
    return "";
  }
  return realExec.apply(this, arguments);
};
`);
  return p;
}

type Run = { code: number; out: string; attempts: string[] };

function drive(entries: object[], env: Record<string, string> = {}, prior: object[] = []): Run {
  const attemptLog = path.join(tmp, `attempt-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(attemptLog, "");
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim(attemptLog, JSON.stringify(prior)))}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifestOf(entries),
        SOURCES: "bcp",
        YEARS: "1991",
        RUN_MINUTES: "60",
        LIMIT: "1",
        WORKDIR: path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`),
        // Keep the driver off the repo's real committed checklists.
        CHECKLIST_DIR: fs.mkdtempSync(path.join(tmp, "cl-")),
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  return { code, out, attempts: fs.readFileSync(attemptLog, "utf8").split("\n").filter(Boolean) };
}

// -- rule 1: an unmatched title refuses --------------------------------------

describe("ingest-universe-driver - an explicit title that matches nothing REFUSES", () => {
  /**
   * The exact shape of run 33872976786: the named entry is in the manifest but
   * already verdicted `ingested`, so it never reaches the queue, and 1991 Bowman
   * is sitting there to be fallen through to.
   */
  const PRIOR_INGESTED = [{ entryId: BCP_TIFFANY.id, status: "ingested", attempts: 1 }];

  it("exits non-zero and acquires NOTHING instead of taking the next queue entry", () => {
    const r = drive([BCP_TIFFANY, BCP_BOWMAN], { BCP_TITLES: "1991 Topps Traded Tiffany" }, PRIOR_INGESTED);

    // THE ASSERTION THAT WAS MISSING. Run 33872976786 exited 0.
    expect(r.code).not.toBe(0);

    // And it must not have run the fall-through entry. That is the fault: the
    // operator asked for Tiffany and the driver fetched Bowman.
    expect(r.attempts).toHaveLength(0);
    expect(r.out).not.toMatch(/bcp\/Bowman/);
  });

  it("reports RECONCILED against an intended of 0, not the entry it substituted", () => {
    const r = drive([BCP_TIFFANY, BCP_BOWMAN], { BCP_TITLES: "1991 Topps Traded Tiffany" }, PRIOR_INGESTED);

    // The old run reconciled "intended 1 = written 0 + skipped 1" -- a balanced
    // ledger for work nobody requested. Refusing means intending nothing.
    expect(r.out).toMatch(/intended\s+0/);
    expect(r.out).toMatch(/intended 0 = written 0 \+ skipped 0/);
    expect(r.out).not.toMatch(/intended 1 = written 0 \+ skipped 1/);
    expect(r.out).toMatch(/universe_entries_done=0/);
  });

  it("names every unmatched title and its nearest manifest neighbours", () => {
    const r = drive(
      [BCP_TIFFANY, BCP_BOWMAN],
      { BCP_TITLES: "1991 Topps Traded Tiffany,1991 Nonesuch Brand" },
      PRIOR_INGESTED,
    );

    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSE/);
    // Both titles named -- not just the first.
    expect(r.out).toContain('"1991 Topps Traded Tiffany"');
    expect(r.out).toContain('"1991 Nonesuch Brand"');
    // "check the title against the manifest sourceRef" is only actionable WITH
    // the manifest, so the nearest candidates travel with the refusal.
    expect(r.out).toMatch(/nearest in manifest/);
  });

  it("a title that DOES rank still runs, so the refusal is not a blanket stop", () => {
    const r = drive([BCP_TIFFANY, BCP_BOWMAN], { BCP_TITLES: "1991 Topps Traded Tiffany", BACKFILL_APPLY: "true" }, []);

    // No prior verdict -> the entry is in the queue -> it matches -> it runs.
    expect(r.out).not.toMatch(/REFUSE/);
    expect(r.attempts.length).toBeGreaterThan(0);
  });
});

// -- rule 2: limit must not pad an explicit list ------------------------------

describe("ingest-universe-driver - limit does not pad an explicit list", () => {
  it("runs ONLY the matched entries when limit exceeds the list", () => {
    // One title named, limit 5, three entries eligible. The proxy would happily
    // supply two more; the operator asked for one.
    const r = drive(
      [BCP_TIFFANY, BCP_BOWMAN, BCP_STADIUM],
      { BCP_TITLES: "1991 Topps Traded Tiffany", LIMIT: "5", BACKFILL_APPLY: "true" },
      [],
    );

    expect(r.out).not.toMatch(/REFUSE/);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts.join("\n")).not.toMatch(/1991_Bowman/);
    expect(r.attempts.join("\n")).not.toMatch(/Stadium_Club/);

    // And it SAYS so, rather than silently taking fewer than the stated limit.
    expect(r.out).toMatch(/will NOT pad with unrequested entries/);
    expect(r.out).toMatch(/intended\s+1/);
  });

  it("with NO titles, limit still sizes the run from the value proxy", () => {
    // The cap is scoped to an explicit list; the no-titles case is untouched.
    const r = drive([BCP_BOWMAN, BCP_STADIUM], { LIMIT: "2", BACKFILL_APPLY: "true" }, []);

    expect(r.out).not.toMatch(/will NOT pad/);
    expect(r.attempts).toHaveLength(2);
  });
});
