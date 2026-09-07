import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-CLEAN-CENSUS-MUST-EXIT-ZERO (2026-09-07, #1942 follow-up).
 *
 * All 64 slots of the duplicate-sale-ids sweep ran on 2026-09-07, walked the
 * whole 16.8M-row corpus, measured 196,143 duplicate ids and 201,522 excess
 * documents, and printed
 *
 *   RECONCILED  documents 6,119 = ids 3,021 + excess 3,098; verdicts sum to
 *   3,021  -> OK
 *
 * on slot 0 and the equivalent on the other 63. Every one of them then
 * concluded `failure`:
 *
 *   FATAL: ReferenceError: writeCensus is not defined
 *       at main (backend/scripts/census-duplicate-sale-ids.cjs:268:20)
 *   finishLane: exiting code 3
 *
 * #1942 shipped the CALL and not the FUNCTION, at the last statement of a
 * 15-minute lane. Two things then compounded it, and both are pinned here.
 *
 * 1. THE EXIT CODE IS THE ONLY FIELD THE RUNNER READS. The relaunch step
 *    classifies a run by (a) budget marker -> re-dispatch, (b) finishLane line
 *    AND step outcome success -> done, (c) neither -> KILLED, fail loudly. A
 *    crash after the banner has a finishLane line but a FAILED outcome, so all
 *    64 runs fell to (c) and were reported as killed-at-the-ceiling runs that
 *    had in fact finished. A census that completes must exit 0, or the runner
 *    cannot tell a finished sweep from a dead one.
 *
 * 2. THE BUDGET MARKER MUST BE ABSENT WHEN THE LANE FINISHED. The marker is
 *    what makes the runner re-dispatch (CF-RELAUNCH-ONLY-ON-BUDGET, #1361).
 *    Printing it on a completed run would have re-dispatched all 64 slots
 *    forever; withholding it on a truncated run silently loses the tail. So it
 *    is asserted in BOTH directions.
 *
 * The test drives the REAL script against a stubbed @azure/cosmos, because
 * that is the only shape that catches this class of defect: every unit test of
 * the rule library passed while the lane that calls it could not reach its own
 * last line.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "..");
const script = path.join(backend, "scripts", "census-duplicate-sale-ids.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dupcensus-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** One scanned sold_comps row, as the walk's projection returns it. */
type Row = { id: string; cardId: string; hobbyiqCardId: string; source: string; _ts: number };

/**
 * A duplicate: ONE sale id as TWO documents under two partitions. The newer
 * copy is address-coherent and catalog-backed, the older is not, so
 * decideCanonical returns CANONICAL and parks exactly the older copy.
 */
const DUP_ID = "tca-ebay::267679692186";
const GOOD = "hiq:baseball:2024:bowman-chrome:cpa-jg:refractor:auto";
const BAD = "hiq:baseball:2024:bowman:cpa-jg:base:auto";

const ROWS: Row[] = [
  { id: DUP_ID, cardId: GOOD, hobbyiqCardId: GOOD, source: "tca-ebay", _ts: 1_788_000_200 },
  { id: DUP_ID, cardId: BAD, hobbyiqCardId: GOOD, source: "tca-ebay", _ts: 1_788_000_100 },
  // A plain, unduplicated sale, so the census is not measuring a corpus that
  // is nothing but damage.
  { id: "tca-ebay::111", cardId: GOOD, hobbyiqCardId: GOOD, source: "tca-ebay", _ts: 1_788_000_150 },
];

/**
 * The stub. `card_catalog` resolves GOOD and not BAD, which is what makes the
 * newer copy canonical and the older one an excess to park.
 */
function shimOf(): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const src = [
    'const Module = require("module");',
    `const ROWS = ${JSON.stringify(ROWS)};`,
    `const CATALOG = ${JSON.stringify([GOOD])};`,
    "",
    "function answer(query, parameters) {",
    "  const p = Object.fromEntries((parameters || []).map((x) => [x.name, x.value]));",
    '  if (query.indexOf("MIN(c._ts)") >= 0) return [Math.min.apply(null, ROWS.map((r) => r._ts))];',
    '  if (query.indexOf("MAX(c._ts)") >= 0) return [Math.max.apply(null, ROWS.map((r) => r._ts))];',
    '  if (query.indexOf("COUNT(1)") >= 0) return [ROWS.filter((r) => r._ts >= p["@lo"] && r._ts < p["@hi"]).length];',
    '  if (query.indexOf("c.id IN") >= 0) {',
    "    const wanted = new Set(Object.keys(p).map((k) => p[k]));",
    "    return CATALOG.filter((id) => wanted.has(id));",
    "  }",
    '  return ROWS.filter((r) => r._ts >= p["@lo"] && r._ts < p["@hi"]);',
    "}",
    "",
    "const stub = {",
    "  CosmosClient: class {",
    "    database() {",
    "      return {",
    "        container() {",
    "          return {",
    "            items: {",
    "              query(spec) {",
    "                const rows = answer(spec.query, spec.parameters);",
    "                let drained = false;",
    "                return {",
    "                  fetchAll: async () => ({ resources: rows, requestCharge: 1 }),",
    "                  hasMoreResults: () => !drained,",
    "                  fetchNext: async () => { drained = true; return { resources: rows, requestCharge: 1 }; },",
    "                };",
    "              },",
    "            },",
    "          };",
    "        },",
    "      };",
    "    }",
    "    dispose() {}",
    "  },",
    "};",
    "const realLoad = Module._load;",
    "Module._load = function (request) {",
    '  if (request === "@azure/cosmos") return stub;',
    "  return realLoad.apply(this, arguments);",
    "};",
    "",
  ].join("\n");
  fs.writeFileSync(p, src);
  return p;
}

function drive(env: Record<string, string> = {}) {
  const out = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`);
  const shim = shimOf();
  const base = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
    CENSUS_OUT: out,
    SLOT: "0",
    SLOTS: "1",
    RUN_MINUTES: "60",
    ...env,
  };
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: backend, env: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout, dir: out };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? ""), dir: out };
  }
}

const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// ── PIN 1: a census that completes exits 0 ───────────────────────────────────

describe("a clean census exits zero", () => {
  it("reconciles, writes its artifact and exits 0 — never a ReferenceError", () => {
    const r = drive();
    // The defect, named directly: the crash was AFTER the banner, so asserting
    // only on the banner is what let this ship.
    expect(r.out).not.toMatch(/ReferenceError/);
    expect(r.out).not.toMatch(/FATAL/);
    expect(r.out).toMatch(/RECONCILED .* -> OK/);
    expect(r.out).toMatch(/finishLane: exiting code 0/);
    expect(r.code).toBe(0);
  });

  it("the census artifact is a real file naming the slot and the counts", () => {
    const r = drive();
    const files = filesIn(r.dir).filter((n) => n.startsWith("duplicate-sale-ids-census-slot-"));
    expect(files).toHaveLength(1);
    const doc = JSON.parse(fs.readFileSync(path.join(r.dir, files[0]), "utf8"));
    expect(doc.lane).toBe("census-duplicate-sale-ids");
    expect(doc.dupIds).toBe(1);
    expect(doc.excessDocs).toBe(1);
    expect(doc.reconciled).toBe(true);
    // A finished run says so IN the artifact, so a later reader never has to
    // infer it from a log they may not still have.
    expect(doc.stoppedAtBudget).toBe(false);
    expect(doc.stopReason).toBeNull();
  });
});

// ── PIN 2: the budget marker means budget, in both directions ────────────────

describe("the budget marker is printed only when work is left", () => {
  it("a completed census does NOT print it — the runner must not re-dispatch", () => {
    const r = drive();
    expect(r.out).not.toMatch(/stopped at the \d+-minute budget/);
    expect(r.code).toBe(0);
  });

  it("a truncated census DOES say so, and still exits 0", () => {
    // LIMIT stops the walk exactly as the budget does: work is left, so a stop
    // reason must appear, and the run is still a successful partial census.
    //
    // The check sits at the CHUNK and PAGE boundaries, never mid-page, which
    // is deliberate: a row is folded into the id map or it is not, and half a
    // page is not a unit. So the corpus is split into several chunks
    // (ROWS_PER_CHUNK=1 bisects the _ts space) and LIMIT is crossed at a real
    // boundary — the same shape the 120-minute budget stop takes in prod.
    const r = drive({ LIMIT: "1", ROWS_PER_CHUNK: "1" });
    expect(r.out).toMatch(/stopped at LIMIT/);
    expect(r.code).toBe(0);
  });
});

// ── PIN 3: the PARK lists are the remedy, and they are opt-in ────────────────

describe("--emit-list writes relocate-pool-rows-by-list PARK entries", () => {
  it("writes nothing by default — a census is report-first", () => {
    const r = drive();
    expect(filesIn(r.dir).filter((n) => n.startsWith("park-"))).toHaveLength(0);
    expect(r.out).not.toMatch(/PARK LISTS/);
  });

  it("parks the EXCESS copy only, keyed on (id, fromCardId), never a delete", () => {
    const r = drive({ EMIT_LIST: "true" });
    expect(r.code).toBe(0);
    const files = filesIn(r.dir).filter((n) => n.startsWith("park-"));
    expect(files).toHaveLength(1);
    const doc = JSON.parse(fs.readFileSync(path.join(r.dir, files[0]), "utf8"));
    expect(doc.lane).toBe("relocate-pool-rows-by-list");
    expect(doc.reason).toBe("duplicate-partition-copy");
    expect(doc.entries).toHaveLength(1);

    const [e] = doc.entries;
    // The canonical copy is the coherent, catalog-backed one; the OTHER
    // document is what gets parked. Parking the wrong one moves a good sale
    // out of a good pool, so this assertion is the point of the whole lane.
    expect(e.id).toBe(DUP_ID);
    expect(e.fromCardId).toBe(BAD);
    expect(e.parkIdentityUnverified).toBe(true);
    expect(e.evidence).toMatch(/^duplicate-partition-copy: CANONICAL/);
    // CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE.
    expect(JSON.stringify(doc)).not.toMatch(/"delete"|"remove"/);
  });

  it("the part number is in the file name, so a 2,000-entry cap is reviewable", () => {
    const r = drive({ EMIT_LIST: "true", LIST_MAX: "1" });
    const files = filesIn(r.dir).filter((n) => n.startsWith("park-"));
    expect(files[0]).toMatch(/part-001\.json$/);
    for (const name of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(r.dir, name), "utf8"));
      expect(doc.entries.length).toBeLessThanOrEqual(1);
    }
  });
});
