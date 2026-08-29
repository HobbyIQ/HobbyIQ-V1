#!/usr/bin/env node
// !! DO NOT RUN -- superseded 2026-08-29 by checklist D3. This ingester raw-upserts
// !! into card_catalog with a ladder parser that turned player names into
// !! rungs. Use scrape-checklistcenter-products.cjs + convertChecklistCenterToChecklistCsv.cjs
// !! (the canonical CSV) through ingest-checklists-end-to-end.cjs phase "clc".
if (process.env.I_KNOW_THIS_IS_SUPERSEDED !== "true") { console.error("This ingester is superseded (checklist D3). Refusing to run."); process.exit(2); }
/**
 * CF-CLC-HTML-INGESTER (Drew, 2026-08-09). For older checklistcenter
 * pages (2016-2020) that don't publish an XLSX. Parses the inline
 * HTML structure:
 *
 *   <h3>{Year} {SetName} - {SubsetName} Set</h3>
 *   <p>N Cards<br />
 *   <strong>Parallels:</strong> ParallelName #/RUN; ParallelName #/RUN; ...</p>
 *   <div class="csColumn tablewpcol">
 *     <p>1 Mike Trout - Los Angeles Angels<br />
 *     2 Francisco Mejia - Cleveland Indians RC<br />
 *     ...</p>
 *   </div>
 *
 * The inline "Parallels:" line is the authoritative parallel manifest
 * for that subset — no hardcoding, no phantoms.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestChecklistCenterHtml.cjs \
 *     --url=https://www.checklistcenter.com/2018-bowman-baseball-card-checklist/ [--apply]
 */

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");
const fs = require("fs");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const URL = argOf("url");
if (!URL) { console.error("Missing --url"); process.exit(1); }

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
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseUrlMeta(url) {
  const slug = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
  const yearMatch = /^(19\d{2}|20\d{2})-/.exec(slug);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const withoutYear = slug.replace(/^\d{4}-/, "");
  const sport = "baseball";
  const setKeyMatch = /^(.+?)-baseball-/.exec(withoutYear);
  const setKey = setKeyMatch ? setKeyMatch[1] : null;
  return { year, sport, setKey };
}

function decodeHtml(s) {
  return String(s)
    .replace(/&#8211;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ");
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[\/\\#?]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Parse a "Parallels:" declaration line into an array of parallel manifests.
// Handles: "Sky Blue #/499; Purple #/250; Blue #/150; Green #/99 (Retail); Gold #/50; Orange #/25 (Hobby); Red #/5; Platinum 1/1; Printing Plates 1/1"
function parseParallels(text) {
  if (!text) return [];
  const parts = text.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    // "Sky Blue #/499" or "Platinum 1/1" or "Printing Plates 1/1"
    const m = /^(.+?)\s*(?:#\/|(?=\d+\/\d+))(\d+)(?:\/(\d+))?/.exec(part);
    if (!m) {
      // Might be an unnumbered parallel like "Base" (rare in these subsets)
      out.push({ name: part.replace(/\s+\([^)]*\)$/, "").trim(), printRun: null });
      continue;
    }
    let name = m[1].replace(/\s+\([^)]*\)$/, "").trim();
    // Strip trailing "1/1" for Printing Plates etc.
    const printRun = m[3] ? Number(m[3]) : Number(m[2]);
    if (name && printRun > 0) out.push({ name, printRun });
  }
  return out;
}

// Detect isAuto from subset name (contains "Auto" / "Autograph" / "Signature").
function isAutoSubset(subsetName) {
  return /\b(auto|autograph|signature)/i.test(String(subsetName || ""));
}

// Parse a card-list <p> block into rows: "1 Mike Trout - Los Angeles Angels"
// Handles: leading number, dash separator, RC flag suffix, HTML entities.
function parseCardList(pBlock) {
  const stripped = pBlock
    .replace(/<a[^>]*>|<\/a>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n/)
    .map((s) => decodeHtml(s).trim())
    .filter(Boolean);
  const cards = [];
  for (const line of stripped) {
    // Match: "1 Mike Trout - Los Angeles Angels" (numeric card)
    //     or "BCP-1 Player - Team RC" (letter-prefix numeric)
    //     or "CRA-AB Anthony Banda - Arizona Diamondbacks" (letter-prefix letters)
    //     or "AFL-JG Jesus Gonzalez - Braves" (fan-favorite subsets)
    const m = /^([A-Z0-9]{1,6}(?:-[A-Z0-9]{1,10})?[a-z]?)\s+([^-]+?)\s*[-–]\s*([^()]+?)(?:\s+\(?(RC|Rookie)\)?)?\s*$/.exec(line);
    if (!m) continue;
    const cardNumber = m[1].trim();
    const playerName = m[2].trim();
    const team = m[3].trim();
    const isRC = !!m[4];
    if (!playerName || playerName.length < 2) continue;
    cards.push({ cardNumber, playerName, team, isRC });
  }
  return cards;
}

// Split HTML by <h3> and extract per-subset chunks
function extractSubsets(html) {
  const subsets = [];
  const rx = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*>|$)/gi;
  let m;
  while ((m = rx.exec(html))) {
    const titleRaw = m[1].replace(/<[^>]+>/g, "").trim();
    const title = decodeHtml(titleRaw);
    const body = m[2];
    // Grab the Parallels declaration. Labels vary:
    //   "Parallels:" / "Refractor Parallels:" / "Autograph Parallels:" etc.
    const parMatch = /<strong>\s*(?:[A-Za-z\- ]+\s+)?Parallels?:?\s*<\/strong>\s*([\s\S]*?)<\/p>/i.exec(body);
    const parallelText = parMatch ? decodeHtml(parMatch[1].replace(/<[^>]+>/g, " ")) : "";
    const parallels = parseParallels(parallelText);
    // Extract card list from csColumn / csColumn tablewpcol blocks
    const cards = [];
    const colRx = /<div[^>]*class="[^"]*csColumn[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let cm;
    while ((cm = colRx.exec(body))) {
      const inner = cm[1];
      const pRx = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      let pm;
      while ((pm = pRx.exec(inner))) {
        cards.push(...parseCardList(pm[1]));
      }
    }
    subsets.push({ title, parallels, cards });
  }
  return subsets;
}

