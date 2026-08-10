#!/usr/bin/env node
/**
 * CF-BCP-SWEEP (Drew, 2026-08-10). Enumerates BCP year pages,
 * extracts product URLs, and runs ingestBaseballCardPedia.cjs on each.
 *
 * Year pages: https://baseballcardpedia.com/index.php/{YYYY}
 *   → contain /index.php/{YYYY}_{Product_Name} links
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/baseballCardPediaSweep.cjs \
 *     [--years=2020,2021,...,2026] [--apply]
 */

const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const YEARS = (argOf("years", "").split(",").filter(Boolean).map(Number));
if (YEARS.length === 0) {
  for (let y = 1950; y <= 2026; y++) YEARS.push(y);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return httpsGet(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Parse BCP URL → { year, setKey }
// e.g. "2023_Bowman_Chrome" → year=2023 setKey="bowman-chrome"
// "2023_Bowman%27s_Best" → year=2023 setKey="bowmans-best"
function parseProductUrl(urlPath) {
  const slug = urlPath.replace("/index.php/", "").replace(/%27/g, "").replace(/%26/g, "and");
  const m = /^(\d{4})[_\-](.+)$/.exec(slug);
  if (!m) return null;
  const year = Number(m[1]);
  const setKey = m[2].toLowerCase().replace(/[_\-]+/g, "-").replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return { year, setKey };
}

function runIngester(url, year, setKey) {
  const args = [
    path.resolve("backend/scripts/ingestBaseballCardPedia.cjs"),
    `--url=${url}`, `--year=${year}`, `--setKey=${setKey}`,
  ];
  if (APPLY) args.push("--apply");
  const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  const lines = (r.stdout ?? "").split("\n");
  const doneLine = lines.find((l) => /DONE — upserted/.test(l))
                ?? lines.find((l) => /Total rows/i.test(l))
                ?? "(no result)";
  return { code: r.status, doneLine };
}

(async () => {
  console.log(`[bcp-sweep] apply=${APPLY} years=${YEARS.length} (${YEARS[0]}-${YEARS[YEARS.length-1]})`);
  const allProducts = [];
  for (const year of YEARS) {
    try {
      const html = (await httpsGet(`https://baseballcardpedia.com/index.php/${year}`)).toString("utf8");
      const rx = new RegExp(`href="/index\\.php/${year}[_\\-][^"]+"`, "g");
      const found = new Set();
      let m;
      while ((m = rx.exec(html))) {
        const u = m[0].slice(6, -1);   // strip href=" and "
        found.add(u);
      }
      for (const u of found) allProducts.push({ year, urlPath: u });
    } catch (err) {
      console.warn(`year ${year} fetch fail: ${err.message}`);
    }
  }
  console.log(`[bcp-sweep] Total product URLs discovered: ${allProducts.length}`);

  let ok = 0, fail = 0, ingested = 0;
  for (let i = 0; i < allProducts.length; i++) {
    const { year, urlPath } = allProducts[i];
    const meta = parseProductUrl(urlPath);
    if (!meta || meta.year !== year) { fail++; continue; }
    const fullUrl = `https://baseballcardpedia.com${urlPath}`;
    const r = runIngester(fullUrl, meta.year, meta.setKey);
    if (r.code === 0) {
      ok++;
      const nm = r.doneLine.match(/upserted (\d+)/);
      if (nm) ingested += Number(nm[1]);
      if (i % 10 === 0) process.stdout.write(`\r  [${i+1}/${allProducts.length}] ok=${ok} · rows=${ingested}`);
    } else {
      fail++;
    }
  }
  console.log(`\n\n═══ SUMMARY ═══`);
  console.log(`Products:  ${allProducts.length}`);
  console.log(`OK:        ${ok}`);
  console.log(`Fail:      ${fail}`);
  console.log(`Rows ${APPLY ? "ingested" : "would-ingest"}: ${ingested.toLocaleString()}`);
})().catch((e) => { console.error(e); process.exit(1); });
