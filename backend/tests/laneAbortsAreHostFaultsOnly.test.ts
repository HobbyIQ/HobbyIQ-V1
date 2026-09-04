import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const {
  streakAfter,
  gateStagedEntry,
  setKeyCandidates,
  canonicalSetKey,
  setKeyFor,
  SYSTEMIC_FAILURE_STREAK,
} = require_(driver);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-lane-pin-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * PIN — THE STREAK MAY CONCLUDE EXACTLY ONE THING: THE HOST IS DOWN.
 *
 * Two full-lane applies on 2026-09-04 aborted on a 3-streak built almost
 * entirely out of verdicts we could only have reached by successfully fetching
 * and parsing the page:
 *
 *   scc  33870669723  intended 198, 176 unattempted. Entries 20-21-22 were
 *        REFUSED(zero base) / FAILED(green ingest, 0 landed) / REFUSED(zero
 *        base) -- the "...Refractors" half of each 2000-01 Topps Chrome subset
 *        pair, which correctly has no base cards of its own.
 *   bcp  33869931267  intended 119, aborted on parser-gap / green-ingest /
 *        short-ingest.
 *
 * #1735 drew the line for hobbymonitor. These are the same line, on two more
 * lanes.
 *
 * HOW THESE ARE PINNED (rewritten 2026-09-04). The original file asserted four
 * of its rules by GREPPING THE DRIVER'S SOURCE TEXT. The driver has been
 * refactored six times since it was written (#1741 parallel-of-parent, #1742
 * unmatched-title refusal, #1743 refetch, #1746 partial terminal + sibling
 * ladders, #1749 setKeyCandidates + PERIOD_RUNG, #1750), and each refactor put
 * a source-text pin one edit away from a red that says nothing about
 * behaviour -- while a genuine behaviour change that happened to keep the
 * literal string would have stayed green. So every rule here now DRIVES THE
 * COMMITTED SCRIPT through the stubbed harness (the house pattern of
 * ingestUniverseDriverLaneContinues.test.ts) or calls its exported function.
 * Each rule keeps a mutation red, named in its own comment.
 */

// ── the harness ──────────────────────────────────────────────────────────────
//
// The driver shells out to the lane child with execFileSync and talks to Cosmos
// through @azure/cosmos. Both are replaced by a shim injected with NODE_OPTIONS
// --require, so the script under test is the committed file, unmodified: the
// shim intercepts the module boundary, not the logic.

/**
 * What the stubbed lane child does for one entry.
 *
 *   "csv"        stages a clean base+ladder CSV -- the healthy path.
 *   "parserGap"  stages nothing and prints the bcp scraper's own
 *                "0 base cards — layout not understood, SKIPPED". The wiki
 *                served the page; we could not read a heading level.
 *   "throw"      the fetch itself failed (ENOTFOUND) -- the ONLY shape that
 *                is evidence about the host.
 *   "zeroBase"   stages a Refractors-only page: every row carries a parallel,
 *                so the cleanliness gate refuses it as a CONTENT refusal.
 *   "noCsv"      stages nothing and says nothing -- a broken pipe.
 */
type Yield = "csv" | "parserGap" | "throw" | "zeroBase" | "noCsv";
type EntrySpec = { setName: string; year: number; yields: Yield };

const titleOf = (s: EntrySpec) => `${s.year}_${s.setName.replace(/ /g, "_")}`;

function manifestOf(specs: EntrySpec[], lane = "bcp"): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      id: `${lane}::http://www.baseballcardpedia.com/index.php/${titleOf(s)}`,
      lane,
      sourceRef: `http://www.baseballcardpedia.com/index.php/${titleOf(s)}`,
      sport: "baseball",
      year: s.year,
      setName: s.setName,
      seededStatus: "partial",
    })),
    unreachable: [],
  }));
  return p;
}

