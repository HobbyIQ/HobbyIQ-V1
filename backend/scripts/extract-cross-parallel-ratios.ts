#!/usr/bin/env -S npx tsx
/**
 * CF-CROSS-PARALLEL-RATIOS (Drew, 2026-08-06).
 *
 * Extracts pairwise finish-to-finish ratios from the pool. For every
 * card (fingerprint = playerName + year + cardNumber + isAuto), collect
 * per-parallel medians. For every pair of parallels A/B that co-exist
 * on any card, compute ratio(A/B). Aggregate ratios ACROSS ALL CARDS
 * → global median ratio per (parallel A, parallel B).
 *
 * This is the "translation table" that lets us estimate Orange
 * Refractor from Orange Shimmer sales, or ANY parallel from ANY
 * sibling parallel, when the target has no direct comps.
 *
 * Also decomposes to (colorFamily, finishFamily) axes and computes
 * cross-color ratios within same finish + cross-finish ratios within
 * same color. Sparse full-parallel cells fall through to the axis
 * decomposition.
 *
 * Output: data/cross-parallel-ratios.json
 *
 * Env:
 *   RATIOS_APPLY   ignored (script is always read-only + writes local file)
 *   RATIOS_MIN_N   min sample pairs per ratio; default 5
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import * as fs from "node:fs";
import * as path from "node:path";

const MIN_N = Number(process.env.RATIOS_MIN_N ?? 5);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

interface Row {
  playerName: string;
  cardYear: number;
  cardNumber: string;
  isAuto: boolean;
  parallel: string;
  parallelSlug?: string;
  price: number;
}

// ---- Color and finish family decomposition ---------------------------------

const COLOR_FAMILIES: Array<{ name: string; pattern: RegExp }> = [
  { name: "red",         pattern: /\b(red|ruby|crimson)\b/i },
  { name: "orange",      pattern: /\b(orange|amber|tangerine)\b/i },
  { name: "yellow",      pattern: /\b(yellow|canary)\b/i },
  { name: "gold",        pattern: /\b(gold|golden)\b/i },
  { name: "green",       pattern: /\b(green|emerald|forest|mint|jade)\b/i },
  { name: "aqua",        pattern: /\b(aqua|teal|turquoise|cyan)\b/i },
  { name: "blue",        pattern: /\b(blue|sapphire|navy)\b/i },
  { name: "purple",      pattern: /\b(purple|violet|amethyst|lavender)\b/i },
  { name: "pink",        pattern: /\b(pink|magenta|rose|fuchsia)\b/i },
  { name: "black",       pattern: /\bblack\b/i },
  { name: "silver",      pattern: /\b(silver|platinum)\b/i },
  { name: "white",       pattern: /\bwhite\b/i },
  { name: "rainbow",     pattern: /\brainbow\b/i },
  { name: "none",        pattern: /^$/ },
];

const FINISH_FAMILIES: Array<{ name: string; pattern: RegExp }> = [
  { name: "shimmer",     pattern: /\bshimmer\b/i },
  { name: "ray-wave",    pattern: /\b(ray\s*wave|raywave)\b/i },
  { name: "wave",        pattern: /\bwave\b/i },
  { name: "lava",        pattern: /\blava\b/i },
  { name: "lunar",       pattern: /\blunar\b/i },
  { name: "prism",       pattern: /\bprism\b/i },
  { name: "lazer",       pattern: /\b(lazer|laser)\b/i },
  { name: "sapphire",    pattern: /\bsapphire\b/i },
  { name: "geometric",   pattern: /\bgeometric\b/i },
  { name: "sparkle",     pattern: /\bsparkle\b/i },
  { name: "speckle",     pattern: /\bspeckle\b/i },
  { name: "mini-diamond",pattern: /\bmini[-\s]?diamond\b/i },
  { name: "x-fractor",   pattern: /\bx[-\s]?fractor\b/i },
  { name: "superfractor",pattern: /\bsuperfractor\b/i },
  { name: "logofractor", pattern: /\blogo(?:\s+refractor|fractor)\b/i },
  { name: "refractor",   pattern: /\brefractor\b/i },
  { name: "base",        pattern: /^base$/i },
  { name: "none",        pattern: /^$/ },
];

function classifyColor(parallel: string): string {
  const s = parallel.toLowerCase().trim();
  for (const c of COLOR_FAMILIES) if (c.pattern.test(s)) return c.name;
  return "none";
}
function classifyFinish(parallel: string): string {
  const s = parallel.toLowerCase().trim();
  for (const f of FINISH_FAMILIES) if (f.pattern.test(s)) return f.name;
  return "none";
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[Math.floor(s.length / 2)];
}

async function main(): Promise<void> {
  console.log(`▸ Cross-parallel ratio extraction`);
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();

  // Pull every row's (fingerprint components + parallel + price) in the last 180d
  const it = sc.items.query<Row>({
    query: `SELECT c.playerName, c.cardYear, c.cardNumber, c.isAuto, c.parallel, c.parallelSlug, c.price
            FROM c WHERE IS_DEFINED(c.playerName) AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.cardNumber)
              AND IS_DEFINED(c.parallel) AND c.parallel != null
              AND c.soldAt >= @cut AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
              AND (c.gradeCompany = null OR NOT IS_DEFINED(c.gradeCompany))`,
    parameters: [{ name: "@cut", value: cutoff }],
  }, { maxItemCount: 500 });

  // Group by (fingerprint minus parallel) → parallel → prices[]
  interface CardBucket { byParallel: Map<string, number[]> }
  const cards = new Map<string, CardBucket>();

  let scanned = 0;
  const startedAt = Date.now();
  while (it.hasMoreResults()) {
    let batch: Row[] = [];
    try {
      const { resources } = await it.fetchNext();
      batch = resources;
    } catch (e) { console.error(`  ! fetchNext: ${(e as Error).message}`); continue; }
    for (const r of batch) {
      scanned++;
      const fp = `${String(r.playerName).toLowerCase()}|${r.cardYear}|${String(r.cardNumber).toLowerCase()}|${r.isAuto ? "auto" : "no-auto"}`;
      let bucket = cards.get(fp);
      if (!bucket) { bucket = { byParallel: new Map() }; cards.set(fp, bucket); }
      const par = String(r.parallel).trim();
      if (!par) continue;
      let arr = bucket.byParallel.get(par);
      if (!arr) { arr = []; bucket.byParallel.set(par, arr); }
      arr.push(r.price);
    }
    const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scan: ${scanned.toLocaleString()} rows, ${cards.size.toLocaleString()} fingerprints  ${Math.round(scanned / el)}/s\r`);
  }
  console.log(`\n\n▸ Scan complete: ${scanned.toLocaleString()} rows → ${cards.size.toLocaleString()} card fingerprints`);

  // For every fingerprint with 2+ parallels, compute pairwise ratios
  // (A/B), stash by (A, B) in a global bag.
  const pairRatios = new Map<string, number[]>();       // "parallelA__parallelB" → [ratio, ratio, ...]
  const colorFinishPairRatios = new Map<string, number[]>();  // "color:finish__color:finish" → ratios
  const finishOnlyPairRatios = new Map<string, number[]>();   // "finishA__finishB" (same color) → ratios
  const colorOnlyPairRatios = new Map<string, number[]>();    // "colorA__colorB" (same finish) → ratios

  for (const bucket of cards.values()) {
    if (bucket.byParallel.size < 2) continue;
    const perParallel = [...bucket.byParallel.entries()].map(([p, prices]) => ({
      parallel: p,
      color: classifyColor(p),
      finish: classifyFinish(p),
      median: median(prices),
      n: prices.length,
    })).filter((x) => x.median > 0);
    for (let i = 0; i < perParallel.length; i++) {
      for (let j = 0; j < perParallel.length; j++) {
        if (i === j) continue;
        const a = perParallel[i], b = perParallel[j];
        if (a.median <= 0 || b.median <= 0) continue;
        const ratio = a.median / b.median;
        if (!Number.isFinite(ratio) || ratio <= 0) continue;
        // Full-parallel pair
        const fullKey = `${a.parallel}__${b.parallel}`;
        (pairRatios.get(fullKey) ?? pairRatios.set(fullKey, []).get(fullKey))!.push(ratio);
        // Color:Finish pair
        const cfKey = `${a.color}:${a.finish}__${b.color}:${b.finish}`;
        (colorFinishPairRatios.get(cfKey) ?? colorFinishPairRatios.set(cfKey, []).get(cfKey))!.push(ratio);
        // Same-color, cross-finish
        if (a.color === b.color && a.color !== "none") {
          const fKey = `${a.color}|${a.finish}__${b.finish}`;
          (finishOnlyPairRatios.get(fKey) ?? finishOnlyPairRatios.set(fKey, []).get(fKey))!.push(ratio);
        }
        // Same-finish, cross-color
        if (a.finish === b.finish && a.finish !== "none") {
          const cKey = `${a.finish}|${a.color}__${b.color}`;
          (colorOnlyPairRatios.get(cKey) ?? colorOnlyPairRatios.set(cKey, []).get(cKey))!.push(ratio);
        }
      }
    }
  }

  // Aggregate → median ratio per pair, filter by min sample size
  const finalize = (m: Map<string, number[]>): Array<{ key: string; ratio: number; n: number; p25: number; p75: number }> => {
    const out: Array<{ key: string; ratio: number; n: number; p25: number; p75: number }> = [];
    for (const [k, ratios] of m) {
      if (ratios.length < MIN_N) continue;
      const s = [...ratios].sort((a, b) => a - b);
      out.push({
        key: k,
        ratio: Math.round(median(ratios) * 1000) / 1000,
        n: ratios.length,
        p25: Math.round(s[Math.floor(s.length * 0.25)] * 1000) / 1000,
        p75: Math.round(s[Math.floor(s.length * 0.75)] * 1000) / 1000,
      });
    }
    return out.sort((a, b) => b.n - a.n);
  };

  const fullPairs = finalize(pairRatios);
  const cfPairs = finalize(colorFinishPairRatios);
  const finishPairs = finalize(finishOnlyPairRatios);
  const colorPairs = finalize(colorOnlyPairRatios);

  console.log(`\n▸ Aggregated ratios (n>=${MIN_N})`);
  console.log(`  full-parallel pairs:         ${fullPairs.length.toLocaleString()}`);
  console.log(`  color+finish decomposed:     ${cfPairs.length.toLocaleString()}`);
  console.log(`  same-color cross-finish:     ${finishPairs.length.toLocaleString()}`);
  console.log(`  same-finish cross-color:     ${colorPairs.length.toLocaleString()}`);

  // Show sample: top 15 orange-family cross-finish ratios
  console.log(`\n▸ Sample: same-color CROSS-FINISH ratios (top 15 by n):`);
  for (const p of finishPairs.slice(0, 15)) {
    const [col, rest] = p.key.split("|");
    const [a, b] = rest.split("__");
    console.log(`  ${col}: ${a.padEnd(15)} / ${b.padEnd(15)} = ${p.ratio}× (n=${p.n}, p25=${p.p25}, p75=${p.p75})`);
  }

  console.log(`\n▸ Sample: same-finish CROSS-COLOR ratios (top 15 by n):`);
  for (const p of colorPairs.slice(0, 15)) {
    const [fin, rest] = p.key.split("|");
    const [a, b] = rest.split("__");
    console.log(`  ${fin}: ${a.padEnd(10)} / ${b.padEnd(10)} = ${p.ratio}× (n=${p.n}, p25=${p.p25}, p75=${p.p75})`);
  }

  // Save all four maps as JSON for the runtime lookup
  const out = {
    generatedAt: new Date().toISOString(),
    windowDays: 180,
    minN: MIN_N,
    fullPairs, cfPairs, finishPairs, colorPairs,
  };
  const outPath = path.resolve(process.cwd(), "data/cross-parallel-ratios.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n▸ Written to ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
