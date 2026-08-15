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
// ONE ROW PER CARD — NO CROSS PRODUCT. 2026 Donruss carries 1,210 cards and
// 248 parallel entries. Multiplying them would mint ~300,000 rows asserting
// that every card exists in every parallel, which the source never says:
// it states a subset's parallel LIST, not that card #44 exists in Yellow
// Flood. Short prints and case hits make that inference wrong in detail, and
// it is exactly the templating rejected on 2026-08-11 (memory: "No synthetic
// parallels — actuals only"). So the cards are emitted, and the parallel
// list is written beside them as set-level metadata for a later decision.
//
// Emits the same CSV contract ingest-scraped-checklist already consumes, so
// nothing downstream changes:
//     category,cardNumber,parallel,isAuto,printRun,player
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

(async () => {
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

  const rows = [];
  const seen = new Set();
  for (const c of cards) {
    const num = String(c.cardNumber ?? "").trim();
    if (!num) continue;
    const set = String(c.cardSet ?? c.cardType ?? "Base").trim() || "Base";
    const player = Array.isArray(c.players) ? c.players.join(" / ") : String(c.players ?? "");
    const key = `${set}|${num}|${player}`;
    if (seen.has(key)) continue;          // same card listed under several teams
    seen.add(key);
    // ingest-scraped-checklist accepts only "base", "insert-*" and "auto-*",
    // and it derives the PARALLEL from the category slug (it ignores the
    // parallel column). So the subset name has to ride in the category, or
    // the row is skipped and its identity is lost — a first pass emitted
    // "base-optic"/"bomb-squad" and lost 1,110 of 1,210 rows that way.
    const auto = isAutoOf(c);
    let category;
    if (auto) category = `auto-${slug(set)}`;
    else if (slug(set) === "base") category = "base";
    else category = `insert-${slug(set)}`;
    rows.push({
      category,
      cardNumber: num,
      parallel: set,
      isAuto: auto,
      printRun: c.numberDenominator ?? "",
      player,
    });
  }

  const header = "category,cardNumber,parallel,isAuto,printRun,player";
  const body = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, r.player]
    .map(csvCell).join(",")).join("\n");

  const parallelCount = parallelGroups.reduce((a, g) => a + (g.parallels?.length ?? 0), 0);
  console.log(`${url}`);
  console.log(`  cards=${cards.length} rows=${rows.length} (deduped ${cards.length - rows.length}) subsets=${new Set(rows.map((r) => r.category)).size}`);
  console.log(`  parallel groups=${parallelGroups.length} parallel entries=${parallelCount} (NOT expanded — see header)`);

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
        sectionsReport: [...new Set(rows.map(function (r) { return r.parallel; }))].map(function (sub) {
          return {
            breadcrumb: "Checklist > " + sub,
            category: slug(sub),
            playerCount: rows.filter(function (r) { return r.parallel === sub; }).length,
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
      console.log(`  wrote ${side}  (${parallelCount} parallels, set-level metadata)`);
    }
  } else {
    console.log(`${header}\n${body}`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