/**
 * `catalogRows` is what the stubbed Cosmos reports for countCatalogRows, in
 * order, one answer per read. `0` is the "green ingest, 0 rows landed" shape.
 * `catalogSink` records every (year, setKey) the driver actually asked for, so
 * a pin can assert WHICH PRODUCT was read rather than grepping for the call.
 */
function shimOf(specs: EntrySpec[], opts: { catalogRows?: number[]; catalogSink?: string } = {}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const behaviour: Record<string, Yield> = {};
  for (const s of specs) behaviour[titleOf(s)] = s.yields;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const BEHAVIOUR = ${JSON.stringify(behaviour)};
const CATALOG_ROWS = ${JSON.stringify(opts.catalogRows ?? null)};
const CATALOG_SINK = ${JSON.stringify(opts.catalogSink ?? null)};
const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

function cleanCsv() {
  const rows = [HEADER];
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",,false,,Player " + i + " Name");
  for (let i = 1; i <= 20; i++) rows.push("base," + i + ",Gold Refractor,false,/50,Player " + i + " Name");
  return rows.join("\\n") + "\\n";
}

// The exact shape of scc entry [10/198]: a Refractors-only subset page. Every
// row carries a parallel, so the product has no base print of its own.
function refractorsOnlyCsv() {
  const rows = [HEADER];
  for (let i = 1; i <= 40; i++) rows.push("base," + i + ",Gold Refractor,false,/50,Player " + i + " Name");
  return rows.join("\\n") + "\\n";
}

// ── the lane child ──
const cp = require("node:child_process");
cp.execFileSync = function (file, args, options) {
  const titleArg = (args || []).find((a) => String(a).startsWith("--titles="));
  if (titleArg) {
    const title = String(titleArg).slice("--titles=".length);
    const outArg = (args || []).find((a) => String(a).startsWith("--outDir="));
    const outDir = String(outArg).slice("--outDir=".length);
    const mode = BEHAVIOUR[title] || "csv";
    if (mode === "throw") throw new Error("fetch failed ENOTFOUND baseballcardpedia.com");
    fs.mkdirSync(outDir, { recursive: true });
    if (mode === "csv") fs.writeFileSync(path.join(outDir, title + ".csv"), cleanCsv());
    if (mode === "zeroBase") fs.writeFileSync(path.join(outDir, title + ".csv"), refractorsOnlyCsv());
    // The scraper exits 0 and SAYS which of its two nothings it means. This is
    // the string the driver reads to decide parser-gap vs broken pipe.
    if (mode === "parserGap") return "0 base cards — layout not understood, SKIPPED";
    return "";
  }
  // The ingest child lands nothing; the catalog stub below reports the rows.
  return "";
};

