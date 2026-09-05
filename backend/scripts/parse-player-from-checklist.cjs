#!/usr/bin/env node
/**
 * parse-player-from-checklist.cjs -- the checklist knows who is on card #74.
 *
 * CF-THE-CHECKLIST-KNOWS-THE-PLAYER (Drew, 2026-08-29 checklist D1). 1,459,254
 * sales sit in comps_staging as awaiting-verify with no parsed player. Every
 * one of them already carries a hobbyiqCardId slug -- sport, year, setKey,
 * cardNumber, parallel -- derived at ingest, and its title plainly names the
 * player ("2026 Topps Chrome Flagship Bobby Witt Jr. #74 ... Refractor"). The
 * AI title parser was the only path to a player; it is rate-limited and paid.
 *
 * This is a lookup, not a model: (sport, year, setKey, cardNumber) -> the
 * checklist rows at that address -> their player names -> the ONE whose last
 * name (and, if the title has it, first name) appears in the title. Exactly
 * one match, or nothing is written. Only checklist-source identity rows are
 * consulted -- never sale-minted rows, never graded rows -- and a product with
 * more than MAX_CANDIDATES players at one number is treated as exploded and
 * skipped (run this AFTER retire-exploded-checklist-rows).
 *
 * On a match the row gets clean.playerName (+ cardYear / setName / cardNumber
 * / parallel from the slug), parsedBy = "checklist", and status
 * awaiting-catalog -- the status the one-pool emission reads -- so the next
 * emission pass writes the sale through recordSoldComp with a player.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS (hash of id);
 *      CONCURRENCY=16; RUN_MINUTES=140; LIMIT; MAX_CANDIDATES=40.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "parse-player-from-checklist" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 40);
const PRINT_EXAMPLES = Number(process.env.PRINT_EXAMPLES || 12);
const exParsed = [], exNoMatch = [], exAmbig = [];
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const CHECKLIST_SQL = "(c.source = 'bccp' OR STARTSWITH(c.source,'baseballcardpedia') OR STARTSWITH(c.source,'checklist') OR STARTSWITH(c.source,'beckett') OR STARTSWITH(c.source,'tcgdex') OR STARTSWITH(c.source,'cardboardchecklist'))";

const fold = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (s) => fold(s).replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
// Checklist player cells carry designation tags that are not part of the name:
// "Elly De La Cruz RC", "Johnny Bench AS DP", "Bobby Dalbec FS", "Rogers
// Hornsby 1991". Two such cells for one card made every match "ambiguous";
// "Johnny Bench AS DP" never matched because "dp" was taken as the surname.
const TAG = new Set(["rc", "as", "dp", "fs", "sp", "ssp", "hof", "mvp", "rr", "dk", "cl", "tc", "ll", "var", "variation", "sv", "uer", "err"]);
const nameTokens = (player) => tokens(player).filter((t) => !SUFFIX.has(t) && !TAG.has(t) && !/^\d{2,4}$/.test(t));
const nameKey = (player) => nameTokens(player).join(" ");

/** Does this checklist player appear in the title? Last name must be a whole
 *  token; if the player has a first name, its first token must appear too
 *  (or its initial, for "B. Witt"). Suffixes and designation tags are ignored. */
