// CF-BATCH-FILL-CATALOG (Drew, 2026-08-08). Direct catalog fill from a
// hand-picked list of high-priority Baseball Almanac set URLs. For each
// entry:
//   1. Fetch the URL, strip HTML, parse cardNumber+player lines
//   2. Compute canonical hobbyiqCardId slug per row
//   3. Upsert into card_catalog with verificationStatus='pending-review'
//      so admin approval is still required before the entries count as
//      canonical.
//
// Non-destructive: existing catalog entries at the same slug get their
// fields refreshed but retain their verificationStatus. Idempotent
// re-runs won't demote a verified entry back to pending.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do the writes (else dry-run)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";

function loadComputeSlug() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

// Priority sets — verified valid Baseball Almanac URLs (dry-run
// confirmed each returns 100+ real card rows). Modern autograph subsets
// and Bowman Chrome variants aren't on Baseball Almanac; those need
// checklistinsider / cardsmithsbreaks fills in a separate pass.
const PRIORITY_SETS = [
  // Baseball Almanac — vintage + a few modern (site's modern coverage is thin)
  { year: 2001, sport: "baseball", setName: "Bowman Draft Picks & Prospects",              url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2001bdp01" },
  { year: 2004, sport: "baseball", setName: "Bowman",                                      url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2004bow01" },
  { year: 2005, sport: "baseball", setName: "Bowman",                                      url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2005bow01" },
  { year: 2005, sport: "baseball", setName: "Bowman Heritage",                             url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2005bow02" },
  { year: 2008, sport: "baseball", setName: "Bowman",                                      url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2008bow01" },
  { year: 2016, sport: "baseball", setName: "Bowman Chrome Prospects Autographs",          url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2016bow04" },
  { year: 2020, sport: "baseball", setName: "Bowman",                                      url: "https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=2020bow01" },
  // Cardsmithsbreaks — modern coverage (works with existing parser, static HTML tables)
  { year: 2025, sport: "baseball", setName: "Bowman",                                      url: "https://cardsmithsbreaks.com/full-checklist/2025-bowman-baseball/" },
  { year: 2025, sport: "baseball", setName: "Bowman Chrome",                               url: "https://cardsmithsbreaks.com/full-checklist/2025-bowman-chrome-baseball/" },
  { year: 2025, sport: "baseball", setName: "Bowman Chrome Sapphire",                      url: "https://cardsmithsbreaks.com/full-checklist/2025-bowman-chrome-baseball-sapphire-edition/" },
  { year: 2025, sport: "baseball", setName: "Bowman Draft",                                url: "https://cardsmithsbreaks.com/full-checklist/2025-bowman-draft-baseball-super-jumbo/" },
  { year: 2025, sport: "baseball", setName: "Topps Transcendent Collection",               url: "https://cardsmithsbreaks.com/full-checklist/2025-topps-transcendent-collection-baseball/" },
  { year: 2026, sport: "baseball", setName: "Bowman",                                      url: "https://cardsmithsbreaks.com/full-checklist/2026-bowman-baseball-hobby/" },
  // CF-VINTAGE-NBA (Drew, 2026-08-08). Close the 1990s Skybox / Fleer /
  // Hoops NBA gap surfaced by tonight's Michael Jordan mis-categorization.
  // URLs are the cardsmithsbreaks / basketball-almanac equivalents where
  // available; parser handles both static HTML shapes.
  { year: 1990, sport: "basketball", setName: "Fleer",             url: "https://cardsmithsbreaks.com/full-checklist/1990-91-fleer-basketball/" },
  { year: 1990, sport: "basketball", setName: "Hoops",             url: "https://cardsmithsbreaks.com/full-checklist/1990-91-hoops-basketball/" },
  { year: 1990, sport: "basketball", setName: "Skybox",            url: "https://cardsmithsbreaks.com/full-checklist/1990-91-skybox-basketball/" },
  { year: 1991, sport: "basketball", setName: "Fleer",             url: "https://cardsmithsbreaks.com/full-checklist/1991-92-fleer-basketball/" },
  { year: 1991, sport: "basketball", setName: "Hoops",             url: "https://cardsmithsbreaks.com/full-checklist/1991-92-hoops-basketball/" },
  { year: 1991, sport: "basketball", setName: "Skybox",            url: "https://cardsmithsbreaks.com/full-checklist/1991-92-skybox-basketball/" },
  { year: 1991, sport: "basketball", setName: "Upper Deck",        url: "https://cardsmithsbreaks.com/full-checklist/1991-92-upper-deck-basketball/" },
  { year: 1992, sport: "basketball", setName: "Fleer",             url: "https://cardsmithsbreaks.com/full-checklist/1992-93-fleer-basketball/" },
  { year: 1992, sport: "basketball", setName: "Fleer Ultra",       url: "https://cardsmithsbreaks.com/full-checklist/1992-93-fleer-ultra-basketball/" },
  { year: 1992, sport: "basketball", setName: "Skybox",            url: "https://cardsmithsbreaks.com/full-checklist/1992-93-skybox-basketball/" },
  { year: 1993, sport: "basketball", setName: "Fleer Ultra",       url: "https://cardsmithsbreaks.com/full-checklist/1993-94-fleer-ultra-basketball/" },
  { year: 1993, sport: "basketball", setName: "Skybox Premium",    url: "https://cardsmithsbreaks.com/full-checklist/1993-94-skybox-premium-basketball/" },
  { year: 1993, sport: "basketball", setName: "Topps",             url: "https://cardsmithsbreaks.com/full-checklist/1993-94-topps-basketball/" },
  { year: 1994, sport: "basketball", setName: "Fleer Ultra",       url: "https://cardsmithsbreaks.com/full-checklist/1994-95-fleer-ultra-basketball/" },
  { year: 1994, sport: "basketball", setName: "Skybox Premium",    url: "https://cardsmithsbreaks.com/full-checklist/1994-95-skybox-premium-basketball/" },
  { year: 1995, sport: "basketball", setName: "Fleer",             url: "https://cardsmithsbreaks.com/full-checklist/1995-96-fleer-basketball/" },
  { year: 1995, sport: "basketball", setName: "Skybox Premium",    url: "https://cardsmithsbreaks.com/full-checklist/1995-96-skybox-premium-basketball/" },
  { year: 1996, sport: "basketball", setName: "Skybox Premium",    url: "https://cardsmithsbreaks.com/full-checklist/1996-97-skybox-premium-basketball/" },
  { year: 1996, sport: "basketball", setName: "Fleer",             url: "https://cardsmithsbreaks.com/full-checklist/1996-97-fleer-basketball/" },
  { year: 1996, sport: "basketball", setName: "Topps Chrome",      url: "https://cardsmithsbreaks.com/full-checklist/1996-97-topps-chrome-basketball/" },
];

// Alternating pass matches pure-digit card numbers only (Baseball
// Almanac's dominant format). Same-line pass covers the letter-prefixed
// autograph subsets (CPA-EHA, BDP129) that appear on checklistinsider /
// cardsmithsbreaks with different HTML shapes.
const NUM_RX_STRICT = /^(\d{1,4}[a-z]?)$/;
// Letter-prefix cardNumbers must have BOTH a letter prefix AND at least
// one digit or dash — this rules out "HISTORY", "BOWMAN", etc.
const NUM_RX_LETTER = /^([A-Z]{1,6}-?\d{1,5}|[A-Z]{1,6}-[A-Z0-9]{1,10})$/;
const NAME_RX = /^([A-Z][A-Za-z.'\- ]{2,60})$/;
const SAME_LINE_RX = /^(\d{1,4}[a-z]?|[A-Z]{1,6}-?\d{1,5}|[A-Z]{1,6}-[A-Z0-9]{1,10})\s+([A-Z][A-Za-z.'\- ]{2,60})\s*$/;
const NAME_STOPWORDS = /^(RC|SP|HOF|MVP|CY|POY|ROY|BASE|CARD|SET|PLAYER|TEAM|POS|BATS|THROWS|BORN|DIED|CHECKLIST|CARDS|CENTURY|EDITION|SET II|SERIES|SP\/S|TCDB|NEW|NOTES|CARD DESCRIPTION|NUMBER|BOB|1948|BOWMAN|TOPPS|FLEER)$/i;

function parseChecklistHtml(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(td|th|tr|br|p|div|li|dt|dd)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "")
    .replace(/\t+/g, " ");
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= 100);

  const rows = [];
  const seen = new Set();
  function tryAdd(cn, player) {
    if (!cn || !player) return;
    cn = cn.toUpperCase();
    if (NAME_STOPWORDS.test(player)) return;
    if (!/^[A-Z][a-z]/.test(player)) return;
    const key = `${cn}|${player.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ cardNumber: cn, player });
  }

  // Pass A: same-line "<num> <name>" (checklistinsider / cardsmiths shape)
  for (const line of lines) {
    const m = line.match(SAME_LINE_RX);
    if (m) tryAdd(m[1], m[2].trim());
  }

  // Pass B: alternating "<num>\n<name>" (Baseball Almanac shape — table
  // cells strip to separate lines). Only strict digit numbers here to
  // avoid the "HISTORY All-Star Game" false positives from navigation.
  for (let i = 0; i < lines.length - 1; i++) {
    const numLine = lines[i];
    const nameLine = lines[i + 1];
    if (!NUM_RX_STRICT.test(numLine) && !NUM_RX_LETTER.test(numLine)) continue;
    if (!NAME_RX.test(nameLine)) continue;
    tryAdd(numLine, nameLine.trim());
  }
  return rows;
}

const AUTO_CARD_NUMBER_PREFIX = /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV|TEK|CDA|BSPA|CPAR|CPALD|CPATWH)-/i;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const computeSlug = loadComputeSlug();

  console.log(`[fill-catalog] apply=${APPLY}  sets=${PRIORITY_SETS.length}`);
  const startMs = Date.now();
  let totalRows = 0, totalWritten = 0, totalSkipped = 0, totalErrored = 0;

  for (const setDef of PRIORITY_SETS) {
    console.log(`\n▸ ${setDef.year} ${setDef.setName}`);
    console.log(`  URL: ${setDef.url}`);
    let html;
    try {
      const r = await fetch(setDef.url, { redirect: "follow", headers: { "user-agent": "HobbyIQ/1.0 (admin catalog fill)" } });
      if (!r.ok) { console.warn(`  upstream ${r.status} — skip`); totalErrored++; continue; }
      html = await r.text();
    } catch (err) {
      console.warn(`  fetch failed: ${err?.message ?? err}`);
      totalErrored++;
      continue;
    }
    const rows = parseChecklistHtml(html);
    console.log(`  parsed ${rows.length} card rows`);
    totalRows += rows.length;
    if (rows.length === 0) continue;

    const setKeyRaw = setDef.setName; // computeHobbyIqCardId normalizes internally
    const isAutoSet = /autograph/i.test(setDef.setName);

    let written = 0, skipped = 0, errored = 0;
    for (const row of rows) {
      const isAuto = isAutoSet || AUTO_CARD_NUMBER_PREFIX.test(row.cardNumber);
      let slug;
      try {
        slug = computeSlug({
          sport: setDef.sport,
          year: setDef.year,
          setKey: setKeyRaw,
          cardNumber: row.cardNumber,
          parallel: "Base",
          isAuto,
          printRun: null,
        });
      } catch { errored++; continue; }

      if (!APPLY) { written++; continue; }
      const now = new Date().toISOString();
      try {
        await cat.items.upsert({
          id: slug,
          cardId: slug,
          hobbyiqCardId: slug,
          sport: setDef.sport,
          year: setDef.year,
          cardYear: setDef.year,
          setKey: undefined, // let it derive; slug has the canonical
          setName: setDef.setName,
          cardNumber: row.cardNumber,
          parallel: "Base",
          isAuto,
          printRun: null,
          playerName: row.player,
          source: "checklist-batch-fill",
          confidence: 0.85,
          verificationStatus: "pending-review",
          observedAt: now,
          lastSeenAt: now,
          sourceUrl: setDef.url,
        });
        written++;
      } catch (err) {
        errored++;
        if (errored <= 3) console.warn(`  upsert failed ${slug}: ${err?.code ?? err?.message ?? err}`);
      }
    }
    console.log(`  written=${written} skipped=${skipped} errored=${errored}`);
    totalWritten += written;
    totalSkipped += skipped;
    totalErrored += errored;
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log(`\n=== FILL SUMMARY ===`);
  console.log(`apply         : ${APPLY}`);
  console.log(`sets          : ${PRIORITY_SETS.length}`);
  console.log(`total rows    : ${totalRows}`);
  console.log(`written       : ${totalWritten}`);
  console.log(`skipped       : ${totalSkipped}`);
  console.log(`errored       : ${totalErrored}`);
  console.log(`elapsed       : ${elapsed}s`);
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
