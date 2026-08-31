#!/usr/bin/env node
// CF-HOBBYMONITOR-CHECKLIST (Drew, 2026-08-15, sharing
// hobbymonitor.com/release/2026-donruss-baseball-checklist).
//
// FOURTH checklist source, and the one that covers what the other three do
// not. Beckett publishes Topps/Bowman XLSX and almost no Panini;
// cardboardchecklist holds 3 Panini checklists in total. Hobby Monitor's
// release index carries 112 releases — 68 Topps, 29 PANINI — including
// 2026 Panini Prizm Baseball, 2026 Panini Immaculate Baseball, 2026 Panini
// Donruss Football, 2025-26 Panini Prizm Basketball and Panini Origins.
//
// NO API KEY NEEDED. api.hobbymonitor.com/v3 answers 401, but the release
// page server-renders the whole checklist into the HTML, so this parses the
// page rather than calling the API.
//
// Page shape — two independent arrays:
//   teamChecklists[] one object per CARD
//       {cardNumber, players[], cardSet, cardType, rookie, team, ...}
//   cardParallels[]  one entry per SUBSET, listing that subset's parallels
//       {cardSet, cardType, parallels:[{name, printRun, isOneOfOne, odds}]}
//
// THE LADDER LANDS ON ITS OWN SUBSET'S CARDS (CF-HM-LADDER-INTO-ROWS,
// 2026-08-30). This used to emit one row per card and park the ladder in a
// sidecar, so every print run in the release was lost: hobbymonitor puts
// numberDenominator on ZERO card objects and states the run once per subset,
// on the ladder. 2026 Bowman ingested that way gives 1,165 rows with an empty
// printRun column — CPA-JG's Refractor is /499 on the page and null in the
// catalog.
//
// This is NOT the cross-product rejected on 2026-08-11. A subset's ladder is
// applied to THAT SUBSET'S OWN CARDS ONLY — the same shape
// convertChecklistCenterToChecklistCsv already uses (its convertHtml emits a
// base row per card, then one row per rung of that card's own subset). The
// rejected shape multiplied one product-wide parallel list across every card
// in the release; this joins on (cardSet, cardType), which is how the source
// itself scopes a ladder.
//
// TWO GUARDS, because a ladder is only as good as what is in it:
//   * REAL RUNGS ONLY. 53 of 2026 Bowman's 218 "parallels" are PLAYER NAMES
//     misfiled into the parallels[] of five hit subsets ({name:"Ethan
//     Holliday", printRun:null, odds:null}). A rung is real only when the
//     source gives it a printRun, isOneOfOne or odds; anything else that also
//     matches this product's own roster is dropped as a misfiled name. That is
//     the exploded-spine shape (11.49M cards x players rows) caught early.
//   * PER-SUBSET CEILINGS. Same gate as the CLC converter: a subset whose
//     ladder exceeds PAR_MAX rungs, or whose card list exceeds NUM_MAX
//     numbers, is what a roster-read-as-a-ladder looks like — refuse that
//     subset, keep the rest, and say so.
//
// Emits the canonical CSV contract, with the 7th column the CLC converter
// added for a rung's odds/footnote:
//     category,cardNumber,parallel,isAuto,printRun,player,parallelNote
//
// The manifest sets parallelColumnAuthoritative:true, so ingest-scraped-
// checklist reads the rung out of the parallel column instead of re-deriving
// a label from the category slug. Without that flag the legacy branch turns
// "insert-base-cards" into the parallel "Base Cards" — the anchor's own name
// baked into the rung, on the 100 BASE cards of the set.
//
//   node scripts/fetchHobbyMonitorChecklist.cjs \
//     --url https://www.hobbymonitor.com/release/2026-donruss-baseball-checklist \
//     --out data/checklists/scraped/2026-panini-donruss-baseball.csv
//   node scripts/fetchHobbyMonitorChecklist.cjs --list

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const UA = "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0)";

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

/**
 * Pull every JSON object in `html` that carries `marker`, by walking balanced
 * braces outward from each hit. The page is a Next.js payload with the data
 * inlined as escaped strings, so a regex cannot bound an object reliably.
 */
