#!/usr/bin/env node
/**
 * CF-LEARN-THE-LADDER (Drew, 2026-08-28: "keep going with the parallel vocab
 * and learn how the model should work based off checklists").
 *
 * READ ONLY against prod. Learns the parallel model FROM the checklist rows now
 * in the catalog, then measures how well each candidate resolution rule maps
 * sales-derived parallels onto that model. The output is evidence for a mapping
 * pass, not the mapping pass itself.
 *
 * THE MODEL BEING TESTED. A parallel is not a global vocabulary word; it is a
 * RUNG on a specific product's ladder:
 *
 *     product (year, setKey)
 *       └─ ladder: [ {name, printRun} ... ]     <- from checklist rows only
 *
 * and resolving a sale's noisy parallel text means finding ITS product's rung,
 * never pattern-matching against every parallel that exists anywhere. The
 * rules doctrine encodes why: "Colour ≡ Refractor" is safe per-card and
 * catastrophic product-wide (Panini Prizm has bare colours that are NOT
 * refractors), and no-synthetic-parallels means an unresolvable name stays
 * unresolved rather than minting a rung the checklist does not carry.
 *
 * RULE CASCADE measured, strictest first, first hit wins:
 *
 *   R1 exact        slugify(text) === slugify(rung)
 *   R2 squash       hyphen/space-insensitive ("X Fractor" ≡ "X-Fractor")
 *   R3 deglue       strip ": N Copies" / trailing "/N" noise, then R1-R2
 *   R4 long-form    text + "refractor"/"prizm"/... equals EXACTLY ONE rung
 *                   ("Gold" -> "Gold Refractor"); ambiguity = no match
 *   R5 unresolved   counted, sampled, and grouped for acquisition or ruling
 *
 * Also decomposes every checklist rung into MODIFIER x FAMILY to report the
 * grammar the hobby actually uses, and writes the learned ladders to
 * backend/data/checklist-ladders.json -- deliberately NOT parallel-vocabulary
 * .json, which is hand-curated and load-bearing in the slug generator.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SPORT=baseball  TOP=40    products to learn, by derived-row count
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const SPORT = process.env.SPORT || "baseball";
const TOP = Number(process.env.TOP || 40);
const OUT = path.join(backend, "data", "checklist-ladders.json");
const f = (n) => Number(n).toLocaleString();
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "-");

const slug = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const squash = (s) => slug(s).replace(/-/g, "");
const deglue = (s) => String(s ?? "")
  .replace(/:\s*[\d,]+\s*cop(y|ies)\b.*$/i, "")
  .replace(/\s*\/\s*[\d,]+\s*$/, "")
  .replace(/\s*\(\s*[\d,]+\s*cop(y|ies)?\s*\)\s*$/i, "")
  .trim();

/** Families seen at the END of a rung name; the remainder is the modifier. */
const FAMILIES = [
  "refractor", "x-fractor", "prizm", "shimmer", "lava", "wave", "holo",
  "foilboard", "foil", "sapphire", "chrome", "ice", "mojo", "velocity",
  "pulsar", "disco", "cracked-ice", "camo", "snakeskin", "pattern", "paper",
];

