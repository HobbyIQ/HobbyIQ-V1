import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE (2026-09-04).
 *
 * Backfill Runner 33845979897 (ingest-universe-driver, sources=tcgdexja,
 * limit=52, APPLY) took the first three entries of the queue -- 2014 XY2, XY3,
 * XY4 -- and reported each "FAILED — tcgdex produced no CSV". Three in a row
 * tripped the systemic tripwire, the lane aborted, and the 49 remaining entries
 * were never attempted. Among them: all 52 modern JA sets #1702 had already
 * STAGED to disk, CSVs and manifests committed.
 *
 * Nothing was broken. Probed live against api.tcgdex.net/v2/ja: XY2, XY3 and
 * XY4 each answer HTTP 200, with the right Japanese name, a populated
 * `cardCount.total` (80 / 96 / 88) -- and `cards: []`. tcgdex holds no per-card
 * rows for the XY-era Japanese sets. `scrape-tcgdex-ja.cjs` reads that
 * correctly (`!d.cards.length` -> skippedSets++, continue), writes no CSV and
 * exits 0. Only the DRIVER was wrong, in reading "no CSV" as a lane fault.
 *
 * Measured over the lane: 32 of the 97 vintage entries answer with an empty
 * `cards` array (a further 5 are honest 404s, which stay `unreachable`).
 *
 * Three pins: the verdict is its own class, it does not advance the streak, and
 * an entry whose checklist is already staged leads the queue.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const {
  orderQueue, isStaged, stagedSourceRefs, EMPTY_STATUS, STREAK_STATUSES, SYSTEMIC_FAILURE_STREAK,
} = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-ja-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── the harness ──────────────────────────────────────────────────────────────
//
// Drives the COMMITTED driver through a stubbed tcgdex child and a stubbed
// Cosmos. "empty" reproduces the real scraper's exit-0 shape for a set the
// source does not card: no CSV written, and the summary lines the acquisition
// reads to tell that apart from a broken scrape.

type Spec = { setId: string; year: number; yields: "csv" | "empty" | "throw" };

function manifestOf(specs: Spec[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      id: `tcgdexja::https://api.tcgdex.net/v2/ja/sets/${s.setId}`,
      lane: "tcgdexja",
      sourceRef: `https://api.tcgdex.net/v2/ja/sets/${s.setId}`,
      sport: "pokemon",
      year: s.year,
      setName: `${s.setId} test`,
      seededStatus: "partial",
    })),
    unreachable: [],
  }));
  return p;
}

function shimOf(specs: Spec[]): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const behaviour: Record<string, string> = {};
  for (const s of specs) behaviour[s.setId] = s.yields;
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const BEHAVIOUR = ${JSON.stringify(behaviour)};
const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

function cleanCsv() {
  const rows = [HEADER];
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",,false,,Player " + i + " Name");
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",Gold Refractor,false,/50,Player " + i + " Name");
  return rows.join("\\n") + "\\n";
}

const cp = require("node:child_process");
cp.execFileSync = function (file, args, options) {
  const setsArg = (args || []).find((a) => String(a).startsWith("--sets="));
  if (setsArg) {
    const setId = String(setsArg).slice("--sets=".length);
    const outArg = (args || []).find((a) => String(a).startsWith("--outDir="));
    const outDir = String(outArg).slice("--outDir=".length);
    const mode = BEHAVIOUR[setId] || "csv";
    if (mode === "throw") throw new Error("fetch failed ENOTFOUND api.tcgdex.net");
    if (mode === "csv") {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, setId + ".csv"), cleanCsv());
      return "\\n  sets staged        1\\n  card rows          40\\n  sets skipped       0\\n";
    }
    // The XY shape: exit 0, no CSV, and the summary says the SOURCE had nothing.
    return "\\n  sets staged        0\\n  card rows          0\\n  sets skipped       1\\n";
  }
  return "";
};

