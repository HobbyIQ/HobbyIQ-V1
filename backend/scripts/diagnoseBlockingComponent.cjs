#!/usr/bin/env node
// CF-WHICH-COMPONENT-BLOCKS (Drew, 2026-08-14: "how can we fix the matching?").
//
// Matching is exact equality on a 7-part identity:
//
//   hiq:{vertical}:{year}:{setKey}:{cardNumber}:{parallel}:{auto}[:num-N]
//
// Every part must be right at the same time, and each is a separate fallible
// extraction from free-text seller titles. So the hit rate is the PRODUCT of
// seven accuracies, which is why fixing any one parser moved the number so
// little — #1035 was real and correct and barely dented the backlog.
//
// The useful question is therefore not "is the catalog missing cards" (it is
// not — every top blocked set has a real ingested checklist) but "WHICH
// component is wrong, per row". That is directly measurable: relax exactly one
// component and see whether a catalog match appears.
//
// A row that matches when `parallel` is dropped, and only then, was blocked by
// the parallel and nothing else. Relaxations are tested INDEPENDENTLY rather
// than cumulatively, so blame is attributed to one component instead of being
// smeared across whichever order they were removed in.
//
// Rows where no single relaxation helps are reported separately — those need
// two or more components fixed and are not addressable by any one project.
//
//   node scripts/diagnoseBlockingComponent.cjs --sample 300

const path = require("node:path");
const { CosmosClient } = require(path.join(__dirname, "..", "node_modules/@azure/cosmos"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(val("--sample", "300"));
const CONCURRENCY = Number(val("--concurrency", "12"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

function parseSlug(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  return {
    vertical: p[1], year: Number(p[2]), setKey: p[3],
    cardNumber: String(p[4] || "").toUpperCase(),
    parallelSlug: p[5], isAuto: p[6] === "auto",
  };
}

/** Count catalog rows matching the identity with `drop` omitted. */
async function hits(c, drop) {
  const where = [], params = [];
  const add = (name, field, value) => { where.push(`c.${field}=@${name}`); params.push({ name: `@${name}`, value }); };
  if (drop !== "vertical") add("v", "sport", c.vertical);
  if (drop !== "year") add("y", "year", c.year);
  if (drop !== "setKey") add("s", "setKey", c.setKey);
  if (drop !== "cardNumber") add("n", "cardNumber", c.cardNumber);
  if (drop !== "parallel") add("p", "parallelSlug", c.parallelSlug);
  if (drop !== "isAuto") add("a", "isAuto", c.isAuto);
  if (!where.length) return 0;
  try {
    const { resources } = await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${where.join(" AND ")}`,
      parameters: params,
    }).fetchAll();
    return resources[0] ?? 0;
  } catch { return 0; }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const COMPONENTS = ["cardNumber", "parallel", "isAuto", "setKey", "year", "vertical"];

(async () => {
  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status='awaiting-catalog' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
  }).fetchAll();
  resources.sort((a, b) => b.n - a.n);
  const step = Math.max(1, Math.floor(resources.length / SAMPLE));
  const picked = resources.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const totalSales = picked.reduce((s, r) => s + Number(r.n ?? 0), 0);

  console.log(`which identity component blocks the match?\n`);
  console.log(`distinct blocked slugs ${resources.length.toLocaleString()}, sampling ${picked.length} (${totalSales.toLocaleString()} sales)\n`);

  const blame = {}, blameSales = {};
  for (const k of COMPONENTS) { blame[k] = 0; blameSales[k] = 0; }
  let multi = 0, multiSales = 0, alreadyMatches = 0, none = 0, noneSales = 0;
  const examples = {};

  await mapLimit(picked, CONCURRENCY, async (r) => {
    const c = parseSlug(r.slug);
    const n = Number(r.n ?? 0);
    if (!c) { none++; noneSales += n; return; }

    // Sanity: the full identity should NOT match (that is why it is blocked).
    if (await hits(c, null) > 0) { alreadyMatches++; return; }

    const helps = [];
    for (const k of COMPONENTS) {
      if (await hits(c, k) > 0) helps.push(k);
    }
    if (helps.length === 1) {
      blame[helps[0]]++; blameSales[helps[0]] += n;
      (examples[helps[0]] ??= []).length < 4 && examples[helps[0]].push(`${String(n).padStart(4)}  ${r.slug}`);
    } else if (helps.length > 1) {
      // Ambiguous attribution — several single drops each work. Count once,
      // against the FIRST in priority order, but report the overlap honestly.
      multi++; multiSales += n;
    } else { none++; noneSales += n; }
  });

  const pct = (x) => `${(100 * x / Math.max(picked.length, 1)).toFixed(1)}%`;
  const spct = (x) => `${(100 * x / Math.max(totalSales, 1)).toFixed(1)}%`;

  console.log("BLOCKED BY EXACTLY ONE COMPONENT — fixing that field alone unblocks the row:");
  for (const k of COMPONENTS) {
    if (!blame[k]) continue;
    console.log(`  ${k.padEnd(11)} ${String(blame[k]).padStart(4)} slugs (${pct(blame[k])})   ${String(blameSales[k]).padStart(6)} sales (${spct(blameSales[k])})`);
  }
  console.log(`\n  several drops each work (attribution ambiguous): ${multi} slugs (${pct(multi)}), ${multiSales.toLocaleString()} sales`);
  console.log(`  NO single drop helps — needs 2+ fields fixed   : ${none} slugs (${pct(none)}), ${noneSales.toLocaleString()} sales`);
  if (alreadyMatches) console.log(`  full identity DOES match (stale awaiting-catalog): ${alreadyMatches} slugs  <- requeue would clear these`);

  for (const k of COMPONENTS) {
    if (!examples[k]?.length) continue;
    console.log(`\n${k} — examples:`);
    for (const e of examples[k]) console.log(`  ${e}`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
