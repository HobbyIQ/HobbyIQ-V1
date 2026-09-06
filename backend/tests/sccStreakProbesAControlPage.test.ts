import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-A-STREAK-IS-A-HYPOTHESIS-UNTIL-A-CONTROL-PAGE-ANSWERS (2026-09-06).
 *
 * Run 34059282207, lane sportscardchecklist, slice SCC-BB-7099c: pass 4 took
 * 170 entries, hit three consecutive "UNREACHABLE — a 200 carrying no
 * checklist" on set-14739/14740/14741 (1998 Topps Tek Pattern 21, 22, 23),
 * declared SYSTEMIC ABORT and left 167 entries unattempted. The walk chain
 * stops on ABORT, so 1,870 entries were stranded.
 *
 * The abort chose between two readings with evidence for neither:
 *   (a) the host is soft-blocking us -- every page a 200 with no checklist
 *   (b) those three sibling pages genuinely carry no checklist, and an
 *       id-ordered queue walks a cluster of them back to back
 *
 * MEASURED 2026-09-06 with this repo's own fetcher, paced, by hand: all three
 * Tek pages serve 90 card headers / 90 rows / exit 0, and the control page
 * set-14620 (1998 Topps Baseball) serves 503. Reading (a) held; three live
 * pages were closed `unreachable` and an era was stranded behind them.
 *
 * The fix is an EXPERIMENT rather than a better guess: before any systemic
 * abort, fetch a page this lane has already ingested. These pins drive the
 * COMMITTED script through the house stubbed harness -- the shim intercepts the
 * module boundary, never the logic -- and each names its own mutation red.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const {
  SYSTEMIC_FAILURE_STREAK,
  CONTROL_PAGES,
  probeControlPage,
  HOST_FAULT_STATUSES,
} = require_(script);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-probe-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * What the stubbed fetcher does for one scc entry.
 *
 *   "cards"      a full checklist -- the healthy path.
 *   "softBlock"  the #1898 signature: exit 9 whose message is the fetcher's own
 *                "did not serve a set page" wording, which the driver's scc
 *                branch turns into `unreachable`. This is the Tek shape.
 */
type Yield = "cards" | "softBlock";
type EntrySpec = { setName: string; setId: number; yields: Yield };

const slugOf = (s: EntrySpec) =>
  `${s.setName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-trading-card-checklist`;
const urlOf = (s: EntrySpec) => `https://www.sportscardchecklist.com/set-${s.setId}/${slugOf(s)}`;

function manifestOf(specs: EntrySpec[]): string {
  const p = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    entries: specs.map((s) => ({
      id: `sportscardchecklist::${urlOf(s)}`,
      lane: "sportscardchecklist",
      sourceRef: urlOf(s),
      sport: "baseball",
      year: 1998,
      setName: s.setName,
      seededStatus: "missing",
    })),
    unreachable: [],
  }));
  return p;
}

/**
 * `controlServes` is the experiment's answer: whether the PINNED control page
 * (never one of the manifest entries) comes back with a checklist. It is the
 * single variable these pins turn.
 */
