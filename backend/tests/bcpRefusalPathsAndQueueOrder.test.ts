import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-REFUSAL-PATH-IS-NOT-A-CRASH + CF-THE-REST-FOLLOW-BENEATH-IN-VALUE-ORDER
 * (2026-09-04, Backfill Runner 33852199385).
 *
 * The bcp canary named four Chrome pages and took a limit of 20. The four
 * ingested (619 / 374 / 1,862 / 1,328 rows). Entries 5-20 were 1990 Baseball
 * Wit, Bazooka, Bowman, Classic, Classic Draft Picks, Donruss, Donruss
 * Baseball's Best, Donruss Learning Series, Donruss The Rookies, Fleer, Fleer
 * Award Winners, Fleer Baseball All-Stars, Fleer Baseball MVP's -- the
 * ALPHABETICAL head of 1990, the least valuable end of a 3,157-entry lane.
 *
 * TWO DEFECTS, one run.
 *
 * 1. ORDER. #1708 promised the value proxy would rank the queue. It does --
 *    but only when NO titles are given. With titles, the named entries led and
 *    the remainder was `[...lead, ...rest]` where `rest` was the eligible queue
 *    in MANIFEST order, which for bcp is alphabetical. A LIMIT larger than the
 *    list is the normal case (4 named, 20 taken), so the un-ordered remainder
 *    was most of what actually ran.
 *
 * 2. REFUSAL PATHS. #1718 mapped exactly ONE scraper message ("nothing new to
 *    add") to EMPTY. The 1990 boxed/retail sets exit by a different path and
 *    were still read as `failed`: six of them, and three consecutively, so the
 *    lane aborted with 2,621 entries never attempted.
 *
 * The probe (2026-09-04, pages fetched live) settles what each path MEANS, and
 * it is not what the incident brief assumed:
 *
 *   1990_Baseball_Wit          Base_Set heading, no ladder   -> EMPTY, correct.
 *   1990_Bazooka               NO Base_Set heading; a full 22-card checklist
 *                              sits under a plain `Checklist` heading.
 *   1990_Fleer_Award_Winners   same shape, 44 cards.
 *   1990_Donruss_Learning_Series, 1990_Fleer_Baseball_All-Stars: same shape.
 *
 * So "0 base cards — layout not understood" is NOT a correct refusal. Those
 * pages carry the rows and our parser cannot see them, because parseCards reads
 * only the `Base_Set` heading. That stays a lane fault -- calling a gap in our
 * own parser "the source has nothing" is how a defect goes quiet. Only the
 * genuinely-empty path becomes EMPTY.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const { orderQueue, EMPTY_STATUS, STREAK_STATUSES } = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-bcp-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── the harness ──────────────────────────────────────────────────────────────
//
// Drives the COMMITTED driver through a stubbed scrape-bcp-ladders child and a
// stubbed Cosmos. Each `yields` reproduces one real exit shape of the scraper,
// on the lines the acquisition actually reads.

type Yield = "csv" | "noLadder" | "noBase" | "gone" | "throw" | "roster" | "stub" | "singleCard";
type Spec = { title: string; year: number; setName: string; yields: Yield };

function manifestOf(specs: Spec[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      id: `bcp::http://www.baseballcardpedia.com/index.php/${s.title}`,
      lane: "bcp",
      sourceRef: `http://www.baseballcardpedia.com/index.php/${s.title}`,
      sport: "baseball",
      year: s.year,
      setName: s.setName,
      seededStatus: "partial",
    })),
    unreachable: [],
  }));
  return p;
}

