// CF-BATCH-BBM-ALL (Drew, 2026-08-11). Consume the Wayback CDX URL
// list of BBM signlist PDFs (2016-2026, all products including team
// sets), download live → Wayback fallback, extract text, parse into
// hand-fetched manifests. Companion to batchDownloadParseBbm.cjs
// which was flagship-only.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRATCH = "C:/Users/dvabu/AppData/Local/Temp/claude/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1/44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7/scratchpad";
const HAND_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");
const PARSER = path.resolve(__dirname, "parseBbmChecklistPdf.cjs");
const URL_LIST = `${SCRATCH}/wayback-bbm-baseball-urls.txt`;

// Team-set slug → English-league team abbreviation for setName clarity
const TEAM_MAP = {
  tigers: "Hanshin Tigers", carp: "Hiroshima Carp", dragons: "Chunichi Dragons",
  swallows: "Yakult Swallows", giants: "Yomiuri Giants", baystars: "Yokohama DeNA BayStars",
  dena: "Yokohama DeNA BayStars", fighters: "Hokkaido Nippon-Ham Fighters",
  hawks: "Fukuoka SoftBank Hawks", lions: "Saitama Seibu Lions", eagles: "Tohoku Rakuten Eagles",
  marines: "Chiba Lotte Marines", orix: "Orix Buffaloes",
};

function parseFilename(url) {
  // e.g. https://www.sportsclick.jp/user_data/signlist/2023dragons.pdf
  const base = url.replace(/^https?:\/\/[^/]+\//, "").split("/").pop();
  const noExt = base.replace(/\.pdf$/i, "").replace(/_list$/i, "");
  // Extract year prefix
  const m = /^(\d{4})(.+)$/.exec(noExt);
  if (!m) return null;
  const [_, y, rest] = m;
  return { year: Number(y), product: rest, base };
}

function productToSet(product) {
  if (product === "1st" || product === "bbm1st") return { version: "1st Version", productSuffix: "1st-version", setKey: "bbm-1st-version" };
  if (product === "2nd" || product === "bbm2nd") return { version: "2nd Version", productSuffix: "2nd-version", setKey: "bbm-2nd-version" };
  const team = TEAM_MAP[product.toLowerCase()];
  if (team) return { version: team, productSuffix: `team-${product.toLowerCase()}`, setKey: `bbm-${product.toLowerCase()}` };
  // Everything else: use raw product as suffix + setKey
  const cleanProd = product.toLowerCase().replace(/^bbm/, "");
  return { version: cleanProd.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase()), productSuffix: cleanProd, setKey: `bbm-${cleanProd}` };
}

function tryDownload(url, pdfPath) {
  try {
    execSync(`curl -sf -o "${pdfPath}" "${url}"`, { stdio: "pipe" });
    return "live";
  } catch {
    // Wayback fallback: query CDX for most recent snapshot
    try {
      execSync(
        `curl -sf -L -o "${pdfPath}" "https://web.archive.org/web/2im_/${url}"`,
        { stdio: "pipe" },
      );
      return "wayback";
    } catch { return null; }
  }
}

function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  if (!fs.existsSync(URL_LIST)) { console.error(`URL list missing: ${URL_LIST}`); process.exit(1); }
  const urls = fs.readFileSync(URL_LIST, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(`▸ processing ${urls.length} URLs`);

  let ok = 0, empty = 0, fail = 0, live = 0, wb = 0;
  let totalBase = 0, totalInsert = 0;
  const summary = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const parsed = parseFilename(url);
    if (!parsed) { fail++; continue; }
    const { year, product, base } = parsed;
    const meta = productToSet(product);
    const pdfPath = `${SCRATCH}/${year}-${product}.pdf`;
    const txtPath = `${SCRATCH}/${year}-${product}.txt`;
    const outPath = `${HAND_DIR}/${year}-bbm-${meta.productSuffix}.json`;

    // Skip already-processed non-zero manifests (idempotent)
    if (fs.existsSync(outPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if ((doc.baseSet?.length || 0) > 0) { continue; }
      } catch {}
    }

    const dlSource = tryDownload(url, pdfPath);
    if (!dlSource) { fail++; if (fail < 5) console.log(`  ✗ dl fail: ${base}`); continue; }
    if (dlSource === "live") live++; else wb++;

    try {
      execSync(`pdftotext -enc UTF-8 -layout "${pdfPath}" "${txtPath}"`, { stdio: "pipe" });
      execSync(`node "${PARSER}" "${txtPath}" ${year} "${meta.version}" > "${outPath}"`, { stdio: "pipe" });
      const doc = JSON.parse(fs.readFileSync(outPath, "utf8"));
      // Rewrite setKey/setName to match our schema
      doc.setKey = meta.setKey;
      doc.setName = `${year} BBM ${meta.version}`;
      doc.sourceUrl = url;
      fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
      const b = doc.baseSet?.length || 0;
      const ins = (doc.inserts || []).reduce((s, x) => s + (x.cards?.length || 0), 0);
      if (b === 0 && ins === 0) empty++;
      else { totalBase += b; totalInsert += ins; ok++; summary.push({ year, product: meta.productSuffix, b, ins }); }
      if ((i + 1) % 25 === 0) console.log(`  progress ${i+1}/${urls.length}  ok=${ok} empty=${empty} fail=${fail}  live=${live} wb=${wb}`);
    } catch (e) {
      fail++; if (fail < 5) console.log(`  ✗ parse fail ${base}: ${e.message.slice(0,80)}`);
    }
  }
  console.log(`\n[done] ok=${ok}  empty=${empty}  fail=${fail}  live=${live}  wayback=${wb}`);
  console.log(`  totalBase=${totalBase.toLocaleString()}  totalInsert=${totalInsert.toLocaleString()}`);
  // Top products by row count
  const byProduct = new Map();
  for (const s of summary) {
    const rec = byProduct.get(s.product) || { count: 0, base: 0, ins: 0 };
    rec.count++; rec.base += s.b; rec.ins += s.ins;
    byProduct.set(s.product, rec);
  }
  console.log(`\ntop products by base card count:`);
  const rows = [...byProduct.entries()].sort((a, b) => b[1].base - a[1].base).slice(0, 20);
  for (const [p, r] of rows) console.log(`  ${p.padEnd(35)} sets=${r.count} base=${r.base.toLocaleString()} ins=${r.ins.toLocaleString()}`);
}
main();
