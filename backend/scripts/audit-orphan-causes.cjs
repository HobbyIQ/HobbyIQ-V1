#!/usr/bin/env node
/**
 * CF-ORPHAN-CAUSES (Drew, 2026-08-19).
 *
 * Splits the ORPHAN population — comps no checklist can judge — into the part
 * that is a genuine gap in our checklist coverage and the part that is our OWN
 * malformed slugs.
 *
 * WHY THIS EXISTS. The conformance audit reported 196,031 Bowman ORPHANs, and
 * the backlog recorded that as an ACQUISITION problem: buy or scrape more
 * checklists and it shrinks. Measuring a candidate source killed that theory —
 * cardboardchecklist.com closes 2,091 of 88,677 in the 2023-26 window, 2.4% —
 * and the leftovers explained why:
 *
 *     2024 #null      Leo De Vries
 *     2025 #null      Thomas White
 *     2025 #sho-time  Shohei Ohtani
 *
 * A comp whose card-number segment is the literal string "null", or a phrase
 * lifted out of a title, can never match a checklist. No source fixes that. It
 * is a slug-quality problem wearing an acquisition problem's clothes, and the
 * distinction decides whether the next move is an ingest or a repair.
 *
 * THE CLASSES:
 *   nullish        cardNumber segment is "null" / "undefined"
 *   empty          segment is blank
 *   notNumberLike  something that is not shaped like a card number at all
 *   plausible      a well-formed number the checklist genuinely lacks
 *                  <- ONLY this one is a real acquisition gap
 *
 * SCANS THAT SURVIVE THEMSELVES. Two earlier attempts at this measurement died:
 * one on an empty connection string (az returned nothing under concurrent load,
 * which would have looked like a data result), and one on a 403 after 2h43m —
 * the auth token is minted when a query iterator opens and expires under long
 * scans. So the catalog side is year-bounded to shrink it, and both scans read
 * in legs, keeping the continuation token and resuming from a fresh client.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-orphan-causes.cjs \
 *     [--sport=baseball] [--family=bowman] [--years=2023-2026] [--refreshPages=400]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const FAMILY = arg("family", "bowman");
const [Y0, Y1] = arg("years", "2023-2026").split("-").map(Number);
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
// A Cosmos auth token is minted when the iterator opens and expires under a
// long scan. Page count is the WRONG unit for that: 400 pages is 800k rows,
// and at a throttled RU ceiling one leg can outlive the token — which killed
// a 10-hour trend scan with a 403. Elapsed time is what the token cares about.
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

const NOISE = new Set([
  "au", "auto", "autos", "autograph", "autographs", "on", "card", "true", "mini", "rc", "rookie",
  "gold", "blue", "green", "orange", "yellow", "aqua", "purple", "pink", "red", "black", "white",
  "silver", "teal", "bronze", "lava", "ice", "sepia", "refractor", "refractors", "xfractor",
  "prizm", "shimmer", "speckle", "mojo", "wave", "atomic", "sapphire", "superfractor", "grass",
  "redemption", "redeemed", "sealed", "first", "1st", "choice", "hta", "psa", "bgs", "sgc",
  "graded", "raw", "lot", "the", "of", "and", "jr", "sr", "ii", "iii",
]);
const core = (s) => String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
  .filter((w) => w.length > 1 && !NOISE.has(w)).slice(0, 2).join(" ");
const numKey = (n) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Shaped like a printed card number: 109, BCP-109, BCP109, CPA-WJ, 27b. */
const looksLikeCardNumber = (n) => {
  const s = String(n).trim();
  return /^[a-z]{0,6}-?\d{1,5}[a-z]?$/i.test(s) || /^[a-z]{1,6}-[a-z0-9]{1,6}$/i.test(s);
};

const isChecklistSource = (source) => {
  const s = String(source ?? "").toLowerCase().replace(/-graded$/, "");
  if (/^(cardhedge|cardsight|ebay|ingest-auto-seed|sold-comps-stub|tree-builder|catalog-explode|user-verified)/.test(s)) return false;
  if (/-product-structure$/.test(s)) return false;
  return /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor/.test(s);
};

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

