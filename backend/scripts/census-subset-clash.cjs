#!/usr/bin/env node
/**
 * census-subset-clash.cjs -- READ ONLY. How many (product, cardNumber, rung)
 * clash sets exist in card_catalog today, and how many sold_comps rows sit on
 * the plain ids those clashes would move.
 *
 * A CLASH SET is one (sport, year, setKey, cardNumber, parallelSlug, isAuto,
 * printRun) -- everything the identity slug carries -- held by MORE THAN ONE
 * named subset. Those cards, and only those, take a subset segment under
 * CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE.
 *
 * WHY THE QUERY IS SHAPED THIS WAY. GROUP BY over card_catalog does not
 * return -- measured 2026-09-04, `GROUP BY c.subsetName` scoped to ONE product
 * ran past 200s with zero rows. A RANGE predicate on subsetName is
 * index-served and returns the whole subset-bearing population in ~70s /
 * 48.5k RU, so the grouping is done client-side on the rows that come back.
 * Same shape as census-split-identity: indexed server-side, compare in
 * process.
 *
 * Env: COSMOS_CONNECTION_STRING (required), TOP (default 20), OUT
 */
const fs = require("node:fs");
const { CosmosClient } = require("@azure/cosmos");

const TOP = Number(process.env.TOP || 20);
const OUT = process.env.OUT || "";
const f = (n) => Number(n).toLocaleString();

const db = () => new CosmosClient({
  connectionString: process.env.COSMOS_CONNECTION_STRING,
  connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
}).database("hobbyiq");

async function drain(container, sql, label) {
  const t0 = Date.now();
  const it = container.items.query(sql, { maxItemCount: 5000 });
  const out = []; let ru = 0;
  while (it.hasMoreResults()) {
    const r = await it.fetchNext();
    ru += r.requestCharge || 0;
    out.push(...(r.resources || []));
  }
  console.log(`  ${label}: ${f(out.length)} rows in ${((Date.now()-t0)/1000).toFixed(1)}s, ${f(Math.round(ru))} RU`);
  return out;
}

(async () => {
  const database = db();
  const catalog = database.container("card_catalog");
  const comps = database.container("sold_comps");

  console.log("== CENSUS: subset clash sets in card_catalog ==\n");

  // Everything the identity slug carries, plus the subset. A row whose
  // subsetName is blank/absent states no subset, and a blank is UNKNOWN --
  // never a subset name, so it can neither create nor join a clash set.
  const rows = await drain(catalog,
    "SELECT c.sport, c.year, c.setKey, c.cardNumber, c.parallelSlug, c.isAuto, c.printRun, c.subsetName, c.id, c.source FROM c WHERE c.subsetName > ''",
    "subset-bearing catalog rows");

  // rung key = the whole identity slug MINUS the subset.
  const rung = new Map();      // rungKey -> Map<subsetName, {n, ids:[]}>
  const productOf = new Map(); // rungKey -> "sport|year|setKey"
  for (const r of rows) {
    const sub = String(r.subsetName || "").trim();
    if (!sub) continue;
    const prod = `${r.sport}|${r.year}|${r.setKey}`;
    const k = `${prod}|${String(r.cardNumber||"").toLowerCase()}|${r.parallelSlug||""}|${r.isAuto?1:0}|${r.printRun??""}`;
    if (!rung.has(k)) { rung.set(k, new Map()); productOf.set(k, prod); }
    const m = rung.get(k);
    if (!m.has(sub)) m.set(sub, { n: 0, ids: [] });
    const e = m.get(sub); e.n++; if (e.ids.length < 3) e.ids.push(r.id);
  }

  const clashes = [...rung.entries()].filter(([, m]) => m.size > 1);
  console.log(`\n  distinct rungs carrying a subset   ${f(rung.size)}`);
  console.log(`  CLASH SETS (rung under >1 subset)  ${f(clashes.length)}`);

  // Per product.
  const byProduct = new Map();
  for (const [k, m] of clashes) {
    const p = productOf.get(k);
    if (!byProduct.has(p)) byProduct.set(p, { clashSets: 0, subsets: new Set(), rows: 0, slugs: new Set(), examples: [] });
    const g = byProduct.get(p);
    g.clashSets++;
    let n = 0;
    for (const [s, e] of m) { g.subsets.add(s); n += e.n; for (const id of e.ids) g.slugs.add(id); }
    g.rows += n;
    if (g.examples.length < 3) {
      g.examples.push({ rung: k.split("|").slice(3).join("|"), subsets: [...m.keys()] });
    }
  }
  const top = [...byProduct.entries()].sort((a, b) => b[1].clashSets - a[1].clashSets).slice(0, TOP);
  console.log(`  products holding a clash set      ${f(byProduct.size)}\n`);
  console.log(`  TOP ${TOP} PRODUCTS BY CLASH SETS`);
  for (const [p, g] of top) {
    console.log(`    ${p.padEnd(46)} clashSets=${String(g.clashSets).padStart(5)}  subsets=${String(g.subsets.size).padStart(3)}  catalogRows=${String(g.rows).padStart(6)}`);
    for (const ex of g.examples) console.log(`        e.g. ${ex.rung}  ->  ${ex.subsets.map((s)=>JSON.stringify(s)).join(" | ")}`);
  }

  // POOL ROWS AFFECTED. The plain (subsetless) id for every clashing rung is
  // exactly the id those catalog rows already carry, so the affected sale rows
  // are the sold_comps rows keyed to those slugs. Counted by point-scoped
  // query on cardId -- the partition key -- in batches.
  const slugs = new Set();
  for (const [, m] of clashes) for (const [, e] of m) for (const id of e.ids) slugs.add(id);
  const slugList = [...slugs];
  console.log(`\n  distinct catalog slugs in a clash  ${f(slugList.length)}`);
  console.log(`  counting sold_comps rows on those slugs...`);
  let poolRows = 0; let scanned = 0;
  const B = 200;
  for (let i = 0; i < slugList.length; i += B) {
    const batch = slugList.slice(i, i + B);
    const params = batch.map((s, j) => ({ name: `@s${j}`, value: s }));
    const sql = {
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.cardId IN (${params.map((p) => p.name).join(",")})`,
      parameters: params,
    };
    const r = await comps.items.query(sql, { maxItemCount: -1 }).fetchAll();
    poolRows += Number(r.resources?.[0] ?? 0);
    scanned += batch.length;
    if (scanned % 1000 === 0) console.log(`    ...${f(scanned)}/${f(slugList.length)} slugs, ${f(poolRows)} rows`);
  }
  console.log(`\n  POOL ROWS ON PLAIN IDS THAT WOULD NEED A SUBSET  ${f(poolRows)}`);

  const census = {
    generatedAt: new Date().toISOString(),
    subsetBearingCatalogRows: rows.length,
    distinctRungsWithSubset: rung.size,
    clashSets: clashes.length,
    productsWithAClash: byProduct.size,
    distinctSlugsInAClash: slugList.length,
    poolRowsAffected: poolRows,
    top: top.map(([p, g]) => ({
      product: p, clashSets: g.clashSets, subsets: g.subsets.size,
      catalogRows: g.rows, examples: g.examples,
    })),
  };
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(census, null, 1)); console.log(`\n  wrote ${OUT}`); }
  console.log("\nCENSUS_JSON " + JSON.stringify({ clashSets: census.clashSets, products: census.productsWithAClash, poolRowsAffected: census.poolRowsAffected }));
})().catch((e) => { console.error("CENSUS FAILED:", e.message); process.exit(1); });
