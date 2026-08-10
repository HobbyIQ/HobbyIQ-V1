#!/usr/bin/env node
/**
 * CF-BECKETT-FULL-SWEEP (Drew, 2026-08-09). Enumerates known Beckett
 * product pages for baseball (2018-2026), downloads any XLSX
 * checklist found, and runs the ingester on each. Belt-and-suspenders
 * approach vs the discovery-crawler: hardcoded URL list ensures we
 * get every major product even if archive pagination is flaky.
 *
 * Products covered per year:
 *   Bowman, Bowman Chrome, Bowman Chrome Sapphire, Bowman Draft,
 *   Bowman Sterling, Bowman Mega Box, Bowman Chrome Mega Box
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/beckettFullSweep.cjs \
 *     [--years=2020,2021,...,2026] [--apply]
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
const YEARS = (argOf("years", "2020,2021,2022,2023,2024,2025,2026").split(",")).map(Number);
const DL_DIR = "C:/Users/dvabu/AppData/Local/Temp/beckett-sweep";
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Product slug → setKey mapping. slug goes into Beckett news URL as
// `{year}-{slug}-baseball-cards`; setKey goes into the ingester as
// `--setKey=...`. Subset drives which sheet gets ingested.
const PRODUCTS = [
  { slug: "bowman-chrome",          setKey: "bowman-chrome",          subset: "autographs" },
  { slug: "bowman",                 setKey: "bowman",                 subset: "autographs" },
  { slug: "bowman-draft",           setKey: "bowman-draft",           subset: "autographs" },
  { slug: "bowman-sterling",        setKey: "bowman-sterling",        subset: "autographs" },
  { slug: "bowman-chrome-sapphire", setKey: "bowman-chrome-sapphire", subset: "autographs" },
  { slug: "bowman-chrome-mega-box", setKey: "bowman-chrome",          subset: "autographs" },
  { slug: "bowman-mega-box",        setKey: "bowman",                 subset: "autographs" },
  { slug: "topps-chrome",           setKey: "topps-chrome",           subset: "autographs" },
  { slug: "topps",                  setKey: "topps",                  subset: "autographs" },
  { slug: "topps-update",           setKey: "topps-update",           subset: "autographs" },
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, "Accept": "text/html,*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function discoverXlsx(year, slug) {
  const pageUrl = `https://www.beckett.com/news/${year}-${slug}-baseball-cards/`;
  try {
    const html = (await httpsGet(pageUrl)).toString("utf8");
    const m = /href="([^"]*\.xlsx[^"]*)"/i.exec(html);
    return m ? { pageUrl, xlsxUrl: m[1] } : null;
  } catch (err) {
    return null;
  }
}

async function downloadXlsx(url, outPath) {
  if (fs.existsSync(outPath)) return true;
  try {
    const buf = await httpsGet(url);
    fs.writeFileSync(outPath, buf);
    return true;
  } catch { return false; }
}

// CF-DATA-DRIVEN-DEFAULT (Drew, 2026-08-09). Sweep now uses the
// data-driven ingester by default — only materializes catalog rows
// for parallels observed in sold_comps. Pass --hardcoded-manifest to
// use the legacy fixed-parallel ingester (creates phantoms).
const INGESTER_SCRIPT = process.argv.includes("--hardcoded-manifest")
  ? "backend/scripts/ingestBeckettChecklist.cjs"
  : "backend/scripts/ingestBeckettChecklistDataDriven.cjs";

function runIngester(xlsxPath, year, setKey, subset, apply) {
  const args = [
    path.resolve(INGESTER_SCRIPT),
    `--xlsx=${xlsxPath}`,
    `--year=${year}`,
    `--sport=baseball`,
    `--setKey=${setKey}`,
    `--subset=${subset}`,
  ];
  if (apply) args.push("--apply");
  const r = spawnSync("node", args, { encoding: "utf8" });
  const lines = (r.stdout ?? "").split("\n");
  const done = lines.find((l) => /DONE — upserted/.test(l))
             ?? lines.find((l) => /Total rows to upsert/i.test(l))
             ?? lines.find((l) => /TOTAL rows to upsert/.test(l))
             ?? "(no result line)";
  return { code: r.status, done };
}

(async () => {
  console.log(`[sweep] years=${YEARS.join(",")} apply=${APPLY}`);
  console.log(`[sweep] ${PRODUCTS.length} products × ${YEARS.length} years = ${PRODUCTS.length * YEARS.length} combos to check\n`);

  const results = [];
  for (const year of YEARS) {
    for (const p of PRODUCTS) {
      const found = await discoverXlsx(year, p.slug);
      if (!found) {
        results.push({ year, slug: p.slug, status: "no-page-or-xlsx" });
        continue;
      }
      const local = path.join(DL_DIR, `${year}-${p.slug}.xlsx`);
      const dl = await downloadXlsx(found.xlsxUrl, local);
      if (!dl) {
        results.push({ year, slug: p.slug, status: "download-fail", xlsxUrl: found.xlsxUrl });
        continue;
      }
      const ing = runIngester(local, year, p.setKey, p.subset, APPLY);
      results.push({ year, slug: p.slug, status: ing.code === 0 ? "ok" : "ingest-fail", done: ing.done });
      console.log(`  ${year} ${p.slug.padEnd(28)} ${ing.done}`);
    }
  }

  console.log(`\n═══ SWEEP SUMMARY ═══`);
  const ok = results.filter((r) => r.status === "ok");
  const misses = results.filter((r) => r.status !== "ok");
  console.log(`OK:    ${ok.length}`);
  console.log(`Miss:  ${misses.length}`);
  console.log(`\nMisses (no XLSX or fail):`);
  const missByReason = misses.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  for (const [k, v] of Object.entries(missByReason)) console.log(`  ${k}: ${v}`);

  const outPath = path.join(DL_DIR, "sweep-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results: ${outPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
