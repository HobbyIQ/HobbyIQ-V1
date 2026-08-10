#!/usr/bin/env node
/**
 * CF-CHECKLISTCENTER-INGESTER (Drew, 2026-08-09). Ingests
 * checklistcenter.com XLSX checklists. Better than Beckett because
 * the XLSX is already exploded: each parallel is its own "set" with
 * the same player list, and Print Run is included per row. No
 * hardcoded parallel manifest needed — the file IS the manifest.
 *
 * Doctrine per Drew 2026-08-09:
 *   "we need all cards period. So we use what we find on checklists
 *    to fix... but dont make up cards"
 * → Every XLSX row = one catalog row. Never invent parallels beyond
 *   what the checklist enumerates.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestChecklistCenter.cjs \
 *     --url=https://www.checklistcenter.com/2026-topps-chrome-baseball-card-checklist/ \
 *     [--apply]
 */

const XLSX = require("xlsx");
const { CosmosClient } = require("@azure/cosmos");
const https = require("https");
const path = require("path");
const fs = require("fs");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const URL = argOf("url");
const OVERRIDE_XLSX = argOf("xlsx");
const OVERRIDE_YEAR = Number(argOf("year"));
const OVERRIDE_SET_KEY = argOf("setKey");
const OVERRIDE_SPORT = argOf("sport");

if (!URL && !OVERRIDE_XLSX) { console.error("Missing --url or --xlsx"); process.exit(1); }

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

// Parse the checklistcenter URL to derive year + setKey + sport
function parseUrlMeta(url) {
  const slug = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
  const yearMatch = /^(19\d{2}|20\d{2})-/.exec(slug);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const withoutYear = slug.replace(/^\d{4}-/, "");
  const sportMatch = /-(baseball|basketball|football|hockey|soccer)-/.exec(withoutYear);
  const sport = sportMatch ? sportMatch[1] : "baseball";
  // setKey: everything between year- and -sport-, hyphenated
  const setKeyMatch = new RegExp(`^(.+?)-${sport}-`).exec(withoutYear);
  const setKey = setKeyMatch ? setKeyMatch[1] : withoutYear.replace(/-card-checklist$/, "");
  return { year, sport, setKey };
}

// Derive parallel name + slug from checklistcenter "Set" column value.
// Examples:
//   "Base" → { parallel: "Base", parallelSlug: "base" }
//   "Base Refractor" → { parallel: "Refractor", parallelSlug: "refractor" }
//   "Base Aqua Refractor" → { parallel: "Aqua Refractor", parallelSlug: "aqua-refractor" }
//   "Base SuperFractor" → { parallel: "SuperFractor", parallelSlug: "superfractor" }
//   "Base Printing Plates Black" → { parallel: "Printing Plates Black", parallelSlug: "printing-plates-black" }
// For non-Base subsets (Insert, Autograph, etc.), the whole Set name is the parallel.
// Sanitize a parallel slug so it's a valid Cosmos ID segment.
// Cosmos rejects /, \, #, ? in ids — collapse them to hyphens.
function sanitizeSlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\/\\#?]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveParallel(setValue) {
  const s = String(setValue || "").trim();
  if (!s) return { parallel: "Base", parallelSlug: "base", subsetName: "Base" };
  // If starts with "Base ", strip and treat rest as parallel
  const baseMatch = /^Base\s+(.+)$/i.exec(s);
  if (baseMatch) {
    const parallel = baseMatch[1].trim();
    return {
      parallel,
      parallelSlug: sanitizeSlug(parallel),
      subsetName: "Base",
    };
  }
  if (/^Base$/i.test(s)) return { parallel: "Base", parallelSlug: "base", subsetName: "Base" };
  // Non-base subset: entire name is the "subset" and default parallel is Base
  return { parallel: "Base", parallelSlug: "base", subsetName: s };
}

// Detect isAuto from Set name (contains "Auto"/"Signature") or card number prefix
function detectIsAuto(setValue, cardNumber) {
  const s = String(setValue || "");
  if (/\bauto/i.test(s) || /\bsignature/i.test(s) || /\bautograph/i.test(s)) return true;
  const cn = String(cardNumber || "").trim().toUpperCase();
  return /^(CPA|CPRA|CPAA|BSPA|CDA|CFA|BCPA|AUTO)-/i.test(cn);
}

