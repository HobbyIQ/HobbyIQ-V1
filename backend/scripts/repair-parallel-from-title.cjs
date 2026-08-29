#!/usr/bin/env node
/**
 * repair-parallel-from-title.cjs -- a pool row's parallel must be something its
 * title says. Where a vendor product tag was stamped over a silent title, the
 * title decides again.
 *
 * CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG (Drew, 2026-08-29: "Bases are tagged to
 * this gold or the gold is tagged to bases" -- holding ca7a150b, 2026 Bowman
 * Chrome CPA-MG Marconi German Gold Refractor /50). Under that gold slug, 38
 * of the 40 latest rows were CardHedge base autos at $5-12 whose titles never
 * said gold: persistVendorSalesToPool let `identity.parallel` (the vendor's
 * PRODUCT tag) override the title parse, and the long-form rule then folded
 * `:gold:` into `:gold-refractor:`. Measured pool-wide (exact): CardHedge Gold
 * 226 / Blue 161 / Blue Refractor 467 / Black 132 / Silver 551 ...; TCA-eBay
 * colour refractors 1-3% each. The "Refractor"-stamped-title-silent bucket
 * (CH 163k, TCA 38k) is a DIFFERENT question (CH's variant vs our composed
 * "Base" suffix) and is NOT in scope here.
 *
 * For each (source, parallel) pair in COLOURS, every row whose title does not
 * contain the parallel's colour word is re-parsed with the same title parser
 * the eBay import uses; the parsed parallel (or Base when the title names no
 * finish) replaces the stamped one, the slug is recomputed with the same
 * grammar, and the row is re-pointed with reslugedFrom/Reason/At. Only-improve
 * does not apply: this is a correction of a confidently-wrong stamp.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY=true to write (default report only);
 *      SOURCES=cardhedge,tca-ebay,cardsight; SLOT/SLOTS (hash shards);
 *      RUN_MINUTES=140 (budget marker for the runner's relaunch).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { parseListingTitle } = require(path.join(backend, "dist", "services", "portfolioiq", "ebayTitleParser.service.js"));
const { computeHobbyIqCardId, parseHobbyIqCardId } = require(path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const APPLY = process.env.APPLY === "true";
const SOURCES = String(process.env.SOURCES || "cardhedge,tca-ebay,cardsight").split(",").map((s) => s.trim()).filter(Boolean);
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 1);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
// MODE=refractor: the bucket the colour pass left alone. Settled by price
// (2026-08-29, read-only): under 2025 Bowman Chrome CPA-EP :refractor:auto,
// CardHedge rows whose title never says "refractor" sell at a $60.95 median
// (n=695) while the ones that do say it sell at $140 (n=67); the true base
// pool sits at $47. A silent title is the base auto -- the vendor "Refractor"
// variant was stamped on base sales. CH 163,272 / TCA 37,854 / Cardsight
// 14,422 rows. MODE is the runner input; the runner ALSO exports
// SCOPE=refractor by default for other scripts, so SCOPE is not the switch.
const MODE = String(process.env.MODE || "colours").toLowerCase();
const REFRACTOR_ONLY = ["Refractor"];
const COLOURS = ["Gold", "Gold Refractor", "Blue", "Blue Refractor", "Green", "Green Refractor", "Orange", "Orange Refractor", "Red", "Red Refractor", "Purple", "Purple Refractor", "Black", "Black Refractor", "Sapphire", "Silver", "Pink", "Pink Refractor", "Yellow", "Yellow Refractor", "Aqua", "Aqua Refractor"];
const BARE_COLOURS = new Set(["gold", "blue", "green", "orange", "red", "purple", "black", "silver", "pink", "yellow", "aqua", "sapphire"]);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** The parallel the title itself names, in the pool's spelling. Null when the
 *  parser sees no finish -- that is Base. */