/** Leg-based scan: survives both token expiry and an exhausted 429. */
async function scanAll(containerName, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(containerName);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try {
        page = await iter.fetchNext();
      } catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const wait = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}), waiting ${Math.round(wait / 1000)}s   `);
        await new Promise((r) => setTimeout(r, wait));
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
  // An empty connection string must ABORT, not produce a zero. A previous run
  // of this measurement got nothing back from `az` under load and the failure
  // was indistinguishable from a clean result until the error surfaced.
  if (!conn || conn.length < 40) {
    console.error("FATAL: COSMOS_CONNECTION_STRING missing or truncated — refusing to report a result from no data.");
    process.exit(1);
  }
  console.log(`[orphan-causes] sport=${SPORT} family=${FAMILY} years=${Y0}-${Y1}\n`);

  // ── 1. Checklist-backed keys, YEAR-BOUNDED to keep the scan short ────────
  const ours = new Map();
  await scanAll("card_catalog", {
    query: `SELECT c.cardNumber, c.playerName, c.year, c.source FROM c
             WHERE IS_STRING(c.cardNumber) AND c.cardNumber <> ""
               AND STARTSWITH(c.setKey, @f) AND c.year >= @y0 AND c.year <= @y1`,
    parameters: [{ name: "@f", value: FAMILY }, { name: "@y0", value: Y0 }, { name: "@y1", value: Y1 }],
  }, (r) => {
    if (!isChecklistSource(r.source)) return;
    const p = core(r.playerName);
    if (!p) return;
    const k = `${Number(r.year)}|${numKey(r.cardNumber)}`;
    if (!ours.has(k)) ours.set(k, new Set());
    ours.get(k).add(p);
  }, "catalog");
  console.log(`checklist-backed (year, number) keys: ${ours.size.toLocaleString()}\n`);

  // ── 2. Classify every orphaned comp ─────────────────────────────────────
  let comps = 0, orphan = 0;
  const why = { nullish: 0, empty: 0, notNumberLike: 0, plausible: 0 };
  const ex = { nullish: [], notNumberLike: [], plausible: [] };
  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId, c.playerName FROM c
             WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
    parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
  }, (r) => {
    const parts = String(r.hobbyiqCardId).split(":");
    if (parts.length < 7) return;
    const y = Number(parts[2]);
    if (!(y >= Y0 && y <= Y1)) return;
    const p = core(r.playerName);
    if (!p) return;
    comps++;
    const num = parts[4];
    if (ours.get(`${y}|${numKey(num)}`)?.has(p)) return;
    orphan++;
    if (num === "") why.empty++;
    else if (num === "null" || num === "undefined") {
      why.nullish++;
      if (ex.nullish.length < 4) ex.nullish.push(`${y} #${num} ${r.playerName}`);
    } else if (!looksLikeCardNumber(num)) {
      why.notNumberLike++;
      if (ex.notNumberLike.length < 6) ex.notNumberLike.push(`${y} #${num} ${r.playerName}`);
    } else {
      why.plausible++;
      if (ex.plausible.length < 6) ex.plausible.push(`${y} #${num} ${r.playerName}`);
    }
  }, "comps");

  const pc = (n) => `${((n / Math.max(orphan, 1)) * 100).toFixed(1)}%`;
  const ourFault = why.nullish + why.empty + why.notNumberLike;
  console.log(`comps in range : ${comps.toLocaleString()}`);
  console.log(`ORPHAN         : ${orphan.toLocaleString()}\n`);
  console.log(`  cardNumber is literal "null"/"undefined" : ${String(why.nullish).padStart(8)}  ${pc(why.nullish)}`);
  console.log(`  cardNumber segment EMPTY                 : ${String(why.empty).padStart(8)}  ${pc(why.empty)}`);
  console.log(`  not shaped like a card number            : ${String(why.notNumberLike).padStart(8)}  ${pc(why.notNumberLike)}`);
  console.log(`  ------------------------------------------------------------`);
  console.log(`  OUR OWN malformed slugs (a REPAIR)       : ${String(ourFault).padStart(8)}  ${pc(ourFault)}`);
  console.log(`  well-formed, checklist genuinely lacks   : ${String(why.plausible).padStart(8)}  ${pc(why.plausible)}   <- the only ACQUISITION gap\n`);
  for (const [k, label] of [["nullish", "literal null"], ["notNumberLike", "not a card number"], ["plausible", "genuine checklist gap"]]) {
    if (ex[k].length) { console.log(`  ${label}:`); for (const e of ex[k]) console.log(`     ${e}`); console.log(""); }
  }
  console.log("READ-ONLY. Only the last class can be closed by acquiring checklists.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