function extractObjects(html, marker) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf(marker, i)) !== -1) {
    let start = i, depth = 0;
    for (let j = i; j >= 0; j--) {
      const c = html[j];
      if (c === "}") depth++;
      else if (c === "{") { if (depth === 0) { start = j; break; } depth--; }
    }
    let d = 0, end = start;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (c === "{") d++;
      else if (c === "}") { d--; if (d === 0) { end = j; break; } }
    }
    try { out.push(JSON.parse(html.slice(start, end + 1))); } catch { /* not JSON — skip */ }
    i = end > i ? end : i + marker.length;
  }
  return out;
}

/** Balanced-scan the array value that follows `"key":`. */
function extractArray(html, key) {
  const k = html.indexOf(`"${key}"`);
  if (k === -1) return [];
  const s = html.indexOf("[", k);
  if (s === -1) return [];
  let d = 0, e = s;
  for (let j = s; j < html.length; j++) {
    const c = html[j];
    if (c === "[") d++;
    else if (c === "]") { d--; if (d === 0) { e = j; break; } }
  }
  try { return JSON.parse(html.slice(s, e + 1)); } catch { return []; }
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A subset is an autograph set when the source says so, either on cardType or
// in the subset name. Relic/Insert stay false — isAuto is about signatures.
const isAutoOf = (c) =>
  /autograph/i.test(String(c.cardType ?? "")) ||
  /\b(auto|autograph|signature)/i.test(String(c.cardSet ?? ""));

// Same ceilings as convertChecklistCenterToChecklistCsv: past these a "ladder"
// is a roster and the subset is refused rather than multiplied.
const PAR_MAX = 150, NUM_MAX = 2000;

/** Fold a name for roster comparison: "Julio Rodriguez - Seattle Mariners"
 *  and "Julio Rodriguez" are the same person. The team suffix comes off. */
const foldName = (s) => String(s ?? "").split(" - ")[0]
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z]/g, "");

/**
 * A parallel entry is a real RUNG only when the source priced its scarcity:
 * a printRun, a 1/1 flag, or pack odds. Everything else is a misfiled player
 * name -- 53 of 218 on 2026 Bowman -- and minting those would put "Ethan
 * Holliday" in the parallel column of a catalog row.
 *
 * `roster` is every player name in THIS product, so a refusal can name which
 * of the two reasons it fired on; an entry with no scarcity that is also a
 * known player of the set is unambiguous.
 */
function classifyRung(p, roster) {
  const name = String(p && p.name != null ? p.name : "").trim();
  if (!name) return { ok: false, why: "empty" };
  const hasScarcity = p.printRun != null || p.isOneOfOne === true ||
    (p.odds != null && String(p.odds).trim() !== "");
  if (hasScarcity) return { ok: true, why: null };
  if (roster.has(foldName(name))) return { ok: false, why: "player-name" };
  if (name.length > 60) return { ok: false, why: "over-60-chars" };
  return { ok: false, why: "no-scarcity" };
}

/** The print run a rung states. isOneOfOne is the source's way of writing /1. */
const runOf = (p) => (p.isOneOfOne === true ? 1 : (p.printRun != null ? p.printRun : ""));

/** A rung's footnote -- the pack odds, kept in the 7th column like the CLC
 *  converter's parallelNote. Never part of the parallel name. */
const noteOf = (p) => String(p.odds == null ? "" : p.odds).replace(/\s+/g, " ").trim();

