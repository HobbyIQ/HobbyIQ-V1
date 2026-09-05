#!/usr/bin/env node
/**
 * repair-clc-signature-unsigned.cjs -- the clc rows whose parallel SAYS the card
 * is signed and whose flag says it is not.
 *
 * CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION (2026-09-05). The clc
 * converter decided isAuto from the section and the qualifier only, through a
 * vocabulary that did not include the word "signature". 2022 Panini Select
 * publishes "Jumbo Rookie Signature Swatches Gold Prizm"; sectionsOf split it
 * correctly ("Jumbo Rookie" IS the section) and the auto word landed on the
 * finish side, where nothing was reading. The converter is fixed; this is the
 * rows it already minted.
 *
 * MEASURED read-only 2026-09-05 over card_catalog, source LIKE checklistcenter%,
 * by this script's own report-only run (`RUN_MINUTES=8`, no APPLY):
 *   3,882,540 clc rows in total
 *      75,430 candidates scanned (flag false + an auto-ish word in the name)
 *      74,448 ACTIONABLE, across 88 products
 *         982 refused, and the refusals are the interesting half:
 *             916 deny the signature -- 2018 Topps Archives "1977 - No
 *                 Signature" (303), "1959 - No Signature/Venezuelan" (303),
 *                 "1977 No Signature" (275) and 2024 Topps Heritage "Missing
 *                 Facsimile Signature Variations" (35). Every one of those is a
 *                 variation whose POINT is the absent signature; the stored
 *                 flag is already right and flipping them would be the right
 *                 guard at the wrong scope.
 *              66 name no auto -- and these are a SOURCE TYPO, not a rule
 *                 failure: "Patch Autogrpahs Gold" (34) and "Patch Autogrpahs
 *                 Black" (32), misspelled on the page itself. They are left
 *                 alone deliberately. Guessing at a misspelling is how a
 *                 vocabulary starts inventing cards; the page should be
 *                 re-scraped or the spelling ruled, and 66 rows is a report
 *                 line, not a silent correction.
 *
 * The biggest cells are Leaf, not Panini, and the first read of this defect
 * missed them by looking only for the word "signature":
 *      40,383  2023 leaf-perfect-game-bonus-box   ("Metal Auto - Marble Orange Proof")
 *       8,686  2026 leaf-metal                    ("Western Auto Prismatic Platinum")
 *       5,336  2025 leaf-vivid                    ("Talent Auto Laser Blue")
 *       3,700  2025 leaf-optichrome
 *       1,772  2022 panini-elite-extra-edition    ("Signatures")
 * ... 88 products in all. The card numbers corroborate the names independently
 * -- MA- (Metal Auto), AWA-, DA-, CA-, TA- are auto prefixes -- so the
 * checklist's name and the card-number boundary agree on every sampled row.
 *
 * WHY A RE-INGEST CANNOT DO THIS, which is the whole reason this lane exists.
 * isAuto is part of the canonical id -- segment 6, `auto` / `no-auto`
 * (hobbyIqCardId). A re-ingest of these cells through the FIXED converter mints
 * the row at the `:auto` address and leaves the wrong `:no-auto` row standing
 * beside it: not a repair, a second row and a split pool. Confirmed on real
 * rows -- `hiq:baseball:2022:panini-elite-extra-edition:17:signatures:no-auto:num-1`
 * has no signed twin (a re-ingest would ADD one), while
 * `hiq:baseball:2023:panini-elite-extra-edition:18:signatures:no-auto` already
 * HAS one (a re-ingest would leave the pool split as it is). The ingester's
 * merge rule is the second half of it: a row another source already holds at
 * equal-or-higher authority keeps its stored values and only lastSeenAt moves,
 * so even at the same address the flag would not flip.
 *
 * And patchCatalogRowFields is refused BY DESIGN for this field: it declares
 * id / cardId / hobbyiqCardId UNPATCHABLE, because changing where a row lives
 * is a move. isAuto is derived INTO the address, so it is a move too.
 *
 * SO: moveCatalogRow, with { isAuto: true } as the changed field and sold_comps
 * as salesContainer. It rebuilds every derived field (never a raw patch --
 * memory: "deriveCatalogEntry builds its own search fields"), re-points the
 * sales BEFORE deleting the old row, folds onto an existing signed twin by
 * authority rather than duplicating it, and retires the old slug's graded
 * children (regenerable).
 *
 * THE EVIDENCE IS THE CHECKLIST'S OWN WORDS, which is what doctrine requires
 * (memory: "isAuto boundary is cardNumber, not text" -- the CHECKLIST decides
 * the flag, via its section/subset name, never free text on a card_set). The
 * parallel column on a clc row is not free text: it is the finish half of the
 * page's own Set cell, published by the manufacturer. A row is actionable only
 * when that published name contains a whole auto word and NOT a negation.
 *
 * REPORT-FIRST, ALWAYS. Default is report only. The report prints, per product,
 * the rows it would move, the rows it refuses and why, and every distinct
 * parallel spelling it is acting on -- so the blast radius is read before it is
 * taken. Nothing here runs without BACKFILL_APPLY/APPLY=true.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY / APPLY (report only by
 *      default); SOURCES (default checklistcenter, family-matched); SPORTS,
 *      YEARS (comma lists); SLOT/SLOTS; RUN_MINUTES=120; CONCURRENCY=8;
 *      LIMIT=0 (actionable rows); VERBOSE=true prints every row.
 */
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const backend = path.join(__dirname, "..");

