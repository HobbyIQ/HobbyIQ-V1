#!/usr/bin/env node
/**
 * DETAIL PASS for the 13 dead-edge census, READ ONLY.
 *
 * The first pass measured HOW MANY family titles state each specialization
 * word. This pass answers whether the word can be read UNAMBIGUOUSLY -- the
 * question that decides whether a parser rule may be written at all:
 *
 *   - PACIFIC OVERLAP. "1994 Pacific Crown Collection - Prisms" states both
 *     words, and "1995 Pacific Crown Collection Gold Crown Die-Cuts" states
 *     three. Co-occurrence decides rule ORDER, or refuses the rule.
 *   - SP. `sp` and `sp-championship` have family `unknown`, so there is no
 *     family pool to scan. This samples every title containing a bare SP token
 *     and classifies it: SP-the-brand (Upper Deck's line) vs SP-the-short-print
 *     vs neither.
 *   - FLEER YEARS. CF-THERE-IS-NO-FLEER-TIFFANY scopes the Tiffany/Glossy
 *     reading by year. This measures the year spread of the titles that state
 *     each word so a rule can be year-correct rather than year-blind.
 *
 * WRITES NOTHING. No --apply exists.
 */
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith("--" + n + "=")); return h ? h.slice(n.length + 3) : d; };
const CAP = Number(arg("cap", "6000")) || 6000;
const JSON_OUT = arg("json", "");
const f = (n) => Number(n).toLocaleString("en-US");

