#!/usr/bin/env node
/**
 * CF-CLC-SWEEP (Drew, 2026-08-09). Enumerates baseball checklists on
 * checklistcenter.com, filters by year, and runs the ingester on each.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/checklistCenterSweep.cjs \
 *     --years=2024,2025,2026 [--apply] [--limit=10]
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const YEARS = (argOf("years", "2024,2025,2026").split(",")).map(Number);
const LIMIT = Number(argOf("limit", "999"));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function enumerateUrls() {
  const all = new Set();
  for (const n of ["", "2", "3", "4"]) {
    const url = `https://www.checklistcenter.com/post-sitemap${n}.xml`;
    try {
      const xml = (await httpsGet(url)).toString("utf8");
      const rx = /https:\/\/www\.checklistcenter\.com\/[a-z0-9\-]+\//gi;
      let m;
      while ((m = rx.exec(xml))) all.add(m[0]);
    } catch (err) {
      console.warn(`sitemap${n}: ${err.message}`);
    }
  }
  return [...all];
}

// --html mode: use the HTML ingester (older products without XLSX).
const USE_HTML = process.argv.includes("--html");
const INGESTER_SCRIPT = USE_HTML
  ? "backend/scripts/ingestChecklistCenterHtml.cjs"
  : "backend/scripts/ingestChecklistCenter.cjs";

function runIngester(url) {
  const args = [path.resolve(INGESTER_SCRIPT), `--url=${url}`];
  if (APPLY) args.push("--apply");
  const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  const lines = (r.stdout ?? "").split("\n");
  const doneLine = lines.find((l) => /DONE — upserted/.test(l))
                ?? lines.find((l) => /Total rows to upsert/i.test(l))
                ?? lines.find((l) => /Catalog rows built/i.test(l))
                ?? "(no result)";
  return { code: r.status, doneLine, err: (r.stderr ?? "").split("\n").slice(0, 3).join(" | ") };
}

// Parse a checklistcenter URL into (year, setKey) so we can check
// whether this product has already been ingested. Match to
// parseUrlMeta() in ingestChecklistCenter.cjs.
function parseUrlToMeta(url) {
  const slug = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
  const yearMatch = /^(19\d{2}|20\d{2})-/.exec(slug);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const withoutYear = slug.replace(/^\d{4}-/, "");
  const setKeyMatch = /^(.+?)-baseball-/.exec(withoutYear);
  const setKey = setKeyMatch ? setKeyMatch[1] : null;
  return { year, setKey };
}

async function loadAlreadyIngested() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return new Set();
  const { CosmosClient } = require("@azure/cosmos");
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  // Retry on 429 with exponential backoff — the count/group query is
  // expensive and gets throttled when writes are in flight.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Match whichever ingester's source is active this run.
      const sourceLike = USE_HTML ? "checklistcenter-html" : "checklistcenter";
      const q = await cat.items.query({
        query: "SELECT c.year, c.setKey, COUNT(1) AS n FROM c WHERE c.source = @s GROUP BY c.year, c.setKey",
        parameters: [{ name: "@s", value: sourceLike }],
      }).fetchAll();
      const seen = new Set();
      for (const r of q.resources) if (r.n > 100) seen.add(`${r.year}::${r.setKey}`);
      return seen;
    } catch (err) {
      const is429 = err?.code === 429 || /request rate is too large/i.test(err?.message ?? "");
      if (!is429 || attempt === 4) {
        console.warn(`[clc-sweep] loadAlreadyIngested failed (${err.message.slice(0,80)}) — proceeding without skip list (harmless re-upserts)`);
        return new Set();
      }
      const wait = 3000 * (attempt + 1);
      console.warn(`[clc-sweep] loadAlreadyIngested 429 attempt ${attempt+1}, waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return new Set();
}

(async () => {
  console.log(`[clc-sweep] years=${YEARS.join(",")} apply=${APPLY} limit=${LIMIT}`);
  const all = await enumerateUrls();
  const yearRx = new RegExp(`/(${YEARS.join("|")})-`);
  const baseballRx = /(baseball|topps|bowman|panini|leaf|donruss).*checklist/i;
  // --wide mode: loosen filter to any -checklist URL for the given
  // years. Catches products with unusual naming (topps-heritage-checklist,
  // hobby-boxes checklists, insert-only products, etc.).
  const WIDE = process.argv.includes("--wide");
  const targets = all
    .filter((u) => yearRx.test(u))
    .filter((u) => WIDE ? /checklist/.test(u) : baseballRx.test(u))
    .filter((u) => WIDE ? true : /-(baseball)-.*checklist/.test(u))
    // Exclude clearly non-baseball products even in --wide mode
    .filter((u) => !/football|basketball|hockey|soccer|wrestling|mma|racing|nascar|pokemon|magic-the/i.test(u))
    .sort()
    .slice(0, LIMIT);
  console.log(`[clc-sweep] ${targets.length} URLs match filter (mode: ${WIDE ? "WIDE" : "strict"})`);

  // Skip products already ingested (>100 rows exist for (year, setKey))
  const alreadyDone = APPLY ? await loadAlreadyIngested() : new Set();
  console.log(`[clc-sweep] ${alreadyDone.size} products already ingested — will skip`);

  const results = [];
  let total = 0;
  let errors = 0;
  let skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    const meta = parseUrlToMeta(url);
    const key = meta.year && meta.setKey ? `${meta.year}::${meta.setKey}` : null;
    if (key && alreadyDone.has(key)) {
      skipped++;
      process.stdout.write(`\n[${i+1}/${targets.length}] SKIP (already done): ${url}\n`);
      continue;
    }
    process.stdout.write(`\n[${i+1}/${targets.length}] ${url}\n`);
    const r = runIngester(url);
    if (r.code !== 0) {
      errors++;
      console.log(`  ✗ FAIL: ${r.err.slice(0, 200)}`);
      results.push({ url, ok: false, err: r.err.slice(0, 200) });
      continue;
    }
    console.log(`  ${r.doneLine.trim()}`);
    const m = /upserted\s+(\d+)/.exec(r.doneLine);
    const n = m ? Number(m[1]) : 0;
    total += n;
    results.push({ url, ok: true, upserted: n });
  }

  console.log(`\n═══ SWEEP SUMMARY ═══`);
  console.log(`Products: ${targets.length}`);
  console.log(`Success:  ${results.filter((r) => r.ok).length}`);
  console.log(`Failures: ${errors}`);
  console.log(`Total ${APPLY ? "upserted" : "would-upsert"}: ${total.toLocaleString()}`);

  fs.writeFileSync("C:/Users/dvabu/AppData/Local/Temp/clc-sweep-results.json", JSON.stringify(results, null, 2));
  console.log(`\nDetailed results: C:/Users/dvabu/AppData/Local/Temp/clc-sweep-results.json`);
})().catch((e) => { console.error(e); process.exit(1); });