const { CosmosClient } = require("@azure/cosmos");
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");

// CF-THE-RUNNER-EXPORTS-BACKFILL-APPLY (memory). Both spellings, because the
// runner exports one and a hand run types the other.
const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const SHARD_SCOPE = runnerShardScope({ label: "repair-clc-signature-unsigned" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const VERBOSE = process.env.VERBOSE === "true";
const SOURCES = String(process.env.SOURCES || "checklistcenter").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ─────────────────────────────────────────────────────────────────────

/** checklistcenter-2026-08-29 / -html-graded -> checklistcenter. */
const familyOf = (source) => String(source ?? "").toLowerCase().trim()
  .replace(/-graded$/, "").replace(/-html$/, "")
  .replace(/-(?:scraped-|ladders-|html-)?\d{4}-\d{2}-\d{2}$/, "")
  .replace(/-html$/, "");

/**
 * THE AUTO VOCABULARY, and its negation. Deliberately the SAME word list as the
 * converter's namesAnAuto, because a repair that read a different vocabulary
 * from the parser would heal rows the parser will re-break, and vice versa.
 *
 * Whole words only: "Autumn" is not an autograph and "Inkjet" is not ink.
 */
const AUTO_WORDS = /\b(auto|autos|autograph|autographs|autographed|signature|signatures|signing|signings|signed|penmanship|inscription|inscriptions|ink)\b/i;

/**
 * A NAME THAT DENIES THE SIGNATURE. 2018 Topps Archives publishes "1977 - No
 * Signature" and "1959 - No Signature/Venezuelan": a variation whose whole point
 * is that the facsimile signature is ABSENT. It contains the word and means the
 * opposite, and all 881 such rows are already correctly isAuto=false.
 *
 * Every negation spelling present in the corpus was enumerated read-only before
 * this list was written -- there are exactly three, all 2018 Topps Archives, all
 * already correct. The pattern is written wider than the three so a fourth
 * spelling arriving later is refused rather than flipped.
 */
const NEGATION = /\b(?:no|non|not|without|missing|un)[\s\-/]*(?:facsimile[\s\-]*)?(?:signature|signatures|signed|auto|autos|autograph|autographs|autographed)\b|\bunsigned\b|\bnon-?auto\b/i;

/** Is this published name evidence that the card is signed? */
function namesAnAuto(text) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (NEGATION.test(t)) return false;
  return AUTO_WORDS.test(t);
}

/** Slug layout hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N] --
 *  segment 6 is the auto boundary. */
const idSaysAuto = (id) => String(id).split(":")[6] === "auto";
const withAutoSegment = (id, isAuto) => { const p = String(id).split(":"); if (p.length > 6) p[6] = isAuto ? "auto" : "no-auto"; return p.join(":"); };

/**
 * The verdict for one stored row.
 *
 * Returns { action, reason } where action is one of:
 *   "move"    -- the name says signed, the flag and the id say unsigned: the
 *                row moves to the `:auto` address.
 *   "heal"    -- the id ALREADY says auto and only the field is false; the
 *                address is right, so nothing moves and the field conforms.
 *   "skip"    -- no evidence, a negation, or the row is already correct.
 */
function verdictFor(row) {
  const parallel = String(row.parallel ?? "");
  const subset = String(row.subsetName ?? "");
  if (row.isAuto === true) return { action: "skip", reason: "already signed" };
  if (NEGATION.test(parallel) || NEGATION.test(subset)) {
    return { action: "skip", reason: `the name denies the signature: "${parallel || subset}"` };
  }
  const evidence = namesAnAuto(parallel) ? parallel : namesAnAuto(subset) ? subset : null;
  if (!evidence) return { action: "skip", reason: "no auto word in the checklist's own name" };
  if (idSaysAuto(row.id)) return { action: "heal", reason: `id already says auto; field disagrees ("${evidence}")` };
  return { action: "move", reason: `the checklist names it "${evidence}"` };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[repair-clc-signature-unsigned] ${APPLY ? "APPLY" : "REPORT ONLY"}  sources=${SOURCES.join(",")}  ${SHARDED ? `slot ${SLOT}/${SLOTS}` : "unsharded (every row)"}`);
  console.log(`  sports=${SPORTS.length ? SPORTS.join(",") : "ALL"}  years=${YEARS.length ? YEARS.join(",") : "ALL"}  budget=${RUN_MINUTES}m  limit=${LIMIT || "none"}`);
  console.log(`  the flag comes from the CHECKLIST'S OWN published name, never from free text; a name that denies the signature is refused.\n`);

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const catalog = db.container("card_catalog");
  const sales = db.container("sold_comps");

  // Only rows that could possibly be actionable: this lane's sources, flag
  // false, and a signature-ish word somewhere in the published name. The
  // vocabulary above then judges each one properly (CONTAINS cannot express a
  // word boundary or a negation, so the query is deliberately WIDER than the
  // rule and the rule refuses the rest).
  const where = [
    "c.isAuto = false",
    `(${SOURCES.map((s, i) => `STARTSWITH(LOWER(c.source), @src${i})`).join(" OR ")})`,
    `(CONTAINS(LOWER(c.parallel), 'signature') OR CONTAINS(LOWER(c.parallel), 'autograph')
      OR CONTAINS(LOWER(c.parallel), 'auto') OR CONTAINS(LOWER(c.parallel), 'penmanship')
      OR CONTAINS(LOWER(c.parallel), 'inscription') OR CONTAINS(LOWER(c.parallel), 'signed')
      OR CONTAINS(LOWER(c.subsetName ?? ''), 'signature') OR CONTAINS(LOWER(c.subsetName ?? ''), 'autograph'))`,
  ];
  const parameters = SOURCES.map((s, i) => ({ name: `@src${i}`, value: s }));
  if (SPORTS.length) { where.push(`ARRAY_CONTAINS(@sports, LOWER(c.sport))`); parameters.push({ name: "@sports", value: SPORTS }); }
  if (YEARS.length) { where.push(`ARRAY_CONTAINS(@years, c.year)`); parameters.push({ name: "@years", value: YEARS }); }

  const query = {
    query: `SELECT c.id, c.cardId, c.sport, c.year, c.setKey, c.cardNumber, c.parallel,
                   c.subsetName, c.isAuto, c.printRun, c.playerName, c.source
            FROM c WHERE ${where.join(" AND ")}`,
    parameters,
  };

  const stats = {
    scanned: 0, moved: 0, healed: 0, folded: 0, replaced: 0, failed: 0,
    salesRepointed: 0, gradedRetired: 0,
    skipNegation: 0, skipNoEvidence: 0, skipAlready: 0, skipShard: 0, notReached: 0,
  };
  const byProduct = new Map();          // "year setKey sport" -> { move, heal, skip }
  const spellings = new Map();          // the distinct published names acted on
  const refusals = new Map();           // the distinct names refused, and why
  const examples = [];
  let stopReason = "complete";

  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const productKey = (r) => `${r.year} ${r.setKey} ${r.sport}`;

  const iter = catalog.items.query(query, { maxItemCount: 500 });
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const work = batch; batch = [];
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      if (budgetLeft() < RESERVE_MS) { stopReason = "budget"; stats.notReached += work.length - i; return; }
      if (LIMIT && stats.moved + stats.healed >= LIMIT) { stopReason = "limit"; stats.notReached += work.length - i; return; }
      await Promise.all(work.slice(i, i + CONCURRENCY).map(async (row) => {
        const v = verdictFor(row);
        const pk = productKey(row);
        if (!byProduct.has(pk)) byProduct.set(pk, { move: 0, heal: 0, skip: 0 });
        const p = byProduct.get(pk);
        if (v.action === "skip") {
          p.skip++;
          if (/denies the signature/.test(v.reason)) { stats.skipNegation++; bump(refusals, `${row.parallel || row.subsetName} — denies the signature`); }
          else if (/already signed/.test(v.reason)) stats.skipAlready++;
          else { stats.skipNoEvidence++; bump(refusals, `${row.parallel || "(blank)"} — no auto word`); }
          return;
        }
        bump(spellings, String(row.parallel || row.subsetName));
        if (v.action === "heal") p.heal++; else p.move++;
        if (examples.length < 12) examples.push(`${v.action.toUpperCase().padEnd(5)} ${row.id}  <- ${v.reason}`);
        if (VERBOSE) console.log(`  ${v.action.toUpperCase().padEnd(5)} ${row.id}  ${v.reason}`);
        if (!APPLY) { if (v.action === "heal") stats.healed++; else stats.moved++; return; }
        try {
          const full = (await retry(() => catalog.item(String(row.id), String(row.cardId ?? row.id)).read())).resource;
          if (!full) { stats.failed++; return; }
          const newSlug = v.action === "heal" ? String(full.id) : withAutoSegment(String(full.id), true);
          const res = await moveCatalogRow(catalog, full, newSlug, { isAuto: true }, {
            reason: "clc converter read the auto flag from the section only; the checklist's own name says signed (CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION)",
            salesContainer: sales,
            retry,
          });
          stats.salesRepointed += res.salesRepointed || 0;
          stats.gradedRetired += res.gradedChildrenRetired || 0;
          if (res.action === "fold") stats.folded++;
          else if (res.action === "replace") stats.replaced++;
          if (v.action === "heal") stats.healed++; else stats.moved++;
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 5) console.error(`  FAILED ${row.id}: ${String(e.message || e).slice(0, 90)}`);
        }
      }));
    }
  };

  while (stopReason === "complete") {
    const page = await retry(() => iter.fetchNext());
    if (!page.resources.length && !page.hasMoreResults) break;
    for (const row of page.resources) {
      stats.scanned++;
      if (SHARDED && shardOf(productKey(row)) !== SLOT) { stats.skipShard++; continue; }
      batch.push(row);
    }
    await flush();
    if (!page.hasMoreResults) break;
  }
  await flush();

  // ── the report ─────────────────────────────────────────────────────────────
  console.log(`\nscanned ${f(stats.scanned)} candidate rows${SHARDED ? ` (${f(stats.skipShard)} in other shards)` : ""}   stop: ${stopReason}`);
  console.log(`\n  ${APPLY ? "MOVED" : "would move"}  ${f(stats.moved)}   ${APPLY ? "HEALED" : "would heal"} ${f(stats.healed)}   refused ${f(stats.skipNegation + stats.skipNoEvidence)} (${f(stats.skipNegation)} deny the signature, ${f(stats.skipNoEvidence)} name no auto)`);
  if (APPLY) console.log(`  folded onto an existing signed twin ${f(stats.folded)}   replaced an incumbent ${f(stats.replaced)}   sales re-pointed ${f(stats.salesRepointed)}   graded children retired ${f(stats.gradedRetired)}   failed ${f(stats.failed)}`);
  if (stats.notReached) console.log(`  not reached (${stopReason}): ${f(stats.notReached)}`);

  const actionable = [...byProduct.entries()].filter(([, v]) => v.move + v.heal > 0).sort((a, b) => (b[1].move + b[1].heal) - (a[1].move + a[1].heal));
  console.log(`\n  by product (${actionable.length} with actionable rows):`);
  for (const [k, v] of actionable.slice(0, 60)) console.log(`    ${String(v.move + v.heal).padStart(6)}  ${k}${v.skip ? `   (${v.skip} refused)` : ""}`);
  if (actionable.length > 60) console.log(`    ... and ${actionable.length - 60} more products`);

  console.log(`\n  the published names being acted on (${spellings.size} distinct, top 25):`);
  for (const [k, n] of [...spellings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(n).padStart(6)}  ${JSON.stringify(k)}`);

  if (refusals.size) {
    console.log(`\n  REFUSED, and why (${refusals.size} distinct, top 15) -- read these: a wrong refusal is a card left unsigned:`);
    for (const [k, n] of [...refusals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(n).padStart(6)}  ${k}`);
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(`    ${e}`); }

  if (!APPLY) {
    console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);
    return;
  }

  // CF-VERIFY-THE-WRITE-BY-READ. A green run is not a written row.
  try {
    const left = (await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${where.join(" AND ")}`, parameters,
    }, { maxItemCount: 1 }).fetchAll()).resources[0];
    console.log(`\n  VERIFY BY READ: candidate rows still matching the predicate: ${f(left)}  (the refused ones stay, by design)`);
  } catch (e) { console.log(`\n  VERIFY BY READ: could not answer (${String(e.message).slice(0, 60)})`); }

  await reportWrites?.({ script: "repair-clc-signature-unsigned", written: stats.moved + stats.healed, failed: stats.failed });
}

module.exports = { namesAnAuto, verdictFor, familyOf, idSaysAuto, withAutoSegment, AUTO_WORDS, NEGATION };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