function shimOf(specs: Spec[]): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const behaviour: Record<string, string> = {};
  for (const s of specs) behaviour[s.title] = s.yields;
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
  const titlesArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titlesArg) {
    const title = String(titlesArg).slice("--titles=".length);
    const outArg = (args || []).find((a) => String(a).startsWith("--outDir="));
    const outDir = String(outArg).slice("--outDir=".length);
    const mode = BEHAVIOUR[title] || "csv";
    if (mode === "throw") throw new Error("FATAL: connection reset by peer");
    if (mode === "csv") {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, title.toLowerCase() + ".csv"), cleanCsv());
      return "  " + title + ": 40 rows across 1 product(s)\\n\\npages fetched     1\\n  staged          1   (40 csv rows)\\n";
    }
    // Every shape below is the REAL scraper exiting 0 having staged nothing.
    if (mode === "noLadder") {
      // scrape-bcp-ladders.cjs:1417 -- the page is fine, we hold it all.
      return "  " + title + ": base ok (109) but 0 rungs \\u2014 nothing new to add\\n\\npages fetched     1\\n  staged          0   (0 csv rows)\\n  no ladder       1\\n";
    }
    if (mode === "gone") {
      // get() :90 -- the wiki says the page is not there.
      return "   HTTP 404 http://www.baseballcardpedia.com/index.php/" + title + "\\n\\npages fetched     0\\n  staged          0   (0 csv rows)\\n  unreachable     1\\n";
    }
    // CF-A-CHECKLIST-WITHOUT-CARD-NUMBERS-IS-NOT-A-PARSER-GAP. Three shapes
    // the wiki publishes with no card number at all; each has its OWN wording
    // so the driver can map them per shape rather than on a catch-all.
    if (mode === "roster") {
      return "  " + title + ": checklist is an UNNUMBERED ROSTER (70 lines) \\u2014 the source states no card numbers, nothing to add\\n\\npages fetched     1\\n  staged          0   (0 csv rows)\\n";
    }
    if (mode === "stub") {
      return "  " + title + ": page is a STUB \\u2014 headings with no checklist under them (0 lines) \\u2014 the source states no card numbers, nothing to add\\n\\npages fetched     1\\n  staged          0   (0 csv rows)\\n";
    }
    if (mode === "singleCard") {
      return "  " + title + ": page is a SINGLE-CARD promo, not a numbered set (1 line) \\u2014 the source states no card numbers, nothing to add\\n\\npages fetched     1\\n  staged          0   (0 csv rows)\\n";
    }
    // scrape-bcp-ladders.cjs:1415 -- OUR parser, not the source.
    return "  " + title + ": 0 base cards \\u2014 layout not understood, SKIPPED (not emitted)\\n\\npages fetched     1\\n  staged          0   (0 csv rows)\\n  no base cards   1   <- layout gap, listed above, NOT silently emitted\\n";
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

const docFor = (control: any[], title: string) =>
  control.find((d) => String(d.entryId ?? d.id).includes(title));
const statusOf = (control: any[], title: string) => docFor(control, title)?.status;

// ── PIN 1: each refusal path gets the verdict its MESSAGE earns ──────────────

