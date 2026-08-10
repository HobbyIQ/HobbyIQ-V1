#!/usr/bin/env node
/**
 * CF-BCP-INGESTER (Drew, 2026-08-10). Baseballcardpedia.com ingester.
 * Wiki-style pages with sectioned checklists: H2 "Base Set" → <li>N
 * Player Name</li>, H2 "Parallels" → parallel manifest text, H2
 * "Autographs" → autograph subset, etc.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestBaseballCardPedia.cjs \
 *     --url=https://baseballcardpedia.com/index.php/2023-24_Topps_Chrome_Platinum_Anniversary \
 *     --year=2024 --setKey=topps-chrome-platinum-anniversary [--apply]
 */

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const URL = argOf("url");
const YEAR = Number(argOf("year"));
const SET_KEY = argOf("setKey");
if (!URL || !YEAR || !SET_KEY) {
  console.error("Missing --url --year --setKey");
  process.exit(1);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

function sanitizeSlug(s) {
  return String(s || "").toLowerCase().replace(/[\/\\#?]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function decodeHtml(s) {
  return String(s).replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Parse parallel manifest text: "Refractor #/499; Blue #/150; ..." (fallback)
function parseParallelsText(text) {
  if (!text) return [];
  const parts = text.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = /^(.+?)\s*(?:#?\/|(?=\d+\/\d+))(\d+)(?:\/\d+)?/.exec(part);
    if (!m) continue;
    const name = m[1].replace(/\s+\([^)]*\)$/, "").trim();
    const printRun = Number(m[2]);
    if (name && printRun > 0) out.push({ name, printRun });
  }
  return out;
}

// Extract parallels from BCP <ul> list inside Parallels section:
//   <li>Refractors</li>
//   <li>Blue Refractors (serial-numbered to 150 copies)</li>
//   <li>Green Refractors (serial-numbered to 99 copies; Hobby only)</li>
function parseParallelsFromList(body) {
  const parallels = [];
  const rx = /<li[^>]*>([^<]{2,120})<\/li>/gi;
  let m;
  while ((m = rx.exec(body))) {
    const raw = decodeHtml(m[1]).trim();
    // Extract print run from "(serial-numbered to N copies)" or "/N"
    const runMatch = /(?:serial-numbered\s+to\s+(\d+)\s+cop|1\/1|#\/(\d+)|\/(\d+))/i.exec(raw);
    let printRun = null;
    if (runMatch) {
      printRun = Number(runMatch[1] ?? runMatch[2] ?? runMatch[3] ?? 1);
      if (/1\/1/.test(raw)) printRun = 1;
    }
    // Strip trailing "(...)" annotations to get clean parallel name
    let name = raw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    // Also strip trailing "Refractors" plural → singular
    name = name.replace(/s$/, "").trim();
    if (!name || name.length < 2) continue;
    // Skip non-parallel bullets (long descriptive text)
    if (name.length > 60) continue;
    if (/^(hobby|retail|jumbo|fanatics)\s/i.test(name)) continue;
    parallels.push({ name, printRun });
  }
  return parallels;
}

// Extract sections between h2 headers. BCP markup: <h2 id="X">Title</h2>
// wrapped in <div class="mw-heading mw-heading2">...</div>.
function extractSections(html) {
  const sections = [];
  const rx = /<h2[^>]*id="([^"]+)"[^>]*>([^<]+)<\/h2>([\s\S]*?)(?=<h2[^>]*id=|$)/gi;
  let m;
  while ((m = rx.exec(html))) {
    const id = m[1] ?? "";
    const title = decodeHtml((m[2] ?? "").trim());
    const body = m[3];
    sections.push({ id, title, body });
  }
  return sections;
}

// Parse cards from a section body: <li>N Player Name</li>
function parseCards(body) {
  const rx = /<li[^>]*>\s*([A-Z0-9]{1,6}-?[A-Z0-9]{0,10}|\d{1,4}[a-z]?)\s+([^<]{2,80}?)\s*<\/li>/gi;
  const cards = [];
  let m;
  while ((m = rx.exec(body))) {
    const cardNumber = m[1].trim();
    let playerName = decodeHtml(m[2].replace(/\s+RC\s*$/i, "").trim());
    // Strip trailing " *" or " (SP)" etc.
    playerName = playerName.replace(/\s+\*+\s*$/, "").replace(/\s+\([^)]*\)\s*$/, "").trim();
    if (!playerName || playerName.length < 2) continue;
    cards.push({ cardNumber, playerName });
  }
  return cards;
}

// Detect isAuto from section title
function isAutoSection(title) {
  return /\b(autograph|signature|sig)/i.test(String(title || ""));
}

function buildCatalogRow({ year, setKey, cardNumber, playerName, parallel, printRun, isAuto, subsetName }) {
  const cardNumSlug = sanitizeSlug(cardNumber);
  const parallelSlug = sanitizeSlug(parallel.name);
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = printRun ? `:num-${printRun}` : "";
  const slug = `hiq:baseball:${year}:${setKey}:${cardNumSlug}:${parallelSlug || "base"}${autoSuffix}${printRunSuffix}`;
  const searchTokens = new Set([
    ...String(playerName).toLowerCase().split(/\s+/).filter(Boolean),
    ...setKey.split("-").filter(Boolean),
    cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallelSlug, ...(parallelSlug || "").split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));
  return {
    id: slug, cardId: slug, hobbyiqCardId: slug,
    sport: "baseball", year, setKey,
    setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    cardNumber, playerName, team: null,
    parallel: parallel.name, parallelSlug: parallelSlug || "base",
    isAuto, printRun,
    source: "baseballcardpedia",
    catalogVersion: 2,
    catalogBatch: "bcp-2026-08-10",
    verificationStatus: "verified",
    builtAt: "2026-08-10T00:00:00.000Z",
    subsetName,
    searchTokens: [...searchTokens],
  };
}

(async () => {
  console.log(`[bcp-ingest] MODE=${APPLY ? "APPLY" : "DRY-RUN"} year=${YEAR} setKey=${SET_KEY}`);
  console.log(`[bcp-ingest] fetching ${URL}`);
  const html = (await httpsGet(URL)).toString("utf8");

  // Extract parallel manifest from Parallels section — parse <li> items
  // for the actual parallel names + serial-numbered runs.
  const parMatch = /<h2[^>]*id="Parallels"[\s\S]*?<\/h2>([\s\S]*?)(?=<h2|<h1)/i.exec(html);
  const parallels = parMatch ? parseParallelsFromList(parMatch[1]) : [];
  console.log(`[bcp-ingest] Parallels detected (${parallels.length}):`, parallels.map((p) => `${p.name}${p.printRun ? "/"+p.printRun : ""}`).join(", "));

  const sections = extractSections(html);
  console.log(`[bcp-ingest] Found ${sections.length} h2 sections`);

  const allRows = [];
  const alwaysBase = [{ name: "Base", printRun: null }, ...parallels];
  for (const sec of sections) {
    const cards = parseCards(sec.body);
    if (cards.length === 0) continue;
    const isAuto = isAutoSection(sec.title);
    console.log(`  [${sec.title}] ${cards.length} cards · ${alwaysBase.length} parallels · auto=${isAuto}`);
    for (const c of cards) {
      for (const par of alwaysBase) {
        allRows.push(buildCatalogRow({
          year: YEAR, setKey: SET_KEY,
          cardNumber: c.cardNumber, playerName: c.playerName,
          parallel: par, printRun: par.printRun, isAuto,
          subsetName: sec.title,
        }));
      }
    }
  }

  console.log(`\n[bcp-ingest] Total rows: ${allRows.length}`);
  console.log(`Sample (first 5):`);
  for (const r of allRows.slice(0, 5)) {
    console.log(`  ${r.hobbyiqCardId}  ← ${r.playerName} · ${r.parallel} · /${r.printRun ?? "-"}`);
  }

  if (!APPLY) { console.log(`\n[bcp-ingest] DRY-RUN. --apply to write.`); return; }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[bcp-ingest] APPLY — upserting ${allRows.length} rows`);
  let done = 0, errors = 0;
  const CH = 24;
  for (let i = 0; i < allRows.length; i += CH) {
    const batch = allRows.slice(i, i + CH);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
  }
  console.log(`[bcp-ingest] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
