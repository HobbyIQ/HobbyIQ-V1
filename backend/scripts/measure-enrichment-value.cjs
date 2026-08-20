#!/usr/bin/env node
/**
 * CF-ENRICHMENT-VALUE (Drew, 2026-08-20: "will match cards better?").
 *
 * Answers the ONLY question that makes the 6,290 number worth anything:
 * how many real comps would newly resolve to a specific parallel if we adopted
 * the scraped ladders for sets we already own?
 *
 * READ-ONLY.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The reconcile found 6,290 scraped parallels (70%) belonging to sets the
 * catalog HOLDS but carries no parallels for. That is a count of PARALLELS, not
 * of value. A parallel on a set nobody trades improves nothing, and today has
 * already produced three counts that looked like wins and were not:
 *
 *   851 FILLABLE   -> 13, once both print-run keys were read
 *   53.6% unmatched -> an artifact of keying without sport
 *   a 70% bucket    -> computed but never printed, so the report summed to 30%
 *
 * So the claim "this will match cards better" gets measured before it gets
 * believed.
 *
 * ── WHAT COUNTS AS A WIN ────────────────────────────────────────────────────
 *
 * A comp is a CANDIDATE if all three hold:
 *   1. it belongs to a set we hold and carry no parallels for
 *   2. its slug currently says `base` — it resolved to no parallel
 *   3. its TITLE contains one of the scraped parallel names for that set
 *
 * Then adding that ladder would let the comp resolve to (card, parallel)
 * instead of collapsing into the base pool — which is exactly the confusion
 * that put a /499 and a /10 in one series.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * A title match is EVIDENCE, not proof. Matching is longest-name-first and
 * WORD-BOUNDARIED: "Gold Refractor" beats "Gold" on the same title, and "Gold"
 * no longer fires inside "GOLDEN ANNIVERSARY REPRINT" or "marigold" — the same
 * false-positive class as `lot` matching "Charlotte". Names are regex-escaped
 * first, because real parallels carry metacharacters ("Green & Gold",
 * "X-Fractor").
 *
 * Even so the result is a CANDIDATE count, deliberately labelled as such. It is
 * an upper bound on the win, not the win.
 *
 * Reported separately, because they are different facts and different work:
 *   CANDIDATE      base-slugged comp whose title names a scraped parallel
 *                  -> ENRICH: adopt the ladder and this comp resolves
 *   ALREADY-PAR    comp already carrying a parallel — no change available
 *   GAP SIGNAL     title names a parallel or serial our ladder LACKS
 *                  -> ACQUIRE: a checklist gap with a completed sale behind it
 *   NO-TITLE-MATCH base-slugged and genuinely looks like a base card
 *
 * GAP SIGNAL exists because Drew asked "shouldn't the no match be a good place
 * to get better checklist data?" — and he was right. Filing those as "probably
 * base" discarded the most demand-weighted acquisition signal we have: real
 * money changed hands on a card our checklist cannot describe. They are ranked
 * by SALES DOLLARS, not row count, so the list is ordered by what the market
 * actually cares about.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/measure-enrichment-value.cjs \
 *     [--in=C:/tmp/ci-final.jsonl] [--top=25]
 */

