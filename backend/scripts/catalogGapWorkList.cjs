#!/usr/bin/env node
// CF-CATALOG-GAP-WORKLIST (Drew, 2026-08-14: "what missing sets do we need in
// the catalog?").
//
// The naive answer — group awaiting-catalog rows by set and rank — is wrong,
// and the first run of it produced a work-list that would have wasted days.
// Three different things masquerade as "missing checklist":
//
//   1. PARSER ARTIFACTS. A slug whose cardNumber came from a serial
//      ("22/30" -> 2230) can never match, no matter how complete the
//      checklist is. Fixed in #1035/#1037 for NEW rows, but rows already in
//      awaiting-catalog keep their old slugs, so they still pollute the
//      ranking. ~13% of blocked sales.
//
//   2. UNRESOLVED SETKEY. `setKey = "unknown"` is a parse failure, not a
//      missing product. No checklist exists to go and fetch.
//
//   3. INCOMPLETE vs ABSENT. "baseball:2025:topps" ranked #1 while
//      card_catalog holds 1,636,136 rows for it. The set is not missing —
//      specific cards and parallels within it are. That is a different job
//      (extend an existing checklist) from ingesting a set we have never
//      seen, and conflating them means the actually-absent sets never get
//      worked.
//
// So each candidate set is checked against the catalog and reported in its own
// bucket, with the parser artifacts and unresolved setKeys stripped first.
//
//   node scripts/catalogGapWorkList.cjs
//   node scripts/catalogGapWorkList.cjs --top 40 --min-sales 100

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TOP = Number(val("--top", "30"));
const MIN_SALES = Number(val("--min-sales", "50"));
const CONCURRENCY = Number(val("--concurrency", "16"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

function parse(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  return {
    vertical: p[1], year: Number(p[2]), setKey: p[3], cardNumber: p[4],
    printRun: p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null,
  };
}
/** #1035/#1037: cardNumber taken from a serial. Cannot match at any checklist
 *  completeness, so it is not catalog work. */
function isParserArtifact(c) {
  if (!c.printRun || !/^\d+$/.test(c.cardNumber)) return false;
  if (!c.cardNumber.endsWith(c.printRun) || c.cardNumber.length <= c.printRun.length) return false;
  const head = c.cardNumber.slice(0, c.cardNumber.length - c.printRun.length);
  return /^\d+$/.test(head) && Number(head) <= Number(c.printRun);
}
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  console.log("catalog gap work-list — from sales actually blocked on the catalog\n");

  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status = 'awaiting-catalog'
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''
            GROUP BY c.hobbyiqCardId`,
  }).fetchAll();

  const bySet = new Map();
  const excluded = { artifact: 0, unknownSet: 0, unparsable: 0 };
  let total = 0;
  for (const r of resources) {
    const n = Number(r.n ?? 0); total += n;
    const c = parse(r.slug);
    if (!c) { excluded.unparsable += n; continue; }
    if (isParserArtifact(c)) { excluded.artifact += n; continue; }
    if (!c.setKey || c.setKey === "unknown") { excluded.unknownSet += n; continue; }
    const key = `${c.vertical}:${c.year}:${c.setKey}`;
    const e = bySet.get(key) ?? { sales: 0, slugs: 0, vertical: c.vertical, year: c.year, setKey: c.setKey };
    e.sales += n; e.slugs++;
    bySet.set(key, e);
  }

  const actionable = [...bySet.values()].reduce((s, e) => s + e.sales, 0);
  console.log(`blocked sales total        : ${total.toLocaleString()}`);
  console.log(`  parser artifacts (#1035) : ${excluded.artifact.toLocaleString()}  <- NOT catalog work; slug can never match`);
  console.log(`  setKey unresolved        : ${excluded.unknownSet.toLocaleString()}  <- NOT catalog work; parse failure`);
  console.log(`  unparsable slug          : ${excluded.unparsable.toLocaleString()}`);
  console.log(`  genuinely catalog-blocked: ${actionable.toLocaleString()}\n`);

  // Check each candidate against the catalog, biggest first.
  const cands = [...bySet.values()].filter((e) => e.sales >= MIN_SALES).sort((a, b) => b.sales - a.sales).slice(0, TOP * 3);
  await mapLimit(cands, CONCURRENCY, async (e) => {
    try {
      const { resources: c } = await catalog.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.sport=@v AND c.year=@y AND c.setKey=@s`,
        parameters: [
          { name: "@v", value: e.vertical }, { name: "@y", value: e.year }, { name: "@s", value: e.setKey },
        ],
      }).fetchAll();
      e.catalogRows = c[0] ?? 0;
    } catch { e.catalogRows = -1; }
  });

  const absent = cands.filter((e) => e.catalogRows === 0).slice(0, TOP);
  const incomplete = cands.filter((e) => e.catalogRows > 0).slice(0, TOP);

  console.log("=".repeat(72));
  console.log("ABSENT — no catalog rows at all. These need a checklist INGESTED.");
  console.log("=".repeat(72));
  console.log(`${"sales".padStart(7)}  ${"cards".padStart(6)}  set`);
  for (const e of absent) {
    console.log(`${String(e.sales).padStart(7)}  ${String(e.slugs).padStart(6)}  ${e.vertical} ${e.year} ${e.setKey}`);
  }
  if (!absent.length) console.log("  (none in the top candidates — every blocked set already has catalog rows)");

  console.log("\n" + "=".repeat(72));
  console.log("INCOMPLETE — set IS in the catalog; specific cards/parallels missing.");
  console.log("Extend the existing checklist; do NOT re-ingest the set.");
  console.log("=".repeat(72));
  console.log(`${"sales".padStart(7)}  ${"cards".padStart(6)}  ${"in catalog".padStart(10)}  set`);
  for (const e of incomplete) {
    console.log(`${String(e.sales).padStart(7)}  ${String(e.slugs).padStart(6)}  ${String(e.catalogRows).padStart(10)}  ${e.vertical} ${e.year} ${e.setKey}`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
