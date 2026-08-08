// CF-TCDB-BATCH-FILL (Drew, 2026-08-08). Scrape TCDB checklists for the
// top-N unmatched-pool gap sets and seed card_catalog entries. TCDB's
// URL pattern is:
//   https://www.tcdb.com/Checklist.cfm/sid/{sid}/{set-slug}?PageIndex={N}
// Server-rendered HTML with a stable <tr> table shape, 100 cards/page,
// includes RC/RD/AS/SP/VAR flags and card image thumbnails.
//
// Image URLs are captured into imageUrl for downstream photo attach.
//
// Cloudflare gate: Node fetch is 403 on TLS/JA3 fingerprint; Playwright
// Chromium gets 403 after ~1-2 pages (headless browser fingerprint is
// also detected + escalates); curl passes cleanly and reliably. So
// we shell out to curl. Every entry lands verificationStatus='pending-
// review', source='tcdb-scrape', confidence=0.85.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write to card_catalog (else dry-run)
//   TCDB_MAX_PAGES             per-set pagination cap (default 10 = 1000 cards)

const { CosmosClient } = require("@azure/cosmos");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const MAX_PAGES = Number(process.env.TCDB_MAX_PAGES || 10);

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

// Top-5 flagship sets identified from the current unmatched pool
// (analyzeCatalogGaps.cjs, 2026-08-08). Each entry drives one TCDB
// scrape → one set of card_catalog upserts.
const TCDB_SETS = [
  { sid: 243938, slug: "2020-Panini-Prizm",     year: 2020, sport: "football",   setName: "Panini Prizm" },       // Herbert RC
  { sid: 58238,  slug: "2011-Topps-Update",     year: 2011, sport: "baseball",   setName: "Topps Update" },       // Trout US175
  { sid: 188541, slug: "2018-19-Panini-Prizm",  year: 2018, sport: "basketball", setName: "Panini Prizm" },       // Luka RC
  { sid: 2067,   slug: "1986-87-Fleer",         year: 1986, sport: "basketball", setName: "Fleer" },              // Jordan #57
  { sid: 2031,   slug: "1980-81-Topps",         year: 1980, sport: "basketball", setName: "Topps" },              // vintage
  { sid: 2701,   slug: "1997-98-Topps",         year: 1997, sport: "basketball", setName: "Topps" },
  // CF-BATCH-2 (Drew, 2026-08-08). Second wave of sids covering the
  // remaining top-buckets from analyzeCatalogGaps — vintage baseball
  // (Topps 1965/1971, 1933 Goudey), 90s multi-sport (1991 Score BB/FB,
  // 1992 Studio), 90s NBA (Metal Universe, Skybox Premium, Fleer),
  // 2005 Bowman.
  { sid: 2654,   slug: "1997-98-Metal-Universe",           year: 1997, sport: "basketball", setName: "Metal Universe" },
  { sid: 2664,   slug: "1997-98-SkyBox-Premium",           year: 1997, sport: "basketball", setName: "SkyBox Premium" },
  { sid: 2627,   slug: "1997-98-Fleer",                    year: 1997, sport: "basketball", setName: "Fleer" },
  { sid: 210,    slug: "1992-Studio",                      year: 1992, sport: "baseball",   setName: "Studio" },
  { sid: 160,    slug: "1991-Score",                       year: 1991, sport: "baseball",   setName: "Score" },
  { sid: 3270,   slug: "1991-Score",                       year: 1991, sport: "football",   setName: "Score" },
  { sid: 71,     slug: "1971-Topps",                       year: 1971, sport: "baseball",   setName: "Topps" },
  { sid: 64,     slug: "1965-Topps",                       year: 1965, sport: "baseball",   setName: "Topps" },
  { sid: 7,      slug: "1933-Goudey-(R319)",               year: 1933, sport: "baseball",   setName: "Goudey" },
  { sid: 1789,   slug: "2005-Bowman",                      year: 2005, sport: "baseball",   setName: "Bowman" },
];