describe("bcp — a refusal path is classified on what the scraper said", () => {
  it("`nothing new to add` is EMPTY: a base set with no ladder is a verdict", () => {
    const r = drive([{ title: "1990_Baseball_Wit", year: 1990, setName: "Baseball Wit", yields: "noLadder" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(r.out).toMatch(/EMPTY —/);
    expect(r.out).not.toMatch(/FAILED —/);
    expect(statusOf(r.control, "Baseball_Wit")).toBe(EMPTY_STATUS);
    expect(r.code).toBe(0);
  });

  it("`0 base cards — layout not understood` stays a FAULT: the rows are there, we cannot read them", () => {
    // 1990_Bazooka carries 22 cards under a `Checklist` heading and no
    // `Base_Set` heading at all. Calling that "empty at source" would file our
    // own parser gap as the wiki's answer and retire it silently.
    const r = drive([{ title: "1990_Bazooka", year: 1990, setName: "Bazooka", yields: "noBase" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    const status = statusOf(r.control, "Bazooka");
    expect(status).not.toBe(EMPTY_STATUS);
    expect(STREAK_STATUSES.has(status)).toBe(true);
    // ...and it names the defect, so a fix can find its own rows.
    expect(String(docFor(r.control, "Bazooka").reason)).toMatch(/parser does not read|Base_Set heading/);
  });

  it("a 404 is `unreachable`, not `failed` — the page is gone, our pipe is fine", () => {
    const r = drive([{ title: "1990_Missing_Page", year: 1990, setName: "Missing Page", yields: "gone" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(statusOf(r.control, "Missing_Page")).toBe("unreachable");
  });

  it("an UNNUMBERED ROSTER is EMPTY — the source states no card number to key", () => {
    // 1999 Team Best Autographs: 70 real player names, and the wiki publishes
    // not one card number. The catalog keys a card by cardNumber and the
    // ingester drops a row without one, so the only way to "read" this page
    // would be to invent a numbering the source never published.
    const r = drive([{ title: "1999_Team_Best_Autographs", year: 1999, setName: "Team Best Autographs", yields: "roster" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(statusOf(r.control, "Team_Best_Autographs")).toBe(EMPTY_STATUS);
    expect(r.code).toBe(0);
    // The control doc says WHICH shape, so the 62 can be told apart later.
    expect(String(docFor(r.control, "Team_Best_Autographs").reason)).toMatch(/UNNUMBERED ROSTER/);
  });

  it("a STUB page is EMPTY — headings with nothing under them", () => {
    const r = drive([{ title: "2010_SP_Authentic", year: 2010, setName: "SP Authentic", yields: "stub" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(statusOf(r.control, "SP_Authentic")).toBe(EMPTY_STATUS);
    expect(String(docFor(r.control, "SP_Authentic").reason)).toMatch(/STUB/);
  });

  it("a SINGLE-CARD promo page is EMPTY, not a set we failed to parse", () => {
    const r = drive([{ title: "2004-05_Speed_Stick", year: 2004, setName: "Bowman Chrome Speed Stick", yields: "singleCard" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(statusOf(r.control, "Speed_Stick")).toBe(EMPTY_STATUS);
    expect(String(docFor(r.control, "Speed_Stick").reason)).toMatch(/SINGLE-CARD/);
  });

  it("the three no-number shapes are streak-neutral, so they cannot abort the lane", () => {
    // This is the whole point: 62 control docs carried the parser-gap message,
    // and three consecutive `failed` entries abort the lane. Before this
    // change a run that met three of these in a row stranded everything
    // behind them.
    const specs: Spec[] = [
      { title: "1993_Nabisco", year: 1993, setName: "Nabisco All-Star Autographs", yields: "roster" },
      { title: "2010_SP_Authentic", year: 2010, setName: "SP Authentic", yields: "stub" },
      { title: "2004-05_Speed_Stick", year: 2004, setName: "Speed Stick", yields: "singleCard" },
      { title: "2011_Topps_Chrome", year: 2011, setName: "Topps Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "4", BACKFILL_APPLY: "true",
      TITLES: "1993 Nabisco All-Star Autographs,2010 SP Authentic,2004 Speed Stick,2011 Topps Chrome" });
    // The work BEHIND the three still ran, which it could not have done if
    // they had advanced the streak.
    expect(statusOf(r.control, "Topps_Chrome")).toBe("ingested");
    expect(r.out).not.toMatch(/systemic/i);
  });

  it("a shape we have NOT classified still stays a parser gap", () => {
    // The mapping matches three explicit strings, never a catch-all, so an
    // unrecognised layout keeps its fault verdict rather than going quiet.
    const r = drive([{ title: "1990_Bazooka", year: 1990, setName: "Bazooka", yields: "noBase" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    expect(statusOf(r.control, "Bazooka")).not.toBe(EMPTY_STATUS);
  });

  it("a scraper that genuinely crashes is still FAILED", () => {
    // The classification must not swallow real breakage.
    const r = drive([{ title: "1990_Crash", year: 1990, setName: "Crash", yields: "throw" }],
      { LIMIT: "1", BACKFILL_APPLY: "true" });
    const status = statusOf(r.control, "Crash");
    expect(status).not.toBe(EMPTY_STATUS);
    expect(STREAK_STATUSES.has(status)).toBe(true);
  });
});

// ── PIN 2: EMPTY is streak-neutral, so a base-only run of pages cannot abort ──

describe("bcp — base-only pages do not abort the lane", () => {
  it("`empty` never advances the systemic streak", () => {
    expect(STREAK_STATUSES.has(EMPTY_STATUS)).toBe(false);
  });

  it("six consecutive base-only pages still let the work behind them run", () => {
    // 1,873 of the lane's 3,157 entries are seeded "NO parallel ladder
    // (base-only)" -- 59.3%. A lane where the MAJORITY of entries correctly
    // answer EMPTY must not treat a run of them as an outage.
    const specs: Spec[] = [
      { title: "1990_A", year: 1990, setName: "A Oddball", yields: "noLadder" },
      { title: "1990_B", year: 1990, setName: "B Oddball", yields: "noLadder" },
      { title: "1990_C", year: 1990, setName: "C Oddball", yields: "noLadder" },
      { title: "1990_D", year: 1990, setName: "D Oddball", yields: "noLadder" },
      { title: "1990_E", year: 1990, setName: "E Oddball", yields: "noLadder" },
      { title: "1990_F", year: 1990, setName: "F Oddball", yields: "noLadder" },
      { title: "2011_Topps_Chrome", year: 2011, setName: "Topps Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "7", BACKFILL_APPLY: "true" });
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.out).toMatch(/RECONCILED\s+yes/);
    expect(r.out).toMatch(/empty at source\s+6/);
    expect(statusOf(r.control, "2011_Topps_Chrome")).toBe("ingested");
    expect(r.code).toBe(0);
  });

  it("the exact run-33852199385 tail no longer aborts", () => {
    // Entries 15/16/17 of the incident: three "no CSV" in a row. Two are parser
    // gaps and stay faults; the third is genuinely empty and is now streak-
    // neutral, so the streak never reaches three and the work behind is reached.
    const specs: Spec[] = [
      { title: "1990_Fleer_Award_Winners", year: 1990, setName: "Fleer Award Winners", yields: "noBase" },
      { title: "1990_Fleer_Baseball_All-Stars", year: 1990, setName: "Fleer Baseball All-Stars", yields: "noBase" },
      { title: "1990_Donruss_The_Rookies", year: 1990, setName: "Donruss The Rookies", yields: "noLadder" },
      { title: "2019_Topps_Chrome", year: 2019, setName: "Topps Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "4", BACKFILL_APPLY: "true" });
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(statusOf(r.control, "2019_Topps_Chrome")).toBe("ingested");
    expect(r.code).toBe(0);
  });
});

// ── PIN 3: the budget marker means a BUDGET stop, not a finished slice ───────
//
// CF-A-LIMIT-BOUND-RUN-IS-NOT-A-BUDGET-STOP (2026-09-04, run 33854416984).
//
// sportscardchecklist, limit=3, took exactly its three entries: "intended 3 =
// written 3", not reached 0, RECONCILED yes. It STILL printed "stopped at the
// 140-minute budget — the relaunch continues from here", because the condition
// was `stoppedOnBudget || written >= LIMIT` and 3 >= 3. The runner's relaunch
// step greps for that line, so it re-dispatched the same limit=3 inputs, which
// took the same three entries, and the lane looped (33854423019, 33854625169)
// until it was cancelled by hand.

describe("the budget marker gates the relaunch, so it must mean what it says", () => {
  const marker = /stopped at the .*-minute budget — the relaunch continues from here/;

  it("a run that exhausts its LIMIT with work left prints NO marker", () => {
    // The incident shape: LIMIT smaller than the lane, every entry attempted.
    const specs: Spec[] = [
      { title: "2011_Topps_Chrome", year: 2011, setName: "Topps Chrome", yields: "csv" },
      { title: "2019_Topps_Chrome", year: 2019, setName: "Topps Chrome", yields: "csv" },
      { title: "2021_Topps_Chrome", year: 2021, setName: "Topps Chrome", yields: "csv" },
      { title: "2015_Bowman_Chrome", year: 2015, setName: "Bowman Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "3", BACKFILL_APPLY: "true", RUN_MINUTES: "140" });

    expect(r.out).toMatch(/not reached\s+0/);
    expect(r.out).toMatch(/RECONCILED\s+yes/);
    // There IS more work -- which is exactly why the old condition fired.
    expect(r.out).toMatch(/remaining in lane\s+1/);
    // ...and the marker must NOT, or the relaunch loops on identical inputs.
    expect(r.out).not.toMatch(marker);
    // It says the true thing instead.
    expect(r.out).toMatch(/slice complete/);
    expect(r.code).toBe(0);
  });

  it("a run that drains the lane prints no marker either", () => {
    const specs: Spec[] = [
      { title: "2011_Topps_Chrome", year: 2011, setName: "Topps Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "1", BACKFILL_APPLY: "true", RUN_MINUTES: "140" });
    expect(r.out).not.toMatch(marker);
    expect(r.out).toMatch(/lane complete/);
  });

  it("a GENUINE budget stop, with entries never attempted, still prints it", () => {
    // RUN_MINUTES tiny, so the per-entry reserve trips the clock before the
    // slice is finished and `notReached` is non-zero. This is the case the
    // relaunch exists for, and it must survive the fix.
    const specs: Spec[] = [];
    for (let i = 0; i < 12; i++) {
      specs.push({ title: `20${10 + i}_Topps_Chrome`, year: 2010 + i, setName: "Topps Chrome", yields: "csv" });
    }
    const r = drive(specs, { LIMIT: "12", BACKFILL_APPLY: "true", RUN_MINUTES: "1" });
    expect(r.out).toMatch(/not reached\s+[1-9]/);
    expect(r.out).toMatch(marker);
  });

  it("a lane abort never prints it, whatever the clock did", () => {
    const specs: Spec[] = [
      { title: "1990_X", year: 1990, setName: "X Oddball", yields: "throw" },
      { title: "1990_Y", year: 1990, setName: "Y Oddball", yields: "throw" },
      { title: "1990_Z", year: 1990, setName: "Z Oddball", yields: "throw" },
      { title: "2011_Topps_Chrome", year: 2011, setName: "Topps Chrome", yields: "csv" },
    ];
    const r = drive(specs, { LIMIT: "4", BACKFILL_APPLY: "true", RUN_MINUTES: "140" });
    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.out).not.toMatch(marker);
    expect(r.code).toBe(5);
  });
});

// ── PIN 4: the remainder behind a titles list is VALUE-ordered ───────────────

describe("orderQueue — the rest follow beneath in value order, not alphabetically", () => {
  // The real manifest slice, so the pin is about the lane that actually ran.
  const manifest = require_(path.join(backend, "data", "ingest-universe.json"));
  const entries = (Array.isArray(manifest) ? manifest : manifest.entries).filter((e: any) => e.lane === "bcp");
  const queue = entries.map((entry: any) => ({ entry }));
  const label = (x: any) => `${x.entry.year} ${x.entry.setName}`;

  it("the real bcp lane is present in the manifest", () => {
    expect(entries.length).toBeGreaterThan(2500);
  });

  it("with a titles list, the named entries still lead in the order given", () => {
    const titles = "2011 Topps Chrome,2015 Bowman Chrome,2019 Topps Chrome,2021 Topps Chrome";
    const { queue: q, named, unmatched } = orderQueue(queue, titles);
    expect(named).toBe(4);
    expect(unmatched).toEqual([]);
    expect(q.slice(0, 4).map(label))
      .toEqual(["2011 Topps Chrome", "2015 Bowman Chrome", "2019 Topps Chrome", "2021 Topps Chrome"]);
  });

  it("THE INCIDENT: entry 5 is a modern flagship, NOT `1990 Baseball Wit`", () => {
    const titles = "2011 Topps Chrome,2015 Bowman Chrome,2019 Topps Chrome,2021 Topps Chrome";
    const { queue: q } = orderQueue(queue, titles);
    const next16 = q.slice(4, 20).map(label);

    // The regression, stated as the run stated it.
    expect(next16[0]).not.toBe("1990 Baseball Wit");
    expect(next16).not.toContain("1990 Bazooka");
    expect(next16).not.toContain("1990 Donruss Learning Series");
    expect(next16).not.toContain("1990 Fleer Award Winners");

    // What the proxy promised: the modern flagships lead. A STAGED entry may
    // still precede them whatever its year -- #1718's contract, and the reason
    // this is a floor on the chrome count rather than a floor on every year.
    expect(next16.filter((l: string) => /topps chrome|bowman chrome/i.test(l)).length).toBeGreaterThanOrEqual(8);
    // Every non-staged entry in the head is modern.
    const stagedCount = orderQueue(queue, titles).staged;
    for (const l of next16.slice(stagedCount)) {
      expect(Number(String(l).slice(0, 4))).toBeGreaterThanOrEqual(2000);
    }
  });

  it("the banner says the remainder is value-ordered, so the operator can see it", () => {
    const { mode } = orderQueue(queue, "2011 Topps Chrome");
    expect(mode).toMatch(/explicit list/);
    expect(mode).toMatch(/value-proxy/);
  });

  it("with no titles, ordering is unchanged (the #1718 staged-first contract)", () => {
    const { queue: q, mode, named, staged } = orderQueue(queue, "");
    expect(named).toBe(0);
    expect(mode).toMatch(/value-proxy/);
    // Staged entries lead regardless of era (#1718); everything behind them is
    // the value proxy, so the modern flagships head the un-staged remainder.
    const head = q.slice(staged, staged + 10).map(label);
    for (const l of head) expect(Number(String(l).slice(0, 4))).toBeGreaterThanOrEqual(2000);
    expect(head.filter((l: string) => /chrome/i.test(l)).length).toBeGreaterThanOrEqual(8);
  });

  it("an unmatched title is still reported, never silently dropped", () => {
    const { named, unmatched } = orderQueue(queue, "2011 Topps Chrome,No Such Page 1234");
    expect(named).toBe(1);
    expect(unmatched).toEqual(["No Such Page 1234"]);
  });
});
