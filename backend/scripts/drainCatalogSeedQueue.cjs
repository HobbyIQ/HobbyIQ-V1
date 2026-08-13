#!/usr/bin/env node
// CF-SEED-DRAINER (Drew, 2026-08-13: "ok we need to wire it and do it almost
// real time to make fixes").
//
// The last link in the demand loop. Three producers already file checklist
// seeds when something cannot be matched:
//
//   unmatched vendor sale   (soldCompsStore, CF-UNMATCHED-SALE-SEEDS-CHECKLIST)
//   unmatched eBay import   (ebayAutoHolding, CF-EBAY-MISS-SEEDS-CHECKLIST)
//   pricing / verify misses (compiq.routes, catalogVerify, resolveSetKey)
//
// but nothing consumed the queue, so demand accumulated and no catalog ever
// grew from it. This drains it, highest demand first, and closes the loop:
//
//   unmatched -> seed (demand++) -> [THIS] acquire checklist -> ingest
//     -> staging rows retried -> promoted into sold_comps
//
// WHY IT REUSES THE CLI SCRIPTS. Acquisition is Beckett URL discovery
// (HEAD-probes candidate S3 URLs), then convertBeckettChecklistXlsx, then
// ingest-scraped-checklist. Those two are proven CLI scripts that ran the 2026
// Bowman Chrome (1,197 rows) and Mega Box (268 rows) ingests, so the drainer
// spawns them rather than reimplementing their parsing. A bug fixed in the
// manual path is fixed here for free.
//
// SAFETY. Dry-run by default. Bounded per run (--max) so a large queue drains
// over several ticks instead of one long job. A seed that cannot be acquired is
// marked `unavailable` with the reason, NOT deleted — it stays visible as real
// demand we cannot yet serve, which is the signal for a manual fetch.
//
//   node scripts/drainCatalogSeedQueue.cjs                 # dry run
//   node scripts/drainCatalogSeedQueue.cjs --apply --max 3

const { CosmosClient } = require("@azure/cosmos");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "3"));
const SPORT_DEFAULT = val("--sport", "baseball");

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const queue = db.container("catalog_seed_queue");

const BACKEND = path.resolve(__dirname, "..");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve(dest)));
      f.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** Beckett discovery lives in TS; use the built dist so the drainer stays a
 *  plain script. Requires `npm run build` (the workflow does it). */
async function discoverUrl(year, brand, sport) {
  const mod = require(path.join(BACKEND, "dist/agents/beckett/beckettUrlDiscovery.js"));
  // The default 72-probe cap is tuned for a bulk sweep across thousands of
  // tuples. Here we are chasing ONE release the market has already asked for
  // repeatedly, so a deeper search is worth it: with both sport casings there
  // are ~20 candidates per month, and 72 probes only reaches into the fourth
  // month tried. 2024 Bowman Chrome publishes in month 08 and was reported
  // "no checklist published" purely because the sweep stopped short.
  // HEAD probes are cheap and this runs a handful of seeds per tick.
  return mod.discoverBeckettChecklistUrl({
    year, brand, sport,
    maxProbes: Number(process.env.DISCOVERY_MAX_PROBES || 400),
  });
}

