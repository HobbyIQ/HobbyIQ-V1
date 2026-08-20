#!/usr/bin/env node
// CF-INGEST-ONLY-WHAT-WE-NEED (Drew, 2026-08-13: "only what we need and are
// missing").
//
// cardboardchecklist.com exposes 359 checklists / 288,173 cards over MCP. We do
// not want all of them — we want the ones the market has actually asked for and
// the catalog cannot describe.
//
// So this intersects the source's catalogue against catalog_seed_queue on
// (sport, year, setKey) and ingests only the overlap, highest demand first.
// Measured 2026-08-13: 104 of 359 match pending demand — 98,973 cards.
//
// Sharded, because each set is an HTTP round trip plus a Cosmos write batch.
//
//   node scripts/ingestNeededChecklists.cjs                 # dry run
//   node scripts/ingestNeededChecklists.cjs --apply --shard 0 --shards 4

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PLAN = val("--plan", path.join(__dirname, "..", "cc-needed.json"));
const SHARD = Number(val("--shard", "-1"));
const SHARDS = Number(val("--shards", "1"));
const LIMIT = Number(val("--limit", "999"));
// CF-STAGE-THEN-CROSS-REFERENCE (Drew, 2026-08-13: "maybe stage them and cross
// reference?"). Fetch every needed checklist to CSV WITHOUT touching the
// catalog, so coverage can be measured against what we already hold before a
// single row is written. Ingesting first and measuring after is how duplicate
// rows accumulate — and the catalog is already 25.5M rows.
const STAGE_ONLY = args.includes("--stage-only");

const BACKEND = path.resolve(__dirname, "..");
const OUTDIR = path.join(BACKEND, "data/checklists/scraped");

function run(cmd, argv, env) {
  const r = spawnSync(cmd, argv, {
    cwd: BACKEND, encoding: "utf8", env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

(async () => {
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const mine = plan.slice(0, LIMIT).filter((_, i) => SHARD < 0 || SHARDS <= 1 || i % SHARDS === SHARD % SHARDS);
  console.log(`needed checklists: ${plan.length}  this shard: ${mine.length}  ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const stats = { done: 0, rows: 0, failed: 0 };
  for (const m of mine) {
    const csv = path.join(OUTDIR, `${m.year}-${m.setKey}-${m.sport}.csv`);
    if (!APPLY) { console.log(`  would ingest dmd=${m.dmd} ${m.slug}`); continue; }

    const gen = run("node", ["scripts/fetchCardboardChecklistMcp.cjs",
      "--slug", m.slug, "--out", csv, "--set-key", m.setKey,
      "--year", String(m.year), "--sport", m.sport, "--quiet"]);
    if (gen.code !== 0) {
      console.log(`  [${m.slug}] fetch failed: ${gen.out.split("\n").slice(-2).join(" ").slice(0, 110)}`);
      stats.failed++; continue;
    }
    if (STAGE_ONLY) {
      const NL = String.fromCharCode(10);
      const n = fs.readFileSync(csv, "utf8").trim().split(NL).length - 1;
      stats.rows += n; stats.done++;
      console.log(`  dmd ${String(m.dmd).padStart(4)}  ${m.slug.padEnd(42)} staged=${n}`);
      continue;
    }
    const ing = run("node", ["scripts/ingest-scraped-checklist.cjs"],
      { CSV_PATH: csv, SOURCE_LABEL: "cardboardchecklist", APPLY: "true" });
    if (ing.code !== 0) {
      console.log(`  [${m.slug}] ingest failed: ${ing.out.split("\n").slice(-2).join(" ").slice(0, 110)}`);
      stats.failed++; continue;
    }
    const wrote = (ing.out.split("\n").find((l) => l.includes("wrote=")) || "").trim();
    stats.rows += Number((wrote.match(/wrote=(\d+)/) || [])[1] || 0);
    stats.done++;
    console.log(`  dmd ${String(m.dmd).padStart(4)}  ${m.slug.padEnd(42)} ${wrote}`);
  }

  console.log(`\ningested : ${stats.done}`);
  console.log(`rows     : ${stats.rows.toLocaleString()}`);
  console.log(`failed   : ${stats.failed}`);
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
