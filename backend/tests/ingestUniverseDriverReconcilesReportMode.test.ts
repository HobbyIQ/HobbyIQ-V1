import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The two defects of Backfill Runner 33841276495 (sportscardchecklist, report
 * mode, limit=20, titles="1979-80 O-Pee-Chee Hockey,1972 Topps Football,1957
 * Topps Basketball"). Both drive the COMMITTED script through a stubbed
 * Cosmos; report mode fetches nothing, so the lane child is never reached.
 *
 * A. CF-AN-UNREACHABLE-ENTRY-IS-ACCOUNTED-FOR. The banner printed
 *
 *      intended 20 / inspected 19 / unreachable 1 / not reached 0
 *      RECONCILED NO — 19 + 0 != 20
 *
 *    and exited 4, so the runner refused to relaunch a lane that had done
 *    nothing wrong. The entry WAS accounted for and printed on its own line
 *    one row above the failing sum; report mode simply counted only
 *    `inspected`, and an entry settled without a fetch is never inspected.
 *
 * B. CF-A-404-BELONGS-TO-THE-HOST-THAT-SERVED-IT. The manifest's unreachable
 *    marks were keyed `sport|year|setKey` -- the SET, with no lane and no
 *    sourceRef -- so a 404 earned on one host settled the set on every host,
 *    forever. 1972 Topps Football (seededStatus "missing", sourceRef
 *    set-11959, which #1710's survey fetched fine with 351 cards) was printed
 *    "UNREACHABLE — direct 404 probe, no lane serves it", even though the mark
 *    itself records `nowCoveredBy: "sportscardchecklist"`.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-recon-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

type Entry = { setName: string; year: number; sport: string; setKey: string; sourceRef: string; lane?: string };
type Mark = { sport: string; year: number; setKey: string; lane?: string; sourceRef?: string; nowCoveredBy?: string };

function manifestOf(entries: Entry[], unreachable: Mark[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: entries.map((e) => ({
      id: `${e.lane ?? "sportscardchecklist"}::${e.sourceRef}`,
      lane: e.lane ?? "sportscardchecklist",
      sourceRef: e.sourceRef,
      sport: e.sport, year: e.year, setName: e.setName, setKey: e.setKey,
      seededStatus: "missing",
    })),
    unreachable,
  }));
  return p;
}