function run(cmd, argv, env) {
  const r = spawnSync(cmd, argv, {
    cwd: BACKEND, encoding: "utf8", env: { ...process.env, ...(env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

async function markSeed(seed, status, extra) {
  if (!APPLY) return;
  const next = { ...seed, status, drainedAt: new Date().toISOString(), ...(extra || {}) };
  try { await queue.items.upsert(next); } catch { /* non-fatal */ }
}

(async () => {
  console.log(`seed-queue drainer — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}\n`);

  // Highest demand first — the queue's requestCount is how many times the
  // market asked for a card we could not describe.
  const { resources: seeds } = await queue.items.query({
    query: "SELECT * FROM c WHERE c.status = 'pending' ORDER BY c.requestCount DESC",
  }).fetchAll();

  console.log(`pending seeds: ${seeds.length}`);
  if (seeds.length === 0) { console.log("nothing to drain."); return; }
  for (const s of seeds.slice(0, 12)) {
    console.log(`   x${String(s.requestCount).padStart(4)}  ${s.id}   ${(s.reasons || []).join(",")}`);
  }

  const batch = seeds.slice(0, MAX);
  console.log(`\ndraining ${batch.length} highest-demand seed(s)…\n`);

  const summary = { acquired: 0, ingested: 0, unavailable: 0, failed: 0 };

  for (const seed of batch) {
    const year = Number(seed.year);
    const sport = String(seed.sport || SPORT_DEFAULT);
    // setName is the display product ("2026 Bowman Chrome"); strip the year so
    // discovery gets the brand it probes on.
    const brand = String(seed.setName || seed.setKey || "")
      .replace(/^(19|20)\d{2}(-\d{2})?\s+/, "")
      .replace(/\s+(baseball|basketball|football|hockey|soccer)\s*$/i, "")
      .trim();
    console.log(`── ${seed.id}  (demand ${seed.requestCount})`);
    console.log(`   brand="${brand}" year=${year} sport=${sport}`);
    if (!brand || !Number.isFinite(year)) {
      console.log(`   SKIP — cannot derive a brand/year to probe`);
      await markSeed(seed, "unavailable", { drainReason: "no-brand-or-year" });
      summary.unavailable++;
      continue;
    }

    let found;
    try {
      found = await discoverUrl(year, brand, sport);
    } catch (e) {
      console.log(`   discovery ERROR ${e.message}`);
      summary.failed++;
      continue;
    }
    if (!found || !found.success || !found.url) {
      const probes = found ? found.attempts.length : 0;
      console.log(`   no Beckett checklist found (${probes} probes) — leaving as real unserved demand`);
      await markSeed(seed, "unavailable", { drainReason: "no-checklist-published", probes });
      summary.unavailable++;
      continue;
    }
    console.log(`   found: ${found.url}`);
    summary.acquired++;
    if (!APPLY) { console.log(`   (dry run — not downloading/ingesting)\n`); continue; }

    const tmp = path.join(os.tmpdir(), `seed-${seed.id.replace(/[^a-z0-9]+/gi, "-")}.xlsx`);
    const csv = path.join(BACKEND, "data/checklists/scraped", `${year}-${String(seed.setKey)}.csv`);
    try {
      await download(found.url, tmp);
    } catch (e) {
      console.log(`   download failed: ${e.message}`);
      summary.failed++;
      continue;
    }

    const conv = run("node", ["scripts/convertBeckettChecklistXlsx.cjs",
      "--xlsx", tmp, "--year", String(year), "--set-key", String(seed.setKey),
      "--set-name", String(seed.setName || seed.setKey), "--out", csv,
      "--source-url", found.url, "--sport", sport]);
    if (conv.code !== 0) {
      console.log(`   convert failed:\n${conv.out.split("\n").slice(-4).join("\n")}`);
      summary.failed++;
      continue;
    }
    console.log(`   ${conv.out.split("\n").find((l) => l.includes("rows=")) || "converted"}`);

    const ing = run("node", ["scripts/ingest-scraped-checklist.cjs"],
      { CSV_PATH: csv, SOURCE_LABEL: "beckett", APPLY: "true" });
    if (ing.code !== 0) {
      console.log(`   ingest failed:\n${ing.out.split("\n").slice(-4).join("\n")}`);
      summary.failed++;
      continue;
    }
    const wrote = ing.out.split("\n").find((l) => l.includes("wrote=")) || "";
    console.log(`   ingested: ${wrote.trim()}`);
    summary.ingested++;
    await markSeed(seed, "done", { drainReason: "ingested", sourceUrl: found.url });
    console.log("");
  }

  console.log(`\nacquired=${summary.acquired} ingested=${summary.ingested} unavailable=${summary.unavailable} failed=${summary.failed}`);

  // Closing the loop: staging rows parked on awaitingCatalog can now promote.
  // Only worth running when a checklist actually landed.
  if (APPLY && summary.ingested > 0) {
    console.log(`\nre-running promotion so rows awaiting these checklists can land…`);
    const promo = run("node", ["-e", `
      (async () => {
        const { runPromotionBatch } = require("./dist/services/portfolioiq/promotionJob.service.js");
        const r = await runPromotionBatch(200);
        console.log(JSON.stringify(r));
      })().catch(e => { console.error(e.message); process.exit(1); });
    `]);
    console.log(promo.out.trim().split("\n").slice(-3).join("\n"));
  }

  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
