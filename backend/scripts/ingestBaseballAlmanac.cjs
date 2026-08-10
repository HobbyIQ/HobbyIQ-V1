#!/usr/bin/env node
/**
 * CF-BA-INGESTER (Drew, 2026-08-10). Baseball-Almanac vintage checklist
 * ingester. Writes v2-canonical rows so BA-sourced sets match the
 * checklistcenter shape exactly.
 *
 * BA URL pattern: baseball_cards_oneset.php?s={YEAR}{code}{seq}
 *   where code is a 3-letter set abbrev (bow=Bowman, top=Topps,
 *   don=Donruss, fle=Fleer, upd=Upper Deck, etc.)
 *
 * Table structure per set:
 *   <tr><td>N</td><td>Player Name</td>...</tr>
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestBaseballAlmanac.cjs \
 *     --year=1950 --setKey=bowman --code=bow01 [--apply]
 */

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const YEAR = Number(argOf("year"));
const SET_KEY = argOf("setKey");
const CODE = argOf("code");   // e.g. "bow01"
if (!YEAR || !SET_KEY || !CODE) {
  console.error("Missing --year --setKey --code (e.g. --year=1950 --setKey=bowman --code=bow01)");
  process.exit(1);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, "Referer": "https://www.baseball-almanac.com/baseball_cards/" } }, (res) => {
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
  return String(s)
    .replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Parse BA table rows. Each set page has a table with rows like:
//   <tr>...<td>N</td>...<td>Player Name</td>...</tr>
// Or single-column: <td>N Player Name</td>
function parseCards(html) {
  const cards = [];
  const rows = html.split(/<\/tr>/i);
  for (const row of rows) {
    // Extract all <td> cells from this row
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)(?=<td[^>]*>|<\/tr>|$)/gi)]
      .map((m) => decodeHtml(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
      .filter(Boolean);
    if (cells.length < 2) continue;
    // Pattern 1: first cell is number, second is player
    const cn0 = cells[0].trim();
    const pl0 = cells[1].trim();
    if (/^([0-9]{1,4}[a-z]?|[A-Z]{1,6}-?[0-9A-Z]{1,10})$/.test(cn0) && /^[A-Z][A-Za-z.'\-\s]{2,60}$/.test(pl0)) {
      cards.push({ cardNumber: cn0, playerName: pl0 });
      continue;
    }
    // Pattern 2: single cell like "N Player" or "TWL-1 Player"
    for (const cell of cells) {
      const m = /^([0-9]{1,4}[a-z]?|[A-Z]{1,6}-?[0-9A-Z]{1,10})\s+([A-Z][A-Za-z.'\-\s]{2,60})$/.exec(cell);
      if (m) cards.push({ cardNumber: m[1], playerName: m[2].trim() });
    }
  }
  return cards;
}

function buildCatalogRow({ year, setKey, cardNumber, playerName }) {
  const cardNumSlug = sanitizeSlug(cardNumber);
  const parallelSlug = "base";
  const isAuto = false;
  const slug = `hiq:baseball:${year}:${setKey}:${cardNumSlug}:${parallelSlug}:no-auto`;
  const searchTokens = new Set([
    ...playerName.toLowerCase().split(/\s+/).filter(Boolean),
    ...setKey.split("-").filter(Boolean),
    cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    "base",
  ]);
  return {
    id: slug, cardId: slug, hobbyiqCardId: slug,
    sport: "baseball", year, setKey,
    setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    cardNumber, playerName, team: null,
    parallel: "Base", parallelSlug, isAuto, printRun: null,
    source: "baseball-almanac",
    catalogVersion: 2,
    catalogBatch: "ba-2026-08-10",
    verificationStatus: "verified",
    builtAt: "2026-08-10T00:00:00.000Z",
    searchTokens: [...searchTokens],
  };
}

(async () => {
  const url = `https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=${YEAR}${CODE}`;
  console.log(`[ba-ingest] MODE=${APPLY ? "APPLY" : "DRY-RUN"} year=${YEAR} setKey=${SET_KEY}`);
  console.log(`[ba-ingest] fetching ${url}`);
  const html = (await httpsGet(url)).toString("utf8");
  const cards = parseCards(html);
  console.log(`[ba-ingest] parsed ${cards.length} cards`);

  const rows = cards.map((c) => buildCatalogRow({ year: YEAR, setKey: SET_KEY, cardNumber: c.cardNumber, playerName: c.playerName }));
  console.log(`[ba-ingest] first 5 rows:`);
  for (const r of rows.slice(0, 5)) console.log(`   ${r.hobbyiqCardId}  ← ${r.playerName}`);

  if (!APPLY) { console.log(`\n[ba-ingest] DRY-RUN. --apply to write.`); return; }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[ba-ingest] APPLY — upserting ${rows.length} rows`);
  let done = 0, errors = 0;
  const CH = 16;
  for (let i = 0; i < rows.length; i += CH) {
    const batch = rows.slice(i, i + CH);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
  }
  console.log(`[ba-ingest] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
