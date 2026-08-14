#!/usr/bin/env node
// CF-CATALOG-SET-PROVENANCE (Drew, 2026-08-14: "what missing sets do we need in
// the catalog?").
//
// catalogGapWorkList splits blocked sets into ABSENT (no catalog rows) and
// INCOMPLETE (rows exist). That split is still too coarse, because "has rows"
// does not mean "has a checklist".
//
// ensureCatalogRow auto-seeds a minimal row with source="ingest-auto-seed"
// every time a comp is written. A set can therefore accumulate thousands of
// rows without anyone ever ingesting its checklist — the rows are a shadow of
// the sales we happened to see, not the product's card list. Such a set looks
// healthy by row count and is actually the WORST case: it can only ever match
// cards we have already sold, so every genuinely new card stays blocked.
//
// "2026 panini-prizm" is the case that prompted this: 974 catalog rows against
// 3,204 blocked sales, for a product that ships thousands of cards.
//
// The `source` field separates them:
//   ingest-auto-seed  -> a shadow of observed sales
//   checklist-*/scrape/bulk-build -> a real ingested checklist
//
//   node scripts/catalogSetProvenance.cjs --set baseball:2026:panini-prizm
//   node scripts/catalogSetProvenance.cjs --top-blocked 20

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SET = val("--set", "");
const TOP_BLOCKED = Number(val("--top-blocked", "0"));
const CONCURRENCY = Number(val("--concurrency", "8"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

async function provenance(vertical, year, setKey) {
  const { resources } = await catalog.items.query({
    query: `SELECT c.source AS src, COUNT(1) AS n FROM c
            WHERE c.sport=@v AND c.year=@y AND c.setKey=@s
            GROUP BY c.source`,
    parameters: [
      { name: "@v", value: vertical }, { name: "@y", value: Number(year) }, { name: "@s", value: setKey },
    ],
  }).fetchAll();
  const by = {};
  let total = 0;
  for (const r of resources) {
    const k = r.src ?? "(null)";
    by[k] = (by[k] ?? 0) + Number(r.n ?? 0);
    total += Number(r.n ?? 0);
  }
  return { by, total };
}

const isSeed = (s) => s === "ingest-auto-seed" || s === "(null)" || s === "sales-derived";

function verdict(by, total) {
  const seeded = Object.entries(by).filter(([k]) => isSeed(k)).reduce((n, [, v]) => n + v, 0);
  const real = total - seeded;
  const pct = total ? (100 * seeded / total) : 0;
  if (total === 0) return { label: "ABSENT — no rows", real, seeded, pct };
  if (real === 0) return { label: "NO CHECKLIST — every row is auto-seeded from sales", real, seeded, pct };
  if (pct >= 80) return { label: "MOSTLY SEEDED — checklist is thin or partial", real, seeded, pct };
  return { label: "has an ingested checklist", real, seeded, pct };
}

(async () => {
  let targets = [];
  if (SET) {
    const [v, y, s] = SET.split(":");
    targets = [{ vertical: v, year: Number(y), setKey: s, sales: null }];
  } else {
    const { resources } = await staging.items.query({
      query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
              WHERE c.status='awaiting-catalog' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              GROUP BY c.hobbyiqCardId`,
    }).fetchAll();
    const bySet = new Map();
    for (const r of resources) {
      const p = String(r.slug).split(":");
      if (p.length < 7 || !p[3] || p[3] === "unknown") continue;
      const k = `${p[1]}:${p[2]}:${p[3]}`;
      bySet.set(k, (bySet.get(k) ?? 0) + Number(r.n ?? 0));
    }
    targets = [...bySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_BLOCKED || 20)
      .map(([k, sales]) => { const [v, y, s] = k.split(":"); return { vertical: v, year: Number(y), setKey: s, sales }; });
  }

  console.log("catalog provenance — does this set actually have an ingested checklist?\n");
  console.log(`${"blocked".padStart(7)}  ${"rows".padStart(8)}  ${"real".padStart(7)}  ${"seeded".padStart(7)}  set / verdict`);

  let cursor = 0;
  const out = new Array(targets.length);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const i = cursor++; const t = targets[i];
      const { by, total } = await provenance(t.vertical, t.year, t.setKey);
      out[i] = { t, by, total, v: verdict(by, total) };
    }
  }));

  for (const o of out) {
    if (!o) continue;
    const { t, v, total } = o;
    console.log(`${String(t.sales ?? "-").padStart(7)}  ${String(total).padStart(8)}  ${String(v.real).padStart(7)}  ${String(v.seeded).padStart(7)}  ${t.vertical} ${t.year} ${t.setKey}`);
    console.log(`${" ".repeat(35)}${v.label}`);
    if (SET) {
      for (const [k, n] of Object.entries(o.by).sort((a, b) => b[1] - a[1])) {
        console.log(`${" ".repeat(37)}${String(n).padStart(9)}  source=${k}`);
      }
    }
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