/** Cosmos only; report mode never shells out to a lane child. */
function shim(): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const stub = {
  CosmosClient: class {
    database() {
      return { container(name) {
        return {
          item() { return { read: async () => ({ resource: null }) }; },
          items: {
            query() { return { fetchAll: async () => ({ resources: name === "card_catalog" ? [0] : [] }) }; },
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
  return p;
}

function drive(entries: Entry[], unreachable: Mark[], env: Record<string, string> = {}) {
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(shim())}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MANIFEST_PATH: manifestOf(entries, unreachable),
        SOURCES: "sportscardchecklist",
        SCOPE: "recheck",
        RUN_MINUTES: "60",
        WORKDIR: path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`),
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const scc = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({
  setName: `Set ${i}`, year: 1970 + i, sport: "football", setKey: `set-${i}`,
  sourceRef: `https://www.sportscardchecklist.com/set-${1000 + i}/set-${i}`,
}));

// ── A: report-mode reconciliation counts the unreachable bucket ──────────────

describe("ingest-universe-driver — report mode reconciles the unreachable bucket", () => {
  it("an entry settled from the manifest still balances the sum, and the run exits 0", () => {
    const entries = scc(3);
    // A legacy mark, naming no lane: it binds set-1, which is then settled
    // WITHOUT a fetch and so is never `inspected`.
    const r = drive(entries, [{ sport: "football", year: 1971, setKey: "set-1" }], { LIMIT: "3" });

    expect(r.out).toMatch(/intended\s+3/);
    expect(r.out).toMatch(/inspected\s+2/);
    expect(r.out).toMatch(/unreachable\s+1/);
    // THE ASSERTION THAT WAS MISSING. 2 + 0 != 3 went red and exited 4, so the
    // runner refused to relaunch a lane that had done nothing wrong.
    expect(r.out).toMatch(/RECONCILED\s+yes/);
    expect(r.out).not.toMatch(/RECONCILED\s+NO/);
    expect(r.code).toBe(0);
  });

  it("the relaunch marker counts it too, or the lane never drains", () => {
    const r = drive(scc(3), [{ sport: "football", year: 1971, setKey: "set-1" }], { LIMIT: "3" });
    // An entry that is DONE must advance the marker the runner greps; leaving
    // it out strands the lane one entry short forever.
    expect(r.out).toMatch(/universe_entries_done=3/);
  });

  it("with nothing unreachable the sum is unchanged — the fix adds a term that is 0", () => {
    const r = drive(scc(3), [], { LIMIT: "3" });
    expect(r.out).toMatch(/inspected\s+3/);
    expect(r.out).toMatch(/RECONCILED\s+yes/);
    expect(r.out).toMatch(/universe_entries_done=3/);
    expect(r.code).toBe(0);
  });
});

// ── B: a 404 belongs to the host that served it ──────────────────────────────

describe("ingest-universe-driver — unreachability is keyed per (lane, sourceRef)", () => {
  const football1972: Entry = {
    setName: "1972 Topps Football", year: 1972, sport: "football", setKey: "topps",
    sourceRef: "https://www.sportscardchecklist.com/set-11959/1972-topps-football-trading-card-checklist",
  };

  it("1972 Topps Football reaches 'would drive' — the mark says nowCoveredBy this lane", () => {
    // The manifest's own record, verbatim in shape: the probe that earned the
    // 404 was a DIFFERENT lane, and the survey has since fetched it here.
    const r = drive([football1972], [{
      sport: "football", year: 1972, setKey: "topps",
      nowCoveredBy: "sportscardchecklist",
    }], { LIMIT: "1" });

    expect(r.out).toMatch(/would drive/);
    expect(r.out).not.toMatch(/UNREACHABLE/);
    expect(r.code).toBe(0);
  });

  it("a mark naming a DIFFERENT lane does not bind this one", () => {
    const r = drive([football1972], [{
      sport: "football", year: 1972, setKey: "topps", lane: "beckett",
    }], { LIMIT: "1" });
    expect(r.out).toMatch(/would drive/);
    expect(r.out).not.toMatch(/UNREACHABLE/);
  });

  it("a mark naming THIS lane's own sourceRef still binds — the refusal is not gutted", () => {
    const r = drive([football1972], [{
      sport: "football", year: 1972, setKey: "topps",
      lane: "sportscardchecklist", sourceRef: football1972.sourceRef,
    }], { LIMIT: "1" });
    expect(r.out).toMatch(/UNREACHABLE/);
    expect(r.out).toMatch(/no lane serves it/);
  });

  it("a mark naming a DIFFERENT sourceRef on this lane does not bind", () => {
    const r = drive([football1972], [{
      sport: "football", year: 1972, setKey: "topps",
      lane: "sportscardchecklist", sourceRef: "https://www.sportscardchecklist.com/set-99999/other",
    }], { LIMIT: "1" });
    expect(r.out).toMatch(/would drive/);
  });

  it("a LEGACY mark naming neither keeps its set-wide reach", () => {
    // The only reading under which the old records were ever true: they were
    // written before lanes were part of the key, so they still bind broadly.
    const r = drive([football1972], [{ sport: "football", year: 1972, setKey: "topps" }], { LIMIT: "1" });
    expect(r.out).toMatch(/UNREACHABLE/);
  });

  it("the committed manifest's own marks release the lane #1710 added", () => {
    // Not a fixture: the real file. 7 of its 8 marks carry nowCoveredBy, so a
    // set-keyed match would have handed the new lane almost the whole list as
    // permanent refusals.
    const real = JSON.parse(fs.readFileSync(path.join(backend, "data", "ingest-universe.json"), "utf8"));
    const marks = real.unreachable ?? [];
    expect(marks.length).toBeGreaterThan(0);
    const released = marks.filter((m: any) => m.nowCoveredBy === "sportscardchecklist");
    expect(released.length).toBeGreaterThan(0);
    // And every released mark names a set the new lane actually carries an
    // entry for -- otherwise "nowCoveredBy" would be a claim with nothing
    // behind it.
    for (const m of released) {
      const has = real.entries.some((e: any) =>
        e.lane === "sportscardchecklist" && e.sport === m.sport && String(e.year) === String(m.year));
      expect(`${m.sport}|${m.year}|${m.setKey} has an entry`).toBe(has ? `${m.sport}|${m.year}|${m.setKey} has an entry` : "no entry");
    }
  });
});
