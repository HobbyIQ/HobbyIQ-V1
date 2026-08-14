#!/usr/bin/env node
// CF-CARDBOARD-CHECKLIST-MCP (Drew, 2026-08-13, sharing
// cardboardchecklist.com/api/mcp: "can we get all of this?").
//
// THIRD checklist source, and the best-shaped one we have. It exposes an MCP
// server over JSON-RPC with four tools; `search_checklists` enumerates the
// whole database in one call and `list_cards` returns EVERY card for a set with
// no cap:
//
//   359 checklists · 288,173 cards
//   2025-26 Topps Chrome Basketball -> totalMatched 1299, returned 1299
//
// No HTML parsing, no S3 filename probing, no rate limit encountered. Card
// objects arrive already structured:
//
//   {"cardNumber":"RA-CF","player":"Cooper Flagg","team":"Dallas Mavericks",
//    "type":"Autograph","rookie":true,"subset":"Rookie Autographs Lava Lamp"}
//
// which maps directly onto the CSV contract the other two sources emit, so
// ingest-scraped-checklist consumes it unchanged.
//
//   node scripts/fetchCardboardChecklistMcp.cjs --list
//   node scripts/fetchCardboardChecklistMcp.cjs --slug 2025-26-topps-chrome-basketball \
//     --out data/checklists/scraped/2026-topps-chrome-basketball.csv

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const ENDPOINT = "https://www.cardboardchecklist.com/api/mcp";

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIST = args.includes("--list");
const SLUG = val("--slug", "");
const OUT = val("--out", "");
const SET_KEY_IN = val("--set-key", "");
const YEAR_IN = val("--year", "");
const SPORT_IN = val("--sport", "");
const QUIET = args.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The server negotiates SSE unless JSON is explicitly acceptable.
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "HobbyIQ-checklist/1.0",
      },
    }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => { b += c; });
      res.on("end", () => {
        try {
          const env = JSON.parse(b);
          if (env.error) return reject(new Error(JSON.stringify(env.error).slice(0, 200)));
          // tools/call wraps its payload as a JSON string in content[0].text
          const text = env?.result?.content?.[0]?.text;
          resolve(text ? JSON.parse(text) : env.result);
        } catch (e) { reject(new Error(`bad response: ${String(b).slice(0, 160)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

const call = (name, argsObj) => rpc("tools/call", { name, arguments: argsObj });

const slugify = (s) => String(s ?? "").toLowerCase().replace(/&/g, " ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * setKey the SALES compute: brand only, with the year and sport stripped.
 *
 *   "2025-26 Topps Chrome Basketball Checklist" -> topps-chrome
 *   "1992 Donruss Baseball"                     -> donruss
 *
 * Our basketball sales carry setKey "topps-chrome" (seed queue confirms), so
 * emitting the full title would make the whole set unmatchable.
 */
function setKeyFromTitle(title) {
  return slugify(String(title ?? "")
    .replace(/checklist/ig, "")
    .replace(/^\s*(19|20)\d{2}(\s*[-/]\s*\d{2,4})?\s*/, "")
    .replace(/\s+(baseball|basketball|football|hockey|soccer|ufc|mma|tennis|golf)\s*$/i, "")
    .trim());
}

/** Season strings ("2025-26") resolve to the LATTER year, which is what our
 *  basketball/hockey sales use — a 2024-25 product slugs under 2025. */
function yearFromField(y) {
  const s = String(y ?? "");
  const m = s.match(/^(\d{4})\s*-\s*(\d{2,4})$/);
  if (m) {
    const tail = m[2].length === 2 ? Number(m[1].slice(0, 2) + m[2]) : Number(m[2]);
    return tail;
  }
  const n = Number(s.slice(0, 4));
  return Number.isFinite(n) ? n : 0;
}

/** type + subset -> the CSV `category`, which is what the ingest turns back
 *  into a parallel (CF-CHECKLIST-SECTION-IS-THE-PARALLEL). */
function categoryFor(type, subset) {
  const t = String(type ?? "").toLowerCase();
  const sub = slugify(subset);
  if (t.includes("autograph")) return sub ? `auto-${sub}` : "auto-autographs";
  // CF-SUBSET-IS-NOT-A-PARALLEL (Drew, 2026-08-14). A BASE card is base, full
  // stop. This previously returned `insert-<subset>` whenever the section had
  // a name, and the ingest derives the parallel from the category — so
  // "Base Cards Refractor" became parallel `base-cards-refractor` and the dry
  // run reported base=0 on every checklist. Sales carry `:base:`, so those
  // rows would have matched nothing while looking like coverage.
  //
  // The section name is dropped here deliberately: for Finest/Pristine it
  // describes the stock the whole base set is printed on, not a distinction
  // between cards, so it carries no per-card information worth keeping.
  if (t === "base" || t === "") return "base";
  return sub ? `insert-${sub}` : `insert-${slugify(type) || "insert"}`;
}

(async () => {
  if (LIST) {
    const r = await call("search_checklists", { query: "", limit: 1000 });
    const rows = r.results ?? [];
    console.log(JSON.stringify(rows.map((x) => ({
      slug: x.slug, title: x.title, year: x.year, sport: x.sport, cardCount: x.cardCount,
    })), null, 0));
    return;
  }

  if (!SLUG || !OUT) { console.error("--slug and --out required (or --list)"); process.exit(2); }

  const meta = await call("search_checklists", { query: SLUG, limit: 20 });
  const found = (meta.results ?? []).find((x) => x.slug === SLUG) ?? null;
  const title = found?.title ?? SLUG;
  const sport = SPORT_IN || found?.sport || "baseball";
  const year = YEAR_IN ? Number(YEAR_IN) : yearFromField(found?.year);
  const setKey = SET_KEY_IN || setKeyFromTitle(title);
  if (!year) { console.error(`cannot resolve a year for ${SLUG}`); process.exit(1); }

  const data = await call("list_cards", { slug: SLUG, limit: 20000 });
  const cards = data.cards ?? [];
  log(`${title}  year=${year} setKey=${setKey} sport=${sport}`);
  log(`  totalMatched=${data.totalMatched} returned=${cards.length}`);
  if (cards.length === 0) { console.error("no cards returned"); process.exit(1); }
  if (data.totalMatched && cards.length < data.totalMatched) {
    // Never silently ingest a partial set — that looks like coverage and is not.
    console.error(`TRUNCATED: got ${cards.length} of ${data.totalMatched}`);
    process.exit(1);
  }

  const q = (s) => (/[",]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = [];
  const byCat = {};
  // CF-SUBSET-IS-NOT-A-PARALLEL (Drew, 2026-08-14: "do it").
  //
  // `parallel: c.subset` was wrong, and it made this whole source unusable.
  // The MCP `subset` field is a checklist SECTION name — "Base Cards
  // Refractor", "Base Uncommon Refractor", "Common Refractor" — describing
  // which part of the checklist a card sits in, and for Finest/Pristine what
  // stock the base set is printed on. It is not the card's parallel.
  //
  // Emitting it as one produced:
  //
  //   hiq:baseball:2026:topps-pristine:1:base-cards-refractor:no-auto
  //   hiq:baseball:2025:topps-finest:1:common-refractor:no-auto
  //
  // and a dry run reporting `base=0` on all three fetched checklists — every
  // base card given a parallel no sale will ever carry. The incoming sales
  // carry `:base:`, so ingesting these would have added thousands of rows that
  // match nothing, while looking like coverage.
  //
  // A base card's parallel is "Base". The section name is already carried by
  // `category`, which is where the ingest reads insert/subset structure from,
  // so nothing is lost by keeping it out of the parallel slot.
  //
  // Non-base types keep the subset, because for an insert or autograph section
  // the subset IS the distinguishing product name the sale will name too.
  for (const c of cards) {
    const category = categoryFor(c.type, c.subset);
    byCat[category] = (byCat[category] ?? 0) + 1;
    const type = String(c.type ?? "").toLowerCase();
    const isBaseCard = type === "base" || type === "";
    rows.push({
      category,
      cardNumber: String(c.cardNumber ?? "").trim(),
      parallel: isBaseCard ? "Base" : (c.subset ?? "Base"),
      isAuto: type.includes("autograph") ? "true" : "false",
      printRun: "",
      player: c.player ?? "",
    });
  }
  const seen = new Set();
  const kept = rows.filter((r) => {
    if (!r.cardNumber) return false;
    const k = `${r.category}|${r.cardNumber}|${r.player}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of kept) csv.push([r.category, q(r.cardNumber), q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), csv.join("\n") + "\n");
  fs.writeFileSync(path.resolve(OUT).replace(/\.csv$/, ".manifest.json"), JSON.stringify({
    source: "cardboardchecklist-mcp",
    sourceUrl: `${ENDPOINT} (list_cards ${SLUG})`,
    sport, year, setKey, setName: title,
    rows: kept.length, deduped: rows.length - kept.length,
    categories: Object.keys(byCat).length,
    fetchedAt: new Date().toISOString(),
  }, null, 2));

  log(`  rows=${kept.length} (deduped ${rows.length - kept.length}) categories=${Object.keys(byCat).length}`);
  log(`  wrote ${OUT}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
