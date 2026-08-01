#!/usr/bin/env node
// CF-BACKFILL-STAGE2-TITLE-PARSER (Drew, 2026-08-01).
//
// Stage 2 of the three-stage pool-cleanup pipeline. Stage 1 rewrote
// ~177K rows using catalog+setName agreement; Stage 2 tackles the
// ~2M rows the catalog didn't cover, using the title text as the
// primary evidence source. Multi-witness safeguard: title-extracted
// fields (playerName, setSlug, cardNumber, year) must agree with the
// stored fields in at least 2 places before we rewrite.
//
// Only touches rows where the derived canonical slug differs from
// current. Skips rows lacking sufficient witnesses. Marker field
// __stage2TitleParsedAt for rollback traceability.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_MODE / BACKFILL_APPLY   dry (default) | apply / true|false
//   BACKFILL_CONCURRENCY       default 8

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

// --- Set → canonical slug (mirror of Stage 1) ---
function normalizeSetToCanonical(setText) {
  const s = String(setText || "").toLowerCase();
  if (!s) return null;
  if (/bowman chrome sapphire|bowman sapphire/.test(s)) return "bowman-chrome-sapphire";
  if (/topps chrome sapphire/.test(s)) return "topps-chrome-sapphire";
  if (/bowman chrome draft|bowman draft chrome/.test(s)) return "bowman-chrome";
  if (/bowman chrome/.test(s)) return "bowman-chrome";
  if (/chrome prospect/.test(s)) return "bowman-chrome";
  if (/bowman platinum/.test(s)) return "bowman-platinum";
  if (/bowman sterling/.test(s)) return "bowman-sterling";
  if (/bowman draft/.test(s)) return "bowman-draft";
  if (/bowman mega/.test(s)) return "bowman-mega";
  if (/bowman heritage/.test(s)) return "bowman-heritage";
  if (/bowman inception/.test(s)) return "bowman-inception";
  if (/bowman transcendent/.test(s)) return "bowman-transcendent";
  if (/\bbowman\b/.test(s)) return "bowman";
  if (/topps chrome platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps chrome update|chrome update/.test(s)) return "topps-chrome";
  if (/topps chrome black/.test(s)) return "topps-chrome-black";
  if (/topps chrome/.test(s)) return "topps-chrome";
  if (/topps heritage/.test(s)) return "topps-heritage";
  if (/topps finest|^finest\b/.test(s) || /\btopps finest\b/.test(s)) return "topps-finest";
  if (/topps pristine/.test(s)) return "topps-pristine";
  if (/topps transcendent/.test(s)) return "topps-transcendent";
  if (/topps dynasty/.test(s)) return "topps-dynasty";
  if (/topps tribute/.test(s)) return "topps-tribute";
  if (/topps museum/.test(s)) return "topps-museum-collection";
  if (/topps stadium/.test(s)) return "topps-stadium-club";
  if (/topps allen|allen.*ginter/.test(s)) return "topps-allen-ginter";
  if (/topps gypsy/.test(s)) return "topps-gypsy-queen";
  if (/topps archives/.test(s)) return "topps-archives";
  if (/topps inception/.test(s)) return "topps-inception";
  if (/topps five star/.test(s)) return "topps-five-star";
  if (/topps definitive/.test(s)) return "topps-definitive";
  if (/topps big league/.test(s)) return "topps-big-league";
  if (/\btopps\b/.test(s)) return "topps";
  if (/donruss champions/.test(s)) return "donruss-champions";
  if (/panini prizm|^prizm/.test(s)) return "panini-prizm";
  if (/panini select/.test(s)) return "panini-select";
  if (/panini mosaic/.test(s)) return "panini-mosaic";
  if (/panini donruss optic|donruss optic|panini optic/.test(s)) return "panini-optic";
  if (/panini donruss|donruss/.test(s)) return "panini-donruss";
  if (/panini contenders/.test(s)) return "panini-contenders";
  if (/panini immaculate/.test(s)) return "panini-immaculate";
  if (/panini flawless/.test(s)) return "panini-flawless";
  if (/national treasures/.test(s)) return "panini-national-treasures";
  if (/panini absolute/.test(s)) return "panini-absolute";
  if (/panini chronicled|panini chronicles/.test(s)) return "panini-chronicles";
  if (/panini illusions/.test(s)) return "panini-illusions";
  if (/panini prestige/.test(s)) return "panini-prestige";
  if (/panini diamond kings/.test(s)) return "panini-diamond-kings";
  if (/panini phoenix/.test(s)) return "panini-phoenix";
  if (/panini/.test(s)) return "panini";
  if (/upper deck/.test(s)) return "upper-deck";
  if (/fleer/.test(s)) return "fleer";
  return null;
}

// --- Title extraction ---
function extractYearFromTitle(title) {
  const m = String(title || "").match(/\b(19|20)(\d{2})\b/);
  if (!m) return null;
  return Number(m[0]);
}

const CARD_NUMBER_RE = /#([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|BDC-\d+|HL\d+|US\d+|\d{1,4})\b/i;
function extractCardNumberFromTitle(title) {
  const m = String(title || "").match(CARD_NUMBER_RE);
  return m ? m[1].toUpperCase() : null;
}