function parsePrintRun(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

(async () => {
  const meta = URL ? parseUrlMeta(URL) : {};
  const year = OVERRIDE_YEAR || meta.year;
  const setKey = OVERRIDE_SET_KEY || meta.setKey;
  const sport = OVERRIDE_SPORT || meta.sport;
  if (!year || !setKey || !sport) {
    console.error(`Couldn't derive year/setKey/sport from URL. Got: year=${year} setKey=${setKey} sport=${sport}`);
    process.exit(1);
  }
  console.log(`[clc-ingest] MODE=${APPLY ? "APPLY" : "DRY-RUN"} year=${year} setKey=${setKey} sport=${sport}`);

  // Fetch page + XLSX
  let xlsxPath = OVERRIDE_XLSX;
  if (!xlsxPath) {
    console.log(`[clc-ingest] fetching ${URL}`);
    const html = (await httpsGet(URL)).toString("utf8");
    const xlsxMatch = /href="([^"]*\.xlsx[^"]*)"/i.exec(html);
    if (!xlsxMatch) { console.error("No XLSX link on page"); process.exit(1); }
    const xlsxUrl = xlsxMatch[1];
    const localName = `clc-${year}-${setKey}.xlsx`;
    xlsxPath = `C:/Users/dvabu/AppData/Local/Temp/${localName}`;
    if (!fs.existsSync(xlsxPath)) {
      console.log(`[clc-ingest] downloading ${xlsxUrl}`);
      fs.writeFileSync(xlsxPath, await httpsGet(xlsxUrl));
    } else {
      console.log(`[clc-ingest] using cached ${xlsxPath}`);
    }
  }

  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idxSet = header.indexOf("set");
  const idxNumber = header.indexOf("number");
  const idxName = header.indexOf("name");
  const idxTeam = header.indexOf("team");
  const idxPR = header.indexOf("print run");
  if (idxSet < 0 || idxNumber < 0 || idxName < 0) {
    console.error(`Unexpected header shape: ${JSON.stringify(header)}`);
    process.exit(1);
  }

  const catalogRows = [];
  let seenSubsets = new Map();  // subsetName → count
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const setValue = String(r[idxSet] ?? "").trim();
    const cardNumber = String(r[idxNumber] ?? "").trim();
    const playerName = String(r[idxName] ?? "").trim();
    if (!setValue || !cardNumber || !playerName) continue;
    const team = idxTeam >= 0 ? String(r[idxTeam] ?? "").trim() : "";
    const printRun = idxPR >= 0 ? parsePrintRun(r[idxPR]) : null;
    const { parallel, parallelSlug, subsetName } = deriveParallel(setValue);
    seenSubsets.set(subsetName, (seenSubsets.get(subsetName) ?? 0) + 1);
    const isAuto = detectIsAuto(setValue, cardNumber);
    const cardNumSlug = sanitizeSlug(cardNumber);
    const autoSuffix = isAuto ? ":auto" : ":no-auto";
    const printRunSuffix = printRun ? `:num-${printRun}` : "";
    const slug = `hiq:${sport}:${year}:${setKey}:${cardNumSlug}:${parallelSlug}${autoSuffix}${printRunSuffix}`;
    const searchTokens = new Set([
      ...playerName.toLowerCase().split(/\s+/).filter(Boolean),
      ...setKey.split("-").filter(Boolean),
      cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
      String(year),
      parallelSlug, ...parallelSlug.split("-").filter(Boolean),
      isAuto ? "auto" : null,
    ].flat().filter(Boolean));
    catalogRows.push({
      id: slug, cardId: slug, hobbyiqCardId: slug,
      sport, year, setKey,
      setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      cardNumber, playerName, team: team || null,
      parallel, parallelSlug, isAuto, printRun,
      source: "checklistcenter",
      catalogVersion: 2,
      catalogBatch: "checklistcenter-2026-08-09",
      verificationStatus: "verified",
      builtAt: "2026-08-09T00:00:00.000Z",
      subsetName,
      searchTokens: [...searchTokens],
    });
  }

  console.log(`\n[clc-ingest] Rows in XLSX: ${rows.length - 1}`);
  console.log(`[clc-ingest] Catalog rows built: ${catalogRows.length}`);
  console.log(`[clc-ingest] Distinct subsets: ${seenSubsets.size}`);
  console.log(`[clc-ingest] Top 10 subsets by row count:`);
  const sortedSubsets = [...seenSubsets.entries()].sort((a, b) => b[1] - a[1]);
  for (const [s, n] of sortedSubsets.slice(0, 10)) console.log(`   ${s.padEnd(50)} ${n}`);

  console.log(`\n[clc-ingest] SAMPLE (first 5):`);
  for (const r of catalogRows.slice(0, 5)) {
    console.log(`  ${r.hobbyiqCardId}`);
    console.log(`    ${r.playerName} · ${r.parallel} · /${r.printRun ?? "-"} · auto=${r.isAuto}`);
  }

  if (!APPLY) { console.log(`\n[clc-ingest] DRY-RUN. --apply to write.`); return; }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[clc-ingest] APPLY — upserting ${catalogRows.length} rows (concurrency 24)`);
  let done = 0, errors = 0;
  const CH = 24;
  for (let i = 0; i < catalogRows.length; i += CH) {
    const batch = catalogRows.slice(i, i + CH);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
    if (done % 1000 === 0 || done === catalogRows.length) process.stdout.write(`\r   ${done}/${catalogRows.length} (${errors} err)`);
  }
  console.log(`\n[clc-ingest] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