function shimOf(specs: EntrySpec[], opts: { controlServes: boolean; failControlWrites?: number }): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const behaviour: Record<string, Yield> = {};
  for (const s of specs) behaviour[urlOf(s)] = s.yields;

  const shim = [
    'const Module = require("node:module");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const BEHAVIOUR = ${JSON.stringify(behaviour)};`,
    `const CONTROL_URL = ${JSON.stringify(CONTROL_PAGES.sportscardchecklist.url)};`,
    `const CONTROL_SERVES = ${opts.controlServes ? "true" : "false"};`,
    `const FAIL_WRITES = ${Number(opts.failControlWrites ?? 0)};`,
    'const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";',
    'const PROBE_SINK = process.env.PROBE_SINK;',
    '',
    'function cleanCsv(n) {',
    '  const rows = [HEADER];',
    '  for (let i = 1; i <= n; i++) rows.push("base," + i + ",,false,,Player " + i + " Name");',
    '  for (let i = 1; i <= n; i++) rows.push("base," + i + ",Gold Refractor,false,/50,Player " + i + " Name");',
    '  return rows.join("\\n") + "\\n";',
    '}',
    '',
    '// The fetcher\'s own exit-9 refusal. Two details have to be right or the',
    '// pin drives a path the incident never took:',
    '//   the EXIT STATUS decides the bucket -- the driver\'s isGone test reads',
    '//     `exit 9` and lands it in `unreachable`; a plain Error is `failed`.',
    '//   the REASON has to arrive on stderr, because run() builds its message',
    '//     from the child output it CAPTURED, never from a thrown message.',
    'function softBlockThrow(url) {',
    '  const e = new Error("fetchSportsCardChecklist.cjs exit 9");',
    '  e.status = 9;',
    '  e.stderr = "  !! no checklist on the page — the host did not serve a set " +',
    '    "page with HTTP 200 (bytes=12414, title=(none)) " + url + "\\n";',
    '  e.stdout = "";',
    '  throw e;',
    '}',
    '',
    '// ── the lane child ──',
    'const cp = require("node:child_process");',
    'cp.execFileSync = function (file, args, options) {',
    '  const argv = (args || []).map(String);',
    '  if (argv.includes("--url")) {',
    '    const u = argv[argv.indexOf("--url") + 1];',
    '    const outPath = argv[argv.indexOf("--out") + 1];',
    '    // THE CONTROL PAGE. Recorded so a pin can assert the probe actually ran',
    '    // and asked for the PINNED page -- not one of the entries.',
    '    if (u === CONTROL_URL) {',
    '      const seen = fs.existsSync(PROBE_SINK) ? JSON.parse(fs.readFileSync(PROBE_SINK, "utf8")) : [];',
    '      seen.push(u);',
    '      fs.writeFileSync(PROBE_SINK, JSON.stringify(seen));',
    '      if (!CONTROL_SERVES) softBlockThrow(u);',
    '      fs.mkdirSync(path.dirname(outPath), { recursive: true });',
    '      fs.writeFileSync(outPath, cleanCsv(503));',
    '      return "  card headers=503 hidden ebay_search rows=503  (anchors agree)\\n  rows=503 parsed=503 skipped=0\\n";',
    '    }',
    '    const mode = BEHAVIOUR[u] || "cards";',
    '    // OUR OWN PIPE, BROKEN: the child exits 0 and stages nothing, so',
    '    // acquisition refuses with "staged file unreadable" and the verdict is',
    '    // `failed` -- never a host fault, and never probe-answerable.',
    '    if (process.env.SCC_STUB_BROKEN_PIPE === "true") return "";',
    '    if (mode === "softBlock") softBlockThrow(u);',
    '    fs.mkdirSync(path.dirname(outPath), { recursive: true });',
    '    fs.writeFileSync(outPath, cleanCsv(90));',
    '    return "  rows=90 parsed=90 skipped=0\\n";',
    '  }',
    '  return "";',
    '};',
    '',
    '// ── Cosmos ──',
    'const CONTROL = [];',
    'let writeAttempts = 0;',
    'const stub = {',
    '  CosmosClient: class {',
    '    database() {',
    '      return {',
    '        container(name) {',
    '          return {',
    '            item(id) { return { read: async () => ({ resource: null }) }; },',
    '            items: {',
    '              query(q) {',
    '                if (name === "card_catalog") return { fetchAll: async () => ({ resources: [90] }) };',
    '                return { fetchAll: async () => ({ resources: [] }) };',
    '              },',
    '              upsert: async (doc) => {',
    '                writeAttempts++;',
    '                // The first FAIL_WRITES attempts fail, so a pin can prove the',
    '                // verdict LANDS on a retry rather than being counted lost.',
    '                if (writeAttempts <= FAIL_WRITES) throw new Error("stubbed transient control-write failure (429)");',
    '                CONTROL.push(doc);',
    '                fs.writeFileSync(process.env.CONTROL_SINK, JSON.stringify(CONTROL));',
    '                return { resource: doc };',
    '              },',
    '            },',
    '          };',
    '        },',
    '      };',
    '    }',
    '  },',
    '};',
    'const realLoad = Module._load;',
    'Module._load = function (request) {',
    '  if (request === "@azure/cosmos") return stub;',
    '  if (String(request).includes("writeReconciliation")) return { reportWrites: () => {} };',
    '  return realLoad.apply(this, arguments);',
    '};',
  ].join("\n");

  fs.writeFileSync(p, shim);
  return p;
}