const PRISM = /\bprisms?\b/i;
const CROWNCOLL = /\bcrown\s+collection\b/i;
const GOLDCROWN = /\bgold\s+(?:holo\s+)?crown\b|\bcrown\s+die\s*-?\s*cuts?\b/i;
const DIECUT = /\bdie\s*-?\s*cuts?\b/i;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const out = {};
  console.log("census-dead-edge-detail  READ ONLY -- nothing is written\n");

  // ---- PACIFIC: co-occurrence of the three words -------------------------
  const pq = { query: "SELECT TOP " + CAP + " c.title, c.cardYear FROM c WHERE CONTAINS(c.hobbyiqCardId, ':pacific:')" };
  const prs = (await pool.items.query(pq, { maxItemCount: 1000 }).fetchAll()).resources || [];
  const combo = new Map();
  const byYearGold = new Map(), byYearCC = new Map(), byYearPrism = new Map();
  for (const r of prs) {
    const t = String(r.title == null ? "" : r.title);
    const p = PRISM.test(t), c = CROWNCOLL.test(t), g = GOLDCROWN.test(t);
    if (!p && !c && !g) continue;
    const key = (p ? "P" : "-") + (c ? "C" : "-") + (g ? "G" : "-");
    combo.set(key, (combo.get(key) || 0) + 1);
    const y = r.cardYear == null ? "null" : r.cardYear;
    if (g) byYearGold.set(y, (byYearGold.get(y) || 0) + 1);
    if (c) byYearCC.set(y, (byYearCC.get(y) || 0) + 1);
    if (p) byYearPrism.set(y, (byYearPrism.get(y) || 0) + 1);
  }
  console.log("PACIFIC co-occurrence over " + f(prs.length) + " sampled :pacific: rows  (P=prism C=crown-collection G=gold-crown/die-cut)");
  for (const kv of [...combo].sort((a, b) => b[1] - a[1])) console.log("   " + kv[0] + "  " + String(f(kv[1])).padStart(6));
  out.pacific = {
    sampled: prs.length, combos: Object.fromEntries(combo),
    goldByYear: Object.fromEntries([...byYearGold].sort()),
    crownCollByYear: Object.fromEntries([...byYearCC].sort()),
    prismByYear: Object.fromEntries([...byYearPrism].sort()),
    samplesPC: prs.filter((r) => PRISM.test(String(r.title || "")) && CROWNCOLL.test(String(r.title || "")) && !GOLDCROWN.test(String(r.title || ""))).slice(0, 6).map((r) => String(r.title).slice(0, 115)),
    samplesCG: prs.filter((r) => CROWNCOLL.test(String(r.title || "")) && GOLDCROWN.test(String(r.title || ""))).slice(0, 6).map((r) => String(r.title).slice(0, 115)),
    samplesGonly: prs.filter((r) => GOLDCROWN.test(String(r.title || "")) && !CROWNCOLL.test(String(r.title || ""))).slice(0, 8).map((r) => String(r.title).slice(0, 115)),
    samplesPonly: prs.filter((r) => PRISM.test(String(r.title || "")) && !CROWNCOLL.test(String(r.title || ""))).slice(0, 8).map((r) => String(r.title).slice(0, 115)),
  };

  // ---- SP: is the token a brand or a short print? ------------------------
  // No family pool exists (the probe derives `unknown`), so scope by the token.
  const sq = { query: "SELECT TOP " + CAP + " c.title, c.cardYear, c.hobbyiqCardId FROM c WHERE CONTAINS(UPPER(c.title ?? ''), ' SP ')" };
  let srs = [];
  try { srs = (await pool.items.query(sq, { maxItemCount: 1000 }).fetchAll()).resources || []; }
  catch (err) { console.log("  (SP scan failed: " + String(err.message).slice(0, 90) + ")"); }
  const SP_BRAND_LINE = /\bsp\s+authentic\b|\bupper\s+deck\s+sp\b|\bsp\s+legendary\b|\bsp\s+game\s+used\b|\bsp\s+signature|\bsp\s+championship\b|\bsp\s+top\s+prospects\b/i;
  const SHORTPRINT_CUE = /\bshort\s+print\b|\bssp\b|\bsp\s*\/|\/\s*sp\b|\bsp\b\s*#?\d+\s*of/i;
  const spClass = new Map(); const spYear = new Map();
  const spSamples = { brand: [], shortprint: [], bare: [] };
  for (const r of srs) {
    const t = String(r.title == null ? "" : r.title);
    let k;
    if (SP_BRAND_LINE.test(t)) k = "brand-line";
    else if (SHORTPRINT_CUE.test(t)) k = "short-print-cue";
    else k = "bare-sp-ambiguous";
    spClass.set(k, (spClass.get(k) || 0) + 1);
    const y = r.cardYear == null ? "null" : r.cardYear;
    if (k === "bare-sp-ambiguous") spYear.set(y, (spYear.get(y) || 0) + 1);
    const bucket = k === "brand-line" ? spSamples.brand : k === "short-print-cue" ? spSamples.shortprint : spSamples.bare;
    if (bucket.length < 10) bucket.push(String(r.cardYear) + " | " + t.slice(0, 100) + " | " + String(r.hobbyiqCardId || "").slice(0, 60));
  }
  console.log("\nSP token over " + f(srs.length) + " sampled titles containing ' SP '");
  for (const kv of [...spClass].sort((a, b) => b[1] - a[1])) console.log("   " + kv[0].padEnd(20) + String(f(kv[1])).padStart(6));
  out.sp = { sampled: srs.length, classes: Object.fromEntries(spClass), bareByYear: Object.fromEntries([...spYear].sort()), samples: spSamples };

  // ---- SP CHAMPIONSHIP specifically --------------------------------------
  const cq = { query: "SELECT TOP 1500 c.title, c.cardYear, c.hobbyiqCardId FROM c WHERE CONTAINS(UPPER(c.title ?? ''), 'SP CHAMPIONSHIP')" };
  let crs = [];
  try { crs = (await pool.items.query(cq, { maxItemCount: 1000 }).fetchAll()).resources || []; }
  catch (err) { console.log("  (SP Championship scan failed: " + String(err.message).slice(0, 80) + ")"); }
  const ccYear = new Map(); const ccKey = new Map();
  for (const r of crs) {
    const y = r.cardYear == null ? "null" : r.cardYear; ccYear.set(y, (ccYear.get(y) || 0) + 1);
    const m = String(r.hobbyiqCardId || "").split(":"); const k = m[3] || "?"; ccKey.set(k, (ccKey.get(k) || 0) + 1);
  }
  console.log("\nSP CHAMPIONSHIP titles: " + f(crs.length) + "  years=" + JSON.stringify(Object.fromEntries([...ccYear].sort())));
  console.log("   stored setKeys: " + [...ccKey].sort((a, b) => b[1] - a[1]).slice(0, 8).map((kv) => kv[0] + "=" + kv[1]).join(" "));
  out.spChampionship = { sampled: crs.length, byYear: Object.fromEntries([...ccYear].sort()), byStoredKey: Object.fromEntries(ccKey), samples: crs.slice(0, 8).map((r) => String(r.title).slice(0, 110)) };

  // ---- bare "1994 SP" / "1995 SP" Upper Deck flagship ---------------------
  const bq = { query: "SELECT TOP 1500 c.title, c.cardYear, c.hobbyiqCardId FROM c WHERE CONTAINS(c.hobbyiqCardId, ':sp:')" };
  let brs = [];
  try { brs = (await pool.items.query(bq, { maxItemCount: 1000 }).fetchAll()).resources || []; }
  catch (err) { console.log("  (:sp: scan failed: " + String(err.message).slice(0, 80) + ")"); }
  const bYear = new Map();
  for (const r of brs) { const y = r.cardYear == null ? "null" : r.cardYear; bYear.set(y, (bYear.get(y) || 0) + 1); }
  console.log("\nrows already ON :sp: -> " + f(brs.length) + " sampled, years=" + JSON.stringify(Object.fromEntries([...bYear].sort())));
  out.spOnKey = { sampled: brs.length, byYear: Object.fromEntries([...bYear].sort()), samples: brs.slice(0, 12).map((r) => String(r.title).slice(0, 110)) };

  // ---- FLEER: year spread of tiffany/glossy statements --------------------
  for (const fam of ["fleer", "fleer-update"]) {
    const q = { query: "SELECT TOP " + CAP + " c.title, c.cardYear FROM c WHERE CONTAINS(c.hobbyiqCardId, ':" + fam + ":')" };
    let rs = [];
    try { rs = (await pool.items.query(q, { maxItemCount: 1000 }).fetchAll()).resources || []; }
    catch (err) { console.log("  (" + fam + " scan failed)"); }
    const tif = new Map(), glo = new Map(), both = new Map(); const trad = new Map();
    for (const r of rs) {
      const t = String(r.title == null ? "" : r.title);
      const y = r.cardYear == null ? "null" : r.cardYear;
      const T = /\btiffany\b/i.test(t), G = /\bglossy\b/i.test(t), R = /\btradition\b/i.test(t);
      if (T && G) both.set(y, (both.get(y) || 0) + 1);
      else if (T) tif.set(y, (tif.get(y) || 0) + 1);
      else if (G) glo.set(y, (glo.get(y) || 0) + 1);
      if (R && T) trad.set(y, (trad.get(y) || 0) + 1);
    }
    console.log("\n" + fam + " (" + f(rs.length) + " sampled)  tiffany-only=" + JSON.stringify(Object.fromEntries([...tif].sort())) + "  glossy-only=" + JSON.stringify(Object.fromEntries([...glo].sort())) + "  both=" + JSON.stringify(Object.fromEntries([...both].sort())) + "  tradition+tiffany=" + JSON.stringify(Object.fromEntries([...trad].sort())));
    out["fleerScan_" + fam] = {
      sampled: rs.length, tiffanyOnly: Object.fromEntries([...tif].sort()), glossyOnly: Object.fromEntries([...glo].sort()),
      both: Object.fromEntries([...both].sort()), traditionTiffany: Object.fromEntries([...trad].sort()),
      tiffanySamples: rs.filter((r) => /\btiffany\b/i.test(String(r.title || "")) && !/\bglossy\b/i.test(String(r.title || ""))).slice(0, 10).map((r) => String(r.cardYear) + " | " + String(r.title).slice(0, 100)),
      glossySamples: rs.filter((r) => /\bglossy\b/i.test(String(r.title || ""))).slice(0, 10).map((r) => String(r.cardYear) + " | " + String(r.title).slice(0, 100)),
    };
  }

  // ---- UPPER DECK: minors vs black diamond ambiguity ----------------------
  const uq = { query: "SELECT TOP " + CAP + " c.title, c.cardYear FROM c WHERE CONTAINS(c.hobbyiqCardId, ':upper-deck:')" };
  let urs = [];
  try { urs = (await pool.items.query(uq, { maxItemCount: 1000 }).fetchAll()).resources || []; }
  catch (err) { console.log("  (upper-deck scan failed)"); }
  const MIN_STRICT = /\bminor\s+league\b|\bupper\s+deck\s+minors\b/i;
  const MIN_LOOSE = /\bminors?\b/i;
  const BD = /\bblack\s+diamond\b/i;
  let mStrict = 0, mLooseOnly = 0, bd = 0;
  const mLooseSamples = [];
  for (const r of urs) {
    const t = String(r.title == null ? "" : r.title);
    if (BD.test(t)) bd++;
    if (MIN_STRICT.test(t)) mStrict++;
    else if (MIN_LOOSE.test(t)) { mLooseOnly++; if (mLooseSamples.length < 10) mLooseSamples.push(String(r.cardYear) + " | " + t.slice(0, 100)); }
  }
  console.log("\nupper-deck (" + f(urs.length) + " sampled)  minor-league-strict=" + f(mStrict) + "  bare-minors-only=" + f(mLooseOnly) + "  black-diamond=" + f(bd));
  out.upperDeck = { sampled: urs.length, minorLeagueStrict: mStrict, bareMinorsOnly: mLooseOnly, blackDiamond: bd, bareMinorsSamples: mLooseSamples };

  // ---- SCORE: rookie & traded spellings ----------------------------------
  const scq = { query: "SELECT TOP " + CAP + " c.title, c.cardYear FROM c WHERE CONTAINS(c.hobbyiqCardId, ':score:')" };
  let scrs = [];
  try { scrs = (await pool.items.query(scq, { maxItemCount: 1000 }).fetchAll()).resources || []; }
  catch (err) { console.log("  (score scan failed)"); }
  const RT = /\brookie\s*(?:&|and|\/|\+)\s*traded\b/i;
  const TRADED_ONLY = /\btraded\b/i;
  let rt = 0, tradedOnly = 0; const rtY = new Map(); const tradedSamples = [];
  for (const r of scrs) {
    const t = String(r.title == null ? "" : r.title);
    const y = r.cardYear == null ? "null" : r.cardYear;
    if (RT.test(t)) { rt++; rtY.set(y, (rtY.get(y) || 0) + 1); }
    else if (TRADED_ONLY.test(t)) { tradedOnly++; if (tradedSamples.length < 10) tradedSamples.push(String(y) + " | " + t.slice(0, 100)); }
  }
  console.log("score (" + f(scrs.length) + " sampled)  rookie&traded=" + f(rt) + " years=" + JSON.stringify(Object.fromEntries([...rtY].sort())) + "  traded-without-rookie=" + f(tradedOnly));
  out.score = { sampled: scrs.length, rookieAndTraded: rt, rtByYear: Object.fromEntries([...rtY].sort()), tradedWithoutRookie: tradedOnly, tradedOnlySamples: tradedSamples };

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log("\nwrote " + JSON_OUT); }
}
main().catch((e) => { console.error(e); process.exit(1); });
