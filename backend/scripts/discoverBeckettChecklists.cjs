#!/usr/bin/env node
/**
 * CF-BECKETT-DISCOVER (Drew, 2026-08-09). Crawls Beckett's checklist
 * archive category pages, extracts XLSX download URLs from each
 * product page, and reports the full catalog of downloadable
 * checklist spreadsheets. Non-destructive discovery — dumps a JSON
 * manifest that ingestBeckettChecklist can consume.
 *
 * Usage:
 *   node backend/scripts/discoverBeckettChecklists.cjs [--sport=baseball] [--out=/tmp/beckett-manifest.json] [--download]
 *
 *   --sport      baseball | basketball | football | hockey (default baseball)
 *   --out        JSON output path (default /tmp/beckett-manifest.json)
 *   --download   also download each xlsx to /tmp/beckett-checklists/
 *   --limit-pages  cap archive pagination (default 20)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const SPORT = argOf("sport", "baseball").toLowerCase();
const OUT = argOf("out", "/tmp/beckett-manifest.json");
const DOWNLOAD = process.argv.includes("--download");
const DL_DIR = argOf("dl-dir", "C:/Users/dvabu/AppData/Local/Temp/beckett-checklists");
const MAX_PAGES = Number(argOf("limit-pages", "20"));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, "Accept": "text/html,*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("timeout: " + url)); });
  });
}

function extractProductLinks(html) {
  const links = new Set();
  // Beckett news post links typically shape: /news/{year}-{slug}-{sport}-cards/
  const rx = new RegExp(`href="(https?://www\\.beckett\\.com/news/[a-z0-9\\-]+-${SPORT}-cards/?)"`, "gi");
  let m;
  while ((m = rx.exec(html))) links.add(m[1]);
  // Also match hyphenated sport variants like "24-25-{sport}"
  const rx2 = /href="(https?:\/\/www\.beckett\.com\/news\/[a-z0-9\-]+-cards\/?)"/gi;
  while ((m = rx2.exec(html))) {
    // Only include if URL contains sport keyword or ambiguous multi-sport keyword
    if (new RegExp(SPORT, "i").test(m[1])) links.add(m[1]);
  }
  return [...links];
}

function extractXlsxLink(html) {
  const m = /href="([^"]*\.xlsx[^"]*)"/i.exec(html);
  return m ? m[1] : null;
}

function extractYearFromUrl(url) {
  const m = /\/(?:19|20)(\d{2})-/.exec(url);
  if (!m) return null;
  return 2000 + Number(m[1]);
}

function extractProductNameFromUrl(url) {
  // Strip sport-cards suffix + year prefix to get product name
  const seg = url.split("/").filter(Boolean).pop().replace(/-cards\/?$/, "");
  return seg.replace(/^\d{4}-?\d{0,2}-/, "");   // strip 2024- or 24-25- prefix
}

(async () => {
  console.log(`[discover] sport=${SPORT} download=${DOWNLOAD} maxPages=${MAX_PAGES}`);
  const ARCHIVE = `https://www.beckett.com/news/category/${SPORT}/${SPORT}-card-checklists/`;
  const productLinks = new Set();

  // Page 1 + paginated
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? ARCHIVE : `${ARCHIVE}page/${page}/`;
    try {
      const html = (await httpsGet(url)).toString("utf8");
      const links = extractProductLinks(html);
      if (links.length === 0) {
        console.log(`  page ${page}: 0 links (stop)`);
        break;
      }
      links.forEach((l) => productLinks.add(l));
      console.log(`  page ${page}: +${links.length} product links (total ${productLinks.size})`);
    } catch (err) {
      console.warn(`  page ${page} FAIL: ${err.message}`);
      break;
    }
  }

  console.log(`\n[discover] product pages: ${productLinks.size}`);
  console.log(`[discover] visiting each for XLSX link...`);

  const manifest = [];
  const links = [...productLinks];
  let visited = 0;
  let withXlsx = 0;
  const CONCURRENCY = 8;
  for (let i = 0; i < links.length; i += CONCURRENCY) {
    const batch = links.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (url) => {
      try {
        const html = (await httpsGet(url)).toString("utf8");
        const xlsx = extractXlsxLink(html);
        visited++;
        if (!xlsx) return;
        withXlsx++;
        const year = extractYearFromUrl(url);
        const productName = extractProductNameFromUrl(url);
        manifest.push({ url, xlsx, year, productName, sport: SPORT });
      } catch (err) {
        console.warn(`   ${url}: ${err.message}`);
      }
    }));
    process.stdout.write(`\r  visited ${visited}/${links.length} (${withXlsx} with xlsx)`);
  }
  console.log("");

  // Save manifest
  const outPath = OUT.startsWith("/tmp") ? "C:/Users/dvabu/AppData/Local/Temp/" + path.basename(OUT) : OUT;
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[discover] manifest: ${manifest.length} entries → ${outPath}`);

  // Downloads
  if (DOWNLOAD) {
    if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });
    console.log(`\n[discover] downloading ${manifest.length} XLSX files to ${DL_DIR}...`);
    let done = 0;
    for (const m of manifest) {
      try {
        const filename = `${m.year || "unknown"}-${m.productName.replace(/[^a-z0-9\-]/gi, "")}.xlsx`;
        const out = path.join(DL_DIR, filename);
        if (fs.existsSync(out)) { done++; continue; }
        const buf = await httpsGet(m.xlsx);
        fs.writeFileSync(out, buf);
        done++;
        process.stdout.write(`\r  downloaded ${done}/${manifest.length}`);
      } catch (err) {
        console.warn(`\n  ${m.xlsx}: ${err.message}`);
      }
    }
    console.log(`\n[discover] downloads complete: ${done}`);
  }

  // Sample summary by year
  const byYear = manifest.reduce((acc, m) => { acc[m.year || "unknown"] = (acc[m.year || "unknown"] || 0) + 1; return acc; }, {});
  console.log(`\n═══ MANIFEST SUMMARY ═══`);
  console.log(`Total XLSX discovered: ${manifest.length}`);
  console.log(`By year:`);
  for (const [y, n] of Object.entries(byYear).sort()) console.log(`  ${y}: ${n}`);
})().catch((e) => { console.error(e); process.exit(1); });