function decompose(rungSlug) {
  for (const fam of FAMILIES.sort((a, b) => b.length - a.length)) {
    if (rungSlug === fam) return { modifier: null, family: fam };
    if (rungSlug.endsWith("-" + fam)) return { modifier: rungSlug.slice(0, -(fam.length + 1)), family: fam };
  }
  return { modifier: rungSlug, family: null };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");
  const retry = async (fn, t = 8) => { for (let a = 0; ; a++) { try { return await fn(); } catch (e) { if (a >= t) throw e; await new Promise((r) => setTimeout(r, 2000 * (a + 1))); } } };

  // Products worth learning: where the derived rows (the rows to be mapped) live.
  const { resources: prods } = await retry(() => cat.items.query({
    query: `SELECT c.year, c.setKey, COUNT(1) AS n FROM c
            WHERE c.sport=@s AND (c.source='ingest-auto-seed' OR STARTSWITH(c.source,'catalog-explode') OR STARTSWITH(c.source,'sold-comps-stub'))
            GROUP BY c.year, c.setKey`,
    parameters: [{ name: "@s", value: SPORT }],
  }).fetchAll());
  const top = prods.filter((p) => p.year && p.setKey).sort((a, b) => b.n - a.n).slice(0, TOP);
  console.log(`learning from the ${top.length} products holding the most derived rows (${SPORT})\n`);

  const ladders = {};
  const famTally = new Map(), modTally = new Map();
  const ruleHits = { R1_exact: 0, R2_squash: 0, R3_deglue: 0, R4_longform: 0, R4_ambiguous: 0, R5_unresolved: 0 };
  let derivedChecked = 0, productsWithLadder = 0, runsOnRungs = 0, rungCount = 0;
  const unresolvedTally = new Map();

  for (const p of top) {
    // the ladder: checklist rows only, with print runs
    const { resources: rows } = await retry(() => cat.items.query({
      // The ladder is gathered from the SET FAMILY, not the bare key. Confetti
      // and Sandglitter checklist rows live under topps-series-1/2 while the
      // derived rows sit under bare topps -- the same scoping blind spot that
      // once called 2024 Topps 86.8% unconfirmed. Derived rows stay exact-key:
      // widening the QUERY side would blur which product a spelling belongs to.
      query: `SELECT c.parallel, c.setKey, c.source, COUNT(1) AS n FROM c WHERE c.sport=@s AND c.year=@y AND (c.setKey=@k OR STARTSWITH(c.setKey, @ks) OR STARTSWITH(c.setKey, @ku)) GROUP BY c.parallel, c.setKey, c.source`,
      parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }, { name: "@ks", value: p.setKey + "-series" }, { name: "@ku", value: p.setKey + "-update" }],
    }).fetchAll());
    const rungs = new Map();  // slug -> {name, runs:Set, n}
    const derived = [];
    for (const r of rows) {
      const isChecklist = catalogAuthorityOf(r.source) === "checklist";
      // A derived row from a SIBLING setKey is not this product's spelling.
      if (!isChecklist && r.setKey !== p.setKey) continue;
      const name = deglue(r.parallel);
      if (!name) continue;
      if (isChecklist) {
        const k = slug(name);
        if (!k) continue;
        if (!rungs.has(k)) rungs.set(k, { name, runs: new Set(), n: 0 });
        const g = rungs.get(k);
        g.n += r.n || 1;
      } else if (catalogAuthorityOf(r.source) === "derived") {
        for (let x = 0; x < (r.n || 1); x++) derived.push(name);
      }
    }
    // print runs, second aggregate: MAX cannot digest nulls, so numbered rows only
    const { resources: runRows } = await retry(() => cat.items.query({
      query: `SELECT c.parallel, MAX(c.printRun) AS run FROM c WHERE c.sport=@s AND c.year=@y AND (c.setKey=@k OR STARTSWITH(c.setKey, @ks) OR STARTSWITH(c.setKey, @ku)) AND IS_NUMBER(c.printRun) AND c.printRun > 0 AND c.printRun <= 100000 GROUP BY c.parallel`,
      parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }, { name: "@ks", value: p.setKey + "-series" }, { name: "@ku", value: p.setKey + "-update" }],
    }).fetchAll());
    for (const r of runRows) { const k = slug(deglue(r.parallel)); if (rungs.has(k)) rungs.get(k).runs.add(r.run); }

    if (!rungs.size) continue;
    productsWithLadder++;
    rungCount += rungs.size;

    const squashIndex = new Map();
    for (const [k] of rungs) squashIndex.set(k.replace(/-/g, ""), k);

    for (const [k, g] of rungs) {
      if (g.runs.size) runsOnRungs++;
      const d = decompose(k);
      if (d.family) famTally.set(d.family, (famTally.get(d.family) ?? 0) + 1);
      if (d.modifier) modTally.set(d.modifier, (modTally.get(d.modifier) ?? 0) + 1);
    }
    ladders[`${p.year}|${p.setKey}`] = [...rungs.entries()].map(([k, g]) => ({
      slug: k, name: g.name, printRuns: [...g.runs].sort((a, b) => a - b), checklistRows: g.n,
    })).sort((a, b) => b.checklistRows - a.checklistRows);

    // measure the cascade on this product's own derived spellings
    for (const text of derived) {
      derivedChecked++;
      const s0 = slug(text);
      if (rungs.has(s0)) { ruleHits.R1_exact++; continue; }
      const sq = squashIndex.get(s0.replace(/-/g, ""));
      if (sq) { ruleHits.R2_squash++; continue; }
      const s1 = slug(deglue(text));
      if (s1 !== s0 && (rungs.has(s1) || squashIndex.has(s1.replace(/-/g, "")))) { ruleHits.R3_deglue++; continue; }
      // long-form: text + family suffix hits exactly one rung
      const candidates = [...rungs.keys()].filter((k) => {
        const d = decompose(k);
        return d.modifier === s1 && d.family;
      });
      if (candidates.length === 1) { ruleHits.R4_longform++; continue; }
      if (candidates.length > 1) { ruleHits.R4_ambiguous++; continue; }
      ruleHits.R5_unresolved++;
      unresolvedTally.set(s1, (unresolvedTally.get(s1) ?? 0) + 1);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ learnedAt: new Date().toISOString(), sport: SPORT, products: Object.keys(ladders).length, ladders }, null, 1));

  console.log(`THE MODEL, as the checklists teach it`);
  console.log(`  products with a checklist ladder   ${productsWithLadder} of ${top.length}`);
  console.log(`  rungs learned                      ${f(rungCount)}   (${pct(runsOnRungs, rungCount)} carry a print run)`);
  console.log(`  written to                         ${path.relative(backend, OUT)}`);
  console.log(`\n  rung grammar = [modifier] x [family]; top families:`);
  console.log(`    ${[...famTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}(${v})`).join("  ")}`);
  console.log(`  top modifiers:`);
  console.log(`    ${[...modTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`).join("  ")}`);
  console.log(`\nRESOLUTION — ${f(derivedChecked)} derived spellings vs their OWN product's ladder`);
  for (const [k, v] of Object.entries(ruleHits)) console.log(`  ${k.padEnd(14)} ${String(f(v)).padStart(8)}   ${pct(v, derivedChecked)}`);
  const resolved = ruleHits.R1_exact + ruleHits.R2_squash + ruleHits.R3_deglue + ruleHits.R4_longform;
  console.log(`  ${"RESOLVABLE".padEnd(14)} ${String(f(resolved)).padStart(8)}   ${pct(resolved, derivedChecked)}`);
  console.log(`\n  top unresolved spellings — a rung we lack, or a name to rule on:`);
  for (const [k, v] of [...unresolvedTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`    ${String(f(v)).padStart(6)}  ${k}`);
  }
}

module.exports = { decompose, deglue, FAMILIES };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