// TCDB card row structure — each <tr> has several <td> cells:
//   td[0-1]: image thumbnails (may be empty)
//   td[N]:   cardNumber (e.g. "57", "US175", "US4b")
//   td[N+1]: playerName + optional flags (e.g. "Michael Jordan RC", "Carlton Fisk SP, VAR")
//   td[N+2]: teamName (e.g. "Chicago Bulls", "Boston Red Sox")
// Metadata rows ("Checklist:", "Team Set Break", section headers) get
// filtered by the cardNumber regex + name-shape check.
const CARD_NUM_RX = /^([A-Z]{0,4}\d{1,4}[a-z]?)$/;
const FLAG_TOKENS_RX = /\s+(RC|RD|AS|SP|VAR|HOF|MVP|CY|POY|ROY|SS|TB|LDR|LEG|CL|IA|UER|COR|ERR)(?:,\s*(?:RC|RD|AS|SP|VAR|HOF|MVP|CY|POY|ROY|SS|TB|LDR|LEG|CL|IA|UER|COR|ERR))*\s*$/;
const METADATA_NAME_RX = /^(Checklist|Section|Team Set|Header|Trivia|Rookie Prospects|Pack Insert|Puzzle|Wrapper|Poll|Comment|Add Card)/i;

function stripCell(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTcdbRowFromCells(cells) {
  // Find the cardNumber cell — first cell whose stripped text matches CARD_NUM_RX
  let cnIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    if (CARD_NUM_RX.test(cells[i])) { cnIdx = i; break; }
  }
  if (cnIdx < 0) return null;
  const cardNumber = cells[cnIdx].toUpperCase();
  // Player name is the next non-empty cell after cardNumber
  let nameCell = null;
  for (let i = cnIdx + 1; i < cells.length; i++) {
    if (cells[i] && cells[i].length > 0) { nameCell = cells[i]; break; }
  }
  if (!nameCell) return null;
  // Strip trailing flags from the name cell
  const nameStripped = nameCell.replace(FLAG_TOKENS_RX, "").trim();
  // Reject metadata rows (Checklist:, Section:, etc.)
  if (METADATA_NAME_RX.test(nameStripped)) return null;
  // Reject if the name doesn't start with an uppercase letter followed by a lowercase (real name shape)
  if (!/^[A-Z][a-z]/.test(nameStripped)) return null;
  // Reject if the "name" is a single word longer than 25 chars (probably a section title)
  if (nameStripped.split(/\s+/).length === 1 && nameStripped.length > 25) return null;
  return { cardNumber, playerName: nameStripped };
}

function parseTcdbPage(html) {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const trMatches = [...clean.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const rows = [];
  for (const trHtml of trMatches) {
    // Image thumbnail
    const imgMatch = trHtml.match(/src="(\/Images\/[^"]+Thumb\.(?:jpg|png|jpeg|webp))"/i);
    const imageUrl = imgMatch ? `https://www.tcdb.com${imgMatch[1]}` : null;
    // Extract <td> cells, stripped
    const cellHtmls = [...trHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripCell(m[1]));
    const parsed = parseTcdbRowFromCells(cellHtmls);
    if (!parsed) continue;
    rows.push({ ...parsed, imageUrl });
  }
  return rows;
}

