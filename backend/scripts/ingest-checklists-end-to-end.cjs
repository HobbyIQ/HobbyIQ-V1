#!/usr/bin/env node
/**
 * CF-INGEST-END-TO-END (Drew, 2026-08-27: "do it now and run it auto mode").
 *
 * Acquire → convert → ingest, in one process, so the whole thing runs on a
 * runner with nothing staged beforehand.
 *
 * WHY THIS EXISTS. The checklists were scraped to a local temp folder, and a
 * runner cannot see it. The options were to commit ~6M CSV rows to the repo,
 * or to run the write path locally against production -- which is the one
 * thing the runbook says never to do, because local env resolves containers
 * differently from App Service. So the runner re-acquires instead. It costs
 * ~40 minutes of scraping and makes the job reproducible from nothing.
 *
 * ORDER MATTERS. Beckett first: it publishes the parallel ladder with print
 * runs, and checklistinsider fills modern gaps Beckett has no workbook for.
 * Both write through upsertCatalogEntry, and authority now outranks confidence
 * (#1304), so a checklist row beats the sales-derived row it is correcting --
 * which is the entire point of ingesting them.
 *
 * BOUNDED BY A CLOCK, not by faith. Each phase gets a slice of RUN_MINUTES and
 * the summary prints whatever was reached, so a relaunch continues rather than
 * a killed step reporting nothing.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   RUN_MINUTES=140
 *   PHASES=beckett,insider,bcp    which sources to acquire (default both)
 *   SPORT=baseball            scope the Beckett archive
 *   BCP_SPORT=baseball        the sport bcp pages are scraped AS (default SPORT)
 *   PAGES=29                  Beckett archive depth
 *   WORKDIR                   where to stage (default: OS temp)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// bcp included in the DEFAULT, in the code, not the comment: an earlier patch
// edited the Env doc line and left this default untouched, and phase 3 sat
// configured-off through every relaunch while the log said nothing.
const PHASES = String(process.env.PHASES || "beckett,insider,bcp,tcgdexja,clc").split(",").map((s) => s.trim()).filter(Boolean);
const SPORT = process.env.SPORT || "baseball";
// The sport the bcp pages are scraped AS. Defaults to the run's SPORT so a
// single-sport dispatch stays coherent end to end, and is separately
// overridable because BCP_TITLES can point at pages from a different sport
// than the Beckett archive this run is walking.
const BCP_SPORT = process.env.BCP_SPORT || SPORT;
const PAGES = process.env.PAGES || "29";
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "ingest-checklists-end-to-end" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const WORKDIR = process.env.WORKDIR || path.join(os.tmpdir(), "hiq-checklists");
// The runner caches WORKDIR across relaunches. Re-scraping what is already
// staged costs 76 of the 140 available minutes and acquires nothing new.
const FORCE_ACQUIRE = String(process.env.FORCE_ACQUIRE || "") === "true";
// CF-BECKETT-DIRECT-URL-LANE (2026-09-01). The Beckett archive index is
// effectively BASEBALL-ONLY: walking all 29 pages yields 719 set pages, of
// which 708 are baseball and the nested basketball/football categories 404 in
// every form. So no --sport value reaches, e.g., 2020-21 Panini Prizm
// Basketball -- the index simply cannot name it. BECKETT_URLS carries the set
// page (or the workbook) directly, the same shape the hobbymonitor lane's
// direct-URL escape already uses for a release its index cannot name.
// Carried on the EXISTING `titles` runner input (BCP_TITLES); no new
// workflow_dispatch input -- 24/25 are used.
const BECKETT_URLS = (process.env.BECKETT_URLS || "").trim();

const f = (n) => Number(n).toLocaleString();
const left = () => RUN_MS - (Date.now() - STARTED);
const mins = (ms) => Math.max(1, Math.floor(ms / 60000));
const staged = (p) => { try { return fs.statSync(p).size > 0; } catch { return false; } };

/**
 * The Beckett child's argument list, as a pure function so the two rules that
 * defect D1/D2 turned on are assertable without spawning a scrape:
 *   * --skipExisting is present by default and ABSENT under force-acquire.
 *     The child skips before any fetch, so leaving the flag on made
 *     FORCE_ACQUIRE a no-op for the one phase carrying the parallel ladder.
 *   * --urls, when given, carries a direct set-page/workbook address for a
 *     release the baseball-only archive index cannot name.
 * Exported for the pin; main() calls exactly this.
 */