function drive(
  specs: EntrySpec[],
  opts: { controlServes: boolean; failControlWrites?: number },
  env: Record<string, string> = {},
) {
  const sink = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  const probeSink = path.join(tmp, `probe-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sink, "[]");
  fs.writeFileSync(probeSink, "[]");
  const shim = shimOf(specs, opts);
  const run = () => execFileSync(process.execPath, [script], {
    cwd: backend,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
      MANIFEST_PATH: manifestOf(specs),
      CONTROL_SINK: sink,
      PROBE_SINK: probeSink,
      SOURCES: "sportscardchecklist",
      SCOPE: "recheck",
      SPORTS: "baseball",
      YEARS: "1998",
      WORKDIR: path.join(tmp, `wd-${Math.random().toString(36).slice(2)}`),
      // Generous ON PURPOSE. The loop's budget guard breaks out when fewer than
      // `perEntryMin * 1.5` remain (54s for this lane), and these pins are about
      // what the STREAK does -- a run that stops on its budget instead reaches
      // no probe at all and the pin goes red for a reason it does not test.
      // Observed exactly that at RUN_MINUTES=60 on a loaded box.
      RUN_MINUTES: "600",
      LIMIT: String(specs.length),
      BACKFILL_APPLY: "true",
      // orderQueue sorts by a value proxy, so manifest order is NOT run order.
      // The incident is specifically a streak that arrives FIRST with healthy
      // entries BEHIND it -- that is what makes an abort strand a tail. So the
      // WHOLE queue is named, in the order the pin needs: `titles` orders the
      // run, and naming every entry keeps all five in it (a partial list also
      // FILTERS, which would quietly drop the tail this pin exists to check).
      TITLES: specs.map((s) => s.setName).join(","),
      // The retry waits are behaviour, not duration: a pin must not spend 7s.
      CONTROL_WRITE_BACKOFF_MS: "1,1",
      ...env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const out = run();
    return {
      code: 0,
      out,
      control: JSON.parse(fs.readFileSync(sink, "utf8")) as any[],
      probes: JSON.parse(fs.readFileSync(probeSink, "utf8")) as string[],
    };
  } catch (e: any) {
    return {
      code: e.status as number,
      out: String(e.stdout ?? "") + String(e.stderr ?? ""),
      control: JSON.parse(fs.readFileSync(sink, "utf8")) as any[],
      probes: JSON.parse(fs.readFileSync(probeSink, "utf8")) as string[],
    };
  }
}

/**
 * The incident's own shape: a streak of sibling pages that will not serve,
 * followed by entries the lane must still reach. The two trailing entries are
 * the 167 that run 34059282207 never attempted, in miniature.
 */
function tekClusterThenGood(yields: Yield): EntrySpec[] {
  const specs: EntrySpec[] = [];
  for (let i = 0; i < SYSTEMIC_FAILURE_STREAK; i++) {
    specs.push({ setName: `1998 Topps Tek Pattern ${21 + i} Baseball`, setId: 14739 + i, yields });
  }
  specs.push({ setName: "1998 Bowman Chrome Baseball", setId: 14800, yields: "cards" });
  specs.push({ setName: "1998 Finest Baseball", setId: 14801, yields: "cards" });
  return specs;
}

describe("a streak asks the host before it judges the lane", () => {
  it("the control page is pinned, and it is not one of the entries it vouches for", () => {
    // The probe is only meaningful if the control is a page we have ALREADY
    // ingested. Pinning it also makes the probe one fetch with no dependencies
    // at the exact moment the host is misbehaving.
    const c = CONTROL_PAGES.sportscardchecklist;
    expect(c.url).toMatch(/^https:\/\/www\.sportscardchecklist\.com\/set-\d+\//);
    // MEASURED 2026-09-06: 503 card headers, exit 0. Same era and same shard of
    // the host's id space as the Tek cluster (set-14739..41) it vouches for.
    expect(c.url).toContain("set-14620");
    expect(c.year).toBe(1998);
    for (const id of [14739, 14740, 14741]) expect(c.url).not.toContain(String(id));
  });

  it("probeControlPage: a lane with no pinned control keeps the old ABORT", async () => {
    // The one case the experiment cannot run. Inventing a control for an
    // unverified lane would make its answer meaningless in the direction that
    // hurts -- a control that is simply broken reads as a dead host forever.
    const r = await probeControlPage("no-such-lane", async () => ({ rows: 999 }));
    expect(r.verdict).toBe("abort");
  });

  it("probeControlPage: served -> continue, refused -> backoff, threw -> backoff", async () => {
    // The decision itself, from the committed function.
    const served = await probeControlPage("sportscardchecklist", async () => ({ rows: 503 }));
    expect(served.verdict).toBe("continue");
    expect(served.rows).toBe(503);

    const refused = await probeControlPage("sportscardchecklist", async () => ({ rows: 0, detail: "no checklist" }));
    expect(refused.verdict).toBe("backoff");

    // A probe that THROWS is a host that would not answer, never a reason to
    // abort: it takes the same backoff path as a probe that served nothing.
    const threw = await probeControlPage("sportscardchecklist", async () => { throw new Error("ENOTFOUND"); });
    expect(threw.verdict).toBe("backoff");
  });

  it("DRIVEN: the control probe runs BEFORE any systemic abort", () => {
    // MUTATION RED (the headline one): delete the `probeControlPage(...)` call
    // from the tripwire and go straight to ABORT -- the pinned control page is
    // never fetched, this sink stays empty, and the lane strands its tail again.
    const r = drive(tekClusterThenGood("softBlock"), { controlServes: true });
    expect(r.probes.length).toBeGreaterThan(0);
    expect(r.probes[0]).toBe(CONTROL_PAGES.sportscardchecklist.url);
    expect(r.out).toMatch(/PROBING A CONTROL PAGE/);
  });

  it("DRIVEN: control SERVES -> not systemic -> per-entry verdicts, and the run continues", () => {
    // The reading the incident actually needed inverted. The three Tek entries
    // keep the verdicts they earned; the two entries BEHIND them -- the 167, in
    // miniature -- are still reached.
    //
    // MUTATION RED: make the "continue" branch `break` instead of resetting the
    // streak, and the trailing entries disappear from the control docs again.
    const specs = tekClusterThenGood("softBlock");
    const r = drive(specs, { controlServes: true });

    expect(r.out).toMatch(/NOT SYSTEMIC/);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    expect(r.out).not.toMatch(/BACKING OFF/);
    expect(r.code).toBe(0);

    // EVERY entry got a verdict of its own, streak members included.
    expect(r.control.length).toBe(specs.length);
    for (const s of specs.slice(0, SYSTEMIC_FAILURE_STREAK)) {
      const doc = r.control.find((d) => String(d.sourceRef) === urlOf(s));
      expect(doc, `no verdict for ${s.setName}`).toBeTruthy();
      // Its own verdict, unchanged -- the probe decides the LANE's fate, never
      // the entry's.
      expect(doc.status).toBe("unreachable");
    }
    // And the entries beyond the would-be streak were reached and ingested.
    expect(r.control.some((d) => String(d.sourceRef).includes("set-14800"))).toBe(true);
    expect(r.control.some((d) => String(d.sourceRef).includes("set-14801"))).toBe(true);
  });

  it("DRIVEN: control ALSO FAILS -> BACKOFF, not ABORT — nothing is closed", () => {
    // The soft-block case. It must reach the #1898 path so the walker's
    // retry-after-30-minutes branch fires and the entries come back on the next
    // pending-only walk with no operator action.
    //
    // MUTATION RED: make the "backoff" branch set an ABORT message instead, and
    // the run reports a systemic abort the walk chain stops on.
    const r = drive(tekClusterThenGood("softBlock"), { controlServes: false });

    expect(r.out).toMatch(/BACKING OFF/);
    expect(r.out).toMatch(/the control page did not serve either/);
    expect(r.out).not.toMatch(/ABORTING THE LANE/);
    // NOTHING was marked unreachable by the lane decision itself: the run stops
    // and the remaining entries keep their place.
    expect(r.out).toMatch(/NOTHING was marked unreachable/);
    // The trailing entries were NOT attempted -- backing off is a stop, and it
    // must not quietly keep spending the budget on a host that is refusing us.
    expect(r.control.some((d) => String(d.sourceRef).includes("set-14800"))).toBe(false);
  });

  it("DRIVEN: a verdict that fails to write is RETRIED, and it lands", () => {
    // CF-A-VERDICT-THAT-DOES-NOT-LAND-IS-A-DOUBLE-FETCH. Run 34059282207
    // reported "control writes lost 1 (verdict earned, doc did not land)". A
    // lost verdict is indistinguishable from a never-attempted entry to the
    // queue filter, so the next walk re-fetches the whole page to re-derive an
    // answer we already had.
    //
    // MUTATION RED: drop the retry loop back to a single `await writeControl`
    // and the first entry's verdict is counted lost -- "control writes lost 1"
    // reappears and the doc count is short by one.
    const specs = tekClusterThenGood("cards");
    const r = drive(specs, { controlServes: true, failControlWrites: 1 });

    expect(r.out).toMatch(/control doc landed on attempt 2/);
    expect(r.out).not.toMatch(/control writes lost/);
    expect(r.out).not.toMatch(/CONTROL WRITE FAILED after/);
    // Every verdict landed, the transient failure included.
    expect(r.control.length).toBe(specs.length);
    expect(r.code).toBe(0);
  });

  it("DRIVEN: a streak of OUR OWN broken pipe is never probed — it keeps its abort", () => {
    // THE BOUNDARY OF THE EXPERIMENT. The probe asks one question -- is the
    // HOST serving us -- so it may only be consulted about a streak that could
    // plausibly be the host. `failed` means acquisition handed back no file at
    // all; the host being up says nothing about that, and a probe that answered
    // "carry on" would keep a lane with a severed pipe running to the end of
    // its budget writing `failed` onto entries that are fine.
    //
    // This is the case SYSTEMIC_FAILURE_STREAK was built for, and it is pinned
    // by tests/ingestUniverseDriverSccLaneAppliesEndToEnd.test.ts ("suppresses
    // the budget marker") -- which went RED when the probe was first wired in
    // without this boundary, because a control page cheerfully vouched for a
    // lane whose own pipe was broken.
    //
    // MUTATION RED: drop the `hostFault` gate and probe every streak, and the
    // ENOENT lane above stops aborting -- that pin goes red exactly as observed.
    const specs = tekClusterThenGood("softBlock");
    // The staged file never lands, so acquisition refuses: `failed`, not
    // `unreachable`. The control page WOULD serve if it were asked.
    const r = drive(specs, { controlServes: true }, { SCC_STUB_BROKEN_PIPE: "true" });

    expect(r.out).toMatch(/ABORTING THE LANE/);
    expect(r.out).toMatch(/our own pipe/);
    // The experiment never ran: no fetch was spent asking a question whose
    // answer could not have changed the decision.
    expect(r.probes.length).toBe(0);
    expect(r.out).not.toMatch(/PROBING A CONTROL PAGE/);
  });

  it("HOST_FAULT_STATUSES: only the host's own verdicts are probe-answerable", () => {
    // `unreachable` is the host answering with something that is not a set
    // page. `failed` is our pipe, and `empty`/`refused`/`short-ingest` are
    // verdicts reached BY successfully reading the page -- none of them is a
    // question a control page can settle.
    expect(HOST_FAULT_STATUSES.has("unreachable")).toBe(true);
    for (const s of ["failed", "empty", "refused", "short-ingest", "ingested", "partial"]) {
      expect(HOST_FAULT_STATUSES.has(s), `${s} must not be probe-answerable`).toBe(false);
    }
  });

  it("a healthy lane never probes at all — the experiment costs nothing when nothing is wrong", () => {
    // The probe is a fetch, and a fetch on a rate-limited host is exactly what
    // we are trying to spend less of. It must fire ONLY at the streak limit.
    const r = drive(tekClusterThenGood("cards"), { controlServes: true });
    expect(r.probes.length).toBe(0);
    expect(r.out).not.toMatch(/PROBING A CONTROL PAGE/);
    expect(r.code).toBe(0);
  });
});
