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
const DISC_CONC = Number(val("--discovery-concurrency", "12"));

/**
 * Seed rows store the product inconsistently — "2024 Bowman Chrome Baseball",
 * "topps-chrome", "topps-tier-one". Beckett S3 keys are cased display names
 * ("2024-Bowman-Chrome-Baseball-Checklist.xlsx") and the keys are
 * case-sensitive, so a slug-form brand can never match. Normalise to display
 * form: drop a leading year and a trailing sport, split on hyphens/underscores,
 * Title Case.
 *
 *   "topps-chrome"                  -> "Topps Chrome"
 *   "2024 Bowman Chrome Baseball"   -> "Bowman Chrome"
 *   "topps-tier-one"                -> "Topps Tier One"
 */
function deslugBrand(raw) {
  return String(raw || "")
    .replace(/^(19|20)\d{2}(-\d{2})?[\s_-]+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+(baseball|basketball|football|hockey|soccer)\s*$/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

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
  console.log(`\ndraining ${batch.length} highest-demand seed(s)  discovery-concurrency=${DISC_CONC}\n`);

  const summary = { acquired: 0, ingested: 0, unavailable: 0, failed: 0 };

  // CF-SEED-BRAND-CANDIDATES (Drew, 2026-08-13: "let's find the catalog and
  // build it. The checklist is important").
  //
  // brand used to be `setName || setKey` verbatim, and seeds store that
  // inconsistently — sometimes a display product ("2024 Bowman Chrome
  // Baseball"), sometimes a raw slug ("topps-chrome", "topps-tier-one").
  // Beckett S3 keys are cased display names and case-sensitive, so a slug-form
  // brand could never match; those misses were then recorded as
  // "no-checklist-published", i.e. we wrote off coverage that was free.
  //
  // Probe BOTH derivations. They disagree usefully: seed:baseball:2025:topps
  // carries setName "topps-tier-one", so setName finds Tier One and setKey
  // finds base Topps. We ingest EVERY distinct checklist a seed resolves to —
  // those are genuinely different products and both have demand, and taking
  // only the first hit left the other unserved.
  function brandCandidates(seed) {
    const out = [];
    const add = (b) => { if (b && !out.includes(b)) out.push(b); };
    add(deslugBrand(seed.setName));
    add(deslugBrand(seed.setKey));
    // Flagship Topps baseball never ships a bare "Topps" checklist — it is
    // Series One / Series Two (Drew: "2026 topps is series one or series two").
    // That is why 2026 Topps, the highest-demand miss at 92, failed 240 probes
    // even with correct casing.
    for (const b of [...out]) {
      if (/^topps$/i.test(b)) {
        add("Topps Series One"); add("Topps Series Two");
        add("Topps Series 1");   add("Topps Series 2");
      }
    }
    return out;
  }

  // PHASE 1 — discovery, in parallel. This is where the time goes: a miss costs
  // 240 sequential HEAD probes, so running seeds serially made a full drain of
  // 2,282 seeds take days. Download/convert/ingest stay serial below because
  // they spawn child processes and write Cosmos.
  const found = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: DISC_CONC }, async () => {
    while (cursor < batch.length) {
      const seed = batch[cursor++];
      const year = Number(seed.year);
      const sport = String(seed.sport || SPORT_DEFAULT);
      const candidates = brandCandidates(seed);
      if (candidates.length === 0 || !Number.isFinite(year)) {
        console.log(`── ${seed.id}  SKIP — no brand/year`);
        await markSeed(seed, "unavailable", { drainReason: "no-brand-or-year" });
        summary.unavailable++;
        continue;
      }
      const hits = [];
      let probes = 0;
      for (const brand of candidates) {
        try {
          const a = await discoverUrl(year, brand, sport);
          probes += a && a.attempts ? a.attempts.length : 0;
          if (a && a.success && a.url && !hits.some((h) => h.url === a.url)) {
            hits.push({ url: a.url, brand });
          }
        } catch { /* try the next candidate */ }
      }
      if (hits.length === 0) {
        console.log(`── ${seed.id}  (dmd ${seed.requestCount})  no checklist  [${probes} probes: ${candidates.join(" | ")}]`);
        await markSeed(seed, "unavailable", { drainReason: "no-checklist-published", probes });
        summary.unavailable++;
        continue;
      }
      console.log(`── ${seed.id}  (dmd ${seed.requestCount})  ${hits.length} checklist(s)`);
      for (const h of hits) console.log(`     ${h.brand} → ${h.url}`);
      summary.acquired += hits.length;
      found.push({ seed, hits });
    }
  }));

  if (!APPLY) {
    console.log(`\nacquired=${summary.acquired} unavailable=${summary.unavailable}`);
    console.log("\nDRY RUN — nothing downloaded or ingested. Re-run with --apply.");
    return;
  }

  // PHASE 2 — download + convert + ingest, serial.
  for (const entry of found) {
    const seed = entry.seed;
    const year = Number(seed.year);
    const sport = String(seed.sport || SPORT_DEFAULT);
    let anyIngested = false;
    for (const hit of entry.hits) {
      const brandKey = hit.brand.toLowerCase().replace(/\s+/g, "-");
      const tag = `${year}-${brandKey}-${sport}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const tmp = path.join(os.tmpdir(), `seed-${tag}.xlsx`);
      const csv = path.join(BACKEND, "data/checklists/scraped", `${tag}.csv`);
      try {
        await download(hit.url, tmp);
      } catch (e) {
        console.log(`   [${tag}] download failed: ${e.message}`);
        summary.failed++;
        continue;
      }
      // set-key/set-name come from the BRAND THAT MATCHED, not the seed's key.
      // Otherwise a Tier One checklist gets ingested under setKey "topps" and
      // silently impersonates the flagship — which is exactly how the earlier
      // run "served" seed:baseball:2025:topps without serving base Topps.
      const conv = run("node", ["scripts/convertBeckettChecklistXlsx.cjs",
        "--xlsx", tmp, "--year", String(year), "--set-key", brandKey,
        "--set-name", hit.brand, "--out", csv,
        "--source-url", hit.url, "--sport", sport]);
      if (conv.code !== 0) {
        console.log(`   [${tag}] convert failed:\n${conv.out.split("\n").slice(-3).join("\n")}`);
        summary.failed++;
        continue;
      }
      const ing = run("node", ["scripts/ingest-scraped-checklist.cjs"],
        { CSV_PATH: csv, SOURCE_LABEL: "beckett", APPLY: "true" });
      if (ing.code !== 0) {
        console.log(`   [${tag}] ingest failed:\n${ing.out.split("\n").slice(-3).join("\n")}`);
        summary.failed++;
        continue;
      }
      const wrote = (ing.out.split("\n").find((l) => l.includes("wrote=")) || "").trim();
      console.log(`   [${tag}] ingested: ${wrote}`);
      summary.ingested++;
      anyIngested = true;
    }
    if (anyIngested) {
      await markSeed(seed, "done", { drainReason: "ingested", sourceUrl: entry.hits[0].url });
    }
  }

  console.log(`\nacquired=${summary.acquired} ingested=${summary.ingested} unavailable=${summary.unavailable} failed=${summary.failed}`);

  // Closing the loop: staging rows parked on awaitingCatalog can now promote.
  // Only worth running when a checklist actually landed.
  if (APPLY && summary.ingested > 0) {
    console.log(`\nre-running promotion so rows awaiting these checklists can land…`);
    const promo = run("node", ["-e", `
      (async () => {
        const { runPromotionBatch } = require("./dist/services/portfolioiq/promotionJob.service.js");
        const r = await runPromotionBatch({ limit: 2000 });
        console.log(JSON.stringify(r));
      })().catch(e => { console.error(e.message); process.exit(1); });
    `]);
    console.log(promo.out.trim().split("\n").slice(-3).join("\n"));
  }

  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