async function main() {
  if (has("--list")) {
    const html = await get("https://www.hobbymonitor.com/releases");
    const rel = extractObjects(html, '"manufacturer"').filter((o) => o.slug);
    const uniq = [...new Map(rel.map((o) => [o.slug, o])).values()];
    console.log(JSON.stringify(uniq.map((o) => ({
      slug: o.slug, manufacturer: o.manufacturer, sport: o.sport, status: o.status,
    })), null, 1));
    console.log(`\n${uniq.length} releases`);
    return;
  }

  const url = val("--url", "");
  if (!url) { console.error("need --url <release page> (or --list)"); process.exit(1); }
  const out = val("--out", "");

  const html = await get(url);
  const cards = extractObjects(html, '"cardNumber"');
  const parallelGroups = extractArray(html, "cardParallels");

  if (cards.length === 0) {
    console.error("no cards found — the page shape may have changed");
    process.exit(1);
  }

  // The product's own roster, for the misfiled-name guard.
  const roster = new Set();
  for (const c of cards) {
    for (const pl of (Array.isArray(c.players) ? c.players : [c.players])) {
      const f = foldName(pl); if (f) roster.add(f);
    }
  }

  // Index the ladders by the pair the source itself scopes them with. A group
  // is {cardSet, cardType, parallels[]} and the cards carry the same two
  // fields, so the join is exact -- no name-similarity guessing.
  const ladderByKey = new Map();
  const rungStats = { entries: 0, real: 0, playerName: 0, noScarcity: 0, other: 0 };
  const droppedNames = [];
  for (const g of parallelGroups) {
    const kept = [];
    for (const p of (g.parallels || [])) {
      rungStats.entries++;
      const v = classifyRung(p, roster);
      if (v.ok) { rungStats.real++; kept.push(p); continue; }
      if (v.why === "player-name") { rungStats.playerName++; droppedNames.push(`${g.cardSet} :: ${p.name}`); }
      else if (v.why === "no-scarcity") rungStats.noScarcity++;
      else rungStats.other++;
    }
    ladderByKey.set(`${g.cardSet}||${g.cardType}`, kept);
  }

  // Cards, deduped -- the same card is listed once per team.
  const cardRows = [];
  const seen = new Set();
  for (const c of cards) {
    const num = String(c.cardNumber ?? "").trim();
    if (!num) continue;
    const set = String(c.cardSet ?? c.cardType ?? "Base").trim() || "Base";
    const player = Array.isArray(c.players) ? c.players.join(" / ") : String(c.players ?? "");
    const key = `${set}|${num}|${player}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cardRows.push({ num, set, type: String(c.cardType ?? "").trim(), player, auto: isAutoOf(c) });
  }

  // ingest-scraped-checklist accepts only "base", "insert-*" and "auto-*", so
  // the subset name has to ride in the category or the row is skipped and its
  // identity is lost.
  const categoryOf = (set, auto) =>
    auto ? `auto-${slug(set)}` : (slug(set) === "base" ? "base" : `insert-${slug(set)}`);

  // Emit: the base row for every card, then that card's own subset ladder.
  // The BASE row's parallel is blank -- "blank means unknown, never Base" --
  // except in the `base` category, whose card IS the base card. ingest reads
  // "" as the base tier through normalizeParallel.
  const rows = [];
  const bySubset = new Map();
  let ladderRows = 0, refusedSubsets = 0;
  const refusedNote = [];
  for (const c of cardRows) {
    const cat = categoryOf(c.set, c.auto);
    const rungs = ladderByKey.get(`${c.set}||${c.type}`) || [];
    const st = bySubset.get(c.set) || { cards: 0, rungs: rungs.length, rows: 0, refused: false };
    st.cards++;
    bySubset.set(c.set, st);
    rows.push({ category: cat, cardNumber: c.num, parallel: cat === "base" ? "Base" : "",
      isAuto: c.auto, printRun: "", player: c.player, parallelNote: "" });
    st.rows++;
  }
  // Per-subset ceilings, decided on the subset as a whole before any rung row
  // is emitted for it.
  const numsBySubset = new Map();
  for (const c of cardRows) {
    if (!numsBySubset.has(c.set)) numsBySubset.set(c.set, new Set());
    numsBySubset.get(c.set).add(c.num);
  }
  for (const c of cardRows) {
    const rungs = ladderByKey.get(`${c.set}||${c.type}`) || [];
    if (!rungs.length) continue;
    const nRungs = new Set(rungs.map((r) => r.name)).size;
    const nNums = (numsBySubset.get(c.set) || new Set()).size;
    if (nRungs > PAR_MAX || nNums > NUM_MAX) {
      const st = bySubset.get(c.set);
      if (st && !st.refused) {
        st.refused = true; refusedSubsets++;
        refusedNote.push(`${c.set}: rungs=${nRungs} numbers=${nNums} (gate ${PAR_MAX}/${NUM_MAX})`);
      }
      continue;
    }
    const cat = categoryOf(c.set, c.auto);
    for (const r of rungs) {
      rows.push({ category: cat, cardNumber: c.num, parallel: String(r.name).trim(),
        isAuto: c.auto, printRun: runOf(r), player: c.player, parallelNote: noteOf(r) });
      ladderRows++;
      const st = bySubset.get(c.set); if (st) st.rows++;
    }
  }

  const header = "category,cardNumber,parallel,isAuto,printRun,player,parallelNote";
  const body = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, r.player, r.parallelNote]
    .map(csvCell).join(",")).join("\n");

  const withRun = rows.filter((r) => String(r.printRun) !== "").length;
  console.log(`${url}`);
  console.log(`  cards=${cards.length} cardRows=${cardRows.length} (deduped ${cards.length - cardRows.length}) subsets=${bySubset.size}`);
  console.log(`  ladder groups=${parallelGroups.length} entries=${rungStats.entries} -> real rungs=${rungStats.real}` +
    `  DROPPED player-names=${rungStats.playerName} no-scarcity=${rungStats.noScarcity} other=${rungStats.other}`);
  console.log(`  rows=${rows.length} (base ${cardRows.length} + ladder ${ladderRows})  with printRun=${withRun}`);
  if (refusedSubsets) for (const n of refusedNote) console.log(`  !! REFUSED subset ${n}`);
  if (droppedNames.length) {
    console.log(`  dropped names (first 5 of ${droppedNames.length}):`);
    for (const n of droppedNames.slice(0, 5)) console.log(`     ${n}`);
  }

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${header}\n${body}\n`);
    console.log(`  wrote ${out}`);

    // ingest-scraped-checklist reads a sibling manifest for product identity.
    // setKey must be the key the CATALOG already uses, not a prettified page
    // title -- modern Donruss lives under "panini-donruss", so passing
    // "donruss" would mint a second, parallel product.
    const yr = Number(val("--year", "")) || null;
    const setKey = val("--set-key", "");
    const setName = val("--set-name", setKey);
    const sport = val("--sport", "baseball");
    if (!yr || !setKey) {
      console.log("  NOTE: --year and --set-key required for a manifest; CSV written without one.");
    } else {
      const mPath = out.replace(/[.]csv$/, "") + ".manifest.json";
      fs.writeFileSync(mPath, JSON.stringify({
        scrapedAt: new Date().toISOString(),
        sourceUrl: url,
        sport: sport, year: yr, setName: setName,
        productKey: yr + "-" + setKey,
        setKey: setKey,
        rowCount: rows.length,
        // ingest-scraped-checklist re-derives the parallel from the category
        // slug UNLESS this says otherwise -- which would file the 100 base
        // cards under a parallel named "Base Cards". The rung is already in
        // the parallel column, put there by the subset's own ladder.
        parallelColumnAuthoritative: true,
        cardRows: cardRows.length,
        ladderRows: ladderRows,
        rungsReal: rungStats.real,
        rungsDroppedPlayerName: rungStats.playerName,
        rungsDroppedNoScarcity: rungStats.noScarcity,
        refusedSubsets: refusedSubsets,
        sectionsReport: [...bySubset.entries()].map(function (e) {
          return {
            breadcrumb: "Checklist > " + e[0],
            category: slug(e[0]),
            playerCount: e[1].cards,
            rungs: e[1].rungs,
            rowCount: e[1].rows,
            refused: e[1].refused,
            printRun: null,
          };
        }),
      }, null, 1));
      console.log("  wrote " + mPath);
    }
    // Park the parallel list next to the CSV. It is real published data and
    // we should not lose it just because we are not minting rows from it.
    if (parallelGroups.length) {
      const side = out.replace(/\.csv$/, "") + ".parallels.json";
      fs.writeFileSync(side, JSON.stringify({ sourceUrl: url, groups: parallelGroups }, null, 1));
      console.log(`  wrote ${side}  (${rungStats.entries} published entries, ${rungStats.real} real rungs)`);
    }
  } else {
    console.log(`${header}\n${body}`);
  }
}

// Only run when invoked directly, so the pure helpers above can be unit
// tested (the ladder filter is the guard against minting players as rungs).
if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
}

module.exports = { classifyRung, foldName, runOf, noteOf, extractObjects, extractArray, PAR_MAX, NUM_MAX };
