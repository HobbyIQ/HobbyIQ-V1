// CF-CATALOG-AS-HUB (Drew, 2026-08-07). DRY-RUN audit only — no writes.
//
// Streams card_catalog entries missing hobbyiqCardId, tries to compute
// the canonical slug from the entry's own fields (sport/year/setName/
// cardNumber/isAuto/parallel/printRun), and tallies:
//   - computable         → we can backfill this
//   - missing_sport      → what's absent
//   - missing_year       → what's absent
//   - missing_setName    → what's absent
//   - missing_cardNumber → what's absent (the killer — cardNumber uniquely
//                          identifies within setKey; no cardNumber = no slug)
//   - other_missing      → catch-all for combos we can't compute
//
// Also samples 20 computed slugs so we can eyeball the shape.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   MAX_ROWS                  default 300000 — hard cap on scanned rows
//                             (full scan of 4.9M rows would be RU-expensive)
//   MAX_MINUTES               default 15 — wall clock cap
//   BATCH_SIZE                default 1000 rows per page

const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");

const MAX_ROWS    = Math.max(1000, Number(process.env.MAX_ROWS    || 300_000));
const MAX_MINUTES = Math.max(1,    Number(process.env.MAX_MINUTES || 15));
const BATCH_SIZE  = Math.max(50,   Number(process.env.BATCH_SIZE  || 1000));