function titleParallel(title) {
  const p = parseListingTitle(title);
  const par = p && p.parallel ? String(p.parallel).trim() : "";
  return par && !/^base$/i.test(par) ? par : null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const pool = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq").container("sold_comps");
  console.log(`repair-parallel-from-title  ${APPLY ? "APPLY" : "REPORT ONLY"}  mode=${MODE}  sources=${SOURCES.join(",")}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m`);
  const stats = { scanned: 0, otherShard: 0, repaired: 0, toBase: 0, toOther: 0, kept: 0, keptRefinement: 0, failed: 0, noSlug: 0 };
  const moves = new Map(); // "source|from>to" -> n
  const examples = [];
  let stopReason = null;
  outer:
  for (const source of SOURCES) {
    for (const par of (MODE === "refractor" ? REFRACTOR_ONLY : COLOURS)) {
      const word = par.split(" ")[0].toLowerCase();
      const q = { query: "SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price FROM c WHERE c.source = @s AND c.parallel = @p AND NOT CONTAINS(LOWER(c.title), @w)", parameters: [{ name: "@s", value: source }, { name: "@p", value: par }, { name: "@w", value: word }] };
      const it = pool.items.query(q, { maxItemCount: 500 });
      while (it.hasMoreResults()) {
        if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break outer; }
        const { resources } = await retry(() => it.fetchNext());
        for (const r of resources ?? []) {
          stats.scanned++;
          if (SLOTS > 1 && shardOf(r.id) !== SLOT) { stats.otherShard++; continue; }
          const slug = String(r.hobbyiqCardId ?? "");
          const comp = slug.startsWith("hiq:") ? parseHobbyIqCardId(slug) : null;
          if (!comp) { stats.noSlug++; continue; }
          const fromTitle = titleParallel(r.title);
          // the title must actually corroborate what it names, or we would be
          // trading one uncorroborated stamp for another
          const titleWord = fromTitle ? fromTitle.split(" ")[0].toLowerCase() : null;
          if (titleWord && !String(r.title ?? "").toLowerCase().includes(titleWord)) { stats.kept++; continue; }
          const newParallel = fromTitle ?? "Base";
          const oldLower = String(r.parallel ?? "").toLowerCase(), newLower = newParallel.toLowerCase();
          if (newLower === oldLower) { stats.kept++; continue; }
          // CF-A-REFINEMENT-IS-NOT-A-CONTRADICTION (dry run #1: 199 "Blue
          // Refractor" -> "Refractor", 196 "Gold Refractor" -> "Refractor"). A
          // title that says "Refractor /150" and a vendor tag "Blue Refractor"
          // agree -- the colour refines the family the title names; moving the
          // row to a bare refractor:num-150 would mint a rung no checklist has.
          // Only a title that names NO finish, or a DIFFERENT one, overrules.
          if (fromTitle && oldLower.endsWith(" " + newLower)) { stats.keptRefinement++; continue; }
          // the short form of the same refinement: a bare colour IS "<Colour>
          // Refractor" (project_colour_equals_refractor_ruling), so "Blue" vs a
          // title saying "Refractor" agrees too (dry run #2: 92 rows)
          if (fromTitle && newLower === "refractor" && BARE_COLOURS.has(oldLower)) { stats.keptRefinement++; continue; }
          let newSlug;
          try { newSlug = computeHobbyIqCardId({ ...comp, parallel: newParallel }); } catch { stats.failed++; continue; }
          if (!newSlug || !newSlug.startsWith("hiq:") || newSlug === slug) { stats.kept++; continue; }
          const key = `${source}|${r.parallel}>${newParallel}`;
          moves.set(key, (moves.get(key) || 0) + 1);
          if (examples.length < 25) examples.push(`  ${source}  ${r.parallel} -> ${newParallel}  $${r.price}  "${String(r.title ?? "").slice(0, 80)}"`);
          if (newParallel === "Base") stats.toBase++; else stats.toOther++;
          if (APPLY) {
            try {
              await retry(() => pool.item(r.id, r.cardId).patch([
                { op: "set", path: "/parallel", value: newParallel },
                { op: "set", path: "/hobbyiqCardId", value: newSlug },
                { op: "set", path: "/reslugedFrom", value: slug },
                { op: "set", path: "/reslugedReason", value: "title outranks the vendor parallel tag (CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG)" },
                { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
              ]));
              stats.repaired++;
            } catch (e) { stats.failed++; if (stats.failed <= 3) console.log("  patch failed " + r.id + ": " + String(e.message).slice(0, 80)); }
          } else stats.repaired++;
        }
      }
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned           ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  ${APPLY ? "REPAIRED" : "WOULD REPAIR"}           ${f(stats.repaired)}   <- to Base ${f(stats.toBase)}, to another named finish ${f(stats.toOther)}`);
  console.log(`  kept                   ${f(stats.kept)}   <- title names the same finish, or names one it does not contain`);
  console.log(`  kept, refinement       ${f(stats.keptRefinement)}   <- the title names the family the vendor colour refines (Refractor /150 vs Blue Refractor)`);
  console.log(`  no slug                ${f(stats.noSlug)}`);
  console.log(`  failed                 ${f(stats.failed)}`);
  console.log(`  moves by source|from>to:`);
  for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`    ${String(n).padStart(7)}  ${k}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (stopReason) console.log(`\n${stopReason}`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