function beckettArgs({ sport, pages, outDir, forceAcquire, urls }) {
  return [
    `--sport=${sport}`, `--pages=${pages}`, "--delayMs=700", `--outDir=${outDir}`,
    ...(forceAcquire ? [] : ["--skipExisting"]),
    ...(urls ? [`--urls=${urls}`] : []),
  ];
}

function run(script, args, env) {
  const out = execFileSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(out);
  return out;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  fs.mkdirSync(WORKDIR, { recursive: true });
  const beckettDir = path.join(WORKDIR, "beckett");
  const insiderDir = path.join(WORKDIR, "insider-csv");
  const insiderJsonl = path.join(WORKDIR, "insider.jsonl");
  const bcpDir = path.join(WORKDIR, "bcp-ladders");
  const clcPagesDir = path.join(WORKDIR, "clc-pages"), clcDir = path.join(WORKDIR, "clc-csv");
  const tcgdexJaDir = path.join(WORKDIR, "tcgdex-ja");
  console.log(`workdir ${WORKDIR}   budget ${RUN_MS / 60000}m   ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const done = [];

  // ── acquire ───────────────────────────────────────────────────────────────
  if (PHASES.includes("beckett") && left() > 20 * 60000) {
    console.log("── phase 1: Beckett archive ──");
    try {
      // CF-FORCE-ACQUIRE-REACHES-BECKETT-TOO (2026-09-01). Every other phase
      // honours FORCE_ACQUIRE; beckett was the lone omission, and it passed
      // --skipExisting UNCONDITIONALLY. The child skips BEFORE any fetch (a
      // staged CSV is enough), so a force-acquire dispatch printed
      // "skipped (existing) 409" and re-acquired nothing at all -- the cache
      // pierce the mode exists for never reached the one phase that carries
      // the parallel ladder. FORCE_ACQUIRE now drops the flag, exactly as
      // insider/clc/tcgdexja already drop their staged-and-skip branches.
      run("scrape-beckett-checklists.cjs", beckettArgs({
        sport: SPORT, pages: PAGES, outDir: beckettDir,
        forceAcquire: FORCE_ACQUIRE, urls: BECKETT_URLS,
      }));
      done.push("beckett-acquired");
    } catch (e) { console.error("  beckett acquire failed: " + String(e.message).slice(0, 120)); }
  }

  if (PHASES.includes("insider") && left() > 20 * 60000) {
    console.log("\n── phase 2: checklistinsider ──");
    try {
      if (staged(insiderJsonl) && !FORCE_ACQUIRE) {
        console.log(`  ${(fs.statSync(insiderJsonl).size / 1e6).toFixed(1)} MB already staged — skipping the scrape (FORCE_ACQUIRE=true re-fetches)`);
      } else {
        run("scrape-checklistinsider.cjs", ["--delayMs=700", `--out=${insiderJsonl}`]);
      }
      run("convertChecklistInsiderToChecklistCsv.cjs", [`--in=${insiderJsonl}`, `--outDir=${insiderDir}`]);
      done.push("insider-acquired");
    } catch (e) { console.error("  insider acquire failed: " + String(e.message).slice(0, 120)); }
  }

  if (PHASES.includes("bcp") && left() > 5 * 60000) {
    console.log("\n── phase 3: baseballcardpedia ladders ──");
    // The one source that carries 2016-2024 flagship parallel ladders. The
    // original bcp scraper SKIPPED parallel sections; this one reads only them.
    try {
      // CF-RESCRAPE-WHAT-EXPLODED (2026-08-29, checklist B4). The runner's YEARS
      // and BCP_TITLES inputs widen the scrape to the products the old bcp
      // scrape exploded (2005-2015 Topps / Heritage / A&G / Gypsy Queen, Donruss,
      // Score, Upper Deck ...). Default stays the flagship 2016-2026 window.
      // CF-THE-SPORT-IS-AN-INPUT-NOT-A-CONSTANT (2026-08-31). The scraper used
      // to write "baseball" into the product key and the manifest as a
      // literal. BCP_TITLES takes arbitrary wiki page titles, so a football
      // page dispatched through here minted football cards into a baseball
      // identity. SPORT is the acquisition input this job already carries for
      // Beckett; the bcp phase now states it too, explicitly, rather than
      // letting a default downstream decide.
      const bcpArgs = [`--years=${process.env.YEARS || "2016-2026"}`, `--outDir=${bcpDir}`, "--delayMs=800", `--sport=${BCP_SPORT}`];
      if (process.env.BCP_TITLES) bcpArgs.push(`--titles=${process.env.BCP_TITLES}`);
      run("scrape-bcp-ladders.cjs", bcpArgs);
      done.push("bcp-acquired");
    } catch (e) { console.error("  bcp acquire failed: " + String(e.message).slice(0, 120)); }
  }

  if (PHASES.includes("clc") && left() > 5 * 60000) {
    console.log("\n── phase 5: checklistcenter (D3) ──");
    // CF-CHECKLISTCENTER-INTO-THE-GUARDED-PIPE. The old checklistcenter
    // ingesters raw-upserted ~1.2M rows with comma-split ladders (player
    // names became rungs) and must not be rerun. Pages are acquired into the
    // cached WORKDIR once, converted to the canonical CSV with the rung guards,
    // and land through the same guarded ingest as every other source.
    try {
      // CF-CACHE-THE-PAGES-NOT-THE-VERDICT (2026-08-29, D3 dry run #2). The
      // bounded, polite part is the 531-page fetch; conversion is seconds and
      // its guards keep improving (#1405 moved the explosion gate per subset).
      // A cached CSV directory silently replayed the OLD converter's verdicts
      // -- 36 refused products stayed refused with the fix merged. So: pages
      // are cached (re-fetched only when absent or FORCE_ACQUIRE=true); the
      // CSVs are rebuilt from the pages on every run.
      const hasPages = fs.existsSync(clcPagesDir) && fs.readdirSync(clcPagesDir).length > 0;
      if (!hasPages || process.env.FORCE_ACQUIRE === "true") {
        run("scrape-checklistcenter-products.cjs", [`--outDir=${clcPagesDir}`, "--delayMs=800", ...(process.env.YEARS ? [`--years=${process.env.YEARS}`] : [])]);
      } else console.log("  clc pages cached; skipping the fetch (FORCE_ACQUIRE=true to refresh)");
      if (fs.existsSync(clcDir)) for (const n of fs.readdirSync(clcDir)) if (n.endsWith(".csv") || n.endsWith(".json")) fs.unlinkSync(clcDir + "/" + n);
      run("convertChecklistCenterToChecklistCsv.cjs", [`--pagesDir=${clcPagesDir}`, `--outDir=${clcDir}`, ...(process.env.YEARS ? [`--years=${process.env.YEARS}`] : [])]);
      done.push("clc-acquired");
    } catch (e) { console.error("  clc acquire failed: " + String(e.message).slice(0, 120)); }
  }

  if (PHASES.includes("tcgdexja") && left() > 5 * 60000) {
    console.log("\n── phase 4: tcgdex Japanese sets ──");
    // Japanese-exclusive sets bridged to English species names via dexId.
    // Staged output rides the cache; a directory that already holds CSVs is
    // not re-fetched -- the API is a volunteer-run free service.
    try {
      const already = fs.existsSync(tcgdexJaDir) ? fs.readdirSync(tcgdexJaDir).filter((n) => n.endsWith(".csv")).length : 0;
      if (already >= 5 && !FORCE_ACQUIRE) {
        console.log(`  ${already} sets already staged — skipping the scrape (FORCE_ACQUIRE=true re-fetches)`);
      } else {
        run("scrape-tcgdex-ja.cjs", [`--outDir=${tcgdexJaDir}`, "--delayMs=150"]);
      }
      done.push("tcgdexja-acquired");
    } catch (e) { console.error("  tcgdex-ja acquire failed: " + String(e.message).slice(0, 120)); }
  }

  // ── ingest ────────────────────────────────────────────────────────────────
  // Beckett first: it carries the ladder and print runs. Both are checklist
  // authority, so within the class confidence breaks the tie and the more
  // complete row wins.
  const stamp = new Date().toISOString().slice(0, 10);
  // bcp FIRST: it is ~22 files and minutes of work, and twice now the
  // beckett+insider re-ingest consumed the whole budget before reaching it.
  // The tiny source must never be starved by the big ones.
  for (const [dir, source] of [
    [bcpDir, `baseballcardpedia-ladders-${stamp}`],
[clcDir, `checklistcenter-${stamp}`],
    [beckettDir, `beckett-checklist-${stamp}`],
    [insiderDir, `checklistinsider-${stamp}`],
    [tcgdexJaDir, `tcgdex-ja-${stamp}`],
  ]) {
    if (!fs.existsSync(dir)) { console.log(`\n  skipping ${source} — nothing staged at ${dir}`); continue; }
    const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv")).length;
    if (!csvs) { console.log(`\n  skipping ${source} — 0 CSVs`); continue; }
    const budget = mins(left() / 2);
    if (budget < 2) { console.log(`\n  out of budget before ${source}\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`); break; }
    console.log(`\n── ingest ${source}  (${f(csvs)} files, ${budget}m budget) ──`);
    try {
      run("ingest-checklist-csv-to-catalog.cjs", [], {
        DIR: dir, SOURCE: source,
        BACKFILL_APPLY: APPLY ? "true" : "false",
        RUN_MINUTES: String(budget),
        CONCURRENCY: process.env.CONCURRENCY || "48",
        // MODE=reingest re-upserts every staged file, ignoring resume markers.
        // The restoration path for checklist rows deleted by a pass that turned
        // out to have the wrong premise (numbered Base IS legitimate where the
        // product checklist lists it -- Drew, 2026-08-28).
        // CF-FORCE-ACQUIRE-PIERCES-ALL-CACHE-STATE (2026-09-01). Also true
        // under force-acquire: re-scraping and then skipping the refreshed
        // files on their stale `.ingested` markers acquires nothing that
        // lands. The wrapper's own env is honoured first so the runner can
        // set REINGEST directly, then MODE=reingest as before.
        REINGEST: (String(process.env.REINGEST || "") === "true"
          || String(process.env.MODE || "").toLowerCase() === "reingest") ? "true" : "",
        // The ingest has always sharded by file; nobody was passing it the
        // shard. One worker on 409 files makes "does it fit in one budget
        // window?" an open question every run. Eight workers on the same cached
        // CSVs makes it arithmetic.
        SLOT: String(SLOT), SLOTS: String(SLOTS),
      });
      done.push(`ingested:${source}`);
    } catch (e) { console.error(`  ${source} ingest failed: ` + String(e.message).slice(0, 160)); }
  }

  const spent = Math.round((Date.now() - STARTED) / 60000);
  console.log(`\n── end-to-end complete in ${spent}m ──`);
  console.log(`  phases done: ${done.length ? done.join(", ") : "(none)"}`);
  // The relaunch greps this line; it must print on every exit path.
  console.log(`  checklist_phases_done=${done.length}`);
}

// Exported so the argument-shape rules can be pinned without spawning a
// 40-minute scrape; the pipeline still runs on direct invocation only.
module.exports = { beckettArgs };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
