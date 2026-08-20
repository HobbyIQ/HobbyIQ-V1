#!/usr/bin/env node
/**
 * CF-SET-SPORT (Drew, 2026-08-20: "year product then name").
 *
 * Decides a comp's sport from the SET it belongs to — (year, setKey) — instead
 * of from the player's dominant sport.
 *
 * WHY THE PLAYER IS THE WRONG AUTHORITY. The player-dominance sweep is right for
 * clear cases and breaks on three shapes, all found in production:
 *
 *   TWO PEOPLE, DIFFERENT ERAS
 *     tony gonzalez  69.6% baseball (pre-1990, the MLB outfielder)
 *                    28.9% football (1990-2009, the NFL tight end)
 *
 *   TWO PEOPLE, SAME ERA — no era gate can separate these
 *     jim hart  "1968 Topps Baseball #73"  = Jim Ray Hart, MLB
 *               "1968 Topps Football #60"  = Jim Hart, NFL
 *
 *   ONE PERSON WITH GENUINE CARDS IN BOTH SPORTS
 *     jason kelce  "2025 Topps Series 1 JASON KELCE First Pitch FP-1 /99"
 *                  First Pitch is a real Topps BASEBALL insert. 460 correct rows
 *                  that a lowered dominance threshold would have corrupted.
 *
 * A SET, HOWEVER, HAS ONE SPORT. "2025 Topps Series 1" is baseball whoever is
 * pictured; "2025 Panini Revolution ... Browns" is football however the player
 * histogram votes. That is why Mariota and Sanders are contamination — their
 * SETS are football products — while Kelce is not.
 *
 * THE AUTHORITY IS THE CHECKLIST, NOT THE COMPS. A set's sport is read from
 * checklist-backed catalog rows via catalogAuthority. Reading it from the comps
 * would let contamination vote on its own correctness: a football card wrongly
 * filed under baseball would help prove the set is baseball.
 *
 * MULTI-SPORT PRODUCTS ARE REAL and must survive. Leaf and Panini ship
 * genuinely mixed sets, and Allen & Ginter carries non-sport subjects. So a set
 * is only used as an authority when its checklist is overwhelmingly ONE sport;
 * mixed sets are reported and skipped.
 *
 * NAME IS THE FALLBACK, NOT THE LEAD — the order Drew asked for: year, product,
 * then name. This script covers the first two. Rows in a set with no usable
 * checklist fall through to the existing player-dominance sweep.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-set-sport.cjs \
 *     [--minChecklist=20] [--dominance=0.95] [--top=25]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { canAdjudicate } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { buildAuthority, judgeComp } = require("./lib/setSportAuthority.cjs");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const MIN_CHECKLIST = Number(arg("minChecklist", "20"));
const DOMINANCE = Number(arg("dominance", "0.95"));
const TOP = Number(arg("top", "25"));
/** Absolute count of catalog rows in OTHER sports that makes a setKey a
 *  cross-sport franchise. Absolute, not a ratio - see the note in main(). */