function playerInTitle(player, titleTokens) {
  const pt = nameTokens(player);
  if (!pt.length) return false;
  const last = pt[pt.length - 1];
  if (last.length < 2 || !titleTokens.has(last)) return false;
  if (pt.length === 1) return true;
  const first = pt[0];
  return titleTokens.has(first) || (first.length >= 3 && [...titleTokens].some((t) => t.length === 1 && t === first[0]));
}

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), stg = db.container("comps_staging");
  console.log(`slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY" : "REPORT ONLY"}  budget ${RUN_MS / 60000}m  max candidates ${MAX_CANDIDATES}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // (sport|year|setKey|cardNumber) -> [{ player, setName }] ; memoised per run
  const cache = new Map();
  const candidatesFor = async (sport, year, setKey, cardNumber) => {
    const key = `${sport}|${year}|${setKey}|${cardNumber}`;
    if (cache.has(key)) return cache.get(key);
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT DISTINCT c.playerName AS player, c.setName AS setName FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.cardNumber = @n AND NOT IS_DEFINED(c.gradeTier) AND ${CHECKLIST_SQL}`,
      parameters: [{ name: "@sp", value: sport }, { name: "@y", value: year }, { name: "@k", value: setKey }, { name: "@n", value: cardNumber }],
    }, { maxItemCount: 200 }).fetchAll());
    const list = resources.filter((r) => r.player && String(r.player).trim());
    cache.set(key, list);
    return list;
  };

  let scanned = 0, otherShards = 0, parsed = 0, noChecklist = 0, noMatch = 0, ambiguous = 0, exploded = 0, badSlug = 0, noTitle = 0, failed = 0, notReached = 0;
  let stopReason = null, token;
  const query = { query: "SELECT c.id, c.hobbyiqCardId, c.raw.vendorPayload.title AS title FROM c WHERE c.status = 'awaiting-verify' AND (NOT IS_DEFINED(c.clean.playerName) OR c.clean.playerName = '' OR c.clean.playerName = null) AND IS_DEFINED(c.hobbyiqCardId)" };

  do {
    const page = await retry(() => stg.items.query(query, { maxItemCount: 300, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    const mine = page.resources.filter((d) => shardOf(d.id) === SLOT);
    otherShards += page.resources.length - mine.length;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const parts = String(d.hobbyiqCardId ?? "").split(":");
          if (parts.length < 7 || parts[0] !== "hiq") { badSlug++; return; }
          const [, sport, yearS, setKey, cardNumber, parallelSlug] = parts;
          const year = Number(yearS);
          if (!sport || !year || !setKey || setKey === "unknown" || !cardNumber) { badSlug++; return; }
          const title = String(d.title ?? "");
          if (!title.trim()) { noTitle++; return; }
          const cands = await candidatesFor(sport, year, setKey, String(cardNumber).toUpperCase());
          const cands2 = cands.length ? cands : await candidatesFor(sport, year, setKey, String(cardNumber).toLowerCase());
          if (!cands2.length) { noChecklist++; return; }
          if (cands2.length > MAX_CANDIDATES) { exploded++; return; }
          const tt = new Set(tokens(title));
          const hits = [...new Map(cands2.filter((c) => playerInTitle(c.player, tt)).map((c) => [nameKey(c.player), c])).values()];
          if (hits.length === 0) { noMatch++; if (exNoMatch.length < PRINT_EXAMPLES) exNoMatch.push(`${title.slice(0, 70)}  |  slug ${d.hobbyiqCardId}  |  candidates: ${cands2.slice(0, 4).map((c) => c.player).join(", ")}`); return; }
          if (hits.length > 1) { ambiguous++; if (exAmbig.length < PRINT_EXAMPLES) exAmbig.push(`${title.slice(0, 70)}  |  ${hits.map((c) => c.player).join(" / ")}`); return; }
          const hit = hits[0];
          if (exParsed.length < PRINT_EXAMPLES) exParsed.push(`${title.slice(0, 70)}  ->  ${hit.player}`);
          if (!APPLY) { parsed++; return; }
          await retry(() => stg.item(d.id, d.hobbyiqCardId).patch([
            { op: "set", path: "/clean", value: { playerName: hit.player, cardYear: year, setName: hit.setName ?? setKey, cardNumber, parallel: parallelSlug && parallelSlug !== "base" ? parallelSlug.replace(/-/g, " ") : null, sport, slug: d.hobbyiqCardId } },
            { op: "set", path: "/parsedBy", value: "checklist" },
            { op: "set", path: "/parsedAt", value: new Date().toISOString() },
            { op: "replace", path: "/status", value: "awaiting-catalog" },
            { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
          ]));
          parsed++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 60)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && parsed >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
    if (scanned && scanned % 3000 < CONCURRENCY) process.stderr.write(`\r  scanned=${f(scanned)} parsed=${f(parsed)} no-checklist=${f(noChecklist)} no-match=${f(noMatch)} ambiguous=${f(ambiguous)}   `);
  } while (token);
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned (this slot)   ${f(scanned)}   (+${f(otherShards)} belonging to other slots)`);
  console.log(`  PARSED from the checklist  ${f(parsed)}   <- exactly one checklist player at that number is in the title`);
  console.log(`  no checklist at that address ${f(noChecklist)}   <- acquisition, not guessing`);
  console.log(`  candidates, none in title  ${f(noMatch)}`);
  console.log(`  ambiguous (2+ in title)    ${f(ambiguous)}`);
  console.log(`  exploded address (skipped) ${f(exploded)}   <- >${MAX_CANDIDATES} players at one number: retire the explosion first`);
  console.log(`  bad / unknown slug         ${f(badSlug)}`);
  console.log(`  no title                   ${f(noTitle)}`);
  console.log(`  failed                     ${f(failed)}`);
  if (exParsed.length) { console.log("\n  parsed, examples:"); for (const e of exParsed) console.log("    " + e); }
  if (exNoMatch.length) { console.log("\n  candidates but none in title, examples:"); for (const e of exNoMatch) console.log("    " + e); }
  if (exAmbig.length) { console.log("\n  ambiguous, examples:"); for (const e of exAmbig) console.log("    " + e); }
  if (APPLY) reportWrites({ job: "parse-player-from-checklist", intended: scanned, written: parsed, skipped: noChecklist + noMatch + ambiguous + exploded + badSlug + noTitle + notReached, failed });
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
