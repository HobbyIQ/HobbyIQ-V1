#!/usr/bin/env node
/**
 * clean-base-cards-parallel-slug.cjs -- "Base Cards" is the checklist's SECTION
 * HEADING, not the name of a rung.
 *
 * D28 (Drew, 2026-08-30). 2018 Topps Chrome #150 has
 * `150:base-cards-refractor:no-auto` and no `150:refractor:no-auto` on the
 * scraped spine, because the scraper glued the page's "Base Cards" heading
 * onto every parallel under it. 9,047 checklist rows carry it
 * (cardboardchecklist-scraped-2026-08-14 8,858 / beckett-scraped-2026-08-25
 * 189), and the sale-derived rows that DO spell the rung correctly can never
 * fold onto the spine because the spine's address is not the rung's name.
 *
 * This is NOT the same shape as clean-parallel-annotations, which is why it is
 * not an extension of it: that script's population is a footnote inside
 * `parallel` ("Refractor - Est. print run ~4,000", "Platinum ()") and its query
 * requires a parenthesis or the words "print run". These rows have neither --
 * the glue is a clean prefix on a clean name. Same conventions, same movers,
 * different question.
 *
 * MODES (`mode` on the runner; NO default -- a whole-scope write is asked for
 * by name):
 *
 *   cards   `parallelSlug` starts with `base-cards-`  ->  strip it.
 *           Unambiguous: no product calls a rung "Base Cards Refractor".
 *   subset  `parallelSlug` starts with `base-` (and not `base-cards-`) AND the
 *           row's own subsetName / setName says "Base" -- the evidence that
 *           the leading word is the SUBSET LABEL and not part of the rung.
 *           Without that evidence the row is counted and LEFT: "Base Variation
 *           Refractor" and "Base Pitching Refractor" are real rung names and
 *           stripping them would be the 3.1x bloat mistake in reverse.
 *   both    cards then subset. REFUSED unless SCOPE=all.
 *
 * Only checklist-authority rows are touched (catalogAuthorityOf): a derived or
 * vendor row's parallel is not a checklist transcription and is not this
 * script's business.
 *
 * The move goes through catalogRowOps.moveCatalogRow -- sales re-pointed,
 * graded children of the old slug retired, the collision decided by authority
 * so a checklist row lands ON TOP of a sale-minted twin and FOLDS UNDER an
 * existing checklist one. Where the clean slug has no row but has numbered
 * twins, foldTwinRule decides (the same decision fold-unnumbered-twins makes).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (the runner
 *      exports BACKFILL_APPLY, not APPLY); MODE (required); SCOPE (=all for
 *      MODE=both); SPORTS; SOURCES; SLOT/SLOTS (hash of the row id);
 *      CONCURRENCY=16; RUN_MINUTES=140 (budget marker); LIMIT.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
const { decideTwinFold } = require(path.join(backend, "dist/services/catalog/foldTwinRule.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SOURCES = String(process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
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
const SHARD_SCOPE = runnerShardScope({ label: "clean-base-cards-parallel-slug" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
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
const STARTED = Date.now();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const str = (v) => String(v ?? "").trim();
const REASON_CARDS = `"Base Cards" is the checklist's section heading, not the rung's name (D28)`;
const REASON_SUBSET = `the subset label "Base" was glued onto the rung name (D28)`;

/** The subset label the row itself names -- the evidence MODE=subset requires. */
const NAMES_BASE_SUBSET = /\bbase\b/i;

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

/** Strip the glue from a parallel NAME and its slug. Returns null when there is
 *  nothing left -- a row whose whole parallel is "Base Cards" is already Base
 *  and is not a rename, it is a no-op. */
function stripGlue(parallel, parallelSlug, mode) {
  const prefix = mode === "cards" ? "base-cards-" : "base-";
  const slug = str(parallelSlug).toLowerCase();
  if (!slug.startsWith(prefix)) return null;
  const newSlug = slug.slice(prefix.length);
  if (!newSlug) return null;
  const words = str(parallel).split(/\s+/).filter(Boolean);
  const drop = mode === "cards" ? 2 : 1;
  const kept = words.slice(drop).join(" ");
  return { name: kept || null, slug: newSlug };
}

function withParallelSegment(id, slug) {
  const seg = String(id).split(":");
  if (seg.length < 7 || seg[0] !== "hiq") return null;
  seg[5] = slug;
  return seg.join(":");
}