// Derive subsetSlug from subset title (e.g. "2018 Bowman - Chrome Prospects Autographs Set"
// → "chrome-prospects-autographs")
function subsetKey(title) {
  const cleaned = String(title || "")
    .replace(/^\d{4}\s+/, "")
    .replace(/\s+Set$/, "")
    .replace(/\s+Checklist$/, "")
    .replace(/^[^-]*-\s*/, "")
    .trim();
  return sanitizeSlug(cleaned) || "base";
}

(async () => {
  const meta = parseUrlMeta(URL);
  if (!meta.year || !meta.setKey) { console.error(`Bad URL meta: ${JSON.stringify(meta)}`); process.exit(1); }
  console.log(`[clc-html] MODE=${APPLY ? "APPLY" : "DRY-RUN"} year=${meta.year} setKey=${meta.setKey}`);

  const html = (await httpsGet(URL)).toString("utf8");
  const subsets = extractSubsets(html);
  console.log(`[clc-html] found ${subsets.length} subsets`);

  const rows = [];
  for (const sub of subsets) {
    const subKey = subsetKey(sub.title);
    const isAuto = isAutoSubset(sub.title);
    if (sub.cards.length === 0) continue;
    if (sub.parallels.length === 0) {
      // Still materialize a Base row per card
      sub.parallels.push({ name: "Base", printRun: null });
    }
    // Prepend Base as parallel #0 (checklist implicitly has base card + parallels list on top)
    const allParallels = [{ name: "Base", printRun: null }, ...sub.parallels];
    console.log(`  [${sub.title}] cards=${sub.cards.length} parallels=${allParallels.length} auto=${isAuto}`);
    for (const c of sub.cards) {
      const cardNumSlug = sanitizeSlug(c.cardNumber);
      for (const par of allParallels) {
        const parSlug = sanitizeSlug(par.name);
        const autoSuffix = isAuto ? ":auto" : ":no-auto";
        const printRunSuffix = par.printRun ? `:num-${par.printRun}` : "";
        const slug = `hiq:baseball:${meta.year}:${meta.setKey}:${cardNumSlug}:${parSlug}${autoSuffix}${printRunSuffix}`;
        const searchTokens = new Set([
          ...c.playerName.toLowerCase().split(/\s+/).filter(Boolean),
          ...meta.setKey.split("-").filter(Boolean),
          cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
          String(meta.year),
          parSlug, ...parSlug.split("-").filter(Boolean),
          isAuto ? "auto" : null,
        ].flat().filter(Boolean));
        rows.push({
          id: slug, cardId: slug, hobbyiqCardId: slug,
          sport: "baseball", year: meta.year, setKey: meta.setKey,
          setName: meta.setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
          cardNumber: c.cardNumber, playerName: c.playerName, team: c.team || null,
          parallel: par.name, parallelSlug: parSlug,
          isAuto, printRun: par.printRun,
          source: "checklistcenter-html",
          catalogVersion: 2,
          catalogBatch: "checklistcenter-html-2026-08-09",
          verificationStatus: "verified",
          builtAt: "2026-08-09T00:00:00.000Z",
          subsetName: sub.title,
          searchTokens: [...searchTokens],
        });
      }
    }
  }

  console.log(`\n[clc-html] Total rows to upsert: ${rows.length}`);
  if (rows.length > 0) {
    console.log(`Sample (first 5):`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.hobbyiqCardId}   ${r.playerName} · ${r.parallel} · /${r.printRun ?? "-"} · auto=${r.isAuto}`);
    }
  }

  if (!APPLY) { console.log(`\n[clc-html] DRY-RUN. --apply to write.`); return; }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[clc-html] APPLY — upserting ${rows.length} rows (concurrency 24)`);
  let done = 0, errors = 0;
  for (let i = 0; i < rows.length; i += 24) {
    const batch = rows.slice(i, i + 24);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
    if (done % 500 === 0 || done === rows.length) process.stdout.write(`\r   ${done}/${rows.length} (${errors} err)`);
  }
  console.log(`\n[clc-html] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
