// CF-CATALOG-AS-HUB (Drew, 2026-08-07). Backfill hobbyiqCardId onto
// card_catalog entries missing it. Enables catalog-as-hub: every catalog
// card resolves to its canonical hiq: slug, and every comp in sold_comps
// (which already carries hobbyiqCardId on 99.98% of rows) joins to its
// catalog entry.
//
// Behavior:
//   • Dry-run scan: SELECT rows missing hobbyiqCardId (with all fields
//     needed to compute it — INCLUDING cardId for the partition key).
//   • For each row where slug is computable: PATCH add /hobbyiqCardId.
//   • Skip rows we can't compute (missing cardNumber, missing set, year
//     genuinely unavailable). Log them so we can chase separately.
//   • Idempotent: re-running is safe — the WHERE clause excludes rows
//     that already have hobbyiqCardId.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   COSMOS_DATABASE           default "hobbyiq"
//   APPLY=true                actually PATCH (else dry-run, count only)
//   MAX_ROWS                  default Infinity — hard cap on scanned rows
//   MAX_MINUTES               default 120 — wall clock cap
//   BATCH_SIZE                default 1000 — Cosmos page size
//   CONCURRENCY               default 24 — in-flight PATCH ops
//   THROTTLE_MS               default 0 — sleep between batches if you
//                             need to protect live traffic

const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");

const APPLY       = process.env.APPLY === "true";
const MAX_ROWS    = Number(process.env.MAX_ROWS    || 0) || Infinity;
const MAX_MINUTES = Math.max(1,  Number(process.env.MAX_MINUTES || 120));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE  || 1000));
const CONCURRENCY = Math.max(1,  Number(process.env.CONCURRENCY || 24));
const THROTTLE_MS = Math.max(0,  Number(process.env.THROTTLE_MS || 0));

function loadCompute() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

const SPORT_TOKENS = [
  ["baseball", "baseball"], ["basketball", "basketball"], ["football", "football"],
  ["hockey", "hockey"], ["soccer", "soccer"], ["golf", "golf"],
  ["ufc", "ufc"], ["mma", "ufc"], ["boxing", "boxing"], ["wrestling", "wrestling"],
  ["nascar", "racing"], ["formula 1", "racing"], ["f1", "racing"],
  ["pokemon", "pokemon"], ["pokémon", "pokemon"],
  ["magic", "mtg"], ["mtg", "mtg"], ["yugioh", "yugioh"], ["yu-gi-oh", "yugioh"],
  ["one piece", "one-piece"],
  ["mlb", "baseball"], ["nfl", "football"], ["nba", "basketball"], ["nhl", "hockey"],
];

const extractYear = (s) => {
  const m = String(s).match(/\b(19|20|21)\d{2}\b/);
  if (!m) return null;
  const y = Number(m[0]);
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : null;
};
const extractSport = (s) => {
  const lower = String(s).toLowerCase();
  for (const [needle, canonical] of SPORT_TOKENS) if (lower.includes(needle)) return canonical;
  return null;
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const compute = loadCompute();

  console.log(`[backfill] apply=${APPLY} cap=${MAX_ROWS === Infinity ? "unlimited" : MAX_ROWS} rows / ${MAX_MINUTES} min / batch=${BATCH_SIZE} conc=${CONCURRENCY} throttleMs=${THROTTLE_MS}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Query the same rows the audit did — need cardId (partition key) for PATCH.
  // 2026-08-08 restart: exclude docs without cardId — those are the
  // ~1.86M sales-derived docs being nuked separately (b0tofgzuo). Wastes
  // no RU scanning rows that will disappear.
  const q = {
    query: `SELECT c.id, c.cardId, c.source, c.sport, c.cardYear, c.year, c.setName, c["set"] AS setAlt,
                   c.cardNumber, c["number"] AS numberAlt, c.isAuto,
                   c.parallel, c.parallelSlug, c.printRun
            FROM c
            WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')
              AND IS_DEFINED(c.cardId) AND c.cardId != null AND c.cardId != ''`,
  };
  const iter = cat.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0, patched = 0, skipped_unrecoverable = 0, errored = 0, missingPk = 0;
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (scanned >= MAX_ROWS)          { console.warn(`[backfill] row cap reached at ${scanned}`); break; }
    if (Date.now() - startMs > budgetMs) { console.warn(`[backfill] time cap reached at ${scanned}`); break; }

    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      let sport = r.sport && String(r.sport).trim().toLowerCase();
      let year = Number(r.year);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) year = Number(r.cardYear);
      const setName    = (r.setName || r.setAlt) && String(r.setName || r.setAlt).trim();
      const cardNumber = (r.cardNumber || r.numberAlt) && String(r.cardNumber || r.numberAlt).trim();
      const parallel   = r.parallel ?? r.parallelSlug ?? null;
      const isAuto     = !!r.isAuto;
      const printRun   = typeof r.printRun === "number" ? r.printRun : null;

      if (!cardNumber || !setName) { skipped_unrecoverable++; continue; }
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        const py = extractYear(setName);
        if (py) year = py;
      }
      if (!sport) {
        const ps = extractSport(setName);
        if (ps) sport = ps;
      }
      if (!sport || !Number.isFinite(year)) { skipped_unrecoverable++; continue; }

      const slug = compute({ sport, year, setKey: setName, cardNumber, parallel, isAuto, printRun });
      if (!slug || !slug.startsWith("hiq:")) { skipped_unrecoverable++; continue; }

      if (!APPLY) { patched++; continue; }
      if (!r.cardId) { missingPk++; continue; }

      // Concurrency gate
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);

      const p = cat.item(r.id, r.cardId).patch([{ op: "add", path: "/hobbyiqCardId", value: slug }])
        .then(() => { patched++; })
        .catch((err) => {
          errored++;
          if (errored <= 10) console.warn(`  patch failed id=${(r.id || "").slice(0, 40)} cardId=${(r.cardId || "").slice(0, 40)}: ${err?.code ?? err?.message ?? err}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }

    if (scanned % 20_000 === 0) {
      console.log(`  [progress] scanned=${scanned} patched=${patched} skipped=${skipped_unrecoverable} errored=${errored} inflight=${inflight.size}`);
    }
    if (THROTTLE_MS > 0) await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }

  // Drain remaining in-flight
  while (inflight.size > 0) await Promise.race([...inflight]);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== BACKFILL SUMMARY ===");
  console.log(`apply: ${APPLY}`);
  console.log(`scanned: ${scanned}`);
  console.log(`patched: ${patched}`);
  console.log(`skipped_unrecoverable: ${skipped_unrecoverable}`);
  console.log(`missing_partition_key: ${missingPk}`);
  console.log(`errored: ${errored}`);
  console.log(`elapsed: ${elapsed}s (${(patched / Math.max(elapsed, 1)).toFixed(0)} rows/s)`);
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