const MIN_OTHER = Number(arg("minOther", "200"));
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
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
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

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[set-sport] minChecklist=${MIN_CHECKLIST} dominance=${DOMINANCE}\n`);

  // ── 1. What sport does the CHECKLIST say each (year, setKey) is? ─────────
  //
  // CORRECTED 2026-08-20 AFTER THIS AUDIT PRODUCED A WRONG ANSWER. The first
  // version ranked ONLY checklist-backed rows and required 0.95 dominance. That
  // is unsound, because dominance over a single-sport sample is always 1.0:
  //
  //   2024 panini-donruss
  //     ALL rows       baseball 5,503  football 19,130  basketball 4,031
  //     CHECKLIST rows football 3,993  ONLY
  //     -> dominance 1.0000, authority "football", gate PASSES
  //
  // We simply have no checklist for Donruss BASEBALL 2024; the product plainly
  // exists, with 5,503 catalog rows. Absence of checklist COVERAGE was being
  // read as absence of the PRODUCT, condemning every genuine baseball comp in
  // the set. Sampled titles of those "contradictions" said baseball 424,
  // soccer 32, football 0.
  //
  // So the two questions are separated, because they need different evidence:
  //
  //   IS THIS SET MULTI-SPORT?  asked of ALL catalog rows. A vendor row is weak
  //     evidence of what a card IS, but perfectly good evidence that the product
  //     EXISTS in that sport. Donruss, Topps Chrome, Prizm and Select are
  //     cross-sport franchises; a setKey does not name one sport.
  //
  //   IF SINGLE-SPORT, WHICH?   asked of checklist rows only, unchanged.
  const setAll = new Map();     // "year|setKey" -> Map(sport -> count)   ALL rows
  const setChecklist = new Map();
  await scanAll("card_catalog", {
    query: `SELECT c.year, c.setKey, c.sport, c.source FROM c
             WHERE IS_DEFINED(c.setKey) AND IS_DEFINED(c.sport) AND IS_DEFINED(c.year)`,
    parameters: [],
  }, (r) => {
    const k = `${r.year}|${r.setKey}`;
    let a = setAll.get(k);
    if (!a) setAll.set(k, (a = new Map()));
    a.set(r.sport, (a.get(r.sport) ?? 0) + 1);
    if (!canAdjudicate(r.source)) return;
    let m = setChecklist.get(k);
    if (!m) setChecklist.set(k, (m = new Map()));
    m.set(r.sport, (m.get(r.sport) ?? 0) + 1);
  }, "catalog");

  // GATES COME FROM THE SHARED MODULE, not a copy here. The repair applies
  // these same gates; if this file kept its own, "the dry run matches the
  // audit" would prove nothing about them agreeing — it would only prove two
  // copies had not drifted YET. See scripts/lib/setSportAuthority.cjs.
  const built = buildAuthority(setChecklist, setAll, {
    minOther: MIN_OTHER, minChecklist: MIN_CHECKLIST, dominance: DOMINANCE,
  });
  const authority = built.authority;
  const mixed = built.skipped.mixed;
  const thin = built.skipped.thin;
  const crossSport = built.skipped.crossSport;
  const mixedEx = built.examples;

  console.log(`(year, setKey) with a checklist : ${setChecklist.size.toLocaleString()}`);
  console.log(`  usable as authority           : ${authority.size.toLocaleString()}`);
  console.log(`  MIXED-sport products (skipped): ${mixed.toLocaleString()}`);
  console.log(`  CROSS-SPORT franchise (skipped): ${crossSport.toLocaleString()}   <- new gate, minOther=${MIN_OTHER}`);
  console.log(`  too thin (< ${MIN_CHECKLIST})              : ${thin.toLocaleString()}\n`);
  if (mixedEx.length) { console.log("mixed-sport examples (correctly left alone):"); for (const e of mixedEx) console.log(`   ${e}`); console.log(""); }

  // ── 2. Which comps contradict their own set? ─────────────────────────────
  const moves = new Map();
  const ex = [];
  let judged = 0, agree = 0, noAuthority = 0, contradict = 0, vetoed = 0, vetoedOther = 0;
  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId, c.playerName, c.title, c.price FROM c
             WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)`,
    parameters: [],
  }, (r) => {
    const p = String(r.hobbyiqCardId).split(":");
    if (p.length < 7) return;
    const [, sport, year, setKey] = p;
    if (!sport || !year || !setKey) return;
    judged++;
    // ONE decision function, shared with the repair.
    const v = judgeComp({ slugSport: sport, year, setKey, title: r.title }, authority);
    if (v.verdict === "no-authority") { noAuthority++; return; }
    if (v.verdict === "agree") { agree++; return; }
    if (v.verdict === "vetoed-title-backs-slug") { vetoed++; return; }
    if (v.verdict === "vetoed-title-backs-neither") { vetoedOther++; return; }
    contradict++;
    const k = `${v.from} -> ${v.to}`;
    moves.set(k, (moves.get(k) ?? 0) + 1);
    if (ex.length < TOP) ex.push(`$${String(r.price).padEnd(8)} ${String(r.playerName || "?").slice(0, 22).padEnd(23)} ${v.from} -> ${v.to}\n        ${String(r.title || "").slice(0, 76)}\n        ${r.hobbyiqCardId}`);
  }, "comps");

  const pc = (n) => `${((n / Math.max(judged, 1)) * 100).toFixed(2)}%`;
  console.log(`comps judged        : ${judged.toLocaleString()}`);
  console.log(`  agree with the set: ${agree.toLocaleString()}  ${pc(agree)}`);
  console.log(`  no set authority  : ${noAuthority.toLocaleString()}  ${pc(noAuthority)}`);
  console.log(`  CONTRADICT the set: ${contradict.toLocaleString()}  ${pc(contradict)}   <- the repair\n`);
  console.log("moves:");
  for (const [k, n] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`   ${String(n).padStart(8)}  ${k}`);
  console.log("\nexamples:");
  for (const e of ex.slice(0, 10)) console.log(`   ${e}`);
  console.log("\nREAD-ONLY. The set is the authority; a mixed-sport product is never one.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