function loadCompute() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const p = path.join(distRoot, "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

// CF-CATALOG-SETNAME-PARSER (Drew, 2026-08-07). Recover year + sport from
// setName text when the catalog entry didn't populate those fields.
// CardHedge-sourced rows (cardhedge:: id prefix) commonly land with
// setName="2025 Bowman Chrome Baseball" and null year/sport. Both are
// literally in the text — parse them out so we can compute the slug.
const SPORT_TOKENS = [
  ["baseball", "baseball"],
  ["basketball", "basketball"],
  ["football", "football"],
  ["hockey", "hockey"],
  ["soccer", "soccer"],
  ["golf", "golf"],
  ["ufc", "ufc"], ["mma", "ufc"],
  ["boxing", "boxing"],
  ["wrestling", "wrestling"],
  ["nascar", "racing"], ["formula 1", "racing"], ["f1", "racing"],
  ["pokemon", "pokemon"], ["pokémon", "pokemon"],
  ["magic", "mtg"], ["mtg", "mtg"],
  ["yugioh", "yugioh"], ["yu-gi-oh", "yugioh"],
  ["one piece", "one-piece"],
  // MLB/NFL/NBA/NHL aliases in case the token appears bare
  ["mlb", "baseball"], ["nfl", "football"], ["nba", "basketball"], ["nhl", "hockey"],
];

function extractYear(setName) {
  const m = String(setName).match(/\b(19|20|21)\d{2}\b/);
  if (!m) return null;
  const y = Number(m[0]);
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : null;
}

function extractSport(setName) {
  const lower = String(setName).toLowerCase();
  for (const [needle, canonical] of SPORT_TOKENS) {
    if (lower.includes(needle)) return canonical;
  }
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const compute = loadCompute();

  console.log(`[audit-slug-backfill] DRY-RUN cap=${MAX_ROWS} rows / ${MAX_MINUTES} min / batch=${BATCH_SIZE}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Select BOTH year and cardYear — Cardsight uses `year`, other sources
  // may use `cardYear`. Same for setName (some sources also carry `set`).
  // Also grab `source` to bucket by origin (cardhedge / cardsight / other).
  const q = {
    // c.set and c.number are Cosmos reserved words — quote with brackets.
    query: `SELECT c.id, c.source, c.sport, c.cardYear, c.year, c.setName, c["set"] AS setAlt,
                   c.cardNumber, c["number"] AS numberAlt, c.isAuto,
                   c.parallel, c.parallelSlug, c.printRun
            FROM c
            WHERE NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = ''`,
  };
  const iter = cat.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0;
  const tally = {
    computable_direct: 0,             // year field populated directly
    computable_via_setname_parse: 0,  // rescued by parsing year+sport from setName
    unrecoverable_missing_setName: 0,
    unrecoverable_missing_cardNumber: 0,
    unrecoverable_setname_unparseable: 0,   // year genuinely can't be resolved
  };
  const bySource = {}; // source -> { computable, unrecoverable, missing_cn, missing_set }
  const sampleSlugs = [];
  const sampleUnparseable = [];

  function bumpSource(src, bucket) {
    const key = src || "unknown";
    if (!bySource[key]) bySource[key] = { computable: 0, unrecoverable: 0, missing_cn: 0, missing_set: 0 };
    bySource[key][bucket]++;
  }

  while (iter.hasMoreResults()) {
    if (scanned >= MAX_ROWS) { console.warn(`[audit] row cap reached at ${scanned}`); break; }
    if (Date.now() - startMs > budgetMs) { console.warn(`[audit] time cap reached at ${scanned}`); break; }

    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const src = r.source || (r.id?.split("::")[0]) || "unknown";
      let sport      = r.sport      && String(r.sport).trim().toLowerCase();
      // Try both year fields — Cardsight uses `year`, others may use `cardYear`.
      let year = Number(r.year);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) year = Number(r.cardYear);
      const setName    = (r.setName || r.setAlt) && String(r.setName || r.setAlt).trim();
      const cardNumber = (r.cardNumber || r.numberAlt) && String(r.cardNumber || r.numberAlt).trim();
      const parallel   = r.parallel ?? r.parallelSlug ?? null;
      const isAuto     = !!r.isAuto;
      const printRun   = typeof r.printRun === "number" ? r.printRun : null;

      // Hard blockers first — no cardNumber or setName means no slug.
      if (!cardNumber) {
        tally.unrecoverable_missing_cardNumber++;
        bumpSource(src, "missing_cn");
        continue;
      }
      if (!setName) {
        tally.unrecoverable_missing_setName++;
        bumpSource(src, "missing_set");
        continue;
      }

      let via = "direct";
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        const parsedYear = extractYear(setName);
        if (parsedYear) { year = parsedYear; via = "parsed"; }
      }
      if (!sport) {
        const parsedSport = extractSport(setName);
        if (parsedSport) { sport = parsedSport; via = via === "direct" ? "parsed" : via; }
      }

      if (!sport || !Number.isFinite(year) || year < 1900 || year > 2100) {
        tally.unrecoverable_setname_unparseable++;
        bumpSource(src, "unrecoverable");
        if (sampleUnparseable.length < 8) {
          sampleUnparseable.push({ id: r.id?.slice(0, 30), source: src, setName, cardNumber, sport, year });
        }
        continue;
      }

      const slug = compute({
        sport, year, setKey: setName, cardNumber, parallel, isAuto, printRun,
      });
      if (via === "direct") tally.computable_direct++;
      else tally.computable_via_setname_parse++;
      bumpSource(src, "computable");

      if (sampleSlugs.length < 20) {
        sampleSlugs.push({ id: r.id?.slice(0, 20), src, via, setName, cardNumber, slug });
      }
    }

    if (scanned % 20_000 === 0) {
      const total = tally.computable_direct + tally.computable_via_setname_parse;
      console.log(`  [progress] scanned=${scanned} computable=${total} unparseable=${tally.unrecoverable_setname_unparseable}`);
    }
  }

  const totalComputable = tally.computable_direct + tally.computable_via_setname_parse;
  const pct = scanned > 0 ? Math.round((totalComputable / scanned) * 1000) / 10 : 0;

  console.log("\n=== AUDIT SUMMARY (DRY-RUN) ===");
  console.log(`scanned: ${scanned}`);
  console.log(`elapsed: ${Math.round((Date.now() - startMs) / 1000)}s`);
  console.log("\ntally:");
  for (const [k, v] of Object.entries(tally)) {
    const rowPct = scanned > 0 ? ((v / scanned) * 100).toFixed(1) : "0.0";
    console.log(`  ${k.padEnd(40)} ${String(v).padStart(8)}  (${rowPct}%)`);
  }
  console.log(`\ntotal computable: ${totalComputable} / ${scanned} = ${pct}%`);

  console.log("\nBreakdown by source:");
  for (const [src, s] of Object.entries(bySource).sort((a, b) => (b[1].computable + b[1].unrecoverable + b[1].missing_cn + b[1].missing_set) - (a[1].computable + a[1].unrecoverable + a[1].missing_cn + a[1].missing_set))) {
    const t = s.computable + s.unrecoverable + s.missing_cn + s.missing_set;
    const compPct = t > 0 ? ((s.computable / t) * 100).toFixed(1) : "0.0";
    console.log(`  ${src.padEnd(16)} total=${String(t).padStart(7)}  computable=${String(s.computable).padStart(7)} (${compPct}%)  missing_cn=${String(s.missing_cn).padStart(6)}  missing_set=${String(s.missing_set).padStart(4)}  unrecoverable=${String(s.unrecoverable).padStart(6)}`);
  }

  console.log("\nSample computed slugs (20):");
  for (const s of sampleSlugs) console.log(`  [${s.src}/${s.via}] ${s.slug}   [${s.setName} #${s.cardNumber}]`);

  if (sampleUnparseable.length > 0) {
    console.log("\nSample rows we could NOT resolve (year genuinely missing):");
    for (const u of sampleUnparseable) console.log(`  [${u.source}] ${u.id}  setName=${JSON.stringify(u.setName)}  cardNumber=${u.cardNumber}  parsed{sport=${u.sport}, year=${u.year}}`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
