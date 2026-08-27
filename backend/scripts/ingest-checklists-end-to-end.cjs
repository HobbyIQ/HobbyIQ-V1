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
 *   PHASES=beckett,insider    which sources to acquire (default both)
 *   SPORT=baseball            scope the Beckett archive
 *   PAGES=29                  Beckett archive depth
 *   WORKDIR                   where to stage (default: OS temp)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const PHASES = String(process.env.PHASES || "beckett,insider").split(",").map((s) => s.trim()).filter(Boolean);
const SPORT = process.env.SPORT || "baseball";
const PAGES = process.env.PAGES || "29";
const WORKDIR = process.env.WORKDIR || path.join(os.tmpdir(), "hiq-checklists");

const f = (n) => Number(n).toLocaleString();
const left = () => RUN_MS - (Date.now() - STARTED);
const mins = (ms) => Math.max(1, Math.floor(ms / 60000));

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

(async () => {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  fs.mkdirSync(WORKDIR, { recursive: true });
  const beckettDir = path.join(WORKDIR, "beckett");
  const insiderDir = path.join(WORKDIR, "insider-csv");
  const insiderJsonl = path.join(WORKDIR, "insider.jsonl");
  console.log(`workdir ${WORKDIR}   budget ${RUN_MS / 60000}m   ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  const done = [];

  // ── acquire ───────────────────────────────────────────────────────────────
  if (PHASES.includes("beckett") && left() > 20 * 60000) {
    console.log("── phase 1: Beckett archive ──");
    try {
      run("scrape-beckett-checklists.cjs", [
        `--sport=${SPORT}`, `--pages=${PAGES}`, "--delayMs=700",
        `--outDir=${beckettDir}`, "--skipExisting",
      ]);
      done.push("beckett-acquired");
    } catch (e) { console.error("  beckett acquire failed: " + String(e.message).slice(0, 120)); }
  }

  if (PHASES.includes("insider") && left() > 20 * 60000) {
    console.log("\n── phase 2: checklistinsider ──");
    try {
      run("scrape-checklistinsider.cjs", ["--delayMs=700", `--out=${insiderJsonl}`]);
      run("convertChecklistInsiderToChecklistCsv.cjs", [`--in=${insiderJsonl}`, `--outDir=${insiderDir}`]);
      done.push("insider-acquired");
    } catch (e) { console.error("  insider acquire failed: " + String(e.message).slice(0, 120)); }
  }

  // ── ingest ────────────────────────────────────────────────────────────────
  // Beckett first: it carries the ladder and print runs. Both are checklist
  // authority, so within the class confidence breaks the tie and the more
  // complete row wins.
  const stamp = new Date().toISOString().slice(0, 10);
  for (const [dir, source] of [
    [beckettDir, `beckett-checklist-${stamp}`],
    [insiderDir, `checklistinsider-${stamp}`],
  ]) {
    if (!fs.existsSync(dir)) { console.log(`\n  skipping ${source} — nothing staged at ${dir}`); continue; }
    const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv")).length;
    if (!csvs) { console.log(`\n  skipping ${source} — 0 CSVs`); continue; }
    const budget = mins(left() / 2);
    if (budget < 2) { console.log(`\n  out of budget before ${source}`); break; }
    console.log(`\n── ingest ${source}  (${f(csvs)} files, ${budget}m budget) ──`);
    try {
      run("ingest-checklist-csv-to-catalog.cjs", [], {
        DIR: dir, SOURCE: source,
        BACKFILL_APPLY: APPLY ? "true" : "false",
        RUN_MINUTES: String(budget),
        CONCURRENCY: process.env.CONCURRENCY || "48",
      });
      done.push(`ingested:${source}`);
    } catch (e) { console.error(`  ${source} ingest failed: ` + String(e.message).slice(0, 160)); }
  }

  const spent = Math.round((Date.now() - STARTED) / 60000);
  console.log(`\n── end-to-end complete in ${spent}m ──`);
  console.log(`  phases done: ${done.length ? done.join(", ") : "(none)"}`);
  // The relaunch greps this line; it must print on every exit path.
  console.log(`  checklist_phases_done=${done.length}`);
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