async function fetchPageWithCurl(sid, slug, pageIdx, { retryOn403 = true } = {}) {
  const url = `https://www.tcdb.com/Checklist.cfm/sid/${sid}/${slug}?PageIndex=${pageIdx}`;
  try {
    const { stdout } = await execFileP("curl", [
      "-sL",
      "--max-time", "20",
      "-w", "\n__HTTP_STATUS__:%{http_code}",
      "-H", `User-Agent: ${UA}`,
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H", "Accept-Language: en-US,en;q=0.5",
      url,
    ], { maxBuffer: 5 * 1024 * 1024 });
    const statusMatch = stdout.match(/\n__HTTP_STATUS__:(\d{3})$/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const html = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
    if (status === 403 && retryOn403) {
      console.log(`    (403 — backing off 15s and retrying)`);
      await new Promise(r => setTimeout(r, 15000));
      return fetchPageWithCurl(sid, slug, pageIdx, { retryOn403: false });
    }
    if (status < 200 || status >= 300) return { rows: [], upstreamStatus: status };
    return { rows: parseTcdbPage(html), upstreamStatus: 200 };
  } catch (err) {
    return { rows: [], upstreamStatus: -1, error: err?.message ?? String(err) };
  }
}

function loadComputeSlug() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");
  const computeSlug = loadComputeSlug();

  console.log(`[tcdb-batch] apply=${APPLY}  sets=${TCDB_SETS.length}  max_pages=${MAX_PAGES}`);
  let totalCards = 0, totalWritten = 0, totalSkipped = 0, totalErrored = 0;

  for (let sIdx = 0; sIdx < TCDB_SETS.length; sIdx++) {
    const set = TCDB_SETS[sIdx];
    if (sIdx > 0) await new Promise(r => setTimeout(r, 6000)); // polite between-set delay
    console.log(`\n▸ ${set.year} ${set.setName} (${set.sport}) — sid=${set.sid}`);
    const allRows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await new Promise(r => setTimeout(r, 2500)); // polite per-page delay
      const { rows, upstreamStatus } = await fetchPageWithCurl(set.sid, set.slug, page);
      if (upstreamStatus !== 200) { console.log(`  page ${page}: HTTP ${upstreamStatus} — stop`); break; }
      if (rows.length === 0) { console.log(`  page ${page}: 0 rows — stop`); break; }
      // Dedup by cardNumber — TCDB paginates by 100 but the last page
      // sometimes re-shows earlier cards.
      let fresh = 0;
      const seen = new Set(allRows.map(r => r.cardNumber));
      for (const r of rows) if (!seen.has(r.cardNumber)) { allRows.push(r); fresh++; }
      console.log(`  page ${page}: ${rows.length} rows (${fresh} new)`);
      if (fresh === 0) break;
    }
    console.log(`  → total unique cards: ${allRows.length}`);
    // Sample-print 3 rows for eyeball verification
    for (let i = 0; i < Math.min(3, allRows.length); i++) {
      const r = allRows[i];
      const cardIdx = i === 0 ? 0 : (i === 1 ? Math.floor(allRows.length / 2) : allRows.length - 1);
      const s = allRows[cardIdx];
      console.log(`      · #${s.cardNumber}  ${s.playerName}  ${s.imageUrl ? "[img]" : "[no-img]"}`);
    }
    totalCards += allRows.length;

    // Compute slugs + write
    let written = 0, skipped = 0, errored = 0;
    for (const r of allRows) {
      let slug;
      try {
        slug = computeSlug({
          sport: set.sport,
          year: set.year,
          setKey: set.setName,
          cardNumber: r.cardNumber,
          parallel: "Base",
          isAuto: false,
          printRun: null,
        });
      } catch (e) { errored++; continue; }

      if (!APPLY) { written++; continue; }
      const now = new Date().toISOString();
      try {
        await cat.items.upsert({
          id: slug,
          cardId: slug,
          hobbyiqCardId: slug,
          sport: set.sport,
          year: set.year,
          cardYear: set.year,
          setName: set.setName,
          cardNumber: r.cardNumber,
          parallel: "Base",
          isAuto: false,
          printRun: null,
          playerName: r.playerName,
          imageUrl: r.imageUrl,
          source: "tcdb-scrape",
          confidence: 0.85,
          verificationStatus: "pending-review",
          observedAt: now,
          lastSeenAt: now,
          sourceUrl: `https://www.tcdb.com/Checklist.cfm/sid/${set.sid}/${set.slug}`,
        });
        written++;
      } catch (err) {
        errored++;
        if (errored <= 3) console.warn(`  upsert failed ${slug}: ${err?.code ?? err?.message ?? err}`);
      }
    }
    console.log(`  written=${written}  skipped=${skipped}  errored=${errored}`);
    totalWritten += written; totalSkipped += skipped; totalErrored += errored;
  }

  console.log(`\n=== TCDB FILL SUMMARY ===`);
  console.log(`apply         : ${APPLY}`);
  console.log(`sets          : ${TCDB_SETS.length}`);
  console.log(`total cards   : ${totalCards.toLocaleString()}`);
  console.log(`written       : ${totalWritten.toLocaleString()}`);
  console.log(`skipped       : ${totalSkipped.toLocaleString()}`);
  console.log(`errored       : ${totalErrored.toLocaleString()}`);
}

main().catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