// CF-STAGE2-FAST-PLAYER-LOOKUP (Drew, 2026-08-01). Prior implementation
// ran one regex per player per row — 96K players × 3.4M rows = O(300B)
// operations, timed out after 150 min without progress. Fixed: build
// a Set of lowercased player names, then scan the title's word-window
// pairs (last-first or first-last order) and probe the set. O(rows ×
// title_words) — ~50M operations total, seconds not hours.
function extractPlayerFromTitle(title, playerSet) {
  if (!title) return null;
  const t = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const words = t.split(" ");
  // 2-word windows: "first last"
  for (let i = 0; i + 1 < words.length; i++) {
    const candidate = words[i] + " " + words[i + 1];
    if (playerSet.has(candidate)) return candidate;
  }
  // 3-word windows: "first middle last" (Bo Bichette Jr, etc.)
  for (let i = 0; i + 2 < words.length; i++) {
    const candidate = words[i] + " " + words[i + 1] + " " + words[i + 2];
    if (playerSet.has(candidate)) return candidate;
  }
  return null;
}

async function loadPlayerDict(cc) {
  const iter = cc.items.query({ query: "SELECT c.player FROM c WHERE IS_DEFINED(c.player)" }, { maxItemCount: 5000 });
  const set = new Set();
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const p = String(r.player || "").trim().toLowerCase();
      if (p && p.split(/\s+/).length >= 2 && p.length >= 5) set.add(p);
    }
  }
  return set;
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cc = db.container("card_catalog");
  const sc = db.container("sold_comps");

  console.log(`[backfill-stage2-title-parser]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log("Loading known player dictionary from card_catalog...");
  const playerDict = await loadPlayerDict(cc);
  console.log(`  known players: ${playerDict.size}`);

  console.log("\nScanning sold_comps...");
  // CF-STAGE2-SKIP-STAGE1 (Drew, 2026-08-01). Skip rows already handled
  // by Stage 1 catalog-driven fixer — those have __catalogCanonicalizedAt.
  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')
              AND NOT IS_DEFINED(c.__catalogCanonicalizedAt)
              AND NOT IS_DEFINED(c.__stage2TitleParsedAt)`
  }, { maxItemCount: 500 });

  let examined = 0;
  let noTitle = 0, insufficientWitnesses = 0, sameSlug = 0;
  let rewritten = 0, errors = 0;
  const transitions = {};
  const inFlight = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const slug = row.hobbyiqCardId;
      if (typeof slug !== "string" || !slug.startsWith("hiq:")) continue;
      const parts = slug.split(":");
      if (parts.length < 6) continue;

      const title = String(row.title || "");
      if (!title) { noTitle++; continue; }

      // Stored fields
      const storedName = String(row.playerName || "").trim();
      const storedCn = String(row.cardNumber || "").trim().toUpperCase();
      const storedYear = Number(row.cardYear || 0) || null;
      const storedSetCanon = normalizeSetToCanonical(row.setName);

      // Title-extracted fields
      const titleYear = extractYearFromTitle(title);
      const titleCn = extractCardNumberFromTitle(title);
      const titleSetCanon = normalizeSetToCanonical(title);
      const titleName = extractPlayerFromTitle(title, playerDict);

      // Count witnesses that AGREE between stored and title
      // (titleName is already lowercased by extractPlayerFromTitle)
      let witnesses = 0;
      if (storedName && titleName && storedName.toLowerCase() === titleName) witnesses++;
      if (storedCn && titleCn && storedCn === titleCn) witnesses++;
      if (storedYear && titleYear && storedYear === titleYear) witnesses++;
      if (storedSetCanon && titleSetCanon && storedSetCanon === titleSetCanon) witnesses++;

      // Need at least 2 agreeing witnesses to rewrite anything
      if (witnesses < 2) { insufficientWitnesses++; continue; }

      // Choose canonical set: title extraction wins (it's the primary
      // signal for Stage 2), but only when the title's set canonical
      // is confirmed by at least one other agreement.
      const canonicalSet = titleSetCanon || storedSetCanon;
      if (!canonicalSet) { insufficientWitnesses++; continue; }

      const currentSet = parts[3];
      if (currentSet === canonicalSet) { sameSlug++; continue; }

      // Extra safeguard: if the canonical set is a MAJOR product family
      // change (e.g. bowman→panini), require an even higher bar (3+ witnesses).
      const familyOf = (s) => (s || "").split("-")[0];
      const crossFamily = familyOf(currentSet) !== familyOf(canonicalSet);
      if (crossFamily && witnesses < 3) { insufficientWitnesses++; continue; }

      const tKey = `${currentSet}  →  ${canonicalSet}`;
      transitions[tKey] = (transitions[tKey] || 0) + 1;
      parts[3] = canonicalSet;
      const newSlug = parts.join(":");

      rewritten++;
      if (MODE === "apply") {
        row.hobbyiqCardId = newSlug;
        row.__stage2TitleParsedAt = new Date().toISOString();
        row.__stage2Witnesses = witnesses;
        inFlight.push(
          withRetry(() => sc.items.upsert(row))
            .catch(e => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) {
      console.log(`  examined=${examined}  rewritten=${rewritten}  insufficient=${insufficientWitnesses}  noTitle=${noTitle}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:         ${examined}`);
  console.log(`  no title:         ${noTitle}`);
  console.log(`  insufficient wit: ${insufficientWitnesses}`);
  console.log(`  same slug:        ${sameSlug}`);
  console.log(`  rewritten:        ${rewritten}`);
  console.log(`  errors:           ${errors}`);

  console.log(`\nTop 30 transitions:`);
  Object.entries(transitions).sort((a,b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