// ── Cosmos ──
const CONTROL = [];
let catalogRead = 0;
const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          return {
            item(id) { return { read: async () => ({ resource: null }) }; },
            items: {
              query(q) {
                if (name === "card_catalog") {
                  if (CATALOG_SINK && q && q.parameters) {
                    const seen = fs.existsSync(CATALOG_SINK) ? JSON.parse(fs.readFileSync(CATALOG_SINK, "utf8")) : [];
                    const by = {};
                    for (const pr of q.parameters) by[pr.name] = pr.value;
                    seen.push({ query: String(q.query), params: by });
                    fs.writeFileSync(CATALOG_SINK, JSON.stringify(seen));
                  }
                  // A by-source count is a strictly additional read and must not
                  // consume the scripted answers the product count is reading.
                  if (String(q && q.query).includes("c.source")) return { fetchAll: async () => ({ resources: [0] }) };
                  const n = CATALOG_ROWS === null ? 40 : (CATALOG_ROWS[catalogRead] ?? CATALOG_ROWS[CATALOG_ROWS.length - 1] ?? 0);
                  catalogRead++;
                  return { fetchAll: async () => ({ resources: [n] }) };
                }
                return { fetchAll: async () => ({ resources: [] }) };
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

function drive(
  specs: EntrySpec[],
  env: Record<string, string> = {},
  opts: { catalogRows?: number[]; catalogSink?: string } = {},
) {
  const sink = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  const shim = shimOf(specs, opts);
  const run = () => execFileSync(process.execPath, [driver], {
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
      LIMIT: String(specs.length),
      BACKFILL_APPLY: "true",
      BCP_TITLES: specs.map((s) => `${s.year} ${s.setName}`).join(","),
      ...env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const out = run();
    return { code: 0, out, control: JSON.parse(fs.readFileSync(sink, "utf8")) as any[] };
  } catch (e: any) {
    return {
      code: e.status as number,
      out: String(e.stdout ?? "") + String(e.stderr ?? ""),
      control: JSON.parse(fs.readFileSync(sink, "utf8")) as any[],
    };
  }
}

/** N entries of one shape, then two good ones the lane must still reach. */
function streakThenGood(yields: Yield): EntrySpec[] {
  const specs: EntrySpec[] = [];
  for (let i = 0; i < SYSTEMIC_FAILURE_STREAK; i++) specs.push({ setName: `Probe ${i}`, year: 2000 + i, yields });
  specs.push({ setName: "Topps Chrome", year: 2011, yields: "csv" });
  specs.push({ setName: "Bowman Chrome", year: 2015, yields: "csv" });
  return specs;
}

describe("a per-entry answer never votes the lane down", () => {
  it("zero-base is a CONTENT refusal — it proves the lane is up and resets the streak", () => {
    // The gate's own answer, from the committed gate.
    const dir = fs.mkdtempSync(path.join(tmp, "zb-"));
    const csv = path.join(dir, "refractors-only.csv");
    fs.writeFileSync(csv, ["category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,Refractor,false,,Kobe Bryant",
      "base,2,Refractor,false,,Tim Duncan",
      "base,3,Refractor,false,,Kevin Garnett"].join("\n"));
    const gate = gateStagedEntry([csv], "sportscardchecklist");
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/zero base cards/);
    // THE FLAG. Before the fix this return set no `contentRefusal` at all, so
    // `laneProvenHealthy` was false and the refusal advanced the streak.
    expect(gate.contentRefusal).toBe(true);
    // And through the tripwire's own arithmetic.
    const verdict = { status: "failed", laneProvenHealthy: gate.contentRefusal === true };
    expect(streakAfter(0, verdict)).toBe(0);
    expect(streakAfter(2, verdict)).toBe(0);
  });

  it("DRIVEN: a whole lane of zero-base pages never aborts — the good entries are still reached", () => {
    // MUTATION RED: drop `contentRefusal` from gateStagedEntry's refusal
    // return, or drop `laneProvenHealthy: gate.contentRefusal === true` from
    // the cleanliness-gate verdict, and SYSTEMIC_FAILURE_STREAK of these
    // aborts the lane -- exactly the scc 33870669723 loss.
    const specs = streakThenGood("zeroBase");
    const r = drive(specs);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.out).toMatch(/REFUSED — .*zero base cards/);
    expect(r.code).toBe(0);
    // Every entry got a verdict, including the two beyond the would-be streak.
    expect(r.control.length).toBe(specs.length);
    expect(r.control.some((d) => String(d.entryId).includes("2011_Topps_Chrome"))).toBe(true);
  });

  it("the scc abort sequence 20-21-22 no longer reaches the tripwire", () => {
    const zeroBase = { status: "failed", laneProvenHealthy: true };   // REFUSED — zero base cards
    const greenZero = { status: "failed", laneProvenHealthy: true };  // FAILED — green ingest, 0 landed
    let streak = 0;
    for (const v of [zeroBase, greenZero, zeroBase]) streak = streakAfter(streak, v);
    expect(streak).toBe(0);
  });

  it("a missing staged file is NOT a content refusal — a broken pipe still trips", () => {
    // The one refusal that means acquisition delivered nothing. It must keep
    // its vote, or a genuinely dead lane runs to the end of its budget.
    const gate = gateStagedEntry([], "bcp");
    expect(gate.ok).toBe(false);
    expect(gate.contentRefusal).toBe(false);
    expect(streakAfter(2, { status: "failed", laneProvenHealthy: gate.contentRefusal === true })).toBe(3);
  });

  it("DRIVEN: a lane whose scraper stages nothing and says nothing DOES abort", () => {
    // The other half of the rule, and the reason it is not simply "never
    // abort": a dead lane must stop rather than burn its budget. MUTATION RED:
    // flag "no CSV" as a content refusal and this stops aborting.
    const specs = streakThenGood("noCsv");
    const r = drive(specs);
    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(5);
    expect(r.control.length).toBe(SYSTEMIC_FAILURE_STREAK);
    expect(r.control.some((d) => String(d.entryId).includes("2011_Topps_Chrome"))).toBe(false);
  });

  it("DRIVEN: a bcp parser gap carries the flag — a lane of them keeps running", () => {
    // WAS: two greps for `e.laneProvenHealthy = true;\n throw e;` and for the
    // spread that carries it into the verdict. Both matched source text that
    // six refactors have since moved. This drives the committed acquisition:
    // the stubbed scraper exits 0 with the wiki's own "0 base cards — layout
    // not understood, SKIPPED", which is a PARSER gap -- we read every byte of
    // the page, so the host is provably up.
    //
    // MUTATION RED: delete `e.laneProvenHealthy = true` on that throw, or drop
    // the `...(e?.laneProvenHealthy ? ... : {})` spread from the acquisition
    // catch, and SYSTEMIC_FAILURE_STREAK of these aborts the lane.
    const specs = streakThenGood("parserGap");
    const r = drive(specs);
    expect(r.out).toMatch(/parser gap, not an empty page/);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(0);
    expect(r.control.length).toBe(specs.length);
    // It is still a FAILED verdict -- it must keep bringing someone back to it.
    const gap = r.control.find((d) => String(d.entryId).includes("2000_Probe_0"));
    expect(gap.status).toBe("failed");
    expect(String(gap.reason)).toMatch(/parser does not read/);
    // And the two good entries beyond the would-be streak were reached.
    expect(r.control.some((d) => String(d.entryId).includes("2011_Topps_Chrome"))).toBe(true);
  });

  it("DRIVEN: a real fetch failure still advances — the parser-gap flag is not a blanket amnesty", () => {
    // The control for the pin above: the SAME lane, the SAME count, the only
    // difference being that the fetch never landed. This must abort.
    const r = drive(streakThenGood("throw"));
    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(5);
    expect(r.control.length).toBe(SYSTEMIC_FAILURE_STREAK);
  });

  it("DRIVEN: post-ingest failures are per-entry — the ingest ran, so the host answered", () => {
    // WAS: two greps for the literal verdict-object source of "green ingest, 0
    // rows landed" and "cannot verify by read". This drives it: the scraper
    // stages a clean CSV, the gate passes, the ingest child runs, and the
    // catalog read comes back 0 -- so the host answered at every step and the
    // defect is ours.
    //
    // MUTATION RED: drop `laneProvenHealthy: true` from the `after === 0`
    // verdict and SYSTEMIC_FAILURE_STREAK of these aborts the lane.
    const specs = streakThenGood("csv");
    // Every catalog read answers 0: before=0, after=0 -> green ingest, 0 landed.
    const r = drive(specs, {}, { catalogRows: [0] });
    expect(r.out).toMatch(/FAILED — green ingest, 0 rows landed/);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.code).toBe(0);
    expect(r.control.length).toBe(specs.length);
    const zero = r.control.find((d) => String(d.entryId).includes("2000_Probe_0"));
    expect(zero.status).toBe("failed");
    expect(String(zero.reason)).toMatch(/catalog holds 0 rows for this product/);
  });

  it("failed and unreachable still advance — the tripwire is not disarmed", () => {
    expect(streakAfter(0, { status: "failed" })).toBe(1);
    expect(streakAfter(2, { status: "unreachable" })).toBe(3);
    // `empty` still neither advances nor resets.
    expect(streakAfter(2, { status: "empty" })).toBe(2);
  });
});

/**
 * PIN — ONE CANONICAL KEY PER PRODUCT, AND THE COUNT READS THE KEY THE CHILD
 * WROTE.
 *
 * `finest -> topps-finest` is a normalizeSetKey alias (#1699). The driver
 * counted `finest` while the child wrote `topps-finest`, so on the whole bcp
 * Finest family the verification read a key the ingest never touches. Measured
 * read-only against prod on 2026-09-04:
 *
 *   2026  finest 0       topps-finest 39,480  (18,876 of them this very run)
 *   2023  finest 628     topps-finest 20,367
 *   2025  finest 2,467   topps-finest 91,015
 */
describe("the catalog is read with the key the ingest writes", () => {
  const finest = {
    id: "bcp::http://www.baseballcardpedia.com/index.php/2023_Finest",
    lane: "bcp",
    sourceRef: "http://www.baseballcardpedia.com/index.php/2023_Finest",
    sport: "baseball", year: 2023, setName: "Finest", seededStatus: "partial",
  };

  it("setKeyCandidates resolves the alias and never drops the raw key", () => {
    // The child honours a stated manifest setKey verbatim (`m.setKey ||
    // normalizeSetKey(m.setName)`) and only normalizes when the manifest omits
    // one, so a row may be under EITHER spelling -- the candidate list asks for
    // both and unions the answers. MUTATION RED: return `[raw]` and the alias
    // disappears; return `[canon]` and a row written under the raw key is lost.
    expect(setKeyFor(finest)).toBe("finest");
    expect(canonicalSetKey("finest")).toBe("topps-finest");
    expect(setKeyCandidates(finest)).toEqual(["finest", "topps-finest"]);
    // A key that IS its own canonical form stays a list of one -- no duplicate
    // read, and no second query billed for nothing.
    expect(setKeyCandidates({ ...finest, setName: "Topps Chrome" })).toEqual(["topps-chrome"]);
  });

  it("DRIVEN: EVERY catalog read site asks for both spellings of the product", () => {
    // WAS: `expect(src.match(/const keys = setKeyCandidates\(entry\);/g)).toHaveLength(3)`
    // -- a count of a literal line, which a rename of the local or of the
    // helper reddens without any behaviour changing, and which a fourth read
    // site added on the raw slug would not redden at all.
    //
    // This records every query the driver actually put to card_catalog and
    // asserts the invariant directly: the product count, the identity read and
    // the by-source count all ask for BOTH `finest` and `topps-finest`, and no
    // read site asks for the raw slug alone.
    //
    // MUTATION RED: put any one read site back on `setKeyFor(entry)` and its
    // query never carries `topps-finest`.
    const sink = path.join(tmp, `catalog-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(sink, "[]");
    const specs: EntrySpec[] = [{ setName: "Finest", year: 2023, yields: "csv" }];
    // before=0, after=1 -> a short ingest, which is the path that also takes
    // the identity read. All three sites therefore run on this one entry.
    drive(specs, {}, { catalogRows: [0, 1], catalogSink: sink });

    const reads = JSON.parse(fs.readFileSync(sink, "utf8")) as Array<{ query: string; params: Record<string, unknown> }>;
    expect(reads.length).toBeGreaterThan(0);
    const keysAsked = reads.map((r) => String(r.params["@k"]));
    expect(new Set(keysAsked)).toEqual(new Set(["finest", "topps-finest"]));

    // Group the reads by what they are FOR, and require each kind to have asked
    // for both. This is the "COUNT" the old pin was reaching for, stated as the
    // behaviour instead of as a line tally.
    const kindOf = (q: string) =>
      q.includes("c.source") ? "bySource"
        : /SELECT VALUE COUNT/.test(q) ? "count"
          : "identities";
    const byKind = new Map<string, Set<string>>();
    for (const r of reads) {
      const k = kindOf(r.query);
      if (!byKind.has(k)) byKind.set(k, new Set());
      byKind.get(k)!.add(String(r.params["@k"]));
    }
    // Three read sites, and every one of them resolved the alias.
    expect([...byKind.keys()].sort()).toEqual(["bySource", "count", "identities"]);
    for (const [kind, keys] of byKind) {
      expect(keys, `read site "${kind}" did not ask for both spellings`).toEqual(new Set(["finest", "topps-finest"]));
    }
    // And every read was bounded to the product, never the container.
    for (const r of reads) expect(r.params["@y"]).toBe(2023);
  });

  it("the bcp scraper emits the canonical key, so one product stages under one name", () => {
    // WAS: `expect(scraperSrc).toMatch(/return canonicalSetKeyOf\(slug\);/)` --
    // a grep for one line inside a function the scraper does not export.
    //
    // This drives the COMMITTED emission path over a saved fixture, through
    // the same helper the other bcp pins use, and reads the setKey off the
    // manifest the scraper actually wrote.
    //
    // WHY 1999_Black_Diamond AND NOT A Finest PAGE. The scope loop routes a
    // NON-PAPER scope through productQualifiers (`!isPaper && qualify`), and
    // qualifiedSetKeyFromTitle canonicalises its input independently -- so on a
    // page with routed scopes the qualifier MASKS this function entirely and
    // the pin would survive its own mutation (measured: 1997_Finest and
    // 1993_Finest both still emit `topps-finest` with canonicalSetKeyOf
    // removed). 1999_Black_Diamond is a PAPER-ONLY page: nothing else
    // canonicalises its key, so the scraper's own resolution is the only thing
    // standing between the alias and the filename.
    //
    // MUTATION RED (verified): return the bare `slug` from canonicalSetKeyOf
    // and the manifest reads `black-diamond`, staging the same product under a
    // second spelling -- the CF-ONE-CANONICAL-KEY-PER-PRODUCT defect exactly.
    const out = fs.mkdtempSync(path.join(tmp, "bcp-key-"));
    execFileSync(process.execPath, [
      path.join(backend, "tests", "helpers", "runBcpLaddersOverFixtures.cjs"), out,
      "1999_Black_Diamond=1999-black-diamond",
    ], { stdio: "pipe" });

    const manifests = fs.readdirSync(out).filter((n) => n.endsWith(".manifest.json"));
    expect(manifests.length).toBeGreaterThan(0);
    const keys = new Set(manifests.map((m) =>
      String((JSON.parse(fs.readFileSync(path.join(out, m), "utf8")) as { setKey?: string }).setKey ?? "")));
    // The vocabulary's own answer, so a ruling that renames the product moves
    // this pin with it rather than pinning a stale literal.
    const { normalizeSetKey } = require_(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
    const canonical = normalizeSetKey("black-diamond");
    expect(canonical).toBe("upper-deck-black-diamond");
    // Staged under the canonical spelling, and the raw slug appears nowhere --
    // one product, one name on disk. The FILENAME carries it too, so an ingest
    // that keys off the path lands on the same product.
    expect(keys).toEqual(new Set([canonical]));
    expect(manifests.every((m) => m.startsWith(`1999-${canonical}-`))).toBe(true);
  });

  it("finest and topps-finest are ONE product to normalizeSetKey", () => {
    // The alias itself, so a vocabulary change that split them again reddens
    // here rather than silently re-staging two spellings.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeSetKey } = require_(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
    expect(normalizeSetKey("finest")).toBe("topps-finest");
    expect(normalizeSetKey("topps-finest")).toBe("topps-finest");
  });
});