const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { normalizeSetKey, normalizeParallel } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const IN = arg("in", "C:/tmp/ci-final.jsonl");
const TOP = Number(arg("top", "25"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e && e.code !== 429 && e.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, ((e && e.retryAfterInMs) || 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

function setKeyFromSlug(slug, yearPrefix, sport) {
  let s = String(slug);
  if (yearPrefix) s = s.slice(String(yearPrefix).length).replace(/^-/, "");
  if (sport) s = s.replace(new RegExp(`-${sport}$`), "");
  return normalizeSetKey(s.replace(/-/g, " "));
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  if (!fs.existsSync(IN)) { console.error(`FATAL: staging file not found: ${IN}`); process.exit(1); }

  // ── 1. Scraped ladders per (sport, year, setKey). ───────────────────────
  const ladders = new Map();   // key -> [{ name, lower, printRun }]
  for (const line of fs.readFileSync(IN, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.isStub) continue;
    const setKey = setKeyFromSlug(r.slug, r.yearPrefix, r.sport);
    if (!setKey) continue;
    const k = `${r.sport}|${r.year}|${setKey}`;
    const seen = new Set();
    const list = ladders.get(k) || [];
    for (const p of r.parallels || []) {
      const ps = normalizeParallel(p.parallel);
      if (!ps || seen.has(ps)) continue;
      seen.add(ps);
      const lower = String(p.parallel).toLowerCase();
      // WORD BOUNDARIES, not substring. A plain `includes` matches "Gold"
      // inside "GOLDEN ANNIVERSARY REPRINT" — the same class of false positive
      // as `lot` matching "Charlotte". Escape first: parallel names carry
      // regex metacharacters ("Green & Gold", "Purple /25", "X-Fractor").
      const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      list.push({
        name: p.parallel,
        lower,
        re: new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i"),
        printRun: p.printRun,
      });
    }
    if (list.length) ladders.set(k, list);
  }
  // Longest name first, so "Gold Refractor" wins over "Gold" on the same title.
  for (const list of ladders.values()) list.sort((a, b) => b.lower.length - a.lower.length);
  console.log(`[enrichment-value] sets with a scraped ladder: ${ladders.size.toLocaleString()}`);

  // ── 2. Which of those sets do we hold WITHOUT any parallels? ────────────
  const held = new Set(), hasParallels = new Set();
  await scanAll("card_catalog", {
    query: `SELECT c.year, c.setKey, c.sport, c.parallels FROM c
             WHERE IS_DEFINED(c.setKey) AND IS_DEFINED(c.year) AND IS_DEFINED(c.sport)`,
    parameters: [],
  }, (r) => {
    const k = `${r.sport}|${r.year}|${r.setKey}`;
    if (!ladders.has(k)) return;
    held.add(k);
    if (Array.isArray(r.parallels) && r.parallels.length) hasParallels.add(k);
  }, "catalog");

  const enrichable = new Set([...held].filter((k) => !hasParallels.has(k)));
  console.log(`  of those, we HOLD              : ${held.size.toLocaleString()}`);
  console.log(`  ...and carry NO parallels      : ${enrichable.size.toLocaleString()}   <- the enrichable sets\n`);

  // ── 3. How many real comps would newly resolve? ─────────────────────────
  let inScope = 0, candidate = 0, alreadyPar = 0, noMatch = 0, gapSignal = 0;
  const byParallel = new Map(), examples = [], gaps = new Map(), gapEx = [];
  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId, c.title, c.price, c.playerName FROM c
             WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)`,
    parameters: [],
  }, (r) => {
    const p = String(r.hobbyiqCardId).split(":");
    if (p.length < 7) return;
    const [, sport, year, setKey, , parallel] = p;
    const k = `${sport}|${year}|${setKey}`;
    if (!enrichable.has(k)) return;
    inScope++;
    if (parallel && parallel !== "base") { alreadyPar++; return; }
    const t = String(r.title || "").toLowerCase();
    const known = ladders.get(k) || [];
    const hit = known.find((x) => x.lower.length >= 3 && x.re.test(t));
    if (!hit) {
      // CF-NO-MATCH-IS-A-SIGNAL (Drew, 2026-08-20: "shouldn't the no match be a
      // good place to get better checklist data?"). Yes — and treating this
      // bucket as "probably a base card" threw that away.
      //
      // A base-slugged comp whose TITLE names a parallel or a serial that our
      // scraped ladder does not contain is not a base card. It is a CHECKLIST
      // GAP with a completed sale behind it: real money changed hands on a card
      // our checklist cannot describe. That is the strongest acquisition signal
      // available, because it is demand-weighted rather than guessed — the same
      // logic as the provisional tier being a demand signal for which checklist
      // to build next.
      //
      // parseListingIdentity is reused rather than re-deriving a serial regex.
      // It already carries today's fixes: `PSA 9/10` is rejected as a grade
      // fraction, and `/2022` on 2022 Topps Gold is kept because that parallel
      // really is numbered to its year.
      let parsed = null;
      try { parsed = parseListingIdentity(String(r.title || "")); } catch { /* unparseable title is not a signal */ }
      const pName = parsed && parsed.parallel ? String(parsed.parallel) : null;
      const pRun = parsed && Number.isFinite(parsed.printRun) ? parsed.printRun : null;
      const pSlug = pName ? normalizeParallel(pName) : null;
      const nameUnknown = !!pSlug && pSlug !== "base" && !known.some((x) => normalizeParallel(x.name) === pSlug);
      const runUnknown = pRun != null && !known.some((x) => x.printRun === pRun);
      if (nameUnknown || runUnknown) {
        gapSignal++;
        const label = `${year} ${setKey} :: ${pName || "(unnamed)"}${pRun != null ? ` /${pRun}` : ""}`;
        const g = gaps.get(label) || { n: 0, usd: 0 };
        g.n++; g.usd += Number(r.price) || 0;
        gaps.set(label, g);
        if (gapEx.length < TOP) gapEx.push(`$${String(r.price).padEnd(8)} ${String(r.playerName || "?").slice(0, 20).padEnd(21)} -> MISSING ${pName || "?"}${pRun != null ? ` /${pRun}` : ""}\n        ${String(r.title || "").slice(0, 76)}`);
        return;
      }
      noMatch++;
      return;
    }
    candidate++;
    const key = `${year} ${setKey} :: ${hit.name}${hit.printRun ? ` /${hit.printRun}` : ""}`;
    byParallel.set(key, (byParallel.get(key) ?? 0) + 1);
    if (examples.length < TOP) {
      examples.push(`$${String(r.price).padEnd(8)} ${String(r.playerName || "?").slice(0, 20).padEnd(21)} -> ${hit.name}${hit.printRun ? ` /${hit.printRun}` : ""}\n        ${String(r.title || "").slice(0, 76)}\n        ${r.hobbyiqCardId}`);
    }
  }, "comps");

  const pc = (n) => `${((n / Math.max(inScope, 1)) * 100).toFixed(1)}%`;
  console.log(`comps in enrichable sets : ${inScope.toLocaleString()}\n`);
  console.log(`  CANDIDATE (base slug, title names a scraped parallel): ${candidate.toLocaleString()}  ${pc(candidate)}   <- the win, upper bound`);
  console.log(`  already carries a parallel                          : ${alreadyPar.toLocaleString()}  ${pc(alreadyPar)}   no change available`);
  console.log(`  base slug, no title match                           : ${noMatch.toLocaleString()}  ${pc(noMatch)}   genuinely looks like base\n`);

  console.log("top parallels by comps that would newly resolve:");
  for (const [k, n] of [...byParallel].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`   ${String(n).padStart(7)}  ${k}`);
  console.log("\nexamples:");
  for (const e of examples.slice(0, 8)) console.log(`   ${e}`);

  console.log("\nREAD-ONLY. CANDIDATE is an UPPER BOUND — a title match is evidence,");
  console.log("not proof. Read a sample before treating this as the value of enrichment.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
