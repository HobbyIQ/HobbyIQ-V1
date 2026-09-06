#!/usr/bin/env node
/**
 * READ-ONLY probe for the donruss-optic football/2024 arbitration (#1830).
 *
 * Re-runs the judge's population under the NEW survivor rule and reports the
 * bucket counts the dispatch decision needs:
 *
 *   MOVE               no twin at the destination
 *   FOLD (alias wins)  a twin, different player, the ALIAS copy corroborated
 *   FOLD (dest wins)   a twin, different player, the DEST copy corroborated
 *   FOLD (same player) a twin naming the same player -- the ordinary tiebreak
 *   REFUSED            a twin, different player, NEITHER side corroborated
 *   subset-in-parallel alias rows whose `parallel` swallows a subset name
 *
 * Corroboration here is the SALE-TITLE referee, the second arm of the ruling:
 * `sold_comps` titles for this product at that card number, counted per player.
 * The catalog arm (a third strict source at the cell) is read too.
 *
 * Nothing is written. Nothing is dispatched.
 */
const { CosmosClient } = require("@azure/cosmos");

const SPORT = "football";
const YEAR = 2024;
const ALIAS = "panini-optic";
const DEST = "donruss-optic";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING is required"); process.exit(2); }
const client = new CosmosClient(conn);
const db = client.database("hobbyiq");
const cat = db.container("card_catalog");
const pool = db.container("sold_comps");

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function all(container, spec, pageSize = 1000) {
  const out = [];
  let token;
  do {
    const page = await retry(() => container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    for (const r of page.resources ?? []) out.push(r);
  } while (token);
  return out;
}

const pk = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const norm = (s) => String(s ?? "").trim().toLowerCase()
  .replace(/-(graded|attested|unnumbered|scraped)$/, "")
  .replace(/-\d{4}-\d{2}-\d{2}(t[\d:.+-]*)?$/, "").replace(/-\d{8}$/, "")
  .replace(/-(graded|attested|unnumbered|scraped)$/, "");
/** hiq:sport:year:setKey:...  -> identity rows only (7 or 8 segments, no tier). */
function isIdentity(id) {
  const p = String(id ?? "").split(":");
  if (p[0] !== "hiq") return false;
  if (p.length !== 7 && p.length !== 8) return false;
  if (p.length === 8 && !p[7].startsWith("num-")) return false;
  return p[6] === "auto" || p[6] === "no-auto";
}
const numOf = (id) => String(id ?? "").split(":")[4] ?? "";

/** The subset phrases the judge found folded into `parallel`. */
const SUBSET_MARKERS = [
  /\brookie\b/i, /\bmy house\b/i, /\bdowntown\b/i, /\bfirst year\b/i,
  /\bprimary colors\b/i, /\bfresh\b/i, /\bthe rookies\b/i, /\brated rookie\b/i,
];
const subsetish = (parallel) => SUBSET_MARKERS.some((r) => r.test(String(parallel ?? "")));

(async () => {
  const t0 = Date.now();
  const sel = "SELECT c.id, c.cardId, c.setKey, c.source, c.playerName, c.parallel, c.parallelSlug, c.cardNumber, c.gradeTier, c.vendorIds, c.confidence FROM c WHERE STARTSWITH(c.id, @p)";
  const [aliasRows, destRows] = await Promise.all([
    all(cat, { query: sel, parameters: [{ name: "@p", value: `hiq:${SPORT}:${YEAR}:${ALIAS}:` }] }),
    all(cat, { query: sel, parameters: [{ name: "@p", value: `hiq:${SPORT}:${YEAR}:${DEST}:` }] }),
  ]);
  console.log(`alias rows ${aliasRows.length}   dest rows ${destRows.length}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const aliasIds = aliasRows.filter((r) => isIdentity(r.id) && !r.gradeTier);
  const destById = new Map();
  for (const r of destRows) destById.set(String(r.id), r);

  // ── the sale-title referee ────────────────────────────────────────────────
  // Every 2024 Optic football sale, bucketed by card number -> player counts.
  const saleSpec = {
    query: `SELECT c.title, c.playerName, c.cardNumber, c.hobbyiqCardId FROM c
            WHERE c.sport = @sp AND (c.cardYear = @y OR c.year = @y)
              AND (c.normalizedSetKey = @a OR c.normalizedSetKey = @d)`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@y", value: YEAR }, { name: "@a", value: ALIAS }, { name: "@d", value: DEST }],
  };
  const sales = await all(pool, saleSpec);
  console.log(`sold_comps rows for the product   ${sales.length}`);
  /** number -> Map(playerKey -> {name, n}) */
  const referee = new Map();
  for (const s of sales) {
    const n = String(s.cardNumber ?? numOf(s.hobbyiqCardId) ?? "").trim().toLowerCase();
    const p = String(s.playerName ?? "").trim();
    if (!n || !p) continue;
    if (!referee.has(n)) referee.set(n, new Map());
    const m = referee.get(n);
    const k = pk(p);
    const cur = m.get(k) ?? { name: p, n: 0 };
    cur.n++;
    m.set(k, cur);
  }

  /** Does the market back this (number, player)? majority | minority | absent */
  function refereeVerdict(number, player) {
    const m = referee.get(String(number ?? "").trim().toLowerCase());
    if (!m || m.size === 0) return { verdict: "absent", n: 0, top: null, topN: 0 };
    const entries = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    const top = entries[0];
    const mine = m.get(pk(player));
    if (!mine) return { verdict: "absent", n: 0, top: top[1].name, topN: top[1].n };
    return {
      verdict: pk(player) === top[0] ? "majority" : "minority",
      n: mine.n, top: top[1].name, topN: top[1].n,
    };
  }

  // ── the buckets ───────────────────────────────────────────────────────────
  const b = {
    move: 0, foldSamePlayer: 0, foldAliasWins: 0, foldDestWins: 0, refused: 0,
    subsetInParallel: 0, subsetCollide: 0,
  };
  const refusedExamples = [];
  const aliasWinExamples = [];
  const destWinExamples = [];
  const refusedNumbers = new Set();

  // Subset collision measurement: do alias rows whose parallel carries a subset
  // phrase collide on (number, parallelSlug) with a base row at the same number?
  const aliasCell = new Map(); // "num|parallelSlug" -> [rows]
  for (const r of aliasIds) {
    const p = String(r.id).split(":");
    const key = `${p[4]}|${p[5]}`;
    if (!aliasCell.has(key)) aliasCell.set(key, []);
    aliasCell.get(key).push(r);
  }
  for (const r of aliasIds) if (subsetish(r.parallel)) b.subsetInParallel++;
  // A COLLISION that a subset segment would fix: one (number, parallelSlug)
  // cell holding two DIFFERENT players, at least one of which is subset-ish.
  const subsetCollisionExamples = [];
  for (const [key, rows] of aliasCell) {
    if (rows.length < 2) continue;
    const players = new Set(rows.map((r) => pk(r.playerName)).filter(Boolean));
    if (players.size < 2) continue;
    if (!rows.some((r) => subsetish(r.parallel))) continue;
    b.subsetCollide += rows.length;
    if (subsetCollisionExamples.length < 8) {
      subsetCollisionExamples.push(`${key}  ${rows.map((r) => `${r.playerName} [${r.parallel}]`).join("  |  ")}`);
    }
  }

  // AUTHORITY FIRST, exactly as chooseSurvivor now orders it: a rank gap is
  // already an answer and never reaches the player question.
  const RANK = (src) => {
    const s = norm(src);
    if (!s) return 0;
    if (/checklist|beckett|bccp|baseballcardpedia|tcdb|hobbymonitor|sportscardchecklist/.test(s)) return 3;
    if (/seed|derived|sales/.test(s)) return 1;
    return 2;
  };
  let authorityDecided = 0;

  for (const a of aliasIds) {
    const parts = String(a.id).split(":");
    parts[3] = DEST;
    const twin = destById.get(parts.join(":"));
    if (!twin) { b.move++; continue; }
    if (RANK(a.source) !== RANK(twin.source)) { authorityDecided++; b.foldSamePlayer++; continue; }
    const pa = pk(a.playerName), pd = pk(twin.playerName);
    if (!pa || !pd || pa === pd) { b.foldSamePlayer++; continue; }
    const number = parts[4];
    const ra = refereeVerdict(number, a.playerName);
    const rd = refereeVerdict(number, twin.playerName);
    const aliasBacked = ra.verdict === "majority";
    const destBacked = rd.verdict === "majority";
    if (aliasBacked && !destBacked) {
      b.foldAliasWins++;
      if (aliasWinExamples.length < 8) aliasWinExamples.push(`#${number} ${a.parallelSlug ?? parts[5]}: alias "${a.playerName}" (${ra.n} sales) BEATS dest "${twin.playerName}" (${rd.n})`);
    } else if (destBacked && !aliasBacked) {
      b.foldDestWins++;
      if (destWinExamples.length < 8) destWinExamples.push(`#${number} ${a.parallelSlug ?? parts[5]}: dest "${twin.playerName}" (${rd.n} sales) BEATS alias "${a.playerName}" (${ra.n})`);
    } else {
      b.refused++;
      refusedNumbers.add(number);
      if (refusedExamples.length < 20) refusedExamples.push(`#${number} ${parts[5]}: alias "${a.playerName}" (${ra.verdict}/${ra.n}) vs dest "${twin.playerName}" (${rd.verdict}/${rd.n}); market top "${ra.top ?? "-"}" x${ra.topN}`);
    }
  }

  // ── the year defect, counted ──────────────────────────────────────────────
  // Sales at a 2024 number whose top-selling player is not in EITHER catalog
  // at that number -- the judge's 11 NEITHER cases. Reported, not fixed.
  const knownAtNumber = new Map(); // number -> Set(playerKey)
  for (const r of [...aliasIds, ...destRows]) {
    if (!isIdentity(r.id)) continue;
    const n = numOf(r.id);
    if (!knownAtNumber.has(n)) knownAtNumber.set(n, new Set());
    if (r.playerName) knownAtNumber.get(n).add(pk(r.playerName));
  }
  const yearDefect = [];
  for (const [number, m] of referee) {
    const entries = [...m.entries()].sort((a, b2) => b2[1].n - a[1].n);
    const [topKey, top] = entries[0];
    if (top.n < 10) continue;
    const known = knownAtNumber.get(number);
    if (known && known.has(topKey)) continue;
    yearDefect.push({ number, player: top.name, sales: top.n });
  }
  yearDefect.sort((a, b2) => b2.sales - a.sales);

  console.log("");
  console.log("── football 2024 donruss-optic, under the NEW survivor rule ──");
  console.log(`  identity move candidates (alias)   ${aliasIds.length}`);
  console.log(`  MOVE (no twin)                     ${b.move}`);
  console.log(`  FOLD ordinary ladder               ${b.foldSamePlayer}   (of which authority-decided: ${authorityDecided})`);
  console.log(`  FOLD alias wins (corroborated)     ${b.foldAliasWins}`);
  console.log(`  FOLD dest  wins (corroborated)     ${b.foldDestWins}`);
  console.log(`  REFUSED (neither corroborated)     ${b.refused}   across ${refusedNumbers.size} card numbers`);
  console.log(`  alias rows with subset-in-parallel ${b.subsetInParallel}`);
  console.log(`  subset-driven intra-alias collisions ${b.subsetCollide}`);
  console.log("");
  if (aliasWinExamples.length) { console.log("  ALIAS WINS:"); for (const x of aliasWinExamples) console.log(`    ${x}`); }
  if (destWinExamples.length) { console.log("  DEST WINS:"); for (const x of destWinExamples) console.log(`    ${x}`); }
  if (refusedExamples.length) { console.log("  REFUSED (named):"); for (const x of refusedExamples) console.log(`    ${x}`); }
  if (subsetCollisionExamples.length) { console.log("  SUBSET COLLISIONS:"); for (const x of subsetCollisionExamples) console.log(`    ${x}`); }
  console.log("");
  console.log(`  YEAR DEFECT (top seller at a 2024 number absent from both catalogs, >=10 sales): ${yearDefect.length}`);
  for (const y of yearDefect.slice(0, 20)) console.log(`    #${y.number}  ${y.player}  x${y.sales}`);
  console.log("");
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -- READ ONLY, nothing written`);
})().catch((e) => { console.error("FAILED:", String(e?.message ?? e)); process.exit(1); });