async function rowAt(cat, id) {
  try { const { resource } = await retry(() => cat.item(id, id).read()); return resource ?? null; }
  catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!MODE) { console.error("FATAL: MODE is required and has no default. One of: cards | subset | both"); process.exit(1); }
  if (MODE === "both" && SCOPE !== "all") { console.error("FATAL: MODE=both renames every base-prefixed checklist parallel. Confirm it with SCOPE=all."); process.exit(1); }
  const modes = MODE === "both" ? ["cards", "subset"] : [MODE];
  for (const m of modes) if (!["cards", "subset"].includes(m)) { console.error(`FATAL: unknown MODE "${m}". One of: cards | subset | both`); process.exit(1); }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");

  console.log(`clean-base-cards-parallel-slug  MODE=${MODE}  slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY (moves card_catalog rows, re-points sales)" : "REPORT ONLY -- nothing written"}  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m  sports=${SPORTS.join(",") || "all"}  sources=${SOURCES.join(",") || "every checklist source"}${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`only checklist-authority rows are touched; a rung name with no subset evidence is counted and left.\n`);

  const s = {
    scanned: 0, otherSlot: 0, notChecklist: 0, noEvidence: 0, nothingToStrip: 0, noSlug: 0,
    moved: 0, folded: 0, replaced: 0, noop: 0, salesRepointed: 0, gradedRetired: 0, twinFolds: 0,
    failed: 0, notReached: 0, refusedSetKeySplit: 0,
  };
  const bySource = new Map(), byNewName = new Map(), examples = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  let stopReason = null;

  async function handle(row, mode) {
    if (catalogAuthorityOf(row.source) !== "checklist") { s.notChecklist++; return; }
    if (mode === "subset") {
      const evidence = `${str(row.subsetName)} ${str(row.setName)}`;
      if (!NAMES_BASE_SUBSET.test(evidence)) { s.noEvidence++; return; }
    }
    const cleaned = stripGlue(row.parallel, row.parallelSlug, mode);
    if (!cleaned) { s.nothingToStrip++; return; }
    let newSlug = withParallelSegment(row.id, cleaned.slug);
    if (!newSlug || newSlug === row.id) { s.noSlug++; return; }

    // The incumbent at the clean address -- one read, reused as moveCatalogRow's
    // `known` (CF-DO-NOT-LOOK-TWICE).
    let incumbent = await rowAt(cat, newSlug);
    if (!incumbent && !/:num-\d+$/.test(newSlug)) {
      // No row at the un-numbered clean address, but the card may exist there
      // WITH a print run. foldTwinRule decides -- the same decision
      // fold-unnumbered-twins makes, not a second rule.
      const { resources } = await retry(() => cat.items.query({
        query: "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p)",
        parameters: [{ name: "@p", value: `${newSlug}:num-` }],
      }, { maxItemCount: 50 }).fetchAll());
      const numbered = (resources ?? [])
        .map((r) => ({ id: String(r.id), printRun: Number(String(r.id).split(":num-")[1]), source: str(r.source) }))
        .filter((r) => Number.isFinite(r.printRun) && r.printRun > 0);
      if (numbered.length) {
        const d = decideTwinFold({ baseId: newSlug, twinSource: str(row.source), twinIsChecklist: true, numbered, mode: "cross-source" });
        if (d.fold) { newSlug = d.target.id; incumbent = await rowAt(cat, newSlug); s.twinFolds++; }
      }
    }

    bump(bySource, str(row.source) || "(none)");
    bump(byNewName, cleaned.name ?? "(Base)");
    if (examples.length < 12) examples.push(`  "${str(row.parallel)}" -> "${cleaned.name ?? "Base"}"   ${row.id}\n        -> ${newSlug}${incumbent ? `   (a ${catalogAuthorityOf(incumbent.source)} row is already there: ${incumbent.source})` : ""}`);

    const r = await moveCatalogRow(cat, row, newSlug, { parallel: cleaned.name, parallelSlug: cleaned.slug }, {
      reason: mode === "cards" ? REASON_CARDS : REASON_SUBSET,
      dryRun: !APPLY,
      salesContainer: pool,
      known: incumbent,
      retry,
    });
    s.salesRepointed += r.salesRepointed;
    s.gradedRetired += r.gradedChildrenRetired;
    if (r.action === "move") s.moved++;
    else if (r.action === "fold") s.folded++;
    else if (r.action === "replace") s.replaced++;
    else s.noop++;
  }

  for (const mode of modes) {
    if (stopReason) break;
    const sportSql = SPORTS.length ? ` AND c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})` : "";
    const srcSql = SOURCES.length ? ` AND c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})` : "";
    const shapeSql = mode === "cards"
      ? "STARTSWITH(c.parallelSlug, 'base-cards-')"
      : "STARTSWITH(c.parallelSlug, 'base-') AND NOT STARTSWITH(c.parallelSlug, 'base-cards-')";
    const query = {
      query: `SELECT * FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.parallelSlug) AND ${shapeSql}${sportSql}${srcSql}`,
      parameters: [
        ...SPORTS.map((v, i) => ({ name: `@sp${i}`, value: v })),
        ...SOURCES.map((v, i) => ({ name: `@s${i}`, value: v })),
      ],
    };
    console.log(`-- MODE=${mode}: ${shapeSql}`);
    let token, seen = 0;
    do {
      const page = await retry(() => cat.items.query(query, { maxItemCount: 200, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      const mine = (page.resources ?? []).filter((d) => { if (shardOf(d.id) === SLOT) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (d) => {
          s.scanned++; seen++;
          try { await handle(d, mode); }
          catch (e) {
            // CF-A-KEY-NEEDS-BOTH-HALVES. moveCatalogRow refuses a row whose id
            // and whose `setKey` FIELD disagree -- D23's rename is mid-flight
            // and some rows carry the old spelling in one half. That is a
            // REFUSAL of a different repair's population, not a failure of
            // this one: counted on its own line, declared as skipped, and left
            // for the rename fleet to finish.
            const msg = String(e?.message ?? e);
            if (/newSlug says setKey/.test(msg)) {
              s.refusedSetKeySplit++;
              if (s.refusedSetKeySplit <= 3) console.log(`  refused (setKey id/field split, D23's population) ${String(d.id).slice(0, 80)}`);
              return;
            }
            s.failed++; if (s.failed <= 8) console.error(`  failed ${String(d.id).slice(0, 80)}: ${msg.slice(0, 100)}`);
          }
        }));
        const done = s.moved + s.folded + s.replaced;
        if (LIMIT && done >= LIMIT) { stopReason = "limit"; s.notReached += mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; s.notReached += mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
      }
      if (!stopReason && seen && seen % 2000 < CONCURRENCY) process.stderr.write(`\r  ${mode}: scanned=${f(s.scanned)} moved=${f(s.moved)} folded=${f(s.folded)} replaced=${f(s.replaced)}   `);
    } while (token && !stopReason);
    process.stderr.write("\n");
    console.log(`   scanned in this mode: ${f(seen)}`);
  }

  if (examples.length) { console.log(`\nexamples:`); for (const e of examples) console.log(e); }
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  const written = s.moved + s.folded + s.replaced;
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned (this slot)      ${f(s.scanned)}   (+${f(s.otherSlot)} belonging to other slots)`);
  console.log(`  CLEANED                       ${f(written)}   <- the sub-totals below, which sum to it`);
  console.log(`    moved to the clean slug        ${f(s.moved)}`);
  console.log(`    folded (a row was already there) ${f(s.folded)}`);
  console.log(`    replaced a lower-authority twin  ${f(s.replaced)}   <- the checklist row outranks a sale-minted one`);
  console.log(`  sales re-pointed              ${f(s.salesRepointed)}`);
  console.log(`  graded children retired       ${f(s.gradedRetired)}   <- regenerable by materialize-graded-identities`);
  console.log(`  numbered-twin folds           ${f(s.twinFolds)}   <- foldTwinRule chose a :num-N address`);
  console.log(`  not a checklist row           ${f(s.notChecklist)}   <- left alone; a derived parallel is not a transcription`);
  console.log(`  no subset evidence            ${f(s.noEvidence)}   <- "Base Variation Refractor" is a rung name; not stripped`);
  console.log(`  nothing to strip / no-op      ${f(s.nothingToStrip + s.noSlug + s.noop)}`);
  console.log(`  refused (setKey id/field split) ${f(s.refusedSetKeySplit)}   <- D23's rename population; a key needs both halves`);
  console.log(`  failed                        ${f(s.failed)}`);
  console.log(`  not reached                   ${f(s.notReached)}`);
  console.log(`\n  by source:`);
  for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(40)} ${f(n).padStart(8)}`);
  console.log(`\n  the rung names recovered (top 15):`);
  for (const [k, n] of [...byNewName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(k).padEnd(48)} ${f(n).padStart(8)}`);

  if (APPLY) {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: `notReached` rows were never
    // scanned, so intending only `scanned` while skipping them over-accounts
    // on every budget stop. Intend what this run took on: scanned + held.
    reportWrites({
      job: "clean-base-cards-parallel-slug",
      intended: s.scanned + s.notReached,
      written,
      skipped: s.notChecklist + s.noEvidence + s.nothingToStrip + s.noSlug + s.noop + s.notReached + s.refusedSetKeySplit,
      failed: s.failed,
    });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