const CONTROL = [];
const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          return {
            item() { return { read: async () => ({ resource: null }) }; },
            items: {
              query() { return { fetchAll: async () => ({ resources: name === "card_catalog" ? [40] : [] }) }; },
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

function drive(specs: Spec[], env: Record<string, string> = {}) {
  const sink = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  const shim = shimOf(specs);
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
        SOURCES: "tcgdexja",
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

// ── PIN 1: the empty set gets its own verdict ────────────────────────────────

describe("tcgdexja — a set the source does not card is `empty`, not `failed`", () => {
  it("records EMPTY, not FAILED, when the scraper exits 0 having staged nothing", () => {
    const r = drive([{ setId: "XY2", year: 2014, yields: "empty" }], { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(r.out).toMatch(/EMPTY —/);
    expect(r.out).not.toMatch(/FAILED — tcgdex produced no CSV/);
    // The reason names the source's own answer, so a reader is not sent hunting
    // for a defect in our pipe.
    expect(r.control).toHaveLength(1);
    expect(r.control[0].status).toBe(EMPTY_STATUS);
    expect(r.control[0].reason).toMatch(/serves no cards for this set/);
    expect(r.code).toBe(0);
  });

  it("a scraper that genuinely breaks is still not `empty`", () => {
    // The classification must not swallow real breakage: ONLY the exit-0 +
    // "staged 0 / skipped N" shape earns `empty`. A scrape that throws carries
    // no such summary, so it keeps the streak-advancing verdict it had.
    const r = drive([{ setId: "XY2", year: 2014, yields: "throw" }], { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(r.control[0].status).not.toBe(EMPTY_STATUS);
    expect(STREAK_STATUSES.has(r.control[0].status)).toBe(true);
  });
});

// ── PIN 2: `empty` does not trip the systemic tripwire ───────────────────────

describe("tcgdexja — a correct refusal is not a lane failure", () => {
  it("does NOT count toward the systemic streak", () => {
    expect(STREAK_STATUSES.has(EMPTY_STATUS)).toBe(false);
    expect(STREAK_STATUSES.has("failed")).toBe(true);
    expect(STREAK_STATUSES.has("unreachable")).toBe(true);
  });

  it("the exact run-33845979897 shape now reaches the entries behind the empty sets", () => {
    // Three empty sets ahead of real work -- the incident, entry for entry.
    const specs: Spec[] = [
      { setId: "XY2", year: 2014, yields: "empty" },
      { setId: "XY3", year: 2014, yields: "empty" },
      { setId: "XY4", year: 2014, yields: "empty" },
      { setId: "S5I", year: 2021, yields: "csv" },
      { setId: "S10a", year: 2022, yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "5", BACKFILL_APPLY: "true" });

    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.out).not.toMatch(/SYSTEMIC ABORT/);
    // Every entry was attempted, and the two real ones landed.
    expect(r.control).toHaveLength(5);
    const byId = Object.fromEntries(
      r.control.map((d: any) => [String(d.entryId).split("/").pop(), d.status]),
    );
    expect(byId.XY2).toBe(EMPTY_STATUS);
    expect(byId.XY3).toBe(EMPTY_STATUS);
    expect(byId.XY4).toBe(EMPTY_STATUS);
    expect(byId.S5I).toBe("ingested");
    expect(byId.S10a).toBe("ingested");
    // The run balances -- an `empty` verdict is accounted for, never loss.
    expect(r.out).toMatch(/RECONCILED\s+yes/);
    expect(r.out).toMatch(/empty at source\s+3/);
    expect(r.code).toBe(0);
  });

  it("a genuine outage still aborts, even with an empty set interleaved", () => {
    // `empty` must not RESET the streak either, or one uncarded set between
    // outage entries would hide a lane that is truly down. The order is pinned
    // with an explicit titles list so the assertion is about the TRIPWIRE, not
    // about how the value proxy happened to rank these synthetic ids.
    const specs: Spec[] = [];
    for (let i = 0; i < SYSTEMIC_FAILURE_STREAK; i++) {
      specs.push({ setId: `DOWN${i}`, year: 2000 + i, yields: "throw" });
      if (i === 0) specs.push({ setId: `EMPTY${i}`, year: 2010 + i, yields: "empty" });
    }
    specs.push({ setId: "S5I", year: 2021, yields: "csv" });
    const r = drive(specs, {
      LIMIT: String(specs.length),
      BACKFILL_APPLY: "true",
      TITLES: specs.map((s) => `${s.setId} test`).join(","),
    });
    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(5);
    // The empty set was attempted and verdicted; it neither advanced nor reset
    // the streak, so the outage still tripped on its own three entries...
    expect(r.control.some((d: any) => d.status === EMPTY_STATUS)).toBe(true);
    // ...and the good entry behind the outage was never reached.
    expect(r.control.some((d: any) => String(d.entryId).includes("S5I"))).toBe(false);
  });
});

// ── PIN 3: a staged checklist leads its lane ─────────────────────────────────

describe("ingest-universe-driver — work already on disk leads the queue", () => {
  it("indexes the committed staged checklists by their manifest sourceUrl", () => {
    const refs = stagedSourceRefs();
    expect(refs.size).toBeGreaterThan(0);
    // The 52 modern JA sets #1702 staged are the ones this incident stranded.
    const ja = [...refs].filter((u: string) => u.includes("api.tcgdex.net/v2/ja/sets/"));
    expect(ja.length).toBe(52);
  });

  it("all 52 staged modern JA sets lead the tcgdexja lane, ahead of the vintage XY sets", () => {
    const manifest = require_(path.join(backend, "data", "ingest-universe.json"));
    const lane = manifest.entries.filter((e: any) => e.lane === "tcgdexja");
    expect(lane.length).toBe(180);

    const { queue, mode, staged } = orderQueue(lane.map((entry: any) => ({ entry })), "");
    expect(mode).toMatch(/staged-first/);
    expect(staged).toBe(52);

    // THE INCIDENT, INVERTED. The old proxy put 2014 XY2/XY3/XY4 first; a
    // limit=52 dispatch now takes exactly the 52 sets whose CSVs are in hand,
    // so no `years` filter is needed to reach them.
    const head = queue.slice(0, 52);
    expect(head.every((q: any) => isStaged(q.entry))).toBe(true);
    const headIds = head.map((q: any) => String(q.entry.sourceRef).split("/").pop());
    expect(headIds).not.toContain("XY2");
    expect(headIds).not.toContain("XY3");
    expect(headIds).not.toContain("XY4");
    // Including the four 2026 sets a years=2021..2025 dispatch would have missed.
    for (const id of ["M3", "M4", "M5", "M6"]) expect(headIds).toContain(id);
  });

  it("an explicit titles list still wins over staged-first", () => {
    // The operator's own list remains the top authority; staged-first only
    // orders the proxy path.
    const manifest = require_(path.join(backend, "data", "ingest-universe.json"));
    const lane = manifest.entries.filter((e: any) => e.lane === "tcgdexja");
    const target = lane.find((e: any) => String(e.sourceRef).endsWith("/XY2"));
    const { queue, mode } = orderQueue(lane.map((entry: any) => ({ entry })), target.setName);
    expect(mode).toMatch(/explicit list/);
    expect(String(queue[0].entry.sourceRef).split("/").pop()).toBe("XY2");
  });
});
